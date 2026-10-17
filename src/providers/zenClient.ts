import https from "node:https";
import type { ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { mintZenId } from "../utils/ids.js";
import { resolveUpstreamModel } from "../models/naming.js";
import { freeTierGateResponse, freeTierGateState, isFreeTierBody, tripFreeTierGate } from "./upstreamGate.js";
import type { AppConfig } from "../config/env.js";
import type { ZenFullResponse } from "../types/api.js";
import type { ProxyLease, ProxyPoolStore } from "../proxy/proxyPool.js";
import type { MetricsStore } from "../observability/metrics.js";

const OC_VERSION = "1.18.31";
const noProxyAvailableError = "Proxy is required but no proxy node is available";

/**
 * Translate an upstream error body into an OpenAI-shaped error without losing
 * the real status or reason. The free tier answers 403 with a `FreeTierError`
 * and 429 with `FreeUsageLimitError`; reporting either as a generic rate limit
 * hides the actual cause from the caller.
 */
export const errorPayload = (status: number, parsed: any, fallback: string) => {
  const upstreamType =
    typeof parsed?.error?.type === "string" ? parsed.error.type : typeof parsed?.type === "string" ? parsed.type : undefined;
  const message = parsed?.error?.message || parsed?.message || fallback;
  const type = status === 429 ? "rate_limit_error" : status === 401 || status === 403 ? "permission_error" : "upstream_error";
  const code = upstreamType && upstreamType !== "error" ? upstreamType : status === 429 ? "rate_limit_exceeded" : "upstream_error";
  return { error: { message: String(message), type, code } };
};

/**
 * The inference gate inspects the request's tool list: `bash` and `read` must
 * both be present, by exact lowercase name, each carrying a real parameter
 * schema. Requests without them — compaction, session titles, summaries, or any
 * turn whose permissions trimmed the list — are refused with FreeTierError and
 * the misleading "free tier can only be used from within OpenCode".
 */
const ZEN_REQUIRED_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ["bash", "command"],
  ["read", "file_path"],
];

const zenTool = (name: string, property: string) => ({
  type: "function",
  function: {
    name,
    description: "Requirement placeholder from OpenCode Zen: this gateway cannot execute it.",
    parameters: {
      type: "object",
      properties: { [property]: { type: "string", description: "Placeholder parameter." } },
      required: [property],
    },
  },
});

/**
 * Pad the declared tools so the gate's shape requirement holds. Declared tools
 * keep their positions and only missing placeholders are appended, so a request
 * that already qualifies is passed through untouched and the upstream prompt
 * cache is not invalidated.
 */
export const ensureZenTools = (tools: unknown[] | undefined): unknown[] => {
  const filled = Array.isArray(tools) ? [...tools] : [];
  const present = new Set(
    filled.map((tool) => {
      const entry = tool as { name?: unknown; function?: { name?: unknown } };
      return typeof entry?.function?.name === "string" ? entry.function.name : entry?.name;
    }),
  );
  for (const [name, property] of ZEN_REQUIRED_TOOLS) {
    if (!present.has(name)) filled.push(zenTool(name, property));
  }
  return filled;
};

/**
 * Session ids already minted for a conversation scope. The gateway meters free
 * usage per session and routes its prompt cache by the id, so every turn of one
 * conversation has to reuse the id minted for its first turn.
 */
const ZEN_SESSION_KEEP = 128;
const zenSessions = new Map<string, string>();

export const zenSessionId = (seed: string): string => {
  const hit = zenSessions.get(seed);
  if (hit !== undefined) return hit;
  const minted = mintZenId("ses", true);
  if (zenSessions.size >= ZEN_SESSION_KEEP) {
    const oldest = zenSessions.keys().next();
    if (!oldest.done) zenSessions.delete(oldest.value);
  }
  zenSessions.set(seed, minted);
  return minted;
};

export interface ZenRequestInput {
  model: string;
  messages: unknown[];
  stream?: boolean;
  tools?: unknown[];
  toolChoice?: unknown;
  parameters?: Record<string, unknown>;
  sessionId: string;
}

export interface ZenPreparedRequest {
  body: string;
  options: https.RequestOptions;
  lease?: ProxyLease;
  /** The client-facing model name, echoed back on assembled responses. */
  publicModel: string;
  /** The upstream model name actually sent in the body. */
  upstreamModel: string;
  /** True only for the anonymous `/inference` lane, which has the fingerprint. */
  fingerprintLane: boolean;
}

