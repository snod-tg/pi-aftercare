#!/usr/bin/env python3
# 运行指令（在 pi-aftercare 项目目录，模型 API 需先独立启动）：
# 四任务并发全量：.venv/bin/python -m evals.run_tau_full --domain all --split test --trials 1 --concurrency 4 --output .data/evals/tau-full-vllm-4
# 全量 test 集：.venv/bin/python -m evals.run_tau_full --domain all --split test --trials 1
# 仅零售全量：.venv/bin/python -m evals.run_tau_full --domain retail --split test --trials 1
# 中断后续跑：.venv/bin/python -m evals.run_tau_full --domain all --split test --trials 1 --resume
# 只列任务，不调用模型：.venv/bin/python -m evals.run_tau_full --domain all --split test --dry-run
# 3 次可靠性评测：.venv/bin/python -m evals.run_tau_full --domain all --split test --trials 3 --output .data/evals/tau-full-3
# 先测零售前3项：.venv/bin/python -m evals.run_tau_full --domain retail --split test --task-stop 3 --output .data/evals/tau-pilot
# 首次安装可选依赖：uv sync --extra tau --frozen --cache-dir .cache/uv
"""Bounded parallel full-suite runner: upstream tasks, per-trial checkpoints, resume and summaries."""
from __future__ import annotations
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from threading import Event
import time
from datetime import datetime, timezone
import hashlib
import importlib
import json
from math import comb
import os
from pathlib import Path
import signal
import subprocess
import sys
from urllib.parse import urlsplit

os.environ.setdefault('LITELLM_LOCAL_MODEL_COST_MAP', 'True')
from dotenv import load_dotenv
from evals.progress import progress

ROOT = Path(__file__).resolve().parents[1]
COMMIT = '59a200c6d575d595120f1cb70fea53cef0632f6b'

def inventory(domains, split):
    tasks = []
    for domain in domains:
        if domain == 'airline' and split != 'test':
            raise ValueError('固定版本的 airline 只有 test 集；dev/train 请指定 --domain retail')
        module = importlib.import_module(f'tau_bench.envs.{domain}.tasks_{split}')
        native = getattr(module, 'TASKS' if domain == 'airline' else f'TASKS_{split.upper()}')
        for index, task in enumerate(native):
            digest = hashlib.sha256(json.dumps(task.model_dump(), sort_keys=True).encode()).hexdigest()
            tasks.append({'domain': domain, 'task_index': index, 'task_hash': digest})
    return tasks

def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)

def endpoint(name, fallback=None):
    value = os.environ.get(name) or fallback
    parsed = urlsplit(value or '')
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(f'{name} 必须为不含凭据、查询参数或片段的 HTTP(S) 地址')
    return value.rstrip('/')

class TrialCancelled(Exception):
    """An interrupted trial has no final score and must be resumed."""

def execute_trial(task, trial, args, output):
    """A separate process per trial prevents environment/history leakage and bounds total time."""
    stop = args._stop_event
    if stop.is_set():
        raise TrialCancelled()
    raw = output / 'scratch' / f"{task['domain']}-{task['task_index']}-{trial}.json"
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.unlink(missing_ok=True)
    command = [sys.executable, '-m', 'evals.run_tau', '--domain', task['domain'], '--split', args.split,
               '--task-index', str(task['task_index']), '--trials', '1', '--max-steps', str(args.max_steps),
               '--user', 'llm', '--output', str(raw)]
    started = datetime.now(timezone.utc)
    child_env = {**os.environ, 'TAU_PROGRESS_FILE': str(output / 'progress.jsonl'),
                 'TAU_PROGRESS_LABEL': f"{task['domain']} task={task['task_index']} trial={trial}"}
    process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, start_new_session=True, env=child_env)
    try:
        deadline = time.monotonic() + args.task_timeout
        while True:
            if stop.is_set():
                raise TrialCancelled()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, args.task_timeout)
            try:
                process.communicate(timeout=min(0.25, remaining))
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() >= deadline:
                    raise
        if raw.exists():
            report = json.loads(raw.read_text())
            if report.get('benchmark') != 'tau-bench-upstream' or report.get('task_index') != task['task_index'] or report.get('domain') != task['domain'] or report.get('split') != args.split:
                raise ValueError('子进程报告与预期任务不匹配')
            result = report['results'][0]
            result.pop('trial', None)
        else:
            result = {'reward': 0.0, 'messages': [], 'info': {'pi_adapter': {'status': 'error'}, 'error_type': 'ChildProcessError'}, 'total_cost': None}
    except subprocess.TimeoutExpired:
        result = {'reward': 0.0, 'messages': [], 'info': {'pi_adapter': {'status': 'timeout'}, 'error_type': 'TaskTimeout'}, 'total_cost': None}
    finally:
        # Includes Node descendants if the Python parent has already exited or was interrupted.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate(timeout=3)
    return {**result, 'started_at': started.isoformat(), 'duration_seconds': (datetime.now(timezone.utc) - started).total_seconds()}

