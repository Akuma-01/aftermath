import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { FalkorDB } from 'falkordblite';
import type { Graph } from 'falkordb';
import { EvidenceGraph } from '@aftermath/graph';
import {
  createDomainFixture as createIncident,
  createIncident as createCheckoutIncident,
  createCommerceIncident,
} from '@aftermath/fixtures';
import { EVALUATE_GROUPS } from '../packages/graph/src/queries';
import { evaluateSupport } from '@aftermath/domain';

let db: FalkorDB;
const engines: EvidenceGraph[] = [];
beforeAll(async () => {
  db = await FalkorDB.open({ timeout: 20000, logLevel: 'warning' });
});
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()));
});
afterAll(async () => {
  await db?.close();
});

function observedGraph(beforeWrite?: (query: string, graph: Graph) => Promise<void>) {
  const writes: string[] = [];
  const generations: string[] = [];
  const engine = new EvidenceGraph({
    selectGraph(name) {
      const graph = db.selectGraph(name);
      const query = graph.query.bind(graph);
      vi.spyOn(graph, 'query').mockImplementation(async (text, options) => {
        writes.push(String(text));
        if (!generations.includes(name)) generations.push(name);
        await beforeWrite?.(String(text), graph);
        return query(text, options);
      });
      return graph;
    },
    // Tests share the engine process, but each wrapper deletes its own generations.
    close: async () => {},
  });
  engines.push(engine);
  return { engine, writes, generations };
}

it('projects complete payloads, opposition, group memberships and corrections before activating a generation', async () => {
  const incident = createIncident();
  incident.evidence[0].status = 'withdrawn';
  incident.corrections.push({
    id: 'correction-1',
    targetId: 'E1-v1',
    reason: 'The imported log belongs to staging.',
    evidenceEpoch: 2,
    createdAt: new Date().toISOString(),
  });
  incident.claims[1].oppositionGroups.push({
    id: 'opposition',
    ruleId: 'test',
    memberIds: ['E2-v1'],
  });
  const { engine, writes } = observedGraph();
  const model = await engine.read(incident);
  expect(writes.filter((query) => query.includes('SET p.ready = true'))).toHaveLength(1);
  expect(model.evidence).toEqual(expect.arrayContaining(incident.evidence));
  expect(model.evidence).toHaveLength(incident.evidence.length);
  expect(model.claims).toEqual(expect.arrayContaining(incident.claims));
  expect(model.claims).toHaveLength(incident.claims.length);
  expect(model.evaluations).toEqual(
    expect.arrayContaining(evaluateSupport(incident.evidence, incident.claims)),
  );
  const groups = incident.claims.flatMap((c) => [...c.supportGroups, ...c.oppositionGroups]);
  const memberships = await db.selectGraph(model.view.generation).roQuery<{
    groupId: string;
    memberId: string;
  }>('MATCH (g:SupportGroup)-[:REQUIRES]->(m) RETURN g.id AS groupId, m.id AS memberId');
  expect(memberships.data).toHaveLength(groups.reduce((sum, g) => sum + g.memberIds.length, 0));
  expect(memberships.data).toEqual(
    expect.arrayContaining(
      groups.flatMap((g) => g.memberIds.map((memberId) => ({ groupId: g.id, memberId }))),
    ),
  );
  const edges = incident.claims.flatMap((c) =>
    [...new Set([...c.supportGroups, ...c.oppositionGroups].flatMap((g) => g.memberIds))].map(
      (target) => ({ source: c.id, target, id: `${c.id}:${target}` }),
    ),
  );
  expect(model.view.edges).toHaveLength(edges.length);
  expect(model.view.edges).toEqual(expect.arrayContaining(edges));
  expect((await engine.impact(incident, 'E1-v1')).paths).toContainEqual([
    'E1-v1',
    'C2-v1',
    'C3-v1',
  ]);
  expect((await engine.corrections(incident)).corrections).toEqual(incident.corrections);
  expect((await engine.read(incident)).view.generation).toBe(model.view.generation);
  expect(writes.filter((query) => query.includes('SET p.ready = true'))).toHaveLength(1);
});

it('handles empty claim, group and correction batches without losing evidence', async () => {
  const incident = createIncident();
  incident.claims = [];
  incident.evaluations = [];
  const { engine } = observedGraph();
  const model = await engine.read(incident);
  expect(model.claims).toEqual([]);
  expect(model.view.edges).toEqual([]);
  expect(model.evidence).toHaveLength(incident.evidence.length);
  expect((await engine.corrections(incident)).corrections).toEqual([]);
});

