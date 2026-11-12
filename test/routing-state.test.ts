import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoutingState, saveRoutingState } from "../src/routing/service.ts";

test("routing state survives a save and reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-routing-"));
  const path = join(directory, "state.json");
  try {
    assert.equal(await loadRoutingState(path), undefined);
    await saveRoutingState(path, { modelId: "gpt-5.6-sol", mode: "force-provider", reasoningEffort: "high", updatedAt: new Date() });
    assert.deepEqual(await loadRoutingState(path), { model: "gpt-5.6-sol", mode: "force-provider", reasoningEffort: "high" });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { model: "gpt-5.6-sol", mode: "force-provider", reasoningEffort: "high" });
  } finally { await rm(directory, { recursive: true }); }
});
