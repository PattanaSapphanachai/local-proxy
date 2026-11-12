import type { ModelProfile } from "../types.ts";
import { GatewayError } from "../errors.ts";

export class ModelRegistry {
  #models = new Map<string, ModelProfile>();
  constructor(models: ModelProfile[] = []) { for (const model of models) this.register(model); }
  register(model: ModelProfile): void {
    if (this.#models.has(model.id)) throw new Error(`Duplicate model id: ${model.id}`);
    this.#models.set(model.id, structuredClone(model));
  }
  get(id: string): ModelProfile {
    const model = this.#models.get(id);
    if (!model) throw new GatewayError("MODEL_NOT_FOUND", `Unknown gateway model: ${id}`, 404);
    return structuredClone(model);
  }
  has(id: string): boolean { return this.#models.has(id); }
  list(): ModelProfile[] { return [...this.#models.values()].map((model) => structuredClone(model)); }
  replace(models: ModelProfile[]): void {
    const next = new Map<string, ModelProfile>();
    for (const model of models) {
      if (next.has(model.id)) throw new Error(`Duplicate model id: ${model.id}`);
      next.set(model.id, structuredClone(model));
    }
    this.#models = next;
  }
}
