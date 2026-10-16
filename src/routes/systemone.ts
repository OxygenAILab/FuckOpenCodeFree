import https from "node:https";
import type { FastifyInstance } from "fastify";
import type { ApiKeyStore } from "../auth/apiKeys.js";
import type { AppConfig } from "../config/env.js";
import type { ModelConfigStore } from "../models/catalog.js";
import { resolveUpstreamModel } from "../models/naming.js";
import { mintZenId } from "../utils/ids.js";
import { SessionStore, sessionScopeFromHeaders } from "../sessions/sessionStore.js";
import type { ProxyLease, ProxyPoolStore } from "../proxy/proxyPool.js";
import type { RequestTracker } from "../runtime/requestTracker.js";
import type { MetricsStore } from "../observability/metrics.js";

/** OpenCode Zen's CLI identity; the inference gate rejects anything else. */
const OC_VERSION = "1.18.31";

export interface SystemOneRequest {
  model?: string;
  state?: unknown;
  questions?: unknown;
  [key: string]: unknown;
}

/**
 * TypeSafe System One (`jev-*`) is a decision model, not a chat model: it takes
 * `state` plus typed `questions` and returns calibrated probabilities instead of
 * text. Zen exposes it on its own upstream path, so it gets its own route rather
 * than being squeezed through `/v1/chat/completions`.
 *
 * The body and the response both pass through unchanged; only the model name is
 * rewritten to its upstream id.
 */
export const registerSystemOneRoutes = async (
  app: FastifyInstance,
  config: AppConfig,
  keyStore: ApiKeyStore,
  modelStore: ModelConfigStore,
  sessions: SessionStore,
  proxyPool: ProxyPoolStore,
  requestTracker: RequestTracker,
  metrics: MetricsStore,
): Promise<void> => {
  app.post<{ Body: SystemOneRequest }>("/v1/systemone", async (request, reply) => {
    const started = process.hrtime.bigint();
    const releaseRequest = requestTracker.acquire();
    if (!releaseRequest) {
      return reply.code(503).header("Retry-After", "5").send({ error: { message: "Server is draining", type: "service_unavailable" } });
    }

    const auth = keyStore.authenticateKey(request.headers);
    if (!auth) {
      releaseRequest();
      return reply.code(401).send({ error: { message: "Invalid API key" } });
    }
    keyStore.recordClientUsage(auth.id, request.headers);

    const body = request.body || ({} as SystemOneRequest);
    const model = typeof body.model === "string" ? body.model : "";
    if (!model || !modelStore.isEnabled(model)) {
      releaseRequest();
      return reply.code(400).send({
        error: { message: `Unknown or disabled model: ${model}. Available: ${modelStore.enabledIds().join(", ")}` },
      });
    }
    if (!keyStore.isModelAllowed(auth.id, model)) {
      releaseRequest();
      return reply.code(403).send({ error: { message: `Model is not allowed for this API key: ${model}`, type: "permission_error" } });
    }
    if (body.state === undefined || body.questions === undefined) {
      releaseRequest();
      return reply.code(400).send({ error: { message: "state and questions are required", type: "invalid_request_error" } });
    }

    const session = sessions.getSession(sessionScopeFromHeaders(auth.id, "systemone", model, request.headers));
    const payload = JSON.stringify({ ...body, model: resolveUpstreamModel(model) });
    const lease: ProxyLease | undefined = proxyPool.acquire();
    if (lease?.requiredUnavailable) {
      releaseRequest();
      return reply.code(503).send({ error: { message: "Proxy is required but no proxy node is available", type: "proxy_unavailable" } });
    }

    const options: https.RequestOptions = {
      hostname: config.zenHost,
      port: 443,
      path: config.zenSystemOnePath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Authorization: "Bearer public",
        "User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-session": session,
        "x-opencode-session-id": session,
        "x-session-affinity": session,
        "x-session-id": session,
      },
      ...(lease?.agent ? { agent: lease.agent } : {}),
      timeout: config.upstreamTimeoutMs,
    };

    const upstream = await new Promise<{ status: number; raw: string }>((resolve, reject) => {
      const req = https.request(options, (zenRes) => {
        const chunks: Buffer[] = [];
        zenRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        zenRes.on("end", () => resolve({ status: zenRes.statusCode || 502, raw: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Upstream timeout"));
      });
      req.write(payload);
      req.end();
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown upstream error";
      return { status: 502, raw: JSON.stringify({ error: { message, type: "upstream_error" } }) };
    });

    if (lease?.node) {
      if (upstream.status >= 500 || upstream.status === 429) proxyPool.markFailure(lease.node.id, "systemone upstream error", { statusCode: upstream.status });
      else proxyPool.markSuccess(lease.node.id);
    }
    metrics?.recordUpstream({
      statusCode: upstream.status,
      durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      proxyId: lease?.node?.id,
    });
    releaseRequest();
    app.log.info({ user: auth.name, model, status: upstream.status }, "systemone_request");

    reply.header("Content-Type", "application/json");
    // Report the client-facing name, not the upstream `-free` id.
    if (upstream.status === 200) {
      try {
        const parsed = JSON.parse(upstream.raw) as Record<string, unknown>;
        parsed.model = model;
        return reply.code(200).send(parsed);
      } catch {
        // Not JSON; fall through and pass the body through untouched.
      }
    }
    return reply.code(upstream.status).send(upstream.raw);
  });
};
