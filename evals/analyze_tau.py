#!/usr/bin/env python3
# 运行：.venv/bin/python -m evals.analyze_tau --run-dir .data/evals/tau-full-2026-10-19-vllm4b-c4-32k --audit-unfinished
"""Read saved trials, validate coverage and summarize results without model calls."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import json
import os
from pathlib import Path
from statistics import median


WRITE_TOOLS = {
    'cancel_pending_order', 'return_delivered_order_items', 'exchange_delivered_order_items',
    'modify_pending_order_address', 'modify_pending_order_items', 'modify_pending_order_payment',
    'modify_user_address', 'book_reservation', 'cancel_reservation', 'update_reservation_flights',
    'update_reservation_baggages', 'update_reservation_passengers', 'send_certificate',
}


def failure_category(record):
    if record['reward'] == 1:
        return 'success'
    info = record['info']
    status = info.get('pi_adapter', {}).get('status', 'error')
    error = info.get('adapter_error') or ''
    code = (info.get('error_details') or {}).get('code')
    if code in ('fidelity_rejected', 'ungrounded_facts', 'invalid_review', 'http_error'):
        return 'simulator_' + code
    if status == 'completed':
        return 'completed_reward_zero'
    if status == 'step_limit':
        return 'environment_step_limit'
    if '模型输出终止：length' in error:
        return 'agent_output_truncated'
    if '用户模拟器没有生成完整回复' in error:
        return 'simulator_incomplete_response'
    if '模型请求次数已达上限' in error:
        return 'agent_model_call_limit'
    return 'other_' + status


def percentile(values, fraction):
    ordered = sorted(values)
    if not ordered:
        return None
    position = (len(ordered) - 1) * fraction
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def metrics(records):
    successes = sum(r['reward'] == 1 for r in records)
    durations = [r['duration_seconds'] for r in records]
    return {
        'runs': len(records), 'successes': successes,
        'success_rate': successes / len(records) if records else None,
        'statuses': dict(Counter(r['info'].get('pi_adapter', {}).get('status', 'error') for r in records)),
        'duration_seconds_median': median(durations) if durations else None,
        'duration_seconds_p90': percentile(durations, 0.9),
        'environment_steps_median': median(r['info']['pi_adapter']['environment_steps'] for r in records) if records else None,
    }


def load_run(directory):
    manifest = json.loads((directory / 'manifest.json').read_text())
    summary = json.loads((directory / 'summary.json').read_text())
    expected = {(t['domain'], t['task_index'], trial)
                for t in manifest['config']['tasks']
                for trial in range(1, manifest['config']['trials'] + 1)}
    hashes = {(t['domain'], t['task_index']): t['task_hash'] for t in manifest['config']['tasks']}
    records, seen = [], set()
    for path in sorted((directory / 'runs').glob('*.json')):
        record = json.loads(path.read_text())
        key = (record['domain'], record['task_index'], record['trial'])
        if key in seen or key not in expected:
            raise ValueError('Duplicate or unexpected trial: ' + path.name)
        if record['fingerprint'] != manifest['fingerprint'] or record['task_hash'] != hashes[key[:2]]:
            raise ValueError('Trial fingerprint/hash mismatch: ' + path.name)
        seen.add(key)
        records.append(record)
    if summary['finished_runs'] != len(records) or summary['planned_runs'] != len(expected):
        raise ValueError('Summary coverage differs from saved trials')
    if summary['complete'] != (seen == expected):
        raise ValueError('Summary completion differs from saved trials')
    if records and abs(summary['observed_success_rate'] - metrics(records)['success_rate']) > 1e-12:
        raise ValueError('Summary score differs from saved trials')
    return manifest, records, sorted(expected - seen)


def audit_unfinished(record, split):
    """Replay recorded tools in fresh upstream in-memory data; never alters official scores."""
    os.environ.setdefault('LITELLM_LOCAL_MODEL_COST_MAP', 'True')
    from tau_bench.envs import get_env
    env = get_env(env_name=record['domain'], user_strategy='human', user_model='unused',
                  task_split=split, task_index=record['task_index'])
    errors = []
    blocked = {m.get('tool_call_id') for m in record['messages'] if m.get('role') == 'tool'
               and m.get('content', '').startswith('Error: observed-fact guard:')}
    for message in record['messages']:
        for call in message.get('tool_calls', []):
            if call['id'] in blocked:
                continue
            function = call['function']
            name = function['name']
            if name not in env.tools_map or name in env.terminate_tools:
                continue
            try:
                env.tools_map[name].invoke(data=env.data, **json.loads(function['arguments']))
            except Exception as exc:
                errors.append(type(exc).__name__)
    actual_hash = env.get_data_hash()
    env.data = env.data_load_func()
    for action in env.task.actions:
        if action.name not in env.terminate_tools:
            env.tools_map[action.name].invoke(data=env.data, **action.kwargs)
    expected_hash = env.get_data_hash()
    return {
        'database_matches_expected': actual_hash == expected_hash,
        'actual_data_hash': actual_hash, 'expected_data_hash': expected_hash,
        'required_text_outputs': record['info']['task'].get('outputs', []),
        'replay_exceptions': errors,
        'notice': 'Offline diagnostic only; no terminal event, no official reward recalculation. Partial/unrecorded output is unavailable.',
    }


def analyze(directory, *, audit=False):
    manifest, records, missing = load_run(directory)
    tool_errors = []
    rows = []
    for record in records:
        label = f"{record['domain']}-{record['task_index']:04d}-{record['trial']:02d}"
        errors = [m for m in record['messages'] if m.get('role') == 'tool'
                  and m.get('content', '').startswith(('Error:', 'Unknown action'))]
        tool_errors.extend((label, m.get('name'), m['content']) for m in errors)
        row = {
            'id': label, 'reward': record['reward'], 'category': failure_category(record),
            'status': record['info']['pi_adapter']['status'],
            'adapter_error': record['info'].get('adapter_error'),
            'duration_seconds': record['duration_seconds'],
            'environment_steps': record['info']['pi_adapter']['environment_steps'],
            'tool_error_observations': len(errors),
            'required_write_actions': sum(a['name'] in WRITE_TOOLS for a in record['info']['task']['actions']),
        }
        if audit and row['status'] != 'completed':
            row['offline_replay'] = audit_unfinished(record, manifest['config']['split'])
        rows.append(row)
    start = min((datetime.fromisoformat(r['started_at']).timestamp() for r in records), default=None)
    end = max((datetime.fromisoformat(r['started_at']).timestamp() + r['duration_seconds'] for r in records), default=None)
    groups = {}
    for domain in sorted({r['domain'] for r in records}):
        for count in (0, 1, 2):
            group = [r for r in records if r['domain'] == domain and
                     min(2, sum(a['name'] in WRITE_TOOLS for a in r['info']['task']['actions'])) == count]
            groups[f'{domain}/expected_writes_{count if count < 2 else "2plus"}'] = metrics(group)
    return {
        'benchmark': manifest['config']['upstream_commit'], 'fingerprint': manifest['fingerprint'],
        'source_run': directory.name, 'config': {k: v for k, v in manifest['config'].items() if k != 'tasks'},
        'coverage': {'planned': len(records) + len(missing), 'saved': len(records), 'missing': missing},
        'overall': metrics(records),
        'by_domain': {d: metrics([r for r in records if r['domain'] == d]) for d in sorted({r['domain'] for r in records})},
        'outcomes': dict(Counter(failure_category(r) for r in records)),
        'wall_seconds': end - start if start is not None else None,
        'summed_task_seconds': sum(r['duration_seconds'] for r in records),
        'recorded_agent_tokens': sum(r['info']['pi_adapter'].get('tokens', 0) for r in records),
        'recorded_user_tokens': sum(r['info'].get('user_tokens', 0) for r in records),
        'tool_errors': {'observations': len(tool_errors), 'tasks': len({x[0] for x in tool_errors}),
                        'successful_tasks': len({x[0] for x in tool_errors if next(r for r in rows if r['id'] == x[0])['reward'] == 1}),
                        'top_messages': Counter(x[2] for x in tool_errors).most_common(10)},
        'expected_write_groups': groups, 'trials': rows,
        'limitations': ['One trial per task in this run; no pass^2/pass^3 estimate.',
                        'Both roles use the same 4B model; simulator drift can change measured success.',
                        'Categories describe recorded outcomes, not exhaustive causal attribution.',
                        'Expected writes are grouped by an explicit mutating-tool allowlist, excluding reads/calculate/think.',
                        'Token usage sums repeated prompt/cache accounting; it is not unique context size or a dollar cost.'],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', required=True, type=Path)
    parser.add_argument('--audit-unfinished', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    report = analyze(args.run_dir, audit=args.audit_unfinished)
    output = args.output or args.run_dir / 'analysis.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('coverage', 'overall', 'by_domain', 'outcomes', 'wall_seconds')}, ensure_ascii=False, indent=2))
    print('Analysis:', output)


if __name__ == '__main__':
    main()
