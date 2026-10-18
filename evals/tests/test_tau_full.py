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
    settings = args(tmp_path)
    def execute(task, trial, settings, output):
        if trial == 2:
            raise KeyboardInterrupt()
        return {'reward': 1.0, 'messages': [], 'info': {'pi_adapter': {'status': 'completed'}}}
    assert runner.run(settings, execute) == 130
    summary = json.loads((tmp_path / 'results/summary.json').read_text())
    assert summary['finished_runs'] == 1
    assert summary['complete'] is False
    assert summary['mean_passPowerK_completed_tasks'] == {}
    dry = args(tmp_path, dry_run=True, output=str(tmp_path / 'dry'))
    assert runner.run(dry, execute) == 0
    assert not (tmp_path / 'dry').exists()
