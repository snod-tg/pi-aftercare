import json
from evals.progress_viewer import snapshot


def test_progress_page_counts_final_scores_and_keeps_role_endpoints_separate(tmp_path):
    (tmp_path / 'manifest.json').write_text(json.dumps({'config': {'tasks': [{}, {}, {}], 'trials': 1, 'model': 'agent-9b', 'model_base_url': 'http://127.0.0.1:8080/v1', 'user_model': 'user-4b', 'user_base_url': 'http://127.0.0.1:8081/v1', 'context_window': '32768', 'model_service_slots': '4', 'evaluation_concurrency': 1}}))
    (tmp_path / 'summary.json').write_text(json.dumps({'finished_runs': 2, 'per_task': [{'successes': 1}, {'successes': 0}], 'statuses': {'completed': 1, 'timeout': 1}}))
    (tmp_path / 'progress.jsonl').write_text(json.dumps({'event': 'task_start', 'task': 'retail task=2 trial=1'}) + '\n' + json.dumps({'event': 'environment_result', 'done': False, 'reward': 0.0}) + '\n')
    (tmp_path / 'progress.log').write_text('environment_result done=False reward=0.0\n')
    result = snapshot(tmp_path)
    assert result['planned'] == 3 and result['finished'] == 2
    assert result['score'] == 1 and result['errors'] == 1
    assert result['agent_url'] != result['user_url']
    assert result['service_slots'] == '4'
    assert result['evaluation_concurrency'] == 1
    assert 'retail task=2' in result['current']


def test_progress_page_tracks_all_active_tasks_and_removes_finished(tmp_path):
    events = [
        {'event': 'task_start', 'task': 'retail task=0 trial=1'},
        {'event': 'task_start', 'task': 'retail task=1 trial=1'},
        {'event': 'model_request', 'task': 'retail task=0 trial=1'},
        {'event': 'task_end', 'task': 'retail task=1 trial=1'},
        {'event': 'task_start', 'task': 'retail task=2 trial=1'},
    ]
    (tmp_path / 'progress.jsonl').write_text('\n'.join(json.dumps(event) for event in events))
    result = snapshot(tmp_path)
    assert result['active_tasks'] == ['retail task=0 trial=1', 'retail task=2 trial=1']
    assert 'model_request' in result['current']
    assert 'task=1' not in result['current']
