import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const tenantSchemaPath = join(projectRoot, "prisma/tenant/schema.prisma");
const tenantMigrationsPath = join(projectRoot, "prisma/tenant/migrations");
const posMigrationPath = join(
  projectRoot,
  "prisma/tenant/migrations/20260828100000_pos_foundation/migration.sql",
);
const saleSourceMigrationPath = join(
  projectRoot,
  "prisma/tenant/migrations/20260828103000_pos_sale_source/migration.sql",
);
const approvalMigrationPath = join(
  projectRoot,
  "prisma/tenant/migrations/20260828110000_pos_approval_workflow/migration.sql",
);
const trackingMigrationPath = join(
  projectRoot,
  "prisma/tenant/migrations/20260828130000_pos_lot_serial_fefo/migration.sql",
);
const trackingBucketsMigrationPath = join(
  projectRoot,
  "prisma/tenant/migrations/20260828133000_pos_inventory_buckets/migration.sql",
);
const promotionReversalMigrationPath = join(
  projectRoot,
  "prisma/tenant/migrations/20260828150000_pos_promotion_redemption_reversal/migration.sql",
);
const inventoryAdminMigrationPath = join(
  projectRoot,
  "prisma/tenant/migrations/20260828153000_pos_inventory_admin_actions/migration.sql",
);
const valueAccountsMigrationPath = join(
  projectRoot,
  "prisma/tenant/migrations/20260829110000_pos_value_accounts/migration.sql",
);
const productCodesMigrationPath = join(
  projectRoot,
  "prisma/tenant/migrations/20260829130000_pos_product_code_admin/migration.sql",
);
const heldCartTransferMigrationPath = join(
  projectRoot,
  "prisma/tenant/migrations/20260829160000_pos_held_cart_transfer/migration.sql",
);
const genericErpRoutePath = join(projectRoot, "app/api/erp/route.ts");
const tenantSchema = readFileSync(tenantSchemaPath, "utf8");
const posMigration = readFileSync(posMigrationPath, "utf8");
const saleSourceMigration = readFileSync(saleSourceMigrationPath, "utf8");
const approvalMigration = readFileSync(approvalMigrationPath, "utf8");
const trackingMigration = readFileSync(trackingMigrationPath, "utf8");
const trackingBucketsMigration = readFileSync(
  trackingBucketsMigrationPath,
  "utf8",
);
const promotionReversalMigration = readFileSync(
  promotionReversalMigrationPath,
  "utf8",
);
const inventoryAdminMigration = readFileSync(
  inventoryAdminMigrationPath,
  "utf8",
);
const valueAccountsMigration = readFileSync(valueAccountsMigrationPath, "utf8");
const productCodesMigration = readFileSync(productCodesMigrationPath, "utf8");
const heldCartTransferMigration = readFileSync(
  heldCartTransferMigrationPath,
  "utf8",
);
const allTenantMigrations = readdirSync(tenantMigrationsPath, {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name))
  .map((entry) =>
    readFileSync(
      join(tenantMigrationsPath, entry.name, "migration.sql"),
      "utf8",
    ),
  )
  .join("\n");

function withoutSqlComments(value: string) {
  return value.replace(/--[^\n]*/g, "");
}

function sqlStatements(value: string) {
  return withoutSqlComments(value)
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
}

function statementContaining(fragment: string) {
  const normalized = fragment.toLowerCase();
  return (
    sqlStatements(posMigration).find((statement) =>
      statement.includes(normalized),
    ) || ""
  );
}

function modelBlocks(source: string) {
  const blocks = new Map<string, string>();
  for (const match of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm))
    blocks.set(match[1], match[2]);
  return blocks;
}

function mappedTable(block: string) {
  return block.match(/@@map\(\s*"([^"]+)"\s*\)/)?.[1] || null;
}

function assertMappedField(
  blocks: Map<string, string>,
  model: string,
  field: string,
  column: string,
) {
  const block = blocks.get(model);
  assert.ok(block, `modelo Prisma ausente: ${model}`);
  const fieldPattern = new RegExp(
    `^\\s*${field}\\s+[^\\n]*@map\\(\\s*"${column}"\\s*\\)`,
    "m",
  );
  assert.match(block, fieldPattern, `${model}.${field} deve mapear ${column}`);
}

function assertIndexContract(indexName: string, tokens: string[]) {
  const statement = statementContaining(`index "${indexName}"`);
  assert.ok(statement, `índice ausente: ${indexName}`);
  for (const token of tokens)
    assert.ok(
      statement.includes(token.toLowerCase()),
      `${indexName} deve conter ${token}`,
    );
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name.startsWith(".") ||
      entry.name === "node_modules" ||
      entry.name === "generated"
    )
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if ([".ts", ".tsx", ".js", ".jsx"].includes(extname(entry.name)))
      files.push(path);
  }
  return files;
}

