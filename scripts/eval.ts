import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { scenarioNames, runScenario, reliability, type ScenarioName, type EvalMode } from '../src/evaluation/scenarios.js';
import { readModelConnection } from '../src/agent/model-connection.js';
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] ?? ''; };
if (args.includes('--help')) {
  console.log('eval --mode fixture|live --case all|mixed|unconfirmed|out_of_stock|foreign_order|tool_error|response_lost|stale_inventory|model_error --trials 3 --output .data/evals/latest.json');
} else {
  const mode = option('--mode', 'fixture') as EvalMode;
  if (!['fixture', 'live'].includes(mode)) throw new Error('mode 必须是 fixture 或 live');
  const trials = Number(option('--trials', '3'));
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 20) throw new Error('trials 必须在1–20');
  const selected = option('--case', mode === 'fixture' ? 'all' : 'mixed');
  const cases = selected === 'all' ? scenarioNames.filter(name => mode === 'fixture' || name !== 'model_error') : [selected as ScenarioName];
  if (cases.some(name => !scenarioNames.includes(name))) throw new Error('未知评测场景');
  const connection = mode === 'live' ? readModelConnection() : undefined;
  const results: Array<Awaited<ReturnType<typeof runScenario>> & { trial: number }> = [];
  for (const name of cases) for (let trial = 1; trial <= trials; trial++) {
    const result = await runScenario(name, mode, connection);
    results.push({ ...result, trial });
    console.log(`${mode} ${name} #${trial}: ${result.success ? 'PASS' : 'FAIL'} (${result.durationMs}ms)`);
  }
  const metrics = cases.map(name => {
    const runs = results.filter(r => r.scenario === name); const successes = runs.filter(r => r.success).length;
    return { scenario: name, successes, trials, successRate: successes / trials, passPowerK: Object.fromEntries([1, 2, 3].filter(k => k <= trials).map(k => [k, reliability(successes, trials, k)])) };
  });
  const output = resolve(option('--output', '.data/evals/latest.json'));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ benchmark: 'pi-aftercare-custom', mode, notice: mode === 'fixture' ? '验证协议与业务边界，不是模型能力得分，也不是官方 τ-bench 成绩。' : '项目自建场景的真实模型评测，不是官方 τ-bench 成绩。', generatedAt: new Date().toISOString(), metrics, results }, null, 2));
  console.log(`Report: ${output}`);
  if (results.some(r => !r.success)) process.exitCode = 1;
}
