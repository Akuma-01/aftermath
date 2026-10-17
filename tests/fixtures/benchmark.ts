import type { BenchmarkResult, BenchmarkTrial } from '@aftermath/contracts';
import { fraction, summarize } from '@aftermath/evaluation';

/** Display/storage contract fixture. No engine benchmark or model measurement is fabricated. */
export function benchmarkFixture(
  projection: 'cold' | 'warm' = 'cold',
  failed = false,
): BenchmarkResult {
  const trials: BenchmarkTrial[] = (
    ['full-rerun', 'descendant-invalidation', 'aftermath'] as const
  ).map((method, order) => {
    const selected = method === 'aftermath' ? ['C1'] : ['C1', 'C2'];
    const errors = failed && method === 'aftermath' ? ['Fixture: required review was omitted'] : [];
    return {
      caseId: 'browser-contract-case',
      family: 'display-fixture',
      caseChecksum: 'a'.repeat(64),
      method,
      repetition: 0,
      order,
      projection,
      outcome: errors.length ? 'failed' : 'passed',
      errors,
      requiredReviewIds: ['C1'],
      selectedReviewIds: selected,
      affectedClaimIds: ['C1', 'C2'],
      paths: [['E1', 'C1']],
      finalStates: { C1: 'unsupported', C2: 'supported' },
      finalOriginCounts: { C1: 0, C2: 1 },
      metrics: {
        stateAccuracy: fraction(2, 2),
        originAccuracy: fraction(2, 2),
        reviewPrecision: fraction(1, selected.length),
        reviewRecall: fraction(1, 1),
        affectedStatementPreservation: fraction(method === 'aftermath' ? 1 : 0, 1),
        unsupportedAssertionRate: fraction(0, 1),
      },
      work: {
        claimsEvaluated: 2,
        supportEvaluationPasses: 1,
        graphReads: 1,
        impactTraversals: method === 'full-rerun' ? 0 : 1,
        requestedStatementRevisions: selected.length,
        avoidableStatementRevisions: selected.length - 1,
        preservedStatements: 2 - selected.length,
        modelCalls: 0,
        inputTokens: null,
        outputTokens: null,
      },
      timing: {
        totalMs: order + (projection === 'cold' ? 5 : 1),
        graphReadMs: 1,
        impactMs: 0,
        evaluationMs: 0,
        selectionMs: 0,
        warmupMs: projection === 'warm' ? 4 : 0,
      },
    };
  });
  if (failed) {
    const t = trials[2];
    t.selectedReviewIds = [];
    t.finalStates = {};
    t.finalOriginCounts = {};
    t.work.requestedStatementRevisions = 0;
    t.work.avoidableStatementRevisions = 0;
    t.work.preservedStatements = 0;
    t.metrics = {
      stateAccuracy: fraction(0, 2),
      originAccuracy: fraction(0, 2),
      reviewPrecision: fraction(0, 0),
      reviewRecall: fraction(0, 1),
      affectedStatementPreservation: fraction(0, 1),
      unsupportedAssertionRate: fraction(0, 0),
    };
  }
  return {
    version: 'deterministic-repair-v1',
    completedAt: `2026-09-26T08:0${projection === 'cold' ? '1' : '2'}:00.000Z`,
    seed: 7,
    repetitions: 1,
    projection,
    datasetChecksum: 'a'.repeat(64),
    caseCount: 1,
    malformedCaseCount: 1,
    outcome: failed ? 'failed' : 'passed',
    model: {
      provider: null,
      model: null,
      calls: 0,
      inputTokens: null,
      outputTokens: null,
      tokenSavings: null,
    },
    rejections: [
      {
        caseId: 'cycle-fixture',
        expectedError: 'Cycle',
        actualError: failed ? null : 'Cycle found',
        passed: !failed,
      },
    ],
    summary: summarize(trials) as BenchmarkResult['summary'],
    trials,
    metadata: {
      startedAt: '2026-09-26T08:00:00.000Z',
      node: 'v22.23.3',
      platform: 'linux',
      architecture: 'x64',
      cpu: 'Contract fixture',
      availableParallelism: 1,
      commit: null,
      sources: { 'fixture.ts': 'b'.repeat(64) },
      scope: 'Browser/storage contract fixture; no actual benchmark or model request.',
      timing: 'Synthetic display values only.',
      workload: 'One contract fixture.',
    },
  };
}
