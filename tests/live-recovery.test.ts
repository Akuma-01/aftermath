import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ScriptedProvider, testConfig } from './support/scripted-provider';
import { Ledger } from '@aftermath/storage';
import { EvidenceGraph } from '@aftermath/graph';
import { InvestigationService } from '../apps/api/src/service';
import { randomUUID } from 'node:crypto';
import { runLiveRecovery } from '../scripts/support/live-recovery';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'aftermath-live-recovery-'));
  dirs.push(dir);
  return { dir, provider: new ScriptedProvider() };
}
it('rejects a missing recovery checkpoint without starting a new investigation', async () => {
  const { dir, provider } = await setup();
  await expect(
    runLiveRecovery(dir, { config: testConfig, provider }, { resume: true }),
  ).rejects.toThrow('No recovery checkpoint');
  expect(provider.inputs).toHaveLength(0);
  expect(await readdir(dir)).toEqual([]);
});
it('checks correction, held-report rejection, diagnostic publication and fresh model inputs after restart', async () => {
  const { dir, provider } = await setup();
  const result = await runLiveRecovery(dir, { config: testConfig, provider });
  expect(result.outcome).toBe('accepted');
  expect(result.checks.every((c) => c.passed)).toBe(true);
  expect(result.diagnosticOrigin).toBe('human-command');
  expect(result.calls).toHaveLength(23);
  expect(result.freshSession).toMatchObject({ storesReopened: true });
  expect(result.stages.find((s) => s.name === 'stale-report-rejection')).toMatchObject({
    outcome: 'stale',
    calls: 0,
  });
  expect(JSON.parse(await readFile(join(dir, 'recovery-result.json'), 'utf8')).outcome).toBe(
    'accepted',
  );
  await expect(runLiveRecovery(dir, { config: testConfig, provider })).rejects.toThrow(
    'will not be overwritten',
  );
});
it('records autonomous diagnostic execution separately from human diagnostic commands', async () => {
  const { dir, provider } = await setup();
  provider.diagnostic = true;
  const result = await runLiveRecovery(dir, { config: testConfig, provider });
  expect(result.outcome).toBe('accepted');
  expect(result.diagnosticOrigin).toBe('agent');
  expect(result.stages.some((s) => s.name === 'diagnostic-repair')).toBe(false);
});
it('stops at the run-wide call budget and retains a failed result without retrying', async () => {
  const { dir, provider } = await setup();
  const result = await runLiveRecovery(dir, { config: testConfig, provider }, { maxCalls: 4 });
  expect(result.outcome).toBe('failed');
  expect(result.failure).toContain('Insufficient acceptance budget');
  expect(provider.inputs).toHaveLength(4);
  expect(result.calls).toHaveLength(4);
  expect(result.stages[0].outcome).toBe('accepted');
  const resumed = await runLiveRecovery(
    dir,
    { config: testConfig, provider },
    { resume: true, maxCalls: 24 },
  );
  expect(resumed.outcome).toBe('failed');
  expect(resumed.maxAdditionalProviderCalls).toBe(4);
  expect(provider.inputs).toHaveLength(4);
});
it('resumes a failed stage without repeating completed stages or resetting the shared budget', async () => {
  const { dir, provider } = await setup();
  const failed = await runLiveRecovery(
    dir,
    { config: testConfig, provider },
    {
      progress: (message) => {
        if (message.startsWith('withdrawal-repair: running'))
          provider.onInvoke = async () => {
            throw new Error('Temporary test transport failure');
          };
      },
    },
  );
  expect(failed.outcome).toBe('failed');
  expect(provider.inputs).toHaveLength(9);
  provider.onInvoke = undefined;
  const resumed = await runLiveRecovery(dir, { config: testConfig, provider }, { resume: true });
  expect(resumed.outcome).toBe('accepted');
  expect(resumed.calls).toHaveLength(24);
  expect(resumed.stages.filter((s) => s.name === 'held-report')).toHaveLength(1);
  const archive = (await readdir(dir)).find((name) => name.startsWith('recovery-before-resume-'))!;
  expect(JSON.parse(await readFile(join(dir, archive), 'utf8')).outcome).toBe('failed');
});
it('enforces the shared budget in the middle of a diagnostic repair attempt', async () => {
  const { dir, provider } = await setup();
  const result = await runLiveRecovery(
    dir,
    { config: testConfig, provider },
    {
      maxCalls: 12,
      progress: (message) => {
        if (message.startsWith('withdrawal-repair: running')) provider.diagnostic = true;
      },
    },
  );
  expect(result.outcome).toBe('failed');
  expect(result.failure).toContain('call budget exhausted');
  expect(provider.inputs).toHaveLength(12);
  expect(result.calls).toHaveLength(12);
  expect(result.dispatchedCalls).toBe(12);
});

it('includes key failover in the shared recovery cap without replenishing the budget', async () => {
  const { dir, provider } = await setup();
  const backup = new ScriptedProvider();
  provider.invoke = async () => ({
    raw: { httpStatus: 503 },
    calls: [],
    inputTokens: null,
    outputTokens: null,
    error: 'Temporarily unavailable',
    retryable: true,
  });
  const result = await runLiveRecovery(
    dir,
    { config: testConfig, provider, fallbackProvider: backup },
    { maxCalls: 4 },
  );
  expect(result.outcome).toBe('failed');
  expect(result.backupConfigured).toBe(true);
  expect(result.dispatchedCalls).toBe(4);
  expect(result.calls).toHaveLength(4);
  expect(backup.inputs).toHaveLength(3);
  expect(result.failure).toContain('budget exhausted');
  expect(result.calls.filter((c) => c.failoverFromCallId)).toHaveLength(1);
});

it('excludes pre-existing model calls from recovery usage and audit output', async () => {
  const { dir, provider } = await setup();
  const ledger = await Ledger.open(join(dir, 'ledger'));
  const service = new InvestigationService(ledger, await EvidenceGraph.open(), {
    config: testConfig,
    provider,
  });
  let previousIds: string[] = [];
  try {
    const incident = await service.create();
    await service.investigate(incident.id, incident.eventSeq, randomUUID());
    const task = (await ledger.jobs.work(incident.id)).tasks[0];
    expect(await service.processor.process(task.id)).toBe('accepted');
    previousIds = (await ledger.jobs.work(incident.id)).modelCalls.map((call) => call.id);
    expect(previousIds).toHaveLength(4);
  } finally {
    await service.close();
  }
  const result = await runLiveRecovery(dir, { config: testConfig, provider });
  expect(result.outcome).toBe('accepted');
  expect(result.startingCalls).toBe(previousIds.length);
  expect(result.calls).toHaveLength(19);
  expect(result.calls.every((call) => !previousIds.includes(call.id))).toBe(true);
});
