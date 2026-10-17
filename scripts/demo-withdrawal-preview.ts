import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Incident, Snapshot, WithdrawalPreview } from '@aftermath/contracts';
import { startApi } from '../apps/api/src/runtime';

// An isolated demo: no .env loading, inherited service URLs or provider credentials.
const directory = await mkdtemp(join(tmpdir(), 'aftermath-preview-demo-'));
let api: Awaited<ReturnType<typeof startApi>> | undefined;
try {
  api = await startApi({ HOST: '127.0.0.1', PORT: '0', DATA_DIR: directory });
  async function request(path: string, body?: unknown, expected = 200) {
    const response = await fetch(api!.url + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  }
  const incident: Incident = await request('/incidents', { scenario: 'checkout' }, 201);
  const path = `/incidents/${incident.id}`;
  const initial: Snapshot = await request(path);
  const preview: WithdrawalPreview = await request(path + '/evidence/E1-v1/withdrawal-preview', {
    expectedEventSeq: incident.eventSeq,
  });
  assert.deepEqual(preview.affectedClaimIds, ['C2-v1', 'C3-v1']);
  assert.equal(preview.claims.find((c) => c.claimId === 'C2-v1')?.after.status, 'unsupported');
  const alternative: WithdrawalPreview = await request(
    path + '/evidence/E3-v1/withdrawal-preview',
    { expectedEventSeq: incident.eventSeq },
  );
  assert.equal(alternative.claims.find((c) => c.claimId === 'C4-v1')?.after.status, 'supported');
  assert.equal(alternative.conclusions.find((c) => c.claimId === 'C5-v1')?.requiresReview, false);
  const afterPreviews: Snapshot = await request(path);
  assert.deepEqual(afterPreviews.incident, initial.incident);
  assert.deepEqual(afterPreviews.work, initial.work);
  console.log(
    'PASS: previews changed no durable state; E1 affects C2/C3; E3 retains alternative support.',
  );

  const advanced: Incident = await request(
    path + '/sessions',
    { expectedEventSeq: incident.eventSeq, idempotencyKey: randomUUID() },
    201,
  );
  const command = (value: WithdrawalPreview) => ({
    expectedEventSeq: value.snapshot.eventSeq,
    idempotencyKey: randomUUID(),
    reason: 'Demo: source environment verified as staging',
    preview: { snapshot: value.snapshot, evidenceId: value.evidenceId },
  });
  await request(path + '/evidence/E1-v1/withdrawals', command(preview), 409);
  assert.deepEqual((await request(path)).incident, advanced);
  console.log(
    'PASS: an intervening session invalidated the old preview; stale confirmation made no correction.',
  );

  const fresh: WithdrawalPreview = await request(path + '/evidence/E1-v1/withdrawal-preview', {
    expectedEventSeq: advanced.eventSeq,
  });
  const confirmation = command(fresh);
  const accepted: Incident = await request(path + '/evidence/E1-v1/withdrawals', confirmation);
  assert.equal(accepted.corrections.length, 1);
  const deadline = performance.now() + 30000;
  let current: Snapshot = await request(path);
  while (current.incident.reportStatus !== 'current' && performance.now() < deadline) {
    if (current.incident.repairError) throw new Error(current.incident.repairError);
    await delay(100);
    current = await request(path);
  }
  assert.equal(current.incident.reportStatus, 'current', 'Repair did not finish within 30 seconds');
  assert.equal(current.incident.reports.length, 2);
  assert.equal(
    current.incident.evaluations.find((e) => e.claimId === 'C2-v1')?.status,
    'unsupported',
  );
  assert.equal(
    current.incident.evaluations.find((e) => e.claimId === 'C4-v1')?.status,
    'supported',
  );
  assert.deepEqual(current.incident.reports[0], initial.incident.reports[0]);
  assert.deepEqual(await request(path + '/evidence/E1-v1/withdrawals', confirmation), accepted);
  assert.equal((await request(path)).incident.corrections.length, 1);
  console.log(
    'PASS: fresh confirmation repaired the report, preserved history and alternative findings, and replayed idempotently.',
  );
} finally {
  try {
    await api?.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
