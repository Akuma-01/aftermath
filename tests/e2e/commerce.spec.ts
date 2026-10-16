import { expect, test } from '@playwright/test';

test('shows a multi-service correction and graph-explained next check', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Commerce demo', exact: true }).click();
  await expect(page.getByText('24 services · 34 dependencies')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dependency PageRank' })).toBeVisible();
  await page.getByRole('button', { name: 'Withdraw source', exact: true }).click();
  await page.getByRole('button', { name: 'Withdraw evidence', exact: true }).click();
  await expect(
    page.getByText('Correction applied. The investigation has recovered.'),
  ).toBeVisible();
  await expect(
    page
      .locator('.report-statement')
      .filter({ hasText: 'Order degradation remains independently observed' }),
  ).toContainText('Preserved');
  await expect(
    page
      .locator('.report-statement')
      .filter({ hasText: 'Order delays may propagate to fulfillment' }),
  ).toContainText('Insufficient current production evidence');
  const next = page.locator('.diagnostic-card').first();
  await expect(next).toContainText('Check production pool usage');
  await next.locator('summary').click();
  await expect(next).toContainText('fulfillment → orders → database');
  await next.getByRole('button', { name: 'Run check' }).click();
  await expect(
    page.locator('.report-statement').filter({ hasText: 'Production pool metrics are normal' }),
  ).toContainText('34%');
  await page.screenshot({ path: 'test-results/commerce-recovery.png', fullPage: true });
});
