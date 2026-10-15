import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { FalkorDB } from 'falkordblite';
import type { Graph } from 'falkordb';
import type { Incident } from '@aftermath/contracts';
import { incidentSchema } from '@aftermath/contracts';
import { createIncident, createCommerceIncident } from '@aftermath/fixtures';
import { EvidenceGraph } from '@aftermath/graph';
import { evaluateSupport } from '@aftermath/domain';

let db: FalkorDB;
const engines: EvidenceGraph[] = [];
beforeAll(async () => {
  db = await FalkorDB.open({ timeout: 20000, logLevel: 'warning' });
});
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.close()));
});
afterAll(async () => {
  await db?.close();
});
function engine(before?: (query: string, graph: Graph) => Promise<void>) {
  const result = new EvidenceGraph({
    selectGraph(name) {
      const graph = db.selectGraph(name);
      const query = graph.query.bind(graph);
      vi.spyOn(graph, 'query').mockImplementation(async (text, options) => {
        await before?.(String(text), graph);
        return query(text, options);
      });
      return graph;
    },
    close: async () => {},
  });
  engines.push(result);
  return result;
}

it('preserves deterministic complete commerce data without revealing diagnostic outcomes', () => {
  const incident = createCommerceIncident();
  expect(createCommerceIncident()).toEqual(incident);
  expect(incidentSchema.parse(incident)).toEqual(incident);
  expect(incident.topology!.services).toHaveLength(24);
  expect(incident.topology!.dependencies).toHaveLength(34);
  expect(incident.evidence).toHaveLength(17);
  expect(incident.claims).toHaveLength(18);
  expect(incident.evidence.some((e) => ['E7-v1', 'E8-v1', 'E9-v1'].includes(e.id))).toBe(false);
  expect(incident.evaluations).toEqual(evaluateSupport(incident.evidence, incident.claims));
  incident.diagnosticRecipes![0].informs.push('changed');
  incident.topology!.dependencies.length = 0;
  expect(createCommerceIncident().topology!.dependencies).toHaveLength(34);
  expect(createIncident().diagnosticRecipes![0].informs).toHaveLength(2);
});

it('returns caller-to-dependency blast radius and importance separately from claim support', async () => {
  const incident = createIncident();
  const graph = engine();
  const impact = await graph.serviceImpact(incident, 'database');
  expect(impact.paths).toEqual([
    { serviceId: 'checkout', hops: 1, path: ['checkout', 'database'] },
  ]);
  expect(impact.topology.services).toHaveLength(3);
  expect(impact.topology.dependencies).toEqual(incident.topology!.dependencies);
  expect((await graph.serviceImpact(incident, 'checkout')).paths).toEqual([]);
  expect(impact.centrality).toHaveLength(3);
  expect(impact.centrality.every((row) => Number.isFinite(row.score) && row.score >= 0)).toBe(true);
  expect(impact.centrality.find((r) => r.serviceId === 'database')!.score).toBeGreaterThan(
    impact.centrality.find((r) => r.serviceId === 'checkout')!.score,
  );
  expect((await graph.read(incident)).evaluations.every((e) => e.status === 'supported')).toBe(
    true,
  );
});

it('ranks small-incident coverage and cost from unresolved graph claims', async () => {
  const incident = createIncident();
  incident.evidence[0].status = 'withdrawn';
  const graph = engine();
  const rows = await graph.diagnostics(incident);
  expect(rows.map((r) => r.id)).toEqual([
    'source-environment',
    'production-pool',
    'payment-timeouts',
  ]);
  const pool = rows.find((r) => r.id === 'production-pool')!;
  expect(pool.paths).toEqual([
    { claimId: 'C2-v1', serviceIds: ['database'] },
    { claimId: 'C3-v1', serviceIds: ['checkout', 'database'] },
  ]);
  expect(pool.score).toBeCloseTo((2 + 0.1 * (1 + 1 / 2)) / 2);
  expect(pool.graphGeneration).toBe((await graph.read(incident)).view.generation);
  expect(rows.find((r) => r.id === 'payment-timeouts')!.score).toBe(0);
  incident.completedDiagnosticIds = ['source-environment'];
  incident.eventSeq++;
  const completed = await graph.diagnostics(incident);
  expect(completed[0].id).toBe('production-pool');
  expect(completed.find((r) => r.id === 'source-environment')).toMatchObject({
    available: false,
    completed: true,
    score: 0,
  });
});

