import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { BenchmarkStore } from '../apps/api/src/benchmarks';
import { createApp } from '../apps/api/src/app';
import type { InvestigationService } from '../apps/api/src/service';
import { benchmarkFixture } from './fixtures/benchmark';

describe('saved benchmark artifacts', () => {
  let directory: string, store: BenchmarkStore, base: string, server: Server;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'aftermath-benchmarks-'));
    store = new BenchmarkStore(directory);
    // Benchmark routes remain independent of incident/database/provider operations.
    const service = new Proxy(
      {},
      {
        get() {
          throw new Error('Incident service must not be accessed');
        },
      },
    ) as InvestigationService;
    const app = createApp(service, 'http://localhost:5173', store);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/benchmarks`;
  });
  afterAll(async () => {
    if (server?.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function save(id: string, files: Record<string, unknown>) {
    await mkdir(join(directory, id), { recursive: true });
    for (const [name, value] of Object.entries(files))
      await writeFile(
        join(directory, id, name),
        typeof value === 'string' ? value : JSON.stringify(value),
      );
  }

  it('returns an empty list before any benchmark has been run', async () => {
    expect(await new BenchmarkStore(join(directory, 'absent')).list()).toEqual({
      runs: [],
      omitted: 0,
    });
    expect(await (await fetch(base)).json()).toEqual({ runs: [], omitted: 0 });
  });
  it('lists runs newest first and keeps projection modes separate', async () => {
    await save('run-cold', { 'results.json': benchmarkFixture() });
    await save('run-warm', {
      'results.json': benchmarkFixture('warm'),
      'trials.csv': 'case_id,outcome\nfixture,passed\n',
    });
    const response = await fetch(base);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(base, { method: 'POST' })).status).toBe(404);
    const { runs } = await response.json();
    expect(runs.map((r: { id: string }) => r.id)).toEqual(['run-warm', 'run-cold']);
    expect(runs[0]).toMatchObject({ projection: 'warm', status: 'passed', trialCount: 3 });
    expect(runs[0]).not.toHaveProperty('result');
    const detail = await (await fetch(`${base}/run-warm`)).json();
    expect(detail.result).toEqual(benchmarkFixture('warm'));
    expect(detail.artifacts).toEqual(['results.json', 'trials.csv']);
  });
  it('retains failed trials and validator failures in normal measurements', async () => {
    await save('run-failed', { 'results.json': benchmarkFixture('cold', true) });
    const detail = await store.detail('run-failed');
    expect(detail.status).toBe('failed');
    expect(detail.result?.summary[2]).toMatchObject({
      trials: 1,
      failures: 1,
      totalLatencyMs: { median: 7 },
    });
    expect(detail.result?.rejections[0].passed).toBe(false);
    expect(detail.result?.trials[2].errors).toHaveLength(1);
  });
  it('shows incomplete, unreadable, and setup-failed runs instead of dropping them', async () => {
    await save('run-incomplete', { 'metadata.json': benchmarkFixture().metadata });
    await save('run-invalid', { 'results.json': '{unfinished' });
    await save('run-setup', { 'failure.json': { error: 'Fixture: engine could not start' } });
    const { runs } = await store.list();
    expect(runs.find((r) => r.id === 'run-incomplete')?.status).toBe('incomplete');
    expect(runs.find((r) => r.id === 'run-invalid')?.status).toBe('invalid');
    expect(runs.find((r) => r.id === 'run-setup')).toMatchObject({
      status: 'failed',
      issue: 'Run failure: Fixture: engine could not start',
    });
  });
  it('does not hide a late artifact-write failure behind passing trials', async () => {
    await save('run-late', {
      'results.json': benchmarkFixture(),
      'failure.json': { error: 'Could not write CSV' },
    });
    expect(await store.detail('run-late')).toMatchObject({
      status: 'failed',
      result: { outcome: 'passed' },
      issue: 'Run failure: Could not write CSV',
    });
  });
  it.each(['summary', 'duplicate', 'outcome', 'ratio', 'version', 'rejections'] as const)(
    'rejects inconsistent %s data without displaying it as passing',
    async (kind) => {
      const result = benchmarkFixture();
      if (kind === 'summary') result.summary[0].requestedStatementRevisions = 0;
      if (kind === 'duplicate') result.trials[2].method = 'full-rerun';
      if (kind === 'outcome') result.outcome = 'failed';
      if (kind === 'ratio') result.trials[0].metrics.stateAccuracy.value = 0.5;
      if (kind === 'version') (result as { version: string }).version = 'future-protocol';
      if (kind === 'rejections') result.malformedCaseCount = 2;
      await save(`run-${kind}`, { 'results.json': result });
      expect(await store.detail(`run-${kind}`)).toMatchObject({
        status: 'invalid',
        result: null,
        artifacts: ['results.json'],
      });
    },
  );
  it('downloads exact allowlisted artifacts as attachments and refuses arbitrary paths', async () => {
    const response = await fetch(`${base}/run-warm/artifacts/trials.csv`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain(
      'attachment; filename="run-warm-trials.csv"',
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('case_id,outcome\nfixture,passed\n');
    for (const path of [
      '/run-warm/artifacts/.env',
      '/run-warm/artifacts/..%2F.env',
      '/run-missing',
      '/..%2Fprivate',
    ]) {
      expect((await fetch(base + path)).status).toBe(404);
    }
  });
  it('refuses symbolic links, non-files, and oversized artifacts', async () => {
    const external = join(directory, 'private.txt');
    await writeFile(external, 'private sentinel');
    await save('run-link', {});
    await symlink(external, join(directory, 'run-link', 'results.json'));
    await symlink(join(directory, 'run-cold'), join(directory, 'run-symlink'));
    expect((await store.list()).runs.some((r) => r.id === 'run-symlink')).toBe(false);
    expect((await store.detail('run-link')).status).toBe('invalid');
    const response = await fetch(`${base}/run-link/artifacts/results.json`);
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain('private sentinel');
    await save('run-directory', {});
    await mkdir(join(directory, 'run-directory', 'results.json'));
    expect((await fetch(`${base}/run-directory/artifacts/results.json`)).status).toBe(422);
    await save('run-large', {});
    const file = await open(join(directory, 'run-large', 'results.json'), 'w');
    await file.truncate(16 * 1024 * 1024 + 1);
    await file.close();
    expect((await store.detail('run-large')).status).toBe('invalid');
    expect((await fetch(`${base}/run-large/artifacts/results.json`)).status).toBe(422);
  });
});