test("schema Prisma tenant é válido sem conexão PostgreSQL", () => {
  const prismaCli = resolve(projectRoot, "node_modules/prisma/build/index.js");
  const result = spawnSync(
    process.execPath,
    [prismaCli, "validate", "--config", "prisma.tenant.config.ts"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        TENANT_DATABASE_URL:
          process.env.TENANT_DATABASE_URL ||
          "postgresql://localhost:5432/nalven_pos_contract_validation",
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
});

test("câmera do PDV possui decoder local e diálogos preservam teclado/foco", () => {
  const workspace = readFileSync(
    join(projectRoot, "components/erp/pdv-workspace.tsx"),
    "utf8",
  );
  const packageJson = readFileSync(join(projectRoot, "package.json"), "utf8");
  assert.match(packageJson, /"@zxing\/browser": "\^?0\.2\.1"/);
  assert.match(workspace, /window as unknown as \{ BarcodeDetector\?/);
  assert.match(workspace, /import\("@zxing\/browser"\)/);
  assert.match(workspace, /new BrowserMultiFormatReader/);
  assert.match(workspace, /cameraDecoderControls\.current\?\.stop\(\)/);
  assert.match(workspace, /event\.key !== "Tab"/);
  assert.match(workspace, /button:not\(\[disabled\]\)[\s\S]*\[tabindex\]:not/);
  assert.match(workspace, /returnFocus\.current\?\.focus\(\)/);
});

test("todos os modelos Pos têm tabela criada pela cadeia de migrations", () => {
  const blocks = modelBlocks(tenantSchema);
  const schemaTables = [...blocks.values()]
    .map((block) => mappedTable(block))
    .filter((table): table is string => Boolean(table?.startsWith("pos_")))
    .sort();
  const migrationTables = [
    ...allTenantMigrations.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"(pos_[^"]+)"/gi,
    ),
  ]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(migrationTables, schemaTables);
});

test("campos POS acrescentados a agregados legados permanecem alinhados ao schema", () => {
  const blocks = modelBlocks(tenantSchema);
  const fields = [
    ["Sale", "sessionId", "session_id"],
    ["Sale", "operatorProfileId", "operator_profile_id"],
    ["Sale", "totalCents", "total_cents"],
    ["Sale", "idempotencyKey", "idempotency_key"],
    ["Sale", "requestHash", "request_hash"],
    ["SaleItem", "variationId", "variation_id"],
    ["SaleItem", "surchargeCents", "surcharge_cents"],
    ["SaleItem", "returnedCents", "returned_cents"],
    ["CashRegisterSession", "registerId", "register_id"],
    ["CashRegisterSession", "operatorProfileId", "operator_profile_id"],
    ["CashRegisterSession", "openIdempotencyKey", "open_idempotency_key"],
    ["CashRegisterSession", "openRequestHash", "open_request_hash"],
    ["CashRegisterSession", "closeIdempotencyKey", "close_idempotency_key"],
    ["CashRegisterSession", "closeRequestHash", "close_request_hash"],
    [
      "CashRegisterSession",
      "absoluteDifferenceCents",
      "absolute_difference_cents",
    ],
    ["CashRegisterSession", "closeApprovalId", "close_approval_id"],
    ["CashRegisterEvent", "idempotencyKey", "idempotency_key"],
    ["CashRegisterEvent", "requestHash", "request_hash"],
  ] as const;
  for (const [model, field, column] of fields) {
    assertMappedField(blocks, model, field, column);
    assert.match(
      allTenantMigrations,
      new RegExp(`ADD\\s+COLUMN\\s+"${column}"`, "i"),
      `cadeia de migrations deve adicionar ${column}`,
    );
  }
});

test("migration preserva unicidade de turno e idempotência financeira", () => {
  assertIndexContract("cash_register_sessions_one_open_per_register_idx", [
    "create unique index",
    '"register_id"',
    "where",
    "'open'",
    "'closing'",
  ]);
  assertIndexContract("cash_register_sessions_one_open_per_operator_idx", [
    "create unique index",
    '"operator_profile_id"',
    "where",
    "'open'",
    "'closing'",
  ]);
  assertIndexContract("cash_register_sessions_open_idempotency_key_key", [
    "create unique index",
    '"open_idempotency_key"',
  ]);
  assertIndexContract("cash_register_sessions_close_idempotency_key_key", [
    "create unique index",
    '"close_idempotency_key"',
  ]);
  assertIndexContract("sales_idempotency_key_key", [
    "create unique index",
    '"idempotency_key"',
  ]);
  assertIndexContract("cash_register_events_idempotency_key_key", [
    "create unique index",
    '"idempotency_key"',
  ]);
  assertIndexContract("pos_sale_payments_idempotency_key_key", [
    "create unique index",
    '"idempotency_key"',
  ]);
  assertIndexContract("pos_returns_idempotency_key_key", [
    "create unique index",
    '"idempotency_key"',
  ]);
  assertIndexContract("pos_held_sales_idempotency_key_key", [
    "create unique index",
    '"idempotency_key"',
  ]);
  assertIndexContract("pos_held_sales_discard_idempotency_key_key", [
    "create unique index",
    '"discard_idempotency_key"',
  ]);
  assertIndexContract("pos_sale_payments_provider_transaction_key", [
    "create unique index",
    '"provider"',
    '"transaction_id"',
    "where",
  ]);
  assertIndexContract("pos_sale_payments_end_to_end_key", [
    "create unique index",
    '"end_to_end_id"',
    "where",
  ]);
});

