import { randomUUID } from 'node:crypto';
import type { Incident } from '@aftermath/contracts';
import type { Database, Sql } from './database';

/** Durable scheduling only. Claiming, leases and execution arrive with repair workers. */
export class RepairJobs {
  constructor(private readonly db: Database) {}
  async ensure(tx: Sql, incident: Incident): Promise<string> {
    const existing = await tx.query<{ id: string }>(
      "SELECT id FROM repair_tasks WHERE incident_id=$1 AND evidence_epoch=$2 AND kind='repair' AND status IN ('pending','running','paused')",
      [incident.id, incident.evidenceEpoch],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const id = randomUUID();
    await tx.query(
      "INSERT INTO repair_tasks(id,incident_id,evidence_epoch,kind,status) VALUES ($1,$2,$3,'repair','pending')",
      [id, incident.id, incident.evidenceEpoch],
    );
    await tx.query('INSERT INTO repair_outbox(id,task_id,delivery_version) VALUES ($1,$2,1)', [
      randomUUID(),
      id,
    ]);
    return id;
  }
  async work(incidentId: string) {
    const tasks = await this.db.query<{ id: string; evidenceEpoch: number; status: string }>(
      'SELECT id,evidence_epoch AS "evidenceEpoch",status FROM repair_tasks WHERE incident_id=$1 ORDER BY created_at,id',
      [incidentId],
    );
    const attempts = await this.db.query<{ id: string; status: string }>(
      'SELECT id,status FROM repair_attempts WHERE incident_id=$1 ORDER BY started_at,id',
      [incidentId],
    );
    const modelCalls = await this.db.query<{ id: string; status: string }>(
      'SELECT id,status FROM model_calls WHERE incident_id=$1 ORDER BY started_at,id',
      [incidentId],
    );
    const toolCalls = await this.db.query<{ id: string; status: string }>(
      'SELECT id,status FROM agent_tool_calls WHERE incident_id=$1 ORDER BY created_at,id',
      [incidentId],
    );
    return {
      tasks: tasks.rows,
      attempts: attempts.rows,
      modelCalls: modelCalls.rows,
      toolCalls: toolCalls.rows,
    };
  }
}
