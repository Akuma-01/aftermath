import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Ledger, openDatabase } from '@aftermath/storage';
import { EvidenceGraph } from '@aftermath/graph';
import {
  validateFindings,
  validateReport,
  citationOptions,
  LEGACY_PROMPT_VERSION,
  DIAGNOSTIC_PROMPT_VERSION,
  reportTargets,
  type ModelInput,
  type ModelReply,
} from '@aftermath/agents';
import { evaluateSupport, makeReport } from '@aftermath/domain';
import { createIncident } from '@aftermath/fixtures';
import { InvestigationService } from '../apps/api/src/service';
import { ScriptedProvider, testConfig } from './support/scripted-provider';

describe.each(process.env.STORAGE_TEST_DATABASE_URL ? ['PGlite', 'PostgreSQL'] : ['PGlite'])(
  'agent publication on %s',
  (database) => {
    let ledger: Ledger;
    let graph: EvidenceGraph;
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'aftermath-agents-'));
      ledger = await Ledger.open(
        join(dir, 'ledger'),
        database === 'PostgreSQL' ? process.env.STORAGE_TEST_DATABASE_URL : undefined,
        { retryDelayMs: 0 },
      );
      graph = await EvidenceGraph.open();
    });
    afterAll(async () => {
      await graph?.close();
      await ledger?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    });
    async function setup(config = testConfig) {
      const provider = new ScriptedProvider();
      const service = new InvestigationService(ledger, graph, { config, provider });
      const initial = await service.create();
      await service.investigate(initial.id, initial.eventSeq, randomUUID());
      const task = (await ledger.jobs.work(initial.id)).tasks[0];
      return { provider, service, initial, task };
    }
    async function correctedSetup(config = testConfig) {
      const current = await setup(config);
      const incident = await ledger.get(current.initial.id);
      const corrected = await current.service.withdraw(
        incident.id,
        'E1-v1',
        'The import is from staging.',
        incident.eventSeq,
        randomUUID(),
      );
      const task = (await ledger.jobs.work(incident.id)).tasks.find(
        (t) => t.evidenceEpoch === corrected.evidenceEpoch && t.status === 'pending',
      )!;
      return { ...current, task };
    }
    async function missingDependencySetup(config = testConfig) {
      const current = await setup(config);
      const incident = await ledger.get(current.initial.id);
      const corrected = await current.service.withdraw(
        incident.id,
        'E6-v1',
        'This dependency map is outdated.',
        incident.eventSeq,
        randomUUID(),
      );
      const task = (await ledger.jobs.work(incident.id)).tasks.find(
        (t) => t.evidenceEpoch === corrected.evidenceEpoch && t.status === 'pending',
      )!;
      return { ...current, task };
    }
    it('publishes a support notice for an unsupported recommendation and excludes it from reporter writing', async () => {
      const { service, provider, initial, task } = await missingDependencySetup();
      expect(await service.processor.process(task.id)).toBe('accepted');
      const current = await ledger.get(initial.id);
      const statement = current.reports.at(-1)!.statements.find((s) => s.claimId === 'C5-v1')!;
      expect(statement).toMatchObject({
        author: 'gateway',
        status: 'unsupported',
        citationIds: [],
      });
      expect(statement.text).toBe(
        'Recommendation withheld because required support is missing or invalid.',
      );
      expect(statement.uncertainty).toContain('E6-v1: withdrawn');
      const bundle = provider.inputs.find((i) => i.role === 'reporter' && i.history.length)!
        .history[0].result as { requestedStatementIds: string[]; supportNotices: unknown[] };
      expect(bundle.requestedStatementIds).not.toContain('C5-v1');
      expect(bundle.supportNotices).toEqual([statement]);
      expect(provider.inputs).toHaveLength(4);
      await service.investigate(current.id, current.eventSeq, randomUUID());
      const next = (await ledger.jobs.work(current.id)).tasks.findLast(
        (t) => t.status === 'pending',
      )!;
      expect(await service.processor.process(next.id)).toBe('accepted');
      expect(
        (await ledger.get(current.id)).reports
          .at(-1)!
          .statements.find((s) => s.claimId === 'C5-v1'),
      ).toMatchObject({
        ...statement,
        disposition: 'preserved',
        validatedEpoch: (await ledger.get(current.id)).evidenceEpoch,
      });
    });
    it('reads each agent context once and refreshes it after a diagnostic', async () => {
      const { service, provider, initial, task } = await correctedSetup({
        ...testConfig,
        maxCalls: 8,
      });
      provider.diagnostic = true;
      const read = vi.spyOn(graph, 'read');
      try {
        expect(await service.processor.process(task.id)).toBe('accepted');
        expect(read).toHaveBeenCalledTimes(2);
        const [before, after] = await Promise.all(read.mock.results.map((r) => r.value));
        expect(before.evidence.some((e: { id: string }) => e.id === 'E7-v1')).toBe(false);
        expect(after.evidence.some((e: { id: string }) => e.id === 'E7-v1')).toBe(true);
        expect(after.view.projectedSeq).toBeGreaterThan(before.view.projectedSeq);
        const report = (await ledger.get(initial.id)).reports.at(-1)!;
        expect(report.statements.find((s) => s.claimId === 'C6-v1')?.citationIds).toContain(
          'E7-v1',
        );
        expect(report.statements.some((s) => s.citationIds?.includes('E1-v1'))).toBe(false);
      } finally {
        read.mockRestore();
      }
    });
    it('keeps recorded v2 wording until an explicit new v3 investigation repairs it without rewriting history', async () => {
      const { service, provider, initial, task } = await missingDependencySetup({
        ...testConfig,
        promptVersion: DIAGNOSTIC_PROMPT_VERSION,
      });
      const invoke = provider.invoke.bind(provider);
      provider.invoke = async (request) => {
        const reply = await invoke(request);
        if (reply.calls[0].name === 'proposeReport') {
          const statements = (
            reply.calls[0].arguments as { statements: Array<{ claimId: string; text: string }> }
          ).statements;
          statements.find((s) => s.claimId === 'C5-v1')!.text =
            'Run a bounded payment timeout check now.';
        }
        return reply;
      };
      expect(await service.processor.process(task.id)).toBe('accepted');
      const old = await ledger.get(initial.id);
      const prior = old.reports.at(-1)!;
      expect(prior.statements.find((s) => s.claimId === 'C5-v1')).toMatchObject({
        author: 'reporter',
        text: 'Insufficient current evidence. Run a bounded payment timeout check now.',
      });
      expect(JSON.stringify(provider.inputs)).not.toContain('supportNotices');
      const upgraded = new InvestigationService(ledger, graph, {
        config: testConfig,
        provider: new ScriptedProvider(),
      });
      await upgraded.investigate(old.id, old.eventSeq, randomUUID());
      const next = (await ledger.jobs.work(old.id)).tasks.findLast((t) => t.status === 'pending')!;
      expect(await upgraded.processor.process(next.id)).toBe('accepted');
      const current = await ledger.get(old.id);
      expect(current.reports.find((r) => r.version === prior.version)).toEqual(prior);
      expect(current.reports.at(-1)!.statements.find((s) => s.claimId === 'C5-v1')).toMatchObject({
        author: 'gateway',
        text: 'Recommendation withheld because required support is missing or invalid.',
        disposition: 'revised',
      });
    });
    function failoverReply(): ModelReply {
      return {
        raw: { httpStatus: 429 },
        calls: [],
        inputTokens: null,
        outputTokens: null,
        error: 'Gemini quota or rate limit reached (HTTP 429).',
        retryable: true,
      };
    }
    function withBackup(service: InvestigationService) {
      const backup = new ScriptedProvider();
      service.processor.agents!.fallbackProvider = backup;
      return backup;
    }
    it('switches to the backup mid-investigation, preserving the journal and separately auditing every request', async () => {
      const { service, provider, initial, task } = await setup({ ...testConfig, maxCalls: 5 });
      const backup = withBackup(service);
      const invoke = provider.invoke.bind(provider);
      provider.invoke = async (request) => {
        if ((request as ModelInput).history.length) {
          provider.inputs.push(structuredClone(request as ModelInput));
          return failoverReply();
        }
        return invoke(request);
      };
      expect(await service.processor.process(task.id)).toBe('accepted');
      expect(provider.inputs).toHaveLength(2);
      expect(backup.inputs).toHaveLength(3);
      expect(backup.inputs[0].history).toEqual(provider.inputs[1].history);
      const work = await ledger.jobs.work(initial.id);
      expect(work.modelCalls).toHaveLength(5);
      expect(work.toolCalls).toHaveLength(4);
      const failed = work.modelCalls.find((c) => c.status === 'failed')!;
      expect(failed.credentialSlot).toBe('primary');
      expect(failed.inputTokens).toBeNull();
      const switched = work.modelCalls.find((c) => c.failoverFromCallId)!;
      expect(switched).toMatchObject({
        credentialSlot: 'backup',
        failoverFromCallId: failed.id,
        status: 'succeeded',
      });
      expect(work.modelCalls.filter((c) => c.credentialSlot === 'backup')).toHaveLength(3);
      const detail = await ledger.jobs.modelCallDetail(initial.id, switched.id);
      expect(detail.failoverFromCallId).toBe(failed.id);
      expect(detail.manifest.modelCallIds).toContain(failed.id);
      expect(work.attempts[0].manifest?.modelCallIds).toHaveLength(5);
    });
    it('does not dispatch a backup request after the last budgeted call fails', async () => {
      const { service, provider, initial, task } = await setup({ ...testConfig, maxCalls: 4 });
      const backup = withBackup(service);
      const invoke = provider.invoke.bind(provider);
      provider.invoke = async (request) => {
        const input = request as ModelInput;
        if (input.role === 'reporter' && input.history.length) return failoverReply();
        return invoke(request);
      };
      expect(await service.processor.process(task.id)).toBe('failed');
      expect(backup.inputs).toHaveLength(0);
      const work = await ledger.jobs.work(initial.id);
      expect(work.modelCalls).toHaveLength(4);
      expect(work.attempts[0].reason).toContain('budget exhausted');
      expect((await ledger.get(initial.id)).reportStatus).toBe('needs_review');
    });
    it('tries each key at most once on failure within an attempt and preserves the SQL cap across worker retries', async () => {
      const { service, provider, initial, task } = await setup({ ...testConfig, maxCalls: 4 });
      const backup = withBackup(service);
      const primaryInvoke = vi.fn(async () => failoverReply());
      const backupInvoke = vi.fn(async () => failoverReply());
      provider.invoke = primaryInvoke;
      backup.invoke = backupInvoke;
      for (let i = 0; i < 3; i++) {
        // Dispatch only when the SQL outbox says the retry is due, as the runtime does.
        await vi.waitFor(async () => {
          expect((await ledger.jobs.deliveries()).some((d) => d.taskId === task.id)).toBe(true);
        });
        expect(await service.processor.process(task.id)).toBe('failed');
      }
      expect(primaryInvoke).toHaveBeenCalledTimes(2);
      expect(backupInvoke).toHaveBeenCalledTimes(2);
      const work = await ledger.jobs.work(initial.id);
      expect(work.modelCalls).toHaveLength(4);
      expect(work.tasks[0].status).toBe('failed');
      expect(work.toolCalls).toHaveLength(0);
    });
    it('keeps nonretryable provider errors visible without dispatching to the backup', async () => {
      const { service, provider, initial, task } = await setup();
      const backup = withBackup(service);
      provider.invoke = async () => ({
        ...failoverReply(),
        retryable: false,
        error: 'Invalid request schema',
      });
      expect(await service.processor.process(task.id)).toBe('failed');
      expect(backup.inputs).toHaveLength(0);
      expect((await ledger.jobs.work(initial.id)).modelCalls).toHaveLength(1);
    });
    it('recomputes diagnostic availability after failover consumes a reserved call', async () => {
      const { service, provider, initial, task } = await correctedSetup({
        ...testConfig,
        maxCalls: 7,
      });
      const backup = withBackup(service);
      const invoke = provider.invoke.bind(provider);
      provider.invoke = async (request) =>
        (request as ModelInput).history.length ? failoverReply() : invoke(request);
      expect(await service.processor.process(task.id)).toBe('accepted');
      expect(backup.inputs[0].tools.map((t) => t.name)).toEqual([
        'proposeClaims',
        'inspectServiceImpact',
      ]);
      const incident = await ledger.get(initial.id);
      expect(incident.completedDiagnosticIds).toHaveLength(0);
      expect(incident.reports.at(-1)?.agent?.diagnosticDecision).toMatchObject({
        source: 'gateway',
        code: 'call_budget',
      });
    });
    it('rejects stale context before contacting the backup after an intervening correction', async () => {
      const { service, provider, initial, task } = await setup();
      const backup = withBackup(service);
      provider.invoke = async () => {
        const current = await ledger.get(initial.id);
        await service.withdraw(
          initial.id,
          'E1-v1',
          'Staging source.',
          current.eventSeq,
          randomUUID(),
        );
        return failoverReply();
      };
      expect(await service.processor.process(task.id)).toBe('stale');
      expect(backup.inputs).toHaveLength(0);
      expect((await ledger.jobs.work(initial.id)).modelCalls).toHaveLength(1);
    });
    it('gates findings on execution or explicit deferral and exposes ranked candidates without hidden outcomes', async () => {
      const { service, provider, initial, task } = await correctedSetup({
        ...testConfig,
        maxCalls: 8,
      });
      provider.diagnostic = true;
      expect(await service.processor.process(task.id)).toBe('accepted');
      expect(provider.inputs[1].tools.map((t) => t.name)).toEqual([
        'runDiagnostic',
        'deferDiagnostics',
        'inspectServiceImpact',
      ]);
      expect(JSON.stringify(provider.inputs[1])).not.toContain('max_pool_utilization');
      expect(JSON.stringify(provider.inputs[1])).not.toContain('E7-v1');
      const report = (await ledger.get(initial.id)).reports.at(-1)!;
      expect(report.agent?.diagnosticDecision).toMatchObject({
        status: 'executed',
        source: 'agent',
        recipeId: 'production-pool',
      });
      expect(report.statements.find((s) => s.claimId === 'C6-v1')?.citationIds).toContain('E7-v1');
      expect(provider.inputs).toHaveLength(6);
    });
    it('finishes an executed check, one corrected proposal, and reporter history within eight calls', async () => {
      const { service, provider, initial, task } = await correctedSetup({
        ...testConfig,
        maxCalls: 8,
      });
      provider.diagnostic = true;
      const invoke = provider.invoke.bind(provider);
      let rejected = false;
      provider.invoke = async (request) => {
        const input = request as Parameters<typeof provider.buildRequest>[0];
        if (input.role === 'reporter' && input.tools.some((t) => t.name === 'getReportRevision')) {
          provider.inputs.push(structuredClone(input));
          return {
            raw: { testDouble: true },
            calls: [{ name: 'getReportRevision', arguments: {} }],
            inputTokens: 120,
            outputTokens: 80,
            error: null,
          };
        }
        const reply = await invoke(request);
        if (reply.calls[0].name === 'proposeClaims' && !rejected) {
          rejected = true;
          (
            reply.calls[0].arguments as { findings: Array<{ citationIds: string[] }> }
          ).findings[0].citationIds = ['invented-source'];
        }
        return reply;
      };
      expect(await service.processor.process(task.id)).toBe('accepted');
      const work = await ledger.jobs.work(initial.id);
      expect(work.modelCalls).toHaveLength(8);
      expect(work.toolCalls.filter((t) => t.status === 'rejected')).toHaveLength(1);
      expect((await ledger.get(initial.id)).reports.at(-1)?.agent?.diagnosticDecision?.status).toBe(
        'executed',
      );
    });
    it('retains an explicit deferral in the report and reporter context without executing a check', async () => {
      const { service, provider, initial, task } = await correctedSetup();
      expect(await service.processor.process(task.id)).toBe('accepted');
      const report = (await ledger.get(initial.id)).reports.at(-1)!;
      expect(report.agent?.diagnosticDecision).toMatchObject({
        status: 'deferred',
        source: 'agent',
        code: 'agent_deferred',
        consideredRecipeIds: ['production-pool', 'source-environment'],
      });
      const input = provider.inputs.find((i) => i.role === 'reporter' && i.history.length)!;
      expect(
        (input.history[0].result as { diagnosticDecision: unknown }).diagnosticDecision,
      ).toEqual(report.agent?.diagnosticDecision);
      expect((await ledger.get(initial.id)).completedDiagnosticIds).toEqual([]);
      expect(report.statements.find((s) => s.claimId === 'C2-v1')?.status).toBe('unsupported');
      expect(provider.inputs).toHaveLength(5);
    });
    it('rejects attempts to bypass the diagnostic decision gate without publishing', async () => {
      const { service, provider, initial, task } = await correctedSetup();
      provider.skipDiagnosticDecision = true;
      expect(await service.processor.process(task.id)).toBe('failed');
      const work = await ledger.jobs.work(initial.id);
      expect(
        work.toolCalls.filter((t) => t.name === 'proposeClaims' && t.status === 'rejected'),
      ).toHaveLength(2);
      expect((await ledger.get(initial.id)).reports.at(-1)!.agent).toBeUndefined();
      expect(provider.inputs).toHaveLength(3);
    });
    it.each(['missing', 'duplicate', 'unknown', 'blank'] as const)(
      'rejects a %s diagnostic deferral',
      async (kind) => {
        const { service, provider, initial, task } = await correctedSetup();
        const invoke = provider.invoke.bind(provider);
        provider.invoke = async (input) => {
          const reply = await invoke(input);
          if (reply.calls[0].name === 'deferDiagnostics') {
            const args = reply.calls[0].arguments as { recipeIds: string[]; reason: string };
            if (kind === 'missing') args.recipeIds = [];
            if (kind === 'duplicate') args.recipeIds = ['production-pool', 'production-pool'];
            if (kind === 'unknown') args.recipeIds = ['invented-check'];
            if (kind === 'blank') args.reason = '   ';
          }
          return reply;
        };
        expect(await service.processor.process(task.id)).toBe('failed');
        expect((await ledger.get(initial.id)).completedDiagnosticIds).toEqual([]);
      },
    );
    it('records budget-based deferral while retaining enough calls for both roles', async () => {
      const { service, provider, initial, task } = await correctedSetup({
        ...testConfig,
        maxCalls: 4,
      });
      expect(await service.processor.process(task.id)).toBe('accepted');
      expect(
        (await ledger.get(initial.id)).reports.at(-1)!.agent?.diagnosticDecision,
      ).toMatchObject({ status: 'deferred', source: 'gateway', code: 'call_budget' });
      expect(provider.inputs).toHaveLength(4);
      expect(
        provider.inputs.every(
          (i) => !i.tools.some((t) => ['runDiagnostic', 'deferDiagnostics'].includes(t.name)),
        ),
      ).toBe(true);
    });
    it('records why a held-report attempt cannot execute an otherwise relevant diagnostic', async () => {
      const { service, provider, initial } = await correctedSetup();
      const current = await ledger.get(initial.id);
      await service.holdReport(current.id, current.eventSeq, randomUUID());
      const task = (await ledger.jobs.work(current.id)).tasks.find(
        (t) => t.kind === 'report_preview',
      )!;
      expect(await service.processor.process(task.id)).toBe('paused');
      const input = provider.inputs.find((i) => i.role === 'reporter' && i.history.length)!;
      expect(
        (input.history[0].result as { diagnosticDecision: unknown }).diagnosticDecision,
      ).toMatchObject({ status: 'deferred', source: 'gateway', code: 'read_only_attempt' });
      expect((await ledger.get(initial.id)).completedDiagnosticIds).toEqual([]);
    });
    it('continues legacy investigations with their recorded protocol and budget', async () => {
      const { service, provider, initial, task } = await correctedSetup({
        ...testConfig,
        promptVersion: LEGACY_PROMPT_VERSION,
        maxCalls: 4,
      });
      expect(await service.processor.process(task.id)).toBe('accepted');
      const incident = await ledger.get(initial.id);
      expect(incident.agentConfig).toMatchObject({
        promptVersion: LEGACY_PROMPT_VERSION,
        maxCalls: 4,
      });
      expect(incident.reports.at(-1)!.agent?.diagnosticDecision).toBeUndefined();
      expect(JSON.stringify(provider.inputs)).not.toContain('diagnosticReview');
      expect(provider.inputs).toHaveLength(4);
    });
    it('executes both graph-backed roles, publishes cited wording, and retains full inputs and provider usage', async () => {
      const { service, provider, initial, task } = await setup();
      expect(await service.processor.process(task.id)).toBe('accepted');
      const incident = await ledger.get(initial.id);
      expect(incident.reports.at(-1)!.agent?.findings).toHaveLength(5);
      expect(incident.reports.at(-1)!.statements.every((s) => s.author === 'reporter')).toBe(true);
      const work = await ledger.jobs.work(initial.id);
      expect(work.modelCalls).toHaveLength(4);
      expect(new Set(work.modelCalls.map((c) => c.role))).toEqual(
        new Set(['investigator', 'reporter']),
      );
      expect(work.modelCalls.every((c) => c.inputTokens === 120 && c.status === 'succeeded')).toBe(
        true,
      );
      expect(work.toolCalls.map((c) => c.name)).toContain('getAcceptedFindings');
      const toolDetail = await ledger.jobs.toolCallDetail(initial.id, work.toolCalls[0].id);
      expect(toolDetail).toHaveProperty('arguments');
      expect(toolDetail).toHaveProperty('result');
      await expect(ledger.jobs.toolCallDetail(randomUUID(), toolDetail.id)).rejects.toThrow(
        'not found',
      );
      const detail = await ledger.jobs.modelCallDetail(initial.id, work.modelCalls[0].id);
      expect(detail.manifest.readArtifacts.some((a) => a.id === 'incident-context')).toBe(true);
      expect(detail.request).toBeTruthy();
      expect(detail.response).toHaveProperty('testDouble', true);
      expect(JSON.stringify(provider.inputs[0])).not.toContain('max_pool_utilization');
      expect(JSON.stringify(provider.inputs[1])).not.toContain('E7-v1');
      expect(work.attempts[0].manifest?.modelCallIds).toHaveLength(4);
      await expect(ledger.jobs.modelCallDetail(randomUUID(), detail.id)).rejects.toThrow(
        'not found',
      );
    });
    it('records nonnegative call durations when the wall clock moves backward', async () => {
      const { service, provider, initial, task } = await setup();
      const earlier = Date.now() - 60000;
      const clock = vi.spyOn(Date, 'now');
      provider.onInvoke = async () => {
        clock.mockReturnValue(earlier);
      };
      try {
        expect(await service.processor.process(task.id)).toBe('accepted');
      } finally {
        clock.mockRestore();
      }
      const calls = (await ledger.jobs.work(initial.id)).modelCalls;
      expect(calls).toHaveLength(4);
      expect(
        calls.every(
          (c) => c.latencyMs !== null && c.latencyMs >= 0 && Number.isInteger(c.latencyMs),
        ),
      ).toBe(true);
    });
    it('runs a requested diagnostic transactionally, rebuilds context, and publishes only after the fresh read', async () => {
      const { service, provider, initial, task } = await setup();
      provider.diagnostic = true;
      expect(await service.processor.process(task.id)).toBe('accepted');
      const current = await ledger.get(initial.id);
      expect(current.completedDiagnosticIds).toEqual(['production-pool']);
      expect(current.evidenceEpoch).toBe(3);
      expect(current.reports.at(-1)!.evidenceEpoch).toBe(3);
      expect(current.reports.at(-1)!.statements.some((s) => s.citationIds?.includes('E7-v1'))).toBe(
        true,
      );
      expect(
        provider.inputs.filter((i) => i.role === 'investigator' && i.history.length === 0),
      ).toHaveLength(2);
      const work = await ledger.jobs.work(initial.id);
      expect(work.attempts[0].manifest?.readArtifacts.some((a) => a.id === 'E7-v1')).toBe(true);
      expect(work.toolCalls.filter((t) => t.name === 'runDiagnostic')).toHaveLength(1);
    });
    it('reserves reporter calls after diagnostic exploration and one corrected investigator proposal', async () => {
      const { service, initial, task, provider } = await setup({
        ...testConfig,
        promptVersion: LEGACY_PROMPT_VERSION,
        maxCalls: 8,
      });
      provider.diagnostic = true;
      const invoke = provider.invoke.bind(provider);
      let rejectedOnce = false;
      provider.invoke = async (request) => {
        const input = request as Parameters<typeof provider.buildRequest>[0];
        const readExtra = input.tools.find(
          (t) =>
            t.name ===
            (input.role === 'investigator' ? 'listApplicableDiagnostics' : 'getReportRevision'),
        );
        if (input.history.length && readExtra) {
          provider.inputs.push(structuredClone(input));
          return {
            raw: { testDouble: true },
            calls: [{ name: readExtra.name, arguments: {} }],
            inputTokens: 120,
            outputTokens: 80,
            error: null,
          };
        }
        const reply = await invoke(request);
        if (reply.calls[0].name === 'proposeClaims' && !rejectedOnce) {
          rejectedOnce = true;
          const args = reply.calls[0].arguments as {
            findings: Array<{ claimId: string; citationIds: string[] }>;
          };
          args.findings.find((f) => f.claimId === 'C5-v1')!.citationIds = ['E6-v1'];
        }
        return reply;
      };
      expect(await service.processor.process(task.id)).toBe('accepted');
      const work = await ledger.jobs.work(initial.id);
      expect(work.modelCalls).toHaveLength(8);
      expect(work.toolCalls.filter((t) => t.status === 'rejected')).toHaveLength(1);
      expect(work.toolCalls.filter((t) => t.name === 'listApplicableDiagnostics')).toHaveLength(1);
      expect(work.modelCalls.filter((c) => c.role === 'reporter')).toHaveLength(2);
    });
    it('rejects an in-flight reporter when a user withdraws evidence, keeping the old report historical', async () => {
      const { service, provider, initial, task } = await setup();
      let changed = false;
      provider.onInvoke = async (input) => {
        if (input.role !== 'reporter' || !input.history.length || changed) return;
        changed = true;
        const current = await ledger.get(initial.id);
        await service.withdraw(
          initial.id,
          'E1-v1',
          'Staging evidence was mislabeled',
          current.eventSeq,
          randomUUID(),
        );
      };
      expect(await service.processor.process(task.id)).toBe('stale');
      const incident = await ledger.get(initial.id);
      expect(incident.reports).toHaveLength(1);
      expect(incident.reportStatus).toBe('needs_review');
      const work = await ledger.jobs.work(initial.id);
      expect(work.attempts[0].status).toBe('stale');
      expect(
        work.tasks.some(
          (t) => t.status === 'pending' && t.evidenceEpoch === incident.evidenceEpoch,
        ),
      ).toBe(true);
      expect(work.modelCalls).toHaveLength(4);
    });
    it('preserves unrelated model-written statements through correction and excludes the withdrawn version', async () => {
      const { service, initial, task, provider } = await setup();
      await service.processor.process(task.id);
      const before = await ledger.get(initial.id);
      await service.withdraw(
        initial.id,
        'E1-v1',
        'Staging evidence was mislabeled',
        before.eventSeq,
        randomUUID(),
      );
      const repair = (await ledger.jobs.work(initial.id)).tasks.find(
        (t) => t.status === 'pending',
      )!;
      expect(await service.processor.process(repair.id)).toBe('accepted');
      const after = await ledger.get(initial.id);
      const payment = after.reports.at(-1)!.statements.find((s) => s.claimId === 'C4-v1')!;
      expect(payment.text).toBe(
        before.reports.at(-1)!.statements.find((s) => s.claimId === 'C4-v1')!.text,
      );
      expect(payment.disposition).toBe('preserved');
      expect(after.reports.at(-1)!.statements.some((s) => s.citationIds?.includes('E1-v1'))).toBe(
        false,
      );
      const latestRead = provider.inputs.findLast(
        (i) => i.role === 'investigator' && i.history.length > 0,
      )!;
      expect(JSON.stringify(latestRead)).toContain('Staging evidence was mislabeled');
      expect(JSON.stringify(latestRead)).not.toContain('previous chat');
    });
    it('rejects a diagnostic requested with stale context and records the rejected tool invocation', async () => {
      const { service, initial, task, provider } = await setup();
      provider.diagnostic = true;
      let changed = false;
      provider.onInvoke = async (input) => {
        if (!input.history.length || changed) return;
        changed = true;
        const current = await ledger.get(initial.id);
        await service.withdraw(
          initial.id,
          'E1-v1',
          'Corrected while the diagnostic was proposed',
          current.eventSeq,
          randomUUID(),
        );
      };
      expect(await service.processor.process(task.id)).toBe('stale');
      const incident = await ledger.get(initial.id);
      expect(incident.evidence.some((e) => e.id === 'E7-v1')).toBe(false);
      expect(incident.completedDiagnosticIds).toEqual([]);
      const work = await ledger.jobs.work(initial.id);
      expect(work.toolCalls.find((t) => t.name === 'runDiagnostic')?.status).toBe('rejected');
    });
    it('records invalid citation proposals and never substitutes a fixture report', async () => {
      const { service, initial, task, provider } = await setup();
      provider.rejectCitations = true;
      expect(await service.processor.process(task.id)).toBe('failed');
      expect((await ledger.get(initial.id)).reports).toHaveLength(1);
      const work = await ledger.jobs.work(initial.id);
      expect(work.toolCalls.filter((t) => t.status === 'rejected')).toHaveLength(2);
      expect(work.attempts[0].reason).toContain('invalid tool');
    });
    it('enforces the persisted model-call budget across worker retries', async () => {
      const { service, initial, task, provider } = await setup({ ...testConfig, maxCalls: 4 });
      provider.onInvoke = async (input) => {
        if (input.role === 'reporter') throw new Error('Simulated provider disconnect');
      };
      for (let n = 0; n < 3; n++) expect(await service.processor.process(task.id)).toBe('failed');
      expect(provider.inputs).toHaveLength(4);
      const work = await ledger.jobs.work(initial.id);
      expect(work.modelCalls).toHaveLength(4);
      expect(work.tasks[0].status).toBe('failed');
      expect((await ledger.get(initial.id)).reportStatus).toBe('needs_review');
    });
    it('enforces concurrent SQL call reservations and rejects forged sequences and configuration', async () => {
      const { service, task } = await setup({ ...testConfig, maxCalls: 4 });
      const claimed = (await ledger.jobs.claim(task.id))!;
      const { manifest } = await service.processor.prepare(claimed.incident);
      const config = claimed.incident.agentConfig!;
      await expect(
        ledger.jobs.reserveModelCall(
          task.id,
          claimed.attempt.id,
          'investigator',
          config,
          {},
          { ...manifest, projectedSeq: manifest.projectedSeq + 1 },
        ),
      ).rejects.toThrow('context');
      await expect(
        ledger.jobs.reserveModelCall(
          task.id,
          claimed.attempt.id,
          'investigator',
          { ...config, maxCalls: 20 },
          {},
          manifest,
        ),
      ).rejects.toThrow('configuration');
      const other =
        database === 'PostgreSQL'
          ? await Ledger.open(undefined, process.env.STORAGE_TEST_DATABASE_URL)
          : ledger;
      try {
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, (_, n) =>
            (n % 2 ? other : ledger).jobs.reserveModelCall(
              task.id,
              claimed.attempt.id,
              'investigator',
              config,
              {},
              manifest,
            ),
          ),
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(4);
        expect(await ledger.jobs.modelCallsUsed(task.id)).toBe(4);
      } finally {
        if (other !== ledger) await other.close();
      }
    });
    it('resumes a held agent proposal without spending additional calls', async () => {
      const { service, initial, task, provider } = await setup();
      expect(await service.processor.process(task.id)).toBe('accepted');
      let current = await ledger.get(initial.id);
      await service.holdReport(current.id, current.eventSeq, randomUUID());
      const held = (await ledger.jobs.work(current.id)).tasks.findLast(
        (t) => t.kind === 'report_preview',
      )!;
      expect(await service.processor.process(held.id)).toBe('paused');
      const calls = provider.inputs.length;
      current = await ledger.get(initial.id);
      await service.resumeReport(current.id, held.id, current.eventSeq, randomUUID());
      expect(await service.processor.process(held.id)).toBe('accepted');
      expect(provider.inputs).toHaveLength(calls);
      expect((await ledger.get(initial.id)).reports).toHaveLength(3);
    });
    it('bounds a transport that ignores cancellation and never publishes its late result', async () => {
      const { service, initial, task, provider } = await setup({ ...testConfig, timeoutMs: 1000 });
      provider.invoke = () => new Promise(() => {});
      expect(await service.processor.process(task.id)).toBe('failed');
      const work = await ledger.jobs.work(initial.id);
      expect(work.modelCalls).toHaveLength(1);
      expect(work.modelCalls[0]).toMatchObject({
        status: 'failed',
        inputTokens: null,
        outputTokens: null,
      });
      expect(work.modelCalls[0].error).toContain('timed out');
      expect((await ledger.get(initial.id)).reports).toHaveLength(1);
    });
    it('rejects oversized requests before reserving or dispatching a model call', async () => {
      const { service, initial, task, provider } = await setup();
      provider.buildRequest = (input) => ({
        ...input,
        instructions: 'x'.repeat(testConfig.maxContextBytes + 1),
      });
      expect(await service.processor.process(task.id)).toBe('failed');
      expect(provider.inputs).toHaveLength(0);
      expect((await ledger.jobs.work(initial.id)).modelCalls).toHaveLength(0);
    });
    it('rejects a sequence change between agent calls even when evidence and artifact hashes are unchanged', async () => {
      const { service, initial, task, provider } = await setup();
      provider.onInvoke = async () => {
        const current = await ledger.get(initial.id);
        await ledger.mutate(
          initial.id,
          current.eventSeq,
          { key: randomUUID(), fingerprint: 'sequence-only' },
          'test.sequence_changed',
          'Unrelated command',
          () => {},
        );
      };
      expect(await service.processor.process(task.id)).toBe('stale');
      expect(provider.inputs).toHaveLength(1);
      expect(
        (await ledger.jobs.work(initial.id)).tasks.filter((t) => t.status === 'pending'),
      ).toHaveLength(1);
      expect((await ledger.get(initial.id)).reports).toHaveLength(1);
    });
    it('audits an actual graph service-impact tool with the current projection', async () => {
      const { service, initial, task, provider } = await setup();
      const invoke = provider.invoke.bind(provider);
      let inspected = false;
      provider.invoke = async (request) => {
        const input = request as ModelInput;
        if (!inspected && input.tools.some((t) => t.name === 'inspectServiceImpact')) {
          inspected = true;
          return {
            raw: {},
            calls: [{ name: 'inspectServiceImpact', arguments: { serviceId: 'database' } }],
            inputTokens: 1,
            outputTokens: 1,
            error: null,
          };
        }
        return invoke(request);
      };
      expect(await service.processor.process(task.id)).toBe('accepted');
      const work = await ledger.jobs.work(initial.id);
      const tool = work.toolCalls.find((t) => t.name === 'inspectServiceImpact')!;
      expect(tool.status).toBe('succeeded');
      const detail = await ledger.jobs.toolCallDetail(initial.id, tool.id);
      expect(detail.result).toMatchObject({
        generation: detail.manifest.graphGeneration,
        projectedSeq: detail.manifest.projectedSeq,
      });
      expect(inspected).toBe(true);
    });
    it('records provider timeouts as failures with unknown usage', async () => {
      const { service, initial, task, provider } = await setup();
      provider.invoke = async () => {
        throw new Error('Private transport details');
      };
      expect(await service.processor.process(task.id)).toBe('failed');
      const work = await ledger.jobs.work(initial.id);
      expect(work.modelCalls[0].status).toBe('failed');
      expect(work.modelCalls[0].inputTokens).toBeNull();
      expect(work.modelCalls[0].error).not.toContain('Private');
      expect((await ledger.get(initial.id)).reports.at(-1)!.agent).toBeUndefined();
    });
  },
);