test("migration protege equações monetárias e vínculos compostos do POS", () => {
  const saleEquation = statementContaining(
    'constraint "sales_pos_total_equation_check"',
  );
  assert.ok(
    saleEquation.includes(
      '"total_cents" = "subtotal_cents" - "discount_cents" + "surcharge_cents"',
    ),
  );

  const itemAmounts = statementContaining(
    'constraint "sale_items_pos_amounts_check"',
  );
  for (const invariant of [
    '"total_cents" = "gross_cents" - "discount_cents" + "surcharge_cents"',
    '"returned_quantity" <= "quantity"',
    '"returned_cents" <= "total_cents"',
  ])
    assert.ok(
      itemAmounts.includes(invariant),
      `sale_items deve preservar ${invariant}`,
    );

  for (const constraint of [
    "pos_product_codes_variation_product_fkey",
    "sale_items_variation_product_fkey",
    "pos_held_sale_items_variation_product_fkey",
    "pos_return_items_sale_item_product_fkey",
    "pos_sale_payments_original_same_sale_fkey",
  ])
    assert.ok(
      statementContaining(`constraint "${constraint}"`),
      `constraint ausente: ${constraint}`,
    );
});

test("backfill de códigos legados importa apenas códigos não ambíguos", () => {
  const backfill = statementContaining('insert into "pos_product_codes"');
  assert.ok(
    backfill.includes(
      'having count(distinct "product_id") = 1 and count(*) = 1',
    ),
  );
  assert.ok(
    !backfill.includes("on conflict"),
    "duplicidades não podem ser descartadas silenciosamente pelo backfill",
  );
});

