import "dotenv/config";

const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const boolFromEnv = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
};

const proxyModeFromEnv = (): "direct" | "optional" | "required" => {
  const raw = process.env.PROXY_MODE?.toLowerCase();
  if (raw === "direct" || raw === "optional" || raw === "required") return raw;
  return boolFromEnv("REQUIRE_PROXY", false) ? "required" : "optional";
};

export interface AppConfig {
  host: string;
  port: number;
  keysFile: string;
  modelsFile: string;
  settingsFile: string;
  proxiesFile: string;
  logsDir: string;
  adminPassword: string;
  zenHost: string;
  zenPath: string;
  /**
   * Credential sent upstream. Defaults to the literal `public`, which is the
   * anonymous free-tier credential. Set `ZEN_API_KEY` to use a real Zen/Go
   * credential against the subscription route (`/zen/go/v1/...`).
   */
  zenApiKey: string;
  /**
   * The free tier's ids carry a `-free` suffix while the client-facing names do
   * not; the subscription route uses the bare ids. Derive it from the path so a
   * single `ZEN_PATH` switch is enough.
   */
  zenFreeNaming: boolean;
  /**
   * Only the anonymous lane (`/inference/v1`) is behind the environment
   * fingerprint, so only that lane needs the request shaped to satisfy it
   * (`stream: true`, injected `bash`/`read` tools). The credential lanes
   * (`/zen/v1`, `/zen/go/v1`) authenticate by key and take the caller's shape.
   */
  zenRequiresFingerprint: boolean;
  /**
   * User-Agent presented to upstream. Defaults to the exact string the shipped
   * v1.19.3 CLI sends: `opencode/<ver> ai-sdk/provider-utils/<ver> runtime/bun/<ver>`
   * (extracted statically in OpenCode-REA-2026-10-17/06-free-tier-fingerprint.zh.md).
   */
  zenOpencodeUa: string;
  /**
   * Also send `x-session-affinity` / `x-session-id` on the fingerprint lane.
   * The real CLI sends those two only for non-OpenCode providers; the gateway
   * carried them from the 2026-10-16 shape, so the toggle keeps that behaviour
   * available without a code change.
   */
  zenLegacySessionHeaders: boolean;
  /** TypeSafe System One (`jev-*`) path; those models are not chat models. */
  zenSystemOnePath: string;
  /**
   * Which protocol surfaces to serve. `all` exposes OpenAI, Anthropic and
   * System One; `openai` exposes only the OpenAI-compatible routes.
   */
  apiSurface: "all" | "openai";
  upstreamTimeoutMs: number;
  globalRequestsPerMinute: number;
  apiKeyRequestsPerMinute: number;
  apiKeyMaxConcurrentRequests: number;
  apiKeyMaxConcurrentStreams: number;
  redisUrl: string;
  redisKeyPrefix: string;
  shutdownDrainTimeoutMs: number;
  storePlaintextApiKeys: boolean;
  proxyMode: "direct" | "optional" | "required";
  outboundPreProxyEnabled: boolean;
  outboundPreProxyUrl: string;
  /**
   * Attempts per request on the anonymous fingerprint lane. A 403 FreeTierError
   * rotates to the next egress and mints a fresh session before retrying; the
   * shared breaker only trips when every attempt is exhausted.
   */
  freeTierRetryAttempts: number;
  /** Cooldown for a proxy node that answered 403 FreeTierError. */
  freeTierBanCooldownMs: number;
  /** Cooldown for a proxy node that failed at the transport layer (reset/TLS). */
  freeTierTransportCooldownMs: number;
  /** Cooldown for an egress the upstream marked as abusive VPN/proxy traffic. */
  freeTierAbuseCooldownMs: number;
  /** Shared breaker window when every egress is abuse-blocked. */
  freeTierAbuseGateCooldownMs: number;
}

