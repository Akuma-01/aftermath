import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startApi } from '../apps/api/src/runtime';

it('rejects invalid ports before opening application resources', async () => {
  await expect(startApi({ PORT: 'invalid' })).rejects.toThrow('Invalid API port');
});

it('starts the API process locally, repairs in the background, and reloads durable correction memory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aftermath-api-start-'));
  let child: ChildProcess | undefined;
  let output = '';
  async function start() {
    output = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        DATA_DIR: dir,
        DATABASE_URL: '',
        FALKORDB_URL: '',
        QUEUE_REDIS_URL: '',
        QUEUE_NAME: `api-${randomUUID()}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (data) => {
      output += String(data);
    });
    child.stderr!.on('data', (data) => {
      output += String(data);
    });
    const deadline = Date.now() + 15000;
    while (!/Aftermath API: (http:\/\/127\.0\.0\.1:\d+)/.test(output)) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`API startup failed: ${output}`);
      await delay(25);
    }
    return output.match(/Aftermath API: (http:\/\/127\.0\.0\.1:\d+)/)![1];
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      expect((await exit)[0]).toBe(0);
    }
  }
  try {
    let origin = await start();
    expect((await fetch(origin + '/api/health')).status).toBe(200);
    const listing = await (await fetch(origin + '/api/incidents')).json();
    expect(listing).toHaveLength(1);
    const incident = listing[0];
    const correction = await fetch(
      `${origin}/api/incidents/${incident.id}/evidence/E1-v1/withdrawals`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedEventSeq: incident.eventSeq,
          idempotencyKey: randomUUID(),
          reason: 'Original source has invalid scope',
        }),
      },
    );
    expect(correction.status).toBe(200);
    const deadline = Date.now() + 10000;
    let snapshot = await (await fetch(`${origin}/api/incidents/${incident.id}`)).json();
    while (snapshot.incident.reportStatus !== 'current') {
      if (Date.now() > deadline) throw new Error(`Background repair failed: ${output}`);
      await delay(30);
      snapshot = await (await fetch(`${origin}/api/incidents/${incident.id}`)).json();
    }
    expect(snapshot.incident.reports).toHaveLength(2);
    expect(
      snapshot.work.attempts.filter((a: { status: string }) => a.status === 'accepted'),
    ).toHaveLength(1);
    await stop();
    origin = await start();
    snapshot = await (await fetch(`${origin}/api/incidents/${incident.id}`)).json();
    expect(snapshot.incident.corrections).toHaveLength(1);
    expect(snapshot.incident.reports).toHaveLength(2);
    const memory = await fetch(`${origin}/api/incidents/${incident.id}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedEventSeq: snapshot.incident.eventSeq,
        idempotencyKey: randomUUID(),
      }),
    });
    expect(memory.status).toBe(201);
    expect((await memory.json()).sessions[0].rejectedSourceIds).toEqual(['E1-v1']);
    await stop();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
