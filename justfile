# Agent command surface: thin wrappers over package scripts and agent-deck.
# CI calls `pnpm run ci` directly, so nothing depends on `just`.
# Recipes echo the command they run. No recipe runs `bd init`.

fork := justfile_directory()

default:
    @just --list

# The gate: everything an agent must pass.
ci:
    @node -v | grep -qE '^v26\.' || { echo "refusing: the gate needs Node 26, found $(node -v 2>/dev/null || echo none). Fix: nvm use 26, or put Node 26 first on PATH." >&2; exit 1; }
    pnpm run plugins:setup
    pnpm run ci

# One step in a Cloudflare sandbox (cf-ci), from this worktree, uncommitted files included.
# `just remote ci` runs the full gate as `just remote-ci`; any other step name runs alone. Steps: .cf-ci.yml.
remote step:
    {{ if step == "ci" { "just remote-ci" } else { "infisical-kn-personal-dev cf-ci-remote " + quote(step) } }}

# Every .cf-ci.yml step, each in its own sandbox, in one cf-ci run (one snapshot).
remote-ci:
    #!/usr/bin/env bash
    set -u; logs=$(mktemp -d)
    CF_CI_LOG_DIR="$logs" infisical-kn-personal-dev cf-ci-remote $(sed -n '/^steps:/,$s/^  \([a-z0-9_-]*\):.*/\1/p' .cf-ci.yml) > "$logs/run.out"; rc=$?
    awk 'FNR==1' "$logs"/*.log 2>/dev/null; tail -n 1 "$logs/run.out"; echo "logs: $logs"
    exit $rc

# Build the fork as an unsigned LearnHarness.app, put its data on DoltLite, install over the old app, open it.
app:
    bash scripts/install-app.sh

# Drives the fork's screens headless (puppeteer, throwaway data, scripted model, no keys); one PASS/FAIL line per step, screenshots under $TMPDIR.
acceptance:
    @node -v | grep -qE '^v26\.' || { echo "refusing: acceptance needs Node 26, found $(node -v 2>/dev/null || echo none)." >&2; exit 1; }
    pnpm run plugins:setup && pnpm run plugins:build-core && pnpm run plugins:build-authoring
    pnpm exec tsx scripts/acceptance/run.ts

test-one file:
    NODE_ENV=test pnpm exec tsx --import ./tests/isolate-data-dir.ts --test {{file}}

# Times the due-queue read at 10k propositions x 3 reviews on the file and sqlite backends (prints ms; no assertion).
bench-review:
    pnpm exec tsx scripts/bench-review.ts

contract:
    pnpm run test:contract

ready:
    bd ready --type task --json

# Rebuild the shared GitNexus index from main. Lead only, after a merge with `just ci` green.
index: _main-checkout
    gitnexus analyze --index-only --embeddings --name learnharness-fork

wt-list:
    agent-deck worktree list

wt-new id slug: _main-checkout
    agent-deck add -t {{id}} -c claude -w lh-{{id}}-{{slug}} -b --location sibling {{fork}}

wt-finish id: _main-checkout
    agent-deck worktree finish {{id}}

wt-clean: _main-checkout
    agent-deck worktree cleanup

bead-claim id:
    BEADS_ACTOR=${BEADS_ACTOR:-kn-builder} bd update {{id}} --claim

# notes: "gate: <one real result line per command>; gitnexus: <risk line>"
bead-handoff id $notes: ci
    BEADS_ACTOR=${BEADS_ACTOR:-kn-builder} bd update {{id}} --status review --append-notes "$(git branch --show-current)@$(git rev-parse --short HEAD); $notes"

seed *args:
    pnpm run seed {{args}}

lh *args:
    pnpm run lh {{args}}

# In a linked worktree .git is a file. Beads setup and worktree management belong to the main checkout.
[private]
_main-checkout:
    @test -d "{{fork}}/.git" || (echo "refusing: run this from the main checkout, not a worktree (and never bd init in a worktree)" >&2; exit 1)
