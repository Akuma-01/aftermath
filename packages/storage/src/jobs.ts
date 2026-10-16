import { randomUUID } from 'node:crypto';
import {
  contextManifestSchema,
  agentConfigSchema,
  type AgentConfig,
  type AgentRole,
  type ContextManifest,
  type ModelCallDetail,
  type ModelCallSummary,
  type ToolCallSummary,
  type ToolCallDetail,
  evaluationSchema,
  reportSchema,
  impactSchema,
  type Incident,
  type RepairAttempt,
  type RepairProposal,
  type RepairTask,
} from '@aftermath/contracts';
import type { Database, Sql } from './database';
import { ConflictError, NotFoundError, lockIncident, saveEvent } from './state';
import { canonical, readArtifacts } from './manifest';
import { assertHistory, validateIncident } from './invariants';
const taskColumns = `id, incident_id AS "incidentId", evidence_epoch AS "evidenceEpoch", kind, status,
 attempt_count AS "attemptCount", max_attempts AS "maxAttempts", active_attempt_id AS "activeAttemptId",
 pause_before_commit AS "pauseBeforeCommit", delivery_version AS "deliveryVersion", lease_until AS "leaseUntil",
 created_at AS "createdAt", updated_at AS "updatedAt", error, report_version AS "reportVersion"`;
const attemptColumns = `id, task_id AS "taskId", incident_id AS "incidentId", number, evidence_epoch AS "evidenceEpoch",
 status, input_seq AS "inputSeq", started_at AS "startedAt", finished_at AS "finishedAt", reason, manifest, report_version AS "reportVersion"`;
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export interface JobPolicy {
  leaseMs?: number;
  retryDelayMs?: number;
}
export interface ClaimedRepair {
  task: RepairTask;
  attempt: RepairAttempt;
  incident: Incident;
  proposal: RepairProposal | null;
}
export type CommitOutcome = 'accepted' | 'paused' | 'stale' | 'ignored' | 'failed';
export class StaleContextError extends Error {
  override name = 'StaleContextError';
}
const callColumns = `id, attempt_id AS "attemptId", role, provider, model, status,
 started_at AS "startedAt", finished_at AS "finishedAt", latency_ms AS "latencyMs",
 input_tokens AS "inputTokens", output_tokens AS "outputTokens", error,
 credential_slot AS "credentialSlot", failover_from_call_id AS "failoverFromCallId"`;

const publicationEvents = new Set([
  'attempt.paused',
  'attempt.resumed',
  'repair.resumed',
  'agent.call_started',
]);

