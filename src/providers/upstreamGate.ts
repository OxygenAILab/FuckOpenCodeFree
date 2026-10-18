/**
 * Upstream's free tier sits behind a client-fingerprint gate that changes
 * without notice. When it trips, every call comes back as
 * `403 FreeTierError: OpenCode's free tier can only be used from within
 * OpenCode`, and each retry is another round trip that a downstream fallback
 * may pay for. Keep a shared cooldown instead: the gateway answers instantly
 * and says exactly what happened, and the operator decides what to do next.
 */
export const FREE_TIER_GATED = "free_tier_gated";
export const FREE_TIER_IP_ABUSE = "free_tier_ip_abuse";

export type FreeTierErrorKind = "client_identity" | "ip_abuse" | "unknown";

const ABUSE_MARKERS = [
  "abusive traffic",
  "detected abusive",
  "isn't related to your account",
  "vpn or proxy",
  "blocked this egress",
];

const CLIENT_MARKERS = [
  "can only be used from within opencode",
  "non-opencode clients",
  "download it at https://opencode.ai",
];

const cooldownMs = (): number => {
  const raw = Number.parseInt(process.env.FREE_TIER_GATE_COOLDOWN_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5 * 60 * 1000;
};

const disabled = (): boolean => ["1", "true", "yes", "on"].includes((process.env.FREE_TIER_GATE_DISABLED ?? "").toLowerCase());

let gateUntil = 0;
let lastReason = "";
let lastTrippedAt: number | null = null;
let lastKind: FreeTierErrorKind | null = null;
let lastCooldownMs = cooldownMs();

export interface FreeTierGateState {
  tripped: boolean;
  until: number;
  lastTrippedAt: number | null;
  reason: string;
  cooldownMs: number;
  kind: FreeTierErrorKind | null;
}

export const freeTierGateState = (): FreeTierGateState => ({
  tripped: Date.now() < gateUntil,
  until: gateUntil,
  lastTrippedAt,
  reason: lastReason,
  cooldownMs: lastCooldownMs,
  kind: lastKind,
});

export const tripFreeTierGate = (
  reason: string,
  kind: FreeTierErrorKind = "client_identity",
  cooldownOverrideMs?: number,
): void => {
  if (disabled()) return;
  lastCooldownMs = cooldownOverrideMs ?? cooldownMs();
  gateUntil = Date.now() + lastCooldownMs;
  lastReason = reason;
  lastKind = kind;
  lastTrippedAt = Date.now();
};

export const clearFreeTierGate = (): void => {
  gateUntil = 0;
  lastReason = "";
  lastKind = null;
  lastCooldownMs = cooldownMs();
};

/**
 * Recognise the gate from either the parsed error object or the raw body. The
 * upstream marks it with a `FreeTierError` type and a fixed sentence; matching
 * both keeps this working if only one of them changes.
 */
export const isFreeTierBody = (status: number, body: unknown): boolean => {
  if (status !== 403) return false;
  const text = (typeof body === "string" ? body : JSON.stringify(body ?? "")).toLowerCase();
  return text.includes("freetiererror") || [...CLIENT_MARKERS, ...ABUSE_MARKERS].some((marker) => text.includes(marker));
};

export const classifyFreeTierError = (body: unknown): FreeTierErrorKind => {
  const text = (typeof body === "string" ? body : JSON.stringify(body ?? "")).toLowerCase();
  if (ABUSE_MARKERS.some((marker) => text.includes(marker))) return "ip_abuse";
  if (CLIENT_MARKERS.some((marker) => text.includes(marker))) return "client_identity";
  return "unknown";
};

export const freeTierGateResponse = () => {
  const state = freeTierGateState();
  const ipAbuse = state.kind === "ip_abuse";
  return {
    retryAfterSeconds: Math.max(1, Math.ceil((state.until - Date.now()) / 1000)),
    body: {
      error: {
        message: ipAbuse
          ? "Upstream blocked this egress IP as abusive traffic (403 FreeTierError). " +
            "This is an IP/network-reputation block, not a client-shape problem; use a clean " +
            "residential/direct egress or wait for the block to expire. The gateway is not " +
            "retrying while the gate is up; see /health for the window."
          : "Upstream closed its free tier to non-OpenCode clients (403 FreeTierError). " +
            "The gateway is not retrying while the gate is up; see /health for the window.",
        type: "permission_error",
        code: ipAbuse ? FREE_TIER_IP_ABUSE : FREE_TIER_GATED,
        gate: state,
      },
    },
  };
};
