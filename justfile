# Agent command surface: thin wrappers over package scripts and agent-deck.
# CI calls `pnpm run ci` directly, so nothing depends on `just`.
# Recipes echo the command they run. No recipe runs `bd init`.

fork := justfile_directory()

default:
    @just --list

# The gate: everything an agent must pass.
ci:
    @node -v | grep -qE '^v26\.' || { echo "refusing: the gate needs Node 26, found $(node -v 2>/dev/null || echo none). Fix: nvm use 26, or put Node 26 first on PATH." >&2; exit 1; }
    pnpm run ci

test-one file:
    NODE_ENV=test pnpm exec tsx --test {{file}}

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