export class RepairJobs {
  readonly leaseMs: number;
  readonly retryDelayMs: number;
  constructor(
    private readonly db: Database,
    policy: JobPolicy = {},
  ) {
    this.leaseMs = policy.leaseMs ?? 30000;
    this.retryDelayMs = policy.retryDelayMs ?? 1000;
    if (
      !Number.isFinite(this.leaseMs) ||
      this.leaseMs < 0 ||
      !Number.isFinite(this.retryDelayMs) ||
      this.retryDelayMs < 0
    )
      throw new Error('Invalid job timing policy');
  }
  async work(incidentId: string) {
    const tasks = await this.db.query<RepairTask>(
      `SELECT ${taskColumns} FROM repair_tasks WHERE incident_id=$1 ORDER BY created_at,id`,
      [incidentId],
    );
    const attempts = await this.db.query<RepairAttempt>(
      `SELECT ${attemptColumns} FROM repair_attempts WHERE incident_id=$1 ORDER BY started_at,id`,
      [incidentId],
    );
    const modelCalls = await this.db.query<ModelCallSummary>(
      `SELECT ${callColumns} FROM model_calls WHERE incident_id=$1 ORDER BY started_at,id`,
      [incidentId],
    );
    const toolCalls = await this.db.query<ToolCallSummary>(
      `SELECT id, attempt_id AS "attemptId", model_call_id AS "modelCallId", role, name, status, created_at AS "createdAt" FROM agent_tool_calls WHERE incident_id=$1 ORDER BY created_at,id`,
      [incidentId],
    );
    return json({
      tasks: tasks.rows,
      attempts: attempts.rows,
      modelCalls: modelCalls.rows,
      toolCalls: toolCalls.rows,
    });
  }
  async modelCallDetail(incidentId: string, callId: string) {
    const result = await this.db.query<ModelCallDetail>(
      `SELECT ${callColumns}, request, response, manifest FROM model_calls WHERE id=$1 AND incident_id=$2`,
      [callId, incidentId],
    );
    if (!result.rows[0]) throw new NotFoundError('Model call not found');
    return json(result.rows[0]);
  }
  async modelCallsUsed(taskId: string) {
    const result = await this.db.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM model_calls WHERE task_id=$1',
      [taskId],
    );
    return result.rows[0].count;
  }
  async toolCallDetail(incidentId: string, toolCallId: string) {
    const result = await this.db.query<ToolCallDetail>(
      `SELECT id, attempt_id AS "attemptId", model_call_id AS "modelCallId", role, name, status,
       created_at AS "createdAt", arguments, result, manifest
       FROM agent_tool_calls WHERE id=$1 AND incident_id=$2`,
      [toolCallId, incidentId],
    );
    if (!result.rows[0]) throw new NotFoundError('Tool call not found');
    return json(result.rows[0]);
  }
  private async assertContext(
    tx: Sql,
    incident: Incident,
    task: RepairTask & { leaseValid: boolean },
    attemptId: string,
    manifest: ContextManifest,
  ) {
    contextManifestSchema.parse(manifest);
    const attempt = (
      await tx.query<{ input_seq: number }>(
        'SELECT input_seq FROM repair_attempts WHERE id=$1 AND task_id=$2',
        [attemptId, task.id],
      )
    ).rows[0];
    if (
      !attempt ||
      manifest.projectedSeq !== attempt.input_seq ||
      (incident.events ?? []).some(
        (e) => e.seq > manifest.projectedSeq && !publicationEvents.has(e.type),
      ) ||
      task.evidenceEpoch !== incident.evidenceEpoch ||
      task.status !== 'running' ||
      task.activeAttemptId !== attemptId ||
      !task.leaseValid ||
      manifest.evidenceEpoch !== incident.evidenceEpoch ||
      manifest.reportVersion !== incident.reports.at(-1)!.version ||
      JSON.stringify(manifest.readArtifacts) !== JSON.stringify(readArtifacts(incident))
    )
      throw new StaleContextError(
        'The agent context or worker ownership changed. This attempt cannot publish.',
      );
  }
  async reserveModelCall(
    taskId: string,
    attemptId: string,
    role: AgentRole,
    config: AgentConfig,
    request: unknown,
    manifest: ContextManifest,
    routing?: Pick<ModelCallSummary, 'credentialSlot' | 'failoverFromCallId'>,
  ) {
    const id = randomUUID();
    const reserved = await this.locked(taskId, async (tx, incident, task) => {
      await this.assertContext(tx, incident, task, attemptId, manifest);
      agentConfigSchema.parse(config);
      if (canonical(config) !== canonical(incident.agentConfig))
        throw new StaleContextError('Agent configuration changed.');
      const { rows } = await tx.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM model_calls WHERE task_id=$1',
        [taskId],
      );
      if (rows[0].count >= config.maxCalls)
        throw new Error('Model call budget exhausted for this task, including prior attempts.');
      if (Buffer.byteLength(JSON.stringify(request)) > config.maxContextBytes)
        throw new Error('Model context exceeds the configured byte budget.');
      await tx.query(
        `INSERT INTO model_calls(id,task_id,attempt_id,incident_id,role,provider,model,status,request,manifest,credential_slot,failover_from_call_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8,$9,$10,$11)`,
        [
          id,
          taskId,
          attemptId,
          incident.id,
          role,
          config.provider,
          config.model,
          JSON.stringify(request),
          JSON.stringify(manifest),
          routing?.credentialSlot ?? null,
          routing?.failoverFromCallId ?? null,
        ],
      );
      await tx.query('UPDATE repair_attempts SET manifest=$2 WHERE id=$1', [
        attemptId,
        JSON.stringify(manifest),
      ]);
      await saveEvent(
        tx,
        incident,
        'agent.call_started',
        `${role} requested ${config.provider}/${config.model}. Input context is recorded.`,
      );
      return id;
    });
    if (!reserved) throw new StaleContextError('Worker task no longer exists');
    return reserved;
  }
  async completeModelCall(
    id: string,
    result: {
      response: unknown;
      inputTokens: number | null;
      outputTokens: number | null;
      latencyMs: number;
      error: string | null;
    },
  ) {
    await this.db.query(
      `UPDATE model_calls SET status=$2, response=$3, input_tokens=$4, output_tokens=$5, latency_ms=$6, error=$7, finished_at=clock_timestamp() WHERE id=$1 AND status='running'`,
      [
        id,
        result.error ? 'failed' : 'succeeded',
        JSON.stringify(result.response),
        result.inputTokens,
        result.outputTokens,
        result.latencyMs,
        result.error,
      ],
    );
  }
  async recordToolCall(
    attemptId: string,
    modelCallId: string,
    role: AgentRole,
    name: string,
    args: unknown,
    result: unknown,
    manifest: ContextManifest,
    status: ToolCallSummary['status'],
  ) {
    const id = randomUUID();
    const inserted = await this.db.query(
      `INSERT INTO agent_tool_calls(id,attempt_id,model_call_id,incident_id,role,name,status,arguments,result,manifest)
      SELECT $1,$2,$3,incident_id,$4,$5,$6,$7,$8,$9 FROM model_calls WHERE id=$3 AND attempt_id=$2 AND role=$4 RETURNING id`,
      [
        id,
        attemptId,
        modelCallId,
        role,
        name,
        status,
        JSON.stringify(args),
        JSON.stringify(result),
        JSON.stringify(manifest),
      ],
    );
    if (!inserted.rows.length) throw new NotFoundError('Matching model call not found');
    return id;
  }
  async applyAgentDiagnostic(
    taskId: string,
    attemptId: string,
    manifest: ContextManifest,
    recipeId: string,
    change: (incident: Incident) => void,
  ) {
    const result = await this.locked(taskId, async (tx, incident, task) => {
      await this.assertContext(tx, incident, task, attemptId, manifest);
      if (task.kind !== 'repair') throw new ConflictError('Held reports cannot run diagnostics');
      const before = structuredClone(incident);
      change(incident);
      assertHistory(before, incident);
      if (incident.evidenceEpoch !== before.evidenceEpoch + 1)
        throw new ConflictError('Diagnostic must advance one evidence epoch');
      await tx.query(
        'UPDATE repair_tasks SET evidence_epoch=$2, updated_at=clock_timestamp() WHERE id=$1',
        [taskId, incident.evidenceEpoch],
      );
      await tx.query('UPDATE repair_attempts SET evidence_epoch=$2 WHERE id=$1', [
        attemptId,
        incident.evidenceEpoch,
      ]);
      await saveEvent(
        tx,
        incident,
        'agent.diagnostic_completed',
        `Investigator ran the read-only ${recipeId} diagnostic. The agent context will be refreshed.`,
      );
      await tx.query('UPDATE repair_attempts SET input_seq=$2 WHERE id=$1', [
        attemptId,
        incident.eventSeq,
      ]);
      validateIncident(incident);
      return incident;
    });
    if (!result) throw new StaleContextError('Worker task no longer exists');
    return result;
  }
  async rejectStale(taskId: string, attemptId: string, reason: string) {
    await this.locked(taskId, async (tx, incident, task) => {
      if (task.activeAttemptId !== attemptId || task.status !== 'running') return;
      await tx.query(
        `UPDATE repair_attempts SET status='stale', finished_at=clock_timestamp(), reason=$2 WHERE id=$1`,
        [attemptId, reason],
      );
      await tx.query(
        `UPDATE repair_tasks SET status='superseded', lease_until=NULL, error=$2 WHERE id=$1`,
        [taskId, reason],
      );
      if (incident.reportStatus === 'needs_review' && task.kind === 'repair')
        await this.ensure(tx, incident);
      await saveEvent(tx, incident, 'attempt.rejected_stale', reason);
    });
  }
  private async delivery(tx: Sql, taskId: string, version: number) {
    await tx.query(
      'INSERT INTO repair_outbox(id, task_id, delivery_version) VALUES ($1, $2, $3) ON CONFLICT(task_id, delivery_version) DO NOTHING',
      [randomUUID(), taskId, version],
    );
  }
  async ensure(tx: Sql, incident: Incident, kind: RepairTask['kind'] = 'repair'): Promise<string> {
    // Caller owns the incident row lock. There is one active task for each repair generation.
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM repair_tasks WHERE incident_id = $1 AND kind = $2 AND status IN ('pending','running','paused') AND ($2 = 'report_preview' OR evidence_epoch = $3) ORDER BY created_at LIMIT 1`,
      [incident.id, kind, incident.evidenceEpoch],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const id = randomUUID();
    await tx.query(
      `INSERT INTO repair_tasks(id, incident_id, evidence_epoch, kind, status, pause_before_commit) VALUES ($1,$2,$3,$4,'pending',$5)`,
      [id, incident.id, incident.evidenceEpoch, kind, kind === 'report_preview'],
    );
    await this.delivery(tx, id, 1);
    incident.repairError = null;
    return id;
  }
  async resume(tx: Sql, incident: Incident, taskId: string) {
    const result = await tx.query<RepairTask>(
      `SELECT ${taskColumns} FROM repair_tasks WHERE id = $1 AND incident_id = $2 FOR UPDATE`,
      [taskId, incident.id],
    );
    const task = result.rows[0];
    if (!task) throw new NotFoundError('Repair task not found');
    if (task.status !== 'paused') throw new ConflictError('This attempt is not waiting for resume');
    await tx.query(
      `UPDATE repair_tasks SET status='pending', pause_before_commit=false, delivery_version=delivery_version+1, available_at=clock_timestamp(), updated_at=clock_timestamp() WHERE id=$1`,
      [taskId],
    );
    await this.delivery(tx, taskId, task.deliveryVersion + 1);
  }
  private async locked<T>(
    taskId: string,
    run: (
      tx: Sql,
      incident: Incident,
      task: RepairTask & { leaseValid: boolean; available: boolean },
    ) => Promise<T>,
  ): Promise<T | null> {
    const lookup = await this.db.query<{ incident_id: string }>(
      'SELECT incident_id FROM repair_tasks WHERE id=$1',
      [taskId],
    );
    if (!lookup.rows[0]) return null;
    return this.db.transaction(async (tx) => {
      // All paths take locks in the same order: incident, task, then attempt.
      const incident = await lockIncident(tx, lookup.rows[0].incident_id);
      const result = await tx.query<RepairTask & { leaseValid: boolean; available: boolean }>(
        `SELECT ${taskColumns}, lease_until > clock_timestamp() AS "leaseValid", available_at <= clock_timestamp() AS available FROM repair_tasks WHERE id=$1 FOR UPDATE`,
        [taskId],
      );
      return run(tx, incident, json(result.rows[0]));
    });
  }
  async claim(taskId: string): Promise<ClaimedRepair | null> {
    return this.locked(taskId, async (tx, incident, task) => {
      if (task.status !== 'pending' || !task.available) return null;
      const prior = task.activeAttemptId
        ? (
            await tx.query<RepairAttempt & { proposal: RepairProposal }>(
              `SELECT ${attemptColumns}, proposal FROM repair_attempts WHERE id=$1`,
              [task.activeAttemptId],
            )
          ).rows[0]
        : undefined;
      if (prior?.status === 'paused' && prior.proposal) {
        await tx.query(
          `UPDATE repair_tasks SET status='running', lease_until=clock_timestamp()+($2 * interval '1 millisecond'), updated_at=clock_timestamp() WHERE id=$1`,
          [task.id, this.leaseMs],
        );
        await tx.query(`UPDATE repair_attempts SET status='running' WHERE id=$1`, [prior.id]);
        await saveEvent(
          tx,
          incident,
          'attempt.resumed',
          'The held report attempt resumed with its original evidence context.',
        );
        return {
          task,
          attempt: { ...prior, status: 'running' as const },
          incident,
          proposal: prior.proposal,
        };
      }
      if (
        incident.evidenceEpoch !== task.evidenceEpoch ||
        (task.kind === 'repair' && incident.reportStatus === 'current')
      ) {
        await tx.query(
          `UPDATE repair_tasks SET status='superseded', error='A newer evidence state or accepted report superseded this task.', updated_at=clock_timestamp() WHERE id=$1`,
          [task.id],
        );
        return null;
      }
      const attemptId = randomUUID();
      const number = task.attemptCount + 1;
      await tx.query(
        `INSERT INTO repair_attempts(id, task_id, incident_id, number, evidence_epoch, status) VALUES ($1,$2,$3,$4,$5,'running')`,
        [attemptId, task.id, incident.id, number, task.evidenceEpoch],
      );
      await tx.query(
        `UPDATE repair_tasks SET status='running', attempt_count=$2, active_attempt_id=$3, lease_until=clock_timestamp()+($4 * interval '1 millisecond'), updated_at=clock_timestamp() WHERE id=$1`,
        [task.id, number, attemptId, this.leaseMs],
      );
      await saveEvent(
        tx,
        incident,
        'attempt.started',
        `${task.kind === 'repair' ? 'Automatic repair' : 'Held report preparation'} attempt ${number} started against evidence epoch ${task.evidenceEpoch}.`,
      );
      await tx.query('UPDATE repair_attempts SET input_seq=$2 WHERE id=$1', [
        attemptId,
        incident.eventSeq,
      ]);
      const attempt = (
        await tx.query<RepairAttempt>(`SELECT ${attemptColumns} FROM repair_attempts WHERE id=$1`, [
          attemptId,
        ])
      ).rows[0];
      return {
        task: { ...task, status: 'running', activeAttemptId: attemptId, attemptCount: number },
        attempt: json(attempt),
        incident,
        proposal: null,
      };
    });
  }
  async heartbeat(taskId: string, attemptId: string) {
    const result = await this.db.query<{ id: string }>(
      `UPDATE repair_tasks SET lease_until=clock_timestamp()+($3 * interval '1 millisecond') WHERE id=$1 AND active_attempt_id=$2 AND status='running' AND lease_until > clock_timestamp() RETURNING id`,
      [taskId, attemptId, this.leaseMs],
    );
    return result.rows.length === 1;
  }
  private async failed(tx: Sql, incident: Incident, task: RepairTask, reason: string) {
    await tx.query(
      `UPDATE repair_attempts SET status='failed', finished_at=clock_timestamp(), reason=$2 WHERE id=$1 AND status='running'`,
      [task.activeAttemptId, reason],
    );
    const obsolete =
      task.evidenceEpoch !== incident.evidenceEpoch ||
      (task.kind === 'repair' && incident.reportStatus === 'current');
    const retry = !obsolete && task.attemptCount < task.maxAttempts;
    await tx.query(
      `UPDATE repair_tasks SET status=$2, active_attempt_id=NULL, lease_until=NULL, error=$3, delivery_version=delivery_version+1, available_at=clock_timestamp()+($4 * interval '1 millisecond'), updated_at=clock_timestamp() WHERE id=$1`,
      [
        task.id,
        obsolete ? 'superseded' : retry ? 'pending' : 'failed',
        reason,
        this.retryDelayMs * 2 ** Math.max(0, task.attemptCount - 1),
      ],
    );
    if (retry) await this.delivery(tx, task.id, task.deliveryVersion + 1);
    if (!obsolete && task.kind === 'repair')
      incident.repairError = retry
        ? null
        : 'Automatic repair failed after three attempts. The previous report remains under review. Retry when the service is available.';
    await saveEvent(
      tx,
      incident,
      'attempt.failed',
      `Attempt ${task.attemptCount} failed: ${reason}${retry ? ' A bounded retry was scheduled.' : ''}`,
    );
  }
  async fail(taskId: string, attemptId: string, reason: string) {
    return this.locked(taskId, async (tx, incident, task) => {
      if (task.status !== 'running' || task.activeAttemptId !== attemptId) return;
      await this.failed(tx, incident, task, reason.slice(0, 1500));
    });
  }
  async finish(taskId: string, attemptId: string, input: RepairProposal): Promise<CommitOutcome> {
    return (
      (await this.locked(taskId, async (tx, incident, task): Promise<CommitOutcome> => {
        const attempt = (
          await tx.query<RepairAttempt>(
            `SELECT ${attemptColumns} FROM repair_attempts WHERE id=$1 AND task_id=$2`,
            [attemptId, taskId],
          )
        ).rows[0];
        if (attempt?.status === 'accepted') return 'accepted';
        if (!attempt || task.status !== 'running' || task.activeAttemptId !== attemptId)
          return 'ignored';
        if (!task.leaseValid) {
          await this.failed(tx, incident, task, 'Worker lease expired before publication.');
          return 'failed';
        }
        const proposal = {
          ...input,
          manifest: contextManifestSchema.parse(input.manifest),
          report: reportSchema.parse(input.report),
          evaluations: evaluationSchema.array().parse(input.evaluations),
          impact: impactSchema.parse(input.impact),
        };
        const lifecycle = publicationEvents;
        const stale =
          proposal.manifest.projectedSeq !== attempt.inputSeq ||
          (incident.events ?? []).some(
            (e) => e.seq > proposal.manifest.projectedSeq && !lifecycle.has(e.type),
          ) ||
          task.evidenceEpoch !== incident.evidenceEpoch ||
          proposal.manifest.evidenceEpoch !== incident.evidenceEpoch ||
          proposal.manifest.reportVersion !== incident.reports.at(-1)!.version ||
          JSON.stringify(proposal.manifest.readArtifacts) !==
            JSON.stringify(readArtifacts(incident));
        await tx.query('UPDATE repair_attempts SET manifest=$2 WHERE id=$1', [
          attemptId,
          JSON.stringify(proposal.manifest),
        ]);
        if (stale) {
          const reason =
            'Evidence changed while this result was being prepared, or another report superseded its input revision.';
          await tx.query(
            `UPDATE repair_attempts SET status='stale', finished_at=clock_timestamp(), reason=$2 WHERE id=$1`,
            [attemptId, reason],
          );
          await tx.query(
            `UPDATE repair_tasks SET status='superseded', lease_until=NULL, error=$2, updated_at=clock_timestamp() WHERE id=$1`,
            [taskId, reason],
          );
          if (incident.reportStatus === 'needs_review' && task.kind === 'repair')
            await this.ensure(tx, incident);
          await saveEvent(tx, incident, 'attempt.rejected_stale', reason);
          return 'stale';
        }
        validatePublication(incident, proposal);
        if (task.pauseBeforeCommit) {
          await tx.query(`UPDATE repair_attempts SET status='paused', proposal=$2 WHERE id=$1`, [
            attemptId,
            JSON.stringify(proposal),
          ]);
          await tx.query(
            `UPDATE repair_tasks SET status='paused', lease_until=NULL, updated_at=clock_timestamp() WHERE id=$1`,
            [taskId],
          );
          await saveEvent(
            tx,
            incident,
            'attempt.paused',
            'Report prepared and held before publication. Change evidence, then resume to test the commit gate.',
          );
          return 'paused';
        }
        incident.reportManifest = proposal.manifest;
        incident.evaluations = proposal.evaluations;
        incident.reports.push(proposal.report);
        incident.reportStatus = 'current';
        incident.lastImpact = proposal.impact;
        incident.repairError = null;
        await tx.query(
          `UPDATE repair_attempts SET status='accepted', finished_at=clock_timestamp(), report_version=$2 WHERE id=$1`,
          [attemptId, proposal.report.version],
        );
        await tx.query(
          `UPDATE repair_tasks SET status='completed', lease_until=NULL, report_version=$2, updated_at=clock_timestamp(), error=NULL WHERE id=$1`,
          [taskId, proposal.report.version],
        );
        await saveEvent(
          tx,
          incident,
          'report.revised',
          `Report v${proposal.report.version} published by attempt ${attempt.number}. Unchanged findings were revalidated.`,
        );
        validateIncident(incident);
        return 'accepted';
      })) ?? 'ignored'
    );
  }
  async recoverExpired() {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM repair_tasks WHERE status='running' AND lease_until <= clock_timestamp() LIMIT 100`,
    );
    for (const { id } of rows.rows)
      await this.locked(id, async (tx, incident, task) => {
        if (task.status === 'running' && !task.leaseValid)
          await this.failed(
            tx,
            incident,
            task,
            'Worker stopped renewing its lease. The attempt cannot publish.',
          );
      });
  }
  async backfill() {
    const rows = await this.db.query<{ id: string }>(
      `SELECT i.id FROM incidents i WHERE i.state->>'reportStatus'='needs_review' AND NOT EXISTS (SELECT 1 FROM repair_tasks t WHERE t.incident_id=i.id AND t.kind='repair' AND t.evidence_epoch=(i.state->>'evidenceEpoch')::integer)`,
    );
    for (const { id } of rows.rows)
      await this.db.transaction(async (tx) => {
        const incident = await lockIncident(tx, id);
        if (incident.reportStatus !== 'needs_review') return;
        const existing = await tx.query(
          "SELECT id FROM repair_tasks WHERE incident_id=$1 AND evidence_epoch=$2 AND kind='repair'",
          [id, incident.evidenceEpoch],
        );
        if (existing.rows.length) return;
        await this.ensure(tx, incident);
        await saveEvent(
          tx,
          incident,
          'repair.recovered',
          'Pending report recovered into durable repair scheduling.',
        );
      });
  }
  async deliveries() {
    return (
      await this.db.query<{ id: string; taskId: string }>(
        `SELECT o.id, o.task_id AS "taskId" FROM repair_outbox o JOIN repair_tasks t ON t.id=o.task_id AND t.delivery_version=o.delivery_version WHERE t.status='pending' AND t.available_at <= clock_timestamp() AND (o.delivered_at IS NULL OR o.delivered_at < clock_timestamp()-interval '5 seconds') ORDER BY o.created_at LIMIT 50`,
      )
    ).rows;
  }
  async delivered(id: string) {
    await this.db.query('UPDATE repair_outbox SET delivered_at=clock_timestamp() WHERE id=$1', [
      id,
    ]);
  }
}

function validatePublication(incident: Incident, proposal: RepairProposal) {
  const { report, evaluations, manifest, impact } = proposal;
  if (
    impact.graphGeneration !== manifest.graphGeneration ||
    report.version !== manifest.reportVersion + 1 ||
    report.evidenceEpoch !== incident.evidenceEpoch ||
    evaluations.length !== incident.claims.length ||
    report.statements.length !== incident.claims.length ||
    new Set(evaluations.map((e) => e.claimId)).size !== evaluations.length ||
    new Set(report.statements.map((s) => s.claimId)).size !== report.statements.length
  )
    throw new ConflictError('Invalid repair publication');
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
      throw new ConflictError('Invalid repair evaluation coverage');
  }
}
