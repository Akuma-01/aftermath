import { test, expect, type Page } from '@playwright/test';

async function createIncident(page: Page) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/incidents') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'New investigation', exact: true }).click();
  return (await (await response).json()).id as string;
}

test('compares real graph support and submits the matching preview only on confirmation', async ({
  page,
}) => {
  await page.goto('/');
  const id = await createIncident(page);
  await page.getByRole('button', { name: 'Withdraw source', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('table')).toBeVisible();
  await expect(
    dialog.getByRole('row').filter({ hasText: 'Production database pool pressure' }),
  ).toContainText('unsupported');
  await expect(
    dialog.getByRole('row').filter({ hasText: 'Payment-provider latency is elevated' }),
  ).toContainText('Conclusion remains supported');
  await dialog.getByText('Report conclusions and citations', { exact: true }).click();
  await expect(
    dialog.getByText(/Database pressure may explain failures.*Requires review/),
  ).toBeVisible();
  const before = await (await page.request.get(`/api/incidents/${id}`)).json();
  expect(before.incident.corrections).toHaveLength(0);
  expect(before.work.tasks).toHaveLength(0);
  const request = page.waitForRequest(
    (r) => r.url().endsWith('/withdrawals') && r.method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Withdraw evidence', exact: true }).click();
  const body = (await request).postDataJSON();
  expect(body.preview.evidenceId).toBe('E1-v1');
  expect(body.preview.snapshot.incidentId).toBe(id);
  expect(body.expectedEventSeq).toBe(body.preview.snapshot.eventSeq);
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText('Correction applied. The investigation has recovered.'),
  ).toBeVisible();
});

test('blocks stale previews until refreshed and remains usable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const id = await createIncident(page);
  await page.getByRole('button', { name: 'Withdraw source', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: 'Withdraw evidence', exact: true });
  await expect(confirm).toBeEnabled();
  const response = await page.request.post(`/api/incidents/${id}/sessions`, {
    data: { expectedEventSeq: 1, idempotencyKey: crypto.randomUUID() },
  });
  expect(response.ok()).toBe(true);
  await expect(
    dialog.getByText('This preview is out of date. Refresh it before confirming.'),
  ).toBeVisible();
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('button', { name: 'Refresh preview', exact: true }).click();
  await expect(confirm).toBeEnabled();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(
    (await (await page.request.get(`/api/incidents/${id}`)).json()).incident.corrections,
  ).toHaveLength(0);
});

test('keeps withdrawal disabled on preview failure and permits recovery', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New investigation', exact: true }).click();
  await page.route('**/withdrawal-preview', (route) =>
    route.fulfill({
      status: 503,
      json: { error: 'Preview graph unavailable', code: 'SERVICE_UNAVAILABLE' },
    }),
  );
  await page.getByRole('button', { name: 'Withdraw source', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toContainText('Preview graph unavailable');
  await expect(
    dialog.getByRole('button', { name: 'Withdraw evidence', exact: true }),
  ).toBeDisabled();
  await page.unroute('**/withdrawal-preview');
  await dialog.getByRole('button', { name: 'Refresh preview', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Withdraw evidence', exact: true }),
  ).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});
