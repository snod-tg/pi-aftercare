import assert from 'node:assert/strict';
import test from 'node:test';
import { scenarioNames, runScenario, reliability } from '../src/evaluation/scenarios.js';
test('custom evaluation grades actual final state for each fault and approval scenario', async () => {
  for (const scenario of scenarioNames) {
    const result = await runScenario(scenario, 'fixture');
    assert.equal(result.success, true, JSON.stringify({ scenario, checks: result.checks, actual: result.actual }));
  }
});
test('pass^k measures all-k success rather than at-least-one pass@k', () => {
  assert.equal(reliability(2, 4, 2), 1 / 6);
  assert.equal(reliability(1, 4, 2), 0);
  assert.equal(reliability(4, 4, 3), 1);
  assert.throws(() => reliability(1, 1, 2));
});