it('keeps concurrent readers behind the ready marker and shares one projection', async () => {
  let signal!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blockedGraph!: Graph;
  const { engine, writes, generations } = observedGraph(async (query, graph) => {
    if (query.includes('SET p.ready = true')) {
      blockedGraph = graph;
      signal();
      await held;
    }
  });
  const incident = createIncident();
  let completed = 0;
  const reads = Promise.all(
    [engine.read(incident), engine.read(incident)].map((read) =>
      read.then((value) => {
        completed++;
        return value;
      }),
    ),
  );
  await reached;
  try {
    const marker = await blockedGraph.roQuery<{ ready: boolean }>(
      'MATCH (p:Projection) RETURN p.ready AS ready',
    );
    expect(marker.data).toEqual([{ ready: false }]);
    expect(completed).toBe(0);
    expect(generations).toHaveLength(1);
  } finally {
    release();
  }
  const [first, second] = await reads;
  expect(first).toEqual(second);
  expect(first.view.nodes).toHaveLength(11);
  expect(writes.filter((query) => query.includes('SET p.ready = true'))).toHaveLength(1);
});

it('never exposes an interrupted batch and retries in a fresh complete generation', async () => {
  let fail = true;
  const { engine, generations } = observedGraph(async (query) => {
    if (fail && query.includes('[:RETRACTS]')) {
      fail = false;
      throw new Error('Interrupted projection');
    }
  });
  const incident = createIncident();
  incident.evidence[0].status = 'withdrawn';
  incident.corrections.push({
    id: 'interrupted-correction',
    targetId: 'E1-v1',
    reason: 'Staging import must be excluded.',
    evidenceEpoch: 2,
    createdAt: new Date().toISOString(),
  });
  await expect(engine.read(incident)).rejects.toThrow('Interrupted projection');
  const failed = generations[0];
  const marker = await db
    .selectGraph(failed)
    .roQuery<{ ready: boolean }>('MATCH (p:Projection) RETURN p.ready AS ready');
  expect(marker.data).toEqual([{ ready: false }]);
  const retried = await engine.read(incident);
  expect(retried.view.generation).not.toBe(failed);
  expect(retried.view.nodes).toHaveLength(11);
  expect((await engine.corrections(incident)).corrections).toEqual(incident.corrections);
  expect(generations).toHaveLength(2);
});

it('evaluates actual premise edges even when the original ledger membership disagrees', async () => {
  const incident = createIncident();
  incident.evidence[0].status = 'withdrawn';
  let changed = false;
  const { engine } = observedGraph(async (query, graph) => {
    if (query === EVALUATE_GROUPS && !changed) {
      changed = true;
      await graph.query(`MATCH (g:SupportGroup {id: 'C2-G1'})-[r:REQUIRES]->(:EvidenceVersion {id: 'E1-v1'}),
        (replacement:EvidenceVersion {id: 'E2-v1'}) DELETE r CREATE (g)-[:REQUIRES {position: 0}]->(replacement)`);
    }
  });
  const model = await engine.read(incident);
  expect(
    evaluateSupport(incident.evidence, incident.claims).find((e) => e.claimId === 'C2-v1')?.status,
  ).toBe('unsupported');
  expect(model.evaluations.find((e) => e.claimId === 'C2-v1')?.status).toBe('supported');
  expect(model.claims.find((c) => c.id === 'C2-v1')?.supportGroups[0].memberIds).toEqual(['E2-v1']);
});

it('uses explicit graph polarity to distinguish support from opposition', async () => {
  let changed = false;
  const { engine } = observedGraph(async (query, graph) => {
    if (query === EVALUATE_GROUPS && !changed) {
      changed = true;
      await graph.query("MATCH (g:SupportGroup {id: 'C2-G1'}) SET g.polarity = 'opposition'");
    }
  });
  const model = await engine.read(createIncident());
  expect(model.evaluations.find((e) => e.claimId === 'C2-v1')?.status).toBe('unsupported');
  expect(model.claims.find((c) => c.id === 'C2-v1')?.supportGroups).toEqual([]);
  expect(model.claims.find((c) => c.id === 'C2-v1')?.oppositionGroups).toHaveLength(1);
});

it.each(['withdrawn', 'superseded', 'quarantined'] as const)(
  'matches the oracle for %s evidence and surviving alternatives',
  async (status) => {
    const incident = createIncident();
    incident.evidence[0].status = status;
    incident.evidence[2].status = status;
    const { engine } = observedGraph();
    const model = await engine.read(incident);
    expect(model.evaluations).toEqual(evaluateSupport(incident.evidence, incident.claims));
    expect(model.evaluations[3]).toMatchObject({ status: 'supported', validGroupIds: ['C4-G2'] });
    expect(model.evaluations[2].status).toBe('unsupported');
  },
);

