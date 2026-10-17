import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Router } from 'express';
import { z } from 'zod';
import {
  benchmarkArtifacts,
  benchmarkMetadataSchema,
  benchmarkResultSchema,
  type BenchmarkArtifact,
  type BenchmarkDetail,
  type BenchmarkIndex,
  type BenchmarkResult,
} from '@aftermath/contracts';
import { summarize } from '@aftermath/evaluation';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RUNS = 100;
const runName = /^run-[a-zA-Z0-9]+$/;
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
class ArtifactError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

function validateResult(raw: unknown): BenchmarkResult {
  const r = benchmarkResultSchema.parse(raw);
  const cases = new Set(r.trials.map((t) => t.caseId));
  const combinations = new Set(
    r.trials.map((t) => JSON.stringify([t.caseId, t.method, t.repetition])),
  );
  const expectedOutcome =
    r.trials.every((t) => t.outcome === 'passed') && r.rejections.every((t) => t.passed)
      ? 'passed'
      : 'failed';
  if (
    r.trials.length !== r.caseCount * r.repetitions * 3 ||
    cases.size !== r.caseCount ||
    combinations.size !== r.trials.length ||
    r.rejections.length !== r.malformedCaseCount ||
    new Set(r.rejections.map((t) => t.caseId)).size !== r.rejections.length ||
    r.trials.some(
      (t, i) =>
        t.repetition >= r.repetitions ||
        t.order !== i ||
        t.projection !== r.projection ||
        (t.errors.length === 0) !== (t.outcome === 'passed'),
    ) ||
    r.rejections.some((t) => t.passed !== Boolean(t.actualError?.includes(t.expectedError))) ||
    r.outcome !== expectedOutcome ||
    !isDeepStrictEqual(r.summary, summarize(r.trials))
  ) {
    throw new ArtifactError(
      'Saved results are inconsistent with their trial records. Inspect the raw artifacts.',
    );
  }
  return r;
}

/** Reads only named benchmark artifacts. Never runs a benchmark or a model. */
export class BenchmarkStore {
  constructor(readonly root = resolve('.data/benchmarks')) {}

  private async directory(id: string) {
    if (!runName.test(id)) throw new ArtifactError('Benchmark run not found.', 404);
    const directory = join(this.root, id);
    const stat = await lstat(directory).catch((e) => {
      if (missing(e)) throw new ArtifactError('Benchmark run not found.', 404);
      throw e;
    });
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ArtifactError('Benchmark run not found.', 404);
    return { directory, stat };
  }

  async artifact(id: string, name: string): Promise<Buffer> {
    if (!benchmarkArtifacts.includes(name as BenchmarkArtifact))
      throw new ArtifactError('Artifact not found.', 404);
    const { directory } = await this.directory(id);
    const file = await open(
      join(directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((e) => {
      if (missing(e)) throw new ArtifactError('Artifact not found.', 404);
      throw new ArtifactError('Artifact cannot be safely read.');
    });
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES)
        throw new ArtifactError('Artifact is not a regular file within the 16 MiB limit.');
      // Bound allocation even if a file grows between stat and read.
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== stat.size)
        throw new ArtifactError('Artifact changed while reading. Refresh after the run finishes.');
      return buffer.subarray(0, offset);
    } finally {
      await file.close();
    }
  }

  async detail(id: string): Promise<BenchmarkDetail> {
    const { directory, stat } = await this.directory(id);
    const names = await readdir(directory);
    const artifacts: BenchmarkArtifact[] = [];
    for (const name of benchmarkArtifacts.filter((n) => names.includes(n))) {
      const entry = await lstat(join(directory, name)).catch(() => null);
      if (entry?.isFile() && !entry.isSymbolicLink() && entry.size <= MAX_BYTES)
        artifacts.push(name);
    }
    const detail: BenchmarkDetail = {
      id,
      status: 'incomplete',
      recordedAt: stat.mtime.toISOString(),
      projection: null,
      datasetChecksum: null,
      caseCount: null,
      trialCount: null,
      issue: 'This run has no completed results yet. Refresh after it finishes.',
      result: null,
      metadata: null,
      artifacts,
    };
    try {
      if (names.includes('results.json')) {
        const result = validateResult(
          JSON.parse((await this.artifact(id, 'results.json')).toString('utf8')),
        );
        Object.assign(detail, {
          status: result.outcome,
          recordedAt: result.completedAt,
          projection: result.projection,
          datasetChecksum: result.datasetChecksum,
          caseCount: result.caseCount,
          trialCount: result.trials.length,
          result,
          metadata: result.metadata,
          issue: null,
        });
      } else {
        if (names.includes('metadata.json')) {
          detail.metadata = benchmarkMetadataSchema.parse(
            JSON.parse((await this.artifact(id, 'metadata.json')).toString('utf8')),
          );
          detail.recordedAt = detail.metadata.startedAt;
        }
      }
      // A late artifact-write failure can coexist with valid measurements. Retain both.
      if (names.includes('failure.json')) {
        const failure = z
          .object({ error: z.string() })
          .parse(JSON.parse((await this.artifact(id, 'failure.json')).toString('utf8')));
        detail.status = 'failed';
        detail.issue = `Run failure: ${failure.error}`;
      }
    } catch (error) {
      detail.status = 'invalid';
      detail.issue =
        error instanceof ArtifactError
          ? error.message
          : 'Saved artifacts are unreadable or use an unsupported format. Inspect the raw artifacts.';
    }
    return detail;
  }

  async list(): Promise<BenchmarkIndex> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((e) => {
      if (missing(e)) return [];
      throw e;
    });
    const candidates = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && runName.test(e.name))
        .map(async (e) => ({
          id: e.name,
          time: (await lstat(join(this.root, e.name))).mtimeMs,
        })),
    );
    candidates.sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
    const runs: BenchmarkIndex['runs'] = [];
    // Bounded batches avoid loading every retained result simultaneously.
    for (let i = 0; i < Math.min(candidates.length, MAX_RUNS); i += 4) {
      const batch = await Promise.all(
        candidates.slice(i, Math.min(i + 4, MAX_RUNS)).map(async ({ id }) => {
          const {
            result: _result,
            metadata: _metadata,
            artifacts: _artifacts,
            ...run
          } = await this.detail(id);
          return run;
        }),
      );
      runs.push(...batch);
    }
    runs.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id));
    return { runs, omitted: Math.max(0, candidates.length - MAX_RUNS) };
  }
}

export function benchmarkRouter(store: BenchmarkStore) {
  const router = Router();
  router.get('/', async (_req, res) => res.json(await store.list()));
  router.get('/:id', async (req, res) => res.json(await store.detail(req.params.id)));
  router.get('/:id/artifacts/:name', async (req, res) => {
    const body = await store.artifact(req.params.id, req.params.name);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.attachment(`${req.params.id}-${req.params.name}`).send(body);
  });
  router.use(
    (
      error: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      _next: import('express').NextFunction,
    ) => {
      res.status(error instanceof ArtifactError ? error.status : 503).json({
        error:
          error instanceof ArtifactError
            ? error.message
            : 'Saved benchmarks could not be read. Check the local artifact directory and retry.',
      });
    },
  );
  return router;
}
