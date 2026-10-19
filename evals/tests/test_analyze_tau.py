import json

import pytest

from evals.analyze_tau import analyze, failure_category, load_run


def record(index, *, reward=0, status='completed', error=None):
    return {'domain': 'retail', 'task_index': index, 'trial': 1, 'task_hash': str(index),
            'fingerprint': 'fixture', 'reward': reward, 'messages': [],
            'started_at': '2026-10-19T04:26:00+00:00', 'duration_seconds': 10 + index,
            'info': {'task': {'actions': [], 'outputs': []}, 'adapter_error': error,
                     'pi_adapter': {'status': status, 'environment_steps': 3, 'tokens': 100}}}


def save_run(directory, records):
    (directory / 'runs').mkdir()
    config = {'tasks': [{'domain': r['domain'], 'task_index': r['task_index'], 'task_hash': r['task_hash']} for r in records],
              'trials': 1, 'split': 'test', 'upstream_commit': 'fixture'}
    (directory / 'manifest.json').write_text(json.dumps({'fingerprint': 'fixture', 'config': config}))
    (directory / 'summary.json').write_text(json.dumps({'planned_runs': len(records), 'finished_runs': len(records),
                                                     'complete': True, 'observed_success_rate': sum(r['reward'] for r in records) / len(records)}))
    for r in records:
        (directory / 'runs' / f"{r['task_index']}.json").write_text(json.dumps(r))


def test_analysis_preserves_official_denominator_and_separates_outcomes(tmp_path):
    records = [record(0, reward=1), record(1), record(2, status='error', error='模型输出终止：length'),
               record(3, status='step_limit'), record(4, status='error', error='用户模拟器没有生成完整回复')]
    records[0]['messages'] = [{'role': 'tool', 'name': 'find_user_id_by_email', 'content': 'Error: user not found'}]
    save_run(tmp_path, records)
    report = analyze(tmp_path)
    assert report['overall']['success_rate'] == 0.2
    assert report['outcomes'] == {'success': 1, 'completed_reward_zero': 1, 'agent_output_truncated': 1,
                                  'environment_step_limit': 1, 'simulator_incomplete_response': 1}
    assert report['wall_seconds'] == 14 and report['summed_task_seconds'] == 60
    assert report['tool_errors']['successful_tasks'] == 1
    assert report['coverage']['missing'] == []
    assert failure_category(record(5, status='error', error='模型请求次数已达上限')) == 'agent_model_call_limit'


def test_analysis_rejects_score_corruption_duplicate_and_wrong_fingerprint(tmp_path):
    save_run(tmp_path, [record(0, reward=1)])
    summary_file = tmp_path / 'summary.json'
    summary = json.loads(summary_file.read_text())
    summary_file.write_text(json.dumps(summary | {'observed_success_rate': 0}))
    with pytest.raises(ValueError, match='score differs'):
        load_run(tmp_path)
    summary_file.write_text(json.dumps(summary))
    path = tmp_path / 'runs/0.json'
    (tmp_path / 'runs/duplicate.json').write_text(path.read_text())
    with pytest.raises(ValueError, match='Duplicate'):
        load_run(tmp_path)
    (tmp_path / 'runs/duplicate.json').unlink()
    path.write_text(json.dumps(record(0, reward=1) | {'fingerprint': 'wrong'}))
    with pytest.raises(ValueError, match='fingerprint/hash'):
        load_run(tmp_path)
