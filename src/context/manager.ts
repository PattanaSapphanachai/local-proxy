import type { GatewaySession, ModelProfile } from "../types.ts";
import { GatewayError } from "../errors.ts";

export class ContextManager {
  estimateTokens(session: GatewaySession): number {
    const characters = JSON.stringify(session.messages.map(({ role, content }) => ({ role, content }))).length;
    return Math.ceil(characters / 4);
  }
  assertFits(session: GatewaySession, model: ModelProfile, requestedOutput = 0): void {
    if (!model.contextLimit) return;
    const estimated = this.estimateTokens(session) + requestedOutput;
    if (estimated > model.contextLimit) throw new GatewayError("CONTEXT_LIMIT", `Estimated context ${estimated} tokens exceeds ${model.id} limit ${model.contextLimit}; automatic compaction is not enabled`, 400);
  }
}
