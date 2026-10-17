/**
 * Upstream's free tier sits behind a client-fingerprint gate that changes
 * without notice. When it trips, every call comes back as
 * `403 FreeTierError: OpenCode's free tier can only be used from within
 * OpenCode`, and each retry is another round trip that a downstream fallback
 * may pay for. Keep a shared cooldown instead: the gateway answers instantly
 * and says exactly what happened, and the operator decides what to do next.
 */
export const FREE_TIER_GATED = "free_tier_gated";

const cooldownMs = (): number => {
  const raw = Number.parseInt(process.env.FREE_TIER_GATE_COOLDOWN_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5 * 60 * 1000;
};

const disabled = (): boolean => ["1", "true", "yes", "on"].includes((process.env.FREE_TIER_GATE_DISABLED ?? "").toLowerCase());

let gateUntil = 0;
let lastReason = "";
let lastTrippedAt: number | null = null;

export interface FreeTierGateState {
  tripped: boolean;
  until: number;
  lastTrippedAt: number | null;
  reason: string;
  cooldownMs: number;
}

export const freeTierGateState = (): FreeTierGateState => ({
  tripped: Date.now() < gateUntil,
  until: gateUntil,
  lastTrippedAt,
  reason: lastReason,
  cooldownMs: cooldownMs(),
});

export const tripFreeTierGate = (reason: string): void => {
  if (disabled()) return;
  gateUntil = Date.now() + cooldownMs();
  lastReason = reason;
  lastTrippedAt = Date.now();
};

export const clearFreeTierGate = (): void => {
  gateUntil = 0;
  lastReason = "";
};

/**
 * Recognise the gate from either the parsed error object or the raw body. The
 * upstream marks it with a `FreeTierError` type and a fixed sentence; matching
 * both keeps this working if only one of them changes.
 */
export const isFreeTierBody = (status: number, body: unknown): boolean => {
  if (status !== 403) return false;
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return text.includes("FreeTierError") || text.includes("can only be used from within OpenCode");
};

export const freeTierGateResponse = () => {
  const state = freeTierGateState();
  return {
    retryAfterSeconds: Math.max(1, Math.ceil((state.until - Date.now()) / 1000)),
    body: {
      error: {
        message:
          "Upstream closed its free tier to non-OpenCode clients (403 FreeTierError). " +
          "The gateway is not retrying while the gate is up; see /health for the window.",
        type: "permission_error",
        code: FREE_TIER_GATED,
        gate: state,
      },
    },
  };
};
