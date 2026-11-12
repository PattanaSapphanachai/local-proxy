import type { CommonModelSettings, GatewayRoute, RoutingMode } from "../types.ts";
import { GatewayError } from "../errors.ts";
import { ModelRegistry } from "../models/registry.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface RoutingUpdate {
  model?: string;
  mode?: RoutingMode;
  reasoningEffort?: CommonModelSettings["reasoning"] | null;
}

const efforts = new Set(["none", "low", "medium", "high", "xhigh"]);

export async function loadRoutingState(path: string): Promise<RoutingUpdate | undefined> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return { model: typeof state.model === "string" ? state.model : undefined, mode: state.mode as RoutingMode | undefined,
      reasoningEffort: state.reasoningEffort as CommonModelSettings["reasoning"] | null | undefined };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveRoutingState(path: string, route: GatewayRoute): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ model: route.modelId, mode: route.mode, reasoningEffort: route.reasoningEffort ?? null }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export class RoutingService {
  #route: GatewayRoute;
  constructor(private models: ModelRegistry, defaultModelId: string) {
    models.get(defaultModelId);
    this.#route = { modelId: defaultModelId, mode: "force-model", updatedAt: new Date() };
  }
  get(): GatewayRoute { return structuredClone(this.#route); }
  update(update: RoutingUpdate): GatewayRoute {
    if (update.model === undefined && update.mode === undefined && update.reasoningEffort === undefined) throw new GatewayError("INVALID_REQUEST", "Routing update requires model, mode, or reasoningEffort", 400);
    const modelId = update.model ?? this.#route.modelId;
    this.models.get(modelId);
    if (update.mode !== undefined && update.mode !== "force-model" && update.mode !== "force-provider") {
      throw new GatewayError("INVALID_REQUEST", "mode must be force-model or force-provider", 400);
    }
    if (update.reasoningEffort !== undefined && update.reasoningEffort !== null && !efforts.has(update.reasoningEffort)) {
      throw new GatewayError("INVALID_REQUEST", "reasoningEffort must be one of: none, low, medium, high, xhigh, or null", 400);
    }
    this.#route = {
      modelId,
      mode: update.mode ?? this.#route.mode,
      reasoningEffort: update.reasoningEffort === null ? undefined : update.reasoningEffort ?? this.#route.reasoningEffort,
      updatedAt: new Date()
    };
    return this.get();
  }
}
