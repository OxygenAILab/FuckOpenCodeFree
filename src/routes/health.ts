import type { FastifyInstance } from "fastify";
import type { ModelConfigStore } from "../models/catalog.js";
import type { AppConfig } from "../config/env.js";
import { freeTierGateState } from "../providers/upstreamGate.js";

export const registerHealthRoutes = async (app: FastifyInstance, config: AppConfig, models: ModelConfigStore): Promise<void> => {
  // Report only the routes this instance actually mounted, so a caller can trust
  // the list instead of probing for the ones `API_SURFACE` removed.
  const endpoints = ["/v1/chat/completions", "/v1/responses", "/v1/models"];
  if (config.apiSurface === "all") endpoints.push("/v1/messages", "/v1/systemone");
  app.get("/health", async () => ({
    status: "ok",
    version: "0.2.0",
    surface: config.apiSurface,
    models: models.listEnabled().length,
    endpoints,
    // When the upstream free-tier gate trips, the gateway stops calling
    // upstream and answers 503 itself; this reports that window so callers can
    // fail over deliberately instead of discovering it per request.
    upstreamFreeTier: freeTierGateState(),
  }));
};
