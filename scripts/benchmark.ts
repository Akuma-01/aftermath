import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus, availableParallelism } from 'node:os';
import { evaluationCases, invalidCases, runBenchmark, type Trial } from '@aftermath/evaluation';

const args = process.argv.slice(2);
if (args.some((arg) => !/^--(seed|repetitions|projection)=/.test(arg)))
  throw new Error('Options: --seed=20260926 --repetitions=3 --projection=cold|warm');
const option = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
const seed = Number(option('seed') ?? 20260926);
const repetitions = Number(option('repetitions') ?? 3);
const projection = option('projection') ?? 'cold';
if (projection !== 'cold' && projection !== 'warm')
  throw new Error('Projection must be cold or warm.');
const root = resolve(process.env.DATA_DIR ?? '.data', 'benchmarks');
await mkdir(root, { recursive: true });
const dir = await mkdtemp(join(root, 'run-'));
const cases = evaluationCases(),
  invalid = invalidCases();
const files = [
  'package-lock.json',
  'packages/evaluation/src/cases.ts',
  'packages/evaluation/src/runner.ts',
  'packages/domain/src/index.ts',
  'packages/contracts/src/index.ts',
  'packages/contracts/src/benchmarks.ts',
  'packages/agents/src/validation.ts',
  'packages/graph/src/index.ts',
  'packages/graph/src/queries.ts',
  'packages/graph/src/services.ts',
  'packages/fixtures/src/index.ts',
  'packages/storage/src/manifest.ts',
  'scripts/benchmark.ts',
];
const sources = Object.fromEntries(
  await Promise.all(
    files.map(async (name) => [
      name,
      createHash('sha256')
        .update(await readFile(name))
        .digest('hex'),
    ]),
  ),
);
let commit: string | null = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  /* An unversioned workspace still has exact source checksums. */
}
const metadata = {
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  cpu: cpus()[0]?.model ?? null,
  availableParallelism: availableParallelism(),
  commit,
  sources,
  scope:
    'Deterministic support and report-revision selection; no model, queue, SQL worker, or semantic-quality measurement.',
  timing:
    'Corrected graph read/projection, impact traversal where used, graph support materialization, independent TypeScript support evaluation/parity check, and deterministic report selection/assembly. Initial report preparation is excluded for all methods. Warm projection preparation is reported separately.',
  workload:
    '41 structural cases from 15 motifs (13 have three ID/order variants), plus six malformed-graph rejection cases. These are development fixtures, not held-out incident families.',
};
await writeFile(join(dir, 'cases.json'), JSON.stringify({ cases, invalid }, null, 2));
await writeFile(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
const percent = (value: number | null) => (value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`);
const csv = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
function trialRow(t: Trial) {
  return [
    t.caseId,
    t.family,
    t.caseChecksum,
    t.method,
    t.repetition,
    t.order,
    t.projection,
    t.outcome,
    t.metrics.stateAccuracy.value,
    t.metrics.originAccuracy.value,
    t.metrics.reviewPrecision.value,
    t.metrics.reviewRecall.value,
    t.metrics.affectedStatementPreservation.value,
    t.metrics.unsupportedAssertionRate.value,
    t.work.claimsEvaluated,
    t.work.requestedStatementRevisions,
    t.work.avoidableStatementRevisions,
    t.work.preservedStatements,
    t.work.graphReads,
    t.work.impactTraversals,
    t.timing.totalMs,
    t.timing.graphReadMs,
    t.timing.impactMs,
    t.timing.evaluationMs,
    t.timing.selectionMs,
    t.timing.warmupMs,
    t.work.modelCalls,
    t.work.inputTokens,
    t.work.outputTokens,
    JSON.stringify(t.selectedReviewIds),
    JSON.stringify(t.errors),
  ]
    .map(csv)
    .join(',');
}
try {
  console.log(
    `Deterministic benchmark: ${cases.length} cases, ${repetitions} repetitions, ${projection} projections; no model requests.`,
  );
  const result = await runBenchmark({
    seed,
    repetitions,
    projection,
    cases,
    invalid,
    progress: (done, total) => {
      if (done === 1 || done % 30 === 0 || done === total)
        console.log(`${done}/${total} strategy trials completed.`);
    },
  });
  await writeFile(join(dir, 'results.json'), JSON.stringify({ ...result, metadata }, null, 2));
  const header = [
    'case_id',
    'family',
    'case_checksum',
    'method',
    'repetition',
    'order',
    'projection',
    'outcome',
    'state_accuracy',
    'origin_accuracy',
    'review_precision',
    'review_recall',
    'affected_statement_preservation',
    'unsupported_assertion_rate',
    'claims_evaluated',
    'requested_statement_revisions',
    'avoidable_statement_revisions',
    'preserved_statements',
    'graph_reads',
    'impact_traversals',
    'total_ms',
    'graph_read_ms',
    'impact_ms',
    'evaluation_ms',
    'selection_ms',
    'warmup_ms',
    'model_calls',
    'input_tokens',
    'output_tokens',
    'selected_review_ids',
    'errors',
  ];
  await writeFile(
    join(dir, 'trials.csv'),
    [header.join(','), ...result.trials.map(trialRow)].join('\n') + '\n',
  );
  const lines = [
    '# Deterministic repair benchmark',
    '',
    `Outcome: **${result.outcome}**. ${result.caseCount} structural cases × ${repetitions} repetitions × 3 methods = ${result.trials.length} trials. ${result.rejections.filter((r) => r.passed).length}/${result.rejections.length} malformed graphs rejected as expected.`,
    '',
    `Dataset checksum: \`${result.datasetChecksum}\`. Seed: ${seed}. Projection: ${projection}. Completed: ${result.completedAt}.`,
    '',
    'All three methods evaluate the entire support graph. Revision requests measure the report-selection policy; no LLM runs or token savings are measured. Initial text and citations are seeded, and changed statements use a deterministic formatter.',
    '',
    '| Method | Failures | State accuracy | Review precision | Review recall | Preservable affected statements retained | Requested revisions | Claims evaluated | Median repair ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...result.summary.map(
      (s) =>
        `| ${s.method} | ${s.failures}/${s.trials} | ${percent(s.metrics.stateAccuracy.value)} | ${percent(s.metrics.reviewPrecision.value)} | ${percent(s.metrics.reviewRecall.value)} | ${percent(s.metrics.affectedStatementPreservation.value)} | ${s.requestedStatementRevisions} | ${s.claimsEvaluated} | ${s.totalLatencyMs.median?.toFixed(3) ?? 'N/A'} |`,
    ),
    '',
    'Precision/recall use the separately specified set of statements requiring revision, including obsolete citations even when support survives. Preservation applies only to affected statements that remain supported and need no citation/text revision. Zero denominators are N/A. Aggregate ratios use summed numerators/denominators; latency includes failed trials.',
    '',
    'Cold graph-read latency includes rebuilding the corrected projection. Warm runs prepare each corrected projection before starting the repair timer and retain that preparation time in raw data. Each strategy starts from its own copy; method/case order is shuffled with the recorded seed.',
    '',
    'The inputs contain 15 small structural motifs and ordering/identity variants. They are development fixtures, not independent real-world incident samples or a semantic benchmark. No production cost, end-to-end worker latency, or general model-reliability claim follows from these results.',
    '',
    'Raw evidence: `results.json` (all checks, paths, timings, and metrics), `trials.csv`, `cases.json` (inputs and explicit ground truth), `metadata.json` (environment and source checksums).',
    '',
  ];
  if (result.outcome !== 'passed')
    lines.push(
      '## Failures',
      '',
      ...result.trials
        .filter((t) => t.outcome === 'failed')
        .map((t) => `- ${t.caseId} / ${t.method}: ${t.errors.join('; ')}`),
    );
  await writeFile(join(dir, 'summary.md'), lines.join('\n'));
  console.log(`Outcome: ${result.outcome}. Results: ${join(dir, 'summary.md')}`);
  if (result.outcome !== 'passed') process.exitCode = 1;
} catch (error) {
  await writeFile(
    join(dir, 'failure.json'),
    JSON.stringify(
      { metadata, error: error instanceof Error ? error.message : 'Benchmark failed' },
      null,
      2,
    ),
  );
  throw error;
}
