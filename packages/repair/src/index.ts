import { randomUUID } from 'node:crypto';
import { applyDiagnostic } from '@aftermath/fixtures';
import {
  runAgents,
  SUPPORTED_PROMPT_VERSIONS,
  type AgentRuntimeConfig,
  type ModelProvider,
  type ModelReply,
} from '@aftermath/agents';
import type { Incident, RepairProposal } from '@aftermath/contracts';
import { makeReport } from '@aftermath/domain';
import type { EvidenceGraph } from '@aftermath/graph';
import { Ledger, readArtifacts, StaleContextError } from '@aftermath/storage';
export class RepairProcessor {
  constructor(
    readonly ledger: Ledger,
    readonly graph: EvidenceGraph,
    readonly agents?: AgentRuntimeConfig,
  ) {}
  private async prepareWithAgents(
    initial: Incident,
    taskId: string,
    attemptId: string,
    allowDiagnostic: boolean,
  ) {
    const config = initial.agentConfig!;
    if (
      !this.agents ||
      this.agents.provider.name !== config.provider ||
      this.agents.provider.model !== config.model ||
      (this.agents.fallbackProvider &&
        (this.agents.fallbackProvider.name !== config.provider ||
          this.agents.fallbackProvider.model !== config.model)) ||
      !SUPPORTED_PROMPT_VERSIONS.includes(config.promptVersion)
    )
      throw new Error(
        'The worker does not have the provider/model recorded for this investigation. Restore its server configuration.',
      );
    let incident = initial;
    let provider = this.agents.provider;
    let credentialSlot: 'primary' | 'backup' = 'primary';
    let failoverFromCallId: string | null = null;
    const modelCallIds: string[] = [];
    const toolCallIds: string[] = [];
    const sessionId = randomUUID();
    const result = await runAgents({
      maxCalls: Math.max(0, config.maxCalls - (await this.ledger.jobs.modelCallsUsed(taskId))),
      maxOutputTokens: config.maxOutputTokens,
      allowDiagnostic,
      promptVersion: config.promptVersion,
      read: async () => {
        const model = await this.graph.read(incident);
        const proposal = await this.prepareFromModel(incident, model);
        const memory = await this.graph.corrections(incident);
        proposal.manifest = {
          ...proposal.manifest,
          sessionId,
          promptVersion: config.promptVersion,
          modelCallIds,
          toolCallIds,
        };
        const diagnostics = await this.graph.diagnostics(incident);
        if (
          memory.generation !== model.view.generation ||
          diagnostics.some((d) => d.graphGeneration !== model.view.generation)
        )
          throw new Error('Agent graph generation mismatch');
        return {
          incident,
          evidence: model.evidence,
          claims: model.claims,
          corrections: memory.corrections,
          diagnostics,
          proposal,
        };
      },
      inspectServiceImpact: async (serviceId, context) => {
        const result = await this.graph.serviceImpact(incident, serviceId);
        if (
          result.generation !== context.proposal.manifest.graphGeneration ||
          result.projectedSeq !== context.proposal.manifest.projectedSeq
        )
          throw new Error('Service impact graph generation mismatch');
        return result;
      },
      diagnose: async (recipeId, context) => {
        incident = await this.ledger.jobs.applyAgentDiagnostic(
          taskId,
          attemptId,
          context.proposal.manifest,
          recipeId,
          (current) => applyDiagnostic(current, recipeId),
        );
      },
      call: async (input, context) => {
        const request = provider.buildRequest(input);
        const id = await this.ledger.jobs.reserveModelCall(
          taskId,
          attemptId,
          input.role,
          config,
          request,
          context.proposal.manifest,
          { credentialSlot, failoverFromCallId },
        );
        failoverFromCallId = null;
        modelCallIds.push(id);
        const started = performance.now();
        let reply;
        try {
          reply = await invokeBounded(provider, request, config.timeoutMs);
        } catch {
          const error =
            'Provider connection failed, timed out, or returned an unreadable response. No fixture output was substituted.';
          await this.ledger.jobs.completeModelCall(id, {
            response: null,
            inputTokens: null,
            outputTokens: null,
            latencyMs: Math.round(performance.now() - started),
            error,
          });
          throw new Error(error);
        }
        await this.ledger.jobs.completeModelCall(id, {
          response: reply.raw,
          inputTokens: reply.inputTokens,
          outputTokens: reply.outputTokens,
          latencyMs: Math.round(performance.now() - started),
          error: reply.error,
        });
        if (reply.error) {
          if (reply.retryable && credentialSlot === 'primary' && this.agents!.fallbackProvider) {
            provider = this.agents!.fallbackProvider;
            credentialSlot = 'backup';
            failoverFromCallId = id;
            return { retry: true };
          }
          throw new Error(reply.error);
        }
        if (reply.calls.length !== 1) throw new Error('Provider must return exactly one tool call');
        return { id, ...reply.calls[0] };
      },
      record: async (callId, role, name, args, result, context, rejected) => {
        toolCallIds.push(
          await this.ledger.jobs.recordToolCall(
            attemptId,
            callId,
            role,
            name,
            args,
            result,
            context.proposal.manifest,
            rejected ? 'rejected' : 'succeeded',
          ),
        );
      },
    });
    result.proposal.report.agent = {
      provider: config.provider,
      model: config.model,
      attemptId,
      findings: result.findings,
      inputArtifacts: result.proposal.manifest.readArtifacts,
      ...(result.diagnosticDecision ? { diagnosticDecision: result.diagnosticDecision } : {}),
    };
    return result.proposal;
  }
  async prepare(incident: Incident): Promise<RepairProposal> {
    return this.prepareFromModel(incident, await this.graph.read(incident));
  }
  private async prepareFromModel(
    incident: Incident,
    model: Awaited<ReturnType<EvidenceGraph['read']>>,
  ): Promise<RepairProposal> {
    const evaluations = model.evaluations;
    const previous = incident.reports.at(-1)!;
    const corrections = incident.corrections.filter(
      (c) => c.evidenceEpoch > previous.evidenceEpoch,
    );
    const paths = await Promise.all(
      corrections.map((c) => this.graph.impact(incident, c.targetId)),
    );
    if (paths.some((p) => p.generation !== model.view.generation))
      throw new Error('Graph generation changed during repair');
    const affected = [...new Set(paths.flatMap((p) => p.affectedClaimIds))];
    const claimOrder = new Map(incident.claims.map((claim, index) => [claim.id, index]));
    affected.sort((a, b) => claimOrder.get(a)! - claimOrder.get(b)!);
    return {
      evaluations,
      report: makeReport(
        [...model.claims].sort((a, b) => claimOrder.get(a.id)! - claimOrder.get(b.id)!),
        evaluations,
        incident.evidenceEpoch,
        previous,
      ),
      impact: {
        targetId: corrections.at(-1)?.targetId ?? 'diagnostic',
        affectedClaimIds: affected,
        preservedClaimIds: affected.filter(
          (id) => evaluations.find((e) => e.claimId === id)?.status === 'supported',
        ),
        unresolvedClaimIds: affected.filter(
          (id) => evaluations.find((e) => e.claimId === id)?.status !== 'supported',
        ),
        paths: paths.flatMap((p) => p.paths),
        graphGeneration: model.view.generation,
      },
      manifest: {
        evidenceEpoch: incident.evidenceEpoch,
        reportVersion: previous.version,
        graphGeneration: model.view.generation,
        projectedSeq: model.view.projectedSeq,
        readArtifacts: readArtifacts(incident),
      },
    };
  }
  async process(taskId: string) {
    const claimed = await this.ledger.jobs.claim(taskId);
    if (!claimed) return 'ignored';
    const heartbeat = setInterval(
      () => {
        void this.ledger.jobs
          .heartbeat(taskId, claimed.attempt.id)
          .catch((error) =>
            console.error(
              'Repair heartbeat failed:',
              error instanceof Error ? error.message : 'Database unavailable',
            ),
          );
      },
      Math.max(10, Math.floor(this.ledger.jobs.leaseMs / 3)),
    );
    heartbeat.unref();
    try {
      const proposal =
        claimed.proposal ??
        (claimed.incident.agentConfig
          ? await this.prepareWithAgents(
              claimed.incident,
              taskId,
              claimed.attempt.id,
              claimed.task.kind === 'repair',
            )
          : await this.prepare(claimed.incident));
      return await this.ledger.jobs.finish(taskId, claimed.attempt.id, proposal);
    } catch (error) {
      if (error instanceof StaleContextError) {
        await this.ledger.jobs.rejectStale(taskId, claimed.attempt.id, error.message);
        return 'stale';
      }
      await this.ledger.jobs.fail(
        taskId,
        claimed.attempt.id,
        error instanceof Error ? error.message : 'Repair failed',
      );
      return 'failed';
    } finally {
      clearInterval(heartbeat);
    }
  }
}

/** Bound even an injected transport that fails to honor AbortSignal. No implicit retry. */
async function invokeBounded(
  provider: ModelProvider,
  request: unknown,
  timeoutMs: number,
): Promise<ModelReply> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<ModelReply>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        raw: { timeout: true },
        calls: [],
        inputTokens: null,
        outputTokens: null,
        error: 'Provider request timed out.',
        retryable: provider.name === 'gemini',
      });
    }, timeoutMs);
  });
  try {
    return await Promise.race([provider.invoke(request, controller.signal), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
