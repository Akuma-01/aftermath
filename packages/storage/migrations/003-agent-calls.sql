CREATE TABLE model_calls (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES repair_tasks(id),
  attempt_id text NOT NULL REFERENCES repair_attempts(id),
  incident_id text NOT NULL REFERENCES incidents(id),
  role text NOT NULL CHECK (role IN ('investigator','reporter')),
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  latency_ms integer,
  input_tokens integer,
  output_tokens integer,
  error text,
  request jsonb NOT NULL,
  response jsonb,
  manifest jsonb NOT NULL
);
CREATE INDEX model_calls_task ON model_calls(task_id);
CREATE INDEX model_calls_incident ON model_calls(incident_id, started_at DESC);
CREATE TABLE agent_tool_calls (
  id text PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES repair_attempts(id),
  model_call_id text NOT NULL REFERENCES model_calls(id),
  incident_id text NOT NULL REFERENCES incidents(id),
  role text NOT NULL CHECK (role IN ('investigator','reporter')),
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded','rejected')),
  arguments jsonb NOT NULL,
  result jsonb NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_tool_calls_incident ON agent_tool_calls(incident_id, created_at DESC);
