import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  contextManifestSchema,
  evaluationSchema,
  evidenceSchema,
  incidentSchema,
  reportSchema,
  type ContextManifest,
  type Evaluation,
  type Evidence,
  type Incident,
  type Report,
} from '@aftermath/contracts';
import { openDatabase, type Database, type Sql } from './database';
import { RepairJobs, type JobPolicy } from './jobs';
export { StaleContextError } from './jobs';
import { ConflictError, NotFoundError, lockIncident, saveEvent } from './state';
import { canonical, readArtifacts } from './manifest';
import { assertHistory, reasoningInputs, validateIncident } from './invariants';
export { ConflictError, NotFoundError } from './state';
export { readArtifacts } from './manifest';
export { openDatabase } from './database';
export type { Database, Sql } from './database';
export interface Command {
  key: string;
  fingerprint: string;
}
export interface Publication {
  manifest: ContextManifest;
  report: Report;
  evaluations: Evaluation[];
}

export class Ledger {
  readonly jobs: RepairJobs;
  constructor(
    private readonly db: Database,
    policy?: JobPolicy,
  ) {
    this.jobs = new RepairJobs(db, policy);
  }
  get kind() {
    return this.db.kind;
  }
  static async open(path?: string, url?: string, policy?: JobPolicy) {
    const db = await openDatabase(path, url);
    try {
      await db.transaction(async (tx) => {
        if (db.kind === 'PostgreSQL') await tx.query('SELECT pg_advisory_xact_lock(70600804)');
        await tx.query(
          'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
        );
        for (const name of [
          '001-ledger.sql',
          '002-repair-jobs.sql',
          '003-agent-calls.sql',
          '004-agent-failover.sql',
          '005-attempt-sequence.sql',
        ]) {
          if (
            (await tx.query('SELECT name FROM schema_migrations WHERE name=$1', [name])).rows.length
          )
            continue;
          const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
          for (const statement of sql.split(';').filter((s) => s.trim())) await tx.query(statement);
          await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
        }
      });
      return new Ledger(db, policy);
    } catch (error) {
      await db.close();
      throw error;
    }
  }
  async create(input: Incident): Promise<Incident> {
    const incident = incidentSchema.parse(input);
    incident.events ??= [
      {
        id: randomUUID(),
        seq: 1,
        type: 'incident.created',
        message: 'Incident created.',
        occurredAt: new Date().toISOString(),
      },
    ];
    validateIncident(incident);
    await this.db.transaction(async (tx) => {
      await tx.query('INSERT INTO incidents(id,state) VALUES ($1,$2)', [
        incident.id,
        JSON.stringify(incident),
      ]);
      for (const event of incident.events!)
        await tx.query('INSERT INTO domain_events(incident_id,seq,payload) VALUES ($1,$2,$3)', [
          incident.id,
          event.seq,
          JSON.stringify(event),
        ]);
    });
    return incident;
  }
  async get(id: string): Promise<Incident> {
    const { rows } = await this.db.query<{ state: Incident }>(
      'SELECT state FROM incidents WHERE id=$1',
      [id],
    );
    if (!rows[0]) throw new NotFoundError('Incident not found');
    return incidentSchema.parse(rows[0].state);
  }
  async list(): Promise<Incident[]> {
    const { rows } = await this.db.query<{ state: Incident }>(
      'SELECT state FROM incidents ORDER BY created_at DESC,id LIMIT 25',
    );
    return rows.map((r) => incidentSchema.parse(r.state));
  }
  async events(id: string) {
    await this.get(id);
    const { rows } = await this.db.query<{ payload: NonNullable<Incident['events']>[number] }>(
      'SELECT payload FROM domain_events WHERE incident_id=$1 ORDER BY seq',
      [id],
    );
    return rows.map((r) => r.payload);
  }
  private async command(
    id: string,
    expectedSeq: number,
    command: Command,
    type: string,
    message: string,
    change: (incident: Incident, tx: Sql) => Promise<void>,
  ): Promise<Incident> {
    if (
      !command.key.trim() ||
      !command.fingerprint.trim() ||
      !Number.isSafeInteger(expectedSeq) ||
      expectedSeq < 1
    )
      throw new Error('Invalid command identity or expected sequence');
    return this.db.transaction(async (tx) => {
      const incident = await lockIncident(tx, id);
      const prior = await tx.query<{ fingerprint: string; response: Incident }>(
        'SELECT fingerprint,response FROM commands WHERE incident_id=$1 AND key=$2',
        [id, command.key],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].fingerprint !== command.fingerprint)
          throw new ConflictError('Idempotency key was already used for another command');
        return prior.rows[0].response;
      }
      if (incident.eventSeq !== expectedSeq)
        throw new ConflictError('Incident sequence changed; refresh and retry');
      await change(incident, tx);
      await saveEvent(tx, incident, type, message);
      validateIncident(incident);
      await tx.query(
        'INSERT INTO commands(incident_id,key,fingerprint,response) VALUES ($1,$2,$3,$4)',
        [id, command.key, command.fingerprint, JSON.stringify(incident)],
      );
      return structuredClone(incident);
    });
  }
  async mutate(
    id: string,
    expectedSeq: number,
    command: Command,
    type: string,
    message: string,
    change: (incident: Incident, tx: Sql) => void | Promise<void>,
    scheduleRepair = false,
  ): Promise<Incident> {
    return this.command(id, expectedSeq, command, type, message, async (incident, tx) => {
      const before = structuredClone(incident);
      await change(incident, tx);
      assertHistory(before, incident);
      const changed = reasoningInputs(before) !== reasoningInputs(incident);
      if (
        incident.evidenceEpoch !== before.evidenceEpoch &&
        incident.evidenceEpoch !== before.evidenceEpoch + 1
      )
        throw new ConflictError('Evidence epoch must advance one step');
      if (changed || incident.evidenceEpoch !== before.evidenceEpoch) {
        incident.evidenceEpoch = before.evidenceEpoch + 1;
        incident.reportStatus = 'needs_review';
        incident.evaluations = incident.claims.map((c) => ({
          claimId: c.id,
          status: 'needs_review',
          validGroupIds: [],
          invalidGroups: [],
          originGroupIds: [],
        }));
      } else if (
        incident.reportStatus !== before.reportStatus ||
        canonical(incident.evaluations) !== canonical(before.evaluations)
      ) {
        throw new ConflictError('Evaluation and publication state require fenced publication');
      }
      if (scheduleRepair) {
        if (incident.reportStatus !== 'needs_review')
          throw new ConflictError('Current report does not need repair');
        await this.jobs.ensure(tx, incident);
      }
    });
  }
  async withdraw(id: string, evidenceId: string, reason: string, expectedSeq: number, key: string) {
    if (!reason.trim()) throw new Error('Withdrawal reason is required');
    return this.mutate(
      id,
      expectedSeq,
      { key, fingerprint: canonical(['withdraw', evidenceId, reason, expectedSeq]) },
      'evidence.withdrawn',
      `${evidenceId} withdrawn: ${reason}`,
      (incident) => {
        const source = incident.evidence.find((e) => e.id === evidenceId);
        if (!source) throw new NotFoundError('Evidence version not found');
        if (source.status !== 'active')
          throw new ConflictError('Evidence version is already unavailable');
        source.status = 'withdrawn';
        incident.corrections.push({
          id: randomUUID(),
          targetId: evidenceId,
          reason,
          createdAt: new Date().toISOString(),
          evidenceEpoch: incident.evidenceEpoch + 1,
        });
      },
      true,
    );
  }
  async appendEvidence(id: string, input: Evidence, expectedSeq: number, key: string) {
    const evidence = evidenceSchema.parse(input);
    return this.mutate(
      id,
      expectedSeq,
      { key, fingerprint: canonical(['append-evidence', evidence, expectedSeq]) },
      'evidence.added',
      `Evidence version ${evidence.id} recorded.`,
      (incident) => {
        incident.evidence.push(evidence);
      },
      true,
    );
  }
  async publish(id: string, expectedSeq: number, command: Command, input: Publication) {
    const proposal = {
      manifest: contextManifestSchema.parse(input.manifest),
      report: reportSchema.parse(input.report),
      evaluations: evaluationSchema.array().parse(input.evaluations),
    };
    return this.command(
      id,
      expectedSeq,
      command,
      'report.revised',
      `Report v${proposal.report.version} published.`,
      async (incident, tx) => {
        const { manifest, report, evaluations } = proposal;
        if (
          manifest.projectedSeq !== incident.eventSeq ||
          manifest.evidenceEpoch !== incident.evidenceEpoch ||
          manifest.reportVersion !== (incident.reports.at(-1)?.version ?? 0) ||
          canonical(manifest.readArtifacts) !== canonical(readArtifacts(incident))
        )
          throw new ConflictError('Stale report context');
        if (
          report.version !== manifest.reportVersion + 1 ||
          report.evidenceEpoch !== incident.evidenceEpoch ||
          evaluations.length !== incident.claims.length ||
          report.statements.length !== incident.claims.length ||
          new Set(evaluations.map((e) => e.claimId)).size !== evaluations.length ||
          new Set(report.statements.map((s) => s.claimId)).size !== report.statements.length
        )
          throw new ConflictError('Invalid report revision or evaluation coverage');
        for (const claim of incident.claims) {
          const evaluation = evaluations.find((e) => e.claimId === claim.id);
          const statement = report.statements.find((s) => s.claimId === claim.id);
          if (
            !evaluation ||
            evaluation.status === 'needs_review' ||
            !statement ||
            statement.status !== evaluation.status ||
            statement.validatedEpoch !== incident.evidenceEpoch
          )
            throw new ConflictError('Report statements must match current evaluations');
        }
        incident.evaluations = evaluations;
        incident.reports.push(report);
        incident.reportStatus = 'current';
        incident.reportManifest = manifest;
        await tx.query(
          "UPDATE repair_tasks SET status='superseded', error='A report was published for this incident state.', updated_at=clock_timestamp() WHERE incident_id=$1 AND status='pending'",
          [incident.id],
        );
      },
    );
  }
  async close() {
    await this.db.close();
  }
}
