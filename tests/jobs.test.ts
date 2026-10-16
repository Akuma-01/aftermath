import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Ledger } from '@aftermath/storage';
import { EvidenceGraph } from '@aftermath/graph';
import { repairHarness } from './support/repair';

const databases = process.env.STORAGE_TEST_DATABASE_URL ? ['PostgreSQL'] : ['PGlite'];
describe.each(databases)('durable worker protocol on %s', (database) => {
  let service: ReturnType<typeof repairHarness>;
  let ledger: Ledger;
  let dir: string;
  const url = database === 'PostgreSQL' ? process.env.STORAGE_TEST_DATABASE_URL : undefined;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aftermath-jobs-'));
    ledger = await Ledger.open(join(dir, 'ledger'), url, { retryDelayMs: 0 });
    service = repairHarness(ledger, await EvidenceGraph.open());
  });
  afterAll(async () => {
    if (service) await service.close();
    else await ledger?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  async function corrected() {
    const initial = await service.create();
    const incident = await service.withdraw(
      initial.id,
      'E1-v1',
      'Log belongs to staging',
      1,
      randomUUID(),
    );
    const task = (await service.ledger.jobs.work(incident.id)).tasks[0];
    return { incident, task };
  }
  it('commits correction, stale report and outbox atomically; retries the command without duplicate jobs', async () => {
    const initial = await service.create();
    const key = randomUUID();
    const incident = await service.withdraw(initial.id, 'E1-v1', 'Wrong environment', 1, key);
    await service.withdraw(initial.id, 'E1-v1', 'Wrong environment', 1, key);
    const work = await service.ledger.jobs.work(initial.id);
    expect(incident.reportStatus).toBe('needs_review');
    expect(work.tasks).toHaveLength(1);
    expect(
      (await service.ledger.jobs.deliveries()).filter((d) => d.taskId === work.tasks[0].id),
    ).toHaveLength(1);
    const untouched = await service.create();
    await expect(
      service.withdraw(untouched.id, 'invented', 'Invalid command', 1, randomUUID()),
    ).rejects.toThrow('not found');
    expect((await service.ledger.jobs.work(untouched.id)).tasks).toHaveLength(0);
    expect((await service.ledger.get(untouched.id)).reportStatus).toBe('current');
  });
  it('accepts one completion under concurrent and duplicate delivery', async () => {
    const { incident, task } = await corrected();
    const results = await Promise.all([
      service.processor.process(task.id),
      service.processor.process(task.id),
    ]);
    expect(results.sort()).toEqual(['accepted', 'ignored']);
    await service.processor.process(task.id);
    const current = await service.ledger.get(incident.id);
    const work = await service.ledger.jobs.work(incident.id);
    expect(current.reports).toHaveLength(2);
    expect(work.attempts.filter((a) => a.status === 'accepted')).toHaveLength(1);
    expect(work.tasks[0].attemptCount).toBe(1);
    expect(work.attempts[0].manifest?.readArtifacts.length).toBeGreaterThan(10);
  });
  it('rejects a held attempt after correction and keeps the newer accepted report current', async () => {
    const initial = await service.create();
    await service.holdReport(initial.id, 1, randomUUID());
    const preview = (await service.ledger.jobs.work(initial.id)).tasks[0];
    expect(await service.processor.process(preview.id)).toBe('paused');
    const held = (await service.ledger.jobs.work(initial.id)).attempts[0];
    let current = await service.ledger.get(initial.id);
    current = await service.withdraw(
      initial.id,
      'E1-v1',
      'Environment corrected while held',
      current.eventSeq,
      randomUUID(),
    );
    const repair = (await service.ledger.jobs.work(initial.id)).tasks.find(
      (t) => t.kind === 'repair',
    )!;
    expect(await service.processor.process(repair.id)).toBe('accepted');
    current = await service.ledger.get(initial.id);
    await service.resumeReport(initial.id, preview.id, current.eventSeq, randomUUID());
    expect(await service.processor.process(preview.id)).toBe('stale');
    current = await service.ledger.get(initial.id);
    const rejected = (await service.ledger.jobs.work(initial.id)).attempts.find(
      (a) => a.id === held.id,
    )!;
    expect(rejected.status).toBe('stale');
    expect(rejected.manifest).toEqual(held.manifest);
    expect(current.reports).toHaveLength(2);
    expect(current.reportStatus).toBe('current');
    expect(current.events!.at(-1)?.type).toBe('attempt.rejected_stale');
  });
  it('bounds retries, records every failure and permits an explicit new task afterward', async () => {
    const { incident, task } = await corrected();
    const spy = vi
      .spyOn(service.graph, 'read')
      .mockRejectedValue(new Error('Graph is unavailable'));
    for (let attempt = 0; attempt < 3; attempt++)
      expect(await service.processor.process(task.id)).toBe('failed');
    spy.mockRestore();
    let work = await service.ledger.jobs.work(incident.id);
    expect(work.tasks[0].status).toBe('failed');
    expect(work.attempts.map((a) => a.status)).toEqual(['failed', 'failed', 'failed']);
    expect(await service.processor.process(task.id)).toBe('ignored');
    const current = await service.ledger.get(incident.id);
    expect(current.reportStatus).toBe('needs_review');
    expect(current.repairError).toContain('three attempts');
    await service.repair(incident.id, current.eventSeq, randomUUID());
    work = await service.ledger.jobs.work(incident.id);
    const retry = work.tasks.find((t) => t.status === 'pending')!;
    expect(retry.id).not.toBe(task.id);
    expect(await service.processor.process(retry.id)).toBe('accepted');
    expect((await service.ledger.get(incident.id)).repairError).toBeNull();
  });
  it('rejects a held report when service topology changes', async () => {
    const initial = await service.create('commerce');
    await service.holdReport(initial.id, initial.eventSeq, randomUUID());
    const task = (await service.ledger.jobs.work(initial.id)).tasks[0];
    expect(await service.processor.process(task.id)).toBe('paused');
    let current = await service.ledger.get(initial.id);
    current = await service.ledger.mutate(
      initial.id,
      current.eventSeq,
      { key: randomUUID(), fingerprint: 'test-topology-change' },
      'test.changed',
      'Changed a dependency while the report was held',
      (state) => {
        state.topology!.dependencies.pop();
      },
    );
    await service.resumeReport(initial.id, task.id, current.eventSeq, randomUUID());
    expect(await service.processor.process(task.id)).toBe('stale');
    expect((await service.ledger.get(initial.id)).reports).toHaveLength(1);
  });
  it('recovers expired ownership after restart and fences the abandoned attempt', async () => {
    const restart = await mkdtemp(join(tmpdir(), 'aftermath-lease-'));
    let ledger = await Ledger.open(join(restart, 'ledger'), url, { leaseMs: 0, retryDelayMs: 0 });
    const graph = await EvidenceGraph.open();
    let isolated = repairHarness(ledger, graph);
    try {
      const initial = await isolated.create();
      await isolated.withdraw(initial.id, 'E1-v1', 'Source withdrawn', 1, randomUUID());
      const task = (await ledger.jobs.work(initial.id)).tasks[0];
      const abandoned = (await ledger.jobs.claim(task.id))!;
      const proposal = await isolated.processor.prepare(abandoned.incident);
      await ledger.close();
      ledger = await Ledger.open(join(restart, 'ledger'), url, { retryDelayMs: 0 });
      isolated = repairHarness(ledger, graph);
      await ledger.jobs.recoverExpired();
      expect(await isolated.processor.process(task.id)).toBe('accepted');
      expect(await ledger.jobs.finish(task.id, abandoned.attempt.id, proposal)).toBe('ignored');
      const work = await ledger.jobs.work(initial.id);
      expect(work.attempts.find((a) => a.id === abandoned.attempt.id)?.status).toBe('failed');
      expect(work.attempts.filter((a) => a.status === 'accepted')).toHaveLength(1);
      expect((await ledger.get(initial.id)).reports).toHaveLength(2);
    } finally {
      await isolated.close();
      await rm(restart, { recursive: true, force: true });
    }
  });
});

