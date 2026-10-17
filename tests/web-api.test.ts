import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, getSnapshot, request } from '../apps/web/src/api';

afterEach(() => vi.unstubAllGlobals());
it('encodes incident identity and sends mutations with JSON and a bounded signal', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
  vi.stubGlobal('fetch', fetch);
  await expect(getSnapshot('a/b')).resolves.toEqual({ ok: true });
  expect(fetch.mock.calls[0][0]).toBe('/api/incidents/a%2Fb');
  fetch.mockResolvedValue(new Response('{"accepted":true}'));
  await request('/incidents/id/repairs', { expectedEventSeq: 2, idempotencyKey: 'stable-command' });
  expect(fetch.mock.calls[1][1]).toMatchObject({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"expectedEventSeq":2,"idempotencyKey":"stable-command"}',
  });
  expect(fetch.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
});
it('preserves structured conflict errors and reports non-JSON server failures', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response('{"error":"State changed","code":"CONFLICT"}', { status: 409 }),
      ),
  );
  await expect(request('/incidents/id')).rejects.toMatchObject({
    name: 'ApiError',
    status: 409,
    code: 'CONFLICT',
    message: 'State changed',
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
  await expect(request('/incidents/id')).rejects.toEqual(new ApiError('Request failed (503)', 503));
});
it('passes caller cancellation through to fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = vi.fn().mockImplementation((_url, options) => {
    options.signal.throwIfAborted();
  });
  vi.stubGlobal('fetch', fetch);
  await expect(request('/incidents', undefined, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
});

it('requests a snapshot-specific withdrawal preview with encoded identifiers and cancellation', async () => {
  const { previewWithdrawal } = await import('../apps/web/src/api');
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        kind: 'evidence-withdrawal-preview',
        readOnly: true,
        evidenceId: 'evidence/id',
        snapshot: {
          incidentId: 'incident/id',
          eventSeq: 7,
          evidenceEpoch: 1,
          reportVersion: 1,
          fingerprint: 'a'.repeat(64),
        },
        affectedClaimIds: [],
        claims: [],
        paths: [],
        conclusions: [],
        services: [],
      }),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  await previewWithdrawal('incident/id', 'evidence/id', 7, controller.signal);
  expect(fetch.mock.calls[0][0]).toBe(
    '/api/incidents/incident%2Fid/evidence/evidence%2Fid/withdrawal-preview',
  );
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"expectedEventSeq":7}' });
  controller.abort();
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
});

it('rejects malformed successful preview responses instead of presenting an unsafe comparison', async () => {
  const { previewWithdrawal } = await import('../apps/web/src/api');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"readOnly":true}')));
  await expect(previewWithdrawal('incident', 'E1-v1', 1)).rejects.toThrow(
    'Invalid withdrawal preview response',
  );
});
