/**
 * Upstream model ids carry a `-free` suffix; the gateway exposes them without
 * it so client-facing model lists read cleanly. The suffix is re-added when the
 * request is built, which keeps the upstream traffic identical to what the
 * suffixed names produced.
 *
 * `UPSTREAM_MODEL_EXCEPTIONS` carries the ids the convention cannot derive —
 * currently just the stealth model whose upstream id has no suffix at all.
 */
export const UPSTREAM_MODEL_SUFFIX = "-free";

export const UPSTREAM_MODEL_EXCEPTIONS: Readonly<Record<string, string>> = {
  "big-pickle": "big-pickle",
};

/** Client-facing name for an upstream model id. */
export const publicModelId = (upstreamId: string): string =>
  upstreamId.endsWith(UPSTREAM_MODEL_SUFFIX) ? upstreamId.slice(0, -UPSTREAM_MODEL_SUFFIX.length) : upstreamId;

/**
 * Upstream model id for a client-facing name. Names that already carry the
 * suffix are left alone, so a deployment that still lists the old suffixed ids
 * keeps working unchanged.
 */
export const resolveUpstreamModel = (publicId: string): string => {
  const exception = UPSTREAM_MODEL_EXCEPTIONS[publicId];
  if (exception !== undefined) return exception;
  if (publicId.endsWith(UPSTREAM_MODEL_SUFFIX)) return publicId;
  return `${publicId}${UPSTREAM_MODEL_SUFFIX}`;
};
