import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "codex-as-api";
import { GatewayError } from "./errors.ts";

// Runs codex-as-api inside the gateway process so GPT can be used through the user's own ChatGPT sign-in
// (the same ~/.codex/auth.json the Codex app and CLI use) without starting a second server by hand.
export interface ChatGPTBackendOptions {
  /** ChatGPT OAuth file. Defaults to CODEX_AS_API_AUTH_PATH, then the Codex app and CLI login: $CODEX_HOME/auth.json or ~/.codex/auth.json. */
  authPath?: string;
  codexConfig?: CreateAppOptions["codexConfig"];
  loginManager?: CreateAppOptions["loginManager"];
}
export type ChatGPTAuthStatus = "authenticated" | "unauthenticated" | "reauthentication_required";
export interface ChatGPTLogin { id: string; method: string; status: string; expires_at: string; error_code?: string; auth_url?: string }
export interface ChatGPTBackend {
  url: string;
  status(): Promise<ChatGPTAuthStatus>;
  startLogin(): Promise<ChatGPTLogin>;
  login(id: string): Promise<ChatGPTLogin>;
  cancelLogin(id: string): Promise<ChatGPTLogin>;
  close(): Promise<void>;
}

// codex-as-api 0.8+ defaults to its own ~/.codex-as-api/auth.json; the gateway shares the Codex login instead.
export const defaultChatGPTAuthPath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.CODEX_AS_API_AUTH_PATH || join(env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");

export async function startChatGPTBackend(options: ChatGPTBackendOptions = {}): Promise<ChatGPTBackend> {
  // codex-as-api only serves its sign-in API when an admin key is set; it reads the key on every request.
  process.env.CODEX_AS_API_ADMIN_KEY ||= randomBytes(32).toString("base64url");
  const adminKey = process.env.CODEX_AS_API_ADMIN_KEY;
  const app = createApp({ authPath: options.authPath ?? defaultChatGPTAuthPath(), codexConfig: options.codexConfig, loginManager: options.loginManager });
  const server = await new Promise<Server>((resolveListen, reject) => {
    const listening: Server = app.listen(0, "127.0.0.1");
    listening.once("error", reject);
    listening.once("listening", () => { listening.off("error", reject); resolveListen(listening); });
  });
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  async function auth<T>(method: string, path: string): Promise<T> {
    const response = await fetch(`${url}/auth${path}`, { method, headers: { authorization: `Bearer ${adminKey}` } });
    const body = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    if (!response.ok) {
      const detail = body.error?.message ?? body.error?.code ?? `HTTP ${response.status}`;
      throw new GatewayError(response.status >= 500 ? "UPSTREAM_UNAVAILABLE" : "INVALID_REQUEST", `ChatGPT sign-in: ${detail}`, response.status);
    }
    return body as T;
  }
  const loginPath = (id: string) => `/login/${encodeURIComponent(id)}`;
  return {
    url,
    status: async () => (await auth<{ status: ChatGPTAuthStatus }>("GET", "/status")).status,
    startLogin: () => auth<ChatGPTLogin>("POST", "/login"),
    login: (id) => auth<ChatGPTLogin>("GET", loginPath(id)),
    cancelLogin: (id) => auth<ChatGPTLogin>("DELETE", loginPath(id)),
    // codex-as-api's server.close also stops any pending browser sign-in and its callback listener.
    close: () => new Promise<void>((resolveClose, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolveClose()); })
  };
}