/**
 * Rewrite the upstream model id back to the client-facing name as the stream
 * passes through. Complete lines are processed and a partial line is held until
 * the next chunk finishes it; decoding goes through a StringDecoder so a
 * multi-byte UTF-8 character split across TCP chunks survives intact.
 */
const createModelRewriter = (upstreamModel: string, publicModel: string) => {
  const from = `"model":"${upstreamModel}"`;
  const to = `"model":"${publicModel}"`;
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return {
    push(chunk: Buffer): string {
      buffer += decoder.write(chunk);
      const lastBreak = buffer.lastIndexOf("\n");
      if (lastBreak === -1) return "";
      const ready = buffer.slice(0, lastBreak + 1);
      buffer = buffer.slice(lastBreak + 1);
      return ready.split(from).join(to);
    },
    flush(): string {
      const tail = buffer + decoder.end();
      buffer = "";
      return tail.split(from).join(to);
    },
  };
};

export const prepareZenRequest = (config: AppConfig, input: ZenRequestInput, proxyPool?: ProxyPoolStore): ZenPreparedRequest => {
  // Client-facing names drop the upstream `-free` suffix; the upstream id is
  // restored here so the traffic is byte-identical to the suffixed names.
  // Free-tier ids carry `-free` upstream; the subscription route uses the bare
  // ids. `config.zenFreeNaming` follows `ZEN_PATH` so one switch flips both.
  const upstreamModel = config.zenFreeNaming ? resolveUpstreamModel(input.model) : input.model;
  // The anonymous lane's fingerprint requires `stream: true`: an otherwise
  // byte-identical body flips 200 -> 403 the moment it asks for a non-streamed
  // completion. The credential lanes authenticate by key, so the caller's own
  // shape is passed through untouched.
  const requestBody: Record<string, unknown> = {
    model: upstreamModel,
    messages: input.messages,
    stream: config.zenRequiresFingerprint ? true : Boolean(input.stream),
  };
  if (config.zenRequiresFingerprint) {
    requestBody.tools = ensureZenTools(input.tools);
  } else if (Array.isArray(input.tools) && input.tools.length > 0) {
    requestBody.tools = input.tools;
  }
  if (input.toolChoice) requestBody.tool_choice = input.toolChoice;
  for (const [key, value] of Object.entries(input.parameters || {})) {
    if (value !== undefined) requestBody[key] = value;
  }

  const body = JSON.stringify(requestBody);
  const session = zenSessionId(input.sessionId);

  const lease = proxyPool?.acquire();
  return {
    body,
    publicModel: input.model,
    upstreamModel,
    fingerprintLane: config.zenRequiresFingerprint,
    options: {
      hostname: config.zenHost,
      port: 443,
      path: config.zenPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Bearer ${config.zenApiKey}`,
        "User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        // The gate wants all four session headers carrying the same value;
        // sending only the legacy `x-opencode-session` is refused.
        "x-opencode-session": session,
        "x-opencode-session-id": session,
        "x-session-affinity": session,
        "x-session-id": session,
        // Deliberately absent: `x-opencode-request` and `HTTP-Referer`. Their
        // presence alone trips the gate on the inference path.
      },
      ...(lease?.agent ? { agent: lease.agent } : {}),
      timeout: config.upstreamTimeoutMs,
    },
    lease,
  };
};

interface AssembledDelta {
  content: string;
  reasoning: string;
  reasoningKey: string;
  toolCalls: Array<Record<string, unknown>>;
}

/**
 * Fold an OpenAI-style SSE stream back into a single `chat.completion` object.
 *
 * The gate only serves streamed completions, so a client that asked for a
 * non-streamed response gets one assembled here instead of a second upstream
 * round trip.
 */
export const assembleZenSse = (sse: string, responseModel?: string): Record<string, unknown> | null => {
  let id = "";
  let created = 0;
  let model = "";
  let finishReason: string | null = null;
  let usage: unknown;
  const delta: AssembledDelta = { content: "", reasoning: "", reasoningKey: "", toolCalls: [] };

  for (const line of sse.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!chunk || typeof chunk !== "object") continue;
    if (typeof chunk.id === "string") id = chunk.id;
    if (typeof chunk.created === "number") created = chunk.created;
    if (typeof chunk.model === "string") model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) continue;
    if (choice.finish_reason) finishReason = String(choice.finish_reason);
    const piece = choice.delta;
    if (!piece || typeof piece !== "object") continue;
    if (typeof piece.content === "string") delta.content += piece.content;
    if (typeof piece.reasoning_content === "string") {
      delta.reasoningKey = "reasoning_content";
      delta.reasoning += piece.reasoning_content;
    } else if (typeof piece.reasoning === "string") {
      if (!delta.reasoningKey) delta.reasoningKey = "reasoning";
      delta.reasoning += piece.reasoning;
    }
    if (Array.isArray(piece.tool_calls)) {
      for (const call of piece.tool_calls) {
        const index = typeof call?.index === "number" ? call.index : delta.toolCalls.length;
        const current = (delta.toolCalls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (typeof call?.id === "string") current.id = call.id;
        if (typeof call?.type === "string") current.type = call.type;
        if (typeof call?.function?.name === "string") {
          (current.function as Record<string, unknown>).name =
            String((current.function as Record<string, unknown>).name ?? "") + call.function.name;
        }
        if (typeof call?.function?.arguments === "string") {
          (current.function as Record<string, unknown>).arguments =
            String((current.function as Record<string, unknown>).arguments ?? "") + call.function.arguments;
        }
      }
    }
  }

  if (!id && !model && !delta.content && !delta.reasoning && delta.toolCalls.length === 0) return null;

  const message: Record<string, unknown> = { role: "assistant", content: delta.content };
  if (delta.reasoning) message[delta.reasoningKey || "reasoning_content"] = delta.reasoning;
  if (delta.toolCalls.length > 0) message.tool_calls = delta.toolCalls;
  return {
    id: id || `chatcmpl_${Date.now().toString(16)}`,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: responseModel || model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    ...(usage ? { usage } : {}),
  };
};

export const requestZenFull = (prepared: ZenPreparedRequest, proxyPool?: ProxyPoolStore, metrics?: MetricsStore): Promise<ZenFullResponse> => {
  return new Promise((resolve, reject) => {
    if (prepared.lease?.requiredUnavailable) {
      reject(new Error(noProxyAvailableError));
      return;
    }
    // While the upstream gate is up, answer locally instead of spending another
    // round trip that a downstream fallback may bill against.
    if (prepared.fingerprintLane && freeTierGateState().tripped) {
      resolve({ status: 503, data: freeTierGateResponse().body, raw: "" });
      return;
    }
    const started = process.hrtime.bigint();
    const durationMs = () => Number(process.hrtime.bigint() - started) / 1_000_000;
    const req = https.request(prepared.options, (zenRes) => {
      const chunks: Buffer[] = [];
      zenRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      zenRes.on("end", () => {
        if (prepared.lease?.node && proxyPool) {
          if ((zenRes.statusCode || 502) === 429) proxyPool.markFailure(prepared.lease.node.id, "Upstream returned 429", { statusCode: 429 });
          else proxyPool.markSuccess(prepared.lease.node.id);
        }
        metrics?.recordUpstream({ statusCode: zenRes.statusCode || 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
        const raw = Buffer.concat(chunks).toString();
        const status = zenRes.statusCode || 502;
        if (status !== 200) {
          try {
            const parsed = JSON.parse(raw);
            if (prepared.fingerprintLane && isFreeTierBody(status, parsed)) tripFreeTierGate(parsed?.error?.message ?? "FreeTierError");
            resolve({ status, data: parsed, raw });
          } catch {
            if (prepared.fingerprintLane && isFreeTierBody(status, raw)) tripFreeTierGate("FreeTierError");
            resolve({ status, data: null, raw });
          }
          return;
        }
        // Report the client-facing name back, so a non-streamed response does
        // not echo the upstream `-free` id the caller never asked for.
        const assembled = assembleZenSse(raw, prepared.publicModel);
        if (assembled) resolve({ status, data: assembled, raw });
        else {
          try {
            resolve({ status, data: JSON.parse(raw), raw });
          } catch {
            // A 200 whose body carries no SSE payload at all means upstream
            // accepted the request and then produced nothing (some free models
            // only emit `: keep-alive` comments). Reporting that as a success
            // would hand the caller an empty completion.
            resolve({
              status: 502,
              data: { error: { message: "Upstream returned an empty stream", type: "upstream_error" } },
              raw,
            });
          }
        }
      });
    });

    req.on("error", (error) => {
      if (prepared.lease?.node && proxyPool) proxyPool.markFailure(prepared.lease.node.id, error.message);
      metrics?.recordUpstream({ statusCode: 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: error.message });
      reject(error);
    });
    req.on("timeout", () => {
      req.destroy();
      if (prepared.lease?.node && proxyPool) proxyPool.markFailure(prepared.lease.node.id, "Upstream timeout");
      metrics?.recordUpstream({ statusCode: 504, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: "Upstream timeout" });
      reject(new Error("Upstream timeout"));
    });
    req.write(prepared.body);
    req.end();
  });
};

export const pipeZenOpenAIResponse = (prepared: ZenPreparedRequest, stream: boolean, res: ServerResponse, proxyPool?: ProxyPoolStore, metrics?: MetricsStore): void => {
  if (prepared.lease?.requiredUnavailable) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: noProxyAvailableError, type: "proxy_unavailable" } }));
    return;
  }
  if (prepared.fingerprintLane && freeTierGateState().tripped) {
    const gate = freeTierGateResponse();
    res.writeHead(503, { "Content-Type": "application/json", "Retry-After": String(gate.retryAfterSeconds) });
    res.end(JSON.stringify(gate.body));
    return;
  }
  const started = process.hrtime.bigint();
  const durationMs = () => Number(process.hrtime.bigint() - started) / 1_000_000;
  let markedFailure = false;
  // Only the streaming path needs this: a non-streamed reply is assembled in
  // `requestZenFull`, which already substitutes the client-facing name.
  const rewriter =
    prepared.publicModel === prepared.upstreamModel ? null : createModelRewriter(prepared.upstreamModel, prepared.publicModel);
  // The rewriter holds a partial line back, so a push can legitimately be empty.
  const wire = (payload: Buffer | string): void => {
    if (typeof payload === "string" && payload.length === 0) return;
    res.write(payload);
  };
  const req = https.request(prepared.options, (zenRes) => {
    let firstChunk: Buffer | null = null;
    let headersSent = false;

    zenRes.on("data", (chunk: Buffer) => {
      if (!firstChunk) {
        firstChunk = chunk;
        const str = chunk.toString().trim();
        const upstreamStatus = zenRes.statusCode || 502;
        if (str.startsWith("{") && (upstreamStatus !== 200 || str.includes("FreeUsageLimitError") || str.includes('"error"'))) {
          try {
            const parsed = JSON.parse(str);
            if (parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Upstream request failed";
              if (prepared.fingerprintLane && isFreeTierBody(upstreamStatus, parsed)) tripFreeTierGate(errMsg);
              if (prepared.lease?.node && proxyPool) {
                proxyPool.markFailure(prepared.lease.node.id, errMsg, { statusCode: upstreamStatus });
                markedFailure = true;
              }
              if (!res.headersSent) {
                res.writeHead(upstreamStatus, { "Content-Type": "application/json" });
                res.end(JSON.stringify(errorPayload(upstreamStatus, parsed, errMsg)));
              }
              zenRes.resume();
              return;
            }
          } catch {
            // Continue with normal passthrough.
          }
        }

        headersSent = true;
        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
            "Transfer-Encoding": "chunked",
          });
        } else {
          res.writeHead(zenRes.statusCode || 502, { "Content-Type": "application/json" });
        }
        wire(rewriter ? rewriter.push(firstChunk) : firstChunk);
        return;
      }

      if (headersSent) wire(rewriter ? rewriter.push(chunk) : chunk);
    });

    zenRes.on("end", () => {
      if (prepared.lease?.node && proxyPool && !markedFailure) {
        if ((zenRes.statusCode || 502) === 429) proxyPool.markFailure(prepared.lease.node.id, "Upstream returned 429", { statusCode: 429 });
        else proxyPool.markSuccess(prepared.lease.node.id);
      }
      metrics?.recordUpstream({ statusCode: zenRes.statusCode || 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
      if (!headersSent && !firstChunk) {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Empty response from upstream", type: "upstream_error" } }));
        }
        return;
      }
      if (headersSent) {
        if (rewriter) wire(rewriter.flush());
        res.end();
      }
    });
  });

  res.on("close", () => {
    if (!req.destroyed) req.destroy();
  });

  req.on("error", (error) => {
    if (prepared.lease?.node && proxyPool && !markedFailure) proxyPool.markFailure(prepared.lease.node.id, error.message);
    metrics?.recordUpstream({ statusCode: 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: error.message });
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Upstream error: ${error.message}`, type: "upstream_error" } }));
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (prepared.lease?.node && proxyPool && !markedFailure) proxyPool.markFailure(prepared.lease.node.id, "Upstream timeout");
    metrics?.recordUpstream({ statusCode: 504, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: "Upstream timeout" });
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Upstream timeout", type: "timeout_error" } }));
    }
  });

  req.write(prepared.body);
  req.end();
};
