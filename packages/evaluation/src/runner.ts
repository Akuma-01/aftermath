import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Evaluation, Incident, Statement } from '@aftermath/contracts';
import { evaluateSupport, makeReport, validateGraph } from '@aftermath/domain';
import { citationOptions, reportTargets, validateFindings } from '@aftermath/agents';
import { EvidenceGraph } from '@aftermath/graph';
import { readArtifacts } from '@aftermath/storage';
import {
  evaluationCases,
  invalidCases,
  type EvaluationCase,
  type GraphInput,
  type InvalidCase,
} from './cases';

export const METHODS = ['full-rerun', 'descendant-invalidation', 'aftermath'] as const;
export type Method = (typeof METHODS)[number];
export const EVALUATION_VERSION = 'deterministic-repair-v1';
export const fraction = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  value: denominator === 0 ? null : numerator / denominator,
});
type Fraction = ReturnType<typeof fraction>;
export function checksum(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
function shuffled<T>(values: readonly T[], next: () => number): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function state(input: GraphInput): Incident {
  return {
    id: randomUUID(),
    title: 'Deterministic repair evaluation',
    service: 'evaluation',
    severity: 'test',
    eventSeq: 1,
    evidenceEpoch: 1,
    reportStatus: 'current',
    evidence: structuredClone(input.evidence),
    claims: structuredClone(input.claims),
    evaluations: [],
    corrections: [],
    reports: [],
    events: [],
    sessions: [],
    completedDiagnosticIds: [],
    lastImpact: null,
    repairError: null,
  };
}
function findings(statements: Statement[], evaluations: Evaluation[]) {
  return statements.map((s) => ({
    claimId: s.claimId,
    summary: s.text,
    citationIds: s.citationIds ?? [],
    supportGroupIds:
      s.status === 'supported'
        ? evaluations.find((e) => e.claimId === s.claimId)!.validGroupIds
        : [],
    uncertainty: 'Synthetic structural evaluation; semantic truth is not measured.',
  }));
}
export interface Trial {
  caseId: string;
  family: string;
  caseChecksum: string;
  method: Method;
  repetition: number;
  order: number;
  projection: 'cold' | 'warm';
  outcome: 'passed' | 'failed';
  errors: string[];
  requiredReviewIds: string[];
  selectedReviewIds: string[];
  affectedClaimIds: string[] | null;
  paths: string[][];
  finalStates: Record<string, string>;
  finalOriginCounts: Record<string, number>;
  metrics: {
    stateAccuracy: Fraction;
    originAccuracy: Fraction;
    reviewPrecision: Fraction;
    reviewRecall: Fraction;
    affectedStatementPreservation: Fraction;
    unsupportedAssertionRate: Fraction;
  };
  work: {
    claimsEvaluated: number;
    supportEvaluationPasses: number;
    graphReads: number;
    impactTraversals: number;
    requestedStatementRevisions: number;
    avoidableStatementRevisions: number;
    preservedStatements: number;
    modelCalls: 0;
    inputTokens: null;
    outputTokens: null;
  };
  timing: {
    totalMs: number;
    graphReadMs: number;
    impactMs: number;
    evaluationMs: number;
    selectionMs: number;
    warmupMs: number;
  };
}
const sameIds = (a: string[], b: string[]) =>
  JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

/** Actual production support evaluation and statement selection; no model invocation. */
export async function runTrial(
  graph: EvidenceGraph,
  scenario: EvaluationCase,
  method: Method,
  repetition = 0,
  order = 0,
  projection: 'cold' | 'warm' = 'cold',
): Promise<Trial> {
  const errors: string[] = [];
  const timing = {
    totalMs: 0,
    graphReadMs: 0,
    impactMs: 0,
    evaluationMs: 0,
    selectionMs: 0,
    warmupMs: 0,
  };
  let selected: string[] = [],
    paths: string[][] = [];
  let affected: string[] | null = null;
  let evaluations: Evaluation[] = [];
  let final: Statement[] = [];
  let claimsEvaluated = 0,
    graphReads = 0,
    impactTraversals = 0,
    supportEvaluationPasses = 0;
  let start = performance.now();
  try {
    const before = state(scenario.before);
    before.evaluations = evaluateSupport(before.evidence, before.claims);
    for (const claim of before.claims) {
      if (
        before.evaluations.find((e) => e.claimId === claim.id)?.status !==
        scenario.oracle.beforeStates[claim.id]
      )
        errors.push(`Initial support differs from oracle: ${claim.id}`);
    }
    const previous = makeReport(before.claims, before.evaluations, 1);
    previous.statements = previous.statements.map((s) => ({
      ...s,
      text: `${s.text} [Seeded prior wording]`,
      citationIds: [...scenario.initialCitations[s.claimId]],
      author: 'fixture',
    }));
    validateFindings(
      { findings: findings(previous.statements, before.evaluations) },
      before.claims,
      before.evaluations,
      before.evidence,
    );
    before.reports = [previous];
    // This metadata exercises the same preservation selector as live repairs.
    // The initial wording/citations are seeded inputs, not fabricated model responses.
    previous.agent = {
      provider: 'deterministic-evaluation',
      model: 'none',
      attemptId: 'seeded',
      findings: [],
      inputArtifacts: readArtifacts(before),
    };
    const current: Incident = {
      ...before,
      eventSeq: 2,
      evidenceEpoch: 2,
      reportStatus: 'needs_review',
      evidence: structuredClone(scenario.after.evidence),
      claims: structuredClone(scenario.after.claims),
    };
    if (projection === 'warm') {
      const time = performance.now();
      await graph.read(current);
      timing.warmupMs = performance.now() - time;
    }
    // Fixture/seed preparation is outside the repair timer, identically for all methods.
    start = performance.now();
    let time = performance.now();
    graphReads++;
    const model = await graph.read(current);
    timing.graphReadMs = performance.now() - time;
    if (method !== 'full-rerun') {
      time = performance.now();
      const found = new Set<string>();
      for (const id of scenario.changedEvidenceIds) {
        impactTraversals++;
        const result = await graph.impact(current, id);
        result.affectedClaimIds.forEach((claimId) => found.add(claimId));
        paths.push(...result.paths);
      }
      affected = [...found].sort();
      timing.impactMs = performance.now() - time;
      if (!sameIds(affected, scenario.oracle.affectedClaimIds))
        errors.push('Graph impact differs from oracle');
    }
    time = performance.now();
    supportEvaluationPasses++;
    claimsEvaluated = model.claims.length;
    const reference = evaluateSupport(model.evidence, model.claims);
    evaluations = model.evaluations;
    const sorted = (items: Evaluation[]) =>
      [...items].sort((a, b) => a.claimId.localeCompare(b.claimId));
    if (checksum(sorted(reference)) !== checksum(sorted(evaluations)))
      errors.push('Graph support differs from independent TypeScript reference');
    timing.evaluationMs = performance.now() - time;
    time = performance.now();
    const proposal = makeReport(model.claims, evaluations, 2, previous);
    selected =
      method === 'full-rerun'
        ? model.claims.map((c) => c.id)
        : method === 'descendant-invalidation'
          ? affected!
          : reportTargets(
              proposal,
              previous,
              model.claims,
              evaluations,
              model.evidence,
              readArtifacts(current),
            );
    if (new Set(selected).size !== selected.length)
      errors.push('Duplicate statement revision request');
    if (method === 'aftermath' && !sameIds(selected, scenario.oracle.requiredReviewIds))
      errors.push('Selective report targets differ from oracle');
    if (scenario.oracle.requiredReviewIds.some((id) => !selected.includes(id)))
      errors.push('Required statement review was omitted');
    final = proposal.statements.map((s) =>
      selected.includes(s.claimId)
        ? {
            ...s,
            disposition: 'revised' as const,
            citationIds: [
              ...new Set(
                citationOptions(
                  model.claims.find((c) => c.id === s.claimId)!,
                  model.claims,
                  evaluations,
                  model.evidence,
                ).flat(),
              ),
            ],
          }
        : {
            ...previous.statements.find((old) => old.claimId === s.claimId)!,
            disposition: 'preserved' as const,
            validatedEpoch: 2,
          },
    );
    validateFindings(
      { findings: findings(final, evaluations) },
      model.claims,
      evaluations,
      model.evidence,
    );
    timing.selectionMs = performance.now() - time;
    for (const c of model.claims) {
      if (final.find((s) => s.claimId === c.id)?.status !== scenario.oracle.afterStates[c.id])
        errors.push(`Final state differs from oracle: ${c.id}`);
      if (
        evaluations.find((e) => e.claimId === c.id)?.originGroupIds.length !==
        scenario.oracle.afterOriginCounts[c.id]
      )
        errors.push(`Origin count differs from oracle: ${c.id}`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Unknown benchmark failure');
  }
  timing.totalMs = performance.now() - start;
  const expected = Object.keys(scenario.oracle.afterStates);
  const trueReviews = selected.filter((id) =>
    scenario.oracle.requiredReviewIds.includes(id),
  ).length;
  const preservable = scenario.oracle.affectedClaimIds.filter(
    (id) =>
      scenario.oracle.beforeStates[id] === 'supported' &&
      scenario.oracle.afterStates[id] === 'supported' &&
      !scenario.oracle.requiredReviewIds.includes(id),
  );
  const assertions = final.filter((s) => s.status === 'supported');
  return {
    caseId: scenario.id,
    family: scenario.family,
    caseChecksum: checksum(scenario),
    method,
    repetition,
    order,
    projection,
    outcome: errors.length ? 'failed' : 'passed',
    errors,
    requiredReviewIds: scenario.oracle.requiredReviewIds,
    selectedReviewIds: [...selected].sort(),
    affectedClaimIds: affected,
    paths,
    finalStates: Object.fromEntries(final.map((s) => [s.claimId, s.status])),
    finalOriginCounts: Object.fromEntries(
      evaluations.map((e) => [e.claimId, e.originGroupIds.length]),
    ),
    metrics: {
      stateAccuracy: fraction(
        expected.filter(
          (id) => final.find((s) => s.claimId === id)?.status === scenario.oracle.afterStates[id],
        ).length,
        expected.length,
      ),
      originAccuracy: fraction(
        expected.filter(
          (id) =>
            evaluations.find((e) => e.claimId === id)?.originGroupIds.length ===
            scenario.oracle.afterOriginCounts[id],
        ).length,
        expected.length,
      ),
      reviewPrecision: fraction(trueReviews, selected.length),
      reviewRecall: fraction(trueReviews, scenario.oracle.requiredReviewIds.length),
      affectedStatementPreservation: fraction(
        preservable.filter((id) =>
          final.some(
            (s) => s.claimId === id && s.disposition === 'preserved' && s.status === 'supported',
          ),
        ).length,
        preservable.length,
      ),
      unsupportedAssertionRate: fraction(
        assertions.filter((s) => scenario.oracle.afterStates[s.claimId] !== 'supported').length,
        assertions.length,
      ),
    },
    work: {
      claimsEvaluated,
      supportEvaluationPasses,
      graphReads,
      impactTraversals,
      requestedStatementRevisions: selected.length,
      avoidableStatementRevisions: selected.length - trueReviews,
      preservedStatements: final.filter((s) => s.disposition === 'preserved').length,
      modelCalls: 0,
      inputTokens: null,
      outputTokens: null,
    },
    timing,
  };
}

export function summarize(trials: Trial[]) {
  return METHODS.map((method) => {
    const rows = trials.filter((t) => t.method === method);
    const metrics = Object.fromEntries(
      (
        [
          'stateAccuracy',
          'originAccuracy',
          'reviewPrecision',
          'reviewRecall',
          'affectedStatementPreservation',
          'unsupportedAssertionRate',
        ] as const
      ).map((key) => [
        key,
        fraction(
          rows.reduce((s, r) => s + r.metrics[key].numerator, 0),
          rows.reduce((s, r) => s + r.metrics[key].denominator, 0),
        ),
      ]),
    );
    const values = rows.map((r) => r.timing.totalMs).sort((a, b) => a - b);
    const median = values.length
      ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2
      : null;
    return {
      method,
      trials: rows.length,
      failures: rows.filter((t) => t.outcome === 'failed').length,
      metrics,
      requestedStatementRevisions: rows.reduce((s, r) => s + r.work.requestedStatementRevisions, 0),
      claimsEvaluated: rows.reduce((s, r) => s + r.work.claimsEvaluated, 0),
      avoidableStatementRevisions: rows.reduce((s, r) => s + r.work.avoidableStatementRevisions, 0),
      totalLatencyMs: { median, min: values[0] ?? null, max: values.at(-1) ?? null },
    };
  });
}

export async function runBenchmark(
  options: {
    seed?: number;
    repetitions?: number;
    projection?: 'cold' | 'warm';
    cases?: EvaluationCase[];
    invalid?: InvalidCase[];
    progress?: (completed: number, total: number) => void;
  } = {},
) {
  const seed = options.seed ?? 20260926,
    repetitions = options.repetitions ?? 3,
    projection = options.projection ?? 'cold';
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10)
    throw new Error('Repetitions must be between 1 and 10.');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error('Seed must be an unsigned 32-bit integer.');
  const cases = options.cases ?? evaluationCases(),
    invalid = options.invalid ?? invalidCases();
  if (!cases.length || new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error('Benchmark requires a non-empty set of unique case IDs.');
  const rejections = invalid.map((item) => {
    let error: string | null = null;
    try {
      validateGraph(item.graph.evidence, item.graph.claims);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown failure';
    }
    return {
      caseId: item.id,
      expectedError: item.expectedError,
      actualError: error,
      passed: Boolean(error?.includes(item.expectedError)),
    };
  });
  const next = random(seed),
    trials: Trial[] = [];
  const graph = await EvidenceGraph.open();
  try {
    for (let repetition = 0; repetition < repetitions; repetition++) {
      for (const scenario of shuffled(cases, next)) {
        for (const method of shuffled(METHODS, next)) {
          trials.push(
            await runTrial(graph, scenario, method, repetition, trials.length, projection),
          );
          options.progress?.(trials.length, cases.length * METHODS.length * repetitions);
        }
      }
    }
  } finally {
    await graph.close();
  }
  return {
    version: EVALUATION_VERSION,
    completedAt: new Date().toISOString(),
    seed,
    repetitions,
    projection,
    datasetChecksum: checksum({ cases, invalid }),
    caseCount: cases.length,
    malformedCaseCount: invalid.length,
    outcome:
      trials.every((t) => t.outcome === 'passed') && rejections.every((r) => r.passed)
        ? 'passed'
        : 'failed',
    model: {
      provider: null,
      model: null,
      calls: 0,
      inputTokens: null,
      outputTokens: null,
      tokenSavings: null,
    },
    rejections,
    summary: summarize(trials),
    trials,
  };
}
