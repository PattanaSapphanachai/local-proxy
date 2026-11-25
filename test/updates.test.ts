import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, findUpdate } from "../src/updates.ts";

const release = (tag: string, assets: string[]) => async () => new Response(JSON.stringify({
  tag_name: tag, html_url: `https://github.com/o/r/releases/tag/${tag}`,
  assets: assets.map((name) => ({ name, browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}` }))
}), { status: 200 });

test("compareVersions orders dotted versions numerically", () => {
  assert.equal(compareVersions("0.1.10", "0.1.9"), 1);
  assert.equal(compareVersions("v0.1.3", "0.1.3"), 0);
  assert.equal(compareVersions("0.1.3", "0.2.0"), -1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
});

test("findUpdate offers a newer release that has a DMG for this CPU", async () => {
  const found = await findUpdate({ repo: "o/r", currentVersion: "0.1.3", arch: "arm64", fetch: release("v0.1.4", ["Local-Proxy-0.1.4-arm64.dmg", "Local-Proxy-0.1.4-x64.dmg"]) as typeof fetch });
  assert.deepEqual(found, { version: "0.1.4", dmgUrl: "https://github.com/o/r/releases/download/v0.1.4/Local-Proxy-0.1.4-arm64.dmg", pageUrl: "https://github.com/o/r/releases/tag/v0.1.4" });
});

test("findUpdate ignores same, older, unfinished and missing releases", async () => {
  const dmgs = ["Local-Proxy-0.1.4-arm64.dmg", "Local-Proxy-0.1.4-x64.dmg"];
  assert.equal(await findUpdate({ repo: "o/r", currentVersion: "0.1.4", arch: "arm64", fetch: release("v0.1.4", dmgs) as typeof fetch }), undefined);
  assert.equal(await findUpdate({ repo: "o/r", currentVersion: "0.2.0", arch: "arm64", fetch: release("v0.1.4", dmgs) as typeof fetch }), undefined);
  assert.equal(await findUpdate({ repo: "o/r", currentVersion: "0.1.3", arch: "arm64", fetch: release("v0.1.4", ["Local-Proxy-0.1.4-x64.dmg"]) as typeof fetch }), undefined);
  assert.equal(await findUpdate({ repo: "o/r", currentVersion: "0.1.3", arch: "arm64", fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch }), undefined);
  await assert.rejects(findUpdate({ repo: "o/r", currentVersion: "0.1.3", arch: "arm64", fetch: (async () => new Response("{}", { status: 403 })) as typeof fetch }), /403/);
});
