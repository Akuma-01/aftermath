import { expect, it } from 'vitest';
import { createServer, createConnection, type Server } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FalkorDB } from 'falkordblite';
import { queueConnection } from '@aftermath/queue';
import { Ledger } from '@aftermath/storage';
import { createIncident } from '@aftermath/fixtures';
import { startWorker } from '../apps/worker/src/runtime';

it('requires shared PostgreSQL, graph and queue services for a dedicated worker', async () => {
  await expect(startWorker({})).rejects.toThrow('requires DATABASE_URL');
});

it.runIf(Boolean(process.env.STORAGE_TEST_DATABASE_URL))(
  'repairs from a separate worker process and shuts down cleanly',
  async () => {
    const ledger = await Ledger.open(undefined, process.env.STORAGE_TEST_DATABASE_URL);
    let graph: FalkorDB | undefined;
    let redis: Awaited<ReturnType<typeof queueConnection>> | undefined;
    const servers: Server[] = [];
    let child: ChildProcess | undefined;
    async function proxy(path: string) {
      const server = createServer((socket) => {
        const upstream = createConnection({ path });
        socket.pipe(upstream).pipe(socket);
        socket.on('error', () => upstream.destroy());
        upstream.on('error', () => socket.destroy());
        socket.on('close', () => upstream.destroy());
      });
      servers.push(server);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return `redis://127.0.0.1:${(server.address() as { port: number }).port}`;
    }
    try {
      graph = await FalkorDB.open({ timeout: 20000, logLevel: 'warning' });
      redis = await queueConnection();
      const graphUrl = await proxy(graph.socketPath);
      const queueUrl = await proxy((redis.connection as { path: string }).path);
      const incident = createIncident();
      incident.id = randomUUID();
      await ledger.create(incident);
      await ledger.withdraw(incident.id, 'E1-v1', 'Dedicated worker correction', 1, randomUUID());
      let output = '';
      child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/index.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LLM_PROVIDER: '',
          GEMINI_API_KEY: '',
          GEMINI_API_KEY_FALLBACK: '',
          OPENAI_API_KEY: '',
          DATABASE_URL: process.env.STORAGE_TEST_DATABASE_URL,
          FALKORDB_URL: graphUrl,
          QUEUE_REDIS_URL: queueUrl,
          QUEUE_NAME: `test-${randomUUID()}`,
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
      while ((await ledger.get(incident.id)).reportStatus !== 'current') {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(`Dedicated worker failed: ${output}`);
        await delay(30);
      }
      expect((await ledger.get(incident.id)).reports).toHaveLength(2);
      expect(output).toContain('repair worker started');
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      expect((await exited)[0]).toBe(0);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      await Promise.all(
        servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      );
      await redis?.close();
      await graph?.close();
      await ledger.close();
    }
  },
);
