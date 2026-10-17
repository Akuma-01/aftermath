import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic, Incident, ModelCallDetail, ToolCallDetail } from '@aftermath/contracts';
import {
  LEGACY_PROMPT_VERSION,
  PROMPT_VERSION,
  SUPPORT_NOTICE_PROMPT_VERSION,
  type AgentRuntimeConfig,
  type ModelInput,
  type ModelProvider,
} from '@aftermath/agents';
import { createIncident, applyDiagnostic } from '@aftermath/fixtures';
import { evaluateSupport, makeReport } from '@aftermath/domain';
import { checksum, diagnosticCases, random, type DiagnosticCase } from '@aftermath/evaluation';
import { Ledger } from '@aftermath/storage';
import { EvidenceGraph } from '@aftermath/graph';
import { InvestigationService } from '../../apps/api/src/service';

type Trace = ToolCallDetail;
interface Check {
  name: string;
  passed: boolean;
}
export interface DiagnosticCaseResult {
  id: string;
  outcome: 'running' | 'passed' | 'failed' | 'skipped';
  reason: string | null;
  fixtureChecksum: string | null;
  incidentId: string | null;
  taskId: string | null;
  gatewayOutcome: string | null;
  elapsedMs: number | null;
  candidates: Diagnostic[];
  selection: 'matched' | 'mismatched' | 'not_assessed';
  requestedDiagnostics: Array<{ recipeId: string; status: string }>;
  completedDiagnostics: string[];
  checks: Check[];
  calls: ModelCallDetail[];
  tools: Trace[];
  initial: Incident | null;
  final: Incident | null;
}
export function diagnosticUsage(calls: ModelCallDetail[], reservedCalls = calls.length) {
  const complete = calls.length === reservedCalls;
  return {
    reservedCalls,
    auditedCalls: calls.length,
    complete,
    failedCalls: complete ? calls.filter((c) => c.status === 'failed').length : null,
    inputTokens:
      complete && calls.length && calls.every((c) => c.inputTokens !== null)
        ? calls.reduce((s, c) => s + c.inputTokens!, 0)
        : null,
    outputTokens:
      complete && calls.length && calls.every((c) => c.outputTokens !== null)
        ? calls.reduce((s, c) => s + c.outputTokens!, 0)
        : null,
  };
}
function states(incident: Incident) {
  return Object.fromEntries(incident.evaluations.map((e) => [e.claimId, e.status]));
}
const same = (a: unknown, b: unknown) =>
  checksum(Object.entries(a as object).sort()) === checksum(Object.entries(b as object).sort());

