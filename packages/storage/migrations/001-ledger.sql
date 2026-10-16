CREATE TABLE IF NOT EXISTS incidents (
  id text PRIMARY KEY,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS domain_events (
  incident_id text REFERENCES incidents(id),
  seq integer NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (incident_id, seq)
);
CREATE TABLE IF NOT EXISTS commands (
  incident_id text REFERENCES incidents(id),
  key text NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  PRIMARY KEY (incident_id, key)
);