it('evaluates contested dependencies, scope and deduplicated provenance', async () => {
  const incident = createIncident();
  incident.claims[1].oppositionGroups = [
    { id: 'opposition', ruleId: 'test', memberIds: ['E2-v1'] },
  ];
  incident.evidence[2].originGroupId = incident.evidence[3].originGroupId;
  const { engine } = observedGraph();
  const first = await engine.read(incident);
  expect(first.evaluations).toEqual(evaluateSupport(incident.evidence, incident.claims));
  expect(first.evaluations[1].status).toBe('contested');
  expect(first.evaluations[2].status).toBe('unsupported');
  expect(first.evaluations[3].originGroupIds).toHaveLength(1);
  incident.eventSeq++;
  incident.evidence[1].scope.environment = 'staging';
  incident.evidence[2].scope.timeWindow = 'another window';
  const second = await engine.read(incident);
  expect(second.evaluations).toEqual(evaluateSupport(incident.evidence, incident.claims));
  expect(second.evaluations[1].status).toBe('supported');
});

it('isolates incidents, immutable revisions and independent engine owners', async () => {
  const incident = createIncident();
  const { engine } = observedGraph();
  const first = await engine.read(incident);
  const old = structuredClone(incident);
  incident.evidence[0].status = 'withdrawn';
  incident.eventSeq++;
  const revised = await engine.read(incident);
  expect(revised.view.generation).not.toBe(first.view.generation);
  expect((await engine.read(old)).evaluations).toEqual(first.evaluations);
  const other = structuredClone(incident);
  other.id = 'another-incident';
  other.evidence[0].status = 'active';
  expect((await engine.read(other)).evaluations[1].status).toBe('supported');
  const independent = observedGraph();
  const own = await independent.engine.read(old);
  expect(own.view.generation).not.toBe(first.view.generation);
  await engine.close();
  expect((await independent.engine.read(old)).view.generation).toBe(own.view.generation);
  expect(await db.list()).not.toContain(first.view.generation);
  await expect(engine.read(old)).rejects.toThrow('closed');
});

it('snapshots inputs before asynchronous projection starts', async () => {
  const incident = createIncident();
  const original = structuredClone(incident);
  const { engine } = observedGraph(async (query) => {
    if (query.startsWith('CREATE (:Projection')) incident.evidence[0].status = 'withdrawn';
  });
  expect((await engine.read(incident)).evaluations).toEqual(
    evaluateSupport(original.evidence, original.claims),
  );
});

it('rejects invalid graphs and correction targets before writing', async () => {
  const { engine, writes } = observedGraph();
  const incident = createIncident();
  incident.claims[0].supportGroups[0].memberIds = ['missing'];
  await expect(engine.read(incident)).rejects.toThrow('Unknown premise');
  const corrected = createIncident();
  corrected.corrections.push({
    id: 'bad',
    targetId: 'E1-v1',
    reason: 'bad',
    createdAt: '2026-09-25T10:10:00Z',
    evidenceEpoch: 2,
  });
  await expect(engine.read(corrected)).rejects.toThrow('withdrawn evidence');
  expect(writes).toEqual([]);
});

it('supports empty graphs and claims without positive groups', async () => {
  const { engine } = observedGraph();
  const incident = createIncident();
  incident.claims[0].supportGroups = [];
  expect((await engine.read(incident)).evaluations).toEqual(
    evaluateSupport(incident.evidence, incident.claims),
  );
  incident.eventSeq++;
  incident.evidence = [];
  incident.claims = [];
  incident.evaluations = [];
  expect((await engine.read(incident)).evaluations).toEqual([]);
});

it('rejects reads when the graph service fails, including cached generations', async () => {
  let unavailable = false;
  const engine = new EvidenceGraph({
    selectGraph(name) {
      const graph = db.selectGraph(name);
      const read = graph.roQuery.bind(graph);
      vi.spyOn(graph, 'roQuery').mockImplementation(async (...args) => {
        if (unavailable) throw new Error('Graph service unavailable');
        return read(...args);
      });
      return graph;
    },
    close: async () => {},
  });
  engines.push(engine);
  const incident = createIncident();
  await engine.read(incident);
  unavailable = true;
  await expect(engine.read(incident)).rejects.toThrow('Graph service unavailable');
  incident.eventSeq++;
  await expect(engine.read(incident)).rejects.toThrow('Graph service unavailable');
});

