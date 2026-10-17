import type { Incident, Snapshot } from '@aftermath/contracts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(
      error.error || `Request failed (${response.status})`,
      response.status,
      error.code,
    );
  }
  return response.json() as Promise<T>;
}
export type IncidentSummary = Pick<Incident, 'id' | 'title' | 'eventSeq'>;
export const listIncidents = () => request<IncidentSummary[]>('/incidents');
export const getSnapshot = (id: string) =>
  request<Snapshot>(`/incidents/${encodeURIComponent(id)}`);
export function savedIncident() {
  try {
    return localStorage.getItem('aftermath.incident');
  } catch {
    return null;
  }
}
export function rememberIncident(id: string) {
  try {
    localStorage.setItem('aftermath.incident', id);
  } catch {
    /* Storage may be disabled. */
  }
}

export const previewWithdrawal = (
  incidentId: string,
  evidenceId: string,
  expectedEventSeq: number,
  signal?: AbortSignal,
) =>
  request<import('@aftermath/contracts').WithdrawalPreview>(
    `/incidents/${encodeURIComponent(incidentId)}/evidence/${encodeURIComponent(evidenceId)}/withdrawal-preview`,
    { expectedEventSeq },
    signal,
  );
