import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { FalkorDB } from 'falkordblite';
import { EvidenceGraph, withdrawalSnapshotFingerprint } from '@aftermath/graph';
import { createIncident, createCommerceIncident } from '@aftermath/fixtures';
import { evaluateSupport } from '@aftermath/domain';
import { withdrawalPreviewSchema } from '@aftermath/contracts';
import type { Graph } from 'falkordb';

let db: FalkorDB;
let engine: EvidenceGraph;
const created: string[] = [];
const deleted: string[] = [];
beforeAll(async () => {
  db = await FalkorDB.open({ timeout: 20000, logLevel: 'warning' });
  engine = new EvidenceGraph({
    selectGraph(name) {
      const graph = db.selectGraph(name);
      created.push(name);
      const remove = graph.delete.bind(graph);
      vi.spyOn(graph, 'delete').mockImplementation(async () => {
        deleted.push(name);
        return remove();
      });
      return graph;
    },
    close: async () => {},
  });
});
afterAll(async () => {
  await engine?.close();
  await db?.close();
});

it('previews transitive withdrawal using graph evaluation without changing the snapshot or live generation', async () => {
  const incident = createIncident();
  const original = structuredClone(incident);
  const live = await engine.read(incident);
  const start = created.length;
  const preview = await engine.previewWithdrawal(incident, 'E1-v1');
  expect(withdrawalPreviewSchema.safeParse(preview).success).toBe(true);
  expect(preview.affectedClaimIds).toEqual(['C2-v1', 'C3-v1']);
  expect(preview.paths).toContainEqual(['E1-v1', 'C2-v1', 'C3-v1']);
  expect(preview.claims.find((c) => c.claimId === 'C2-v1')).toMatchObject({
    change: 'changed',
    before: { status: 'supported' },
    after: { status: 'unsupported' },
  });
  expect(preview.conclusions.find((c) => c.claimId === 'C3-v1')).toMatchObject({
    change: 'changed',
    requiresReview: true,
  });
  expect(preview.services.find((s) => s.serviceId === 'database')?.dependencyPaths).toEqual(
    expect.arrayContaining([expect.objectContaining({ serviceId: 'checkout' })]),
  );
  expect(incident).toEqual(original);
  expect(await engine.read(incident)).toEqual(live);
  for (const generation of created.slice(start)) expect(deleted).toContain(generation);
  expect(deleted).not.toContain(live.view.generation);
});

it('preserves alternative conclusions while flagging withdrawn citations and changed groups', async () => {
  const incident = createIncident();
  incident.reports[0].statements.find((s) => s.claimId === 'C4-v1')!.citationIds = ['E3-v1'];
  const preview = await engine.previewWithdrawal(incident, 'E3-v1');
  expect(preview.claims.find((c) => c.claimId === 'C4-v1')).toMatchObject({
    after: { status: 'supported', validGroupIds: ['C4-G2'] },
  });
  expect(preview.conclusions.find((s) => s.claimId === 'C4-v1')).toMatchObject({
    afterStatus: 'supported',
    affectedCitationIds: ['E3-v1'],
    requiresReview: true,
  });
  expect(preview.conclusions.find((s) => s.claimId === 'C5-v1')).toMatchObject({
    change: 'unchanged',
    requiresReview: false,
  });
});

it('shows contested findings and restored support when opposition is withdrawn', async () => {
  const incident = createIncident();
  incident.claims
    .find((c) => c.id === 'C2-v1')!
    .oppositionGroups.push({ id: 'opp', ruleId: 'test', memberIds: ['E5-v1'] });
  const preview = await engine.previewWithdrawal(incident, 'E5-v1');
  const claim = preview.claims.find((c) => c.claimId === 'C2-v1')!;
  expect(claim.before.status).toBe('contested');
  expect(claim.after.status).toBe('supported');
  expect(claim.groups.find((g) => g.groupId === 'opp')).toMatchObject({
    polarity: 'opposition',
    before: { valid: true },
    after: { valid: false },
  });
  expect(preview.claims.find((c) => c.claimId === 'C3-v1')?.after.status).toBe('supported');
});

it.each([createIncident, createCommerceIncident])(
  'agrees with the independent oracle for every active fixture source',
  async (fixture) => {
    const incident = fixture();
    for (const source of incident.evidence.filter((e) => e.status === 'active')) {
      const preview = await engine.previewWithdrawal(incident, source.id);
      const copy = structuredClone(incident);
      copy.evidence.find((e) => e.id === source.id)!.status = 'withdrawn';
      const expected = evaluateSupport(copy.evidence, copy.claims);
      for (const c of preview.claims)
        expect(c.after).toEqual({
          status: expected.find((e) => e.claimId === c.claimId)!.status,
          validGroupIds: expected.find((e) => e.claimId === c.claimId)!.validGroupIds.sort(),
          originGroupIds: expected.find((e) => e.claimId === c.claimId)!.originGroupIds.sort(),
        });
    }
  },
);