it('upgrades existing call history without rewriting legacy audit rows or report revisions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aftermath-failover-migration-'));
  const path = join(dir, 'ledger');
  let ledger: Ledger | undefined;
  let graph: EvidenceGraph | undefined;
  try {
    ledger = await Ledger.open(path);
    graph = await EvidenceGraph.open();
    const service = new InvestigationService(ledger, graph, {
      config: testConfig,
      provider: new ScriptedProvider(),
    });
    const incident = await service.create();
    await service.investigate(incident.id, incident.eventSeq, randomUUID());
    const task = (await ledger.jobs.work(incident.id)).tasks[0];
    expect(await service.processor.process(task.id)).toBe('accepted');
    const report = (await ledger.get(incident.id)).reports.at(-1);
    const work = await ledger.jobs.work(incident.id);
    const call = await ledger.jobs.modelCallDetail(incident.id, work.modelCalls[0].id);
    await ledger.close();
    ledger = undefined;
    // Reconstruct the preceding schema around real existing call/report records.
    const old = await openDatabase(path);
    try {
      await old.query('ALTER TABLE model_calls DROP COLUMN failover_from_call_id');
      await old.query('ALTER TABLE model_calls DROP COLUMN credential_slot');
      await old.query("DELETE FROM schema_migrations WHERE name='004-agent-failover.sql'");
    } finally {
      await old.close();
    }
    ledger = await Ledger.open(path);
    expect((await ledger.get(incident.id)).reports.at(-1)).toEqual(report);
    expect(await ledger.jobs.modelCallDetail(incident.id, call.id)).toEqual({
      ...call,
      credentialSlot: null,
      failoverFromCallId: null,
    });
  } finally {
    await graph?.close();
    await ledger?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('reports all duplicate-support and uncertainty errors for the exact claim', () => {
  const { claims, evidence, evaluations } = createIncident();
  const findings = claims.map((c) => ({
    claimId: c.id,
    summary: c.text,
    supportGroupIds: evaluations.find((e) => e.claimId === c.id)!.validGroupIds,
    citationIds: [...new Set(citationOptions(c, claims, evaluations, evidence).flat())],
    uncertainty: 'Causality is unverified.' as string | null,
  }));
  findings[4].supportGroupIds = ['C5-G1', 'C5-G1'];
  findings[4].uncertainty = null;
  let message = '';
  try {
    validateFindings({ findings }, claims, evaluations, evidence);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain('C5-v1: supportGroupIds must contain unique IDs');
  expect(message).toContain('C5-v1: uncertainty must be a non-empty statement');
  expect(() =>
    validateFindings(
      { findings: findings.filter((f) => f.claimId !== 'C2-v1') },
      claims,
      evaluations,
      evidence,
    ),
  ).toThrow('Missing: C2-v1');
});

it('rejects invented claim rules, withdrawn citations, and incomplete AND support', () => {
  const incident = createIncident();
  const { claims, evidence, evaluations } = incident;
  const findings = claims.map((c) => ({
    claimId: c.id,
    summary: c.text,
    supportGroupIds: evaluations.find((e) => e.claimId === c.id)!.validGroupIds,
    citationIds: [...new Set(citationOptions(c, claims, evaluations, evidence).flat())],
    uncertainty: 'Causality is unverified.',
  }));
  expect(() => validateFindings({ findings }, claims, evaluations, evidence)).not.toThrow();
  const invalid = structuredClone(findings);
  invalid[2].citationIds = ['E2-v1'];
  expect(() => validateFindings({ findings: invalid }, claims, evaluations, evidence)).toThrow(
    'complete valid support',
  );
  invalid[2] = { ...findings[2], supportGroupIds: ['made-up-singleton'] };
  expect(() => validateFindings({ findings: invalid }, claims, evaluations, evidence)).toThrow(
    'supportGroupIds',
  );
  evidence[0].status = 'withdrawn';
  const fresh = evaluateSupport(evidence, claims);
  const report = makeReport(claims, fresh, 2, incident.reports[0]);
  const statements = claims.map((c) => ({
    claimId: c.id,
    text: c.text,
    citationIds: ['E1-v1'],
    uncertainty: 'Unknown',
  }));
  expect(() =>
    validateReport({ statements }, report, incident.reports[0], claims, fresh, evidence),
  ).toThrow('Citation');
});

it.each(['unsupported', 'contested', 'needs_review'] as const)(
  'uses immutable application notices for %s findings, regardless of former assertion text',
  (status) => {
    const initial = createIncident();
    const evaluations = structuredClone(initial.evaluations);
    for (const id of ['C4-v1', 'C5-v1']) {
      const e = evaluations.find((v) => v.claimId === id)!;
      e.status = status;
      e.validGroupIds = [];
      e.invalidGroups = [{ id: `${id}-group`, reasons: ['E3-v1: withdrawn'] }];
    }
    const report = makeReport(initial.claims, evaluations, 2, initial.reports[0]);
    const targets = reportTargets(
      report,
      initial.reports[0],
      initial.claims,
      evaluations,
      initial.evidence,
      [],
      true,
    );
    expect(targets).not.toContain('C4-v1');
    expect(targets).not.toContain('C5-v1');
    const statements = targets.map((id) => ({
      claimId: id,
      text: 'A supported test interpretation.',
      citationIds: [
        ...new Set(
          citationOptions(
            initial.claims.find((c) => c.id === id)!,
            initial.claims,
            evaluations,
            initial.evidence,
          ).flat(),
        ),
      ],
      uncertainty: 'Causality is unverified.',
    }));
    const published = validateReport(
      { statements },
      report,
      initial.reports[0],
      initial.claims,
      evaluations,
      initial.evidence,
      [],
      true,
    );
    for (const id of ['C4-v1', 'C5-v1']) {
      const notice = published.find((s) => s.claimId === id)!;
      expect(notice).toMatchObject({ author: 'gateway', status, citationIds: [] });
      expect(notice.text).not.toContain('latency is elevated');
      expect(notice.text).not.toContain('Run a bounded');
    }
    const override = {
      claimId: 'C5-v1',
      text: 'Run the check despite missing support.',
      citationIds: [],
      uncertainty: 'No problem.',
    };
    expect(() =>
      validateReport(
        { statements: [...statements, override] },
        report,
        initial.reports[0],
        initial.claims,
        evaluations,
        initial.evidence,
        [],
        true,
      ),
    ).toThrow('application-withheld');
    expect(initial.reports[0].statements.find((s) => s.claimId === 'C5-v1')!.text).toContain(
      'Run a bounded',
    );
  },
);

it('returns a previously withheld statement to the reporter when valid support is restored', () => {
  const initial = createIncident();
  initial.evidence.find((e) => e.id === 'E6-v1')!.status = 'withdrawn';
  const unsupported = evaluateSupport(initial.evidence, initial.claims);
  const proposal = makeReport(initial.claims, unsupported, 2, initial.reports[0]);
  const targets = reportTargets(
    proposal,
    initial.reports[0],
    initial.claims,
    unsupported,
    initial.evidence,
    [],
    true,
  );
  const statements = targets.map((id) => ({
    claimId: id,
    text: 'Supported interpretation.',
    citationIds: [
      ...new Set(
        citationOptions(
          initial.claims.find((c) => c.id === id)!,
          initial.claims,
          unsupported,
          initial.evidence,
        ).flat(),
      ),
    ],
    uncertainty: 'Causality is unverified.',
  }));
  const previous = {
    ...proposal,
    statements: validateReport(
      { statements },
      proposal,
      initial.reports[0],
      initial.claims,
      unsupported,
      initial.evidence,
      [],
      true,
    ),
  };
  initial.evidence.find((e) => e.id === 'E6-v1')!.status = 'active';
  const supported = evaluateSupport(initial.evidence, initial.claims);
  const restored = makeReport(initial.claims, supported, 3, previous);
  const nextTargets = reportTargets(
    restored,
    previous,
    initial.claims,
    supported,
    initial.evidence,
    [],
    true,
  );
  expect(nextTargets).toContain('C5-v1');
  const nextStatements = nextTargets.map((id) => ({
    claimId: id,
    text: 'A bounded follow-up is justified by current evidence.',
    citationIds: [
      ...new Set(
        citationOptions(
          initial.claims.find((c) => c.id === id)!,
          initial.claims,
          supported,
          initial.evidence,
        ).flat(),
      ),
    ],
    uncertainty: 'Further investigation is needed.',
  }));
  expect(
    validateReport(
      { statements: nextStatements },
      restored,
      previous,
      initial.claims,
      supported,
      initial.evidence,
      [],
      true,
    ).find((s) => s.claimId === 'C5-v1'),
  ).toMatchObject({
    status: 'supported',
    author: 'reporter',
    text: 'A bounded follow-up is justified by current evidence.',
  });
});
