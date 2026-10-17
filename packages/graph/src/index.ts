import { randomUUID } from 'node:crypto';
import { FalkorDB as EmbeddedDB } from 'falkordblite';
import { FalkorDB as RemoteDB } from 'falkordb';
import type { Graph } from 'falkordb';
import type {
  Claim,
  Correction,
  Evidence,
  Evaluation,
  GraphView,
  Incident,
  SupportGroup,
} from '@aftermath/contracts';
import { MAX_DEPENDENCY_DEPTH, validateGraph } from '@aftermath/domain';
import { READY_CLAIMS, EVALUATE_GROUPS, EVALUATE_CLAIMS, MEMBERSHIPS, IMPACT } from './queries';

import { projectServices, graphDiagnostics, serviceImpact } from './services';
import {
  incidentSchema,
  withdrawalPreviewSchema,
  type WithdrawalPreview,
} from '@aftermath/contracts';
import {
  compareWithdrawal,
  withdrawalSnapshotFingerprint,
  type PreviewGroup,
} from './withdrawal-preview';
export { withdrawalSnapshotFingerprint } from './withdrawal-preview';

type Client = Pick<EmbeddedDB, 'selectGraph' | 'close'>;
export class EvidenceGraph {
  private readonly generations = new Map<string, Promise<{ graph: Graph; generation: string }>>();
  private readonly ownedGraphs = new Set<string>();
  private readonly previews = new Set<Promise<WithdrawalPreview>>();
  private connectionError?: Error;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly db: Client) {}

  static async open(path?: string, url?: string) {
    const remoteOptions = {
      url,
      socket: { connectTimeout: 5000, reconnectStrategy: false as const },
      disableOfflineQueue: true,
    };
    const db = url
      ? await RemoteDB.connect(remoteOptions)
      : await EmbeddedDB.open({ path, timeout: 20000, logLevel: 'warning' });
    const engine = new EvidenceGraph(db);
    if (db instanceof RemoteDB)
      db.on('error', (error: Error) => {
        engine.connectionError = error;
      });
    return engine;
  }

  private async project(incident: Incident) {
    validateGraph(incident.evidence, incident.claims);
    const generation = `aftermath_${incident.id.replaceAll('-', '')}_${incident.eventSeq}_${randomUUID().replaceAll('-', '')}`;
    const graph = this.db.selectGraph(generation);
    this.ownedGraphs.add(generation);
    // Each generation is immutable after ready=true. Readers cannot see partial projection.
    await graph.query('CREATE (:Projection {seq: $seq, ready: false})', {
      params: { seq: incident.eventSeq },
    });
    // Batch each dependency-ordered phase; the ready marker stays false until all succeed.
    await graph.query(
      'UNWIND $rows AS row CREATE (:EvidenceVersion {id: row.id, payload: row.payload, kind: "evidence", title: row.title, status: row.status, environment: row.environment, timeWindow: row.timeWindow, originGroupIds: row.originGroupIds, position: row.position})',
      {
        params: {
          rows: incident.evidence.map((source, position) => ({
            position,
            environment: source.scope.environment,
            timeWindow: source.scope.timeWindow,
            originGroupIds: source.status === 'active' ? [source.originGroupId] : [],
            id: source.id,
            payload: JSON.stringify(source),
            title: source.title,
            status: source.status,
          })),
        },
      },
    );
    const statuses = new Map(incident.evaluations.map((e) => [e.claimId, e.status]));
    await graph.query(
      'UNWIND $rows AS row CREATE (:ClaimVersion {id: row.id, payload: row.payload, kind: "claim", title: row.title, status: row.status, environment: row.environment, timeWindow: row.timeWindow, position: row.position})',
      {
        params: {
          rows: incident.claims.map((claim, position) => ({
            position,
            environment: claim.scope.environment,
            timeWindow: claim.scope.timeWindow,
            id: claim.id,
            payload: JSON.stringify({
              ...claim,
              supportGroups: undefined,
              oppositionGroups: undefined,
            }),
            title: claim.title,
            status: statuses.get(claim.id) ?? 'needs_review',
          })),
        },
      },
    );
    await graph.query(
      `UNWIND $rows AS row
       MATCH (c:ClaimVersion {id: row.claimId})
       CREATE (c)-[:HAS_SUPPORT]->(g:SupportGroup {id: row.id, ruleId: row.ruleId, polarity: row.polarity, position: row.position})
       WITH c, g, row UNWIND row.members AS member
       MATCH (m {id: member.id}) WHERE m.kind IS NOT NULL
       CREATE (g)-[:REQUIRES {position: member.position}]->(m) MERGE (c)-[:DERIVED_FROM]->(m)`,
      {
        params: {
          rows: incident.claims.flatMap((claim) =>
            [...claim.supportGroups, ...claim.oppositionGroups].map((group, position) => ({
              position,
              polarity: position < claim.supportGroups.length ? 'support' : 'opposition',
              ruleId: group.ruleId,
              claimId: claim.id,
              id: group.id,
              members: group.memberIds.map((id, position) => ({ id, position })),
            })),
          ),
        },
      },
    );
    await graph.query(
      'UNWIND $rows AS row MATCH (e:EvidenceVersion {id: row.targetId}) CREATE (:Correction {id: row.id, payload: row.payload})-[:RETRACTS]->(e)',
      {
        params: {
          rows: incident.corrections.map((correction) => ({
            targetId: correction.targetId,
            id: correction.id,
            payload: JSON.stringify(correction),
          })),
        },
      },
    );
    await this.evaluate(graph);
    await projectServices(graph, incident);
    await graph.query('MATCH (p:Projection) SET p.ready = true');
    return { graph, generation };
  }

  private async evaluate(graph: Graph) {
    // The database resolves every group and claim. TypeScript only schedules DAG layers.
    for (let layer = 0; layer < MAX_DEPENDENCY_DEPTH; layer++) {
      const ready = await graph.roQuery<{ id: string }>(READY_CLAIMS);
      const ids = (ready.data ?? []).map((row) => row.id);
      if (!ids.length) break;
      await graph.query(EVALUATE_GROUPS, { params: { ids } });
      await graph.query(EVALUATE_CLAIMS, { params: { ids } });
    }
    const remaining = await graph.roQuery<{ count: number }>(
      'MATCH (c:ClaimVersion) WHERE c.evaluationStatus IS NULL RETURN count(c) AS count',
    );
    if (remaining.data?.[0]?.count !== 0)
      throw new Error('Graph support evaluation did not complete');
  }

  private async ready(incident: Incident) {
    if (this.closed) throw new Error('Evidence graph is closed');
    if (this.connectionError)
      throw new Error('FalkorDB connection failed', { cause: this.connectionError });
    const key = JSON.stringify([incident.id, incident.eventSeq]);
    if (!this.generations.has(key)) {
      // Snapshot before the first await: caller mutations cannot mix projection phases.
      const snapshot = incidentSchema.parse(incident);
      const correctionIds = new Set<string>();
      for (const correction of snapshot.corrections) {
        if (correctionIds.has(correction.id)) throw new Error('Duplicate correction');
        correctionIds.add(correction.id);
        const target = snapshot.evidence.find((source) => source.id === correction.targetId);
        if (!target || target.status !== 'withdrawn')
          throw new Error('Correction must target a withdrawn evidence version');
      }
      const build = this.project(snapshot).catch((error) => {
        this.generations.delete(key);
        throw error;
      });
      this.generations.set(key, build);
    }
    const result = await this.generations.get(key)!;
    const marker = await result.graph.roQuery<{ seq: number; ready: boolean }>(
      'MATCH (p:Projection) RETURN p.seq AS seq, p.ready AS ready',
    );
    if (marker.data?.[0]?.seq !== incident.eventSeq || marker.data[0].ready !== true)
      throw new Error('Graph projection is not ready');
    return result;
  }

  async read(incident: Incident): Promise<{
    view: GraphView;
    evidence: Evidence[];
    claims: Claim[];
    evaluations: Evaluation[];
  }> {
    const { graph, generation } = await this.ready(incident);
    const nodes = await graph.roQuery<{
      id: string;
      kind: 'evidence' | 'claim';
      title: string;
      status: string;
      payload: string;
      environment: string;
      timeWindow: string;
      evaluationStatus: Evaluation['status'] | null;
      originGroupIds: string[] | null;
    }>(`MATCH (n) WHERE n.kind IS NOT NULL
        RETURN n.id AS id, n.kind AS kind, n.title AS title, n.status AS status,
        n.payload AS payload, n.environment AS environment, n.timeWindow AS timeWindow,
        n.evaluationStatus AS evaluationStatus, n.originGroupIds AS originGroupIds
        ORDER BY n.position`);
    if (!nodes.data) throw new Error('Graph projection has no artifacts');
    const groups = await graph.roQuery<
      SupportGroup & {
        claimId: string;
        polarity: 'support' | 'opposition';
        position: number;
        valid: boolean;
        reasons: string[];
      }
    >(MEMBERSHIPS);
    const edges = await graph.roQuery<{ source: string; target: string }>(
      'MATCH (c:ClaimVersion)-[:DERIVED_FROM]->(m) RETURN c.id AS source, m.id AS target',
    );
    const membership = (id: string, polarity: 'support' | 'opposition') =>
      (groups.data ?? [])
        .filter((g) => g.claimId === id && g.polarity === polarity)
        .sort((a, b) => a.position - b.position);
    const toGroup = ({ id, ruleId, memberIds }: SupportGroup): SupportGroup => ({
      id,
      ruleId,
      memberIds,
    });
    return {
      view: {
        nodes: nodes.data.map(({ id, kind, title, status, evaluationStatus }) => ({
          id,
          kind,
          title,
          status: kind === 'claim' ? evaluationStatus! : status,
        })),
        edges: (edges.data ?? []).map((edge) => ({ ...edge, id: `${edge.source}:${edge.target}` })),
        generation,
        projectedSeq: incident.eventSeq,
      },
      evidence: nodes.data
        .filter((n) => n.kind === 'evidence')
        .map((n) => ({
          ...(JSON.parse(n.payload) as Evidence),
          status: n.status as Evidence['status'],
          scope: { environment: n.environment, timeWindow: n.timeWindow },
        })),
      claims: nodes.data
        .filter((n) => n.kind === 'claim')
        .map((n) => ({
          ...(JSON.parse(n.payload) as Claim),
          scope: { environment: n.environment, timeWindow: n.timeWindow },
          supportGroups: membership(n.id, 'support').map(toGroup),
          oppositionGroups: membership(n.id, 'opposition').map(toGroup),
        })),
      evaluations: nodes.data
        .filter((n) => n.kind === 'claim')
        .map((n) => ({
          claimId: n.id,
          status: n.evaluationStatus!,
          validGroupIds: membership(n.id, 'support')
            .filter((g) => g.valid)
            .map((g) => g.id),
          invalidGroups: membership(n.id, 'support')
            .filter((g) => !g.valid)
            .map(({ id, reasons }) => ({ id, reasons })),
          originGroupIds: n.originGroupIds ?? [],
        })),
    };
  }

  async impact(incident: Incident, evidenceId: string) {
    const { graph, generation } = await this.ready(incident);
    const result = await graph.roQuery<{ claimId: string; path: string[] }>(IMPACT, {
      params: { id: evidenceId },
    });
    return {
      affectedClaimIds: [...new Set((result.data ?? []).map((r) => r.claimId))],
      paths: (result.data ?? []).map((r) => [...r.path].reverse()),
      generation,
    };
  }

  /** Snapshot-specific advisory read; temporary derived graphs never enter the live cache. */
  async previewWithdrawal(incident: Incident, evidenceId: string): Promise<WithdrawalPreview> {
    if (this.closed) throw new Error('Evidence graph is closed');
    if (this.connectionError)
      throw new Error('FalkorDB connection failed', { cause: this.connectionError });
    // Parse before any await so caller mutations cannot mix before/after inputs.
    const snapshot = incidentSchema.parse(incident);
    const target = snapshot.evidence.find((e) => e.id === evidenceId);
    if (!target) throw new Error('Unknown evidence version');
    if (target.status !== 'active') throw new Error('Only active evidence can be previewed');
    const run = this.simulateWithdrawal(snapshot, evidenceId);
    this.previews.add(run);
    try {
      return await run;
    } finally {
      this.previews.delete(run);
    }
  }

  private async simulateWithdrawal(
    snapshot: Incident,
    evidenceId: string,
  ): Promise<WithdrawalPreview> {
    // Separate caches, shared connection. Closing these owners deletes only their graphs.
    const client: Client = {
      selectGraph: (name) => this.db.selectGraph(name),
      close: async () => {},
    };
    const baseline = new EvidenceGraph(client);
    const simulation = new EvidenceGraph(client);
    try {
      const before = await baseline.read(snapshot);
      const impact = await baseline.impact(snapshot, evidenceId);
      const { graph: beforeGraph } = await baseline.ready(snapshot);
      const beforeGroups = await beforeGraph.roQuery<PreviewGroup>(MEMBERSHIPS);
      const hypothetical = incidentSchema.parse(snapshot);
      hypothetical.evidence.find((e) => e.id === evidenceId)!.status = 'withdrawn';
      // No correction, sequence increment, report revision or durable event is fabricated.
      const after = await simulation.read(hypothetical);
      const { graph: afterGraph } = await simulation.ready(hypothetical);
      const afterGroups = await afterGraph.roQuery<PreviewGroup>(MEMBERSHIPS);
      const affected = new Set(impact.affectedClaimIds);
      const associations = await beforeGraph.roQuery<{ serviceId: string; artifactId: string }>(
        `MATCH (n)-[:ABOUT]->(s:Service) WHERE n.id IN $ids AND n.kind IS NOT NULL
         RETURN DISTINCT s.id AS serviceId, n.id AS artifactId ORDER BY serviceId, artifactId`,
        { params: { ids: [evidenceId, ...affected] } },
      );
      const services: WithdrawalPreview['services'] = [];
      for (const serviceId of [
        ...new Set((associations.data ?? []).map((row) => row.serviceId)),
      ].sort()) {
        const impact = await baseline.serviceImpact(snapshot, serviceId);
        services.push({
          serviceId,
          artifactIds: (associations.data ?? [])
            .filter((row) => row.serviceId === serviceId)
            .map((row) => row.artifactId),
          dependencyPaths: impact.paths,
        });
      }
      return withdrawalPreviewSchema.parse({
        kind: 'evidence-withdrawal-preview',
        readOnly: true,
        snapshot: {
          incidentId: snapshot.id,
          eventSeq: snapshot.eventSeq,
          evidenceEpoch: snapshot.evidenceEpoch,
          reportVersion: snapshot.reports.at(-1)?.version ?? null,
          fingerprint: withdrawalSnapshotFingerprint(snapshot),
        },
        evidenceId,
        affectedClaimIds: [...affected].sort(),
        paths: impact.paths.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        ...compareWithdrawal(
          hypothetical,
          evidenceId,
          before.evaluations,
          after.evaluations,
          beforeGroups.data ?? [],
          afterGroups.data ?? [],
          affected,
        ),
        services,
      });
    } finally {
      const cleanup = await Promise.allSettled([baseline.close(), simulation.close()]);
      const failures = cleanup.filter((r) => r.status === 'rejected');
      if (failures.length)
        throw new AggregateError(
          failures.map((r) => r.reason),
          'Preview graph cleanup failed',
        );
    }
  }

  async diagnostics(incident: Incident) {
    const { graph, generation } = await this.ready(incident);
    return graphDiagnostics(graph, generation);
  }

  async serviceImpact(incident: Incident, serviceId: string) {
    const { graph, generation } = await this.ready(incident);
    return serviceImpact(graph, generation, incident.eventSeq, serviceId);
  }

  async corrections(
    incident: Incident,
  ): Promise<{ corrections: Correction[]; generation: string }> {
    const { graph, generation } = await this.ready(incident);
    const result = await graph.roQuery<{ payload: string }>(
      'MATCH (c:Correction)-[:RETRACTS]->(:EvidenceVersion) RETURN c.payload AS payload',
    );
    return {
      corrections: (result.data ?? []).map((row) => JSON.parse(row.payload) as Correction),
      generation,
    };
  }

  async close() {
    if (!this.closing) {
      this.closed = true;
      this.closing = (async () => {
        await Promise.allSettled(this.previews);
        await Promise.allSettled(this.generations.values());
        const deleted = await Promise.allSettled(
          [...this.ownedGraphs].map((name) => this.db.selectGraph(name).delete()),
        );
        await this.db.close();
        const failures = deleted.filter((result) => result.status === 'rejected');
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            'Failed to delete graph generations',
          );
      })();
    }
    return this.closing;
  }
}
