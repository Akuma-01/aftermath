import { afterAll, beforeAll, expect, it } from 'vitest';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Ledger } from '@aftermath/storage';
import { EvidenceGraph } from '@aftermath/graph';
import { InvestigationService } from '../apps/api/src/service';
import { createApp } from '../apps/api/src/app';
import { ScriptedProvider, testConfig } from './support/scripted-provider';

let ledger: Ledger;
let service: InvestigationService;
let server: Server;
let origin: string;
const provider = new ScriptedProvider();
beforeAll(async () => {
  ledger = await Ledger.open(undefined, process.env.STORAGE_TEST_DATABASE_URL);
  service = new InvestigationService(ledger, await EvidenceGraph.open(), {
    provider,
    config: testConfig,
  });
  server = createApp(service).listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  if (server?.listening) {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    await closed;
  }
  await service?.close();
});
const post = (path: string, body: unknown) =>
  fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
it('requires explicit activation, validates commands, and exposes incident-scoped model and tool audits', async () => {
  const initial = await service.create();
  const other = await service.create();
  const path = `/api/incidents/${initial.id}`;
  const snapshot = await (await fetch(origin + path)).json();
  expect(snapshot.agentAvailability.configured).toBe(true);
  expect(provider.inputs).toHaveLength(0);
  expect((await ledger.jobs.work(initial.id)).tasks).toHaveLength(0);
  const body = { expectedEventSeq: initial.eventSeq, idempotencyKey: randomUUID() };
  expect((await post(path + '/investigations', { ...body, provider: 'arbitrary' })).status).toBe(
    400,
  );
  expect((await post(path + '/investigations', { ...body, expectedEventSeq: 999 })).status).toBe(
    409,
  );
  const response = await post(path + '/investigations', body);
  expect(response.status).toBe(202);
  const activated = await response.json();
  expect(await (await post(path + '/investigations', body)).json()).toEqual(activated);
  expect(provider.inputs).toHaveLength(0);
  const work = await ledger.jobs.work(initial.id);
  expect(work.tasks).toHaveLength(1);
  expect(await service.processor.process(work.tasks[0].id)).toBe('accepted');
  const completed = await (await fetch(origin + path)).json();
  expect(completed.incident.reports.at(-1).agent.provider).toBe(testConfig.provider);
  expect(completed.work.modelCalls.length).toBeGreaterThanOrEqual(4);
  for (const [kind, calls] of [
    ['model-calls', completed.work.modelCalls],
    ['tool-calls', completed.work.toolCalls],
  ] as const) {
    const detail = await fetch(`${origin}${path}/${kind}/${calls[0].id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toHaveProperty('manifest');
    expect((await fetch(`${origin}/api/incidents/${other.id}/${kind}/${calls[0].id}`)).status).toBe(
      404,
    );
  }
  expect((await fetch(origin + path + '/model-calls/invalid')).status).toBe(400);
  const model = completed.work.modelCalls[0];
  await expect(
    ledger.jobs.recordToolCall(
      randomUUID(),
      model.id,
      model.role,
      'getEvidenceBundle',
      {},
      {},
      (await ledger.jobs.modelCallDetail(initial.id, model.id)).manifest,
      'succeeded',
    ),
  ).rejects.toThrow('Matching model call');
});
it('rejects activation when no runtime is configured', async () => {
  const plain = new InvestigationService(ledger, service.graph);
  const initial = await plain.create();
  await expect(plain.investigate(initial.id, initial.eventSeq, randomUUID())).rejects.toThrow();
  expect((await ledger.jobs.work(initial.id)).tasks).toHaveLength(0);
});