it.each(['withdrawn', 'superseded', 'quarantined', 'environment', 'timeWindow'])(
  'rejects %s diagnostic prerequisites',
  async (reason) => {
    const incident = createIncident();
    incident.evidence[2].status = 'withdrawn';
    incident.evidence[3].status = 'withdrawn';
    const prerequisite = incident.evidence[5];
    if (reason === 'environment' || reason === 'timeWindow') prerequisite.scope[reason] = 'wrong';
    else prerequisite.status = reason as 'withdrawn' | 'superseded' | 'quarantined';
    const diagnostic = (await engine().diagnostics(incident)).find(
      (r) => r.id === 'payment-timeouts',
    );
    expect(diagnostic).toMatchObject({ available: false, score: 0, completed: false });
  },
);

it('treats all prerequisites as required and includes contested findings in coverage', async () => {
  const incident = createIncident();
  incident.claims[1].oppositionGroups.push({
    id: 'opposition',
    ruleId: 'test',
    memberIds: ['E2-v1'],
  });
  incident.diagnosticRecipes![0].prerequisiteIds = ['E5-v1', 'E6-v1'];
  const graph = engine();
  expect(
    (await graph.diagnostics(incident)).find((r) => r.id === 'production-pool')!.paths,
  ).toHaveLength(2);
  incident.evidence[4].status = 'withdrawn';
  incident.eventSeq++;
  expect((await graph.diagnostics(incident)).find((r) => r.id === 'production-pool')).toMatchObject(
    { available: false, score: 0 },
  );
});

it('uses actual NEEDS edges, not serialized recipe prerequisites', async () => {
  const incident = createIncident();
  incident.evidence[0].status = 'withdrawn';
  let altered = false;
  const graph = engine(async (query, g) => {
    if (query.includes('SET p.ready = true') && !altered) {
      altered = true;
      await g.query(
        "MATCH (d:DiagnosticRecipe {id:'production-pool'}), (e:EvidenceVersion {id:'E1-v1'}) CREATE (d)-[:NEEDS]->(e)",
      );
    }
  });
  expect(incident.diagnosticRecipes![0].prerequisiteIds).toEqual([]);
  expect((await graph.diagnostics(incident)).find((r) => r.id === 'production-pool')).toMatchObject(
    { available: false, score: 0 },
  );
});

it('uses actual service edges for diagnostic ranking and blast radius', async () => {
  const incident = createIncident();
  incident.evidence[0].status = 'withdrawn';
  const graph = engine(async (query, g) => {
    if (query.includes('SET p.ready = true'))
      await g.query('MATCH (:Service)-[r:DEPENDS_ON]->(:Service) DELETE r');
  });
  expect((await graph.serviceImpact(incident, 'database')).paths).toEqual([]);
  expect(
    (await graph.diagnostics(incident)).find((r) => r.id === 'production-pool')!.paths,
  ).toEqual([{ claimId: 'C2-v1', serviceIds: ['database'] }]);
});

it('stably chooses equal shortest paths and recipe score ties across insertion orders', async () => {
  const incident = createIncident();
  incident.evidence[0].status = 'withdrawn';
  incident.topology!.services.push(
    { id: 'a', name: 'a', tier: 1 },
    { id: 'b', name: 'b', tier: 1 },
  );
  incident.topology!.dependencies = [
    { caller: 'checkout', dependency: 'b' },
    { caller: 'b', dependency: 'database' },
    { caller: 'checkout', dependency: 'a' },
    { caller: 'a', dependency: 'database' },
  ];
  incident.diagnosticRecipes = [
    { ...incident.diagnosticRecipes![0], id: 'z' },
    { ...incident.diagnosticRecipes![0], id: 'a' },
  ];
  const graph = engine();
  const first = await graph.serviceImpact(incident, 'database');
  expect(first.paths.find((p) => p.serviceId === 'checkout')!.path).toEqual([
    'checkout',
    'a',
    'database',
  ]);
  const diagnostics = await graph.diagnostics(incident);
  expect(diagnostics.map((d) => d.id)).toEqual(['a', 'z']);
  expect(diagnostics[0].paths[1].serviceIds).toEqual(['checkout', 'a', 'database']);
  incident.topology!.dependencies.reverse();
  incident.topology!.services.reverse();
  incident.eventSeq++;
  expect((await graph.serviceImpact(incident, 'database')).paths).toEqual(first.paths);
  expect((await graph.diagnostics(incident))[0].paths).toEqual(diagnostics[0].paths);
});

