import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchmarkStore } from '../apps/api/src/benchmarks';
const execute = promisify(execFile);
it('writes real cold/warm CLI measurements that the artifact API validates without model configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aftermath-benchmark-cli-'));
  const env = {
    ...process.env,
    DATA_DIR: dir,
    LLM_PROVIDER: '',
    GEMINI_API_KEY: '',
    GEMINI_API_KEY_FALLBACK: '',
    OPENAI_API_KEY: '',
  };
  try {
    for (const projection of ['cold', 'warm']) {
      const result = await execute(
        process.execPath,
        [
          'node_modules/tsx/dist/cli.mjs',
          'scripts/benchmark.ts',
          '--seed=7',
          '--repetitions=1',
          `--projection=${projection}`,
        ],
        { env, timeout: 30000 },
      );
      expect(result.stdout).toContain('Outcome: passed');
    }
    const store = new BenchmarkStore(join(dir, 'benchmarks'));
    const { runs } = await store.list();
    expect(runs).toHaveLength(2);
    const results = await Promise.all(
      runs.map(async (run) => {
        const detail = await store.detail(run.id);
        expect(detail.status).toBe('passed');
        expect(detail.result?.trials).toHaveLength(123);
        expect(detail.result?.model.calls).toBe(0);
        expect(detail.result?.metadata.sources['packages/contracts/src/index.ts']).toMatch(
          /^[a-f0-9]{64}$/,
        );
        const csv = (await store.artifact(run.id, 'trials.csv')).toString();
        expect(csv.trim().split('\n')).toHaveLength(124);
        expect(detail.artifacts).toEqual([
          'results.json',
          'trials.csv',
          'cases.json',
          'metadata.json',
          'summary.md',
        ]);
        return detail.result!;
      }),
    );
    expect(results[0].datasetChecksum).toBe(results[1].datasetChecksum);
    expect(results[0].trials.map((t) => [t.caseId, t.method])).toEqual(
      results[1].trials.map((t) => [t.caseId, t.method]),
    );
    await execute(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'scripts/benchmark-diagnostics.ts'],
      { env, timeout: 30000 },
    );
    const [run] = await readdir(join(dir, 'diagnostic-evaluations'));
    const diagnostic = JSON.parse(
      await readFile(join(dir, 'diagnostic-evaluations', run, 'results.json'), 'utf8'),
    );
    expect(diagnostic).toMatchObject({
      outcome: 'passed',
      modelCalls: 0,
      rankingAccuracy: { numerator: 5, denominator: 5, value: 1 },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
