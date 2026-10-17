import 'dotenv/config';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configuredAgents } from '@aftermath/agents';
import { Ledger } from '@aftermath/storage';
import { EvidenceGraph } from '@aftermath/graph';
import { InvestigationService } from '../apps/api/src/service';
import { runLiveRecovery } from './support/live-recovery';
import { diagnosticCases } from '@aftermath/evaluation';
import { runDiagnosticEvaluation } from './support/diagnostic-evaluation';

if (process.argv.includes('--list-diagnostics')) {
  for (const scenario of diagnosticCases()) console.log(`${scenario.id}: ${scenario.description}`);
  process.exit(0);
}

// Listing cases is offline; every invocation that could contact a provider requires explicit opt-in.
if (!process.argv.includes('--allow-live'))
  throw new Error(
    'Live provider requests require --allow-live and explicit approval of the intended call budget.',
  );
process.argv = process.argv.filter((arg) => arg !== '--allow-live');
const runtime = configuredAgents();
if (!runtime)
  throw new Error('Add GEMINI_API_KEY to .env before running the live acceptance check.');
// At most eight calls per SQL task. The recovery harness adds a shared run-wide cap.
runtime.config = {
  ...runtime.config,
  maxCalls: Math.min(8, runtime.config.maxCalls),
  timeoutMs: Math.min(30000, runtime.config.timeoutMs),
};
const failover = process.argv.includes('--failover');
if (
  failover &&
  (process.argv.length !== 3 || runtime.config.provider !== 'gemini' || !runtime.fallbackProvider)
)
  throw new Error(
    'Use --failover alone with Gemini and GEMINI_API_KEY_FALLBACK configured. It uses at most eight call slots, including one simulated primary quota failure.',
  );
