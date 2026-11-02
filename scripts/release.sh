#!/bin/bash
# Cut a release from this Mac:  ./scripts/release.sh 0.11.0
#
# Bumps the version, tests, commits, tags and pushes; builds, signs, notarizes and staples the DMG
# and the darwin CLI binary from a clean checkout of the tag; waits for CI to build Linux/Windows;
# then publishes the GitHub release with all assets.
#
# Needs: a "Developer ID Application" identity in the login keychain, a notarytool keychain profile
# (default "notary"; create with `xcrun notarytool store-credentials notary`), and an authenticated `gh`.
# Env overrides: SIGN_ID, NOTARY_PROFILE.
# RESUME=1 ./scripts/release.sh X.Y.Z  finishes a release whose tag was already pushed (e.g. a failed upload): it rebuilds, re-notarizes and re-uploads.
set -euo pipefail
cd "$(dirname "$0")/.."

VER=${1:-}
[[ $VER =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 <major.minor.patch>" >&2; exit 2; }
TAG=v$VER
PROFILE=${NOTARY_PROFILE:-notary}
SIGN_ID=${SIGN_ID:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' | head -1)}
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

say() { printf '\n==> %s\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

# ---- preflight (nothing is changed until these pass) ----
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || die "run this on an Apple Silicon Mac"
[[ -n $SIGN_ID ]] || die "no 'Developer ID Application' identity in the keychain (or set SIGN_ID)"
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 || die "notarytool profile '$PROFILE' not found (xcrun notarytool store-credentials $PROFILE)"
[[ -z $(git status --porcelain) ]] || die "working tree is not clean; commit or stash first"
[[ $(git branch --show-current) == main ]] || die "not on main"
git fetch -q origin main --tags
[[ $(git rev-parse HEAD) == "$(git rev-parse origin/main)" ]] || die "main is not in sync with origin/main"
if [[ -z ${RESUME:-} ]]; then
  ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "tag $TAG already exists (RESUME=1 finishes an interrupted release)"
  ! gh release view "$TAG" >/dev/null 2>&1 || die "release $TAG already exists"
else
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "RESUME needs the tag $TAG to exist"
fi
echo "releasing $TAG as: $SIGN_ID"

WORK=$(mktemp -d)
cleanup() { git worktree remove --force "$WORK/src" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

# ---- bump, test, tag, push ----
if [[ -z ${RESUME:-} ]]; then
  say "Tests"
  npm test >/dev/null
  say "Bump to $VER, tag and push"
  sed -i '' "s/\"version\": \"[0-9.]*\"/\"version\": \"$VER\"/" package.json
  sed -i '' "s#<key>CFBundleShortVersionString</key><string>[0-9.]*</string>#<key>CFBundleShortVersionString</key><string>$VER</string>#" desktop/build.sh
  git diff --quiet && die "version bump changed nothing"
  git commit -qam "Release $VER"
  git tag "$TAG"
  git push origin main "$TAG"
  SHA=$(git rev-parse HEAD)
else
  say "Resuming $TAG"
  SHA=$(git rev-list -n1 "$TAG")
fi

# ---- build from a clean checkout of the tag ----
git worktree add -q --detach "$WORK/src" "$TAG"
cd "$WORK/src"

say "Node 22 (single-executable builds need an official Node, not Homebrew's)"
NODE22=node
if ! node -e 'process.exit(process.versions.node.split(".")[0]==22 && !/homebrew/i.test(process.execPath) ? 0 : 1)' 2>/dev/null; then
  B=https://nodejs.org/dist/latest-v22.x
  curl -fsSL "$B/SHASUMS256.txt" -o "$WORK/sums"
  F=$(awk '/darwin-arm64.tar.gz$/{print $2}' "$WORK/sums")
  curl -fsSL "$B/$F" -o "$WORK/$F"
  (cd "$WORK" && grep " $F\$" sums | shasum -a 256 -c -)
  tar -xzf "$WORK/$F" -C "$WORK"
  NODE22="$WORK/${F%.tar.gz}/bin/node"
fi
"$NODE22" -v

say "darwin CLI binary"
PATH="$(dirname "$(command -v "$NODE22")"):$PATH" node scripts/build-sea.js >/dev/null
CLI=dist/plainnote-darwin-arm64
[[ -x $CLI ]] || die "darwin binary was not built"

say "App and disk image"
SIGN_ID="$SIGN_ID" ./desktop/build.sh >/dev/null
mkdir "$WORK/dmg"
cp -R dist/Plainnote.app "$WORK/dmg/"
ln -s /Applications "$WORK/dmg/Applications"
DMG=dist/Plainnote-$VER-universal.dmg
hdiutil create -quiet -volname Plainnote -srcfolder "$WORK/dmg" -ov -format UDZO "$DMG"
codesign --force --timestamp --sign "$SIGN_ID" "$DMG"

say "Notarize (waits for Apple)"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait --output-format json > "$WORK/notary.json" || true
STATUS=$(node -p "require('$WORK/notary.json').status" 2>/dev/null || echo unknown)
if [[ $STATUS != Accepted ]]; then
  ID=$(node -p "require('$WORK/notary.json').id" 2>/dev/null || true)
  [[ -n $ID ]] && xcrun notarytool log "$ID" --keychain-profile "$PROFILE" || true
  die "notarization $STATUS; the tag $TAG is already pushed, fix and publish by hand"
fi
xcrun stapler staple "$DMG" >/dev/null
xcrun stapler validate "$DMG" >/dev/null
spctl -a -vv -t install "$DMG"

# ---- CI builds Linux and Windows ----
say "Waiting for CI"
RUN=""
for _ in $(seq 1 30); do
  RUN=$(gh run list --workflow build-desktop --commit "$SHA" --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
  [[ -n $RUN ]] && break; sleep 5
done
[[ -n $RUN ]] || die "no CI run found for $SHA"
gh run watch "$RUN" >/dev/null 2>&1 || true            # the macOS leg may fail without cert secrets; that is fine
mkdir "$WORK/ci"
for n in ubuntu-latest windows-latest; do
  gh run download "$RUN" -n "plainnote-$n" -D "$WORK/ci" || die "CI artifact plainnote-$n missing (did that job fail?)"
done

# ---- publish ----
say "Publish $TAG"
retry() { local n; for n in 1 2 3 4; do "$@" && return 0; echo "attempt $n failed, retrying…" >&2; sleep $((n * 5)); done; return 1; }   # GitHub's upload API occasionally answers 5xx
if gh release view "$TAG" >/dev/null 2>&1; then          # CI's release job already ran; replace its macOS assets
  retry gh release upload "$TAG" "$DMG" "$CLI" "$WORK"/ci/plainnote-* --clobber || die "upload failed; the release is incomplete: RESUME=1 $0 $VER"
else
  retry gh release create "$TAG" --title "$TAG" --verify-tag --generate-notes "$DMG" "$CLI" "$WORK"/ci/plainnote-* || die "release creation failed: RESUME=1 $0 $VER"
fi
echo
gh release view "$TAG" --json url,assets -q '.url, (.assets[] | "  " + .name)'
echo "done: $REPO $TAG"
