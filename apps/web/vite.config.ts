import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const host = process.env.HOST ?? env.HOST ?? '127.0.0.1';
  const port = process.env.PORT ?? env.PORT ?? '4000';
  const target = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/api': target },
    },
    build: { outDir: '../../dist/web', emptyOutDir: true },
  };
});