def summarize(tasks, records, trials, fingerprint):
    by_task = []
    for task in tasks:
        runs = [r for r in records if r['domain'] == task['domain'] and r['task_index'] == task['task_index']]
        successes = sum(r['reward'] == 1 for r in runs)
        full = len(runs) == trials
        by_task.append({**task, 'finished_trials': len(runs), 'successes': successes,
                        'passPowerK': {str(k): comb(successes, k) / comb(trials, k) if successes >= k else 0.0 for k in (1, 2, 3) if full and trials >= k}})
    complete = [task for task in by_task if task['finished_trials'] == trials]
    means = {str(k): sum(t['passPowerK'][str(k)] for t in complete) / len(complete)
             for k in (1, 2, 3) if complete and trials >= k}
    statuses = Counter(r['info'].get('pi_adapter', {}).get('status', 'error') for r in records)
    return {'benchmark': 'tau-bench-upstream', 'upstream_commit': COMMIT, 'fingerprint': fingerprint,
            'generated_at': datetime.now(timezone.utc).isoformat(), 'planned_tasks': len(tasks),
            'planned_runs': len(tasks) * trials, 'finished_runs': len(records), 'fully_evaluated_tasks': len(complete),
            'complete': len(records) == len(tasks) * trials, 'statuses': dict(statuses),
            'observed_success_rate': sum(r['reward'] == 1 for r in records) / len(records) if records else None,
            'mean_passPowerK_completed_tasks': means, 'per_task': by_task,
            'notice': '官方任务、本地 Pi 适配器及 API 用户模拟器；非排行榜复现。未完成任务不加入已完成任务的 pass^k 均值，须同时查看覆盖率；基础设施失败按0分保留。'}

