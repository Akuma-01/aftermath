ALTER TABLE model_calls ADD COLUMN credential_slot text CHECK (credential_slot IN ('primary', 'backup'));
ALTER TABLE model_calls ADD COLUMN failover_from_call_id text REFERENCES model_calls(id);
