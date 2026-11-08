# Agent command surface: thin wrappers over package scripts and agent-deck.
# CI calls `pnpm run ci` directly, so nothing depends on `just`.
# Recipes echo the command they run. No recipe runs `bd init`.

fork := justfile_directory()

default:
    @just --list

# The gate: everything an agent must pass.
ci:
    pnpm run ci

test-one file:
    pnpm exec tsx --test {{file}}

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
    agent-deck add {{fork}} -w lh-{{id}}-{{slug}} -b --location sibling

wt-finish id: _main-checkout
    agent-deck worktree finish {{id}}

wt-clean: _main-checkout
    agent-deck worktree cleanup

bead-claim id:
    BEADS_ACTOR=${BEADS_ACTOR:-kn-builder} bd update {{id}} --claim

bead-handoff id: ci
    BEADS_ACTOR=${BEADS_ACTOR:-kn-builder} bd update {{id}} --status review --append-notes "$(git branch --show-current)@$(git rev-parse --short HEAD); gate: just ci passed"

seed *args:
    pnpm run seed -- {{args}}

lh *args:
    pnpm run lh -- {{args}}

# In a linked worktree .git is a file. Beads setup and worktree management belong to the main checkout.
[private]
_main-checkout:
    @test -d "{{fork}}/.git" || (echo "refusing: run this from the main checkout, not a worktree (and never bd init in a worktree)" >&2; exit 1)
