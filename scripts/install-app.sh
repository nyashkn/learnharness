#!/usr/bin/env bash
# Builds the fork as an unsigned macOS arm64 LearnHarness.app, puts the data folder on DoltLite, installs the app
# over the existing LearnHarness.app (same app id, same data folder) and opens it. Rerun it to update: the installed
# build never checks upstream for updates. Never needs sudo, never kills a process: a running copy is asked to quit.
#
# Overrides (for proving a branch on a throwaway location, never needed day to day):
#   BUNDLE       built .app to install; skips the build. Default: build, then dist/mac-arm64/LearnHarness.app
#   DEST         install directory, default /Applications (falls back to ~/Applications if not writable)
#   LH_APP_DATA  data folder, default "$HOME/Library/Application Support/LearnHarness/data"
#   NO_OPEN=1    skip the final `open`
set -euo pipefail

step() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "install-app.sh only supports macOS (this is $(uname -s))"
node -v | grep -qE '^v26\.' || die "needs Node 26 (DoltLite addon, node:sqlite), found $(node -v 2>/dev/null || echo none). Fix: put Node 26 first on PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="LearnHarness"
DATA="${LH_APP_DATA:-$HOME/Library/Application Support/LearnHarness/data}"

if [ -n "${BUNDLE:-}" ]; then
  step "using the built bundle: $BUNDLE"
else
  step "building the unsigned app (pnpm run desktop:dist, no publish, no notarization)"
  # desktop:dist bakes in upstream's notary profile; these args end up on its electron-builder call.
  # npmRebuild=false: the shell needs no native modules (the server ships prebuilt) and the rebuild fails to compile DoltLite.
  # hardenedRuntime=false: an ad-hoc signature plus hardened runtime blocks loading the server's native addons.
  # --dir builds no dmg/zip, so electron-builder writes no app-update.yml; electron/main.cjs reads that as updater off.
  BUILD_LOG="$(mktemp)"
  # plugins:setup: desktop:dist builds the core plugins, which need their locked dependencies (idempotent npm ci).
  (cd "$ROOT" && pnpm run plugins:setup && pnpm run desktop:dist --dir --publish never -c.mac.notarize=false -c.mac.identity=- -c.mac.hardenedRuntime=false -c.npmRebuild=false) >"$BUILD_LOG" 2>&1 \
    || { tail -40 "$BUILD_LOG" >&2; die "build failed; full log: $BUILD_LOG"; }
  rm -f "$BUILD_LOG"
  BUNDLE="$ROOT/dist/mac-arm64/$APP_NAME.app"
fi
[ -d "$BUNDLE" ] || die "bundle not found: $BUNDLE"

if [ -n "${DEST:-}" ]; then
  [ -d "$DEST" ] && [ -w "$DEST" ] || die "DEST is not a writable directory: $DEST"
elif [ -w /Applications ]; then
  DEST=/Applications
else
  DEST="$HOME/Applications"
  step "/Applications is not writable for this user; installing to $DEST instead (no sudo)"
  mkdir -p "$DEST"
fi
TARGET="$DEST/$APP_NAME.app"

is_running() { [ "$(osascript -e "application \"$APP_NAME\" is running" 2>/dev/null)" = true ]; }

if is_running; then
  step "asking \"$APP_NAME\" to quit"
  osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null
  for _ in $(seq 1 20); do
    is_running || break
    sleep 0.5
  done
  is_running && die "\"$APP_NAME\" is still running after 10 s; quit it yourself and rerun (nothing was changed, nothing was killed)"
  step "\"$APP_NAME\" has quit"
else
  step "\"$APP_NAME\" is not running"
fi

# Data folder: a missing or empty folder starts on DoltLite, a file or sqlite folder is migrated, DoltLite is left alone.
lh_migrate() {
  local out
  out="$(cd "$ROOT" && "$ROOT/node_modules/.bin/tsx" scripts/lh-storage.ts migrate --to doltlite --data-dir "$DATA" "$@" 2>&1)" \
    || { printf '%s\n' "$out" >&2; die "lh migrate failed; the data folder is as migrate left it: $DATA"; }
  step "data to doltlite: $(printf '%s' "$out" | awk 'NF{printf "%s%s", sep, $0; sep="; "}')"
}
if [ ! -d "$DATA" ] || [ -z "$(ls -A "$DATA")" ]; then
  mkdir -p "$DATA"
  lh_migrate --allow-empty-source
else
  # A missing marker means file (src/store/marker.ts); anything unreadable or unknown refuses.
  BACKEND="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).backend)}catch(e){console.log(e.code==="ENOENT"?"file":"unreadable")}' "$DATA/storage.json")"
  case "$BACKEND" in
    doltlite) step "data already on doltlite, left alone: $DATA" ;;
    file|sqlite) lh_migrate ;;
    *) die "$DATA/storage.json is unreadable or names an unknown backend ($BACKEND); nothing was changed" ;;
  esac
fi

step "copying to $TARGET"
rm -rf "$TARGET.new"
ditto "$BUNDLE" "$TARGET.new"
rm -rf "$TARGET"
mv "$TARGET.new" "$TARGET"

if [ "${NO_OPEN:-}" = 1 ]; then
  step "NO_OPEN=1: not opening"
else
  step "opening $TARGET"
  open "$TARGET"
fi
step "done"
