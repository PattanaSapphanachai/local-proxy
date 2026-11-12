import type { GatewaySession, CanonicalMessage } from "../types.ts";

export interface SessionStore {
  get(id: string): Promise<GatewaySession | null>;
  create(session: GatewaySession): Promise<void>;
  update(session: GatewaySession): Promise<void>;
  appendMessages(id: string, messages: CanonicalMessage[]): Promise<void>;
}

const clone = (session: GatewaySession): GatewaySession => structuredClone(session);

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, GatewaySession>();
  async get(id: string): Promise<GatewaySession | null> { const value = this.#sessions.get(id); return value ? clone(value) : null; }
  async create(session: GatewaySession): Promise<void> {
    if (this.#sessions.has(session.id)) throw new Error(`Session already exists: ${session.id}`);
    this.#sessions.set(session.id, clone(session));
  }
  async update(session: GatewaySession): Promise<void> { this.#sessions.set(session.id, clone(session)); }
  async appendMessages(id: string, messages: CanonicalMessage[]): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    session.messages.push(...structuredClone(messages)); session.updatedAt = new Date();
  }
}