it('rejects a generation with a missing or incorrect readiness marker', async () => {
  const { engine } = observedGraph();
  const incident = createIncident();
  const model = await engine.read(incident);
  await db.selectGraph(model.view.generation).query('MATCH (p:Projection) SET p.ready = false');
  await expect(engine.read(incident)).rejects.toThrow('not ready');
});

it('opens and closes its own embedded database', async () => {
  const engine = await EvidenceGraph.open();
  try {
    const incident = createIncident();
    expect((await engine.read(incident)).evaluations).toEqual(
      evaluateSupport(incident.evidence, incident.claims),
    );
  } finally {
    await engine.close();
  }
  await engine.close();
});

it('rejects an unavailable remote connection instead of falling back locally', async () => {
  await expect(EvidenceGraph.open(undefined, 'redis://127.0.0.1:1')).rejects.toThrow();
});

it('resolves twelve dependency layers and rejects a thirteenth', async () => {
  const incident = createIncident();
  const template = incident.claims[0];
  incident.claims = Array.from({ length: 12 }, (_, index) => ({
    ...structuredClone(template),
    id: `depth-${index}`,
    supportGroups: [
      {
        id: `group-${index}`,
        ruleId: 'depth',
        memberIds: [index ? `depth-${index - 1}` : 'E1-v1'],
      },
    ],
  })).reverse();
  const { engine } = observedGraph();
  expect((await engine.read(incident)).evaluations).toEqual(
    evaluateSupport(incident.evidence, incident.claims),
  );
  incident.eventSeq++;
  incident.claims.push({
    ...structuredClone(template),
    id: 'too-deep',
    supportGroups: [{ id: 'too-deep-group', ruleId: 'depth', memberIds: ['depth-11'] }],
  });
  await expect(engine.read(incident)).rejects.toThrow('Dependency depth');
});

it('explains commerce impact, alternative support, shortest paths, and topology-sensitive diagnostic ranking', async () => {
  const incident = createCommerceIncident();
  incident.evidence[0].status = 'withdrawn';
  const { engine } = observedGraph();
  const model = await engine.read(incident);
  expect(model.evaluations).toEqual(
    expect.arrayContaining(evaluateSupport(incident.evidence, incident.claims)),
  );
  expect(model.evaluations.find((e) => e.claimId === 'C17-v1')).toMatchObject({
    status: 'supported',
    validGroupIds: ['C17-G2'],
  });
  expect((await engine.impact(incident, 'E1-v1')).paths).toContainEqual([
    'E1-v1',
    'C2-v1',
    'C11-v1',
    'C15-v1',
    'C16-v1',
  ]);
  const ranked = await engine.diagnostics(incident);
  expect(ranked[0].id).toBe('production-pool');
  expect(ranked[0].paths).toContainEqual({
    claimId: 'C15-v1',
    serviceIds: ['fulfillment', 'orders', 'database'],
  });
  const impact = await engine.serviceImpact(incident, 'database');
  expect(impact.paths).toContainEqual({
    serviceId: 'storefront',
    hops: 3,
    path: ['storefront', 'gateway', 'catalog', 'database'],
  });
  expect(impact.paths.some((p) => p.serviceId === 'notifications')).toBe(false);
  expect(impact.centrality).toHaveLength(24);
  expect(impact.centrality.every((r) => Number.isFinite(r.score) && r.score >= 0)).toBe(true);
  // Remove every incoming path to the database. Only the database finding is still reachable by its check.
  incident.topology!.dependencies = incident.topology!.dependencies.filter(
    (d) => d.dependency !== 'database',
  );
  incident.eventSeq++;
  const disconnected = await engine.diagnostics(incident);
  expect(disconnected.find((d) => d.id === 'production-pool')!.paths).toEqual([
    { claimId: 'C2-v1', serviceIds: ['database'] },
  ]);
  expect(disconnected.find((d) => d.id === 'production-pool')!.score).toBeLessThan(ranked[0].score);
});

it('keeps service paths and diagnostics isolated between incident graphs', async () => {
  const { engine } = observedGraph();
  const commerce = createCommerceIncident();
  const checkout = createCheckoutIncident();
  await engine.read(commerce);
  expect((await engine.serviceImpact(checkout, 'database')).paths.map((p) => p.serviceId)).toEqual([
    'checkout',
  ]);
  await expect(engine.serviceImpact(checkout, 'fulfillment')).rejects.toThrow('Unknown service');
});
