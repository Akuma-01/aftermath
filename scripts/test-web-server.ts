import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { startApi } from '../apps/api/src/runtime';

// Every browser run owns fresh storage and queue/graph engines, never a developer's workspace.
const directory = await mkdtemp(join(tmpdir(), 'aftermath-web-'));
let api: Awaited<ReturnType<typeof startApi>> | undefined;
let web: ViteDevServer | undefined;
let closing: Promise<void> | undefined;
const close = () =>
  (closing ??= (async () => {
    try {
      await web?.close();
    } finally {
      try {
        await api?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  })());
try {
  api = await startApi({
    HOST: '127.0.0.1',
    PORT: '4001',
    APP_ORIGIN: 'http://127.0.0.1:5174',
    DATA_DIR: directory,
  });
  web = await createServer({
    configFile: 'apps/web/vite.config.ts',
    server: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
      proxy: { '/api': 'http://127.0.0.1:4001' },
    },
  });
  await web.listen();
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      void close().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
} catch (error) {
  await close();
  throw error;
}