export function assessDiagnosticCase(scenario: DiagnosticCase, row: DiagnosticCaseResult) {
  const check = (name: string, passed: boolean) => row.checks.push({ name, passed });
  const proposed = row.tools.some((t) => t.name === 'proposeClaims' && t.status === 'succeeded');
  row.requestedDiagnostics = row.tools
    .filter((t) => t.name === 'runDiagnostic')
    .map((t) => ({
      recipeId:
        typeof (t.arguments as { recipeId?: unknown })?.recipeId === 'string'
          ? (t.arguments as { recipeId: string }).recipeId
          : '(invalid arguments)',
      status: t.status,
    }));
  row.completedDiagnostics =
    row.final?.completedDiagnosticIds?.filter((id) => !scenario.precompleted.includes(id)) ?? [];
  if (proposed) {
    const expected = scenario.expectedDiagnostic ? [scenario.expectedDiagnostic] : [];
    const matched =
      same(row.completedDiagnostics, expected) &&
      same(
        row.requestedDiagnostics.map((t) => t.recipeId),
        expected,
      ) &&
      row.requestedDiagnostics.every((t) => t.status === 'succeeded');
    row.selection = matched ? 'matched' : 'mismatched';
    check('Agent diagnostic choice matches the independent case expectation', matched);
  }
  check('Investigator completed a valid proposal', proposed);
  check(
    'Both roles completed and a current report was published',
    row.gatewayOutcome === 'accepted' &&
      row.final?.reportStatus === 'current' &&
      row.tools.some((t) => t.name === 'proposeReport' && t.status === 'succeeded'),
  );
  const report = row.final?.reports.at(-1);
  if (row.initial?.agentConfig?.promptVersion !== LEGACY_PROMPT_VERSION) {
    check(
      'Published report records the diagnostic decision',
      Boolean(report?.agent?.diagnosticDecision),
    );
  }
  check(
    'Final support states match the expected diagnostic outcome',
    !!row.final && same(states(row.final), scenario.afterStates),
  );
  check(
    'Published report states match the independent oracle',
    !!report &&
      same(
        Object.fromEntries(report.statements.map((s) => [s.claimId, s.status])),
        scenario.afterStates,
      ),
  );
  if (
    [PROMPT_VERSION, SUPPORT_NOTICE_PROMPT_VERSION].includes(
      row.initial?.agentConfig?.promptVersion ?? '',
    )
  ) {
    const withheldIds = Object.entries(scenario.afterStates)
      .filter(([, status]) => status !== 'supported')
      .map(([id]) => id);
    if (withheldIds.length) {
      check(
        'Findings without support have application-owned support notices',
        withheldIds.every((id) =>
          report?.statements.some(
            (s) =>
              s.claimId === id &&
              s.author === 'gateway' &&
              s.citationIds?.length === 0 &&
              Boolean(s.uncertainty),
          ),
        ),
      );
      const reporterRead = row.tools.find(
        (t) => t.name === 'getAcceptedFindings' && t.status === 'succeeded',
      )?.result as { requestedStatementIds?: string[] } | undefined;
      check(
        'Support notices are excluded from reporter writing targets',
        Boolean(reporterRead?.requestedStatementIds) &&
          withheldIds.every((id) => !reporterRead!.requestedStatementIds!.includes(id)),
      );
    }
  }
  const withdrawn = new Set(scenario.withdrawals.map((w) => w.id));
  check(
    'Withdrawn versions are absent from published citations',
    !!report?.agent &&
      report.statements.every((s) => s.citationIds?.every((id) => !withdrawn.has(id))),
  );
  check(
    'Withdrawn versions are absent from investigator support',
    !!report?.agent &&
      report.agent.findings.every((f) => f.citationIds.every((id) => !withdrawn.has(id))),
  );
  check(
    'No human diagnostic command was used during the run',
    !row.final?.events?.some((e) => e.type === 'diagnostic.completed'),
  );
  if (scenario.newEvidenceId) {
    const evidenceId = scenario.newEvidenceId;
    check(
      'Agent recorded the expected new observation',
      !!row.final?.evidence.some((e) => e.id === evidenceId && e.status === 'active'),
    );
    check(
      'Investigator reread the new evidence before proposing findings',
      row.tools.some(
        (t) =>
          t.name === 'getEvidenceBundle' &&
          (t.result as { evidence?: Array<{ id: string }> })?.evidence?.some(
            (e) => e.id === evidenceId,
          ),
      ),
    );
    if (evidenceId !== 'E9-v1')
      check(
        'Published report cites the new diagnostic observation',
        !!report?.statements.some((s) => s.citationIds?.includes(evidenceId)),
      );
  }
  row.outcome = row.checks.every((c) => c.passed) ? 'passed' : 'failed';
}

