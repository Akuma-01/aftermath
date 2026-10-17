import { randomUUID } from 'node:crypto';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Incident, ModelCallDetail, RepairTask } from '@aftermath/contracts';
import type { AgentRuntimeConfig, ModelInput, ModelProvider } from '@aftermath/agents';
import { EvidenceGraph } from '@aftermath/graph';
import { Ledger, readArtifacts } from '@aftermath/storage';
import { InvestigationService } from '../../apps/api/src/service';

interface Stage {
  name: string;
  taskId?: string;
  outcome: string;
  calls: number;
  reportVersion: number;
  elapsedMs: number;
}
interface Check {
  name: string;
  passed: boolean;
}
type Work = Awaited<ReturnType<Ledger['jobs']['work']>>;
interface Checkpoint {
  outcome: string;
  provider: string;
  model: string;
  startedAt: string;
  incidentId: string;
  startingCalls: number;
  maxAdditionalProviderCalls: number;
  stages: Stage[];
  checks: Check[];
  completedPhases?: string[];
  baselineReportVersion?: number;
  diagnosticOrigin: 'agent' | 'human-command' | null;
}

// Recover the explicit tool journal from the exact request stored in SQL.
// This also supports the scripted provider used to test this acceptance harness.
function journal(call: ModelCallDetail): ModelInput['history'] {
  const request = call.request as {
    history?: ModelInput['history'];
    contents?: Array<{ parts: Array<{ text: string }> }>;
    input?: Array<{ content: string }>;
  };
  if (Array.isArray(request.history)) return request.history;
  const text = request.contents?.[0]?.parts[0]?.text ?? request.input?.[0]?.content;
  if (!text) throw new Error('Cannot inspect the recorded provider tool journal.');
  const parsed = JSON.parse(text) as { toolHistory?: ModelInput['history'] };
  if (!Array.isArray(parsed.toolHistory)) throw new Error('Recorded tool journal is missing.');
  return parsed.toolHistory;
}

