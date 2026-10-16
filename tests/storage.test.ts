import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIncident } from '@aftermath/fixtures';
import { Ledger, openDatabase, readArtifacts, type Database } from '@aftermath/storage';
import { makeReport, evaluateSupport } from '@aftermath/domain';

let ledger: Ledger;
let sql: Database;
let directory: string;
const url = process.env.STORAGE_TEST_DATABASE_URL;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'aftermath-storage-'));
  if (url) {
    const opened = await Promise.all([Ledger.open(undefined, url), Ledger.open(undefined, url)]);
    ledger = opened[0];
    await opened[1].close();
  } else ledger = await Ledger.open(join(directory, 'ledger'));
  // A separate PGlite handle cannot share a live data directory. SQL tests use their own store.
  sql = await openDatabase(undefined, url);
});
afterAll(async () => {
  await ledger?.close();
  await sql?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function create() {
  const incident = createIncident();
  incident.id = randomUUID();
  return ledger.create(incident);
}
function command(key = randomUUID()) {
  return { key, fingerprint: key };
}

it('initializes the requested real database and returns independent durable snapshots', async () => {
  expect(ledger.kind).toBe(url ? 'PostgreSQL' : 'PGlite');
  const incident = await create();
  expect(await ledger.get(incident.id)).toEqual(incident);
  expect(await ledger.events(incident.id)).toEqual(incident.events);
  expect((await ledger.list()).some((i) => i.id === incident.id)).toBe(true);
  incident.evidence[0].content = 'caller mutation';
  expect((await ledger.get(incident.id)).evidence[0].content).not.toBe('caller mutation');
  await expect(ledger.get('missing')).rejects.toThrow('not found');
  await expect(ledger.create(await ledger.get(incident.id))).rejects.toThrow();
});

it('persists migrations, incidents and command responses across close/reopen', async () => {
  const path = join(directory, 'restart');
  let persistent = await Ledger.open(url ? undefined : path, url);
  const fixture = createIncident();
  fixture.id = randomUUID();
  const initial = await persistent.create(fixture);
  const key = randomUUID();
  const changed = await persistent.withdraw(initial.id, 'E1-v1', 'Invalid source', 1, key);
  await persistent.close();
  persistent = await Ledger.open(url ? undefined : path, url);
  try {
    expect(await persistent.get(initial.id)).toEqual(changed);
    expect(await persistent.withdraw(initial.id, 'E1-v1', 'Invalid source', 1, key)).toEqual(
      changed,
    );
    expect(await persistent.events(initial.id)).toHaveLength(2);
  } finally {
    await persistent.close();
  }
});

it('atomically withdraws evidence, appends correction/events and schedules one outbox task', async () => {
  const incident = await create();
  const key = randomUUID();
  const changed = await ledger.withdraw(incident.id, 'E1-v1', 'Staging source', 1, key);
  expect(changed).toMatchObject({ eventSeq: 2, evidenceEpoch: 2, reportStatus: 'needs_review' });
  expect(changed.reports).toEqual(incident.reports);
  expect(changed.evidence[0]).toEqual({ ...incident.evidence[0], status: 'withdrawn' });
  expect(changed.corrections).toHaveLength(1);
  expect(changed.evaluations.every((e) => e.status === 'needs_review')).toBe(true);
  expect(await ledger.withdraw(incident.id, 'E1-v1', 'Staging source', 1, key)).toEqual(changed);
  await expect(ledger.withdraw(incident.id, 'E2-v1', 'Staging source', 1, key)).rejects.toThrow(
    'Idempotency',
  );
  expect((await ledger.jobs.work(incident.id)).tasks).toHaveLength(1);
  const again = await ledger.mutate(
    incident.id,
    2,
    command(),
    'repair.requested',
    'Repair requested.',
    () => {},
    true,
  );
  expect(again.eventSeq).toBe(3);
  expect((await ledger.jobs.work(incident.id)).tasks).toHaveLength(1);
});

it('accepts only one concurrent command with the same expected sequence', async () => {
  const incident = await create();
  const results = await Promise.allSettled([
    ledger.withdraw(incident.id, 'E1-v1', 'First correction', 1, randomUUID()),
    ledger.withdraw(incident.id, 'E2-v1', 'Second correction', 1, randomUUID()),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect((await ledger.get(incident.id)).corrections).toHaveLength(1);
  expect(await ledger.events(incident.id)).toHaveLength(2);
});

it('serializes duplicate concurrent command retries without duplicate events', async () => {
  const incident = await create();
  const key = randomUUID();
  const results = await Promise.all([
    ledger.withdraw(incident.id, 'E1-v1', 'Same request', 1, key),
    ledger.withdraw(incident.id, 'E1-v1', 'Same request', 1, key),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(await ledger.events(incident.id)).toHaveLength(2);
});

it('rolls back SQL side effects, state and command receipts on failure', async () => {
  const incident = await create();
  const cmd = command();
  await expect(
    ledger.mutate(incident.id, 1, cmd, 'test.failed', 'Failure test', async (i, tx) => {
      i.title = 'Must roll back';
      await ledger.jobs.ensure(tx, i);
      throw new Error('Interrupted command');
    }),
  ).rejects.toThrow('Interrupted');
  expect(await ledger.get(incident.id)).toEqual(incident);
  expect((await ledger.jobs.work(incident.id)).tasks).toEqual([]);
  const retried = await ledger.mutate(incident.id, 1, cmd, 'test.succeeded', 'Retry test', (i) => {
    i.title = 'Accepted';
  });
  expect(retried.title).toBe('Accepted');
});

it.each(['evidence', 'claim', 'report', 'event', 'identity', 'epoch', 'missing-correction'])(
  'rejects destructive %s rewrites transactionally',
  async (kind) => {
    const incident = await create();
    await expect(
      ledger.mutate(incident.id, 1, command(), 'invalid', 'Invalid mutation', (i) => {
        if (kind === 'evidence') i.evidence[0].content = 'overwritten';
        if (kind === 'claim') i.claims[0].supportGroups[0].memberIds = ['E1-v1'];
        if (kind === 'report') i.reports[0].statements[0].text = 'overwritten';
        if (kind === 'event') i.events = [];
        if (kind === 'identity') i.id = 'changed';
        if (kind === 'epoch') i.evidenceEpoch += 2;
        if (kind === 'missing-correction') i.evidence[0].status = 'withdrawn';
      }),
    ).rejects.toThrow();
    expect(await ledger.get(incident.id)).toEqual(incident);
  },
);

it('preserves withdrawn source versions and rejects reactivation and duplicate versions', async () => {
  const original = await create();
  let incident = await ledger.withdraw(original.id, 'E1-v1', 'Wrong source', 1, randomUUID());
  const replacement = {
    ...original.evidence[0],
    id: 'E1-v2',
    version: 2,
    content: 'Corrected observation',
  };
  incident = await ledger.appendEvidence(incident.id, replacement, 2, randomUUID());
  expect(incident.evidence.find((e) => e.id === 'E1-v1')!.status).toBe('withdrawn');
  expect(incident.evidence.find((e) => e.id === 'E1-v2')).toEqual(replacement);
  await expect(
    ledger.appendEvidence(incident.id, { ...replacement, id: 'duplicate' }, 3, randomUUID()),
  ).rejects.toThrow();
  await expect(
    ledger.mutate(incident.id, 3, command(), 'reactivate', 'Invalid reactivation', (i) => {
      i.evidence[0].status = 'active';
    }),
  ).rejects.toThrow('reactivated');
  expect((await ledger.get(incident.id)).corrections).toHaveLength(1);
});

it('hashes are stable through JSONB and reflect topology and source changes', async () => {
  const initial = await create();
  expect(readArtifacts(await ledger.get(initial.id))).toEqual(readArtifacts(initial));
  const changed = await ledger.mutate(
    initial.id,
    1,
    command(),
    'topology.changed',
    'Topology changed',
    (i) => {
      i.topology!.dependencies = [];
    },
  );
  expect(readArtifacts(changed)).not.toEqual(readArtifacts(initial));
  expect(changed.reportStatus).toBe('needs_review');
});

it('rejects stale or malformed report publication and retains old revisions', async () => {
  const first = await create();
  const incident = await ledger.withdraw(first.id, 'E1-v1', 'Invalid source', 1, randomUUID());
  const evaluations = evaluateSupport(incident.evidence, incident.claims);
  const report = makeReport(
    incident.claims,
    evaluations,
    incident.evidenceEpoch,
    incident.reports.at(-1),
  );
  const manifest = {
    evidenceEpoch: incident.evidenceEpoch,
    reportVersion: 1,
    graphGeneration: 'test-generation',
    projectedSeq: incident.eventSeq,
    readArtifacts: readArtifacts(incident),
  };
  await expect(
    ledger.publish(incident.id, 2, command(), {
      report,
      evaluations,
      manifest: { ...manifest, projectedSeq: 1 },
    }),
  ).rejects.toThrow('Stale');
  await expect(
    ledger.publish(incident.id, 2, command(), {
      report: { ...report, version: 9 },
      evaluations,
      manifest,
    }),
  ).rejects.toThrow('Invalid');
  const cmd = command();
  const accepted = await ledger.publish(incident.id, 2, cmd, { report, evaluations, manifest });
  expect(accepted.reports[0]).toEqual(first.reports[0]);
  expect(accepted.reports).toHaveLength(2);
  expect(accepted.reportManifest).toEqual(manifest);
  expect(await ledger.publish(incident.id, 2, cmd, { report, evaluations, manifest })).toEqual(
    accepted,
  );
  await expect(
    ledger.publish(incident.id, 3, command(), { report, evaluations, manifest }),
  ).rejects.toThrow('Stale');
});

it('uses actual SQL commit and rollback operations', async () => {
  const table = `test_${randomUUID().replaceAll('-', '')}`;
  await sql.query(`CREATE TABLE ${table}(id integer PRIMARY KEY)`);
  try {
    await sql.transaction(async (tx) => {
      await tx.query(`INSERT INTO ${table} VALUES (1)`);
    });
    await expect(
      sql.transaction(async (tx) => {
        await tx.query(`INSERT INTO ${table} VALUES (2)`);
        throw new Error('Rollback');
      }),
    ).rejects.toThrow('Rollback');
    expect((await sql.query<{ id: number }>(`SELECT id FROM ${table}`)).rows).toEqual([{ id: 1 }]);
  } finally {
    await sql.query(`DROP TABLE ${table}`);
  }
});

it.runIf(Boolean(url))('protects commands across independent PostgreSQL clients', async () => {
  const other = await Ledger.open(undefined, url);
  const incident = await create();
  try {
    const results = await Promise.allSettled([
      ledger.withdraw(incident.id, 'E1-v1', 'Client one', 1, randomUUID()),
      other.withdraw(incident.id, 'E2-v1', 'Client two', 1, randomUUID()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await other.get(incident.id)).eventSeq).toBe(2);
  } finally {
    await other.close();
  }
});

it('persists repair outbox, attempts and agent audit rows with relational constraints', async () => {
  const initial = await create();
  const changed = await ledger.withdraw(initial.id, 'E1-v1', 'Audit setup', 1, randomUUID());
  const task = (await ledger.jobs.work(initial.id)).tasks[0];
  const attempt = randomUUID();
  const call = randomUUID();
  const tool = randomUUID();
  await ledger.mutate(
    initial.id,
    changed.eventSeq,
    command(),
    'audit.recorded',
    'Audit storage test',
    async (i, tx) => {
      const outbox = await tx.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM repair_outbox WHERE task_id=$1',
        [task.id],
      );
      expect(outbox.rows[0].count).toBe(1);
      await tx.query(
        "INSERT INTO repair_attempts(id,task_id,incident_id,number,evidence_epoch,status) VALUES($1,$2,$3,1,$4,'running')",
        [attempt, task.id, i.id, i.evidenceEpoch],
      );
      await tx.query(
        "INSERT INTO model_calls(id,task_id,attempt_id,incident_id,role,provider,model,status,request,manifest) VALUES($1,$2,$3,$4,'investigator','test','test','running',$5,$6)",
        [
          call,
          task.id,
          attempt,
          i.id,
          JSON.stringify({ test: true }),
          JSON.stringify({ graphGeneration: 'test' }),
        ],
      );
      await tx.query(
        "INSERT INTO agent_tool_calls(id,attempt_id,model_call_id,incident_id,role,name,status,arguments,result,manifest) VALUES($1,$2,$3,$4,'investigator','readEvidence','succeeded','{}','{}','{}')",
        [tool, attempt, call, i.id],
      );
    },
  );
  const work = await ledger.jobs.work(initial.id);
  expect(work.attempts).toMatchObject([{ id: attempt, status: 'running' }]);
  expect(work.modelCalls).toEqual([{ id: call, status: 'running' }]);
  expect(work.toolCalls).toEqual([{ id: tool, status: 'succeeded' }]);
  const current = await ledger.get(initial.id);
  await expect(
    ledger.mutate(
      initial.id,
      current.eventSeq,
      command(),
      'bad.audit',
      'Invalid foreign key',
      async (i, tx) => {
        await tx.query(
          "INSERT INTO repair_attempts(id,task_id,incident_id,number,evidence_epoch,status) VALUES($1,'missing',$2,1,2,'running')",
          [randomUUID(), i.id],
        );
      },
    ),
  ).rejects.toThrow();
  expect(await ledger.get(initial.id)).toEqual(current);
});

it('serializes concurrent publication and rejects altered artifact hashes', async () => {
  const initial = await create();
  const incident = await ledger.withdraw(initial.id, 'E1-v1', 'Publication race', 1, randomUUID());
  const evaluations = evaluateSupport(incident.evidence, incident.claims);
  const report = makeReport(
    incident.claims,
    evaluations,
    incident.evidenceEpoch,
    incident.reports.at(-1),
  );
  const manifest = {
    evidenceEpoch: incident.evidenceEpoch,
    reportVersion: 1,
    graphGeneration: 'test-generation',
    projectedSeq: incident.eventSeq,
    readArtifacts: readArtifacts(incident),
  };
  const corrupted = structuredClone(manifest);
  corrupted.readArtifacts[0].hash = '0'.repeat(64);
  await expect(
    ledger.publish(incident.id, 2, command(), { report, evaluations, manifest: corrupted }),
  ).rejects.toThrow('Stale');
  const results = await Promise.allSettled([
    ledger.publish(incident.id, 2, command(), { report, evaluations, manifest }),
    ledger.publish(incident.id, 2, command(), { report, evaluations, manifest }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect((await ledger.get(incident.id)).reports).toHaveLength(2);
  expect((await ledger.jobs.work(incident.id)).tasks[0].status).toBe('superseded');
});

it('keeps the original idempotent response after later commands and records migrations once', async () => {
  const initial = await create();
  const key = randomUUID();
  const original = await ledger.withdraw(initial.id, 'E1-v1', 'Original', 1, key);
  await ledger.withdraw(initial.id, 'E2-v1', 'Later', 2, randomUUID());
  expect(await ledger.withdraw(initial.id, 'E1-v1', 'Original', 1, key)).toEqual(original);
  expect((await ledger.get(initial.id)).eventSeq).toBe(3);
  await ledger.mutate(
    initial.id,
    3,
    command(),
    'test.migrations',
    'Inspect migrations',
    async (_, tx) => {
      expect((await tx.query('SELECT name FROM schema_migrations')).rows).toHaveLength(5);
    },
  );
});