export const loadConfig = (): AppConfig => ({
  host: process.env.PROXY_HOST || "0.0.0.0",
  port: intFromEnv("PROXY_PORT", 6446),
  keysFile: process.env.KEYS_FILE || "./api-keys.json",
  modelsFile: process.env.MODELS_FILE || "./models.json",
  settingsFile: process.env.SETTINGS_FILE || "./settings.json",
  proxiesFile: process.env.PROXIES_FILE || "./proxies.json",
  logsDir: process.env.LOGS_DIR || "./logs",
  adminPassword: process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN || "admin",
  zenHost: process.env.ZEN_HOST || "opencode.ai",
  // The free tier moved off `/zen/v1` on 2026-10-11: the Zen routes became a
  // thin proxy and the gate went down into a private inference service, so
  // `/zen/v1` now answers every anonymous request with 403 FreeTierError while
  // `/inference/v1` serves the same catalogue and accepts the same fingerprint.
  zenPath: process.env.ZEN_PATH || "/inference/v1/chat/completions",
  // `public` is the anonymous free-tier credential. A real key is required by
  // the subscription route (`ZEN_PATH=/zen/go/v1/chat/completions`).
  zenApiKey: process.env.ZEN_API_KEY || "public",
  // `/zen/v1` and `/inference/v1` publish the identical catalogue, `-free`
  // ids included; only the Go catalogue uses bare ids.
  zenFreeNaming: !(process.env.ZEN_PATH || "/inference/v1/chat/completions").includes("/zen/go/"),
  zenRequiresFingerprint: (process.env.ZEN_PATH || "/inference/v1/chat/completions").includes("/inference/"),
  zenOpencodeUa:
    process.env.ZEN_OPENCODE_UA || "opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
  zenLegacySessionHeaders: boolFromEnv("ZEN_LEGACY_SESSION_HEADERS", false),
  // TypeSafe's System One decision models (`jev-*`) answer on a sibling path
  // with their own request shape; they are not chat models.
  zenSystemOnePath: process.env.ZEN_SYSTEMONE_PATH || "/inference/v1/systemone",
  apiSurface: process.env.API_SURFACE?.toLowerCase() === "openai" ? "openai" : "all",
  upstreamTimeoutMs: intFromEnv("UPSTREAM_TIMEOUT_MS", 120000),
  globalRequestsPerMinute: intFromEnv("GLOBAL_REQUESTS_PER_MINUTE", 120),
  apiKeyRequestsPerMinute: intFromEnv("API_KEY_REQUESTS_PER_MINUTE", 60),
  apiKeyMaxConcurrentRequests: intFromEnv("API_KEY_MAX_CONCURRENT_REQUESTS", 10),
  apiKeyMaxConcurrentStreams: intFromEnv("API_KEY_MAX_CONCURRENT_STREAMS", 5),
  redisUrl: process.env.REDIS_URL || "",
  redisKeyPrefix: process.env.REDIS_KEY_PREFIX || "opencode-proxy-hub:limit",
  shutdownDrainTimeoutMs: intFromEnv("SHUTDOWN_DRAIN_TIMEOUT_MS", 30000),
  storePlaintextApiKeys: boolFromEnv("STORE_PLAINTEXT_API_KEYS", false),
  proxyMode: proxyModeFromEnv(),
  outboundPreProxyEnabled: boolFromEnv("OUTBOUND_PRE_PROXY_ENABLED", false),
  outboundPreProxyUrl: process.env.OUTBOUND_PRE_PROXY_URL || "",
  freeTierRetryAttempts: Math.min(10, Math.max(1, intFromEnv("FREE_TIER_RETRY_ATTEMPTS", 3))),
  freeTierBanCooldownMs: Math.max(60_000, intFromEnv("FREE_TIER_BAN_COOLDOWN_MS", 15 * 60 * 1000)),
  freeTierTransportCooldownMs: Math.max(5_000, intFromEnv("FREE_TIER_TRANSPORT_COOLDOWN_MS", 60_000)),
  freeTierAbuseCooldownMs: Math.max(60_000, intFromEnv("FREE_TIER_ABUSE_COOLDOWN_MS", 60 * 60 * 1000)),
  freeTierAbuseGateCooldownMs: Math.max(60_000, intFromEnv("FREE_TIER_ABUSE_GATE_COOLDOWN_MS", 60 * 60 * 1000)),
});