def run(args, executor=execute_trial):
    concurrency = getattr(args, 'concurrency', 1)
    if not 1 <= concurrency <= 16:
        raise ValueError('concurrency需1–16')
    domains = ['retail', 'airline'] if args.domain == 'all' else [args.domain]
    tasks = inventory(domains, args.split)
    start, stop = getattr(args, 'task_start', 0), getattr(args, 'task_stop', None)
    if start < 0 or (stop is not None and stop <= start):
        raise ValueError('任务范围需满足 0 <= task-start < task-stop（不含末端）')
    for domain in domains:
        size = sum(task['domain'] == domain for task in tasks)
        if start >= size or (stop is not None and stop > size):
            raise ValueError(f'{domain} 任务范围越界，共{size}项')
    tasks = [task for task in tasks if task['task_index'] >= start and (stop is None or task['task_index'] < stop)]
    selected_ids = getattr(args, 'task_ids', None)
    if selected_ids:
        wanted = set()
        for value in selected_ids:
            try:
                domain, index = value.split(':')
                wanted.add((domain, int(index)))
            except (ValueError, TypeError):
                raise ValueError('--task-id 格式为 retail:14 或 airline:3')
        available = {(t['domain'], t['task_index']) for t in tasks}
        if not wanted <= available:
            raise ValueError('--task-id 超出所选域、split或索引范围')
        tasks = [t for t in tasks if (t['domain'], t['task_index']) in wanted]
    counts = dict(Counter(t['domain'] for t in tasks))
    print(f"Tasks: {counts}; trials={args.trials}; runs={len(tasks) * args.trials}", flush=True)
    if args.dry_run:
        return 0
    model_name = os.environ.get('MODEL_NAME', '').strip()
    if not model_name:
        raise ValueError('请先在 .env 中配置 MODEL_NAME')
    base = endpoint('MODEL_BASE_URL')
    agent_profile = os.environ.get('TAU_AGENT_PROFILE', 'baseline')
    user_profile = os.environ.get('TAU_USER_PROFILE', 'upstream')
    if agent_profile not in ('baseline', 'careful-v1') or user_profile not in ('upstream', 'faithful-v1', 'faithful-v2'):
        raise ValueError('Unknown agent/customer experiment profile')
    config = {'upstream_commit': COMMIT, 'domains': domains, 'split': args.split, 'trials': args.trials,
              'task_start': start, 'task_stop': stop, 'selected_task_ids': sorted(selected_ids) if selected_ids else None,
              'max_steps': args.max_steps, 'task_timeout': args.task_timeout, 'model': model_name,
              'model_base_url': base, 'user_model': os.environ.get('TAU_USER_MODEL') or model_name,
              'user_base_url': endpoint('TAU_USER_BASE_URL', base), 'user_strategy': 'api-llm',
              'context_window': os.environ.get('MODEL_CONTEXT_WINDOW', '8192'),
              'model_service_slots': os.environ.get('MODEL_SERVICE_SLOTS', 'unknown'),
              'model_service_context_pool': os.environ.get('MODEL_SERVICE_CONTEXT_POOL', 'unknown'),
              'evaluation_concurrency': concurrency,
              'model_service_description': os.environ.get('MODEL_SERVICE_DESCRIPTION', 'unknown'),
              'user_max_output_tokens': int(os.environ.get('TAU_USER_MAX_OUTPUT_TOKENS', '512')),
              'agent_profile': agent_profile, 'user_profile': user_profile,
              'user_review_mode': os.environ.get('TAU_USER_REVIEW_MODE', 'audit' if user_profile == 'faithful-v2' else 'enforce'),
              'user_max_attempts': int(os.environ.get('TAU_USER_MAX_ATTEMPTS', '2' if user_profile.startswith('faithful-') else '1')),
              'max_model_calls': int(os.environ.get('TAU_MAX_MODEL_CALLS', str(args.max_steps * (2 if agent_profile == 'careful-v1' else 1)))),
              'max_output_tokens': os.environ.get('MODEL_MAX_OUTPUT_TOKENS', '1024'),
              'turn_timeout_ms': os.environ.get('TAU_TURN_TIMEOUT_MS', '120000'),
              'worker_timeout_seconds': os.environ.get('TAU_WORKER_TIMEOUT_SECONDS', '150'),
              'code_hash': hashlib.sha256(b''.join((ROOT / p).read_bytes() for p in ('evals/run_tau_full.py', 'evals/run_tau.py', 'evals/tau_adapter.py', 'scripts/tau-worker.ts', 'evals/progress.py', 'evals/api_user.py', 'evals/action_guard.py', 'evals/customer_facts.py', 'src/agent/reliability.ts'))).hexdigest(),
              'tasks': tasks}
    fingerprint = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    output = Path(args.output).resolve()
    manifest = output / 'manifest.json'
    output.mkdir(parents=True, exist_ok=True)
    if manifest.exists():
        previous = json.loads(manifest.read_text())
        if not args.resume:
            raise ValueError('输出目录已有运行记录；用 --resume 续跑，或换 --output 目录')
        if previous['fingerprint'] != fingerprint:
            raise ValueError('配置、代码或任务清单变化，不能混合续跑；请换 --output 目录')
    elif args.resume:
        raise ValueError('找不到 manifest.json，首次运行请去掉 --resume')
    elif any(output.iterdir()):
        raise ValueError('输出目录非空且没有 manifest；请换新的 --output 目录')
    else:
        atomic_json(manifest, {'fingerprint': fingerprint, 'created_at': datetime.now(timezone.utc).isoformat(), 'config': config})
    records = []
    pending = []
    for task in tasks:
        for trial in range(1, args.trials + 1):
            path = output / 'runs' / f"{task['domain']}-{task['task_index']:04d}-{trial:02d}.json"
            if path.exists():
                record = json.loads(path.read_text())
                if record.get('fingerprint') != fingerprint or record.get('task_hash') != task['task_hash'] or record.get('domain') != task['domain'] or record.get('task_index') != task['task_index'] or record.get('trial') != trial:
                    raise ValueError(f'续跑记录不匹配：{path.name}')
                records.append(record)
            else:
                pending.append((task, trial, path))
    atomic_json(output / 'summary.json', summarize(tasks, records, args.trials, fingerprint))
    args._stop_event = Event()
    interrupted = False
    pool = ThreadPoolExecutor(max_workers=concurrency)
    active = {}
    queue = iter(pending)
    total = len(tasks) * args.trials
    submitted = len(records)

    def launch():
        nonlocal submitted
        try:
            task, trial, path = next(queue)
        except StopIteration:
            return False
        submitted += 1
        label = f"{task['domain']} task={task['task_index']} trial={trial}"
        print(f"[{submitted}/{total}] {label} ...", flush=True)
        progress('task_start', path=output / 'progress.jsonl', label=label, position=submitted, total=total)
        active[pool.submit(executor, task, trial, args, output)] = (task, trial, path, label)
        return True

    def save(future):
        task, trial, path, label = active[future]
        try:
            result = future.result()
        except TrialCancelled:
            return
        except Exception as exc:
            result = {'reward': 0.0, 'messages': [], 'info': {'pi_adapter': {'status': 'error'}, 'error_type': type(exc).__name__}, 'total_cost': None}
        record = {**result, **task, 'trial': trial, 'fingerprint': fingerprint}
        atomic_json(path, record)
        records.append(record)
        status = record['info'].get('pi_adapter', {}).get('status', 'error')
        print(f"[{len(records)}/{total} finished] {label} reward={record['reward']} status={status}", flush=True)
        progress('task_end', path=output / 'progress.jsonl', label=label, reward=record['reward'], status=status, finished=len(records), total=total)
        atomic_json(output / 'summary.json', summarize(tasks, records, args.trials, fingerprint))

    try:
        for _ in range(concurrency):
            if not launch():
                break
        while active:
            finished, _ = wait(active, timeout=0.25, return_when=FIRST_COMPLETED)
            for future in finished:
                save(future)
                del active[future]
            for _ in finished:
                launch()
    except KeyboardInterrupt:
        interrupted = True
        print('\n正在停止活动任务；已完成的 trial 保留，未完成任务不计分。原命令加 --resume 可继续。', flush=True)
    finally:
        args._stop_event.set()
        pool.shutdown(wait=True, cancel_futures=True)
        # Preserve results that completed just before interruption; cancelled trials get no score.
        for future in list(active):
            if not future.cancelled():
                try:
                    save(future)
                except KeyboardInterrupt:
                    pass
        atomic_json(output / 'summary.json', summarize(tasks, records, args.trials, fingerprint))
    print(f"Summary: {output / 'summary.json'}", flush=True)
    if interrupted:
        return 130
    # A reward of 0 is a legitimate benchmark result; infrastructure errors are distinct.
    return 2 if any(r['info'].get('pi_adapter', {}).get('status', 'error') in ('error', 'timeout') for r in records) else 0

