import { randomUUID } from 'node:crypto';
import type { Incident } from '@aftermath/contracts';
import type { Sql } from './database';

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export async function lockIncident(tx: Sql, id: string): Promise<Incident> {
  const result = await tx.query<{ state: Incident }>(
    'SELECT state FROM incidents WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!result.rows[0]) throw new NotFoundError('Incident not found');
  return result.rows[0].state;
}
export async function saveEvent(tx: Sql, incident: Incident, type: string, message: string) {
  incident.eventSeq++;
  const event = {
    id: randomUUID(),
    seq: incident.eventSeq,
    type,
    message,
    occurredAt: new Date().toISOString(),
  };
  (incident.events ??= []).push(event);
  await tx.query('UPDATE incidents SET state = $2 WHERE id = $1', [
    incident.id,
    JSON.stringify(incident),
  ]);
  await tx.query('INSERT INTO domain_events(incident_id, seq, payload) VALUES ($1, $2, $3)', [
    incident.id,
    incident.eventSeq,
    JSON.stringify(event),
  ]);
}
