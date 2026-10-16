import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceGraph } from '@aftermath/graph';
import { Ledger, readArtifacts } from '@aftermath/storage';
import { createCommerceIncident } from '@aftermath/fixtures';
import { makeReport } from '@aftermath/domain';
import type { Incident } from '@aftermath/contracts';
let ledger: Ledger;
let graph: EvidenceGraph;
let dir: string;
const url = process.env.STORAGE_TEST_DATABASE_URL;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aftermath-ledger-graph-'));
  ledger = await Ledger.open(url ? undefined : join(dir, 'ledger'), url);
  graph = await EvidenceGraph.open();
});
afterAll(async () => {
  await graph?.close();
  await ledger?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function create() {
  const incident = createCommerceIncident();
  incident.id = randomUUID();
  return ledger.create(incident);
}
async function prepare(incident: Incident) {
  const model = await graph.read(incident);
  return {
    evaluations: model.evaluations,
    report: makeReport(
      model.claims,
      model.evaluations,
      incident.evidenceEpoch,
      incident.reports.at(-1),
    ),
    manifest: {
      evidenceEpoch: incident.evidenceEpoch,
      reportVersion: incident.reports.at(-1)!.version,
      graphGeneration: model.view.generation,
      projectedSeq: model.view.projectedSeq,
      readArtifacts: readArtifacts(incident),
    },
  };
}
it('publishes Cypher-derived commerce findings and retains evidence/report provenance', async () => {
  const initial = await create();
  const withdrawn = await ledger.withdraw(
    initial.id,
    'E1-v1',
    'Source scope invalid',
    1,
    randomUUID(),
  );
  const proposal = await prepare(withdrawn);
  const accepted = await ledger.publish(
    initial.id,
    withdrawn.eventSeq,
    { key: randomUUID(), fingerprint: 'publish' },
    proposal,
  );
  expect(accepted.reportStatus).toBe('current');
  expect(accepted.reports[0]).toEqual(initial.reports[0]);
  expect(accepted.reports[1].statements.filter((s) => s.disposition === 'revised')).toHaveLength(6);
  expect(accepted.evaluations.find((e) => e.claimId === 'C17-v1')!.status).toBe('supported');
  expect((await graph.corrections(accepted)).corrections).toEqual(accepted.corrections);
  expect(accepted.reportManifest!.graphGeneration).toBe(proposal.manifest.graphGeneration);
  expect((await ledger.events(initial.id)).map((e) => e.seq)).toEqual([1, 2, 3]);
});
it('rejects an in-flight graph proposal after a newer correction', async () => {
  const initial = await create();
  const first = await ledger.withdraw(initial.id, 'E1-v1', 'First correction', 1, randomUUID());
  const proposal = await prepare(first);
  const latest = await ledger.withdraw(
    initial.id,
    'E3-v1',
    'Second correction',
    first.eventSeq,
    randomUUID(),
  );
  await expect(
    ledger.publish(
      initial.id,
      first.eventSeq,
      { key: randomUUID(), fingerprint: 'stale' },
      proposal,
    ),
  ).rejects.toThrow('sequence');
  await expect(
    ledger.publish(
      initial.id,
      latest.eventSeq,
      { key: randomUUID(), fingerprint: 'still-stale' },
      proposal,
    ),
  ).rejects.toThrow('Stale');
  expect((await ledger.get(initial.id)).reports).toHaveLength(1);
});
it('keeps a historical report under review when the graph is unavailable', async () => {
  const initial = await create();
  const changed = await ledger.withdraw(initial.id, 'E1-v1', 'Invalid source', 1, randomUUID());
  const unavailable = new EvidenceGraph({
    selectGraph() {
      throw new Error('Graph unavailable');
    },
    close: async () => {},
  });
  await expect(unavailable.read(changed)).rejects.toThrow('Graph unavailable');
  await unavailable.close();
  expect((await ledger.get(initial.id)).reportStatus).toBe('needs_review');
  expect((await ledger.get(initial.id)).reports).toHaveLength(1);
});
it('rebuilds correction relationships from durable SQL after both services restart', async () => {
  const initial = await create();
  const changed = await ledger.withdraw(initial.id, 'E1-v1', 'Durable correction', 1, randomUUID());
  const generation = (await graph.read(changed)).view.generation;
  await graph.close();
  await ledger.close();
  ledger = await Ledger.open(url ? undefined : join(dir, 'ledger'), url);
  graph = await EvidenceGraph.open();
  const restored = await ledger.get(initial.id);
  expect(restored).toEqual(changed);
  const corrections = await graph.corrections(restored);
  expect(corrections.generation).not.toBe(generation);
  expect(corrections.corrections).toEqual(changed.corrections);
});
