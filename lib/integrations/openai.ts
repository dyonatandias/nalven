import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/tenant/client";
import { normalizeAiPolicy, publicAiError } from "@/lib/erp/ai-control-center";
import {
  activeCredentialFilter,
  decryptSecrets,
  IntegrationError,
  objectValue,
  settingsSection,
} from "./core";

type Input = string | Array<Record<string, unknown>>;
type Options = {
  feature: string;
  input: Input;
  instructions?: string;
  model?: string;
  maxOutputTokens?: number;
  safetyIdentifier?: string;
  estimatedCost?: number;
};
type ResponseBody = {
  id?: string;
  status?: string;
  error?: { message?: string } | null;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export async function createOpenAiResponse(db: PrismaClient, options: Options) {
  const row = await db.integrationSettings.findUniqueOrThrow({
      where: { id: 1 },
    }),
    settings = normalizeAiPolicy(
      settingsSection(row.ai, "ai"),
      settingsSection(row.ai, "ai"),
    );
  if (settings.enabled !== true)
    throw new IntegrationError(
      "A inteligência artificial está desativada.",
      422,
    );
  const allowed = Array.isArray(settings.allowed_models)
      ? settings.allowed_models.map(String)
      : [],
    model = options.model || String(settings.default_model || "gpt-5-mini");
  if (allowed.length && !allowed.includes(model))
    throw new IntegrationError(
      "O modelo solicitado não está permitido para este tenant.",
      403,
    );
  if (settings.consumers[options.feature] === false)
    throw new IntegrationError(
      "Esta funcionalidade de IA está desativada pela política do tenant.",
      403,
    );
  const serializedInput = JSON.stringify(options.input);
  if (Buffer.byteLength(serializedInput, "utf8") > 256 * 1024)
    throw new IntegrationError("A entrada da solicitação excede 256 KB.", 413);
  if (options.instructions && Buffer.byteLength(options.instructions, "utf8") > 32 * 1024)
    throw new IntegrationError("As instruções excedem 32 KB.", 413);
  const source = await resolveKey(
    db,
    String(settings.routing_mode || "platform"),
  );
  const estimatedCost = Math.max(0, Number(options.estimatedCost || 0));
  if (!Number.isFinite(estimatedCost))
    throw new IntegrationError("Estimativa de custo inválida.");
  const reservation = await reserveUsage(
    db,
    options.feature,
    model,
    source.kind,
    estimatedCost,
    settings,
  );
  const started = Date.now(),
    controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 90_000);
  let usageRecorded = false;
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${source.apiKey}`,
        "content-type": "application/json",
        ...(source.projectId ? { "OpenAI-Project": source.projectId } : {}),
        ...(source.organizationId
          ? { "OpenAI-Organization": source.organizationId }
          : {}),
      },
      body: JSON.stringify({
        model,
        input:
          settings.redact_pii === false
            ? options.input
            : redactInput(options.input),
        ...(options.instructions ? { instructions: options.instructions } : {}),
        max_output_tokens: Math.min(
          100_000,
          Math.max(
            1,
            options.maxOutputTokens || Number(settings.max_tokens || 1000),
          ),
        ),
        store: false,
        safety_identifier: safetyId(
          options.safetyIdentifier || options.feature,
        ),
        prompt_cache_key: safetyId(options.feature),
        reasoning: { effort: settings.reasoning_effort },
      }),
    });
    const body = (await response.json().catch(() => ({}))) as ResponseBody;
    const latencyMs = Date.now() - started,
      status = response.ok ? String(body.status || "completed") : "failed";
    await db.integrationAiUsage.update({
      where: { id: reservation.id },
      data: {
        requestId: body.id || null,
        inputTokens: Number(body.usage?.input_tokens || 0),
        outputTokens: Number(body.usage?.output_tokens || 0),
        latencyMs,
        status,
      },
    });
    usageRecorded = true;
    if (!response.ok)
      throw new IntegrationError(
        publicAiError(response.status),
        response.status === 429 ? 429 : 502,
      );
    return {
      id: body.id,
      status,
      model,
      outputText:
        body.output_text ||
        body.output
          ?.flatMap((item) => item.content || [])
          .filter((item) => item.type === "output_text")
          .map((item) => item.text || "")
          .join("\n") ||
        "",
      usage: body.usage || {},
      keySource: source.kind,
    };
  } catch (error) {
    if (!usageRecorded) {
      await db.integrationAiUsage
        .update({
          where: { id: reservation.id },
          data: {
            latencyMs: Date.now() - started,
            status: "failed",
          },
        })
        .catch(() => undefined);
    }
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError(
      error instanceof Error && error.name === "AbortError"
        ? "A OpenAI excedeu o tempo limite."
        : "Não foi possível alcançar a OpenAI.",
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function resolveKey(db: PrismaClient, mode: string) {
  if (["byok", "hybrid"].includes(mode)) {
    const credential = await db.integrationCredential.findFirst({
      where: { providerId: "openai", ...activeCredentialFilter() },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
    if (credential) {
      const secrets = decryptSecrets(credential.secretsCipherText),
        config = objectValue(credential.config);
      if (secrets.api_key)
        return {
          kind: "byok",
          apiKey: secrets.api_key,
          projectId: String(config.project_id || ""),
          organizationId: String(config.organization_id || ""),
        };
    }
    if (mode === "byok")
      throw new IntegrationError(
        "A política exige BYOK, mas não há uma chave OpenAI ativa.",
        422,
      );
  }
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey)
    throw new IntegrationError(
      "A chave OpenAI gerenciada pela plataforma não está configurada.",
      503,
    );
  return {
    kind: "platform",
    apiKey,
    projectId: process.env.OPENAI_PROJECT || "",
    organizationId: process.env.OPENAI_ORG_ID || "",
  };
}

async function reserveUsage(
  db: PrismaClient,
  feature: string,
  model: string,
  keySource: string,
  nextCost: number,
  settings: ReturnType<typeof normalizeAiPolicy>,
) {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('openai_usage_budget'))`;
      const start = new Date(
          Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
        ),
        [aggregate, requests, featureUnits] = await Promise.all([
          tx.integrationAiUsage.aggregate({
            where: { createdAt: { gte: start } },
            _sum: { cost: true },
          }),
          tx.integrationAiUsage.count({ where: { createdAt: { gte: start } } }),
          tx.integrationAiUsage.aggregate({
            where: { createdAt: { gte: start }, feature },
            _sum: { units: true },
          }),
        ]),
        budget = settings.monthly_budget,
        requestLimit = settings.monthly_request_limit,
        featureLimit = settings.per_feature_limits[feature] || 0;
      if (budget > 0 && Number(aggregate._sum.cost || 0) + nextCost > budget)
        throw new IntegrationError("Orçamento mensal de IA atingido.", 402);
      if (requestLimit > 0 && requests >= requestLimit)
        throw new IntegrationError("Limite mensal de requisições de IA atingido.", 402);
      if (featureLimit > 0 && Number(featureUnits._sum.units || 0) >= featureLimit)
        throw new IntegrationError(
          "Limite mensal desta funcionalidade de IA atingido.",
          402,
        );
      return tx.integrationAiUsage.create({
        data: {
          feature,
          model,
          units: 1,
          keySource,
          status: "in_progress",
          cost: nextCost,
        },
      });
    },
    { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
  );
}

function safetyId(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 64);
}

function redactInput(value: Input): Input {
  if (typeof value === "string") return redactText(value);
  return value.map((item) => redactObject(item));
}

function redactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      typeof item === "string"
        ? redactText(item)
        : Array.isArray(item)
          ? item.map((nested) =>
              typeof nested === "string"
                ? redactText(nested)
                : nested && typeof nested === "object"
                  ? redactObject(nested as Record<string, unknown>)
                  : nested,
            )
          : item && typeof item === "object"
            ? redactObject(item as Record<string, unknown>)
            : item,
    ]),
  );
}

function redactText(value: string) {
  return value
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[EMAIL]")
    .replace(
      /(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-\s]?\d{4}\b/g,
      "[TELEFONE]",
    )
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[CPF]");
}
