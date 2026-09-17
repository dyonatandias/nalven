-- Append-only cash ledger and immutable cash-custody chain.
-- The legacy cash_register_events table remains untouched and is not covered
-- until an explicit migration/backfill is designed and reconciled.

CREATE UNIQUE INDEX "pos_terminals_id_register_id_key" ON "pos_terminals"("id", "register_id");

CREATE TABLE "pos_cash_ledger_entries" (
  "id" BIGSERIAL NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "register_id" INTEGER NOT NULL,
  "session_id" INTEGER NOT NULL,
  "terminal_id" TEXT NOT NULL,
  "actor_profile_id" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,
  "entry_type" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "delta_cents" INTEGER NOT NULL,
  "balance_before_cents" INTEGER NOT NULL,
  "balance_after_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "reference_type" TEXT NOT NULL,
  "reference_id" TEXT NOT NULL,
  "reference_sequence" INTEGER NOT NULL DEFAULT 1,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "approval_id" TEXT,
  "reversal_for_id" BIGINT,
  "reason_code" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "occurred_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_cash_ledger_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_cash_ledger_entry_type_check" CHECK ("entry_type" IN ('opening', 'sale', 'return', 'supply', 'withdrawal', 'custody_seal', 'adjustment', 'reversal')),
  CONSTRAINT "pos_cash_ledger_values_check" CHECK (
    "sequence" > 0
    AND "amount_cents" >= 0
    AND ("delta_cents" <> 0 OR "entry_type" = 'opening')
    AND "amount_cents" = abs("delta_cents")
    AND "balance_before_cents" >= 0
    AND "balance_after_cents" >= 0
    AND "balance_after_cents" = "balance_before_cents" + "delta_cents"
    AND "currency" = 'BRL'
    AND "reference_sequence" > 0
    AND char_length("reference_type") BETWEEN 2 AND 80
    AND char_length("reference_id") BETWEEN 1 AND 160
    AND char_length("idempotency_key") BETWEEN 16 AND 160
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "correlation_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND char_length("reason_code") BETWEEN 2 AND 80
    AND char_length("description") BETWEEN 1 AND 500
  ),
  CONSTRAINT "pos_cash_ledger_direction_check" CHECK (
    ("entry_type" = 'opening' AND "delta_cents" >= 0)
    OR ("entry_type" IN ('sale', 'supply') AND "delta_cents" > 0)
    OR ("entry_type" IN ('return', 'withdrawal', 'custody_seal') AND "delta_cents" < 0)
    OR ("entry_type" = 'adjustment' AND "delta_cents" <> 0)
    OR ("entry_type" = 'reversal' AND "delta_cents" <> 0)
  ),
  CONSTRAINT "pos_cash_ledger_reversal_shape_check" CHECK (("entry_type" = 'reversal') = ("reversal_for_id" IS NOT NULL)),
  CONSTRAINT "pos_cash_ledger_sensitive_approval_check" CHECK (("entry_type" IN ('adjustment', 'reversal')) = ("approval_id" IS NOT NULL)),
  CONSTRAINT "pos_cash_ledger_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_ledger_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_ledger_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_register_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_ledger_terminal_id_fkey" FOREIGN KEY ("terminal_id") REFERENCES "pos_terminals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_ledger_actor_profile_id_fkey" FOREIGN KEY ("actor_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_ledger_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "pos_approvals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_ledger_reversal_for_id_fkey" FOREIGN KEY ("reversal_for_id") REFERENCES "pos_cash_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_ledger_register_branch_fkey" FOREIGN KEY ("register_id", "branch_id") REFERENCES "pos_registers"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_ledger_session_register_fkey" FOREIGN KEY ("session_id", "register_id") REFERENCES "cash_register_sessions"("id", "register_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_ledger_terminal_register_fkey" FOREIGN KEY ("terminal_id", "register_id") REFERENCES "pos_terminals"("id", "register_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_cash_ledger_entries_idempotency_key_key" ON "pos_cash_ledger_entries"("idempotency_key");
CREATE UNIQUE INDEX "pos_cash_ledger_entries_session_sequence_key" ON "pos_cash_ledger_entries"("session_id", "sequence");
CREATE UNIQUE INDEX "pos_cash_ledger_reference_key" ON "pos_cash_ledger_entries"("reference_type", "reference_id", "reference_sequence");
CREATE UNIQUE INDEX "pos_cash_ledger_entries_reversal_for_id_key" ON "pos_cash_ledger_entries"("reversal_for_id") WHERE "reversal_for_id" IS NOT NULL;
CREATE INDEX "pos_cash_ledger_entries_branch_created_idx" ON "pos_cash_ledger_entries"("branch_id", "created_at");
CREATE INDEX "pos_cash_ledger_entries_register_created_idx" ON "pos_cash_ledger_entries"("register_id", "created_at");
CREATE INDEX "pos_cash_ledger_entries_terminal_created_idx" ON "pos_cash_ledger_entries"("terminal_id", "created_at");
CREATE INDEX "pos_cash_ledger_entries_actor_created_idx" ON "pos_cash_ledger_entries"("actor_profile_id", "created_at");
CREATE INDEX "pos_cash_ledger_entries_correlation_idx" ON "pos_cash_ledger_entries"("correlation_id");

CREATE TABLE "pos_cash_custody_bags" (
  "id" TEXT NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "register_id" INTEGER NOT NULL,
  "session_id" INTEGER NOT NULL,
  "terminal_id" TEXT NOT NULL,
  "sealed_by_profile_id" INTEGER NOT NULL,
  "ledger_entry_id" BIGINT NOT NULL,
  "seal_number" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "sealed_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_cash_custody_bags_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_cash_custody_bags_values_check" CHECK (
    char_length("id") BETWEEN 8 AND 160
    AND char_length("seal_number") BETWEEN 6 AND 100
    AND "amount_cents" > 0
    AND "currency" = 'BRL'
    AND char_length("idempotency_key") BETWEEN 16 AND 160
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "correlation_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "pos_cash_custody_bags_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_custody_bags_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_custody_bags_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_register_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_custody_bags_terminal_id_fkey" FOREIGN KEY ("terminal_id") REFERENCES "pos_terminals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_custody_bags_sealed_by_profile_id_fkey" FOREIGN KEY ("sealed_by_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_custody_bags_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "pos_cash_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_custody_bags_register_branch_fkey" FOREIGN KEY ("register_id", "branch_id") REFERENCES "pos_registers"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_custody_bags_session_register_fkey" FOREIGN KEY ("session_id", "register_id") REFERENCES "cash_register_sessions"("id", "register_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_custody_bags_terminal_register_fkey" FOREIGN KEY ("terminal_id", "register_id") REFERENCES "pos_terminals"("id", "register_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_cash_custody_bags_idempotency_key_key" ON "pos_cash_custody_bags"("idempotency_key");
CREATE UNIQUE INDEX "pos_cash_custody_bags_ledger_entry_id_key" ON "pos_cash_custody_bags"("ledger_entry_id");
CREATE UNIQUE INDEX "pos_cash_custody_bags_branch_seal_key" ON "pos_cash_custody_bags"("branch_id", "seal_number");
CREATE INDEX "pos_cash_custody_bags_session_sealed_idx" ON "pos_cash_custody_bags"("session_id", "sealed_at");
CREATE INDEX "pos_cash_custody_bags_terminal_sealed_idx" ON "pos_cash_custody_bags"("terminal_id", "sealed_at");
CREATE INDEX "pos_cash_custody_bags_correlation_idx" ON "pos_cash_custody_bags"("correlation_id");

CREATE TABLE "pos_cash_custody_incidents" (
  "id" TEXT NOT NULL,
  "bag_id" TEXT NOT NULL,
  "opened_by_profile_id" INTEGER NOT NULL,
  "expected_amount_cents" INTEGER NOT NULL,
  "observed_amount_cents" INTEGER NOT NULL,
  "difference_cents" INTEGER NOT NULL,
  "reason_code" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "opened_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_cash_custody_incidents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_cash_custody_incidents_values_check" CHECK (
    char_length("id") BETWEEN 8 AND 160
    AND "expected_amount_cents" > 0
    AND "observed_amount_cents" >= 0
    AND "difference_cents" = "observed_amount_cents" - "expected_amount_cents"
    AND "difference_cents" <> 0
    AND char_length("reason_code") BETWEEN 2 AND 80
    AND char_length("description") BETWEEN 1 AND 1000
    AND char_length("idempotency_key") BETWEEN 16 AND 160
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "correlation_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "pos_cash_custody_incidents_bag_id_fkey" FOREIGN KEY ("bag_id") REFERENCES "pos_cash_custody_bags"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_custody_incidents_opened_by_profile_id_fkey" FOREIGN KEY ("opened_by_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_cash_custody_incidents_bag_id_key" ON "pos_cash_custody_incidents"("bag_id");
CREATE UNIQUE INDEX "pos_cash_custody_incidents_idempotency_key_key" ON "pos_cash_custody_incidents"("idempotency_key");
CREATE INDEX "pos_cash_custody_incidents_opener_opened_idx" ON "pos_cash_custody_incidents"("opened_by_profile_id", "opened_at");
CREATE INDEX "pos_cash_custody_incidents_correlation_idx" ON "pos_cash_custody_incidents"("correlation_id");

CREATE TABLE "pos_cash_custody_incident_resolutions" (
  "id" TEXT NOT NULL,
  "incident_id" TEXT NOT NULL,
  "resolved_by_profile_id" INTEGER NOT NULL,
  "approval_id" TEXT NOT NULL,
  "resolution_type" TEXT NOT NULL,
  "final_amount_cents" INTEGER NOT NULL,
  "notes" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "resolved_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_cash_custody_incident_resolutions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_cash_custody_resolution_type_check" CHECK ("resolution_type" IN ('accepted_difference', 'recount_confirmed', 'returned_to_origin')),
  CONSTRAINT "pos_cash_custody_resolutions_values_check" CHECK (
    char_length("id") BETWEEN 8 AND 160
    AND "final_amount_cents" >= 0
    AND char_length("notes") BETWEEN 1 AND 1000
    AND char_length("idempotency_key") BETWEEN 16 AND 160
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "correlation_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "pos_cash_custody_resolutions_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "pos_cash_custody_incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_custody_resolutions_resolved_by_profile_id_fkey" FOREIGN KEY ("resolved_by_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_custody_resolutions_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "pos_approvals"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_cash_custody_resolutions_incident_id_key" ON "pos_cash_custody_incident_resolutions"("incident_id");
CREATE UNIQUE INDEX "pos_cash_custody_resolutions_approval_id_key" ON "pos_cash_custody_incident_resolutions"("approval_id");
CREATE UNIQUE INDEX "pos_cash_custody_resolutions_idempotency_key_key" ON "pos_cash_custody_incident_resolutions"("idempotency_key");
CREATE INDEX "pos_cash_custody_resolutions_actor_resolved_idx" ON "pos_cash_custody_incident_resolutions"("resolved_by_profile_id", "resolved_at");
CREATE INDEX "pos_cash_custody_resolutions_correlation_idx" ON "pos_cash_custody_incident_resolutions"("correlation_id");

CREATE TABLE "pos_cash_custody_events" (
  "id" BIGSERIAL NOT NULL,
  "bag_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event_type" TEXT NOT NULL,
  "from_state" TEXT,
  "to_state" TEXT NOT NULL,
  "actor_profile_id" INTEGER NOT NULL,
  "counterparty_profile_id" INTEGER,
  "incident_id" TEXT,
  "observed_amount_cents" INTEGER,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "notes" TEXT,
  "occurred_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_cash_custody_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_cash_custody_event_type_check" CHECK ("event_type" IN ('sealed', 'delivered', 'accepted', 'divergence_reported', 'divergence_resolved')),
  CONSTRAINT "pos_cash_custody_event_state_check" CHECK (
    ("event_type" = 'sealed' AND "from_state" IS NULL AND "to_state" = 'sealed')
    OR ("event_type" = 'delivered' AND "from_state" = 'sealed' AND "to_state" = 'delivered')
    OR ("event_type" = 'accepted' AND "from_state" = 'delivered' AND "to_state" = 'accepted')
    OR ("event_type" = 'divergence_reported' AND "from_state" = 'delivered' AND "to_state" = 'disputed')
    OR ("event_type" = 'divergence_resolved' AND "from_state" = 'disputed' AND "to_state" = 'accepted')
  ),
  CONSTRAINT "pos_cash_custody_events_values_check" CHECK (
    "sequence" > 0
    AND ("observed_amount_cents" IS NULL OR "observed_amount_cents" >= 0)
    AND char_length("idempotency_key") BETWEEN 16 AND 160
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "correlation_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND ("notes" IS NULL OR char_length("notes") BETWEEN 1 AND 1000)
    AND ("counterparty_profile_id" IS NULL OR "counterparty_profile_id" <> "actor_profile_id")
  ),
  CONSTRAINT "pos_cash_custody_events_bag_id_fkey" FOREIGN KEY ("bag_id") REFERENCES "pos_cash_custody_bags"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_custody_events_actor_profile_id_fkey" FOREIGN KEY ("actor_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_custody_events_counterparty_profile_id_fkey" FOREIGN KEY ("counterparty_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cash_custody_events_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "pos_cash_custody_incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_cash_custody_events_idempotency_key_key" ON "pos_cash_custody_events"("idempotency_key");
CREATE UNIQUE INDEX "pos_cash_custody_events_bag_sequence_key" ON "pos_cash_custody_events"("bag_id", "sequence");
CREATE INDEX "pos_cash_custody_events_bag_created_idx" ON "pos_cash_custody_events"("bag_id", "created_at");
CREATE INDEX "pos_cash_custody_events_actor_created_idx" ON "pos_cash_custody_events"("actor_profile_id", "created_at");
CREATE INDEX "pos_cash_custody_events_incident_idx" ON "pos_cash_custody_events"("incident_id");
CREATE INDEX "pos_cash_custody_events_correlation_idx" ON "pos_cash_custody_events"("correlation_id");

CREATE FUNCTION "pos_cash_forbid_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION "pos_cash_ledger_guard_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_entry "pos_cash_ledger_entries"%ROWTYPE;
  target_entry "pos_cash_ledger_entries"%ROWTYPE;
  approval_record "pos_approvals"%ROWTYPE;
  actor_user_id TEXT;
  expected_action TEXT;
  expected_entity_type TEXT;
  expected_entity_id TEXT;
  expected_context JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(27001, NEW."session_id");
  SELECT * INTO previous_entry FROM "pos_cash_ledger_entries"
    WHERE "session_id" = NEW."session_id" ORDER BY "sequence" DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    IF NEW."sequence" <> 1 OR NEW."balance_before_cents" <> 0 OR NEW."entry_type" <> 'opening' THEN
      RAISE EXCEPTION 'cash ledger must start with opening at sequence 1 and zero balance' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."entry_type" = 'opening' THEN
      RAISE EXCEPTION 'cash ledger opening can only be the first entry' USING ERRCODE = '23514';
    END IF;
    IF NEW."sequence" <> previous_entry."sequence" + 1 OR NEW."balance_before_cents" <> previous_entry."balance_after_cents" THEN
      RAISE EXCEPTION 'cash ledger sequence or balance chain broken' USING ERRCODE = '23514';
    END IF;
    IF NEW."occurred_at" < previous_entry."occurred_at" THEN
      RAISE EXCEPTION 'cash ledger occurred_at must be monotonic' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."reversal_for_id" IS NOT NULL THEN
    SELECT * INTO STRICT target_entry FROM "pos_cash_ledger_entries" WHERE "id" = NEW."reversal_for_id" FOR KEY SHARE;
    IF target_entry."session_id" <> NEW."session_id" OR target_entry."register_id" <> NEW."register_id" OR target_entry."branch_id" <> NEW."branch_id"
       OR target_entry."reversal_for_id" IS NOT NULL OR NEW."delta_cents" <> -target_entry."delta_cents"
       OR NEW."amount_cents" <> target_entry."amount_cents" THEN
      RAISE EXCEPTION 'invalid compensating cash-ledger reversal' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."approval_id" IS NOT NULL THEN
    SELECT "user_id" INTO STRICT actor_user_id FROM "tenant_user_profiles" WHERE "id" = NEW."actor_profile_id" FOR KEY SHARE;
    IF NEW."entry_type" = 'reversal' THEN
      expected_action := 'cash.ledger.reversal';
      expected_entity_type := 'cash_ledger_entry';
      expected_entity_id := target_entry."id"::TEXT;
      expected_context := jsonb_build_object(
        'branchId', NEW."branch_id", 'registerId', NEW."register_id", 'sessionId', NEW."session_id", 'terminalId', NEW."terminal_id",
        'entryId', target_entry."id"::TEXT, 'deltaCents', NEW."delta_cents"
      );
    ELSE
      expected_action := 'cash.ledger.adjustment';
      expected_entity_type := 'cash_register_session';
      expected_entity_id := NEW."session_id"::TEXT;
      expected_context := jsonb_build_object(
        'branchId', NEW."branch_id", 'registerId', NEW."register_id", 'sessionId', NEW."session_id", 'terminalId', NEW."terminal_id",
        'deltaCents', NEW."delta_cents", 'referenceType', NEW."reference_type", 'referenceId', NEW."reference_id", 'referenceSequence', NEW."reference_sequence"
      );
    END IF;
    SELECT * INTO STRICT approval_record FROM "pos_approvals" WHERE "id" = NEW."approval_id" FOR KEY SHARE;
    IF approval_record."branch_id" IS DISTINCT FROM NEW."branch_id" OR approval_record."status" <> 'approved'
       OR approval_record."action" <> expected_action OR approval_record."entity_type" <> expected_entity_type
       OR approval_record."entity_id" IS DISTINCT FROM expected_entity_id OR approval_record."context" <> expected_context
       OR approval_record."requester_id" <> actor_user_id OR approval_record."approver_id" IS NULL
       OR approval_record."approver_id" = actor_user_id OR approval_record."consumed_at" IS NOT NULL
       OR approval_record."expires_at" <= NEW."occurred_at" THEN
      RAISE EXCEPTION 'cash-ledger approval does not match actor, action, entity, snapshot, SoD, or validity' USING ERRCODE = '23514';
    END IF;
    UPDATE "pos_approvals" SET "consumed_at" = NEW."occurred_at", "consumed_by" = actor_user_id,
      "consumption_ref" = 'pos_cash_ledger_entry:' || NEW."id"::TEXT WHERE "id" = NEW."approval_id" AND "consumed_at" IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'cash-ledger approval was consumed concurrently' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_cash_custody_bag_guard_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ledger_entry "pos_cash_ledger_entries"%ROWTYPE;
BEGIN
  SELECT * INTO STRICT ledger_entry FROM "pos_cash_ledger_entries" WHERE "id" = NEW."ledger_entry_id" FOR KEY SHARE;
  IF ledger_entry."entry_type" <> 'custody_seal' OR ledger_entry."delta_cents" <> -NEW."amount_cents"
     OR ledger_entry."branch_id" <> NEW."branch_id" OR ledger_entry."register_id" <> NEW."register_id"
     OR ledger_entry."session_id" <> NEW."session_id" OR ledger_entry."terminal_id" <> NEW."terminal_id"
     OR ledger_entry."actor_profile_id" <> NEW."sealed_by_profile_id" THEN
    RAISE EXCEPTION 'custody bag does not match its cash-ledger seal entry' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_cash_custody_incident_guard_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bag_record "pos_cash_custody_bags"%ROWTYPE;
  delivery_event "pos_cash_custody_events"%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."bag_id", 27002));
  SELECT * INTO STRICT bag_record FROM "pos_cash_custody_bags" WHERE "id" = NEW."bag_id" FOR KEY SHARE;
  SELECT * INTO STRICT delivery_event FROM "pos_cash_custody_events" WHERE "bag_id" = NEW."bag_id" ORDER BY "sequence" DESC LIMIT 1 FOR UPDATE;
  IF delivery_event."event_type" <> 'delivered' OR delivery_event."counterparty_profile_id" <> NEW."opened_by_profile_id"
     OR NEW."expected_amount_cents" <> bag_record."amount_cents" THEN
    RAISE EXCEPTION 'custody incident must be opened by the designated recipient after delivery' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_cash_custody_resolution_guard_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  incident_record "pos_cash_custody_incidents"%ROWTYPE;
  bag_record "pos_cash_custody_bags"%ROWTYPE;
  approval_record "pos_approvals"%ROWTYPE;
  latest_event "pos_cash_custody_events"%ROWTYPE;
  resolver_user_id TEXT;
  expected_context JSONB;
BEGIN
  SELECT * INTO STRICT incident_record FROM "pos_cash_custody_incidents" WHERE "id" = NEW."incident_id" FOR KEY SHARE;
  SELECT * INTO STRICT bag_record FROM "pos_cash_custody_bags" WHERE "id" = incident_record."bag_id" FOR KEY SHARE;
  SELECT * INTO STRICT latest_event FROM "pos_cash_custody_events" WHERE "bag_id" = incident_record."bag_id" ORDER BY "sequence" DESC LIMIT 1 FOR UPDATE;
  SELECT * INTO STRICT approval_record FROM "pos_approvals" WHERE "id" = NEW."approval_id" FOR KEY SHARE;
  SELECT "user_id" INTO STRICT resolver_user_id FROM "tenant_user_profiles" WHERE "id" = NEW."resolved_by_profile_id" FOR KEY SHARE;
  expected_context := jsonb_build_object(
    'branchId', bag_record."branch_id", 'bagId', incident_record."bag_id", 'incidentId', incident_record."id",
    'expectedAmountCents', incident_record."expected_amount_cents", 'observedAmountCents', incident_record."observed_amount_cents",
    'differenceCents', incident_record."difference_cents", 'finalAmountCents', NEW."final_amount_cents", 'resolutionType', NEW."resolution_type"
  );
  IF NEW."resolved_by_profile_id" = incident_record."opened_by_profile_id" THEN
    RAISE EXCEPTION 'custody incident requires an independent resolver' USING ERRCODE = '23514';
  END IF;
  IF latest_event."event_type" <> 'divergence_reported' OR latest_event."incident_id" <> incident_record."id" THEN
    RAISE EXCEPTION 'custody resolution requires the latest event to be its reported divergence' USING ERRCODE = '23514';
  END IF;
  IF approval_record."branch_id" IS DISTINCT FROM bag_record."branch_id" OR approval_record."status" <> 'approved'
     OR approval_record."action" <> 'cash.custody.divergence.resolve' OR approval_record."entity_type" <> 'cash_custody_incident'
     OR approval_record."entity_id" IS DISTINCT FROM incident_record."id" OR approval_record."context" <> expected_context
     OR approval_record."requester_id" <> resolver_user_id OR approval_record."approver_id" IS NULL
     OR approval_record."approver_id" = resolver_user_id OR approval_record."consumed_at" IS NOT NULL
     OR approval_record."expires_at" <= NEW."resolved_at" THEN
    RAISE EXCEPTION 'custody approval does not match actor, action, entity, snapshot, SoD, or validity' USING ERRCODE = '23514';
  END IF;
  UPDATE "pos_approvals" SET "consumed_at" = NEW."resolved_at", "consumed_by" = resolver_user_id,
    "consumption_ref" = 'pos_cash_custody_resolution:' || NEW."id" WHERE "id" = NEW."approval_id" AND "consumed_at" IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'custody approval was consumed concurrently' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_cash_custody_event_guard_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bag_record "pos_cash_custody_bags"%ROWTYPE;
  previous_event "pos_cash_custody_events"%ROWTYPE;
  incident_record "pos_cash_custody_incidents"%ROWTYPE;
  resolution_record "pos_cash_custody_incident_resolutions"%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."bag_id", 27002));
  SELECT * INTO STRICT bag_record FROM "pos_cash_custody_bags" WHERE "id" = NEW."bag_id" FOR KEY SHARE;
  SELECT * INTO previous_event FROM "pos_cash_custody_events" WHERE "bag_id" = NEW."bag_id" ORDER BY "sequence" DESC LIMIT 1 FOR UPDATE;

  IF NOT FOUND THEN
    IF NEW."sequence" <> 1 OR NEW."event_type" <> 'sealed' OR NEW."actor_profile_id" <> bag_record."sealed_by_profile_id"
       OR NEW."counterparty_profile_id" IS NOT NULL OR NEW."incident_id" IS NOT NULL OR NEW."observed_amount_cents" IS NOT NULL THEN
      RAISE EXCEPTION 'first custody event must be the authoritative seal' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."sequence" <> previous_event."sequence" + 1 OR NEW."from_state" IS DISTINCT FROM previous_event."to_state"
     OR NEW."occurred_at" < previous_event."occurred_at" THEN
    RAISE EXCEPTION 'custody event sequence, state, or time chain broken' USING ERRCODE = '23514';
  END IF;

  IF NEW."event_type" = 'delivered' THEN
    IF previous_event."event_type" <> 'sealed' OR NEW."actor_profile_id" <> previous_event."actor_profile_id"
       OR NEW."counterparty_profile_id" IS NULL OR NEW."incident_id" IS NOT NULL OR NEW."observed_amount_cents" IS NOT NULL THEN
      RAISE EXCEPTION 'delivery requires current custodian and a distinct designated recipient' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."event_type" = 'accepted' THEN
    IF previous_event."event_type" <> 'delivered' OR NEW."actor_profile_id" <> previous_event."counterparty_profile_id"
       OR NEW."actor_profile_id" = previous_event."actor_profile_id" OR NEW."counterparty_profile_id" IS NOT NULL
       OR NEW."incident_id" IS NOT NULL OR NEW."observed_amount_cents" <> bag_record."amount_cents"
       OR EXISTS (SELECT 1 FROM "pos_cash_custody_incidents" WHERE "bag_id" = NEW."bag_id") THEN
      RAISE EXCEPTION 'acceptance requires the distinct designated recipient and exact amount' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."event_type" = 'divergence_reported' THEN
    SELECT * INTO STRICT incident_record FROM "pos_cash_custody_incidents" WHERE "id" = NEW."incident_id" FOR KEY SHARE;
    IF previous_event."event_type" <> 'delivered' OR NEW."actor_profile_id" <> previous_event."counterparty_profile_id"
       OR NEW."counterparty_profile_id" IS NOT NULL OR NEW."observed_amount_cents" = bag_record."amount_cents"
       OR incident_record."bag_id" <> NEW."bag_id" OR incident_record."opened_by_profile_id" <> NEW."actor_profile_id"
       OR incident_record."observed_amount_cents" <> NEW."observed_amount_cents" THEN
      RAISE EXCEPTION 'invalid custody divergence report' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."event_type" = 'divergence_resolved' THEN
    SELECT * INTO STRICT incident_record FROM "pos_cash_custody_incidents" WHERE "id" = NEW."incident_id" FOR KEY SHARE;
    SELECT * INTO STRICT resolution_record FROM "pos_cash_custody_incident_resolutions" WHERE "incident_id" = NEW."incident_id" FOR KEY SHARE;
    IF previous_event."event_type" <> 'divergence_reported' OR previous_event."incident_id" <> NEW."incident_id"
       OR NEW."actor_profile_id" <> resolution_record."resolved_by_profile_id" OR NEW."actor_profile_id" = incident_record."opened_by_profile_id"
       OR NEW."counterparty_profile_id" IS NOT NULL OR NEW."observed_amount_cents" <> resolution_record."final_amount_cents" THEN
      RAISE EXCEPTION 'invalid independent custody-divergence resolution' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'custody bag already has its seal event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "pos_cash_custody_require_seal_event"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "pos_cash_custody_events" WHERE "bag_id" = NEW."id" AND "sequence" = 1 AND "event_type" = 'sealed') THEN
    RAISE EXCEPTION 'custody bag requires its immutable seal event in the same transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "pos_cash_custody_require_incident_event"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "pos_cash_custody_events" WHERE "incident_id" = NEW."id" AND "event_type" = 'divergence_reported') THEN
    RAISE EXCEPTION 'custody incident requires its divergence event in the same transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "pos_cash_custody_require_resolution_event"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "pos_cash_custody_events" WHERE "incident_id" = NEW."incident_id" AND "event_type" = 'divergence_resolved' AND "actor_profile_id" = NEW."resolved_by_profile_id") THEN
    RAISE EXCEPTION 'custody resolution requires its terminal event in the same transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "pos_cash_ledger_require_custody_bag"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."entry_type" = 'custody_seal' AND NOT EXISTS (SELECT 1 FROM "pos_cash_custody_bags" WHERE "ledger_entry_id" = NEW."id") THEN
    RAISE EXCEPTION 'custody-seal ledger entry requires its immutable bag in the same transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "pos_cash_ledger_guard_insert_trigger" BEFORE INSERT ON "pos_cash_ledger_entries" FOR EACH ROW EXECUTE FUNCTION "pos_cash_ledger_guard_insert"();
CREATE TRIGGER "pos_cash_ledger_forbid_update_trigger" BEFORE UPDATE ON "pos_cash_ledger_entries" FOR EACH ROW EXECUTE FUNCTION "pos_cash_forbid_mutation"();
CREATE TRIGGER "pos_cash_ledger_forbid_delete_trigger" BEFORE DELETE ON "pos_cash_ledger_entries" FOR EACH ROW EXECUTE FUNCTION "pos_cash_forbid_mutation"();

CREATE TRIGGER "pos_cash_custody_bag_guard_insert_trigger" BEFORE INSERT ON "pos_cash_custody_bags" FOR EACH ROW EXECUTE FUNCTION "pos_cash_custody_bag_guard_insert"();
CREATE TRIGGER "pos_cash_custody_bag_forbid_update_trigger" BEFORE UPDATE ON "pos_cash_custody_bags" FOR EACH ROW EXECUTE FUNCTION "pos_cash_forbid_mutation"();
CREATE TRIGGER "pos_cash_custody_bag_forbid_delete_trigger" BEFORE DELETE ON "pos_cash_custody_bags" FOR EACH ROW EXECUTE FUNCTION "pos_cash_forbid_mutation"();

CREATE TRIGGER "pos_cash_custody_event_guard_insert_trigger" BEFORE INSERT ON "pos_cash_custody_events" FOR EACH ROW EXECUTE FUNCTION "pos_cash_custody_event_guard_insert"();
CREATE TRIGGER "pos_cash_custody_event_forbid_update_trigger" BEFORE UPDATE ON "pos_cash_custody_events" FOR EACH ROW EXECUTE FUNCTION "pos_cash_forbid_mutation"();
CREATE TRIGGER "pos_cash_custody_event_forbid_delete_trigger" BEFORE DELETE ON "pos_cash_custody_events" FOR EACH ROW EXECUTE FUNCTION "pos_cash_forbid_mutation"();

CREATE TRIGGER "pos_cash_custody_incident_guard_insert_trigger" BEFORE INSERT ON "pos_cash_custody_incidents" FOR EACH ROW EXECUTE FUNCTION "pos_cash_custody_incident_guard_insert"();
CREATE TRIGGER "pos_cash_custody_incident_forbid_update_trigger" BEFORE UPDATE ON "pos_cash_custody_incidents" FOR EACH ROW EXECUTE FUNCTION "pos_cash_forbid_mutation"();
CREATE TRIGGER "pos_cash_custody_incident_forbid_delete_trigger" BEFORE DELETE ON "pos_cash_custody_incidents" FOR EACH ROW EXECUTE FUNCTION "pos_cash_forbid_mutation"();

CREATE TRIGGER "pos_cash_custody_resolution_guard_insert_trigger" BEFORE INSERT ON "pos_cash_custody_incident_resolutions" FOR EACH ROW EXECUTE FUNCTION "pos_cash_custody_resolution_guard_insert"();
CREATE TRIGGER "pos_cash_custody_resolution_forbid_update_trigger" BEFORE UPDATE ON "pos_cash_custody_incident_resolutions" FOR EACH ROW EXECUTE FUNCTION "pos_cash_forbid_mutation"();
CREATE TRIGGER "pos_cash_custody_resolution_forbid_delete_trigger" BEFORE DELETE ON "pos_cash_custody_incident_resolutions" FOR EACH ROW EXECUTE FUNCTION "pos_cash_forbid_mutation"();

CREATE CONSTRAINT TRIGGER "pos_cash_custody_bag_requires_seal_event_trigger" AFTER INSERT ON "pos_cash_custody_bags" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "pos_cash_custody_require_seal_event"();
CREATE CONSTRAINT TRIGGER "pos_cash_custody_incident_requires_event_trigger" AFTER INSERT ON "pos_cash_custody_incidents" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "pos_cash_custody_require_incident_event"();
CREATE CONSTRAINT TRIGGER "pos_cash_custody_resolution_requires_event_trigger" AFTER INSERT ON "pos_cash_custody_incident_resolutions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "pos_cash_custody_require_resolution_event"();
CREATE CONSTRAINT TRIGGER "pos_cash_ledger_custody_requires_bag_trigger" AFTER INSERT ON "pos_cash_ledger_entries" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "pos_cash_ledger_require_custody_bag"();

COMMENT ON TABLE "pos_cash_ledger_entries" IS 'Append-only cash ledger. Never update/delete; post a compensating reversal.';
COMMENT ON TABLE "pos_cash_custody_bags" IS 'Immutable sealed cash bag root; current state is derived from custody events.';
COMMENT ON TABLE "pos_cash_custody_events" IS 'Append-only dual-custody transition chain.';
