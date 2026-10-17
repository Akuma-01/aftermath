import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const duration = z.number().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const benchmarkMethods = ['full-rerun', 'descendant-invalidation', 'aftermath'] as const;
const method = z.enum(benchmarkMethods);
const outcome = z.enum(['passed', 'failed']);
const fraction = z
  .object({ numerator: count, denominator: count, value: z.number().min(0).max(1).nullable() })
  .refine(
    (f) =>
      f.numerator <= f.denominator &&
      f.value === (f.denominator === 0 ? null : f.numerator / f.denominator),
    'Invalid metric ratio',
  );
const metrics = z.object({
  stateAccuracy: fraction,
  originAccuracy: fraction,
  reviewPrecision: fraction,
  reviewRecall: fraction,
  affectedStatementPreservation: fraction,
  unsupportedAssertionRate: fraction,
});
export const benchmarkMetadataSchema = z.object({
  startedAt: z.iso.datetime(),
  node: z.string(),
  platform: z.string(),
  architecture: z.string(),
  cpu: z.string().nullable(),
  availableParallelism: count,
  commit: z.string().nullable(),
  sources: z.record(z.string(), hash),
  scope: z.string(),
  timing: z.string(),
  workload: z.string(),
});
const trial = z.object({
  caseId: z.string(),
  family: z.string(),
  caseChecksum: hash,
  method,
  repetition: count,
  order: count,
  projection: z.enum(['cold', 'warm']),
  outcome,
  errors: z.array(z.string()),
  requiredReviewIds: z.array(z.string()),
  selectedReviewIds: z.array(z.string()),
  affectedClaimIds: z.array(z.string()).nullable(),
  paths: z.array(z.array(z.string())),
  finalStates: z.record(z.string(), z.string()),
  finalOriginCounts: z.record(z.string(), count),
  metrics,
  work: z.object({
    claimsEvaluated: count,
    supportEvaluationPasses: count,
    graphReads: count,
    impactTraversals: count,
    requestedStatementRevisions: count,
    avoidableStatementRevisions: count,
    preservedStatements: count,
    modelCalls: z.literal(0),
    inputTokens: z.null(),
    outputTokens: z.null(),
  }),
  timing: z.object({
    totalMs: duration,
    graphReadMs: duration,
    impactMs: duration,
    evaluationMs: duration,
    selectionMs: duration,
    warmupMs: duration,
  }),
});
export const benchmarkResultSchema = z.object({
  version: z.literal('deterministic-repair-v1'),
  completedAt: z.iso.datetime(),
  seed: count.max(0xffffffff),
  repetitions: count.min(1).max(10),
  projection: z.enum(['cold', 'warm']),
  datasetChecksum: hash,
  caseCount: count.min(1),
  malformedCaseCount: count,
  outcome,
  model: z.object({
    provider: z.null(),
    model: z.null(),
    calls: z.literal(0),
    inputTokens: z.null(),
    outputTokens: z.null(),
    tokenSavings: z.null(),
  }),
  rejections: z.array(
    z.object({
      caseId: z.string(),
      expectedError: z.string(),
      actualError: z.string().nullable(),
      passed: z.boolean(),
    }),
  ),
  summary: z
    .array(
      z.object({
        method,
        trials: count,
        failures: count,
        metrics,
        requestedStatementRevisions: count,
        claimsEvaluated: count,
        avoidableStatementRevisions: count,
        totalLatencyMs: z.object({
          median: duration.nullable(),
          min: duration.nullable(),
          max: duration.nullable(),
        }),
      }),
    )
    .length(3),
  trials: z.array(trial),
  metadata: benchmarkMetadataSchema,
});

export type BenchmarkResult = z.infer<typeof benchmarkResultSchema>;
export type BenchmarkTrial = BenchmarkResult['trials'][number];
export type BenchmarkMetadata = z.infer<typeof benchmarkMetadataSchema>;
export const benchmarkArtifacts = [
  'results.json',
  'trials.csv',
  'cases.json',
  'metadata.json',
  'summary.md',
  'failure.json',
] as const;
export type BenchmarkArtifact = (typeof benchmarkArtifacts)[number];
export interface BenchmarkRun {
  id: string;
  status: 'passed' | 'failed' | 'incomplete' | 'invalid';
  recordedAt: string;
  projection: 'cold' | 'warm' | null;
  datasetChecksum: string | null;
  caseCount: number | null;
  trialCount: number | null;
  issue: string | null;
}
export interface BenchmarkDetail extends BenchmarkRun {
  result: BenchmarkResult | null;
  metadata: BenchmarkMetadata | null;
  artifacts: BenchmarkArtifact[];
}
export interface BenchmarkIndex {
  runs: BenchmarkRun[];
  omitted: number;
}
