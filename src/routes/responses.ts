import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import type { FastifyInstance } from "fastify";
import type { ApiKeyStore } from "../auth/apiKeys.js";
import type { AppConfig } from "../config/env.js";
import type { ModelConfigStore } from "../models/catalog.js";
import type { SettingsStore } from "../settings/settingsStore.js";
import { prepareZenRequest, requestZenFull, type ZenPreparedRequest } from "../providers/zenClient.js";
import { SessionStore, sessionScopeFromHeaders } from "../sessions/sessionStore.js";
import type { ProxyPoolStore } from "../proxy/proxyPool.js";
import type { AsyncLimiter } from "../rateLimit/limiter.js";
import type { RequestTracker } from "../runtime/requestTracker.js";
import type { MetricsStore } from "../observability/metrics.js";

export interface ResponsesRequest {
  model?: string;
  input?: unknown;
  instructions?: string;
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  [key: string]: unknown;
}

const newId = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;

const textFromContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const entry = part as Record<string, unknown> | null;
      return typeof entry?.text === "string" ? entry.text : "";
    })
    .join("");
};

/** Responses-API tools are flat; chat completions nests them under `function`. */
const toChatTools = (tools: unknown[] | undefined): unknown[] | undefined => {
  if (!Array.isArray(tools)) return undefined;
  const mapped = tools
    .filter((tool): tool is Record<string, unknown> => Boolean(tool) && typeof tool === "object")
    .filter((tool) => tool.type === "function" && typeof tool.name === "string")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: tool.parameters ?? { type: "object", properties: {} },
      },
    }));
  return mapped.length > 0 ? mapped : undefined;
};

const toChatMessages = (input: unknown, instructions: unknown): Array<Record<string, unknown>> => {
  const messages: Array<Record<string, unknown>> = [];
  if (typeof instructions === "string" && instructions.trim()) messages.push({ role: "system", content: instructions });
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;
  for (const raw of input) {
    if (typeof raw === "string") {
      messages.push({ role: "user", content: raw });
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: typeof item.call_id === "string" ? item.call_id : newId("call"),
            type: "function",
            function: {
              name: item.name,
              arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
            },
          },
        ],
      });
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: typeof item.call_id === "string" ? item.call_id : "",
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
      continue;
    }
    if (item.type === "reasoning") continue;
    const role = typeof item.role === "string" ? item.role : "user";
    messages.push({ role: role === "developer" ? "system" : role, content: textFromContent(item.content) });
  }
  return messages;
};

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
  outputIndex: number;
  itemId: string;
  opened: boolean;
}

interface ChatFold {
  content: string;
  reasoning: string;
  toolCalls: ToolCallAccumulator[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

const responseUsage = (usage: ChatFold["usage"]) =>
  usage
    ? { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? 0 }
    : undefined;

const buildResponseObject = (model: string, fold: ChatFold, status: string) => {
  const output: Array<Record<string, unknown>> = [];
  if (fold.reasoning) output.push({ type: "reasoning", id: newId("rs"), summary: [{ type: "summary_text", text: fold.reasoning }] });
  if (fold.content) {
    output.push({
      type: "message",
      id: newId("msg"),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: fold.content, annotations: [] }],
    });
  }
  for (const call of fold.toolCalls) {
    output.push({ type: "function_call", id: call.itemId, call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" });
  }
  return {
    id: newId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    output_text: fold.content,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    ...(responseUsage(fold.usage) ? { usage: responseUsage(fold.usage) } : {}),
  };
};

const foldChatCompletion = (data: any): ChatFold => {
  const message = data?.choices?.[0]?.message ?? {};
  const toolCalls: ToolCallAccumulator[] = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call: any, index: number) => ({
        id: typeof call?.id === "string" ? call.id : newId("call"),
        name: String(call?.function?.name ?? ""),
        arguments: String(call?.function?.arguments ?? ""),
        outputIndex: index,
        itemId: newId("fc"),
        opened: true,
      }))
    : [];
  return {
    content: typeof message.content === "string" ? message.content : "",
    reasoning: typeof message.reasoning_content === "string" ? message.reasoning_content : "",
    toolCalls,
    usage: data?.usage,
  };
};