it('isolates simultaneous previews and captures inputs before caller mutation', async () => {
  const incident = createIncident();
  const fingerprint = withdrawalSnapshotFingerprint(incident);
  const first = engine.previewWithdrawal(incident, 'E1-v1');
  incident.eventSeq++;
  incident.evidence[0].scope.environment = 'staging';
  const second = engine.previewWithdrawal(incident, 'E3-v1');
  const [a, b] = await Promise.all([first, second]);
  expect(a.snapshot.fingerprint).toBe(fingerprint);
  expect(a.snapshot.eventSeq).toBe(1);
  expect(b.snapshot.eventSeq).toBe(2);
  expect(b.snapshot.fingerprint).not.toBe(fingerprint);
  expect(a.claims.find((c) => c.claimId === 'C2-v1')!.before.status).toBe('supported');
  expect(b.claims.find((c) => c.claimId === 'C2-v1')!.before.status).toBe('unsupported');
  expect(await engine.previewWithdrawal(incident, 'E3-v1')).toEqual(b);
});

it.each([1, 2])(
  'rejects invalid targets and cleans failed projection %i without substituting results',
  async (failedProjection) => {
    const incident = createIncident();
    await expect(engine.previewWithdrawal(incident, 'unknown')).rejects.toThrow('Unknown evidence');
    incident.evidence[0].status = 'withdrawn';
    await expect(engine.previewWithdrawal(incident, 'E1-v1')).rejects.toThrow('Only active');
    let fail = true;
    const names: string[] = [];
    const removed: string[] = [];
    const failing = new EvidenceGraph({
      selectGraph(name) {
        names.push(name);
        const graph = db.selectGraph(name);
        const query = graph.query.bind(graph);
        vi.spyOn(graph, 'query').mockImplementation(async (...args) => {
          if (
            fail &&
            names.length === failedProjection &&
            String(args[0]).includes('SET g.reasons')
          )
            throw new Error('Preview evaluation unavailable');
          return query(...args);
        });
        const remove = graph.delete.bind(graph);
        vi.spyOn(graph, 'delete').mockImplementation(async () => {
          removed.push(name);
          return remove();
        });
        return graph;
      },
      close: async () => {},
    });
    try {
      await expect(failing.previewWithdrawal(createIncident(), 'E1-v1')).rejects.toThrow(
        'Preview evaluation unavailable',
      );
      for (const name of names) expect(removed).toContain(name);
      fail = false;
      expect(
        (await failing.previewWithdrawal(createIncident(), 'E1-v1')).affectedClaimIds,
      ).toContain('C2-v1');
    } finally {
      await failing.close();
    }
  },
);

it('derives impact and support from Cypher relationships, not fixture membership arrays', async () => {
  const modified = new EvidenceGraph({
    selectGraph(name) {
      const graph = db.selectGraph(name);
      const query = graph.query.bind(graph);
      vi.spyOn(graph, 'query').mockImplementation(async (...args: Parameters<Graph['query']>) => {
        if (String(args[0]).includes('SET g.reasons')) {
          await query(
            "MATCH (c:ClaimVersion {id:'C2-v1'})-[r:DERIVED_FROM]->(:EvidenceVersion {id:'E1-v1'}) DELETE r",
          );
          await query(
            "MATCH (:SupportGroup {id:'C2-G1'})-[r:REQUIRES]->(:EvidenceVersion {id:'E1-v1'}) DELETE r",
          );
          await query(
            "MATCH (g:SupportGroup {id:'C2-G1'}), (e:EvidenceVersion {id:'E2-v1'}), (c:ClaimVersion {id:'C2-v1'}) MERGE (g)-[:REQUIRES {position:0}]->(e) MERGE (c)-[:DERIVED_FROM]->(e)",
          );
        }
        return query(...args);
      });
      return graph;
    },
    close: async () => {},
  });
  try {
    const preview = await modified.previewWithdrawal(createIncident(), 'E1-v1');
    expect(preview.affectedClaimIds).toEqual([]);
    expect(preview.claims.find((c) => c.claimId === 'C2-v1')!.after.status).toBe('supported');
  } finally {
    await modified.close();
  }
});

it('fingerprints report and evidence changes even at the same sequence and validates advisory-only output', async () => {
  const incident = createIncident();
  const preview = await engine.previewWithdrawal(incident, 'E1-v1');
  expect(withdrawalPreviewSchema.safeParse({ ...preview, readOnly: false }).success).toBe(false);
  expect(withdrawalPreviewSchema.safeParse({ ...preview, publish: true }).success).toBe(false);
  const copy = structuredClone(incident);
  copy.reports[0].statements[0].text += ' changed';
  expect(withdrawalSnapshotFingerprint(copy)).not.toBe(preview.snapshot.fingerprint);
  incident.evidence[0].scope.environment = 'staging';
  const next = await engine.previewWithdrawal(incident, 'E1-v1');
  expect(next.snapshot.eventSeq).toBe(preview.snapshot.eventSeq);
  expect(next.snapshot.fingerprint).not.toBe(preview.snapshot.fingerprint);
  expect(next.claims.find((c) => c.claimId === 'C2-v1')).toMatchObject({
    before: { status: 'unsupported' },
    after: { status: 'unsupported' },
  });
});
