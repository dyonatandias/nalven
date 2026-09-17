import { createHash, createHmac, randomUUID } from "node:crypto";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { performance } from "node:perf_hooks";
import type { ResolvedProvider, HealthResult } from "./core";
import { IntegrationError, isConfigured, objectValue } from "./core";
import { resolvePublicHost, safeRequest } from "./security";

export type SendResult =
  | { success: true; message_id?: string; details?: Record<string, unknown> }
  | { success: false; message: string; failureType: "transport" | "business" };

export async function testProvider(
  providerId: string,
  configValue: unknown,
  secrets: Record<string, string>,
): Promise<HealthResult> {
  const config = objectValue(configValue),
    start = performance.now();
  if (!isConfigured(providerId, config, secrets))
    return result(
      false,
      "Integração não configurada: preencha os campos obrigatórios.",
      start,
    );
  try {
    if (providerId === "smtp") return await smtpHealth(config, secrets, start);
    if (providerId === "storage_s3")
      return await storageHealth(config, secrets, start);
    const target = healthUrl(providerId, config);
    if (!target)
      return result(true, "Configuração válida e pronta para uso.", start, {
        provider: providerId,
      });
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "NALVEN-Integration-Health/1.0",
    };
    const token = secrets.access_token || secrets.api_key || secrets.token;
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await safeRequest(target, {
      method: "GET",
      headers,
      timeoutMs: timeout(config),
    });
    if (response.status >= 200 && response.status < 300) {
      const details = responseJson(response.body);
      return result(
        true,
        identityMessage(providerId, details, config),
        start,
        safeDetails(details),
      );
    }
    return result(false, httpMessage(response.status), start, {
      status: response.status,
    });
  } catch (error) {
    return result(
      false,
      `Falha HTTP: ${error instanceof Error && error.message === "timeout" ? "tempo limite excedido" : error instanceof Error ? error.message : "destino indisponível"}.`,
      start,
    );
  }
}

export async function sendWithProvider(
  provider: ResolvedProvider,
  recipient: string,
  message: string,
  extras: Record<string, unknown> = {},
): Promise<SendResult> {
  try {
    if (provider.providerId === "smtp")
      return smtpSend(provider, recipient, message, extras);
    return {
      success: false,
      message: "E-mails transacionais aceitam somente SMTP.",
      failureType: "business",
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Falha de transporte.",
      failureType: "transport",
    };
  }
}

function healthUrl(providerId: string, config: Record<string, unknown>) {
  const base = String(
    config.base_url || config.endpoint || config.url || "",
  ).replace(/\/$/, "");
  if (providerId === "openai")
    return `${base || "https://api.openai.com/v1"}/models`;
  if (!base) return "";
  return base;
}

async function smtpHealth(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  start: number,
): Promise<HealthResult> {
  const host = String(config.host),
    pinned = await resolvePublicHost(host),
    port = Number(config.port || 587),
    secure = config.encryption === "ssl";
  let socket: Socket | TLSSocket = secure
    ? connectTls({
        host: pinned.address,
        port,
        servername: host,
        rejectUnauthorized: true,
      })
    : connectTcp({ host: pinned.address, port });
  try {
    await connected(socket, secure);
    await expect(socket, [220]);
    await command(socket, "EHLO nalven.local", [250]);
    if (config.encryption === "tls") {
      await command(socket, "STARTTLS", [220]);
      socket = connectTls({
        socket,
        servername: host,
        rejectUnauthorized: true,
      });
      await connected(socket, true);
      await command(socket, "EHLO nalven.local", [250]);
    }
    if (config.username) {
      await command(socket, "AUTH LOGIN", [334]);
      await command(
        socket,
        Buffer.from(String(config.username)).toString("base64"),
        [334],
      );
      await command(
        socket,
        Buffer.from(secrets.password || "").toString("base64"),
        [235],
      );
    }
    socket.write("QUIT\r\n");
    socket.end();
    return result(
      true,
      `Conexão${config.username ? " e autenticação" : ""} confirmada com ${host}:${port}.`,
      start,
      {
        host,
        port,
        encryption: config.encryption || "tls",
        authenticated: Boolean(config.username),
      },
    );
  } catch (error) {
    socket.destroy();
    return result(
      false,
      `Não foi possível validar ${host}:${port}: ${error instanceof Error ? error.message : "falha SMTP"}.`,
      start,
    );
  }
}