def main(argv=None):
    load_dotenv(ROOT / '.env')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--domain', choices=['all', 'retail', 'airline'], default='all')
    parser.add_argument('--split', choices=['test', 'dev', 'train'], default='test')
    parser.add_argument('--trials', type=int, default=1)
    parser.add_argument('--task-start', type=int, default=0, help='每个域的起始任务索引，含起始')
    parser.add_argument('--task-stop', type=int, help='每个域的结束任务索引，不含末端；默认全部')
    parser.add_argument('--task-id', dest='task_ids', action='append', help='指定诊断任务，可重复：--task-id retail:14 --task-id airline:3')
    parser.add_argument('--max-steps', type=int, default=30)
    parser.add_argument('--task-timeout', type=int, default=900, help='每个 trial 的最长秒数')
    parser.add_argument('--concurrency', type=int, default=1, help='同时运行的独立任务数，1–16；与模型服务槽位分别设置')
    parser.add_argument('--output', default='.data/evals/tau-full')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    if not 1 <= args.trials <= 20 or not 1 <= args.max_steps <= 100 or args.task_timeout < 1 or not 1 <= args.concurrency <= 16:
        parser.error('trials需1–20，max-steps需1–100，task-timeout需为正数，concurrency需1–16')
    def interrupt(signum, frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupt)
    try:
        return run(args)
    except (ValueError, KeyError) as exc:
        parser.error(str(exc))

if __name__ == '__main__':
    raise SystemExit(main())
