import { configuredAgents, type AgentRuntimeConfig } from '@aftermath/agents';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { Ledger } from '@aftermath/storage';
import { EvidenceGraph } from '@aftermath/graph';
import { queueConnection, RepairRuntime } from '@aftermath/queue';
import { InvestigationService } from './service';
import { createApp } from './app';

export async function startApi(
  env: NodeJS.ProcessEnv = process.env,
  agents: AgentRuntimeConfig | undefined = configuredAgents(env),
) {
  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid API port');
  const host = env.HOST ?? '127.0.0.1';
  let ledger: Ledger | undefined;
  let graph: EvidenceGraph | undefined;
  let queue: Awaited<ReturnType<typeof queueConnection>> | undefined;
  let runtime: RepairRuntime | undefined;
  let server: Server | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        if (server?.listening) {
          const stopped = new Promise<void>((resolve, reject) =>
            server!.close((error) => (error ? reject(error) : resolve())),
          );
          server.closeIdleConnections();
          await stopped;
        }
      } finally {
        try {
          await runtime?.close();
        } finally {
          try {
            await queue?.close();
          } finally {
            try {
              await graph?.close();
            } finally {
              await ledger?.close();
            }
          }
        }
      }
    })());
  try {
    const dataDir = resolve(env.DATA_DIR ?? '.data');
    if (!env.DATABASE_URL) await mkdir(dataDir, { recursive: true });
    ledger = await Ledger.open(
      env.DATABASE_URL ? undefined : resolve(dataDir, 'ledger'),
      env.DATABASE_URL,
    );
    graph = await EvidenceGraph.open(undefined, env.FALKORDB_URL);
    const service = new InvestigationService(ledger, graph, agents);
    if (!(await ledger.list()).length) await service.create('commerce');
    queue = await queueConnection(env.QUEUE_REDIS_URL);
    runtime = new RepairRuntime(ledger, service.processor, queue.connection, env.QUEUE_NAME);
    await runtime.start();
    const app = createApp(service, env.APP_ORIGIN);
    app.use(express.static(resolve('dist/web')));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/web/index.html')));
    server = app.listen(port, host);
    await once(server, 'listening');
    const address = server.address() as { port: number };
    return { app, service, server, url: `http://${host}:${address.port}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}
