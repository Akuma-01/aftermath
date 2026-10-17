import { createHash } from 'node:crypto';
import 'dotenv/config';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runDiagnosticEvaluation } from '@aftermath/evaluation';

const root = resolve(process.env.DATA_DIR ?? '.data', 'diagnostic-evaluations');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'run-'));
try {
  const sources = Object.fromEntries(
    await Promise.all(
      [
        'package-lock.json',
        'packages/evaluation/src/diagnostic-cases.ts',
        'packages/evaluation/src/diagnostics.ts',
        'packages/fixtures/src/index.ts',
        'packages/graph/src/index.ts',
        'packages/graph/src/services.ts',
        'packages/graph/src/queries.ts',
        'packages/domain/src/index.ts',
        'packages/contracts/src/index.ts',
        'scripts/benchmark-diagnostics.ts',
      ].map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]),
    ),
  );
  const result = {
    ...(await runDiagnosticEvaluation()),
    metadata: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      sources,
    },
  };
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(
    `${result.outcome}: ${result.results.filter((r) => r.outcome === 'passed').length}/${result.results.length} diagnostic cases; zero model calls. Results: ${directory}/results.json`,
  );
  if (result.outcome !== 'passed') process.exitCode = 1;
} catch (error) {
  await writeFile(
    join(directory, 'failure.json'),
    JSON.stringify(
      { error: error instanceof Error ? error.message : 'Evaluation failed' },
      null,
      2,
    ),
  );
  throw error;
}
