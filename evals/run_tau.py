"""Run Pi against upstream tau-bench; custom smoke is clearly separate from official tasks."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
from datetime import datetime, timezone
from math import comb
os.environ.setdefault('LITELLM_LOCAL_MODEL_COST_MAP', 'True')
import httpx
from dotenv import load_dotenv
from tau_bench.envs.user import BaseUserSimulationEnv, LLMUserSimulationEnv
from tau_bench.envs import get_env
from evals.tau_adapter import PiTauAgent, ROOT
from evals.tau_smoke import make_smoke_env

class ApiUser(BaseUserSimulationEnv):
    """Same user instructions as upstream, through an independently configured HTTP API."""
    def __init__(self):
        self.messages = []
        self.tokens = 0
    def generate(self):
        base = os.environ.get('TAU_USER_BASE_URL') or os.environ['MODEL_BASE_URL']
        model = os.environ.get('TAU_USER_MODEL') or os.environ['MODEL_NAME']
        key = os.environ.get('TAU_USER_API_KEY') or os.environ.get('MODEL_API_KEY', 'local')
        with httpx.Client(timeout=120, trust_env=False) as client:
            response = client.post(base.rstrip('/') + '/chat/completions', headers={'Authorization': f'Bearer {key}'}, json={'model': model, 'messages': self.messages, 'max_tokens': 512, 'stream': False})
            response.raise_for_status()
            data = response.json()
        choice = data['choices'][0]
        text = choice['message'].get('content')
        if choice['finish_reason'] != 'stop' or not text:
            raise RuntimeError('用户模拟器没有生成完整回复，请检查思考模式及输出上限')
        self.tokens += data.get('usage', {}).get('total_tokens', 0)
        self.messages.append({'role': 'assistant', 'content': text})
        return text
    def reset(self, instruction=None):
        self.tokens = 0
        prompt = LLMUserSimulationEnv.build_system_prompt(self, instruction)
        self.messages = [{'role': 'system', 'content': prompt}, {'role': 'user', 'content': 'Hi! How can I help you today?'}]
        return self.generate()
    def step(self, content):
        self.messages.append({'role': 'user', 'content': content})
        return self.generate()
    def get_total_cost(self):
        # Upstream expects a float; our report explicitly overrides this unknown price.
        return 0.0

def main():
    load_dotenv(ROOT / '.env')
    parser = argparse.ArgumentParser()
    parser.add_argument('--smoke', action='store_true', help='自建小任务 + 原生 Env/tools/reward，不是官方任务成绩')
    parser.add_argument('--domain', choices=['retail', 'airline'], default='retail')
    parser.add_argument('--split', choices=['dev', 'train', 'test'], default='dev')
    parser.add_argument('--task-index', type=int, default=0)
    parser.add_argument('--trials', type=int, default=1)
    parser.add_argument('--max-steps', type=int, default=20)
    parser.add_argument('--user', choices=['llm', 'human'], default='llm')
    parser.add_argument('--output', default='.data/evals/tau.json')
    args = parser.parse_args()
    if not 1 <= args.trials <= 20 or not 1 <= args.max_steps <= 100 or args.task_index < 0:
        parser.error('trials 1–20, max-steps 1–100, task-index ≥ 0')
    results = []
    for trial in range(1, args.trials + 1):
        try:
            if args.smoke:
                env = make_smoke_env()
            else:
                env = get_env(env_name=args.domain, user_strategy='human', user_model='unused', task_split=args.split, task_index=args.task_index)
                if args.user == 'llm':
                    env.user = ApiUser()
            result = PiTauAgent().solve(env, task_index=0 if args.smoke else args.task_index, max_num_steps=args.max_steps).model_dump()
            result['info']['user_cost'] = None
            if isinstance(env.user, ApiUser):
                result['info']['user_tokens'] = env.user.tokens
        except Exception as exc:
            result = {'reward': 0, 'messages': [], 'info': {'error_type': type(exc).__name__}, 'total_cost': None}
        results.append({'trial': trial, **result})
        print(f"trial={trial} reward={result['reward']} status={result['info'].get('pi_adapter', {}).get('status', 'error')}", flush=True)
    successes = sum(r['reward'] == 1 for r in results)
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({'benchmark': 'tau-bench-adapter-custom-smoke' if args.smoke else 'tau-bench-upstream',
        'upstream_commit': '59a200c6d575d595120f1cb70fea53cef0632f6b', 'domain': 'custom' if args.smoke else args.domain,
        'split': None if args.smoke else args.split, 'task_index': None if args.smoke else args.task_index,
        'user': 'scripted' if args.smoke else args.user, 'model': os.environ.get('MODEL_NAME'), 'generatedAt': datetime.now(timezone.utc).isoformat(),
        'successRate': successes / args.trials, 'passPowerK': {k: comb(successes, k) / comb(args.trials, k) if successes >= k else 0 for k in (1, 2, 3) if args.trials >= k},
        'notice': '自建冒烟任务，不是官方任务成绩。' if args.smoke else '选定官方任务的本地运行，不是全量评测；记录用户模拟器与模型配置后才可比较。',
        'results': results}, ensure_ascii=False, indent=2) + '\n')
    print(f'Report: {output}')
    return 0 if successes == args.trials else 1

if __name__ == '__main__':
    raise SystemExit(main())
