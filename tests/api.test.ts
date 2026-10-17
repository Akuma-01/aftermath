import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Ledger } from '@aftermath/storage';
import { EvidenceGraph } from '@aftermath/graph';
import type { Incident } from '@aftermath/contracts';
import { InvestigationService } from '../apps/api/src/service';
import { createApp } from '../apps/api/src/app';

let ledger: Ledger;
let graph: EvidenceGraph;
let service: InvestigationService;
let server: Server;
let origin: string;
beforeAll(async () => {
  ledger = await Ledger.open(undefined, process.env.STORAGE_TEST_DATABASE_URL, { retryDelayMs: 0 });
  graph = await EvidenceGraph.open();
  service = new InvestigationService(ledger, graph);
  server = createApp(service).listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  if (server?.listening) {
    const done = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    await done;
  }
  if (service) await service.close();
  else await ledger?.close();
});
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const command = (seq: number, key = randomUUID()) => ({
  expectedEventSeq: seq,
  idempotencyKey: key,
});
async function create(scenario = 'checkout'): Promise<Incident> {
  const response = await post('/api/incidents', { scenario });
  expect(response.status).toBe(201);
  return response.json();
}
async function repair(id: string) {
  const task = (await ledger.jobs.work(id)).tasks.find(
    (t) => t.kind === 'repair' && t.status === 'pending',
  )!;
  expect(await service.processor.process(task.id)).toBe('accepted');
  return ledger.get(id);
}

