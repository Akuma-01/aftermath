import { test, expect } from '@playwright/test';

test('withdraws, repairs, runs a diagnostic and remembers the correction in a fresh session', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('Graph connected')).toBeVisible();
  await page.getByRole('button', { name: 'New investigation' }).click();
  await expect(page.getByText('Report current', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Withdraw source', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Withdraw evidence', exact: true }).click();
  await expect(
    page.getByText('Correction applied. The investigation has recovered.'),
  ).toBeVisible();
  await expect(
    page.locator('.report-statement').filter({ hasText: 'Production database pool pressure' }),
  ).toContainText('Insufficient current production evidence');
  await expect(
    page.locator('.report-statement').filter({ hasText: 'Payment-provider latency is elevated' }),
  ).toContainText('Preserved');
  await page.getByRole('button', { name: /Revision diff/ }).click();
  await expect(page.locator('.old-text')).toHaveCount(2);
  await page
    .locator('.diagnostic-card')
    .filter({ hasText: 'Check production pool usage' })
    .getByRole('button', { name: 'Run check' })
    .click();
  await expect(
    page.locator('.report-statement').filter({ hasText: 'Production pool metrics are normal' }),
  ).toContainText('34%');
  await page.getByRole('button', { name: 'Correction memory', exact: true }).click();
  await page.getByRole('button', { name: 'Open fresh session', exact: true }).click();
  await expect(page.getByText('Excluded from support: E1-v1')).toBeVisible();
  await expect(page.getByText('0 prior chat messages')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Correction memory', exact: true }).click();
  await expect(page.getByText('Excluded from support: E1-v1')).toBeVisible();
  expect(errors).toEqual([]);
  await page.route('**/api/incidents/**', (route) => route.abort());
  await expect(
    page.getByText('Updates unavailable. Showing the last received snapshot.'),
  ).toBeVisible({ timeout: 10000 });
  await page.unrouteAll();
  await page.getByRole('button', { name: 'Reconnect' }).click();
  await expect(page.getByText('Graph connected')).toBeVisible();
});

test('preserves alternative support and keeps the workspace usable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Evidence', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New investigation' }).click();
  await page.locator('.evidence-card').filter({ hasText: 'Payment latency spike' }).click();
  await page.getByRole('button', { name: 'Withdraw source', exact: true }).click();
  await page
    .getByLabel('Reason for withdrawal')
    .fill('Trace sample was incomplete and has been withdrawn.');
  await page.getByRole('button', { name: 'Withdraw evidence', exact: true }).click();
  await expect(page.getByText('2 preserved by valid support')).toBeVisible();
  await expect(page.getByText('0 unresolved')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.getByRole('button', { name: 'Activity ledger', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Repair attempts', exact: true })).toBeVisible();
  await expect(page.getByText('Published', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  await page.screenshot({ path: 'test-results/worker-history-mobile.png', fullPage: true });
});

test('holds a report, rejects it after a correction, and retains the accepted automatic repair', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText('Graph connected')).toBeVisible();
  await page.getByRole('button', { name: 'New investigation' }).click();
  await page.getByRole('button', { name: 'Activity ledger', exact: true }).click();
  await page.getByRole('button', { name: 'Hold a report', exact: true }).click();
  await expect(page.getByText('Report held before publication', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume held report' })).toBeEnabled();
  await page.getByRole('button', { name: 'Investigation workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Withdraw source', exact: true }).click();
  await page.getByRole('button', { name: 'Withdraw evidence', exact: true }).click();
  await expect(
    page.getByText('Correction applied. The investigation has recovered.'),
  ).toBeVisible();
  await expect(page.locator('.report-version')).toHaveText('v2');
  await page.getByRole('button', { name: 'Activity ledger', exact: true }).click();
  await page.getByRole('button', { name: 'Resume held report' }).click();
  await expect(page.getByText('Rejected · stale evidence', { exact: true })).toBeVisible();
  const rejected = page.locator('.attempt-card.stale');
  await rejected.getByText('Inspect input context', { exact: true }).click();
  await expect(rejected).toContainText('E1-v1');
  await expect(rejected).toContainText('Evidence epoch 1');
  await page.getByRole('button', { name: 'Investigation workspace', exact: true }).click();
  await expect(page.locator('.report-version')).toHaveText('v2');
  await expect(page.getByText('Report current', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Activity ledger', exact: true }).click();
  await expect(page.getByText('Rejected · stale evidence', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/worker-history-desktop.png', fullPage: true });
});
