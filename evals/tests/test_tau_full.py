import argparse
import json
import pytest
from evals import run_tau_full as runner

def args(tmp_path, **changes):
    values = dict(domain='all', split='test', trials=3, max_steps=30, task_timeout=900,
                  output=str(tmp_path / 'results'), resume=False, dry_run=False)
    return argparse.Namespace(**(values | changes))

def test_official_full_inventory_has_contiguous_indices_for_both_domains():
    tasks = runner.inventory(['retail', 'airline'], 'test')
    for domain in ('retail', 'airline'):
        selected = [task for task in tasks if task['domain'] == domain]
        assert len(selected) > 1
        assert [task['task_index'] for task in selected] == list(range(len(selected)))
        assert all(len(task['task_hash']) == 64 for task in selected)
    with pytest.raises(ValueError):
        runner.inventory(['airline'], 'dev')

def test_full_runner_checkpoint_resume_metrics_and_config_guard(tmp_path, monkeypatch):
    tasks = [{'domain': 'retail', 'task_index': 0, 'task_hash': 'a'}, {'domain': 'airline', 'task_index': 0, 'task_hash': 'b'}]
    monkeypatch.setattr(runner, 'inventory', lambda domains, split: tasks)
    monkeypatch.setenv('MODEL_NAME', 'fixture-model')
    monkeypatch.setenv('MODEL_BASE_URL', 'http://model.test/v1')
    calls = []
    def execute(task, trial, settings, output):
        calls.append((task['domain'], trial))
        return {'reward': float(task['domain'] == 'retail' and trial <= 2), 'messages': [], 'info': {'pi_adapter': {'status': 'completed'}}, 'total_cost': None}
    settings = args(tmp_path)
    assert runner.run(settings, execute) == 0
    assert len(calls) == 6
    summary = json.loads((tmp_path / 'results/summary.json').read_text())
    assert summary['complete'] is True
    assert summary['finished_runs'] == 6
    assert summary['observed_success_rate'] == 2 / 6
    assert summary['mean_passPowerK_completed_tasks']['2'] == 1 / 6
    settings.resume = True
    assert runner.run(settings, execute) == 0
    assert len(calls) == 6
    settings.max_steps = 31
    with pytest.raises(ValueError, match='不能混合'):
        runner.run(settings, execute)

def test_interruption_preserves_finished_trial_and_dry_run_makes_no_files(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, 'inventory', lambda domains, split: [{'domain': 'retail', 'task_index': 0, 'task_hash': 'a'}])
    monkeypatch.setenv('MODEL_NAME', 'fixture-model')
    monkeypatch.setenv('MODEL_BASE_URL', 'http://model.test/v1')
    settings = args(tmp_path, domain='retail')
    def execute(task, trial, settings, output):
        if trial == 2:
            raise KeyboardInterrupt()
        return {'reward': 1.0, 'messages': [], 'info': {'pi_adapter': {'status': 'completed'}}}
    assert runner.run(settings, execute) == 130
    summary = json.loads((tmp_path / 'results/summary.json').read_text())
    assert summary['finished_runs'] == 1
    assert summary['complete'] is False
    assert summary['mean_passPowerK_completed_tasks'] == {}
    dry = args(tmp_path, domain='retail', dry_run=True, output=str(tmp_path / 'dry'))
    assert runner.run(dry, execute) == 0
    assert not (tmp_path / 'dry').exists()


def test_task_range_selects_only_requested_official_tasks(tmp_path, capsys):
    settings = args(tmp_path, domain='retail', task_start=0, task_stop=3, dry_run=True)
    assert runner.run(settings) == 0
    assert "'retail': 3" in capsys.readouterr().out
    settings.task_stop = 116
    with pytest.raises(ValueError, match='越界'):
        runner.run(settings)


