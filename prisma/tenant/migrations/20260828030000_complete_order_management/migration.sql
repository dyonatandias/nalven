-- Complete order management domain. Existing sales/logistics data is preserved.
ALTER TABLE "sales_orders"
  ADD COLUMN "order_key" TEXT,
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'BRL', ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "tax_amount" DOUBLE PRECISION NOT NULL DEFAULT 0, ADD COLUMN "refunded_total" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "payment_title" TEXT, ADD COLUMN "transaction_id" TEXT,
  ADD COLUMN "shipping_pending" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "needs_processing" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "notification_managed" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "marketplace_notified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ip_address" TEXT, ADD COLUMN "user_agent" TEXT,
  ADD COLUMN "placed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ADD COLUMN "paid_at" TIMESTAMP(3), ADD COLUMN "deleted_at" TIMESTAMP(3);
UPDATE "sales_orders" SET "order_key"=md5(random()::text||clock_timestamp()::text||"id"::text)||md5(random()::text||"number");
ALTER TABLE "sales_orders" ALTER COLUMN "order_key" SET NOT NULL;
CREATE UNIQUE INDEX "sales_orders_order_key_key" ON "sales_orders"("order_key");
CREATE INDEX "sales_orders_deleted_at_status_created_at_idx" ON "sales_orders"("deleted_at","status","created_at");
CREATE INDEX "sales_orders_shipping_pending_status_idx" ON "sales_orders"("shipping_pending","status");
CREATE INDEX "sales_orders_origin_created_at_idx" ON "sales_orders"("origin","created_at");

ALTER TABLE "sales_order_items"
  ADD COLUMN "variation_id" INTEGER, ADD COLUMN "item_type" TEXT NOT NULL DEFAULT 'line_item',
  ADD COLUMN "name_snapshot" TEXT NOT NULL DEFAULT '', ADD COLUMN "sku_snapshot" TEXT,
  ADD COLUMN "variation_snapshot" JSONB, ADD COLUMN "image_snapshot" TEXT,
  ADD COLUMN "tax_total" DOUBLE PRECISION NOT NULL DEFAULT 0, ADD COLUMN "refunded_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0;
UPDATE "sales_order_items" i SET "name_snapshot"=p."name", "sku_snapshot"=p."sku" FROM "products" p WHERE p."id"=i."product_id";
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_variation_id_fkey" FOREIGN KEY ("variation_id") REFERENCES "product_variations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "sales_order_items_variation_id_idx" ON "sales_order_items"("variation_id");
CREATE INDEX "sales_order_items_sales_order_id_item_type_idx" ON "sales_order_items"("sales_order_id","item_type");

ALTER TABLE "sales_order_history" ADD COLUMN "actor_type" TEXT NOT NULL DEFAULT 'user', ADD COLUMN "actor_id" TEXT, ADD COLUMN "reason" TEXT;
ALTER TABLE "marketplace_orders"
  ADD COLUMN "marketplace_status" TEXT, ADD COLUMN "connection_id" TEXT, ADD COLUMN "shipment_external_id" TEXT,
  ADD COLUMN "logistic_type" TEXT, ADD COLUMN "buyer_shipping_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "seller_shipping_cost" DOUBLE PRECISION NOT NULL DEFAULT 0, ADD COLUMN "commission" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "invoice_external_id" TEXT, ADD COLUMN "invoice_status" TEXT, ADD COLUMN "raw_data" JSONB,
  ADD COLUMN "import_attempts" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "next_import_at" TIMESTAMP(3), ADD COLUMN "last_error" TEXT;

