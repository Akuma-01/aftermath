import { expect, test, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { BenchmarkDetail, BenchmarkResult } from '@aftermath/contracts';
import { benchmarkFixture } from '../fixtures/benchmark';

function detail(id: string, result: BenchmarkResult): BenchmarkDetail {
  return {
    id,
    status: result.outcome,
    recordedAt: result.completedAt,
    projection: result.projection,
    datasetChecksum: result.datasetChecksum,
    caseCount: result.caseCount,
    trialCount: result.trials.length,
    result,
    metadata: result.metadata,
    issue: null,
    artifacts: ['results.json', 'trials.csv', 'metadata.json'],
  };
}
async function routes(page: Page, runs: BenchmarkDetail[]) {
  await page.route('**/api/benchmarks**', async (route) => {
    expect(route.request().method()).toBe('GET');
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/benchmarks')
      await route.fulfill({
        json: {
          runs: runs.map(({ result: _r, metadata: _m, artifacts: _a, ...run }) => run),
          omitted: 0,
        },
      });
    else if (path.includes('/artifacts/')) await route.continue();
    else await route.fulfill({ json: runs.find((run) => path.endsWith(`/${run.id}`)) });
  });
}

let artifactDirectory: string | undefined;
test.afterEach(async () => {
  if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true });
  artifactDirectory = undefined;
});

test('compares saved policies, separates runs, and inspects provenance on desktop and mobile', async ({
  page,
}) => {
  const warm = detail('run-warm', benchmarkFixture('warm'));
  // Native browser downloads use the actual API; this artifact is disposable and labeled as a fixture.
  await mkdir('test-results/benchmark-artifacts', { recursive: true });
  artifactDirectory = await mkdtemp('test-results/benchmark-artifacts/run-');
  const cold = detail(basename(artifactDirectory), benchmarkFixture());
  await writeFile(join(artifactDirectory, 'results.json'), JSON.stringify(cold.result));
  await routes(page, [warm, cold]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Saved benchmarks', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Measure what the repair changes.' }),
  ).toBeVisible();
  await expect(page.getByLabel('Saved run')).toHaveValue('run-warm');
  await expect(page.getByText('Warm graph projections', { exact: true })).toBeVisible();
  const revisions = page.getByRole('row', { name: /Requested statement revisions/ });
  await expect(revisions.getByRole('cell')).toHaveText(['2', '2', '1']);
  await expect(page.getByText('Tokens and savings: N/A', { exact: true })).toBeVisible();
  await page.getByLabel('Saved run').selectOption(cold.id);
  await expect(page.getByText('Cold graph projections', { exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: /Median total latency/ })).toContainText('5.000 ms');
  await page.getByText('Run provenance and measurement scope', { exact: true }).click();
  await expect(page.getByText('a'.repeat(64), { exact: true })).toBeVisible();
  await expect(
    page.getByText('Browser/storage contract fixture; no actual benchmark or model request.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText('Inspect individual trials (3)', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Policy', exact: true }).selectOption('aftermath');
  await expect(page.getByText('1 matching trials · page 1 of 1', { exact: true })).toBeVisible();
  await page.locator('.benchmark-trial > summary').click();
  await page.getByText('Raw trial record', { exact: true }).click();
  await expect(page.locator('.benchmark-raw pre')).toContainText('"selectedReviewIds"');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'results.json', exact: true }).click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  expect(JSON.parse(await readFile((await download.path())!, 'utf8'))).toEqual(cold.result);
  await page.screenshot({ path: 'test-results/benchmarks-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  await expect(page.getByLabel('Saved run')).toBeVisible();
  await expect(page.getByRole('link', { name: 'results.json', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/benchmarks-mobile.png', fullPage: true });
});

test('keeps trial failures, rejection failures, and zero-denominator metrics visible', async ({
  page,
}) => {
  await routes(page, [detail('run-failed', benchmarkFixture('cold', true))]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Saved benchmarks', exact: true }).click();
  await expect(page.getByText('This run did not pass.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Fixture: required review was omitted');
  await expect(page.getByRole('alert')).toContainText('no rejection');
  await expect(
    page.getByRole('row', { name: /Structurally unsupported assertions/ }),
  ).toContainText('N/A');
  await page.getByText('Inspect individual trials (3)', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Outcome', exact: true }).selectOption('failed');
  await expect(page.locator('.benchmark-trial')).toHaveCount(1);
  await page.getByLabel('Find a case').fill('no-such-case');
  await expect(page.getByText('No trials match these filters.', { exact: true })).toBeVisible();
  await page.getByText('Malformed-graph checks (0 / 1 passed)', { exact: true }).click();
  await expect(page.getByText('Recorded: No rejection', { exact: true })).toBeVisible();
});

test('offers empty, error, incomplete, and invalid states even if incident memory is unavailable', async ({
  page,
}) => {
  await page.route('**/api/incidents', (route) =>
    route.fulfill({ status: 503, json: { error: 'Fixture: incident store unavailable' } }),
  );
  let error = false;
  let runs: BenchmarkDetail[] = [];
  await page.route('**/api/benchmarks**', async (route) => {
    if (error)
      await route.fulfill({
        status: 503,
        json: { error: 'Fixture: benchmark directory unavailable' },
      });
    else if (new URL(route.request().url()).pathname === '/api/benchmarks')
      await route.fulfill({ json: { runs, omitted: 0 } });
    else await route.fulfill({ json: runs.find((run) => route.request().url().endsWith(run.id)) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Saved benchmarks', exact: true }).click();
  await expect(page.getByText('No saved benchmarks yet.', { exact: true })).toBeVisible();
  error = true;
  await page.getByRole('button', { name: 'Refresh runs', exact: true }).click();
  await expect(
    page.getByText('Fixture: benchmark directory unavailable', { exact: true }),
  ).toBeVisible();
  error = false;
  runs = [
    {
      id: 'run-incomplete',
      status: 'incomplete',
      recordedAt: '2026-09-26T08:00:00.000Z',
      projection: null,
      datasetChecksum: null,
      caseCount: null,
      trialCount: null,
      issue: 'This run has no completed results yet. Refresh after it finishes.',
      result: null,
      metadata: null,
      artifacts: [],
    },
  ];
  await page.getByRole('button', { name: 'Retry benchmarks', exact: true }).click();
  await expect(page.getByText(runs[0].issue!, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Policy comparison' })).toHaveCount(0);
  runs[0] = {
    ...runs[0],
    status: 'invalid',
    issue:
      'Saved artifacts are unreadable or use an unsupported format. Inspect the raw artifacts.',
    artifacts: ['results.json'],
  };
  await page.getByRole('button', { name: 'Refresh runs', exact: true }).click();
  await expect(page.getByText(runs[0].issue!, { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'results.json', exact: true })).toHaveAttribute(
    'href',
    '/api/benchmarks/run-incomplete/artifacts/results.json',
  );
});
