import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Diagnostic } from '@aftermath/contracts';
import type { ModelInput, ModelReply } from '@aftermath/agents';
import { diagnosticCases } from '@aftermath/evaluation';
import { ScriptedProvider, testConfig } from './support/scripted-provider';
import {
  diagnosticUsage,
  runDiagnosticEvaluation as evaluateDiagnostics,
} from '../scripts/support/diagnostic-evaluation';

async function runDiagnosticEvaluation(...args: Parameters<typeof evaluateDiagnostics>) {
  const result = await evaluateDiagnostics(...args);
  // A setup failure must not masquerade as an expected diagnostic rejection.
  expect(result.fatal, result.fatal ?? undefined).toBeNull();
  return result;
}

/** Chooses only from the production tool output, without access to the case oracle. */
class DiagnosticProvider extends ScriptedProvider {
  choose: 'ranked' | 'skip' | 'unavailable' = 'ranked';
  override async invoke(request: unknown): Promise<ModelReply> {
    const input = request as ModelInput;
    if (input.role === 'investigator' && input.history.length && this.choose !== 'skip') {
      const bundle = input.history.findLast((h) => h.name === 'getEvidenceBundle')?.result as
        { diagnostics?: Diagnostic[] } | undefined;
      const listed =
        bundle?.diagnostics ??
        (input.history.find((h) => h.name === 'listApplicableDiagnostics')?.result as
          Diagnostic[] | undefined);
      const selected =
        this.choose === 'unavailable'
          ? 'payment-timeouts'
          : listed?.find((d) => d.available && d.score > 0)?.id;
      const canList = input.tools.some((t) => t.name === 'listApplicableDiagnostics');
      const canRun =
        input.tools.some((t) => t.name === 'runDiagnostic') &&
        !input.history.some((h) => h.name === 'runDiagnostic');
      if (canList || (canRun && selected)) {
        this.inputs.push(structuredClone(input));
        await this.onInvoke?.(input);
        const call = canList
          ? { name: 'listApplicableDiagnostics', arguments: {} }
          : { name: 'runDiagnostic', arguments: { recipeId: selected } };
        return {
          raw: { testDouble: true, call },
          calls: [call],
          inputTokens: 120,
          outputTokens: 80,
          error: null,
        };
      }
    }
    return super.invoke(request);
  }
}
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'aftermath-diagnostic-evaluation-'));
  dirs.push(dir);
  const provider = new DiagnosticProvider();
  return { dir, provider, runtime: { provider, config: testConfig } };
}