/** Runs real services without a background queue consumer or automatic provider retries. */
export async function runLiveRecovery(
  dir: string,
  runtime: AgentRuntimeConfig,
  options: { maxCalls?: number; resume?: boolean; progress?: (message: string) => void } = {},
) {
  const path = join(dir, 'recovery-result.json');
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists && !options.resume)
    throw new Error('This directory already has a recovery result. It will not be overwritten.');
  if (!exists && options.resume)
    throw new Error('No recovery checkpoint exists to resume; no provider calls made.');
  const prior = exists ? (JSON.parse(await readFile(path, 'utf8')) as Checkpoint) : undefined;
  if (
    prior &&
    (prior.outcome === 'accepted' ||
      prior.provider !== runtime.config.provider ||
      prior.model !== runtime.config.model)
  )
    throw new Error('Only unfinished recovery runs with the same provider/model can resume.');
  const maxCalls = prior?.maxAdditionalProviderCalls ?? options.maxCalls ?? 24;
  if (!Number.isInteger(maxCalls) || maxCalls < 4 || maxCalls > 24)
    throw new Error('Recovery acceptance permits between 4 and 24 additional provider calls.');
  if (prior)
    await writeFile(join(dir, `recovery-before-resume-${Date.now()}.json`), await readFile(path), {
      flag: 'wx',
    });
  const stages: Stage[] = prior?.stages ?? [];
  const checks: Check[] = prior?.checks.filter((c) => c.passed) ?? [];
  const completedPhases = prior?.completedPhases ?? [];
  let baselineReportVersion = prior?.baselineReportVersion;
  let service: InvestigationService | undefined;
  let incidentId = '';
  let startingCalls = prior?.startingCalls ?? 0;
  let dispatchedCalls = 0;
  let work: Work | undefined;
  let failure: string | null = null;
  let freshSession: Record<string, unknown> | null = null;
  let diagnosticOrigin: 'agent' | 'human-command' | null = prior?.diagnosticOrigin ?? null;
  const startedAt = prior?.startedAt ?? new Date().toISOString();
  const config = {
    ...runtime.config,
    maxCalls: Math.min(8, runtime.config.maxCalls),
    timeoutMs: Math.min(30000, runtime.config.timeoutMs),
  };
  const guardProvider = (provider: ModelProvider): ModelProvider => ({
    name: provider.name,
    model: provider.model,
    buildRequest: (input) => {
      if (dispatchedCalls >= maxCalls)
        throw new Error('Recovery acceptance call budget exhausted.');
      return provider.buildRequest(input);
    },
    invoke: async (request, signal) => {
      // The current call is already reserved in SQL. Count failed/unknown calls too.
      const count = (await service!.ledger.jobs.work(incidentId)).modelCalls.length;
      if (count - startingCalls > maxCalls)
        throw new Error('Recovery acceptance call budget exhausted.');
      dispatchedCalls++;
      return provider.invoke(request, signal);
    },
  });
  const guardedRuntime: AgentRuntimeConfig = {
    config,
    provider: guardProvider(runtime.provider),
    ...(runtime.fallbackProvider
      ? { fallbackProvider: guardProvider(runtime.fallbackProvider) }
      : {}),
  };
  const open = async () => {
    const ledger = await Ledger.open(join(dir, 'ledger'), undefined, { retryDelayMs: 0 });
    try {
      return new InvestigationService(ledger, await EvidenceGraph.open(), guardedRuntime);
    } catch (error) {
      await ledger.close();
      throw error;
    }
  };
  const read = () => service!.ledger.get(incidentId);
  const check = (name: string, passed: boolean) => {
    checks.push({ name, passed });
    if (!passed) throw new Error(`Acceptance check failed: ${name}`);
  };
  const snapshot = async (outcome: string) => {
    const incident = incidentId ? await read() : undefined;
    if (incidentId) work = await service!.ledger.jobs.work(incidentId);
    const calls = work?.modelCalls.slice(startingCalls) ?? [];
    const result = {
      scenario: 'live-recovery-v1',
      provider: config.provider,
      model: config.model,
      promptVersion: config.promptVersion,
      backupConfigured: Boolean(runtime.fallbackProvider),
      startedAt,
      recordedAt: new Date().toISOString(),
      outcome,
      failure,
      incidentId,
      maxAdditionalProviderCalls: maxCalls,
      startingCalls,
      dispatchedCalls,
      stages,
      checks,
      completedPhases,
      baselineReportVersion,
      diagnosticOrigin,
      freshSession,
      inputTokens: calls.every((c) => c.inputTokens !== null)
        ? calls.reduce((sum, c) => sum + c.inputTokens!, 0)
        : null,
      outputTokens: calls.every((c) => c.outputTokens !== null)
        ? calls.reduce((sum, c) => sum + c.outputTokens!, 0)
        : null,
      calls,
      work,
      incident,
    };
    await writeFile(`${path}.tmp`, JSON.stringify(result, null, 2));
    await rename(`${path}.tmp`, path);
    return result;
  };
  const pending = async (kind: RepairTask['kind'] = 'repair') => {
    const current = await read();
    const task = (await service!.ledger.jobs.work(incidentId)).tasks.find(
      (t) => t.kind === kind && t.status === 'pending' && t.evidenceEpoch === current.evidenceEpoch,
    );
    if (!task) throw new Error(`No pending ${kind} task for the current evidence.`);
    return task;
  };
  const taskFor = async (name: string, kind: RepairTask['kind'] = 'repair') => {
    const old = stages.find((s) => s.name === name);
    if (old) {
      const task = (await service!.ledger.jobs.work(incidentId)).tasks.find(
        (t) => t.id === old.taskId,
      );
      if (task) return task;
    }
    return pending(kind);
  };
  const completePhase = async (name: string) => {
    completedPhases.push(name);
    await snapshot('running');
  };
  const process = async (name: string, task: RepairTask, expected: string) => {
    if (stages.some((s) => s.name === name && s.outcome === expected)) return;
    const before = (await service!.ledger.jobs.work(incidentId)).modelCalls.length;
    // A new investigator/reporter attempt requires at least four calls.
    if (expected !== 'stale' && maxCalls - (before - startingCalls) < 4)
      throw new Error(`Insufficient acceptance budget to start ${name}; no further calls made.`);
    options.progress?.(`${name}: running ${config.provider}/${config.model}.`);
    const start = Date.now();
    const outcome = await service!.processor.process(task.id);
    work = await service!.ledger.jobs.work(incidentId);
    stages.push({
      name,
      taskId: task.id,
      outcome,
      calls: work.modelCalls.length - before,
      reportVersion: (await read()).reports.at(-1)!.version,
      elapsedMs: Date.now() - start,
    });
    await snapshot('running');
    if (outcome !== expected)
      throw new Error(
        `${name}: ${work.attempts.find((a) => a.taskId === task.id)?.reason ?? outcome}`,
      );
    options.progress?.(`${name}: ${outcome}, ${stages.at(-1)!.calls} calls.`);
  };
  const assertCorrected = (incident: Incident) => {
    const report = incident.reports.at(-1)!;
    check('Corrected report is current', incident.reportStatus === 'current');
    check(
      'Withdrawn E1 is absent from report support',
      report.statements.every((s) => !s.citationIds?.includes('E1-v1')),
    );
    check(
      'Withdrawn E1 is absent from investigator support',
      Boolean(report.agent?.findings.every((f) => !f.citationIds.includes('E1-v1'))),
    );
    check(
      'Database explanation is not supported after withdrawal',
      ['C2-v1', 'C3-v1'].every(
        (id) => incident.evaluations.find((e) => e.claimId === id)?.status === 'unsupported',
      ),
    );
  };

  try {
    service = await open();
    let incident = prior
      ? await service.ledger.get(prior.incidentId)
      : ((await service.ledger.list())[0] ?? (await service.create()));
    incidentId = incident.id;
    const existingCalls = (await service.ledger.jobs.work(incidentId)).modelCalls.length;
    if (!prior) startingCalls = existingCalls;
    dispatchedCalls = existingCalls - startingCalls;
    if (!prior)
      check(
        'Recovery starts with the original active source',
        incident.evidence.find((e) => e.id === 'E1-v1')?.status === 'active',
      );
    check(
      'Existing provider configuration matches',
      !incident.agentConfig ||
        (incident.agentConfig.provider === config.provider &&
          incident.agentConfig.model === config.model),
    );
    if (!incident.reports.at(-1)!.agent) {
      if (!incident.agentConfig)
        await service.investigate(incidentId, incident.eventSeq, randomUUID());
      await process('initial-investigation', await taskFor('initial-investigation'), 'accepted');
      incident = await read();
    }
    if (!completedPhases.includes('baseline')) {
      const baseline = prior ? incident.reports.find((r) => r.agent)! : incident.reports.at(-1)!;
      check('Baseline has a model-written report', Boolean(baseline.agent));
      baselineReportVersion = baseline.version;
      await completePhase('baseline');
    }
    const baseline = incident.reports.find((r) => r.version === baselineReportVersion)!;
    const priorSessionId = (await service.ledger.jobs.work(incidentId)).attempts.find(
      (a) => a.id === baseline.agent!.attemptId,
    )?.manifest?.sessionId;
    await snapshot('running');

    if (!stages.some((s) => s.name === 'held-report'))
      await service.holdReport(incidentId, incident.eventSeq, randomUUID());
    const held = await taskFor('held-report', 'report_preview');
    if (!completedPhases.includes('held')) {
      await process('held-report', held, 'paused');
      await completePhase('held');
    }
    if (!completedPhases.includes('withdrawal')) {
      incident = await read();
      if (incident.evidence.find((e) => e.id === 'E1-v1')?.status === 'active') {
        await service.withdraw(
          incidentId,
          'E1-v1',
          'The original database log belongs to staging, not production.',
          incident.eventSeq,
          randomUUID(),
        );
        check(
          'Withdrawal immediately marks the report historical',
          (await read()).reportStatus === 'needs_review',
        );
      }
      await process('withdrawal-repair', await taskFor('withdrawal-repair'), 'accepted');
      incident = await read();
      assertCorrected(incident);
      check(
        'Graph traversal identifies database dependents',
        ['C2-v1', 'C3-v1'].every((id) => incident.lastImpact?.affectedClaimIds.includes(id)),
      );
      check(
        'Unrelated model-written statements are preserved',
        ['C1-v1', 'C4-v1', 'C5-v1'].every((id) => {
          const current = incident.reports.at(-1)!.statements.find((s) => s.claimId === id)!;
          return (
            current.disposition === 'preserved' &&
            current.text === baseline.statements.find((s) => s.claimId === id)!.text
          );
        }),
      );

      await completePhase('withdrawal');
    }
    if (!completedPhases.includes('stale')) {
      incident = await read();
      const repaired = JSON.stringify(incident.reports);
      const heldStatus = (await service.ledger.jobs.work(incidentId)).tasks.find(
        (t) => t.id === held.id,
      )?.status;
      if (heldStatus === 'paused')
        await service.resumeReport(incidentId, held.id, incident.eventSeq, randomUUID());
      await process('stale-report-rejection', held, 'stale');
      check(
        'Held report cannot replace repaired reports',
        JSON.stringify((await read()).reports) === repaired,
      );
      check(
        'Stale rejection makes no new provider calls',
        stages.find((s) => s.name === 'stale-report-rejection' && s.outcome === 'stale')!.calls ===
          0,
      );
      await completePhase('stale');
    }

    if (!completedPhases.includes('diagnostic')) {
      incident = await read();
      if (incident.completedDiagnosticIds?.includes('production-pool')) {
        diagnosticOrigin ??= 'agent';
      } else {
        diagnosticOrigin = 'human-command';
        await service.diagnose(incidentId, 'production-pool', incident.eventSeq, randomUUID());
      }
      if ((await read()).reportStatus === 'needs_review')
        await process('diagnostic-repair', await taskFor('diagnostic-repair'), 'accepted');
      incident = await read();
      check(
        'Production diagnostic contributes new cited findings',
        incident.reports
          .at(-1)!
          .statements.some(
            (s) =>
              s.claimId === 'C6-v1' && s.status === 'supported' && s.citationIds?.includes('E7-v1'),
          ),
      );
      assertCorrected(incident);
      await completePhase('diagnostic');
    }

    // Close both stores; reopen persistent SQL and rebuild a new FalkorDB process.
    await service.close();
    service = undefined;
    service = await open();
    incident = await read();
    if (!stages.some((s) => s.name === 'fresh-session-investigation'))
      incident = await service.freshSession(incidentId, incident.eventSeq, randomUUID());
    const retrieval = incident.sessions?.at(-1);
    if (!retrieval) throw new Error('Fresh correction retrieval session is missing');
    check(
      'Restarted graph retrieves the exact withdrawn version',
      retrieval.rejectedSourceIds.includes('E1-v1') &&
        retrieval.correctionIds.includes(
          incident.corrections.find((c) => c.targetId === 'E1-v1')!.id,
        ),
    );
    if (!stages.some((s) => s.name === 'fresh-session-investigation'))
      await service.investigate(incidentId, incident.eventSeq, randomUUID());
    const fresh = await taskFor('fresh-session-investigation');
    await process('fresh-session-investigation', fresh, 'accepted');
    incident = await read();
    assertCorrected(incident);
    work = await service.ledger.jobs.work(incidentId);
    const attempt = work.attempts.find((a) => a.taskId === fresh.id)!;
    const calls = work.modelCalls
      .filter((c) => c.attemptId === attempt.id && c.role === 'investigator')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const inputs = await Promise.all(
      calls.map((c) => service!.ledger.jobs.modelCallDetail(incidentId, c.id)),
    );
    // The manifest records logical call order even when wall-clock timestamps tie.
    inputs.sort(
      (a, b) => (a.manifest.modelCallIds?.length ?? 0) - (b.manifest.modelCallIds?.length ?? 0),
    );
    const first = inputs[0];
    const bundle = inputs.flatMap(journal).find((step) => step.name === 'getEvidenceBundle')
      ?.result as
      | {
          evidence: Incident['evidence'];
          corrections: Incident['corrections'];
        }
      | undefined;
    check('Fresh investigator starts with an empty tool journal', journal(first).length === 0);
    check(
      'Fresh model attempt has a new session identity',
      Boolean(attempt.manifest?.sessionId && attempt.manifest.sessionId !== priorSessionId),
    );
    check(
      'Actual fresh model input includes the stored correction',
      Boolean(
        bundle?.corrections.some(
          (c) => retrieval.correctionIds.includes(c.id) && c.targetId === 'E1-v1',
        ),
      ),
    );
    check(
      'Re-presented E1 is explicitly withdrawn in model input',
      bundle?.evidence.find((e) => e.id === 'E1-v1')?.status === 'withdrawn',
    );
    freshSession = {
      storesReopened: true,
      retrieval,
      modelSessionId: attempt.manifest?.sessionId,
      firstModelCallId: first.id,
      correctionReadCallIds: inputs
        .filter((c) => journal(c).some((step) => step.name === 'getEvidenceBundle'))
        .map((c) => c.id),
      sourceArtifact: readArtifacts(incident).find((a) => a.id === 'E1-v1'),
      investigatorExplanations: incident.reports
        .at(-1)!
        .agent!.findings.filter((f) => ['C2-v1', 'C3-v1'].includes(f.claimId)),
    };
    return await snapshot('accepted');
  } catch (error) {
    failure = error instanceof Error ? error.message : 'Live recovery acceptance failed.';
    if (service) return await snapshot('failed');
    // A failed reopen must still retain all previously saved stage results.
    throw error;
  } finally {
    await service?.close();
  }
}
