import { randomUUID } from "node:crypto";
import type { CanonicalMessage, GatewaySession } from "../types.ts";
import type { SessionStore } from "./store.ts";

const comparable = (message: CanonicalMessage): string => JSON.stringify({ role: message.role, content: message.content });

export class SessionService {
  constructor(private store: SessionStore) {}
  async resolve(id?: string): Promise<GatewaySession> {
    const sessionId = id || randomUUID();
    const existing = await this.store.get(sessionId);
    if (existing) return existing;
    const now = new Date();
    const created: GatewaySession = { id: sessionId, createdAt: now, updatedAt: now, messages: [] };
    await this.store.create(created); return created;
  }
  async mergeIncoming(session: GatewaySession, incoming: CanonicalMessage[]): Promise<GatewaySession> {
    if (!incoming.length) return session;
    const existing = session.messages;
    let append: CanonicalMessage[] = incoming;
    if (existing.length) {
      let prefix = 0;
      while (prefix < incoming.length && prefix < existing.length && comparable(incoming[prefix]) === comparable(existing[prefix])) prefix++;
      if (prefix > 0) append = incoming.slice(prefix);
      else {
        const last = comparable(existing.at(-1)!);
        append = incoming.filter((message, index) => !(index === 0 && comparable(message) === last));
      }
    }
    if (append.length) await this.store.appendMessages(session.id, append);
    return (await this.store.get(session.id))!;
  }
  async appendAssistant(id: string, message: CanonicalMessage): Promise<void> { await this.store.appendMessages(id, [message]); }
  async get(id: string): Promise<GatewaySession | null> { return this.store.get(id); }
}
