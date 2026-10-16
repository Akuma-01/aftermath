import { agentConfigSchema } from '@aftermath/contracts';
import type { AgentRuntimeConfig } from '@aftermath/agents';
import { makeReport } from '@aftermath/domain';
import { randomUUID } from 'node:crypto';
import type { Diagnostic, GraphView, Snapshot } from '@aftermath/contracts';
import { RepairProcessor } from '@aftermath/repair';
import {
  createIncident,
  createCommerceIncident,
  applyDiagnostic,
  diagnosticAvailable,
} from '@aftermath/fixtures';
import { EvidenceGraph } from '@aftermath/graph';
import { ConflictError, Ledger, NotFoundError } from '@aftermath/storage';

export class InvestigationService {
  readonly processor: RepairProcessor;
  constructor(
    readonly ledger: Ledger,
    readonly graph: EvidenceGraph,
    readonly agents?: AgentRuntimeConfig,
  ) {
    this.processor = new RepairProcessor(ledger, graph, agents);
  }
  async create(scenario: 'checkout' | 'commerce' = 'checkout') {
    const incident = scenario === 'commerce' ? createCommerceIncident() : createIncident();
    incident.id = randomUUID();
    const model = await this.graph.read(incident);
    incident.evaluations = model.evaluations;
    incident.reports = [makeReport(model.claims, model.evaluations, incident.evidenceEpoch)];
    return this.ledger.create(incident);
  }
  private command(key: string, action: string, data: unknown) {
    return { key, fingerprint: JSON.stringify([action, data]) };
  }
  async snapshot(id: string): Promise<Snapshot> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const incident = await this.ledger.get(id);
      let graph: GraphView | null = null;
      let graphError: string | null = null;
      let diagnostics: Diagnostic[] = [];
      try {
        graph = (await this.graph.read(incident)).view;
        diagnostics = await this.graph.diagnostics(incident);
        if (diagnostics.some((d) => d.graphGeneration !== graph!.generation))
          throw new Error('Graph generation mismatch');
      } catch (error) {
        graph = null;
        diagnostics = [];
        graphError = 'Graph analysis is unavailable. Durable incident state is retained.';
        console.error('Graph unavailable:', error instanceof Error ? error.message : 'Unavailable');
      }
      const work = await this.ledger.jobs.work(id);
      if ((await this.ledger.get(id)).eventSeq !== incident.eventSeq) continue;
      return {
        incident,
        diagnostics,
        graph,
        work,
        graphError,
        mode: incident.agentConfig ? 'live' : 'deterministic',
        agentAvailability: {
          configured: Boolean(this.agents),
          provider: this.agents?.config.provider ?? null,
          model: this.agents?.config.model ?? null,
        },
        storage: this.ledger.kind === 'PostgreSQL' ? 'PostgreSQL + FalkorDB' : 'PGlite + FalkorDB',
      };
    }
    throw new ConflictError('Memory is updating. Retry this read.');
  }
  async graphAnalysis(
    id: string,
    kind: 'support' | 'diagnostics' | 'service-impact' | 'topology',
    serviceId?: string,
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const incident = await this.ledger.get(id);
      let result: unknown;
      if (kind === 'topology') {
        const serviceId = incident.topology?.services[0]?.id ?? incident.evidence[0]?.service;
        if (!serviceId) throw new NotFoundError('No services recorded');
        const impact = await this.graph.serviceImpact(incident, serviceId);
        result = {
          topology: impact.topology,
          generation: impact.generation,
          projectedSeq: impact.projectedSeq,
        };
      } else if (kind === 'service-impact') {
        if (!incident.topology?.services.some((s) => s.id === serviceId))
          throw new NotFoundError('Service not found in this incident');
        result = await this.graph.serviceImpact(incident, serviceId!);
      } else if (kind === 'diagnostics') {
        result = { diagnostics: await this.graph.diagnostics(incident) };
      } else {
        const model = await this.graph.read(incident);
        result = {
          generation: model.view.generation,
          evaluations: model.evaluations,
          claims: model.claims,
          evidence: model.evidence,
          view: model.view,
        };
      }
      if ((await this.ledger.get(id)).eventSeq === incident.eventSeq)
        return {
          incidentId: id,
          eventSeq: incident.eventSeq,
          evidenceEpoch: incident.evidenceEpoch,
          result,
        };
    }
    throw new ConflictError('Memory changed during graph analysis. Retry this read.');
  }

  async inspectClaim(id: string, claimId: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const incident = await this.ledger.get(id);
      const model = await this.graph.read(incident);
      const claim = model.claims.find((c) => c.id === claimId);
      if (!claim) throw new NotFoundError('Claim not found');
      if ((await this.ledger.get(id)).eventSeq !== incident.eventSeq) continue;
      return {
        incidentId: id,
        eventSeq: incident.eventSeq,
        evidenceEpoch: incident.evidenceEpoch,
        generation: model.view.generation,
        claim,
        evaluation: model.evaluations.find((e) => e.claimId === claimId),
      };
    }
    throw new ConflictError('Memory changed during claim inspection. Retry this read.');
  }
  async withdraw(id: string, evidenceId: string, reason: string, seq: number, key: string) {
    return this.ledger.withdraw(id, evidenceId, reason, seq, key);
  }
  async repair(id: string, seq: number, key: string) {
    return this.ledger.mutate(
      id,
      seq,
      this.command(key, 'repair', seq),
      'repair.queued',
      'A durable repair task was requested.',
      (incident) => {
        if (incident.reportStatus === 'current')
          throw new ConflictError('The report is already current');
      },
      true,
    );
  }
  async investigate(id: string, seq: number, key: string) {
    if (!this.agents)
      throw new ConflictError(
        'Configure LLM_PROVIDER, LLM_MODEL and the provider API key on the server to run live agents.',
      );
    return this.ledger.mutate(
      id,
      seq,
      this.command(key, 'investigate', seq),
      'agent.investigation_requested',
      'A live investigator and reporter run was requested. Subsequent corrections use this model configuration.',
      (incident) => {
        if (incident.agentConfig && incident.reportStatus === 'needs_review')
          throw new ConflictError(
            'An agent run is already awaiting completion. Use Retry repair after failure.',
          );
        incident.agentConfig = agentConfigSchema.parse(this.agents!.config);
        incident.evidenceEpoch++;
        incident.reportStatus = 'needs_review';
      },
      true,
    );
  }
  async holdReport(id: string, seq: number, key: string) {
    return this.ledger.mutate(
      id,
      seq,
      this.command(key, 'hold-report', seq),
      'report.hold_requested',
      'A report will be prepared and held before publication.',
      async (incident, tx) => {
        await this.ledger.jobs.ensure(tx, incident, 'report_preview');
      },
    );
  }
  async resumeReport(id: string, taskId: string, seq: number, key: string) {
    return this.ledger.mutate(
      id,
      seq,
      this.command(key, 'resume-report', [taskId, seq]),
      'repair.resumed',
      'The held attempt was queued to resume with its original context.',
      async (incident, tx) => {
        await this.ledger.jobs.resume(tx, incident, taskId);
      },
    );
  }
  async diagnose(id: string, recipeId: string, seq: number, key: string) {
    return this.ledger.mutate(
      id,
      seq,
      this.command(key, 'diagnose', [recipeId, seq]),
      'diagnostic.completed',
      `Registered synthetic diagnostic completed: ${recipeId}`,
      (incident) => {
        if (!diagnosticAvailable(incident, recipeId))
          throw new ConflictError('This diagnostic is unavailable or already completed');
        applyDiagnostic(incident, recipeId);
      },
      true,
    );
  }
  async freshSession(id: string, seq: number, key: string) {
    const incident = await this.ledger.get(id);
    const memory = await this.graph.corrections(incident);
    return this.ledger.mutate(
      id,
      seq,
      this.command(key, 'session', seq),
      'memory.correction_retrieved',
      `New session retrieved ${memory.corrections.length} persisted corrections from FalkorDB.`,
      (current) => {
        if (current.eventSeq !== incident.eventSeq)
          throw new ConflictError('Correction memory changed during retrieval');
        (current.sessions ??= []).push({
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          correctionIds: memory.corrections.map((c) => c.id),
          rejectedSourceIds: memory.corrections.map((c) => c.targetId),
          graphGeneration: memory.generation,
          message: memory.corrections.length
            ? `Retrieved ${memory.corrections.length} correction${memory.corrections.length === 1 ? '' : 's'} without previous conversation history. These exact source versions are excluded from supporting evidence.`
            : 'No corrections recorded for this incident. This is a new session with empty conversation history.',
        });
      },
    );
  }
  async close() {
    try {
      await this.graph.close();
    } finally {
      await this.ledger.close();
    }
  }
}
