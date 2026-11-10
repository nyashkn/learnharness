# 0011. pnpm, not npm

Status: Accepted (2026-11-08, Njui, Plannotator Inbox)

## Context
Upstream uses npm and `package-lock.json`. electron-builder needs a flat `node_modules`.

## Decision
pnpm is the only package manager.
- `package.json` sets `"packageManager": "pnpm@11.20.0"`.
- `pnpm-lock.yaml` is the lockfile. `package-lock.json` is deleted.
- `pnpm-workspace.yaml` holds pnpm settings: `nodeLinker: hoisted` (electron-builder needs a flat `node_modules`) and `allowBuilds`, which lists each dependency with install scripts as allowed or not.
- CI and release use `pnpm/action-setup` and `pnpm install --frozen-lockfile`. The gate is `pnpm run ci`, which `just ci` calls.
- Worktrees set up with `pnpm install --frozen-lockfile`.

## Consequences
- pnpm 11 reads only auth and registry settings from `.npmrc`. Everything else goes in `pnpm-workspace.yaml`.
- A new dependency with an install script must be added to `allowBuilds`, or `pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS` and every worktree setup breaks.
- Upstream sync: a change upstream makes to `package-lock.json` must be re-applied with `pnpm import` or by hand.
