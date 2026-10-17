import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { EvidenceGraph } from '@aftermath/graph';
import { diagnosticCases, runDiagnosticCase, runDiagnosticEvaluation } from '@aftermath/evaluation';
let graph: EvidenceGraph;
beforeAll(async () => {
  graph = await EvidenceGraph.open();
});
afterAll(async () => {
  await graph?.close();
});
it.each(diagnosticCases())(
  '$id matches independent ranking, prerequisite and support expectations',
  async (scenario) => {
    const result = await runDiagnosticCase(graph, scenario);
    expect(result.errors).toEqual([]);
    expect(result.outcome).toBe('passed');
    expect(result.selectedDiagnostic).toBe(scenario.expectedDiagnostic);
    expect(result.beforeStates).toEqual(scenario.beforeStates);
    expect(result.afterStates).toEqual(scenario.afterStates);
    expect(result.modelCalls).toBe(0);
    if (scenario.id === 'missing-prerequisite')
      expect(result.candidates.find((c) => c.id === 'payment-timeouts')).toMatchObject({
        available: false,
        score: 0,
      });
  },
);
it('retains graph failures without crediting unmeasured abstention as success', async () => {
  const spy = vi.spyOn(graph, 'read').mockRejectedValueOnce(new Error('Graph unavailable'));
  try {
    const result = await runDiagnosticCase(graph, diagnosticCases()[3]);
    expect(result.outcome).toBe('failed');
    expect(result.selectionAssessed).toBe(false);
    expect(result.errors).toEqual(['Graph unavailable']);
  } finally {
    spy.mockRestore();
  }
});
it('records incorrect ranking as a failure even when graph support is valid', async () => {
  const scenario = structuredClone(diagnosticCases()[1]);
  scenario.expectedDiagnostic = 'production-pool';
  expect((await runDiagnosticCase(graph, scenario)).errors).toContain(
    'Graph ranking differs from expected diagnostic',
  );
});
it('aggregates all five actual graph evaluations without model calls', async () => {
  const result = await runDiagnosticEvaluation();
  expect(result.outcome).toBe('passed');
  expect(result.rankingAccuracy).toEqual({ numerator: 5, denominator: 5, value: 1 });
  expect(result.results).toHaveLength(5);
  expect(result.modelCalls).toBe(0);
});
