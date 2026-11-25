#!/usr/bin/env bash
# Publish the DMGs built by `npm run dist` as a GitHub release.
#
# Usage (after `npm run dist` and committing the version bump):
#   npm run release
#
# Steps: checks the tree is committed and both DMGs exist for the version in
# package.json, tags HEAD as v<version>, pushes the branch and tag to origin,
# then creates the GitHub release with the DMGs attached using the gh CLI.
# The asset names match what scripts/install.sh downloads.
#
# Optional environment variables:
#   DRY_RUN=1      Print the commands instead of running them.
#   RELEASE_REMOTE Git remote to push to. Defaults to origin.

set -euo pipefail

cd "$(dirname "$0")/.."

REMOTE="${RELEASE_REMOTE:-origin}"
VERSION="$(node -p 'require("./package.json").version')"
TAG="v$VERSION"
BRANCH="$(git branch --show-current)"
DMGS=("release/Local-Proxy-$VERSION-arm64.dmg" "release/Local-Proxy-$VERSION-x64.dmg")

info() { printf '==> %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
run() { if [ "${DRY_RUN:-}" = "1" ]; then printf '[dry run] %s\n' "$*"; else "$@"; fi; }

[ -n "$BRANCH" ] || fail "HEAD is detached. Check out the branch to release from."
for dmg in "${DMGS[@]}"; do
  [ -f "$dmg" ] || fail "$dmg is missing. Run npm run dist first."
done
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  fail "The working tree has uncommitted changes. Commit them, including the version bump, before releasing."
fi
command -v gh >/dev/null || fail "The gh CLI is not installed. Install it with: brew install gh"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  [ "$(git rev-parse "$TAG^{commit}")" = "$(git rev-parse HEAD)" ] \
    || fail "Tag $TAG already exists on another commit. Run npm run dist again to bump the version."
  info "Tag $TAG already points at HEAD"
else
  info "Tagging HEAD as $TAG"
  run git tag -a "$TAG" -m "Local Proxy $VERSION"
fi

info "Pushing $BRANCH and $TAG to $REMOTE"
run git push "$REMOTE" "$BRANCH" "$TAG"

info "Creating GitHub release $TAG"
run gh release create "$TAG" "${DMGS[@]}" --verify-tag --title "Local Proxy $VERSION" --generate-notes

info "Released Local Proxy $VERSION"