test("create_sale legado responde 410 antes de qualquer fluxo operacional", () => {
  const source = readFileSync(genericErpRoutePath, "utf8");
  const guardMatch = source.match(
    /if\s*\(\s*body\.action\s*===\s*["']create_sale["']\s*\)\s*\{([\s\S]*?)\}/,
  );
  assert.ok(guardMatch, "guard de create_sale ausente");
  assert.match(
    guardMatch[1],
    /return\s+bad\([\s\S]*?,\s*410\s*\)/,
    "create_sale deve encerrar com HTTP 410",
  );
  const operationalFlow = source.indexOf(
    "operationalContext(",
    guardMatch.index,
  );
  assert.ok(
    operationalFlow > (guardMatch.index || 0),
    "o bloqueio deve ocorrer antes do contexto que permite mutações",
  );
});

test("frontend não possui consumidor do comando create_sale", () => {
  const frontendFiles = [
    ...sourceFiles(join(projectRoot, "components")),
    ...sourceFiles(join(projectRoot, "app")).filter(
      (path) => !path.includes(`${join("app", "api")}/`),
    ),
  ];
  const consumers = frontendFiles.filter((path) =>
    /["']create_sale["']/.test(readFileSync(path, "utf8")),
  );
  assert.deepEqual(
    consumers.map((path) => path.slice(projectRoot.length + 1)),
    [],
  );
});

test("comandos operacionais restantes exigem chave idempotente explícita", () => {
  const source = readFileSync(
    join(projectRoot, "app/api/erp/pdv/route.ts"),
    "utf8",
  );
  for (const functionName of [
    "openSession",
    "closeSession",
    "holdCart",
    "discardCart",
  ]) {
    const start = source.indexOf(`async function ${functionName}(`);
    assert.ok(start >= 0, `função ausente: ${functionName}`);
    const end = source.indexOf("\nasync function ", start + 1);
    const block = source.slice(start, end >= 0 ? end : undefined);
    assert.match(
      block,
      /string\(body\.idempotencyKey,\s*["']Chave idempotente["']/,
      `${functionName} deve exigir idempotencyKey`,
    );
    assert.doesNotMatch(
      block,
      /legacy:/,
      `${functionName} não pode simular idempotência com fallback aleatório`,
    );
  }
});

test("origem operacional única impede nova dupla contagem de pedidos", () => {
  const blocks = modelBlocks(tenantSchema);
  assertMappedField(blocks, "Sale", "sourceType", "source_type");
  assertMappedField(blocks, "Sale", "sourceId", "source_id");
  assert.match(
    blocks.get("Sale") || "",
    /@@unique\(\[sourceType,\s*sourceId\]\)/,
  );
  assert.match(
    saleSourceMigration,
    /CREATE UNIQUE INDEX "sales_source_type_source_id_key" ON "sales"\("source_type", "source_id"\)/,
  );
  assert.match(saleSourceMigration, /CONSTRAINT "sales_source_pair_check"/);
  for (const route of [
    "app/api/erp/orders/route.ts",
    "app/api/erp/logistics/route.ts",
  ]) {
    const source = readFileSync(join(projectRoot, route), "utf8");
    assert.match(
      source,
      /sourceType:\s*"sales_order"/i,
      `${route} deve vincular Sale ao pedido`,
    );
  }
  const serviceSource = readFileSync(
    join(projectRoot, "app/api/erp/service-orders/route.ts"),
    "utf8",
  );
  assert.match(serviceSource, /sourceType:\s*"service_order"/i);
  const reportSource = readFileSync(
    join(projectRoot, "app/api/erp/reports/sales/route.ts"),
    "utf8",
  );
  assert.match(reportSource, /linkedOrderIds/);
  assert.match(
    reportSource,
    /orders\.filter\(\(order\) => !linkedOrderIds\.has/,
  );
});

test("aprovações têm escopo, idempotência e consumo único dentro da operação", () => {
  const blocks = modelBlocks(tenantSchema);
  for (const [field, column] of [
    ["branchId", "branch_id"],
    ["idempotencyKey", "idempotency_key"],
    ["requestHash", "request_hash"],
    ["consumedAt", "consumed_at"],
    ["consumedBy", "consumed_by"],
    ["consumptionRef", "consumption_ref"],
  ] as const)
    assertMappedField(blocks, "PosApproval", field, column);
  assert.match(
    approvalMigration,
    /CREATE UNIQUE INDEX "pos_approvals_branch_id_requester_id_idempotency_key_key"/,
  );
  assert.match(
    approvalMigration,
    /FOREIGN KEY \("branch_id"\) REFERENCES "branches"\("id"\)/,
  );
  const operationalRoute = readFileSync(
    join(projectRoot, "app/api/erp/pdv/route.ts"),
    "utf8",
  );
  assert.match(operationalRoute, /async function consumeApprovedPosAction/);
  assert.match(operationalRoute, /consumedAt:\s*null/);
  for (const action of [
    "cash.withdrawal",
    "sale.cancel",
    "return.create",
    "session.close.divergence",
    "discount.override",
  ])
    assert.match(
      operationalRoute,
      new RegExp(`consumeApprovedPosAction\\([^)]*?"${action}"`, "s"),
    );
});

test("desconto excepcional preserva quote autoritativa e consome aprovação contextual só no commit", () => {
  const route = readFileSync(
    join(projectRoot, "app/api/erp/pdv/route.ts"),
    "utf8",
  );
  const approvals = readFileSync(
    join(projectRoot, "lib/erp/pos-approvals.ts"),
    "utf8",
  );
  const policy = readFileSync(
    join(projectRoot, "lib/erp/pos-discount-approval.ts"),
    "utf8",
  );
  const workspace = readFileSync(
    join(projectRoot, "components/erp/pdv-workspace.tsx"),
    "utf8",
  );
  const dialog = readFileSync(
    join(projectRoot, "components/erp/pdv-approval-dialog.tsx"),
    "utf8",
  );
  assert.match(
    approvals,
    /"discount\.override": \{ entityType: "sale_draft", entityRequired: true \}/,
  );
  for (const field of [
    "saleDraftId",
    "sessionId",
    "grossCents",
    "manualDiscountCents",
    "basisPoints",
  ])
    assert.match(policy, new RegExp(field));
  assert.match(policy, /orderDiscountCents \+ lineDiscountCents/);
  assert.doesNotMatch(policy, /promotionDiscountCents/);
  const quote = route.slice(
    route.indexOf("async function quotePromotion"),
    route.indexOf("function requestedSaleLines"),
  );
  assert.match(quote, /saleDraftId/);
  assert.match(quote, /assertApprovedPosAction/);
  assert.doesNotMatch(quote, /consumeApprovedPosAction/);
  const commit = route.slice(
    route.indexOf("async function commitSale"),
    route.indexOf("async function cancelSale"),
  );
  assert.ok(
    commit.indexOf("const replay = await db.sale.findUnique") <
      commit.indexOf("ownedBoundOpenSession"),
    "replay da venda deve sobreviver ao fechamento posterior do turno",
  );
  assert.match(
    commit,
    /authoritativePromotionQuote\(\s*tx,\s*context,\s*idempotencyKey/,
  );
  assert.match(
    commit,
    /consumeApprovedPosAction\(\s*tx,\s*context,\s*discountApprovalId,\s*"discount\.override",\s*"sale_draft",\s*idempotencyKey,\s*idempotencyKey,\s*discountApproval\.context,?\s*\)/,
  );
  assert.ok(
    commit.indexOf("authoritativePayment.plan.quoteHash !== quoted.quoteHash") <
      commit.indexOf("consumeApprovedPosAction"),
  );
  assert.match(commit, /isolationLevel: "Serializable"/);
  assert.match(workspace, /saleDraftId: saleIdempotencyKey\.current/);
  assert.match(workspace, /entityId: saleIdempotencyKey\.current/);
  assert.match(workspace, /\/api\/erp\/pdv\/approvals/);
  assert.match(workspace, /setDiscountApproval\(null\)/);
  assert.match(workspace, /function replaceDiscountApprovalRequest/);
  assert.match(workspace, /Criar novo pedido/);
  assert.doesNotMatch(dialog, /<option value="discount\.override">/);
});

test("promoção é cotada e revalidada no commit sem confiar no navegador", () => {
  const route = readFileSync(
    join(projectRoot, "app/api/erp/pdv/route.ts"),
    "utf8",
  );
  const workspace = readFileSync(
    join(projectRoot, "components/erp/pdv-workspace.tsx"),
    "utf8",
  );
  const domain = readFileSync(
    join(projectRoot, "lib/erp/pos-promotions.ts"),
    "utf8",
  );
  assert.match(route, /action === "promotion\.quote"/);
  assert.match(
    route,
    /async function quotePromotion[\s\S]*?isolationLevel: "Serializable"/,
  );
  assert.match(
    route,
    /authoritativePromotionQuote\(\s*tx,[\s\S]*?true,?\s*\)/,
    "commit deve recalcular e travar promoções",
  );
  const quoteCheck = route.indexOf(
    "authoritativePayment.plan.quoteHash !== quoted.quoteHash",
  );
  const settlement = route.indexOf(
    "settlePosPayments(pricing.totalCents",
    quoteCheck,
  );
  assert.ok(
    quoteCheck >= 0 && settlement > quoteCheck,
    "cotação deve ser validada antes da liquidação",
  );
  assert.match(
    route,
    /findUnique\(\{ where: \{ codeHash: couponCodeHash \} \}\)/,
  );
  assert.match(
    route,
    /posCoupon\.updateMany[\s\S]*?usedCount: \{ increment: 1 \}/,
  );
  assert.match(
    route,
    /promotionUses:\s*\{\s*create:/,
    "resgate deve nascer na transação da venda",
  );
  assert.match(
    route,
    /saleCommitRequestHash\(\s*body,\s*couponCode\?\.hash \?\? null,\s*couponQrToken,?\s*\)/,
    "hash idempotente deve receber somente a identidade protegida do cupom",
  );
  assert.match(
    route,
    /function saleCommitRequestHash[\s\S]*couponCode: couponCodeHash/,
    "hash idempotente não pode persistir cupom aberto",
  );
  assert.match(
    route,
    /error as \{ code\?: string \}\)\?\.code === "P2034"[\s\S]*?status: 409/,
    "conflito serializável deve ser retry/409, nunca 500",
  );
  assert.match(domain, /createHash\("sha256"\)/);
  assert.match(workspace, /activePromotionQuote/);
  assert.match(
    workspace,
    /setTimeout\(\(\) => void quoteBestPromotion\(\), 450\)/,
    "a cotação deve ocorrer automaticamente após o rascunho ficar estável",
  );
  assert.match(
    workspace,
    /Atualizar total/,
    "a ação manual deve existir somente como recuperação da cotação",
  );
  assert.match(workspace, /promotionQuote: \{/);
});

test("reversão promocional preserva histórico, libera limites e ocorre apenas no encerramento integral", () => {
  const blocks = modelBlocks(tenantSchema);
  const route = readFileSync(
    join(projectRoot, "app/api/erp/pdv/route.ts"),
    "utf8",
  );
  const admin = readFileSync(
    join(projectRoot, "app/api/erp/pdv/promotions/route.ts"),
    "utf8",
  );
  for (const [field, column] of [
    ["reversedAt", "reversed_at"],
    ["reversedBy", "reversed_by"],
    ["reversalReason", "reversal_reason"],
  ] as const)
    assertMappedField(blocks, "PosPromotionRedemption", field, column);
  assert.match(
    promotionReversalMigration,
    /pos_promotion_redemptions_reversal_coherence_check/,
  );
  assert.match(
    promotionReversalMigration,
    /pos_coupons_used_count_nonnegative_check/,
  );
  assert.match(
    promotionReversalMigration,
    /reversed_at[\s\S]*reversed_by[\s\S]*reversal_reason/,
  );
  assert.match(
    route,
    /groupBy\([\s\S]*?reversedAt: null/,
    "limites futuros devem contar somente resgates ativos",
  );
  assert.match(
    admin,
    /redemptions: \{ where: \{ reversedAt: null \} \}/,
    "painel deve exibir somente resgates ativos",
  );
  assert.match(
    route,
    /if \(refundConfirmed && fullyReturned\) \{[\s\S]*?await reverseSalePromotionRedemptions/,
  );
  assert.match(
    route,
    /await reverseSalePromotionRedemptions\(\s*tx,\s*context,\s*sale\.id,\s*"sale_cancel"/,
  );
  const reversal = route.slice(
    route.indexOf("async function reverseSalePromotionRedemptions"),
    route.indexOf("\nasync function ownedOpenSession"),
  );
  assert.match(reversal, /pos_promotion_redemptions[\s\S]*FOR UPDATE/);
  assert.match(reversal, /pos_coupons[\s\S]*FOR UPDATE/);
  assert.match(
    reversal,
    /usedCount: coupon\.usedCount[\s\S]*decrement: decrement\.count/,
    "contador deve usar CAS e nunca decrementar cegamente",
  );
  assert.match(
    reversal,
    /reversedAt: null[\s\S]*data: \{ reversedAt, reversedBy, reversalReason \}/,
  );
  assert.match(reversal, /tenantAuditEvent\.create/);
  assert.doesNotMatch(reversal, /posPromotionRedemption\.delete/);
});

test("lote, série e FEFO preservam identidade, quantidade e ledger no banco", () => {
  const blocks = modelBlocks(tenantSchema);
  const operationalRoute = readFileSync(
    join(projectRoot, "app/api/erp/pdv/route.ts"),
    "utf8",
  );
  const workspace = readFileSync(
    join(projectRoot, "components/erp/pdv-workspace.tsx"),
    "utf8",
  );
  assert.equal(
    mappedTable(blocks.get("PosInventoryLot") || ""),
    "pos_inventory_lots",
  );
  assert.equal(
    mappedTable(blocks.get("PosInventoryLotMovement") || ""),
    "pos_inventory_lot_movements",
  );
  for (const token of [
    "pos_inventory_lots_identity_check",
    "pos_inventory_lots_quantity_check",
    "pos_inventory_lots_lot_identity_key",
    "pos_inventory_lots_serial_identity_key",
    "NULLS NOT DISTINCT",
    "pos_inventory_lots_variation_product_fkey",
    "DEFERRABLE INITIALLY DEFERRED",
    "pos_inventory_lot_movements_amount_check",
    'balance_after_micros" = "balance_before_micros" + "quantity_micros',
    "pos_inventory_lot_movements_idempotency_key_key",
  ])
    assert.ok(
      trackingMigration.includes(token),
      `migration de rastreio deve conter ${token}`,
    );
  for (const token of [
    "bucket_key",
    "pos_inventory_lots_lot_bucket_identity_key",
    "pos_inventory_lots_bucket_status_check",
    "quarantine",
    "NULLS NOT DISTINCT",
  ])
    assert.ok(
      trackingBucketsMigration.includes(token),
      `migration de buckets deve conter ${token}`,
    );
  assert.match(operationalRoute, /allocatePosTrackedSaleItem/);
  assert.match(operationalRoute, /restorePosTrackedSaleItem/);
  assert.match(operationalRoute, /parsePosScanTrackingRequests/);
  assert.match(workspace, /tracking: \[\.\.\.previous/);
});

test("administração de lote/série é isolada, atômica e preserva ledger imutável", () => {
  const route = readFileSync(
    join(projectRoot, "app/api/erp/pdv/inventory/route.ts"),
    "utf8",
  );
  const domain = readFileSync(
    join(projectRoot, "lib/erp/pos-inventory-admin.ts"),
    "utf8",
  );
  const dialog = readFileSync(
    join(projectRoot, "components/erp/pdv-admin-dialog.tsx"),
    "utf8",
  );
  const component = readFileSync(
    join(projectRoot, "components/erp/pdv-inventory-admin.tsx"),
    "utf8",
  );
  for (const action of [
    "inventory.receive",
    "inventory.quarantine",
    "inventory.release",
    "inventory.discard",
  ])
    assert.match(
      inventoryAdminMigration,
      new RegExp(action.replace(".", "\\.")),
    );
  assert.match(
    inventoryAdminMigration,
    /"bucket_key" = 'quarantine' AND "status" = 'quarantine'/,
  );
  assert.doesNotMatch(
    inventoryAdminMigration,
    /"normalized_serial_number" IS NULL/,
  );
  assert.match(route, /readPosJson\(request, 32_768\)/);
  assert.match(route, /pdvAdminMutation\.create/);
  assert.match(route, /tenantAuditEvent\.create/);
  assert.match(route, /isolationLevel: "Serializable"/);
  assert.match(route, /responseBody/);
  assert.match(domain, /FOR UPDATE/);
  assert.match(domain, /updateMany\(\{ where: lotCas\(/);
  assert.match(
    domain,
    /lot\.bucketKey !== "quarantine" \|\| lot\.status !== "quarantine"/,
  );
  assert.match(
    domain,
    /quantityMicros > lot\.quantityMicros - lot\.reservedMicros/,
  );
  assert.match(domain, /normalized_serial_number/);
  assert.doesNotMatch(domain, /posInventoryLot(?:Movement)?\.delete/);
  assert.match(dialog, /<PdvInventoryAdmin branchId=\{data\.branch\.id\}/);
  assert.match(component, /\/api\/erp\/pdv\/inventory/);
  for (const action of [
    "inventory.receive",
    "inventory.quarantine",
    "inventory.release",
    "inventory.discard",
  ])
    assert.match(component, new RegExp(action.replace(".", "\\.")));
});

test("códigos, embalagens e PLU variável são configuráveis por filial e revalidados na venda", () => {
  const blocks = modelBlocks(tenantSchema);
  const route = readFileSync(
    join(projectRoot, "app/api/erp/pdv/product-codes/route.ts"),
    "utf8",
  );
  const operational = readFileSync(
    join(projectRoot, "app/api/erp/pdv/route.ts"),
    "utf8",
  );
  const workspace = readFileSync(
    join(projectRoot, "components/erp/pdv-workspace.tsx"),
    "utf8",
  );
  const dialog = readFileSync(
    join(projectRoot, "components/erp/pdv-admin-dialog.tsx"),
    "utf8",
  );
  const component = readFileSync(
    join(projectRoot, "components/erp/pdv-product-codes-admin.tsx"),
    "utf8",
  );
  const resolver = readFileSync(
    join(projectRoot, "lib/erp/pos-product-codes.ts"),
    "utf8",
  );
  assert.equal(
    mappedTable(blocks.get("PosVariableCodeRule") || ""),
    "pos_variable_code_rules",
  );
  assert.match(
    blocks.get("PosProductCode") || "",
    /version\s+Int\s+@default\(0\)/,
  );
  for (const token of [
    "pos_variable_code_rules_format_check",
    "pos_variable_code_rules_branch_id_name_key",
    "pos_product_codes_values_check",
    "product_code.create",
    "product_code.update",
    "product_code.deactivate",
    "variable_code_rule.create",
    "variable_code_rule.update",
    "variable_code_rule.deactivate",
  ])
    assert.match(
      productCodesMigration,
      new RegExp(token.replaceAll(".", "\\.")),
    );
  assert.match(route, /pdvAdminMutation\.create/);
  assert.match(route, /tenantAuditEvent\.create/);
  assert.match(route, /isolationLevel: "Serializable"/);
  assert.match(
    operational,
    /resolvePosProductCode\(\s*db,\s*context\.branch\.id,\s*body\.code,?\s*\)/,
  );
  assert.match(operational, /classifyPosScanPurpose\(body\.code\)/);
  assert.match(operational, /QR Pix é um instrumento de pagamento/);
  assert.match(operational, /QR fiscal identifica um documento/);
  assert.match(
    operational,
    /assertAuthoritativePosCodeReads\(\s*tx,\s*context\.branch\.id/,
  );
  assert.match(
    resolver,
    /scopeKey: \{ in: \[`branch:\$\{branchId\}`, "global"\] \}/,
  );
  assert.match(resolver, /Etiqueta variável ambígua/);
  assert.doesNotMatch(
    resolver,
    /startsWith\(["']2[0-9]["']\)/,
    "prefixo de etiqueta não pode ser regra global hard-coded",
  );
  assert.match(
    workspace,
    /merged\.codeReads = \[\.\.\.codeReads\(existing\?\.scanData\), incoming\.codeRead\]/,
  );
  assert.match(
    workspace,
    /disabled=\{[^}]*hasCodeReads\(line\.scanData\)[^}]*\}/,
  );
  assert.match(dialog, /<PdvProductCodesAdmin branchId=\{data\.branch\.id\}/);
  assert.match(component, /\/api\/erp\/pdv\/product-codes/);
  assert.match(
    component,
    /Drivers de balança e homologação de hardware permanecem externos/,
  );
});

test("transferência de carrinho suspenso usa posse versionada e ledger imutável", () => {
  const blocks = modelBlocks(tenantSchema);
  const held = blocks.get("PosHeldSale") || "";
  const access = blocks.get("PosRegisterAccess") || "";
  const transfer = blocks.get("PosHeldSaleTransfer") || "";
  const domain = readFileSync(
    join(projectRoot, "lib/erp/pos-held-cart-transfer.ts"),
    "utf8",
  );
  const route = readFileSync(
    join(projectRoot, "app/api/erp/pdv/held-sales/transfer/route.ts"),
    "utf8",
  );
  const operational = readFileSync(
    join(projectRoot, "app/api/erp/pdv/route.ts"),
    "utf8",
  );
  const workspace = readFileSync(
    join(projectRoot, "components/erp/pdv-workspace.tsx"),
    "utf8",
  );
  assert.equal(mappedTable(transfer), "pos_held_sale_transfers");
  assert.match(held, /revision\s+Int\s+@default\(0\)/);
  assert.match(
    access,
    /canTransferHeld\s+Boolean\s+@default\(false\)\s+@map\("can_transfer_held"\)/,
  );
  for (const token of [
    "pos_held_sales_revision_check",
    "pos_held_sale_transfers_revision_check",
    "pos_held_sale_transfers_distinct_check",
    "pos_held_sale_transfers_idempotency_key_key",
    "pos_held_sale_transfers_held_sale_id_resulting_revision_key",
    "pos_held_sale_transfers_from_session_register_fkey",
    "pos_held_sale_transfers_to_session_register_fkey",
    "pos_held_sale_transfers_from_register_branch_fkey",
    "pos_held_sale_transfers_to_register_branch_fkey",
    "pos_held_sale_transfers_immutable_guard",
    "reject_pos_held_sale_transfer_mutation",
  ])
    assert.match(heldCartTransferMigration, new RegExp(token));
  assert.doesNotMatch(heldCartTransferMigration, /"tenant_id"/);
  assert.match(domain, /FOR UPDATE/);
  assert.match(domain, /revision: \{ increment: 1 \}/);
  assert.match(domain, /fromOperatorProfileId: held\.operatorProfileId/);
  assert.match(domain, /toOperatorProfileId: target\.operatorProfileId/);
  assert.match(domain, /target\.operatorProfileId === context\.actorProfileId/);
  assert.doesNotMatch(
    domain,
    /posHeldSaleTransfer\.(?:update|updateMany|delete|deleteMany)/,
  );
  assert.match(route, /executePosHeldCartTransfer/);
  assert.match(
    operational,
    /async function discardCart[\s\S]*integerRange\(\s*body\.expectedRevision[\s\S]*FOR UPDATE[\s\S]*revision:\s*expectedRevision[\s\S]*operatorProfileId:\s*held\.operatorProfileId/,
  );
  assert.match(workspace, /Transferir suspensão/);
  assert.match(
    workspace,
    /action: "cart\.discard"[\s\S]*expectedRevision: held\.revision/,
  );
  assert.match(workspace, /expectedRevision: heldTransfer\.revision/);
  assert.match(
    workspace,
    /O receptor ainda revalidará preços, promoções, estoque e pagamentos/,
  );
});

test("fidelidade, gift card e crédito-loja usam saldo CAS e ledger compensatório imutável", () => {
  const blocks = modelBlocks(tenantSchema);
  const domain = readFileSync(
    join(projectRoot, "lib/erp/pos-value-accounts.ts"),
    "utf8",
  );
  const route = readFileSync(
    join(projectRoot, "app/api/erp/pdv/value-accounts/route.ts"),
    "utf8",
  );
  const resolveRoute = readFileSync(
    join(projectRoot, "app/api/erp/pdv/value-accounts/resolve/route.ts"),
    "utf8",
  );
  const dialog = readFileSync(
    join(projectRoot, "components/erp/pdv-admin-dialog.tsx"),
    "utf8",
  );
  const component = readFileSync(
    join(projectRoot, "components/erp/pdv-value-accounts-admin.tsx"),
    "utf8",
  );
  for (const [model, table] of [
    ["PosValueProgram", "pos_value_programs"],
    ["PosValueAccount", "pos_value_accounts"],
    ["PosValueReservation", "pos_value_reservations"],
    ["PosValueLedgerEntry", "pos_value_ledger_entries"],
  ] as const)
    assert.equal(mappedTable(blocks.get(model) || ""), table);
  assert.match(
    blocks.get("PosValueAccount") || "",
    /@@unique\(\[programId, customerId\], map: "pos_value_accounts_program_customer_key"\)/,
  );
  for (const token of [
    "pos_value_accounts_balance_check",
    "pos_value_accounts_identity_check",
    "pos_value_accounts_code_check",
    "pos_value_accounts_program_customer_key",
    "pos_value_reservations_operation_key_key",
    "pos_value_reservations_account_reference_idx",
    "pos_value_ledger_entries_operation_key_key",
    "pos_value_ledger_entries_equation_check",
    "reject_pos_value_ledger_mutation",
    "value.account.issue",
    "value.reservation.capture",
    "value.entry.reverse",
  ])
    assert.match(
      valueAccountsMigration,
      new RegExp(token.replaceAll(".", "\\.")),
    );
  assert.match(
    valueAccountsMigration,
    /"type" = 'issue' AND "balance_delta_units" = "amount_units"/,
  );
  assert.doesNotMatch(
    valueAccountsMigration,
    /UNIQUE INDEX "pos_value_reservations_account_reference_idx"/,
  );
  assert.doesNotMatch(valueAccountsMigration, /"tenant_id"/);
  assert.match(domain, /FOR UPDATE/);
  assert.match(
    domain,
    /posValueAccount\.updateMany\([\s\S]*?version: \{ increment: 1 \}/,
  );
  assert.match(domain, /type: "reversal"/);
  assert.doesNotMatch(
    domain,
    /posValueLedgerEntry\.(?:update|updateMany|delete|deleteMany)/,
  );
  assert.match(route, /pdvAdminMutation\.create/);
  assert.match(route, /tenantAuditEvent\.create/);
  assert.match(route, /isolationLevel: "Serializable"/);
  assert.match(
    resolveRoute,
    /enforcePosRateLimit\(db, actor\.user\.id, "gift\.resolve"\)/,
  );
  assert.match(dialog, /<PdvValueAccountsAdmin branchId=\{data\.branch\.id\}/);
  assert.match(component, /\/api\/erp\/pdv\/value-accounts/);
  for (const action of [
    "value.account.issue",
    "value.account.credit",
    "value.account.debit",
    "value.reservation.create",
    "value.reservation.capture",
    "value.reservation.release",
    "value.entry.reverse",
  ]) {
    assert.match(component, new RegExp(action.replaceAll(".", "\\.")));
  }
});