def test_four_tasks_overlap_checkpoint_resume_and_concurrency_guard(tmp_path, monkeypatch):
    from threading import Barrier, Lock
    tasks = [{'domain': 'retail', 'task_index': i, 'task_hash': str(i)} for i in range(8)]
    monkeypatch.setattr(runner, 'inventory', lambda domains, split: tasks)
    monkeypatch.setenv('MODEL_NAME', 'fixture-model')
    monkeypatch.setenv('MODEL_BASE_URL', 'http://model.test/v1')
    barrier, lock = Barrier(4), Lock()
    running = peak = calls = 0
    def execute(task, trial, settings, output):
        nonlocal running, peak, calls
        with lock:
            running += 1
            calls += 1
            peak = max(peak, running)
        barrier.wait(timeout=5)
        with lock:
            running -= 1
        return {'reward': float(task['task_index'] % 2 == 0), 'messages': [], 'info': {'pi_adapter': {'status': 'completed'}}}
    settings = args(tmp_path, domain='retail', trials=1, concurrency=4)
    assert runner.run(settings, execute) == 0
    assert peak == 4 and calls == 8
    summary = json.loads((tmp_path / 'results/summary.json').read_text())
    assert summary['finished_runs'] == 8 and summary['observed_success_rate'] == 0.5
    manifest = json.loads((tmp_path / 'results/manifest.json').read_text())
    assert manifest['config']['evaluation_concurrency'] == 4
    assert manifest['config']['user_max_output_tokens'] == 512
    settings.resume = True
    assert runner.run(settings, execute) == 0
    assert calls == 8
    settings.concurrency = 2
    with pytest.raises(ValueError, match='不能混合'):
        runner.run(settings, execute)


def test_parallel_interrupt_does_not_score_cancelled_trials(tmp_path, monkeypatch):
    from threading import Barrier
    tasks = [{'domain': 'retail', 'task_index': i, 'task_hash': str(i)} for i in range(4)]
    monkeypatch.setattr(runner, 'inventory', lambda domains, split: tasks)
    monkeypatch.setenv('MODEL_NAME', 'fixture-model')
    monkeypatch.setenv('MODEL_BASE_URL', 'http://model.test/v1')
    barrier = Barrier(4)
    def execute(task, trial, settings, output):
        barrier.wait(timeout=5)
        if task['task_index'] == 0:
            raise KeyboardInterrupt()
        assert settings._stop_event.wait(timeout=5)
        raise runner.TrialCancelled()
    settings = args(tmp_path, domain='retail', trials=1, concurrency=4)
    assert runner.run(settings, execute) == 130
    summary = json.loads((tmp_path / 'results/summary.json').read_text())
    assert summary['finished_runs'] == 0 and summary['observed_success_rate'] is None
    assert not list((tmp_path / 'results/runs').glob('*.json'))


def test_real_subprocess_stops_promptly_when_parallel_run_is_cancelled(tmp_path, monkeypatch):
    from threading import Event, Timer
    import subprocess
    import sys
    import time
    original = subprocess.Popen
    processes = []
    def launch(command, **kwargs):
        child = original([sys.executable, '-c', 'import time; time.sleep(60)'], **kwargs)
        processes.append(child)
        return child
    monkeypatch.setattr(runner.subprocess, 'Popen', launch)
    settings = args(tmp_path)
    settings._stop_event = Event()
    timer = Timer(0.2, settings._stop_event.set)
    timer.start()
    started = time.monotonic()
    try:
        with pytest.raises(runner.TrialCancelled):
            runner.execute_trial({'domain': 'retail', 'task_index': 0}, 1, settings, tmp_path)
    finally:
        timer.cancel()
    assert time.monotonic() - started < 5
    assert len(processes) == 1 and processes[0].poll() is not None


def test_explicit_diagnostic_task_ids_do_not_silently_expand_to_full_suite(tmp_path, capsys):
    settings = args(tmp_path, task_ids=['retail:14', 'airline:3'], dry_run=True)
    assert runner.run(settings) == 0
    output = capsys.readouterr().out
    assert "'retail': 1" in output and "'airline': 1" in output
    settings.task_ids = ['retail:999']
    with pytest.raises(ValueError, match='超出'):
        runner.run(settings)
