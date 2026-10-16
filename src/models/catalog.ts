import { JsonFileStore } from "../storage/jsonFile.js";

export const DEFAULT_MODELS = [
  "big-pickle",
  "space-bunny",
  "ll-alpha",
  "nemotron-3.5-lightning",
  "nemotron-3.5-super-vl",
  "mimo-v2.6-flash",
  "deepseek-v4.1-flash",
  "glm-5.3-flash",
  "longcat-2.5-preview",
  "muse-spark-1.3-contributor",
  // Decision model, not a chat model: served over /v1/systemone.
  "jev-1.13",
] as const;

/**
 * Models that have been retired by upstream and should be auto-disabled on
 * startup so existing deployments don't encounter 401 errors after upgrade.
 */
export const RETIRED_MODELS: ReadonlyArray<{ id: string; reason: string }> = [
  // Renamed: the client-facing ids dropped the upstream `-free` suffix, and the
  // gateway re-adds it when building the upstream request.
  { id: "space-bunny-free", reason: "Renamed to space-bunny" },
  { id: "ll-alpha-free", reason: "Renamed to ll-alpha" },
  { id: "nemotron-3.5-lightning-free", reason: "Renamed to nemotron-3.5-lightning" },
  { id: "nemotron-3.5-super-vl-free", reason: "Renamed to nemotron-3.5-super-vl" },
  { id: "mimo-v2.6-flash-free", reason: "Renamed to mimo-v2.6-flash" },
  { id: "deepseek-v4.1-flash-free", reason: "Renamed to deepseek-v4.1-flash" },
  { id: "glm-5.3-flash-free", reason: "Renamed to glm-5.3-flash" },
  { id: "longcat-2.5-preview-free", reason: "Renamed to longcat-2.5-preview" },
  { id: "muse-spark-1.3-contributor-free", reason: "Renamed to muse-spark-1.3-contributor" },
  // This one is accepted upstream but never answers: the request is held open
  // with `: keep-alive` comments for ~300s and then closes without any data.
  { id: "nemotron-3-ultra", reason: "Upstream holds the stream open ~300s and never sends a completion" },
  { id: "nemotron-3-ultra-free", reason: "Upstream holds the stream open ~300s and never sends a completion" },
  { id: "mimo-v2.5-free", reason: "Deprecated by upstream, superseded by mimo-v2.6-flash-free" },
  { id: "ling-3.0-flash-fin-free", reason: "Upstream answers 'Model is unavailable'" },
  { id: "nemotron-3-super-free", reason: "Model no longer supported by upstream" },
  { id: "minimax-m3-free", reason: "Free promotion ended, now requires OpenCode Go subscription" },
  { id: "north-mini-code-free", reason: "Model no longer offered as a free model by upstream" },
  { id: "ling-3.0-flash-free", reason: "Model no longer offered as a free model by upstream" },
  { id: "longcat-2.0-free", reason: "Model no longer offered as a free model by upstream" },
  { id: "deepseek-v4-flash-free", reason: "Free promotion ended, no longer offered as a free model by upstream" },
  { id: "hy3-free", reason: "Model no longer offered as a free model by upstream" },
  { id: "x-preview-f-free", reason: "Model no longer offered as a free model by upstream" },
  { id: "laguna-s-2.1-free", reason: "Model no longer offered as a free model by upstream" },
  { id: "muse-spark-1.2-contributor-free", reason: "Superseded by muse-spark-1.3-contributor-free, no longer offered by upstream" },
];

/**
 * Models previously auto-disabled by the retirement mechanism that are
 * available again as upstream free models. On startup, entries carrying the
 * "(retired:" annotation are re-enabled and the annotation is stripped, so
 * only auto-disabled entries are touched — manual user choices are kept.
 * Currently empty (no model is known to have returned as of v0.1.9).
 */
export const REACTIVATED_MODELS: ReadonlySet<string> = new Set([]);

export interface ModelConfig {
  id: string;
  enabled: boolean;
  ownedBy: string;
  created: number;
  displayName?: string;
}

interface ModelConfigFile {
  version: 1;
  models: ModelConfig[];
}

export interface ModelUpdateInput {
  enabled?: boolean;
  ownedBy?: string;
  created?: number;
  displayName?: string;
}

export class ModelConfigStore {
  private readonly store: JsonFileStore<ModelConfigFile>;
  private models: ModelConfig[] = [];

  constructor(modelsFile: string) {
    this.store = new JsonFileStore<ModelConfigFile>(modelsFile);
  }

  load(): void {
    const data = this.store.read({ version: 1, models: [] });
    this.models = this.mergeDefaultModels(data.models);
    this.persist();
  }

  list(): ModelConfig[] {
    return this.models.map((model) => ({ ...model }));
  }

  listEnabled(): ModelConfig[] {
    return this.list().filter((model) => model.enabled);
  }

  isEnabled(modelId: string): boolean {
    return this.models.some((model) => model.id === modelId && model.enabled);
  }

  enabledIds(): string[] {
    return this.listEnabled().map((model) => model.id);
  }

  upsert(id: string, input: ModelUpdateInput): ModelConfig {
    const cleanId = id.trim();
    if (!cleanId) throw new Error("Model id is required");

    let model = this.models.find((item) => item.id === cleanId);
    if (!model) {
      model = { id: cleanId, enabled: true, ownedBy: "opencode-free", created: 1779000000 };
      this.models.push(model);
    }

    if (input.enabled !== undefined) model.enabled = input.enabled;
    if (input.ownedBy !== undefined) model.ownedBy = input.ownedBy.trim() || "opencode-free";
    if (input.created !== undefined) model.created = input.created;
    if (input.displayName !== undefined) model.displayName = input.displayName.trim() || undefined;

    this.persist();
    return { ...model };
  }

  delete(id: string): boolean {
    const before = this.models.length;
    this.models = this.models.filter((model) => model.id !== id);
    if (this.models.length === before) return false;
    this.persist();
    return true;
  }

  private defaultModels(): ModelConfig[] {
    return DEFAULT_MODELS.map((id) => ({ id, enabled: true, ownedBy: "opencode-free", created: 1779000000 }));
  }

  private mergeDefaultModels(models: ModelConfig[]): ModelConfig[] {
    const merged = [...models];
    const existingIds = new Set(merged.map((model) => model.id));
    for (const model of this.defaultModels()) {
      if (!existingIds.has(model.id)) merged.push(model);
    }
    // Auto-disable retired models on startup
    for (const retired of RETIRED_MODELS) {
      const model = merged.find((m) => m.id === retired.id);
      if (model && model.enabled) {
        model.enabled = false;
        model.displayName = `${model.displayName || model.id} (retired: ${retired.reason})`;
      }
    }
    // Re-enable models that returned to the upstream free list and were
    // previously auto-disabled via the retirement mechanism
    for (const model of merged) {
      if (!REACTIVATED_MODELS.has(model.id)) continue;
      if (model.enabled || !model.displayName?.includes("(retired:")) continue;
      model.enabled = true;
      const cleaned = model.displayName.replace(/\s*\(retired:[^)]*\)/g, "").trim();
      model.displayName = cleaned === model.id ? undefined : cleaned;
    }
    return merged;
  }

  private persist(): void {
    this.store.write({ version: 1, models: this.models });
  }
}
