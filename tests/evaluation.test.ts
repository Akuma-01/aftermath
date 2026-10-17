import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { EvidenceGraph } from '@aftermath/graph';
import {
  evaluationCases,
  invalidCases,
  runTrial,
  runBenchmark,
  summarize,
  fraction,
  checksum,
} from '@aftermath/evaluation';

let graph: EvidenceGraph;
beforeAll(async () => {
  graph = await EvidenceGraph.open();
});
afterAll(async () => {
  await graph?.close();
});
const cases = evaluationCases();
it('has reproducible explicit ground truth for 41 valid and six malformed graph cases', () => {
  expect(cases).toHaveLength(41);
  expect(invalidCases()).toHaveLength(6);
  expect(checksum(evaluationCases())).toBe(checksum(cases));
  expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
});
it.each(cases)(
  '$id agrees with the separate support, origin, traversal and report-selection oracle',
  async (scenario) => {
    const result = await runTrial(graph, scenario, 'aftermath');
    expect(result.errors).toEqual([]);
    expect(result.outcome).toBe('passed');
    expect(result.metrics.stateAccuracy.value).toBe(1);
    expect(result.metrics.originAccuracy.value).toBe(1);
    expect(result.selectedReviewIds).toEqual([...scenario.oracle.requiredReviewIds].sort());
  },
);
it('compares conservative baselines without pretending fewer statements mean fewer support evaluations', async () => {
  const scenario = cases.find((c) => c.id === 'or-uncited-0')!;
  const full = await runTrial(graph, scenario, 'full-rerun');
  const descendant = await runTrial(graph, scenario, 'descendant-invalidation');
  const selective = await runTrial(graph, scenario, 'aftermath');
  expect([full, descendant, selective].map((r) => r.outcome)).toEqual([
    'passed',
    'passed',
    'passed',
  ]);
  expect([full, descendant, selective].map((r) => r.work.requestedStatementRevisions)).toEqual([
    2, 1, 0,
  ]);
  expect([full, descendant, selective].map((r) => r.work.claimsEvaluated)).toEqual([2, 2, 2]);
  expect(full.work.modelCalls).toBe(0);
  expect(full.work.inputTokens).toBeNull();
  expect(selective.metrics.reviewPrecision.value).toBeNull();
  expect(selective.metrics.affectedStatementPreservation.value).toBe(1);
});
it('does not preserve a stale citation just because alternative support survives', async () => {
  const result = await runTrial(
    graph,
    cases.find((c) => c.id === 'or-cited-0')!,
    'aftermath',
  );
  expect(result.outcome).toBe('passed');
  expect(result.selectedReviewIds).toEqual(['or-cited-0:A']);
  expect(result.finalStates['or-cited-0:A']).toBe('supported');
  expect(result.metrics.affectedStatementPreservation.value).toBeNull();
});
it('detects an incorrect oracle and preserves the failure in aggregate measurements', async () => {
  const scenario = structuredClone(cases[0]);
  scenario.oracle.afterStates[scenario.after.claims[0].id] = 'supported';
  scenario.oracle.requiredReviewIds = [];
  const result = await runTrial(graph, scenario, 'aftermath');
  expect(result.outcome).toBe('failed');
  expect(result.errors).toContain('Selective report targets differ from oracle');
  expect(result.metrics.stateAccuracy.value).toBeLessThan(1);
  expect(summarize([result]).find((s) => s.method === 'aftermath')!.failures).toBe(1);
  expect(fraction(0, 0).value).toBeNull();
});
it('records actual validator rejection and deterministic randomized strategy order', async () => {
  const options = { seed: 7, repetitions: 1, cases: cases.slice(0, 2) };
  const first = await runBenchmark(options);
  const second = await runBenchmark({ ...options, projection: 'warm' });
  expect(first.outcome).toBe('passed');
  expect(second.outcome).toBe('passed');
  expect(first.rejections.every((r) => r.passed)).toBe(true);
  expect(first.trials.map((r) => [r.caseId, r.method])).toEqual(
    second.trials.map((r) => [r.caseId, r.method]),
  );
  expect(second.trials.every((r) => r.timing.warmupMs > 0)).toBe(true);
});
it('counts failed graph reads as failures without crediting nonexistent preserved statements', async () => {
  const read = vi.spyOn(graph, 'read').mockRejectedValueOnce(new Error('Graph unavailable'));
  const result = await runTrial(
    graph,
    cases.find((c) => c.id === 'or-uncited-0')!,
    'aftermath',
  );
  read.mockRestore();
  expect(result.outcome).toBe('failed');
  expect(result.metrics.stateAccuracy.value).toBe(0);
  expect(result.metrics.affectedStatementPreservation).toEqual({
    numerator: 0,
    denominator: 1,
    value: 0,
  });
  expect(result.work.preservedStatements).toBe(0);
  expect(summarize([result]).find((r) => r.method === 'aftermath')!.totalLatencyMs.median).toBe(
    result.timing.totalMs,
  );
});
it('rejects empty datasets and duplicate cases instead of reporting vacuous success', async () => {
  await expect(runBenchmark({ cases: [] })).rejects.toThrow('non-empty');
  await expect(runBenchmark({ cases: [cases[0], cases[0]] })).rejects.toThrow('unique case IDs');
});

it('uses graph results for the measured outcome while flagging disagreement with the domain oracle', async () => {
  const read = graph.read.bind(graph);
  const spy = vi.spyOn(graph, 'read').mockImplementationOnce(async (incident) => {
    const result = await read(incident);
    result.evaluations[0].originGroupIds = ['incorrect-origin'];
    return result;
  });
  try {
    const result = await runTrial(graph, cases[0], 'full-rerun');
    expect(result.outcome).toBe('failed');
    expect(result.errors).toContain('Graph support differs from independent TypeScript reference');
    expect(result.metrics.originAccuracy.value).toBeLessThan(1);
  } finally {
    spy.mockRestore();
  }
});
