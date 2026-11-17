import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Per-user, per-machine settings entered through the control UI. Never shipped inside the app bundle.
export interface ProviderUserSettings { apiKey?: string; baseUrl?: string }
export interface UserSettings { providers: Record<string, ProviderUserSettings> }

export async function loadUserSettings(path: string): Promise<UserSettings> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<UserSettings>;
    const providers = typeof parsed.providers === "object" && parsed.providers ? parsed.providers : {};
    return { providers };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { providers: {} };
    throw error;
  }
}

export async function saveUserSettings(path: string, settings: UserSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export const apiKeyHint = (key?: string): string | null => key ? `…${key.slice(-4)}` : null;
