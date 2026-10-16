import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Ledger } from '@aftermath/storage';
import { EvidenceGraph } from '@aftermath/graph';
import { RepairRuntime, queueConnection } from '@aftermath/queue';
import { repairHarness } from './support/repair';

describe('real BullMQ dispatch', () => {
  let dir: string;
  let service: ReturnType<typeof repairHarness>;
  let ledger: Ledger | undefined;
  let graph: EvidenceGraph | undefined;
  let runtime: RepairRuntime;
  let redis: Awaited<ReturnType<typeof queueConnection>>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aftermath-bull-'));
    ledger = await Ledger.open(
      process.env.STORAGE_TEST_DATABASE_URL ? undefined : join(dir, 'ledger'),
      process.env.STORAGE_TEST_DATABASE_URL,
    );
    graph = await EvidenceGraph.open();
    service = repairHarness(ledger, graph);
    redis = await queueConnection();
  });
  afterAll(async () => {
    if (runtime) await runtime.close();
    await redis?.close();
    await graph?.close();
    await ledger?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(25);
    }
    throw new Error('Worker did not reach the expected durable state');
  }
  it('recovers a committed outbox after store restart, without an HTTP repair request', async () => {
    const initial = await service.create();
    await service.withdraw(initial.id, 'E1-v1', 'Corrected source environment', 1, randomUUID());
    await service.close();
    ledger = undefined;
    graph = undefined;
    ledger = await Ledger.open(
      process.env.STORAGE_TEST_DATABASE_URL ? undefined : join(dir, 'ledger'),
      process.env.STORAGE_TEST_DATABASE_URL,
    );
    graph = await EvidenceGraph.open();
    service = repairHarness(ledger, graph);
    runtime = new RepairRuntime(
      service.ledger,
      service.processor,
      redis.connection,
      `test-${randomUUID()}`,
    );
    await runtime.start();
    await until(async () => (await service.ledger.get(initial.id)).reportStatus === 'current');
    expect((await service.ledger.get(initial.id)).reports).toHaveLength(2);
    expect((await service.ledger.jobs.work(initial.id)).attempts[0].status).toBe('accepted');
  });
  it('replays SQL deliveries into a fresh empty Redis queue after delivery acknowledgement', async () => {
    await runtime.close();
    const initial = await service.create();
    await service.withdraw(initial.id, 'E3-v1', 'Trace withdrawn', 1, randomUUID());
    const task = (await service.ledger.jobs.work(initial.id)).tasks[0];
    const delivery = (await service.ledger.jobs.deliveries()).find((d) => d.taskId === task.id)!;
    // Simulates dispatcher acknowledgement followed by loss of Redis, with SQL retained.
    await service.ledger.jobs.delivered(delivery.id);
    await redis.close();
    redis = await queueConnection();
    runtime = new RepairRuntime(
      service.ledger,
      service.processor,
      redis.connection,
      `test-${randomUUID()}`,
    );
    await runtime.start();
    await until(async () => (await service.ledger.get(initial.id)).reportStatus === 'current');
    expect((await service.ledger.get(initial.id)).lastImpact?.preservedClaimIds.sort()).toEqual([
      'C4-v1',
      'C5-v1',
    ]);
    expect(
      (await service.ledger.jobs.work(initial.id)).attempts.filter((a) => a.status === 'accepted'),
    ).toHaveLength(1);
  });
  it('retries a graph failure through BullMQ without publishing the failed attempt', async () => {
    const initial = await service.create();
    const read = service.graph.read.bind(service.graph);
    let failed = false;
    const spy = vi.spyOn(service.graph, 'read').mockImplementation(async (incident) => {
      if (incident.id === initial.id && !failed) {
        failed = true;
        throw new Error('Temporary graph outage');
      }
      return read(incident);
    });
    try {
      await service.withdraw(initial.id, 'E1-v1', 'Retry correction', 1, randomUUID());
      await until(async () => (await service.ledger.get(initial.id)).reportStatus === 'current');
      const work = await service.ledger.jobs.work(initial.id);
      expect(work.attempts.map((a) => a.status)).toEqual(['failed', 'accepted']);
      expect((await service.ledger.get(initial.id)).reports).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });
});

it('validates remote Redis URLs and preserves TLS, credentials and database selection', async () => {
  const remote = await queueConnection('rediss://worker:secret%20value@localhost:6381/2');
  expect(remote.connection).toMatchObject({
    host: 'localhost',
    port: 6381,
    username: 'worker',
    password: 'secret value',
    db: 2,
    tls: {},
  });
  await remote.close();
  await expect(queueConnection('http://localhost')).rejects.toThrow('redis://');
  await expect(queueConnection('redis://localhost/not-a-number')).rejects.toThrow('database');
});