it('creates unique incidents and retrieves durable evidence, claims, graph and report views', async () => {
  const first = await create();
  const second = await create('commerce');
  expect(first.id).not.toBe(second.id);
  const listing = await (await fetch(origin + '/api/incidents')).json();
  expect(listing).toEqual(
    expect.arrayContaining([{ id: first.id, title: first.title, eventSeq: 1 }]),
  );
  for (const path of [
    '',
    '/evidence',
    '/evidence/E1-v1',
    '/claims',
    '/claims/C2-v1',
    '/support',
    '/graph',
    '/reports',
    '/repairs',
    '/diagnostics',
    '/events',
    '/service-impact/database',
    '/topology',
  ]) {
    const response = await fetch(`${origin}/api/incidents/${first.id}${path}`);
    expect(response.status, path).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  const snapshot = await (await fetch(`${origin}/api/incidents/${first.id}`)).json();
  expect(snapshot.graph.projectedSeq).toBe(snapshot.incident.eventSeq);
  expect(
    snapshot.diagnostics.every(
      (d: { graphGeneration: string }) => d.graphGeneration === snapshot.graph.generation,
    ),
  ).toBe(true);
  expect(snapshot.graphError).toBeNull();
  const claim = await (await fetch(`${origin}/api/incidents/${first.id}/claims/C2-v1`)).json();
  expect(claim.evaluation.status).toBe('supported');
  expect(claim.claim.supportGroups[0].memberIds).toEqual(['E1-v1']);
  const blast = await (
    await fetch(`${origin}/api/incidents/${second.id}/service-impact/database`)
  ).json();
  expect(blast.result.centrality).toHaveLength(24);
});

it('validates commands, bodies, identifiers, origins and missing resources', async () => {
  const incident = await create();
  const path = `/api/incidents/${incident.id}/evidence/E1-v1/withdrawals`;
  expect((await post(path, {})).status).toBe(400);
  expect(
    (await post(path, { ...command(1), reason: 'Correct source', cypher: 'anything' })).status,
  ).toBe(400);
  expect(
    (
      await post(
        path,
        { ...command(1), reason: 'Correct source' },
        { origin: 'https://untrusted.example' },
      )
    ).status,
  ).toBe(403);
  expect((await post(path, { ...command(9), reason: 'Correct source' })).status).toBe(409);
  expect((await post('/api/incidents', { scenario: 'other' })).status).toBe(400);
  expect((await post('/api/incidents', { extra: true })).status).toBe(400);
  const malformed = await fetch(origin + '/api/incidents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toHaveProperty('code', 'INVALID_REQUEST');
  expect(
    (await post('/api/incidents', { scenario: 'checkout', oversized: 'x'.repeat(40000) })).status,
  ).toBe(413);
  expect((await fetch(origin + '/api/incidents/not-a-uuid')).status).toBe(400);
  expect((await fetch(origin + `/api/incidents/${randomUUID()}`)).status).toBe(404);
  expect((await fetch(origin + `/api/incidents/${incident.id}/claims/missing`)).status).toBe(404);
  expect(
    (await fetch(origin + `/api/incidents/${incident.id}/service-impact/missing`)).status,
  ).toBe(404);
  expect((await fetch(origin + `/api/incidents/${incident.id}/events?after=-1`)).status).toBe(400);
  expect((await fetch(origin + '/api/unknown')).status).toBe(404);
  expect((await ledger.get(incident.id)).eventSeq).toBe(1);
});

it('withdraws idempotently, preserves alternative support, and publishes report history', async () => {
  const incident = await create();
  const path = `/api/incidents/${incident.id}/evidence/E3-v1/withdrawals`;
  const body = { ...command(1), reason: 'Invalid trace sample' };
  const changed = await (await post(path, body, { origin: 'http://localhost:5173' })).json();
  expect(changed.reportStatus).toBe('needs_review');
  expect(changed.eventSeq).toBe(2);
  expect(await (await post(path, body)).json()).toEqual(changed);
  expect((await post(path, { ...body, reason: 'Different reason' })).status).toBe(409);
  const analysis = await (await fetch(origin + `/api/incidents/${incident.id}/support`)).json();
  expect(
    analysis.result.evaluations.find((e: { claimId: string }) => e.claimId === 'C4-v1'),
  ).toMatchObject({ status: 'supported', validGroupIds: ['C4-G2'] });
  const accepted = await repair(incident.id);
  expect(accepted.reports[1].statements.every((s) => s.disposition === 'preserved')).toBe(true);
  const reports = await (await fetch(origin + `/api/incidents/${incident.id}/reports`)).json();
  expect(reports.reports).toHaveLength(2);
  expect(
    (await post(`/api/incidents/${incident.id}/repairs`, command(accepted.eventSeq))).status,
  ).toBe(409);
  const events = await (
    await fetch(origin + `/api/incidents/${incident.id}/events?after=1`)
  ).json();
  expect(events.events[0].type).toBe('evidence.withdrawn');
});

it('records registered diagnostics only when requested and rejects unavailable prerequisites', async () => {
  const incident = await create();
  expect(incident.evidence.some((e) => e.id === 'E7-v1')).toBe(false);
  const path = `/api/incidents/${incident.id}/diagnostics/production-pool`;
  const cmd = command(1);
  const changed = await (await post(path, cmd)).json();
  expect(changed.evidence.some((e: { id: string }) => e.id === 'E7-v1')).toBe(true);
  expect(await (await post(path, cmd)).json()).toEqual(changed);
  expect((await post(path, command(changed.eventSeq))).status).toBe(409);
  const accepted = await repair(incident.id);
  expect(accepted.evaluations.find((e) => e.claimId === 'C2-v1')!.status).toBe('contested');
  expect(
    (await post(`/api/incidents/${incident.id}/diagnostics/unknown`, command(accepted.eventSeq)))
      .status,
  ).toBe(400);
  const second = await create();
  const withdrawn = await service.withdraw(
    second.id,
    'E6-v1',
    'Missing prerequisite',
    1,
    randomUUID(),
  );
  expect(
    (
      await post(
        `/api/incidents/${second.id}/diagnostics/payment-timeouts`,
        command(withdrawn.eventSeq),
      )
    ).status,
  ).toBe(409);
});

it('retrieves correction memory and supports held report controls', async () => {
  const incident = await create();
  const withdrawn = await service.withdraw(incident.id, 'E1-v1', 'Wrong scope', 1, randomUUID());
  const sessionResponse = await post(
    `/api/incidents/${incident.id}/sessions`,
    command(withdrawn.eventSeq),
  );
  expect(sessionResponse.status).toBe(201);
  const current = await sessionResponse.json();
  expect(current.sessions[0].rejectedSourceIds).toEqual(['E1-v1']);
  const held = await post(`/api/incidents/${incident.id}/held-reports`, command(current.eventSeq));
  expect(held.status).toBe(202);
  const preview = (await ledger.jobs.work(incident.id)).tasks.find(
    (t) => t.kind === 'report_preview',
  )!;
  expect(await service.processor.process(preview.id)).toBe('paused');
  const paused = await ledger.get(incident.id);
  expect(
    (
      await post(
        `/api/incidents/${incident.id}/repairs/${preview.id}/resume`,
        command(paused.eventSeq),
      )
    ).status,
  ).toBe(202);
  expect(await service.processor.process(preview.id)).toBe('accepted');
});

it('exposes graph failure without replacing graph results with ledger evaluations', async () => {
  const incident = await create();
  await service.withdraw(incident.id, 'E1-v1', 'Invalid scope', 1, randomUUID());
  const spy = vi.spyOn(graph, 'read').mockRejectedValue(new Error('Graph unavailable'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const snapshot = await (await fetch(origin + `/api/incidents/${incident.id}`)).json();
    expect(snapshot.graph).toBeNull();
    expect(snapshot.graphError).toContain('unavailable');
    expect(snapshot.incident.reportStatus).toBe('needs_review');
    expect((await fetch(origin + `/api/incidents/${incident.id}/support`)).status).toBe(503);
    expect((await fetch(origin + '/api/health')).status).toBe(503);
    expect((await fetch(origin + `/api/incidents/${incident.id}/evidence`)).status).toBe(200);
  } finally {
    spy.mockRestore();
    log.mockRestore();
  }
});

it('retries snapshots and support analysis after concurrent corrections, with a three-read limit', async () => {
  const incident = await create();
  const original = graph.read.bind(graph);
  const once = vi.spyOn(graph, 'read').mockImplementationOnce(async (i) => {
    const model = await original(i);
    await service.withdraw(i.id, 'E1-v1', 'Concurrent correction', i.eventSeq, randomUUID());
    return model;
  });
  try {
    const snapshot = await service.snapshot(incident.id);
    expect(snapshot.incident.eventSeq).toBe(2);
    expect(snapshot.graph!.projectedSeq).toBe(2);
  } finally {
    once.mockRestore();
  }
  let calls = 0;
  const churn = vi.spyOn(graph, 'read').mockImplementation(async (i) => {
    calls++;
    const model = await original(i);
    await ledger.mutate(
      i.id,
      i.eventSeq,
      { key: randomUUID(), fingerprint: 'churn' },
      'test.changed',
      'Concurrent title update',
      (state) => {
        state.title += '!';
      },
    );
    return model;
  });
  try {
    await expect(service.graphAnalysis(incident.id, 'support')).rejects.toThrow('changed');
    expect(calls).toBe(3);
  } finally {
    churn.mockRestore();
  }
});

it('serves real read-only MCP tools and preserves the transport behavior', async () => {
  const incident = await create('commerce');
  const before = await ledger.get(incident.id);
  const call = (body: unknown, headers: Record<string, string> = {}) =>
    post('/api/mcp', body, {
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      ...headers,
    });
  for (const [name, args] of [
    ['list_incidents', {}],
    ['inspect_support', { incidentId: incident.id }],
    ['rank_diagnostics', { incidentId: incident.id }],
    ['service_blast_radius', { incidentId: incident.id, serviceId: 'database' }],
  ] as const) {
    const response = await call({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.result.isError).toBeUndefined();
    expect(data.result).toHaveProperty('structuredContent');
  }
  expect(await ledger.get(incident.id)).toEqual(before);
  expect(
    (
      await call(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { origin: 'https://foreign.example' },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { 'MCP-Protocol-Version': 'unsupported' },
      )
    ).status,
  ).toBe(400);
  expect(
    (await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { accept: 'application/json' }))
      .status,
  ).toBe(406);
  const notice = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
  expect(notice.status).toBe(202);
  expect(await notice.text()).toBe('');
  for (const method of ['GET', 'DELETE']) {
    const response = await fetch(origin + '/api/mcp', { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  }
  const batch = await call([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  expect((await batch.json()).error.code).toBe(-32600);
  const raw = await call({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'withdraw_evidence', arguments: { incidentId: incident.id } },
  });
  expect((await raw.json()).error.code).toBe(-32602);
  const malformed = await fetch(origin + '/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  expect((await malformed.json()).error.code).toBe(-32700);
  const spy = vi.spyOn(graph, 'diagnostics').mockRejectedValueOnce(new Error('Graph unavailable'));
  try {
    const failure = await call({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'rank_diagnostics', arguments: { incidentId: incident.id } },
    });
    expect((await failure.json()).result.isError).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

it('previews withdrawal through FalkorDB without changing SQL state, work or events', async () => {
  const incident = await create();
  const work = await ledger.jobs.work(incident.id);
  const events = await ledger.events(incident.id);
  const response = await post(`/api/incidents/${incident.id}/evidence/E1-v1/withdrawal-preview`, {
    expectedEventSeq: incident.eventSeq,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const preview = await response.json();
  expect(preview).toMatchObject({
    readOnly: true,
    evidenceId: 'E1-v1',
    snapshot: { incidentId: incident.id, eventSeq: 1 },
    affectedClaimIds: ['C2-v1', 'C3-v1'],
  });
  expect(preview.claims.find((c: { claimId: string }) => c.claimId === 'C2-v1').after.status).toBe(
    'unsupported',
  );
  expect(await ledger.get(incident.id)).toEqual(incident);
  expect(await ledger.jobs.work(incident.id)).toEqual(work);
  expect(await ledger.events(incident.id)).toEqual(events);
});

it('validates preview requests, targets and local origins', async () => {
  const incident = await create();
  const path = `/api/incidents/${incident.id}/evidence/E1-v1/withdrawal-preview`;
  for (const body of [
    {},
    { expectedEventSeq: 0 },
    { expectedEventSeq: '1' },
    { expectedEventSeq: 1, cypher: 'MATCH (n) RETURN n' },
  ])
    expect((await post(path, body)).status).toBe(400);
  expect(
    (await post(path, { expectedEventSeq: 1 }, { origin: 'https://untrusted.invalid' })).status,
  ).toBe(403);
  expect((await post(path, { expectedEventSeq: 2 })).status).toBe(409);
  expect((await post(path.replace('E1-v1', 'unknown'), { expectedEventSeq: 1 })).status).toBe(404);
  expect(
    (await post(path.replace(incident.id, randomUUID()), { expectedEventSeq: 1 })).status,
  ).toBe(404);
  const current = await service.withdraw(
    incident.id,
    'E1-v1',
    'Wrong environment',
    1,
    randomUUID(),
  );
  expect((await post(path, { expectedEventSeq: current.eventSeq })).status).toBe(409);
});

it('rejects a preview if SQL changes during graph calculation', async () => {
  const incident = await create();
  const original = graph.previewWithdrawal.bind(graph);
  const spy = vi
    .spyOn(graph, 'previewWithdrawal')
    .mockImplementationOnce(async (snapshot, evidenceId) => {
      const preview = await original(snapshot, evidenceId);
      await service.freshSession(incident.id, incident.eventSeq, randomUUID());
      return preview;
    });
  try {
    const response = await post(`/api/incidents/${incident.id}/evidence/E1-v1/withdrawal-preview`, {
      expectedEventSeq: 1,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('CONFLICT');
    expect((await ledger.get(incident.id)).corrections).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

it('returns a structured unavailable response when preview graph evaluation fails', async () => {
  const incident = await create();
  const spy = vi
    .spyOn(graph, 'previewWithdrawal')
    .mockRejectedValueOnce(new Error('Test graph unavailable'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await post(`/api/incidents/${incident.id}/evidence/E1-v1/withdrawal-preview`, {
      expectedEventSeq: 1,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(await ledger.get(incident.id)).toEqual(incident);
  } finally {
    spy.mockRestore();
    log.mockRestore();
  }
});

it('confirms a matching preview atomically and replays the identical command without another correction', async () => {
  const incident = await create();
  const path = `/api/incidents/${incident.id}/evidence/E3-v1`;
  const preview = await (await post(path + '/withdrawal-preview', { expectedEventSeq: 1 })).json();
  const body = {
    ...command(1),
    reason: 'Wrong source observation',
    preview: { snapshot: preview.snapshot, evidenceId: preview.evidenceId },
  };
  const response = await post(path + '/withdrawals', body);
  expect(response.status).toBe(200);
  const withdrawn = await response.json();
  expect(withdrawn.corrections).toHaveLength(1);
  await repair(incident.id);
  const replay = await post(path + '/withdrawals', body);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(withdrawn);
  expect((await ledger.get(incident.id)).corrections).toHaveLength(1);
  expect((await ledger.jobs.work(incident.id)).tasks).toHaveLength(1);
  expect(
    (
      await post(path + '/withdrawals', {
        ...body,
        preview: {
          ...body.preview,
          snapshot: { ...body.preview.snapshot, fingerprint: '0'.repeat(64) },
        },
      })
    ).status,
  ).toBe(409);
  expect((await post(path + '/withdrawals', { ...body, preview: undefined })).status).toBe(409);
});

it('rejects mismatched preview guards without durable side effects', async () => {
  const incident = await create();
  const preview = await service.previewWithdrawal(incident.id, 'E1-v1', 1);
  const path = `/api/incidents/${incident.id}/evidence/E1-v1/withdrawals`;
  const guard = { snapshot: preview.snapshot, evidenceId: preview.evidenceId };
  for (const invalid of [
    { ...guard, evidenceId: 'E2-v1' },
    { ...guard, snapshot: { ...guard.snapshot, incidentId: randomUUID() } },
    { ...guard, snapshot: { ...guard.snapshot, eventSeq: 2 } },
    { ...guard, snapshot: { ...guard.snapshot, evidenceEpoch: 2 } },
    { ...guard, snapshot: { ...guard.snapshot, reportVersion: 2 } },
    { ...guard, snapshot: { ...guard.snapshot, fingerprint: '0'.repeat(64) } },
  ])
    expect(
      (await post(path, { ...command(1), reason: 'Wrong environment', preview: invalid })).status,
    ).toBe(409);
  expect(
    (await post(path, { ...command(1), reason: 'Wrong environment', preview: {} })).status,
  ).toBe(400);
  expect(await ledger.get(incident.id)).toEqual(incident);
  expect((await ledger.jobs.work(incident.id)).tasks).toEqual([]);
  expect(await ledger.events(incident.id)).toHaveLength(1);
});

it('rejects a confirmation after an intervening command, even when the client supplies the new sequence', async () => {
  const incident = await create();
  const preview = await service.previewWithdrawal(incident.id, 'E1-v1', 1);
  const current = await service.freshSession(incident.id, 1, randomUUID());
  const response = await post(`/api/incidents/${incident.id}/evidence/E1-v1/withdrawals`, {
    ...command(current.eventSeq),
    reason: 'Wrong environment',
    preview: { snapshot: preview.snapshot, evidenceId: preview.evidenceId },
  });
  expect(response.status).toBe(409);
  expect(await ledger.get(incident.id)).toEqual(current);
  expect((await ledger.jobs.work(incident.id)).tasks).toEqual([]);
});

it.each([true, false])(
  'serializes concurrent preview confirmations (same key: %s)',
  async (sameKey) => {
    const incident = await create();
    const preview = await service.previewWithdrawal(incident.id, 'E1-v1', 1);
    const body = {
      ...command(1),
      reason: 'Concurrent withdrawal safety check',
      preview: { snapshot: preview.snapshot, evidenceId: preview.evidenceId },
    };
    const path = `/api/incidents/${incident.id}/evidence/E1-v1/withdrawals`;
    const responses = await Promise.all([
      post(path, body),
      post(path, { ...body, idempotencyKey: sameKey ? body.idempotencyKey : randomUUID() }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual(sameKey ? [200, 200] : [200, 409]);
    const current = await ledger.get(incident.id);
    expect(current.corrections).toHaveLength(1);
    expect(
      (await ledger.events(incident.id)).filter((e) => e.type === 'evidence.withdrawn'),
    ).toHaveLength(1);
    const tasks = (await ledger.jobs.work(incident.id)).tasks;
    expect(tasks).toHaveLength(1);
    expect((await ledger.jobs.deliveries()).filter((d) => d.taskId === tasks[0].id)).toHaveLength(
      1,
    );
  },
);

it('rejects an old fingerprint even if a client rewrites its sequence to the current value', async () => {
  const incident = await create();
  const preview = await service.previewWithdrawal(incident.id, 'E1-v1', 1);
  const current = await service.freshSession(incident.id, 1, randomUUID());
  const response = await post(`/api/incidents/${incident.id}/evidence/E1-v1/withdrawals`, {
    ...command(current.eventSeq),
    reason: 'Fingerprint must still match',
    preview: {
      snapshot: { ...preview.snapshot, eventSeq: current.eventSeq },
      evidenceId: preview.evidenceId,
    },
  });
  expect(response.status).toBe(409);
  expect(await ledger.get(incident.id)).toEqual(current);
});

it.skipIf(!process.env.STORAGE_TEST_DATABASE_URL)(
  'rejects a preview invalidated by an independent PostgreSQL client',
  async () => {
    const incident = await create();
    const preview = await service.previewWithdrawal(incident.id, 'E1-v1', 1);
    const peer = await Ledger.open(undefined, process.env.STORAGE_TEST_DATABASE_URL);
    try {
      await peer.withdraw(incident.id, 'E3-v1', 'Independent client correction', 1, randomUUID());
      const response = await post(`/api/incidents/${incident.id}/evidence/E1-v1/withdrawals`, {
        ...command(1),
        reason: 'Obsolete preview confirmation',
        preview: { snapshot: preview.snapshot, evidenceId: preview.evidenceId },
      });
      expect(response.status).toBe(409);
      const current = await ledger.get(incident.id);
      expect(current.corrections.map((c) => c.targetId)).toEqual(['E3-v1']);
      expect(current.evidence.find((e) => e.id === 'E1-v1')?.status).toBe('active');
    } finally {
      await peer.close();
    }
  },
);
