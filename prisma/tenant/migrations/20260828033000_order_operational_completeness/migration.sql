ALTER TABLE "order_notification_queue"
  ADD COLUMN "dedup_key" TEXT,
  ADD COLUMN "force" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "payload" JSONB;

CREATE UNIQUE INDEX "order_notification_queue_dedup_key_key"
  ON "order_notification_queue"("dedup_key");

ALTER TABLE "sales_order_items"
  DROP CONSTRAINT IF EXISTS "sales_order_items_sales_order_id_product_id_key";
CREATE UNIQUE INDEX "sales_order_items_sales_order_id_product_id_variation_id_key"
  ON "sales_order_items"("sales_order_id", "product_id", "variation_id");

CREATE TABLE "marketplace_webhook_events" (
  "id" SERIAL PRIMARY KEY,
  "channel_id" INTEGER NOT NULL,
  "event_key" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "payload" JSONB,
  "state" TEXT NOT NULL DEFAULT 'received',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "processed_at" TIMESTAMP(3),
  "next_attempt_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "marketplace_webhook_events_channel_id_fkey"
    FOREIGN KEY ("channel_id") REFERENCES "marketplace_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "marketplace_webhook_events_channel_id_event_key_key"
  ON "marketplace_webhook_events"("channel_id", "event_key");
CREATE INDEX "marketplace_webhook_events_state_next_attempt_at_idx"
  ON "marketplace_webhook_events"("state", "next_attempt_at");

CREATE TABLE "order_shipping_labels" (
  "id" SERIAL PRIMARY KEY,
  "sales_order_id" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "external_id" TEXT,
  "protocol" TEXT,
  "service_id" TEXT,
  "service_name" TEXT,
  "carrier" TEXT,
  "status" TEXT NOT NULL DEFAULT 'quoted',
  "status_label" TEXT,
  "quotation" JSONB,
  "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "invoice_number" TEXT,
  "invoice_key" TEXT,
  "non_commercial" BOOLEAN NOT NULL DEFAULT false,
  "tracking_code" TEXT,
  "tracking_url" TEXT,
  "label_url" TEXT,
  "raw_data" JSONB,
  "purchased_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "order_shipping_labels_sales_order_id_fkey"
    FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "order_shipping_labels_sales_order_id_status_idx"
  ON "order_shipping_labels"("sales_order_id", "status");
CREATE INDEX "order_shipping_labels_external_id_idx"
  ON "order_shipping_labels"("external_id");

CREATE TABLE "order_review_requests" (
  "id" SERIAL PRIMARY KEY,
  "sales_order_id" INTEGER NOT NULL,
  "order_item_id" INTEGER NOT NULL,
  "token" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "send_count" INTEGER NOT NULL DEFAULT 0,
  "last_sent_at" TIMESTAMP(3),
  "opened_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_review_requests_sales_order_id_fkey"
    FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "order_review_requests_order_item_id_fkey"
    FOREIGN KEY ("order_item_id") REFERENCES "sales_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "order_review_requests_token_key"
  ON "order_review_requests"("token");
CREATE UNIQUE INDEX "order_review_requests_sales_order_id_order_item_id_key"
  ON "order_review_requests"("sales_order_id", "order_item_id");
CREATE INDEX "order_review_requests_state_expires_at_idx"
  ON "order_review_requests"("state", "expires_at");

CREATE TABLE "product_reviews" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER NOT NULL,
  "sales_order_id" INTEGER NOT NULL,
  "review_request_id" INTEGER NOT NULL,
  "rating" INTEGER NOT NULL,
  "title" TEXT,
  "content" TEXT NOT NULL,
  "author_name" TEXT NOT NULL,
  "author_email_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "verified_purchase" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_reviews_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_reviews_review_request_id_fkey" FOREIGN KEY ("review_request_id") REFERENCES "order_review_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_reviews_rating_check" CHECK ("rating" BETWEEN 1 AND 5)
);

CREATE UNIQUE INDEX "product_reviews_review_request_id_key" ON "product_reviews"("review_request_id");
CREATE INDEX "product_reviews_product_id_status_created_at_idx" ON "product_reviews"("product_id", "status", "created_at");
CREATE INDEX "product_reviews_sales_order_id_idx" ON "product_reviews"("sales_order_id");