/**
 * OpenAI's Responses API on top of a chat-completions upstream.
 *
 * OpenCode Zen's free tier answers `/inference/v1/responses` with
 * `ModelProtocolUnsupported`, so the conversion has to happen here: request
 * items become chat messages, and the streamed chat deltas are re-emitted as
 * Responses events. Agents such as Codex speak this protocol and nothing else.
 */
export const registerResponsesRoutes = async (
  app: FastifyInstance,
  config: AppConfig,
  keyStore: ApiKeyStore,
  modelStore: ModelConfigStore,
  settingsStore: SettingsStore,
  sessions: SessionStore,
  proxyPool: ProxyPoolStore,
  limiter: AsyncLimiter,
  requestTracker: RequestTracker,
  metrics: MetricsStore,
): Promise<void> => {
  app.post<{ Body: ResponsesRequest }>("/v1/responses", async (request, reply) => {
    const releaseRequest = requestTracker.acquire();
    if (!releaseRequest) {
      return reply.code(503).header("Retry-After", "5").send({ error: { message: "Server is draining", type: "service_unavailable" } });
    }
    const auth = keyStore.authenticateKey(request.headers);
    if (!auth) {
      releaseRequest();
      return reply.code(401).send({ error: { message: "Invalid API key", type: "authentication_error" } });
    }
    keyStore.recordClientUsage(auth.id, request.headers);

    const body = request.body || ({} as ResponsesRequest);
    const model = typeof body.model === "string" ? body.model : "";
    const isStream = body.stream !== false;
    const limit = await limiter.acquire(auth.id, isStream, {
      requestsPerMinute: auth.policy.requestsPerMinute,
      maxConcurrentRequests: auth.policy.maxConcurrentRequests,
      maxConcurrentStreams: auth.policy.maxConcurrentStreams,
    });
    if (!limit.allowed) {
      releaseRequest();
      return reply.code(429).send({ error: { message: limit.reason || "Rate limit exceeded", type: "rate_limit_error" } });
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseRequest();
      limiter.release(auth.id, isStream).catch((error) => app.log.warn({ error }, "limiter_release_failed"));
    };
    reply.raw.once("close", release);
    reply.raw.once("finish", release);

    if (!model || !modelStore.isEnabled(model)) {
      release();
      return reply.code(400).send({ error: { message: `Unknown or disabled model: ${model}`, type: "invalid_request_error" } });
    }
    if (!keyStore.isModelAllowed(auth.id, model)) {
      release();
      return reply.code(403).send({ error: { message: `Model is not allowed for this API key: ${model}`, type: "permission_error" } });
    }

    const messages = toChatMessages(body.input, body.instructions);
    if (messages.length === 0) {
      release();
      return reply.code(400).send({ error: { message: "input is required", type: "invalid_request_error" } });
    }

    const settings = settingsStore.get();
    const useProxy = settings.proxyMode !== "direct" && auth.policy.allowProxy !== false;
    const effectivePool = useProxy ? proxyPool : undefined;
    const prepared = prepareZenRequest(
      config,
      {
        model,
        messages,
        stream: isStream,
        tools: toChatTools(body.tools),
        toolChoice: body.tool_choice,
        parameters: { temperature: body.temperature, top_p: body.top_p, max_tokens: body.max_output_tokens },
        sessionId: sessions.getSession(sessionScopeFromHeaders(auth.id, "openai", model, request.headers)),
      },
      effectivePool,
    );

    if (!isStream) {
      const zenResp = await requestZenFull(prepared, effectivePool, metrics);
      if (zenResp.status !== 200 || !zenResp.data?.choices) {
        release();
        return reply.code(zenResp.status === 200 ? 502 : zenResp.status).send(
          zenResp.data?.error ? { error: zenResp.data.error } : { error: { message: "Upstream request failed", type: "upstream_error" } },
        );
      }
      release();
      return reply.code(200).send(buildResponseObject(model, foldChatCompletion(zenResp.data), "completed"));
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Transfer-Encoding": "chunked",
    });
    pipeResponses(prepared, model, res, metrics, effectivePool);
  });
};