async function smtpSend(
  provider: ResolvedProvider,
  recipient: string,
  message: string,
  extras: Record<string, unknown>,
): Promise<SendResult> {
  const host = String(provider.config.host),
    pinned = await resolvePublicHost(host),
    port = Number(provider.config.port || 587),
    mode = String(provider.config.encryption || "tls"),
    from = String(provider.config.from_email || ""),
    subject = String(extras.subject || "Mensagem NALVEN");
  if (!from)
    return {
      success: false,
      message: "E-mail remetente não configurado.",
      failureType: "business",
    };
  let socket: Socket | TLSSocket =
    mode === "ssl"
      ? connectTls({
          host: pinned.address,
          port,
          servername: host,
          rejectUnauthorized: true,
        })
      : connectTcp({ host: pinned.address, port });
  await connected(socket, mode === "ssl");
  await expect(socket, [220]);
  await command(socket, `EHLO nalven.local`, [250]);
  if (mode === "tls") {
    await command(socket, "STARTTLS", [220]);
    socket = connectTls({ socket, servername: host, rejectUnauthorized: true });
    await connected(socket, true);
    await command(socket, "EHLO nalven.local", [250]);
  }
  if (provider.config.auth !== false && provider.config.username) {
    await command(socket, "AUTH LOGIN", [334]);
    await command(
      socket,
      Buffer.from(String(provider.config.username)).toString("base64"),
      [334],
    );
    await command(
      socket,
      Buffer.from(provider.secrets.password || "").toString("base64"),
      [235],
    );
  }
  await command(socket, `MAIL FROM:<${from}>`, [250]);
  await command(socket, `RCPT TO:<${recipient}>`, [250, 251]);
  await command(socket, "DATA", [354]);
  const html = typeof extras.html === "string" ? extras.html : "";
  const boundary = `nalven-${randomUUID()}`;
  const body = html
    ? [
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        message,
        `--${boundary}`,
        "Content-Type: text/html; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        html,
        `--${boundary}--`,
      ].join("\r\n")
    : [
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        message,
      ].join("\r\n");
  const payload =
    `From: ${safeHeader(String(provider.config.from_name || "NALVEN"))} <${from}>\r\nTo: <${recipient}>\r\nSubject: ${safeHeader(subject)}\r\nMIME-Version: 1.0\r\n${body}`
      .replace(/\r?\n/g, "\r\n")
      .replace(/\r\n\./g, "\r\n..");
  socket.write(`${payload}\r\n.\r\n`);
  const response = await smtpResponse(socket);
  if (response.code !== 250)
    throw new IntegrationError(
      `Servidor SMTP recusou a mensagem (${response.code}).`,
    );
  socket.write("QUIT\r\n");
  socket.end();
  return {
    success: true,
    message_id: response.text.match(/(?:queued as|id=?)\s*([\w.-]+)/i)?.[1],
  };
}

async function storageHealth(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  start: number,
): Promise<HealthResult> {
  const endpoint = String(config.endpoint || "").replace(/\/$/, ""),
    bucket = encodeURIComponent(String(config.bucket || "")),
    key = `.nalven-health/${randomUUID()}.txt`,
    url = `${endpoint}/${bucket}/${key}`,
    body = `NALVEN storage health ${new Date().toISOString()}`;
  try {
    const put = await s3ObjectRequest("PUT", url, body, config, secrets);
    if (put.status < 200 || put.status >= 300)
      return result(
        false,
        `Não foi possível gravar o objeto de teste (HTTP ${put.status}).`,
        start,
        { operation: "write", status: put.status },
      );
    const read = await s3ObjectRequest("GET", url, "", config, secrets);
    if (read.status !== 200 || read.body !== body)
      return result(
        false,
        "O objeto de teste foi gravado, mas não pôde ser lido corretamente.",
        start,
        { operation: "read", status: read.status },
      );
    const removed = await s3ObjectRequest("DELETE", url, "", config, secrets);
    if (removed.status < 200 || removed.status >= 300)
      return result(
        false,
        "O objeto de teste foi lido, mas não pôde ser removido.",
        start,
        { operation: "delete", status: removed.status },
      );
    return result(
      true,
      `Leitura e escrita confirmadas no bucket ${config.bucket}.`,
      start,
      { bucket: config.bucket, region: config.region },
    );
  } catch (error) {
    return result(
      false,
      `Falha no armazenamento: ${error instanceof Error ? error.message : "destino indisponível"}.`,
      start,
    );
  }
}

