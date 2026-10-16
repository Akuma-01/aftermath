import { expect, test } from '@playwright/test';
import type { ModelCallDetail, Snapshot } from '@aftermath/contracts';

test('shows Gemini call history, quota failures, and recorded inputs on desktop and mobile', async ({
  page,
  request,
}) => {
  // UI contract fixture only. Real publication and provider parsing are covered separately.
  const created = await (await request.post('/api/incidents', { data: {} })).json();
  const snapshot: Snapshot = await (await request.get(`/api/incidents/${created.id}`)).json();
  snapshot.agentAvailability = {
    configured: true,
    provider: 'gemini',
    model: 'gemini-3.5-flash-lite',
  };
  let launched = false;
  const call: ModelCallDetail = {
    id: 'browser-model-call',
    attemptId: 'browser-attempt',
    role: 'investigator',
    provider: 'gemini',
    model: 'gemini-3.5-flash-lite',
    status: 'failed',
    credentialSlot: 'primary',
    failoverFromCallId: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    latencyMs: 320,
    inputTokens: null,
    outputTokens: null,
    error:
      'Gemini quota or rate limit reached (HTTP 429). Check your free-tier quota in Google AI Studio before retrying.',
    request: {
      contents: [{ role: 'user', parts: [{ text: 'Browser test input; no real model call.' }] }],
    },
    response: { httpStatus: 429 },
    manifest: {
      evidenceEpoch: 1,
      reportVersion: 1,
      graphGeneration: 'browser-test-graph',
      projectedSeq: 1,
      readArtifacts: [],
      sessionId: 'browser-session',
    },
  };
  await page.route(`**/api/incidents/${created.id}`, (route) => route.fulfill({ json: snapshot }));
  await page.route(`**/api/incidents/${created.id}/investigations`, async (route) => {
    expect(route.request().postDataJSON()).toHaveProperty('idempotencyKey');
    launched = true;
    snapshot.mode = 'live';
    snapshot.incident.reportStatus = 'needs_review';
    snapshot.work.modelCalls = [call];
    await route.fulfill({ status: 202, json: snapshot.incident });
  });
  await page.route(`**/api/incidents/${created.id}/model-calls/${call.id}`, (route) =>
    route.fulfill({ json: call }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Activity ledger', exact: true }).click();
  await page.getByRole('button', { name: 'Run AI investigation', exact: true }).click();
  await expect(page.locator('.fixture-pill')).toContainText('Live agents');
  await expect(page.getByText(call.error!)).toBeVisible();
  expect(launched).toBe(true);
  await expect(page.getByText('Input: not reported', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect recorded call', exact: true }).click();
  await page.getByText('Recorded request', { exact: true }).click();
  await expect(page.getByText(/Browser test input; no real model call/)).toBeVisible();
  await page.screenshot({ path: 'test-results/agent-history-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  await expect(page.getByRole('button', { name: 'Close recorded call' })).toBeVisible();
  await page.screenshot({ path: 'test-results/agent-history-mobile.png', fullPage: true });
  const backup: ModelCallDetail = {
    ...call,
    id: 'browser-backup-call',
    credentialSlot: 'backup',
    failoverFromCallId: call.id,
    status: 'succeeded',
    error: null,
    inputTokens: 100,
    outputTokens: 20,
    response: { browserFixture: true },
  };
  snapshot.work.modelCalls = [backup, call];
  await expect(page.getByText('Primary key', { exact: true })).toBeVisible();
  await expect(page.getByText('Backup key', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Switched to the backup key after a provider failure.'),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  await page.screenshot({ path: 'test-results/agent-failover-mobile.png', fullPage: true });
});

test('shows recorded execution, deferral, and stale decision context on desktop and mobile', async ({
  page,
  request,
}) => {
  const created = await (await request.post('/api/incidents', { data: {} })).json();
  const snapshot: Snapshot = await (await request.get(`/api/incidents/${created.id}`)).json();
  const report = snapshot.incident.reports.at(-1)!;
  report.agent = {
    provider: 'gemini',
    model: 'browser-fixture',
    attemptId: 'browser-fixture',
    findings: [],
    inputArtifacts: [],
    diagnosticDecision: {
      status: 'deferred',
      source: 'agent',
      code: 'agent_deferred',
      recipeId: null,
      consideredRecipeIds: ['production-pool'],
      reason:
        'Browser fixture: request human review of the incident window before this diagnostic.',
      evidenceEpoch: 1,
    },
  };
  await page.route(`**/api/incidents/${created.id}`, (route) => route.fulfill({ json: snapshot }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Activity ledger', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Recorded diagnostic decision' });
  await expect(panel).toContainText('Diagnostics deferred');
  await expect(panel).toContainText('No check was executed in this attempt');
  await expect(panel).toContainText('Check production pool usage');
  await expect(panel).toContainText('Browser fixture: request human review');
  snapshot.incident.reportStatus = 'needs_review';
  await expect(panel).toContainText('The current attempt has not published.');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  await page.screenshot({ path: 'test-results/diagnostic-decision-mobile.png', fullPage: true });
  report.agent.diagnosticDecision = {
    ...report.agent.diagnosticDecision!,
    status: 'executed',
    code: 'completed',
    recipeId: 'production-pool',
    reason: 'Browser fixture: the production pool check was executed.',
  };
  snapshot.incident.reportStatus = 'current';
  await expect(panel).toContainText('Diagnostic executed');
  await expect(panel).toContainText('Executed: Check production pool usage');
  await expect(panel).not.toContainText('No check was executed');
});

test('labels application support notices and keeps earlier wording in report history', async ({
  page,
  request,
}) => {
  // Browser contract fixture; backend tests cover the actual publication gate.
  const created = await (await request.post('/api/incidents', { data: {} })).json();
  const snapshot: Snapshot = await (await request.get(`/api/incidents/${created.id}`)).json();
  const prior = snapshot.incident.reports[0];
  const current = structuredClone(prior);
  current.version = 2;
  current.evidenceEpoch = 2;
  const notice = current.statements.find((s) => s.claimId === 'C5-v1')!;
  Object.assign(notice, {
    status: 'unsupported',
    author: 'gateway',
    disposition: 'revised',
    citationIds: [],
    text: 'Recommendation withheld because required support is missing or invalid.',
    uncertainty: 'Support issues: E6-v1: withdrawn.',
    validatedEpoch: 2,
  });
  snapshot.incident.reports.push(current);
  snapshot.incident.evidenceEpoch = 2;
  await page.route(`**/api/incidents/${created.id}`, (route) => route.fulfill({ json: snapshot }));
  await page.goto('/');
  const card = page
    .locator('.report-statement')
    .filter({ hasText: 'Inspect the payment timeout path' });
  await expect(card).toContainText('Support notice');
  await expect(card).toContainText('Recommendation withheld');
  await expect(card).toContainText('E6-v1: withdrawn');
  await expect(card).not.toContainText('Run a bounded payment');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  await page.screenshot({ path: 'test-results/support-notice-mobile.png', fullPage: true });
  await page.getByRole('button', { name: /Revision diff/ }).click();
  await expect(card.locator('.old-text')).toContainText('Run a bounded payment');
  await expect(card.locator('.new-text')).toContainText('Recommendation withheld');
});