/**
 * Translate the upstream chat-completions SSE into Responses events as it
 * arrives, so output stays incremental for the caller.
 */
const pipeResponses = (
  prepared: ZenPreparedRequest,
  model: string,
  res: import("node:http").ServerResponse,
  metrics?: MetricsStore,
  proxyPool?: ProxyPoolStore,
): void => {
  const started = process.hrtime.bigint();
  const durationMs = () => Number(process.hrtime.bigint() - started) / 1_000_000;
  let upstreamStatus = 0;
  const fold: ChatFold = { content: "", reasoning: "", toolCalls: [] };
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let sequence = 0;
  let headersSent = false;
  let messageItemId = "";
  let messageOpen = false;
  let reasoningItemId = "";
  let reasoningOpen = false;
  let outputIndex = 0;
  let finished = false;

  const emit = (type: string, payload: Record<string, unknown>) => {
    sequence += 1;
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...payload })}\n\n`);
  };
  const base = () => ({
    id: newId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "in_progress",
    output: [],
    parallel_tool_calls: true,
  });
  const responseId = newId("resp");
  emit("response.created", { response: { ...base(), id: responseId } });
  emit("response.in_progress", { response: { ...base(), id: responseId } });

  const openMessage = () => {
    if (messageOpen) return;
    messageOpen = true;
    messageItemId = newId("msg");
    emit("response.output_item.added", {
      output_index: outputIndex,
      item: { id: messageItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    emit("response.content_part.added", {
      item_id: messageItemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  };

  const handleChunk = (chunk: any) => {
    if (chunk?.usage) fold.usage = chunk.usage;
    const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
    const delta = choice?.delta;
    if (!delta) return;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      if (!reasoningOpen) {
        reasoningOpen = true;
        reasoningItemId = newId("rs");
        emit("response.output_item.added", { output_index: outputIndex, item: { id: reasoningItemId, type: "reasoning", summary: [] } });
      }
      fold.reasoning += delta.reasoning_content;
      emit("response.reasoning_summary_text.delta", {
        item_id: reasoningItemId,
        output_index: outputIndex,
        summary_index: 0,
        delta: delta.reasoning_content,
      });
    }
    if (typeof delta.content === "string" && delta.content) {
      if (reasoningOpen) {
        emit("response.reasoning_summary_text.done", { item_id: reasoningItemId, output_index: outputIndex, summary_index: 0, text: fold.reasoning });
        emit("response.output_item.done", {
          output_index: outputIndex,
          item: { id: reasoningItemId, type: "reasoning", summary: [{ type: "summary_text", text: fold.reasoning }] },
        });
        reasoningOpen = false;
        outputIndex += 1;
      }
      openMessage();
      fold.content += delta.content;
      emit("response.output_text.delta", { item_id: messageItemId, output_index: outputIndex, content_index: 0, delta: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = typeof call?.index === "number" ? call.index : fold.toolCalls.length;
        let entry = fold.toolCalls[index];
        if (!entry) {
          entry = { id: "", name: "", arguments: "", outputIndex: 0, itemId: newId("fc"), opened: false };
          fold.toolCalls[index] = entry;
        }
        if (typeof call?.id === "string") entry.id = call.id;
        if (typeof call?.function?.name === "string") entry.name += call.function.name;
        if (typeof call?.function?.arguments === "string") entry.arguments += call.function.arguments;
        if (!entry.opened) {
          entry.opened = true;
          if (messageOpen) {
            emit("response.output_text.done", { item_id: messageItemId, output_index: outputIndex, content_index: 0, text: fold.content });
            emit("response.content_part.done", {
              item_id: messageItemId,
              output_index: outputIndex,
              content_index: 0,
              part: { type: "output_text", text: fold.content, annotations: [] },
            });
            emit("response.output_item.done", {
              output_index: outputIndex,
              item: {
                id: messageItemId,
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: fold.content, annotations: [] }],
              },
            });
            messageOpen = false;
            outputIndex += 1;
          }
          entry.outputIndex = outputIndex;
          outputIndex += 1;
          emit("response.output_item.added", {
            output_index: entry.outputIndex,
            item: { id: entry.itemId, type: "function_call", call_id: entry.id, name: entry.name, arguments: "", status: "in_progress" },
          });
        }
        if (typeof call?.function?.arguments === "string" && call.function.arguments) {
          emit("response.function_call_arguments.delta", { item_id: entry.itemId, output_index: entry.outputIndex, delta: call.function.arguments });
        }
      }
    }
  };

  const finish = (failed?: string) => {
    if (finished) return;
    finished = true;
    if (prepared.lease?.node && proxyPool) {
      if (failed) proxyPool.markFailure(prepared.lease.node.id, failed, { statusCode: upstreamStatus || 502 });
      else proxyPool.markSuccess(prepared.lease.node.id);
    }
    metrics?.recordUpstream({
      statusCode: failed ? upstreamStatus || 502 : 200,
      durationMs: durationMs(),
      proxyId: prepared.lease?.node?.id,
      ...(failed ? { error: failed } : {}),
    });
    if (failed) {
      emit("response.failed", { response: { ...base(), id: responseId, status: "failed", error: { code: "upstream_error", message: failed } } });
      res.end();
      return;
    }
    if (reasoningOpen) {
      emit("response.reasoning_summary_text.done", { item_id: reasoningItemId, output_index: outputIndex, summary_index: 0, text: fold.reasoning });
      emit("response.output_item.done", {
        output_index: outputIndex,
        item: { id: reasoningItemId, type: "reasoning", summary: [{ type: "summary_text", text: fold.reasoning }] },
      });
      reasoningOpen = false;
    }
    if (messageOpen) {
      emit("response.output_text.done", { item_id: messageItemId, output_index: outputIndex, content_index: 0, text: fold.content });
      emit("response.content_part.done", {
        item_id: messageItemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: fold.content, annotations: [] },
      });
      emit("response.output_item.done", {
        output_index: outputIndex,
        item: {
          id: messageItemId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: fold.content, annotations: [] }],
        },
      });
      messageOpen = false;
    }
    for (const entry of fold.toolCalls) {
      if (!entry.opened) continue;
      emit("response.function_call_arguments.done", { item_id: entry.itemId, output_index: entry.outputIndex, arguments: entry.arguments });
      emit("response.output_item.done", {
        output_index: entry.outputIndex,
        item: { id: entry.itemId, type: "function_call", call_id: entry.id, name: entry.name, arguments: entry.arguments, status: "completed" },
      });
    }
    emit("response.completed", { response: { ...buildResponseObject(model, fold, "completed"), id: responseId } });
    res.write("data: [DONE]\n\n");
    res.end();
  };

  const request = https.request(prepared.options, (zenRes) => {
    const status = zenRes.statusCode || 502;
    upstreamStatus = status;
    if (status !== 200) {
      const chunks: Buffer[] = [];
      zenRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      zenRes.on("end", () => {
        let message = `Upstream returned ${status}`;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          message = parsed?.error?.message || parsed?.message || message;
        } catch {
          // Keep the status-based message.
        }
        finish(message);
      });
      return;
    }
    zenRes.on("data", (chunk: Buffer) => {
      headersSent = true;
      buffer += decoder.write(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          handleChunk(JSON.parse(payload));
        } catch {
          // Ignore malformed keep-alive noise.
        }
      }
    });
    zenRes.on("end", () => {
      buffer += decoder.end();
      if (!headersSent && buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer);
          finish(parsed?.error?.message || "Upstream returned an empty stream");
          return;
        } catch {
          // Fall through to a normal finish.
        }
      }
      finish();
    });
    zenRes.on("error", (error) => finish(error.message));
  });
  request.on("error", (error) => finish(error.message));
  request.on("timeout", () => {
    request.destroy();
    finish("Upstream timeout");
  });
  res.on("close", () => {
    if (!request.destroyed) request.destroy();
  });
  request.write(prepared.body);
  request.end();
};