it('exercises all five conditions through real graph retrieval and SQL publication', async () => {
  const { dir, provider, runtime } = await setup();
  const result = await runDiagnosticEvaluation(dir, runtime, {
    caseIds: diagnosticCases().map((c) => c.id),
    maxCalls: 40,
  });
  expect(result.outcome).toBe('passed');
  expect(result.summary).toMatchObject({
    cases: 5,
    passed: 5,
    failed: 0,
    skipped: 0,
    selectionsAssessed: 5,
    selectionsMatched: 5,
  });
  expect(result.usage.reservedCalls).toBe(provider.inputs.length);
  expect(result.usage.reservedCalls).toBe(26);
  expect(result.usage.inputTokens).toBe(26 * 120);
  expect(diagnosticUsage(result.cases[0].calls, 8)).toMatchObject({
    complete: false,
    inputTokens: null,
    outputTokens: null,
    failedCalls: null,
  });
  expect(result.semanticReview.status).toBe('not_scored');
  for (const row of result.cases) {
    expect(row.checks.every((c) => c.passed)).toBe(true);
    expect(row.calls.every((c) => c.response && c.request && c.manifest)).toBe(true);
    expect(row.calls.map((c) => c.manifest.modelCallIds?.length)).toEqual(
      row.calls.map((_, i) => i),
    );
    expect(row.tools.map((t) => t.modelCallId)).toEqual(row.calls.map((c) => c.id));
    expect(row.final?.events?.some((e) => e.type === 'diagnostic.completed')).toBe(false);
  }
  const pool = result.cases.find((c) => c.id === 'pool-followup')!;
  expect(pool.completedDiagnostics).toEqual(['production-pool']);
  expect(
    pool.final!.reports.at(-1)!.statements.find((s) => s.claimId === 'C6-v1')!.citationIds,
  ).toContain('E7-v1');
  const unavailable = result.cases.find((c) => c.id === 'missing-prerequisite')!;
  expect(unavailable.candidates.find((d) => d.id === 'payment-timeouts')?.available).toBe(false);
  expect(unavailable.requestedDiagnostics).toEqual([]);
  expect(unavailable.final?.reports.at(-1)?.agent?.diagnosticDecision).toMatchObject({
    status: 'not_needed',
    source: 'gateway',
    code: 'no_relevant_check',
  });
  expect(JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')).outcome).toBe('passed');
  expect(await readFile(join(dir, 'review.md'), 'utf8')).toContain('not assessed');
  await expect(runDiagnosticEvaluation(dir, runtime)).rejects.toThrow();
  expect(provider.inputs).toHaveLength(26);
});

it('records explicit deferral as a selection failure when the case expects execution', async () => {
  const { dir, provider, runtime } = await setup();
  provider.choose = 'skip';
  const result = await runDiagnosticEvaluation(dir, runtime);
  expect(result.outcome).toBe('failed');
  expect(result.cases[0]).toMatchObject({
    gatewayOutcome: 'accepted',
    selection: 'mismatched',
    outcome: 'failed',
    completedDiagnostics: [],
  });
  expect(
    result.cases[0].checks.find(
      (c) => c.name === 'Published report cites the new diagnostic observation',
    )?.passed,
  ).toBe(false);
  expect(result.cases[0].final?.reports.at(-1)?.agent?.diagnosticDecision).toMatchObject({
    status: 'deferred',
    source: 'agent',
  });
  expect(result.usage.reservedCalls).toBe(5);
});

it('retains a rejected unavailable check and does not count eventual publication as correct abstention', async () => {
  const { dir, provider, runtime } = await setup();
  provider.choose = 'unavailable';
  const result = await runDiagnosticEvaluation(dir, runtime, { caseIds: ['missing-prerequisite'] });
  expect(result.outcome).toBe('failed');
  expect(result.cases[0].selection).toBe('mismatched');
  expect(result.cases[0].requestedDiagnostics).toEqual([
    { recipeId: 'payment-timeouts', status: 'rejected' },
  ]);
  expect(result.cases[0].completedDiagnostics).toEqual([]);
});

it('stops after a provider failure, preserves missing usage, and never substitutes a human diagnostic', async () => {
  const { dir, provider, runtime } = await setup();
  provider.onInvoke = async () => {
    throw new Error('Test transport failure');
  };
  const result = await runDiagnosticEvaluation(dir, runtime, {
    caseIds: diagnosticCases().map((c) => c.id),
    maxCalls: 40,
  });
  expect(result.outcome).toBe('failed');
  expect(result.summary).toMatchObject({
    attempted: 1,
    failed: 1,
    skipped: 4,
    selectionsAssessed: 0,
    selectionsMatched: 0,
  });
  expect(result.usage).toMatchObject({
    reservedCalls: 1,
    failedCalls: 1,
    inputTokens: null,
    outputTokens: null,
  });
  expect(provider.inputs).toHaveLength(1);
  expect(result.cases[0].final!.completedDiagnosticIds).toEqual(
    result.cases[0].initial!.completedDiagnosticIds,
  );
});

it('marks cases skipped when the shared budget cannot fund another full diagnostic opportunity', async () => {
  const { dir, provider, runtime } = await setup();
  const result = await runDiagnosticEvaluation(dir, runtime, {
    caseIds: ['source-check', 'pool-followup'],
    maxCalls: 8,
  });
  expect(result.outcome).toBe('failed');
  expect(result.summary).toMatchObject({ attempted: 1, passed: 1, skipped: 1 });
  expect(result.dispatchedCalls).toBe(6);
  expect(provider.inputs).toHaveLength(6);
  expect(result.cases[1].reason).toContain('Fewer than eight calls remain');
});

it('validates case IDs and budgets before making calls or creating artifacts', async () => {
  const { dir, provider, runtime } = await setup();
  for (const options of [
    { caseIds: [] },
    { caseIds: ['missing'] },
    { caseIds: ['pool-followup', 'pool-followup'] },
    { maxCalls: 7 },
    { seed: -1 },
  ]) {
    await expect(runDiagnosticEvaluation(dir, runtime, options)).rejects.toThrow();
  }
  expect(await readdir(dir)).toEqual([]);
  expect(provider.inputs).toHaveLength(0);
  expect(diagnosticUsage([])).toEqual({
    reservedCalls: 0,
    auditedCalls: 0,
    complete: true,
    failedCalls: 0,
    inputTokens: null,
    outputTokens: null,
  });
});

it('counts primary failures and backup calls in the same diagnostic run budget and export', async () => {
  const { dir, provider, runtime } = await setup();
  provider.invoke = async () => ({
    raw: { httpStatus: 429 },
    calls: [],
    inputTokens: null,
    outputTokens: null,
    error: 'Quota reached',
    retryable: true,
  });
  const backup = new DiagnosticProvider();
  const result = await runDiagnosticEvaluation(
    dir,
    { ...runtime, fallbackProvider: backup },
    { maxCalls: 8 },
  );
  expect(result.outcome).toBe('passed');
  expect(result.backupConfigured).toBe(true);
  expect(result.dispatchedCalls).toBe(7);
  expect(result.usage).toMatchObject({
    reservedCalls: 7,
    auditedCalls: 7,
    failedCalls: 1,
    complete: true,
    inputTokens: null,
  });
  expect(backup.inputs).toHaveLength(6);
  expect(result.cases[0].calls[1]).toMatchObject({
    credentialSlot: 'backup',
    failoverFromCallId: result.cases[0].calls[0].id,
  });
});

it('labels a controlled primary failure and separates real provider invocations from reserved call slots', async () => {
  const { dir, provider, runtime } = await setup();
  const backup = new DiagnosticProvider();
  const result = await runDiagnosticEvaluation(
    dir,
    { ...runtime, fallbackProvider: backup },
    { simulatePrimaryQuotaAfterRead: true },
  );
  expect(result.outcome).toBe('passed');
  expect(result.cases[0].checks).toHaveLength(19);
  expect(provider.inputs).toHaveLength(1);
  expect(backup.inputs).toHaveLength(5);
  expect(result.dispatchedCalls).toBe(6);
  expect(result.usage).toMatchObject({
    reservedCalls: 7,
    auditedCalls: 7,
    complete: true,
    failedCalls: 1,
    inputTokens: 720,
    outputTokens: 480,
  });
  expect(result.faultInjection).toMatchObject({
    injectedFailures: 1,
    primaryProviderRequests: 1,
    backupProviderRequests: 5,
    toolJournalPreserved: true,
  });
  const calls = result.cases[0].calls;
  expect(calls[1].response).toMatchObject({ simulated: true, providerRequestMade: false });
  expect(calls[2].failoverFromCallId).toBe(calls[1].id);
  expect(backup.inputs[0].history[0].name).toBe('getEvidenceBundle');
  expect(await readFile(join(dir, 'review.md'), 'utf8')).toContain(
    'not a naturally observed quota outage',
  );
  await expect(
    runDiagnosticEvaluation(
      dir,
      { ...runtime, fallbackProvider: backup },
      { simulatePrimaryQuotaAfterRead: true },
    ),
  ).rejects.toThrow();
  expect(backup.inputs).toHaveLength(5);
});

it('rejects uncontrolled failover scenarios before provider calls or artifacts', async () => {
  const { dir, provider, runtime } = await setup();
  await expect(
    runDiagnosticEvaluation(dir, runtime, { simulatePrimaryQuotaAfterRead: true }),
  ).rejects.toThrow('requires a backup');
  for (const options of [
    { maxCalls: 9 },
    { caseIds: ['source-check'] },
    { caseIds: ['pool-followup', 'source-check'] },
  ]) {
    await expect(
      runDiagnosticEvaluation(
        dir,
        { ...runtime, fallbackProvider: new DiagnosticProvider() },
        { ...options, simulatePrimaryQuotaAfterRead: true },
      ),
    ).rejects.toThrow('Controlled failover');
  }
  expect(provider.inputs).toHaveLength(0);
  expect(await readdir(dir)).toEqual([]);
});

it('retains a controlled failover failure when the backup is unavailable, without retrying', async () => {
  const { dir, provider, runtime } = await setup();
  const backup = new DiagnosticProvider();
  backup.invoke = async () => ({
    raw: { httpStatus: 503 },
    calls: [],
    inputTokens: null,
    outputTokens: null,
    error: 'Backup unavailable',
    retryable: true,
  });
  const result = await runDiagnosticEvaluation(
    dir,
    { ...runtime, fallbackProvider: backup },
    { simulatePrimaryQuotaAfterRead: true },
  );
  expect(result.outcome).toBe('failed');
  expect(result.cases[0].reason).toBe('Backup unavailable');
  expect(provider.inputs).toHaveLength(1);
  expect(result.dispatchedCalls).toBe(2);
  expect(result.usage).toMatchObject({ reservedCalls: 3, failedCalls: 2, inputTokens: null });
  expect(result.faultInjection?.injectedFailures).toBe(1);
  expect(result.cases[0].final?.reportStatus).toBe('needs_review');
});

it('does not mislabel an actual initial primary failure as a completed controlled scenario', async () => {
  const { dir, provider, runtime } = await setup();
  provider.invoke = async () => ({
    raw: { httpStatus: 429 },
    calls: [],
    inputTokens: null,
    outputTokens: null,
    error: 'Actual provider quota response (test double)',
    retryable: true,
  });
  const result = await runDiagnosticEvaluation(
    dir,
    { ...runtime, fallbackProvider: new DiagnosticProvider() },
    { simulatePrimaryQuotaAfterRead: true },
  );
  expect(result.cases[0].gatewayOutcome).toBe('accepted');
  expect(result.outcome).toBe('failed');
  expect(result.faultInjection?.injectedFailures).toBe(0);
  expect(result.dispatchedCalls).toBe(result.usage.reservedCalls);
  expect(result.cases[0].checks.find((c) => c.name.startsWith('Exactly one labeled'))?.passed).toBe(
    false,
  );
});
