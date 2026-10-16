CREATE TABLE repair_tasks (
  id text PRIMARY KEY,
  incident_id text NOT NULL REFERENCES incidents(id),
  evidence_epoch integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('repair', 'report_preview')),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'superseded')),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  active_attempt_id text,
  pause_before_commit boolean NOT NULL DEFAULT false,
  delivery_version integer NOT NULL DEFAULT 1,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  error text,
  report_version integer
);
CREATE INDEX repair_tasks_incident ON repair_tasks(incident_id, created_at DESC);
CREATE UNIQUE INDEX repair_tasks_one_active_repair ON repair_tasks(incident_id, evidence_epoch)
  WHERE kind = 'repair' AND status IN ('pending', 'running', 'paused');
CREATE TABLE repair_attempts (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES repair_tasks(id),
  incident_id text NOT NULL REFERENCES incidents(id),
  number integer NOT NULL,
  evidence_epoch integer NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'paused', 'accepted', 'stale', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  reason text,
  manifest jsonb,
  proposal jsonb,
  report_version integer,
  UNIQUE (task_id, number)
);
CREATE UNIQUE INDEX repair_attempts_one_accepted ON repair_attempts(task_id) WHERE status = 'accepted';
CREATE TABLE repair_outbox (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES repair_tasks(id),
  delivery_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE(task_id, delivery_version)
);
CREATE INDEX repair_outbox_task ON repair_outbox(task_id);