/** One isolated SQL task per condition, no queue, worker retries, fallback check, or semantic auto-grader. */
export async function runDiagnosticEvaluation(
  dir: string,
  runtime: AgentRuntimeConfig,
  options: {
    caseIds?: string[];
    maxCalls?: number;
    seed?: number;
    progress?: (message: string) => void;
    simulatePrimaryQuotaAfterRead?: boolean;
  } = {},
) {
  const ids = options.caseIds ?? ['pool-followup'];
  const cases = diagnosticCases();
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !cases.some((c) => c.id === id))
  )
    throw new Error('Choose unique registered diagnostic case IDs.');
  const maxCalls = options.maxCalls ?? 8;
  const seed = options.seed ?? 20260926;
  if (!Number.isInteger(maxCalls) || maxCalls < 8 || maxCalls > 40)
    throw new Error('Diagnostic evaluation permits a shared cap of 8–40 calls.');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error('Seed must be an unsigned 32-bit integer.');
  if (
    options.simulatePrimaryQuotaAfterRead &&
    (!runtime.fallbackProvider || ids.length !== 1 || ids[0] !== 'pool-followup' || maxCalls !== 8)
  )
    throw new Error(
      'Controlled failover requires a backup provider, the pool-followup case, and an eight-call cap.',
    );
  if (runtime.config.maxCalls < 8)
    throw new Error(
      'These diagnostic conditions require an eight-call task budget. Increase AGENT_MAX_CALLS to at least 8.',
    );
  const selected = ids.map((id) => cases.find((c) => c.id === id)!);
  const next = random(seed);
  for (let i = selected.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [selected[i], selected[j]] = [selected[j], selected[i]];
  }
  // Refuse directory reuse: a fresh command cannot reset a retained run's call budget.
  await writeFile(join(dir, 'cases.json'), JSON.stringify(selected, null, 2), { flag: 'wx' });
  const sources = Object.fromEntries(
    await Promise.all(
      [
        'package-lock.json',
        'packages/evaluation/src/diagnostic-cases.ts',
        'packages/fixtures/src/index.ts',
        'packages/agents/src/provider.ts',
        'packages/agents/src/runner.ts',
        'packages/agents/src/validation.ts',
        'packages/repair/src/index.ts',
        'packages/domain/src/index.ts',
        'packages/graph/src/index.ts',
        'packages/storage/src/jobs.ts',
        'packages/storage/src/index.ts',
        'packages/storage/migrations/004-agent-failover.sql',
        'packages/storage/src/state.ts',
        'packages/storage/src/manifest.ts',
        'scripts/test-agents-live.ts',
        'scripts/support/diagnostic-evaluation.ts',
      ].map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]),
    ),
  );
  const config = {
    ...runtime.config,
    maxCalls: 8,
    timeoutMs: Math.min(30000, runtime.config.timeoutMs),
  };
  const rows: DiagnosticCaseResult[] = [];
  let dispatched = 0;
  let reserved = 0;
  let primaryInvocations = 0;
  let primaryRequests = 0;
  let backupRequests = 0;
  let injectedFailures = 0;
  let primaryHistory: ModelInput['history'] | undefined;
  let failedHistory: ModelInput['history'] | undefined;
  let backupHistory: ModelInput['history'] | undefined;
  const historyPreserved = () =>
    failedHistory && backupHistory
      ? failedHistory.length > 0 && checksum(failedHistory) === checksum(backupHistory)
      : null;
  let fatal: string | null = null;
  let service: InvestigationService | undefined;
  let ledger: Ledger | undefined;
  let graph: EvidenceGraph | undefined;
  const startedAt = new Date().toISOString();
  const save = async (outcome: 'running' | 'passed' | 'failed') => {
    const calls = rows.flatMap((r) => r.calls);
    const assessed = rows.filter((r) => r.selection !== 'not_assessed');
    const result = {
      version: 'diagnostic-selection-v1',
      outcome,
      startedAt,
      recordedAt: new Date().toISOString(),
      fatal,
      provider: config.provider,
      model: config.model,
      promptVersion: config.promptVersion,
      backupConfigured: Boolean(runtime.fallbackProvider),
      faultInjection: options.simulatePrimaryQuotaAfterRead
        ? {
            kind: 'simulated-primary-quota-after-read',
            source: 'acceptance-harness-only',
            injectedFailures,
            primaryProviderRequests: primaryRequests,
            backupProviderRequests: backupRequests,
            toolJournalPreserved: historyPreserved(),
            meaning:
              'One synthetic HTTP 429 result replaces the second primary invocation. It makes no provider request and uses no tokens, but consumes a SQL call slot. Other invocations contact the configured providers. This is not evidence of natural quota exhaustion or independent project quotas.',
          }
        : null,
      config,
      seed,
      caseOrder: selected.map((s) => s.id),
      caseDefinitionChecksum: checksum(selected),
      sources,
      scope:
        'Five development conditions of the synthetic checkout incident; ranking/abstention and structural publication checks, not held-out families or semantic grading.',
      maxProviderCalls: maxCalls,
      dispatchedCalls: dispatched,
      usage: diagnosticUsage(calls, reserved),
      summary: {
        cases: selected.length,
        attempted: rows.filter((r) => r.outcome !== 'skipped').length,
        passed: rows.filter((r) => r.outcome === 'passed').length,
        failed: rows.filter((r) => r.outcome === 'failed').length,
        skipped: rows.filter((r) => r.outcome === 'skipped').length,
        selectionsAssessed: assessed.length,
        selectionsMatched: assessed.filter((r) => r.selection === 'matched').length,
      },
      semanticReview: {
        status: 'not_scored',
        instructions:
          'Inspect review.md and the original evidence. Structural acceptance is not a semantic accuracy grade.',
      },
      cases: rows,
    };
    await writeFile(join(dir, 'result.json.tmp'), JSON.stringify(result, null, 2));
    await rename(join(dir, 'result.json.tmp'), join(dir, 'result.json'));
    return result;
  };
  try {
    await save('running');
    ledger = await Ledger.open(join(dir, 'ledger'));
    graph = await EvidenceGraph.open();
    const guardProvider = (provider: ModelProvider, slot: 'primary' | 'backup'): ModelProvider => ({
      name: provider.name,
      model: provider.model,
      buildRequest: (input) => {
        if (reserved >= maxCalls)
          throw new Error('Diagnostic evaluation shared call budget exhausted.');
        if (options.simulatePrimaryQuotaAfterRead) {
          if (slot === 'primary') primaryHistory = structuredClone(input.history);
          else backupHistory ??= structuredClone(input.history);
        }
        return provider.buildRequest(input);
      },
      invoke: async (request, signal) => {
        if (reserved >= maxCalls)
          throw new Error('Diagnostic evaluation shared call budget exhausted.');
        reserved++;
        if (slot === 'primary') primaryInvocations++;
        if (options.simulatePrimaryQuotaAfterRead && slot === 'primary' && primaryInvocations > 1) {
          if (injectedFailures)
            throw new Error('Controlled failover must not return to the primary.');
          injectedFailures++;
          failedHistory = primaryHistory;
          return {
            raw: {
              httpStatus: 429,
              simulated: true,
              source: 'acceptance-harness-only',
              providerRequestMade: false,
            },
            calls: [],
            inputTokens: 0,
            outputTokens: 0,
            error:
              'Simulated primary quota failure for controlled failover acceptance. No provider request was made for this call.',
            retryable: true,
          };
        }
        dispatched++;
        if (slot === 'primary') primaryRequests++;
        else backupRequests++;
        return provider.invoke(request, signal);
      },
    });
    service = new InvestigationService(ledger, graph, {
      config,
      provider: guardProvider(runtime.provider, 'primary'),
      ...(runtime.fallbackProvider
        ? { fallbackProvider: guardProvider(runtime.fallbackProvider, 'backup') }
        : {}),
    });
    let stopReason: string | null = null;
    for (const scenario of selected) {
      const row: DiagnosticCaseResult = {
        id: scenario.id,
        outcome: 'running',
        reason: null,
        fixtureChecksum: null,
        incidentId: null,
        taskId: null,
        gatewayOutcome: null,
        elapsedMs: null,
        candidates: [],
        selection: 'not_assessed',
        requestedDiagnostics: [],
        completedDiagnostics: [],
        checks: [],
        calls: [],
        tools: [],
        initial: null,
        final: null,
      };
      rows.push(row);
      if (stopReason || maxCalls - reserved < 8) {
        row.outcome = 'skipped';
        row.reason = stopReason ?? 'Fewer than eight calls remain; the case was not started.';
        await save('running');
        continue;
      }
      const started = performance.now();
      try {
        const initial = createIncident();
        initial.id = randomUUID();
        for (const recipe of scenario.precompleted) applyDiagnostic(initial, recipe);
        initial.evaluations = evaluateSupport(initial.evidence, initial.claims);
        initial.reports = [makeReport(initial.claims, initial.evaluations, initial.evidenceEpoch)];
        initial.reportStatus = 'current';
        row.fixtureChecksum = checksum({
          evidence: initial.evidence,
          claims: initial.claims,
          scenario,
        });
        row.incidentId = initial.id;
        let incident = await ledger.create(initial);
        for (const correction of scenario.withdrawals)
          incident = await service.withdraw(
            incident.id,
            correction.id,
            correction.reason,
            incident.eventSeq,
            randomUUID(),
          );
        const prepared = await service.processor.prepare(incident);
        row.candidates = await graph.diagnostics(incident);
        const expectedTop = row.candidates.find((d) => d.available && d.score > 0)?.id ?? null;
        if (
          expectedTop !== scenario.expectedDiagnostic ||
          !same(
            Object.fromEntries(prepared.evaluations.map((e) => [e.claimId, e.status])),
            scenario.beforeStates,
          )
        )
          throw new Error(
            'Fixture no longer matches the independent pre-run oracle; no provider calls made for this case.',
          );
        await service.investigate(incident.id, incident.eventSeq, randomUUID());
        row.initial = await ledger.get(incident.id);
        const task = (await ledger.jobs.work(incident.id)).tasks.find(
          (t) => t.status === 'pending' && t.evidenceEpoch === row.initial!.evidenceEpoch,
        );
        if (!task) throw new Error('No current diagnostic-evaluation task exists.');
        row.taskId = task.id;
        await save('running');
        options.progress?.(
          `${scenario.id}: ${config.provider}/${config.model}, at most eight calls; expected ${scenario.expectedDiagnostic ?? 'no diagnostic'}.`,
        );
        row.gatewayOutcome = await service.processor.process(task.id);
        const work = await ledger.jobs.work(incident.id);
        row.final = await ledger.get(incident.id);
        row.calls = await Promise.all(
          [...work.modelCalls]
            .reverse()
            .map((c) => ledger!.jobs.modelCallDetail(incident.id, c.id)),
        );
        // This harness runs one attempt per incident. Its append-only manifest IDs
        // preserve request order even when the host's wall clock moves backward.
        row.calls.sort(
          (a, b) => (a.manifest.modelCallIds?.length ?? 0) - (b.manifest.modelCallIds?.length ?? 0),
        );
        row.tools = await Promise.all(
          [...work.toolCalls].reverse().map((t) => ledger!.jobs.toolCallDetail(incident.id, t.id)),
        );
        const callOrder = new Map(row.calls.map((c, i) => [c.id, i]));
        row.tools.sort(
          (a, b) => (callOrder.get(a.modelCallId) ?? -1) - (callOrder.get(b.modelCallId) ?? -1),
        );
        assessDiagnosticCase(scenario, row);
        if (options.simulatePrimaryQuotaAfterRead) {
          const [first, failed, switched, ...rest] = row.calls;
          row.checks.push(
            {
              name: 'Primary provider completed the evidence read before the simulated failure',
              passed:
                first?.credentialSlot === 'primary' &&
                first.status === 'succeeded' &&
                row.tools.some(
                  (t) =>
                    t.modelCallId === first.id &&
                    t.name === 'getEvidenceBundle' &&
                    t.status === 'succeeded',
                ),
            },
            {
              name: 'Exactly one labeled quota failure was injected without a provider request',
              passed:
                injectedFailures === 1 &&
                failed?.credentialSlot === 'primary' &&
                failed.status === 'failed' &&
                (failed.response as { simulated?: boolean })?.simulated === true &&
                reserved === dispatched + 1,
            },
            {
              name: 'Backup follows the failed call and completes all remaining requests',
              passed:
                switched?.credentialSlot === 'backup' &&
                switched.failoverFromCallId === failed?.id &&
                switched.status === 'succeeded' &&
                rest.every((c) => c.credentialSlot === 'backup' && c.status === 'succeeded'),
            },
            {
              name: 'Backup retains the completed primary tool journal',
              passed: historyPreserved() === true,
            },
            {
              name: 'Synthetic failure and provider requests remain within the eight-call cap',
              passed: reserved <= 8 && row.calls.length === reserved,
            },
          );
          row.outcome = row.checks.every((c) => c.passed) ? 'passed' : 'failed';
        }
        if (row.gatewayOutcome !== 'accepted') {
          row.reason =
            work.attempts.find((a) => a.taskId === task.id)?.reason ?? row.gatewayOutcome;
          stopReason =
            'A task failed to publish. Remaining cases were not started; no automatic retries.';
        } else if (row.outcome === 'failed')
          row.reason = row.checks
            .filter((c) => !c.passed)
            .map((c) => c.name)
            .join('; ');
      } catch (error) {
        row.outcome = 'failed';
        row.reason = error instanceof Error ? error.message : 'Evaluation failed.';
        stopReason = 'Evaluation setup or audit failed. Remaining cases were not started.';
      }
      row.elapsedMs = performance.now() - started;
      await save('running');
      options.progress?.(
        `${scenario.id}: ${row.outcome}; selection ${row.selection}; ${row.calls.length} reserved calls.`,
      );
    }
  } catch (error) {
    fatal = error instanceof Error ? error.message : 'Evaluation setup failed.';
  } finally {
    const closed = await Promise.allSettled([graph?.close(), ledger?.close()]);
    if (closed.some((r) => r.status === 'rejected'))
      fatal ??=
        'A local store could not be closed cleanly. Its ledger and completed checkpoints are retained.';
  }
  const result = await save(
    !fatal && rows.length === selected.length && rows.every((r) => r.outcome === 'passed')
      ? 'passed'
      : 'failed',
  );
  const review = [
    '# Diagnostic evaluation — manual semantic review',
    '',
    `Provider/model: ${config.provider}/${config.model}. Prompt: ${config.promptVersion}.`,
    '',
    ...(options.simulatePrimaryQuotaAfterRead
      ? [
          'Controlled failover: one primary HTTP 429 result is simulated after the first request. The primary read and subsequent backup replies come from the configured providers. See faultInjection in result.json; this is not a naturally observed quota outage.',
          '',
        ]
      : []),
    'Semantic score: **not assessed**. The automated checks cover diagnostic choice, support states, citations, and publication only. Review the original evidence in result.json before assigning any semantic grade.',
    '',
    'For each case, check factual consistency, appropriate uncertainty, distinction between correlation and causation, and whether the proposed next action is justified. Record reviewer identity and rationale separately; do not infer a semantic pass from publication.',
    '',
  ];
  for (const scenario of selected) {
    const row = rows.find((r) => r.id === scenario.id);
    review.push(
      `## ${scenario.id}`,
      '',
      scenario.description,
      '',
      `Automated outcome: ${row?.outcome ?? 'not started'}. Expected diagnostic: ${scenario.expectedDiagnostic ?? 'none'}.`,
      '',
      ...scenario.reviewNotes.map((note) => `- ${note}`),
      '',
      '### Published wording',
      '',
    );
    if (
      row?.gatewayOutcome === 'accepted' &&
      row.final?.reports.at(-1)?.agent?.diagnosticDecision
    ) {
      const decision = row.final.reports.at(-1)!.agent!.diagnosticDecision!;
      review.push(
        `Diagnostic decision: ${decision.status} (${decision.source}); ${decision.reason}`,
        '',
      );
    }
    if (row?.gatewayOutcome === 'accepted')
      for (const statement of row.final!.reports.at(-1)!.statements)
        review.push(
          `- ${statement.claimId} (${statement.status}): ${statement.text} Citations: ${statement.citationIds?.join(', ') || 'none'}. Uncertainty: ${statement.uncertainty ?? 'none recorded'}`,
          '',
        );
    else review.push('No current model report was accepted for this case.', '');
  }
  await writeFile(join(dir, 'review.md'), review.join('\n'));
  return result;
}