it.each([
  (i: Incident) => i.topology!.services.push(i.topology!.services[0]),
  (i: Incident) => i.topology!.dependencies.push({ caller: 'missing', dependency: 'database' }),
  (i: Incident) => i.topology!.dependencies.push({ caller: 'database', dependency: 'database' }),
  (i: Incident) => {
    i.claims[0].serviceIds = ['missing'];
  },
  (i: Incident) => {
    i.evidence[0].service = 'missing';
  },
  (i: Incident) => {
    i.diagnosticRecipes![0].serviceId = 'missing';
  },
  (i: Incident) => {
    i.diagnosticRecipes![0].informs = ['missing'];
  },
  (i: Incident) => {
    i.diagnosticRecipes![0].prerequisiteIds = ['missing'];
  },
  (i: Incident) => {
    i.diagnosticRecipes![0].estimatedCost = -1;
  },
  (i: Incident) => i.diagnosticRecipes!.push(i.diagnosticRecipes![0]),
  (i: Incident) => {
    i.diagnosticRecipes![0].informs = [];
  },
  (i: Incident) => {
    i.topology!.services = Array.from({ length: 129 }, (_, n) => ({
      id: String(n),
      name: String(n),
      tier: 0,
    }));
  },
  (i: Incident) => {
    i.topology!.dependencies = Array.from({ length: 513 }, () => ({
      caller: 'checkout',
      dependency: 'database',
    }));
  },
])('rejects invalid topology or recipes without publishing', async (mutate) => {
  let activated = false;
  const graph = engine(async (q) => {
    if (q.includes('SET p.ready = true')) activated = true;
  });
  const incident = createIncident();
  mutate(incident);
  await expect(graph.diagnostics(incident)).rejects.toThrow();
  expect(activated).toBe(false);
});

it('keeps interrupted service projections unpublished and retries', async () => {
  let fail = true;
  let activated = 0;
  const graph = engine(async (q) => {
    if (q.includes('SET p.ready = true')) activated++;
    if (fail && q.includes('CREATE (d)-[:NEEDS]')) {
      fail = false;
      throw new Error('Service projection interrupted');
    }
  });
  const incident = createIncident();
  await expect(graph.read(incident)).rejects.toThrow('Service projection interrupted');
  expect(activated).toBe(0);
  expect(await graph.diagnostics(incident)).toHaveLength(3);
  expect(activated).toBe(1);
});

it('derives missing claim service links from evidence paths and handles service cycles', async () => {
  const incident = createIncident();
  incident.claims.forEach((c) => {
    delete c.serviceIds;
  });
  incident.evidence[0].status = 'withdrawn';
  incident.topology!.dependencies.push({ caller: 'database', dependency: 'checkout' });
  const graph = engine();
  expect(
    (await graph.diagnostics(incident))
      .find((d) => d.id === 'production-pool')!
      .paths.map((p) => p.claimId),
  ).toEqual(['C2-v1', 'C3-v1']);
  const impact = await graph.serviceImpact(incident, 'database');
  expect(impact.paths).toEqual([
    { serviceId: 'checkout', hops: 1, path: ['checkout', 'database'] },
  ]);
  expect(impact.centrality.every((r) => Number.isFinite(r.score))).toBe(true);
});

it('does not expose service or diagnostic reads during incomplete projection', async () => {
  let signal!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const graph = engine(async (q) => {
    if (q.includes('CREATE (d)-[:CHECKS]')) {
      signal();
      await held;
    }
  });
  const incident = createIncident();
  let completed = 0;
  const reads = Promise.all(
    [graph.diagnostics(incident), graph.serviceImpact(incident, 'database')].map(async (read) => {
      const result = await read;
      completed++;
      return result;
    }),
  );
  await reached;
  try {
    expect(completed).toBe(0);
  } finally {
    release();
  }
  await reads;
  expect(completed).toBe(2);
});

it('propagates failed service and diagnostic queries after projection is ready', async () => {
  const incident = createIncident();
  let fail = false;
  const graph = new EvidenceGraph({
    selectGraph(name) {
      const g = db.selectGraph(name);
      const read = g.roQuery.bind(g);
      vi.spyOn(g, 'roQuery').mockImplementation(async (text, options) => {
        if (fail && !String(text).includes('MATCH (p:Projection)'))
          throw new Error('Graph read failed');
        return read(text, options);
      });
      return g;
    },
    close: async () => {},
  });
  engines.push(graph);
  await graph.read(incident);
  fail = true;
  await expect(graph.diagnostics(incident)).rejects.toThrow('Graph read failed');
  await expect(graph.serviceImpact(incident, 'database')).rejects.toThrow('Graph read failed');
});

it('keeps completed diagnostic availability isolated across incident generations', async () => {
  const graph = engine();
  const first = createIncident();
  const other = createIncident();
  other.id = 'other';
  first.completedDiagnosticIds = ['production-pool'];
  expect((await graph.diagnostics(first)).find((d) => d.id === 'production-pool')!.available).toBe(
    false,
  );
  expect((await graph.diagnostics(other)).find((d) => d.id === 'production-pool')!.available).toBe(
    true,
  );
  expect((await graph.diagnostics(first)).find((d) => d.id === 'production-pool')!.available).toBe(
    false,
  );
});
