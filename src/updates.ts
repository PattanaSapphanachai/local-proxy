// Release lookup for the desktop app's updater. Releases are the GitHub releases `npm run release` publishes:
// tag v<version> with Local-Proxy-<version>-<arch>.dmg assets, the same layout scripts/install.sh downloads.
export interface AvailableUpdate { version: string; dmgUrl: string; pageUrl: string }

/** Compares dotted numeric versions ("0.1.10" > "0.1.9"); a leading "v" and any "-suffix" are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.replace(/^v/, "").split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a), right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** Returns the latest GitHub release when it is newer than currentVersion and already has a DMG for this CPU. */
export async function findUpdate(options: { repo: string; currentVersion: string; arch: string; fetch?: typeof fetch }): Promise<AvailableUpdate | undefined> {
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(`https://api.github.com/repos/${options.repo}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "local-proxy-updater" }
  });
  if (response.status === 404) return undefined; // nothing published yet
  if (!response.ok) throw new Error(`GitHub answered ${response.status} when asked for the latest release`);
  const release = await response.json() as { tag_name?: string; html_url?: string; assets?: { name?: string; browser_download_url?: string }[] };
  const version = (release.tag_name ?? "").replace(/^v/, "");
  if (!version || compareVersions(version, options.currentVersion) <= 0) return undefined;
  // Missing while `gh release create` is still uploading, or when no build exists for this CPU: offer it on a later check.
  const asset = release.assets?.find((item) => item.name === `Local-Proxy-${version}-${options.arch}.dmg`);
  if (!asset?.browser_download_url) return undefined;
  return { version, dmgUrl: asset.browser_download_url, pageUrl: release.html_url ?? `https://github.com/${options.repo}/releases/tag/v${version}` };
}