export async function s3ObjectRequest(
  method: string,
  value: string,
  body: string | Buffer,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
) {
  const url = new URL(value),
    now = new Date(),
    amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""),
    date = amzDate.slice(0, 8),
    region = String(config.region || "us-east-1"),
    service = "s3",
    payloadHash = createHash("sha256").update(body).digest("hex"),
    canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    signedHeaders = "host;x-amz-content-sha256;x-amz-date",
    canonical = [
      method,
      url.pathname,
      url.searchParams.toString(),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n"),
    scope = `${date}/${region}/${service}/aws4_request`,
    toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`;
  const sign = (key: Buffer | string, valueToSign: string) =>
      createHmac("sha256", key).update(valueToSign).digest(),
    dateKey = sign(`AWS4${secrets.secret_key}`, date),
    regionKey = sign(dateKey, region),
    serviceKey = sign(regionKey, service),
    signingKey = sign(serviceKey, "aws4_request"),
    signature = createHmac("sha256", signingKey).update(toSign).digest("hex"),
    authorization = `AWS4-HMAC-SHA256 Credential=${secrets.access_key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return safeRequest(value, {
    method,
    body: body || undefined,
    timeoutMs: 10000,
    headers: {
      host: url.host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      authorization,
      ...(body ? { "content-type": "text/plain" } : {}),
    },
  });
}

function connected(socket: Socket | TLSSocket, tls: boolean) {
  return new Promise<void>((resolve, reject) => {
    const event = tls ? "secureConnect" : "connect";
    socket.once(event, () => resolve());
    socket.once("error", reject);
    socket.setTimeout(10000, () => socket.destroy(new Error("timeout")));
  });
}
async function command(
  socket: Socket | TLSSocket,
  value: string,
  allowed: number[],
) {
  socket.write(`${value}\r\n`);
  const response = await smtpResponse(socket);
  if (!allowed.includes(response.code))
    throw new IntegrationError(
      `Servidor SMTP recusou o comando (${response.code} ${response.text.slice(0, 160)}).`,
    );
  return response;
}
function expect(socket: Socket | TLSSocket, allowed: number[]) {
  return smtpResponse(socket).then((response) => {
    if (!allowed.includes(response.code))
      throw new IntegrationError(
        `Resposta SMTP inesperada (${response.code}).`,
      );
    return response;
  });
}
function smtpResponse(socket: Socket | TLSSocket) {
  return new Promise<{ code: number; text: string }>((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean),
        last = lines.at(-1);
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), text: lines.join(" ") });
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function result(
  success: boolean,
  message: string,
  start: number,
  details: Record<string, unknown> = {},
): HealthResult {
  return {
    success,
    message,
    latency_ms: Math.max(0, Math.round(performance.now() - start)),
    details,
  };
}
function timeout(config: Record<string, unknown>) {
  return Math.min(
    10000,
    Math.max(1000, Number(config.timeout_sec || 10) * 1000),
  );
}
function responseJson(body: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(body));
  } catch {
    return {};
  }
}
function safeDetails(body: Record<string, unknown>) {
  return Object.fromEntries(
    [
      "id",
      "name",
      "nickname",
      "verified_name",
      "display_phone_number",
      "quality_rating",
      "status",
      "sandbox",
    ]
      .filter((key) => body[key] !== undefined)
      .map((key) => [key, body[key]]),
  );
}
function identityMessage(
  provider: string,
  details: Record<string, unknown>,
  config: Record<string, unknown>,
) {
  const name =
    details.verified_name ||
    details.nickname ||
    details.name ||
    details.display_phone_number ||
    details.id;
  return name
    ? `Conectado como ${String(name)}${config.sandbox ? " (sandbox)" : ""}.`
    : `Conexão com ${provider} validada${config.sandbox ? " (sandbox)" : ""}.`;
}
function httpMessage(status: number) {
  if (status === 401 || status === 403)
    return "Credenciais inválidas ou expiradas.";
  if (status === 429) return "Limite de requisições atingido — aguarde.";
  if (status >= 500) return "O provedor está temporariamente indisponível.";
  return `O provedor recusou a solicitação (HTTP ${status}).`;
}
function safeHeader(value: string) {
  return value.replace(/[\r\n]/g, " ").slice(0, 240);
}
