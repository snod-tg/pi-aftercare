CREATE TABLE IF NOT EXISTS agent_sessions (
  id text PRIMARY KEY,
  merchant_id text NOT NULL,
  customer_id text NOT NULL,
  body jsonb NOT NULL CHECK (body->>'version' = '1'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_sessions_owner_updated ON agent_sessions (merchant_id, customer_id, updated_at DESC);
