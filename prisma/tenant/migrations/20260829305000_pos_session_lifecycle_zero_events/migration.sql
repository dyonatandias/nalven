-- Session lifecycle events are audit/idempotency markers, not money movement.
-- Keep every monetary cash-register event strictly positive while allowing an
-- explicit, closed list of lifecycle markers to persist zero cents.
ALTER TABLE "cash_register_events" DROP CONSTRAINT "cash_register_events_positive_amount_check";

ALTER TABLE "cash_register_events"
  ADD CONSTRAINT "cash_register_events_positive_amount_check" CHECK (
    "amount_cents" > 0
    OR (
      "amount_cents" = 0
      AND "type" IN (
        'session_suspended',
        'session_resumed',
        'session_handoff_requested',
        'session_handoff_accepted',
        'session_handoff_cancelled'
      )
    )
  ) NOT VALID;
