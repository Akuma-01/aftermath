import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startApi } from '../apps/api/src/runtime';
import viteConfig from '../apps/web/vite.config';

it('uses the configured API address for the Vite proxy without exposing provider configuration', async () => {
  vi.stubEnv('HOST', '127.0.0.1');
  vi.stubEnv('PORT', '4321');
  vi.stubEnv('GEMINI_API_KEY', 'release-test-sentinel');
  try {
    const config =
      typeof viteConfig === 'function'
        ? await viteConfig({ mode: 'test', command: 'serve' })
        : viteConfig;
    expect(config.server?.proxy?.['/api']).toBe('http://127.0.0.1:4321');
    expect(JSON.stringify(config)).not.toContain('release-test-sentinel');
  } finally {
    vi.unstubAllEnvs();
  }
});
it('requires explicit live opt-in but lists diagnostic cases offline', async () => {
  const run = promisify(execFile);
  const args = ['--import', 'tsx', 'scripts/test-agents-live.ts'];
  const env = {
    ...process.env,
    LLM_PROVIDER: '',
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: '',
    GEMINI_API_KEY_FALLBACK: '',
  };
  await expect(run(process.execPath, args, { env })).rejects.toMatchObject({
    stderr: expect.stringContaining('require --allow-live'),
  });
  const listed = await run(process.execPath, [...args, '--list-diagnostics'], { env });
  expect(listed.stdout).toContain('pool-followup');
  expect(listed.stdout).toContain('missing-prerequisite');
});
it('serves a complete same-origin incident lifecycle on an assigned port and rejects hostile origins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aftermath-release-'));
  const api = await startApi({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir });
  const post = (
    path: string,
    body: unknown,
    origin = api.url,
    extra: Record<string, string> = {},
  ) =>
    fetch(api.url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...extra },
      body: JSON.stringify(body),
    });
  try {
    expect(
      (
        await post('/api/incidents', {}, 'http://untrusted.invalid', {
          host: new URL(api.url).host,
        })
      ).status,
    ).toBe(403);
    const created = await post('/api/incidents', { scenario: 'checkout' });
    expect(created.status).toBe(201);
    const incident = await created.json();
    const path = `/api/incidents/${incident.id}`;
    expect((await fetch(api.url + path + '/evidence')).status).toBe(200);
    const support = await (await fetch(api.url + path + '/claims/C2-v1')).json();
    expect(support.evaluation.status).toBe('supported');
    const mcp = await post(
      '/api/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'inspect_support', arguments: { incidentId: incident.id } },
      },
      api.url,
      { accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    );
    expect(mcp.status).toBe(200);
    expect((await mcp.json()).result.isError).toBeUndefined();
    const withdrawn = await post(path + '/evidence/E1-v1/withdrawals', {
      expectedEventSeq: incident.eventSeq,
      idempotencyKey: randomUUID(),
      reason: 'Release test: wrong environment',
    });
    expect(withdrawn.status).toBe(200);
    expect((await withdrawn.json()).reportStatus).toBe('needs_review');
    await vi.waitFor(
      async () => {
        const snapshot = await (await fetch(api.url + path)).json();
        expect(snapshot.incident.reportStatus).toBe('current');
        expect(snapshot.incident.reports).toHaveLength(2);
        expect(
          snapshot.incident.evaluations.find((e: { claimId: string }) => e.claimId === 'C2-v1')
            .status,
        ).toBe('unsupported');
      },
      { timeout: 10000, interval: 50 },
    );
    const reports = await (await fetch(api.url + path + '/reports')).json();
    expect(reports.reports).toHaveLength(2);
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
