import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BinaryManager } from 'falkordblite';
import type { ConnectionOptions } from 'bullmq';

export async function queueConnection(
  url?: string,
): Promise<{ connection: ConnectionOptions; close: () => Promise<void> }> {
  if (url) {
    const parsed = new URL(url);
    if (!['redis:', 'rediss:'].includes(parsed.protocol))
      throw new Error('QUEUE_REDIS_URL must use redis:// or rediss://');
    const db = Number(parsed.pathname.slice(1) || 0);
    if (!Number.isInteger(db) || db < 0) throw new Error('Invalid Redis database number');
    return {
      connection: {
        host: parsed.hostname,
        port: Number(parsed.port || 6379),
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        db,
        ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
        connectTimeout: 3000,
      },
      close: async () => {},
    };
  }
  // Dedicated queue Redis. It never shares configuration or memory with the graph engine.
  const dir = await mkdtemp(join(tmpdir(), 'aftermath-queue-'));
  const socket = join(dir, 'redis.sock');
  const child = spawn(
    new BinaryManager().getRedisServerPath(),
    [
      '--port',
      '0',
      '--unixsocket',
      socket,
      '--unixsocketperm',
      '700',
      '--save',
      '',
      '--appendonly',
      'no',
      '--maxmemory-policy',
      'noeviction',
      '--dir',
      dir,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let failure = '';
  let startupError = false;
  child.stderr.on('data', (data) => {
    failure = (failure + String(data)).slice(-2000);
  });
  child.stdout.on('data', (data) => {
    failure = (failure + String(data)).slice(-2000);
  });
  child.on('error', (error) => {
    failure = error.message;
    startupError = true;
  });
  const kill = () => {
    child.kill('SIGTERM');
  };
  process.once('exit', kill);
  async function close() {
    process.removeListener('exit', kill);
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      kill();
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (startupError || child.exitCode !== null)
        throw new Error(`Queue Redis could not start: ${failure || child.exitCode}`);
      if (
        await stat(socket)
          .then(() => true)
          .catch(() => false)
      )
        return { connection: { path: socket, connectTimeout: 3000 }, close };
      await delay(20);
    }
    throw new Error('Queue Redis startup timed out');
  } catch (error) {
    await close();
    throw error;
  }
}