describe('publication and ownership fences', () => {
  let ledger: Ledger;
  let graph: EvidenceGraph;
  let service: ReturnType<typeof repairHarness>;
  beforeAll(async () => {
    ledger = await Ledger.open(undefined, process.env.STORAGE_TEST_DATABASE_URL, {
      retryDelayMs: 0,
    });
    graph = await EvidenceGraph.open();
    service = repairHarness(ledger, graph);
  });
  afterAll(async () => {
    await service?.close();
  });
  async function corrected() {
    const incident = await service.create();
    await service.withdraw(incident.id, 'E1-v1', 'Invalid scope', 1, randomUUID());
    return { incident, task: (await ledger.jobs.work(incident.id)).tasks[0] };
  }
  it('rejects an in-flight evaluation after a newer correction and preserves its audit', async () => {
    const { incident, task } = await corrected();
    let release!: () => void;
    let signal!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const read = graph.read.bind(graph);
    const spy = vi.spyOn(graph, 'read').mockImplementationOnce(async (i) => {
      const result = await read(i);
      signal();
      await held;
      return result;
    });
    const pending = service.processor.process(task.id);
    await reached;
    try {
      const current = await ledger.get(incident.id);
      await ledger.withdraw(incident.id, 'E2-v1', 'New correction', current.eventSeq, randomUUID());
    } finally {
      release();
    }
    expect(await pending).toBe('stale');
    spy.mockRestore();
    const current = await ledger.get(incident.id);
    expect(current.corrections).toHaveLength(2);
    expect(current.reports).toHaveLength(1);
    const next = (await ledger.jobs.work(incident.id)).tasks.find((t) => t.status === 'pending')!;
    expect(await service.processor.process(next.id)).toBe('accepted');
  });
  it('rejects incorrect generation or sequence and never publishes malformed coverage', async () => {
    const { incident, task } = await corrected();
    const claimed = (await ledger.jobs.claim(task.id))!;
    const proposal = await service.processor.prepare(claimed.incident);
    await expect(
      ledger.jobs.finish(task.id, claimed.attempt.id, {
        ...proposal,
        impact: { ...proposal.impact, graphGeneration: 'wrong' },
      }),
    ).rejects.toThrow('Invalid repair');
    await expect(
      ledger.jobs.finish(task.id, claimed.attempt.id, { ...proposal, evaluations: [] }),
    ).rejects.toThrow('Invalid repair');
    expect(
      await ledger.jobs.finish(task.id, claimed.attempt.id, {
        ...proposal,
        manifest: { ...proposal.manifest, projectedSeq: 999 },
      }),
    ).toBe('stale');
    expect((await ledger.get(incident.id)).reports).toHaveLength(1);
  });
  it('renews only the owning live attempt and makes duplicate finish idempotent', async () => {
    const { task } = await corrected();
    const claimed = (await ledger.jobs.claim(task.id))!;
    expect(await ledger.jobs.heartbeat(task.id, 'wrong-attempt')).toBe(false);
    expect(await ledger.jobs.heartbeat(task.id, claimed.attempt.id)).toBe(true);
    const proposal = await service.processor.prepare(claimed.incident);
    expect(await ledger.jobs.finish(task.id, claimed.attempt.id, proposal)).toBe('accepted');
    expect(await ledger.jobs.finish(task.id, claimed.attempt.id, proposal)).toBe('accepted');
    expect(await ledger.jobs.heartbeat(task.id, claimed.attempt.id)).toBe(false);
  });
  it('resumes an unchanged held proposal without re-evaluating the graph', async () => {
    const incident = await service.create();
    await service.holdReport(incident.id, 1, randomUUID());
    const task = (await ledger.jobs.work(incident.id)).tasks[0];
    expect(await service.processor.process(task.id)).toBe('paused');
    const current = await ledger.get(incident.id);
    await service.resumeReport(incident.id, task.id, current.eventSeq, randomUUID());
    const spy = vi
      .spyOn(graph, 'read')
      .mockRejectedValue(new Error('Must reuse original proposal'));
    try {
      expect(await service.processor.process(task.id)).toBe('accepted');
    } finally {
      spy.mockRestore();
    }
  });
  it('repairs missing scheduling on startup without duplicating outbox deliveries', async () => {
    const initial = await service.create();
    await ledger.mutate(
      initial.id,
      1,
      { key: randomUUID(), fingerprint: 'topology' },
      'topology.changed',
      'Topology updated',
      (i) => {
        i.topology!.dependencies = [];
      },
    );
    await Promise.all([ledger.jobs.backfill(), ledger.jobs.backfill()]);
    expect((await ledger.jobs.work(initial.id)).tasks).toHaveLength(1);
    const task = (await ledger.jobs.work(initial.id)).tasks[0];
    expect((await ledger.jobs.deliveries()).filter((d) => d.taskId === task.id)).toHaveLength(1);
  });
  it.runIf(Boolean(process.env.STORAGE_TEST_DATABASE_URL))(
    'claims through independent PostgreSQL connections only once',
    async () => {
      const { task } = await corrected();
      const other = await Ledger.open(undefined, process.env.STORAGE_TEST_DATABASE_URL);
      try {
        const claims = await Promise.all([ledger.jobs.claim(task.id), other.jobs.claim(task.id)]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        const owner = claims.find(Boolean)!;
        const proposal = await service.processor.prepare(owner.incident);
        const outcomes = await Promise.all([
          ledger.jobs.finish(task.id, owner.attempt.id, proposal),
          other.jobs.finish(task.id, owner.attempt.id, proposal),
        ]);
        expect(outcomes).toEqual(['accepted', 'accepted']);
        expect(
          (await ledger.jobs.work(owner.incident.id)).attempts.filter(
            (a) => a.status === 'accepted',
          ),
        ).toHaveLength(1);
      } finally {
        await other.close();
      }
    },
  );
});
