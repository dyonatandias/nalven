-- Blueprint. Converter em migrations Prisma antes de aplicar.
CREATE TABLE IF NOT EXISTS schema_metadata (
  key varchar(80) PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  actor_id text,
  action varchar(120) NOT NULL,
  entity_type varchar(100) NOT NULL,
  entity_id text,
  correlation_id uuid,
  before_data jsonb,
  after_data jsonb,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events(entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY,
  topic varchar(120) NOT NULL,
  aggregate_type varchar(100) NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key varchar(200) NOT NULL UNIQUE,
  status varchar(30) NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_events_worker_idx ON outbox_events(status, next_attempt_at);