CREATE TABLE "order_addresses" (
 "id" SERIAL PRIMARY KEY,"sales_order_id" INTEGER NOT NULL,"type" TEXT NOT NULL,"first_name" TEXT,"last_name" TEXT,"company" TEXT,"email" TEXT,"phone" TEXT,
 "document_type" TEXT,"document" TEXT,"zip" TEXT,"street" TEXT,"number" TEXT,"complement" TEXT,"neighborhood" TEXT,"city" TEXT,"state" TEXT,"country" TEXT NOT NULL DEFAULT 'BR',
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "order_addresses_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE UNIQUE INDEX "order_addresses_sales_order_id_type_key" ON "order_addresses"("sales_order_id","type");
CREATE INDEX "order_addresses_document_idx" ON "order_addresses"("document");

CREATE TABLE "order_item_meta" ("id" SERIAL PRIMARY KEY,"order_item_id" INTEGER NOT NULL,"key" TEXT NOT NULL,"value" TEXT NOT NULL,"display_key" TEXT,"display_value" TEXT,"visible" BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT "order_item_meta_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "sales_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE INDEX "order_item_meta_order_item_id_visible_idx" ON "order_item_meta"("order_item_id","visible");

CREATE TABLE "order_status_definitions" ("id" SERIAL PRIMARY KEY,"key" TEXT NOT NULL,"label" TEXT NOT NULL,"color" TEXT NOT NULL,"icon" TEXT,"description" TEXT,"position" INTEGER NOT NULL DEFAULT 0,"native" BOOLEAN NOT NULL DEFAULT false,"email_template" JSONB,"whatsapp_template" JSONB,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL);
CREATE UNIQUE INDEX "order_status_definitions_key_key" ON "order_status_definitions"("key");
CREATE INDEX "order_status_definitions_position_idx" ON "order_status_definitions"("position");

CREATE TABLE "order_notes" ("id" SERIAL PRIMARY KEY,"sales_order_id" INTEGER NOT NULL,"content" TEXT NOT NULL,"customer_visible" BOOLEAN NOT NULL DEFAULT false,"author_type" TEXT NOT NULL DEFAULT 'user',"author" TEXT NOT NULL,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "order_notes_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE INDEX "order_notes_sales_order_id_created_at_idx" ON "order_notes"("sales_order_id","created_at");
CREATE INDEX "order_notes_sales_order_id_customer_visible_idx" ON "order_notes"("sales_order_id","customer_visible");

CREATE TABLE "order_refunds" ("id" SERIAL PRIMARY KEY,"sales_order_id" INTEGER NOT NULL,"amount" DOUBLE PRECISION NOT NULL,"reason" TEXT,"mode" TEXT NOT NULL DEFAULT 'amount',"gateway_refund_id" TEXT,"refund_payment" BOOLEAN NOT NULL DEFAULT false,"restock" BOOLEAN NOT NULL DEFAULT false,"actor" TEXT NOT NULL,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "order_refunds_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE INDEX "order_refunds_sales_order_id_created_at_idx" ON "order_refunds"("sales_order_id","created_at");
CREATE TABLE "order_refund_items" ("id" SERIAL PRIMARY KEY,"refund_id" INTEGER NOT NULL,"order_item_id" INTEGER NOT NULL,"quantity" DOUBLE PRECISION NOT NULL,"amount" DOUBLE PRECISION NOT NULL,
 CONSTRAINT "order_refund_items_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "order_refunds"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "order_refund_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "sales_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE);
CREATE UNIQUE INDEX "order_refund_items_refund_id_order_item_id_key" ON "order_refund_items"("refund_id","order_item_id");

CREATE TABLE "order_tracking" ("id" SERIAL PRIMARY KEY,"sales_order_id" INTEGER NOT NULL,"tracking_number" TEXT NOT NULL,"carrier" TEXT,"carrier_key" TEXT,"tracking_url" TEXT,"status" TEXT,"status_label" TEXT,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "order_tracking_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE UNIQUE INDEX "order_tracking_sales_order_id_key" ON "order_tracking"("sales_order_id"); CREATE INDEX "order_tracking_tracking_number_idx" ON "order_tracking"("tracking_number");
CREATE TABLE "order_tracking_events" ("id" SERIAL PRIMARY KEY,"tracking_id" INTEGER NOT NULL,"status" TEXT,"description" TEXT NOT NULL,"location" TEXT,"occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "order_tracking_events_tracking_id_fkey" FOREIGN KEY ("tracking_id") REFERENCES "order_tracking"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE INDEX "order_tracking_events_tracking_id_occurred_at_idx" ON "order_tracking_events"("tracking_id","occurred_at");

CREATE TABLE "shipping_carriers" ("id" SERIAL PRIMARY KEY,"key" TEXT NOT NULL,"label" TEXT NOT NULL,"url_template" TEXT,"keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],"patterns" TEXT[] DEFAULT ARRAY[]::TEXT[],"active" BOOLEAN NOT NULL DEFAULT true,"position" INTEGER NOT NULL DEFAULT 0,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL);
CREATE UNIQUE INDEX "shipping_carriers_key_key" ON "shipping_carriers"("key"); CREATE INDEX "shipping_carriers_active_position_idx" ON "shipping_carriers"("active","position");

CREATE TABLE "order_notification_log" ("id" SERIAL PRIMARY KEY,"sales_order_id" INTEGER NOT NULL,"status_trigger" TEXT,"channel" TEXT NOT NULL,"recipient_type" TEXT NOT NULL,"recipient_masked" TEXT,"success" BOOLEAN NOT NULL DEFAULT false,"skipped" BOOLEAN NOT NULL DEFAULT false,"skip_reason" TEXT,"error" TEXT,"pdf_ok" BOOLEAN,"consent_basis" TEXT,"sent_at" TIMESTAMP(3),"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "order_notification_log_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE INDEX "order_notification_log_sales_order_id_created_at_idx" ON "order_notification_log"("sales_order_id","created_at"); CREATE INDEX "order_notification_log_channel_success_created_at_idx" ON "order_notification_log"("channel","success","created_at"); CREATE INDEX "order_notification_log_dedup_idx" ON "order_notification_log"("sales_order_id","status_trigger","channel","recipient_type");
CREATE TABLE "order_notification_queue" ("id" SERIAL PRIMARY KEY,"sales_order_id" INTEGER NOT NULL,"status_trigger" TEXT,"channel" TEXT NOT NULL,"recipient_type" TEXT NOT NULL,"state" TEXT NOT NULL DEFAULT 'pending',"attempts" INTEGER NOT NULL DEFAULT 0,"next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"claimed_at" TIMESTAMP(3),"last_error" TEXT,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "order_notification_queue_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE INDEX "order_notification_queue_state_next_attempt_at_idx" ON "order_notification_queue"("state","next_attempt_at"); CREATE INDEX "order_notification_queue_channel_state_created_at_idx" ON "order_notification_queue"("channel","state","created_at");
CREATE TABLE "order_notification_settings" ("id" INTEGER PRIMARY KEY DEFAULT 1,"enabled" BOOLEAN NOT NULL DEFAULT false,"settings" JSONB NOT NULL,"updated_by" TEXT,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL);

CREATE TABLE "order_idempotency" ("id" SERIAL PRIMARY KEY,"key" TEXT NOT NULL,"request_hash" TEXT NOT NULL,"state" TEXT NOT NULL DEFAULT 'processing',"sales_order_id" INTEGER,"response_status" INTEGER,"response_body" JSONB,"expires_at" TIMESTAMP(3) NOT NULL,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "order_idempotency_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE);
CREATE UNIQUE INDEX "order_idempotency_key_key" ON "order_idempotency"("key"); CREATE INDEX "order_idempotency_state_expires_at_idx" ON "order_idempotency"("state","expires_at");
CREATE TABLE "order_payments" ("id" SERIAL PRIMARY KEY,"sales_order_id" INTEGER NOT NULL,"type" TEXT NOT NULL DEFAULT 'order',"method" TEXT,"status" TEXT NOT NULL DEFAULT 'pending',"amount" DOUBLE PRECISION NOT NULL,"transaction_id" TEXT,"payment_url" TEXT,"paid_at" TIMESTAMP(3),"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "order_payments_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE INDEX "order_payments_sales_order_id_status_idx" ON "order_payments"("sales_order_id","status");

CREATE TABLE "order_returns" ("id" SERIAL PRIMARY KEY,"sales_order_id" INTEGER NOT NULL,"customer_id" INTEGER,"reason" TEXT NOT NULL,"description" TEXT NOT NULL,"status" TEXT NOT NULL DEFAULT 'pending',"customer_email" TEXT NOT NULL,"admin_notes" TEXT,"requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"decided_at" TIMESTAMP(3),"completed_at" TIMESTAMP(3),
 CONSTRAINT "order_returns_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "order_returns_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE);
CREATE INDEX "order_returns_status_requested_at_idx" ON "order_returns"("status","requested_at"); CREATE INDEX "order_returns_sales_order_id_status_idx" ON "order_returns"("sales_order_id","status");
CREATE TABLE "order_return_items" ("id" SERIAL PRIMARY KEY,"return_id" INTEGER NOT NULL,"order_item_id" INTEGER NOT NULL,"quantity" DOUBLE PRECISION NOT NULL,
 CONSTRAINT "order_return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "order_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "order_return_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "sales_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE);
CREATE UNIQUE INDEX "order_return_items_return_id_order_item_id_key" ON "order_return_items"("return_id","order_item_id");

CREATE TABLE "order_documents" ("id" SERIAL PRIMARY KEY,"sales_order_id" INTEGER NOT NULL,"type" TEXT NOT NULL,"name" TEXT NOT NULL,"storage_key" TEXT,"external_url" TEXT,"mime_type" TEXT,"created_by" TEXT NOT NULL,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "order_documents_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE INDEX "order_documents_sales_order_id_type_idx" ON "order_documents"("sales_order_id","type");
CREATE TABLE "order_meta" ("id" SERIAL PRIMARY KEY,"sales_order_id" INTEGER NOT NULL,"key" TEXT NOT NULL,"value" JSONB NOT NULL,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "order_meta_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE UNIQUE INDEX "order_meta_sales_order_id_key_key" ON "order_meta"("sales_order_id","key");

INSERT INTO "order_status_definitions" ("key","label","color","icon","description","position","native","updated_at") VALUES
('draft','Rascunho','#64748b','file','Registro ainda não confirmado',0,true,CURRENT_TIMESTAMP),('pending','Pendente','#d97706','clock','Aguardando pagamento',10,true,CURRENT_TIMESTAMP),('processing','Pago','#2563eb','check','Pagamento confirmado',20,true,CURRENT_TIMESTAMP),('on-hold','Em espera','#7c3aed','pause','Aguardando ação operacional',30,true,CURRENT_TIMESTAMP),('preparing','Separando','#0891b2','package','Itens em separação',40,true,CURRENT_TIMESTAMP),('shipped','Enviado','#0284c7','truck','Entregue à transportadora',50,true,CURRENT_TIMESTAMP),('out-delivery','Em rota','#0d9488','route','Saiu para entrega',60,true,CURRENT_TIMESTAMP),('delivered','Entregue','#16a34a','home','Entrega confirmada',70,true,CURRENT_TIMESTAMP),('completed','Concluído','#15803d','check-circle','Fluxo concluído',80,true,CURRENT_TIMESTAMP),('awaiting-shipping','Aguardando frete','#ca8a04','wallet','Aguardando pagamento do frete',90,true,CURRENT_TIMESTAMP),('cancelled','Cancelado','#dc2626','x','Pedido cancelado',100,true,CURRENT_TIMESTAMP),('refunded','Reembolsado','#be123c','refund','Valor integral devolvido',110,true,CURRENT_TIMESTAMP),('failed','Falhou','#991b1b','alert','Pagamento ou processamento falhou',120,true,CURRENT_TIMESTAMP);

INSERT INTO "shipping_carriers" ("key","label","url_template","keywords","patterns","position","updated_at") VALUES
('correios','Correios','https://rastreamento.correios.com.br/app/index.php?objetos={code}',ARRAY['correio','correios'],ARRAY['^[A-Z]{2}[0-9]{9}[A-Z]{2}$','^[A-Z]{2}[0-9]{11}$'],10,CURRENT_TIMESTAMP),('total-express','Total Express','https://totalconecta.totalexpress.com.br/rastreamento/{code}',ARRAY['total express'],ARRAY[]::TEXT[],20,CURRENT_TIMESTAMP),('jadlog','Jadlog','https://www.jadlog.com.br/siteInstitucional/tracking.jad?cte={code}',ARRAY['jadlog'],ARRAY[]::TEXT[],30,CURRENT_TIMESTAMP),('loggi','Loggi','https://www.loggi.com/rastreador/{code}',ARRAY['loggi'],ARRAY[]::TEXT[],40,CURRENT_TIMESTAMP),('jet','Jet Express','https://www.jetexpress.com.br/site/rastreamento?codigo={code}',ARRAY['jet'],ARRAY[]::TEXT[],50,CURRENT_TIMESTAMP),('jt','J&T Express','https://www.jtexpress.com.br/track?billCode={code}',ARRAY['j&t','jt express'],ARRAY[]::TEXT[],60,CURRENT_TIMESTAMP),('azul-cargo','Azul Cargo','https://www.azulcargoexpress.com.br/Rastreio/Rastreio?numero={code}',ARRAY['azul cargo'],ARRAY[]::TEXT[],70,CURRENT_TIMESTAMP),('latam-cargo','LATAM Cargo','https://www.latamcargo.com/pt/trackshipment?documentNumber={code}',ARRAY['latam cargo'],ARRAY[]::TEXT[],80,CURRENT_TIMESTAMP),('sequoia','Sequoia','https://sequoialog.com.br/rastreamento/?codigo={code}',ARRAY['sequoia'],ARRAY[]::TEXT[],90,CURRENT_TIMESTAMP),('buslog','Buslog','https://buslog.com.br/rastreio/{code}',ARRAY['buslog'],ARRAY[]::TEXT[],100,CURRENT_TIMESTAMP),('melhor-envio','Melhor Envio','https://melhorrastreio.com.br/rastreio/{code}',ARRAY['melhor envio'],ARRAY[]::TEXT[],110,CURRENT_TIMESTAMP),('frete-a-combinar','Frete a combinar',NULL,ARRAY['frete a combinar'],ARRAY[]::TEXT[],120,CURRENT_TIMESTAMP),('outra','Outra transportadora','https://melhorrastreio.com.br/rastreio/{code}',ARRAY[]::TEXT[],ARRAY[]::TEXT[],130,CURRENT_TIMESTAMP);

INSERT INTO "order_notification_settings" ("id","enabled","settings","updated_at") VALUES
(1,false,'{"email":{"enabled":false,"recipients":[],"triggerStatuses":["pending","on-hold","processing"],"includePdf":true,"subjectTemplate":"Novo pedido #{order_id} — {customer_name} ({total})","replyTo":""},"whatsappAdmin":{"enabled":false,"recipients":[],"triggerStatuses":["pending","on-hold","processing"],"templates":{}},"whatsappCustomer":{"enabled":false,"triggerStatuses":["shipped","delivered"],"templates":{},"includeNotes":false},"matrix":{},"policies":{},"synchronousDispatch":true,"logRetentionDays":90,"anonymizeOnCleanup":false,"dailySummary":{"enabled":false,"hour":18,"recipients":[]},"previewSampleData":{}}'::jsonb,CURRENT_TIMESTAMP);

INSERT INTO "order_addresses" ("sales_order_id","type","first_name","email","phone","document","zip","street","number","complement","neighborhood","city","state","updated_at")
SELECT "id",'shipping',"customer_name","customer_email","customer_phone","customer_document","delivery_zip","delivery_street","delivery_number","delivery_complement","delivery_district","delivery_city","delivery_state",CURRENT_TIMESTAMP FROM "sales_orders";
