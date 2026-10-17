import { expect, test } from '@playwright/test';

test('inspects graph premises and provenance, contested findings and immutable report revisions', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New investigation', exact: true }).click();
  await page.getByText('Source provenance and scope', { exact: true }).click();
  await expect(page.locator('.provenance')).toContainText('Origin:');
  await page.getByRole('button', { name: 'View raw observation', exact: true }).click();
  await expect(page.locator('.raw-observation')).not.toBeEmpty();
  await page.locator('.graph-canvas').getByTestId('rf__node-C4-v1').click();
  await expect(page.getByRole('heading', { name: 'Finding inspector', exact: true })).toBeVisible();
  await expect(page.locator('.inspector-body .support-group')).toHaveCount(2);
  await expect(page.locator('.inspector-body .support-group .status.supported')).toHaveCount(2);
  await expect(page.locator('.inspector-body')).toContainText('OR');
  await page
    .locator('.diagnostic-card')
    .filter({ hasText: 'Check production pool usage' })
    .getByRole('button', { name: 'Run check', exact: true })
    .click();
  const finding = page
    .locator('.report-statement')
    .filter({ hasText: 'Production database pool pressure' });
  await expect(finding.locator('.status')).toHaveText('contested');
  await expect(page.locator('.graph-canvas .artifact-node.contested')).toHaveCount(1);
  await expect(page.locator('.report-version')).toHaveText('v2');
  await page.getByLabel('Report version', { exact: true }).selectOption('1');
  await expect(page.getByText('HISTORICAL REVISION', { exact: true })).toBeVisible();
  await expect(finding.locator('.status')).toHaveText('supported');
  await page.getByLabel('Report version', { exact: true }).selectOption('latest');
  await expect(finding.locator('.status')).toHaveText('contested');
  await page.getByRole('button', { name: 'Activity ledger', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Run AI investigation', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText('No agent calls recorded for this incident.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('switches incidents, retains selection on reload and ignores an old in-flight poll', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByLabel('Select investigation')).toBeVisible();
  const original = await page.getByLabel('Select investigation').inputValue();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const received = new Promise<void>((resolve) => (started = resolve));
  await page.route(`**/api/incidents/${original}`, async (route) => {
    const response = await route.fetch();
    started();
    await gate;
    await route.fulfill({ response });
  });
  await received;
  await page.getByRole('button', { name: 'New investigation', exact: true }).click();
  await expect(page.getByLabel('Select investigation')).not.toHaveValue(original);
  const created = await page.getByLabel('Select investigation').inputValue();
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await page.reload();
  await expect(page.getByLabel('Select investigation')).toHaveValue(created);
  await page.getByLabel('Select investigation').selectOption(original);
  await expect(page.getByLabel('Select investigation')).toHaveValue(original);
  await page.reload();
  await expect(page.getByLabel('Select investigation')).toHaveValue(original);
});

test('shows loading, empty and unavailable states without silently creating incidents', async ({
  page,
}) => {
  let creates = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/incidents')) creates++;
  });
  await page.route('**/api/incidents', (route) => route.fulfill({ status: 200, json: [] }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'No incidents yet' })).toBeVisible();
  expect(creates).toBe(0);
  await page.unrouteAll();
  await page.route('**/api/incidents', (route) =>
    route.fulfill({ status: 503, json: { error: 'Database temporarily unavailable' } }),
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Workspace unavailable' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Database temporarily unavailable');
  await page.unrouteAll();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Graph connected', { exact: true })).toBeVisible();
  const id = await page.getByLabel('Select investigation').inputValue();
  await page.route(`**/api/incidents/${id}`, async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    await route.fulfill({
      json: { ...snapshot, graph: null, diagnostics: [], graphError: 'Graph unavailable' },
    });
  });
  await expect(page.getByText('Graph memory is unavailable', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Diagnostics are unavailable until graph analysis recovers.'),
  ).toBeVisible();
  await expect(page.locator('.evidence-card').first()).toBeVisible();
  await page.unrouteAll();
  await expect(page.getByText('Graph connected', { exact: true })).toBeVisible();
});

test('keeps a rejected correction open, displays conflict details and refreshes state', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New investigation', exact: true }).click();
  await page.route('**/withdrawals', (route) =>
    route.fulfill({
      status: 409,
      json: { error: 'Incident changed. Refresh and retry.', code: 'CONFLICT' },
    }),
  );
  await page.getByRole('button', { name: 'Withdraw source', exact: true }).click();
  await page.getByRole('button', { name: 'Withdraw evidence', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Incident changed');
  await expect(page.getByRole('button', { name: 'Withdraw evidence', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh preview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Withdraw evidence', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.evidence-card.selected')).not.toHaveClass(/withdrawn/);
});

test('keeps navigation and graph tools usable at narrow, tablet and desktop widths', async ({
  page,
}) => {
  const deferred: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/.*(benchmarks|investigations|model-calls)/.test(request.url()))
      deferred.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'New investigation', exact: true }).click();
  await expect(page.getByText('Report current', { exact: true })).toBeVisible();
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByLabel('Select investigation')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), {
        message: `No page overflow at ${width}px`,
      })
      .toBe(true);
    await page.screenshot({ path: `test-results/workspace-${width}.png`, fullPage: false });
    await page.getByRole('button', { name: 'Activity ledger', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Hold a report', exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.getByRole('button', { name: 'Correction memory', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Open fresh session', exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.getByRole('button', { name: 'Investigation workspace', exact: true }).click();
  }
  expect(deferred).toEqual([]);
});
