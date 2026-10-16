import { expect, test } from '@playwright/test';

test('runs both agents through the real API, queue and graph, then repairs withdrawn evidence', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New investigation', exact: true }).click();
  await page.getByRole('button', { name: 'Activity ledger', exact: true }).click();
  await expect(page.locator('.model-call')).toHaveCount(0);
  await page.getByRole('button', { name: 'Run AI investigation', exact: true }).click();
  await expect(page.locator('.model-call')).toHaveCount(4);
  await expect(
    page.getByRole('button', { name: 'Run AI investigation', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Inspect recorded call', exact: true }).first().click();
  await page.getByText('Recorded request', { exact: true }).click();
  await expect(page.locator('.model-call-detail pre').first()).toContainText('proposeReport');
  await page.getByRole('button', { name: 'Investigation workspace', exact: true }).click();
  await expect(page.locator('.report-version')).toHaveText('v2');
  await expect(page.locator('.report-statement').first()).toContainText('Test reporter wording');
  await page.getByRole('button', { name: 'Withdraw source', exact: true }).click();
  await page.getByRole('button', { name: 'Withdraw evidence', exact: true }).click();
  await expect(page.locator('.report-version')).toHaveText('v3');
  await page.getByRole('button', { name: 'Activity ledger', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Recorded diagnostic decision' })).toContainText(
    'Diagnostics deferred',
  );
  await expect(page.locator('.model-call')).toHaveCount(9);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  }
});