if (process.argv.includes('--diagnostics') || failover) {
  const args = failover ? [] : process.argv.slice(2);
  if (
    args.some(
      (arg) => !/^(--diagnostics|--all|--case=[a-z-]+|--max-calls=[0-9]+|--seed=[0-9]+)$/.test(arg),
    )
  )
    throw new Error(
      'Diagnostic options: --diagnostics [--case=ID | --all] [--max-calls=8..40] [--seed=N]. Recovery resume flags do not apply.',
    );
  const option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (
    (args.includes('--all') && option('case')) ||
    new Set(args.map((a) => a.split('=')[0])).size !== args.length
  )
    throw new Error('Choose one case or --all, and supply each option once.');
  const caseIds = args.includes('--all')
    ? diagnosticCases().map((c) => c.id)
    : [option('case') ?? 'pool-followup'];
  const maxCalls = Number(option('max-calls') ?? (args.includes('--all') ? 40 : 8));
  const root = resolve(
    process.env.DATA_DIR ?? '.data',
    failover ? 'failover-acceptance' : 'diagnostic-acceptance',
  );
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'run-'));
  console.log(
    `Diagnostic selection: ${caseIds.length} condition(s), shared cap ${maxCalls} calls, eight per task. No worker retries or human diagnostic fallback. Backup key: ${runtime.fallbackProvider ? 'configured; shares the call cap' : 'not configured'}.`,
  );
  if (failover)
    console.log(
      'Controlled failover: one real primary request, then a SIMULATED quota failure; backup requests are live. No quota is intentionally exhausted.',
    );
  const result = await runDiagnosticEvaluation(dir, runtime, {
    caseIds,
    maxCalls,
    seed: Number(option('seed') ?? 20260926),
    progress: console.log,
    simulatePrimaryQuotaAfterRead: failover,
  });
  console.log(
    `Outcome: ${result.outcome}. ${result.usage.reservedCalls} reserved calls. Results: ${join(dir, 'result.json')}`,
  );
  if (result.outcome !== 'passed') {
    console.error(
      result.fatal ??
        result.cases
          .filter((c) => c.outcome !== 'passed')
          .map((c) => `${c.id}: ${c.reason}`)
          .join('\n'),
    );
    process.exitCode = 1;
  }
} else {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => !/^(--recovery|--continue-recovery|--resume=run-[a-zA-Z0-9]+)$/.test(arg)) ||
    new Set(args.map((arg) => arg.split('=')[0])).size !== args.length
  )
    throw new Error('Recovery options: --recovery [--resume=run-NAME --continue-recovery].');
  const root = resolve(process.env.DATA_DIR ?? '.data', 'live-acceptance');
  await mkdir(root, { recursive: true });
  const resume = process.argv.find((arg) => arg.startsWith('--resume='))?.slice('--resume='.length);
  if (
    process.argv.includes('--continue-recovery') &&
    (!resume || !process.argv.includes('--recovery'))
  )
    throw new Error('--continue-recovery requires --recovery and --resume=run-NAME.');
  if (resume && !/^run-[a-zA-Z0-9]+$/.test(resume))
    throw new Error('Resume requires a run directory name, for example --resume=run-Abc123.');
  const dir = resume ? join(root, resume) : await mkdtemp(join(root, 'run-'));
  if (resume) await access(join(dir, 'ledger'));
  if (
    resume &&
    !process.argv.includes('--recovery') &&
    (await access(join(dir, 'recovery-result.json')).then(
      () => true,
      () => false,
    ))
  )
    throw new Error(
      'This run has recovery history. Use --recovery --continue-recovery to preserve its initial result and shared budget.',
    );
  if (process.argv.includes('--recovery')) {
    console.log(
      'Live recovery acceptance: at most 24 provider requests across recovery checkpoints, no background retries.',
    );
    const result = await runLiveRecovery(dir, runtime, {
      progress: console.log,
      resume: process.argv.includes('--continue-recovery'),
    });
    console.log(
      `Outcome: ${result.outcome}. ${result.calls.length} additional reserved calls. Results: ${join(dir, 'recovery-result.json')}`,
    );
    if (result.outcome !== 'accepted') {
      console.error(result.failure);
      process.exitCode = 1;
    }
  } else {
    const ledger = await Ledger.open(join(dir, 'ledger'));
    const graph = await EvidenceGraph.open();
    const service = new InvestigationService(ledger, graph, runtime);
    try {
      const initial = resume ? (await ledger.list())[0] : await service.create();
      if (!initial) throw new Error('The selected run has no incident to resume.');
      if (!resume) await service.investigate(initial.id, initial.eventSeq, randomUUID());
      const task = (await ledger.jobs.work(initial.id)).tasks[0];
      console.log(
        `Testing ${runtime.config.provider}/${runtime.config.model}; max ${runtime.config.maxCalls} calls, ${runtime.config.maxOutputTokens} output tokens per call.`,
      );
      const outcome = await service.processor.process(task.id);
      const incident = await ledger.get(initial.id);
      const work = await ledger.jobs.work(initial.id);
      const summary = {
        provider: runtime.config.provider,
        model: runtime.config.model,
        outcome,
        completedAt: new Date().toISOString(),
        incidentId: incident.id,
        taskId: task.id,
        calls: work.modelCalls,
        tools: work.toolCalls,
        report: incident.reports.at(-1),
        attempts: work.attempts,
        inputTokens: work.modelCalls.every((c) => c.inputTokens !== null)
          ? work.modelCalls.reduce((sum, c) => sum + c.inputTokens!, 0)
          : null,
        outputTokens: work.modelCalls.every((c) => c.outputTokens !== null)
          ? work.modelCalls.reduce((sum, c) => sum + c.outputTokens!, 0)
          : null,
      };
      await writeFile(join(dir, 'result.json'), JSON.stringify(summary, null, 2));
      console.log(
        `Outcome: ${outcome}. ${work.modelCalls.length} provider calls. Results: ${join(dir, 'result.json')}`,
      );
      if (
        outcome !== 'accepted' ||
        !work.modelCalls.some((c) => c.role === 'investigator') ||
        !work.modelCalls.some((c) => c.role === 'reporter')
      ) {
        console.error(work.attempts[0]?.reason ?? 'Both agent roles must complete.');
        process.exitCode = 1;
      }
    } finally {
      await service.close();
    }
  }
}
