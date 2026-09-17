-- Some early installations applied the transactional e-mail catalog before the
-- encrypted recipient/variables columns were included in the migration bundle.
-- Keep the repair additive and safe for both drifted and fresh tenants.
ALTER TABLE "transactional_email_deliveries"
  ADD COLUMN IF NOT EXISTS "recipient_cipher" TEXT,
  ADD COLUMN IF NOT EXISTS "variables_cipher" TEXT;

-- A legacy row cannot be reconstructed from its mask. Preserve that fact rather
-- than fabricating personal data; the worker will classify the row as invalid.
UPDATE "transactional_email_deliveries"
   SET "recipient_cipher" = 'legacy.unavailable'
 WHERE "recipient_cipher" IS NULL;

UPDATE "transactional_email_deliveries"
   SET "variables_cipher" = 'legacy.unavailable'
 WHERE "variables_cipher" IS NULL;

ALTER TABLE "transactional_email_deliveries"
  ALTER COLUMN "recipient_cipher" SET NOT NULL,
  ALTER COLUMN "variables_cipher" SET NOT NULL;
