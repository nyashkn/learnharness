# 0008. TypeBox at trust boundaries, not zod

Status: Accepted (2026-11-08; storage-architecture C6, CB5)

## Context
`zod` is installed but never imported. TypeBox is already used for LLM tool arguments (`src/core/tool-parts.ts`) and emits JSON Schema natively.

## Decision
Use TypeBox for line, chat, job and settings schemas and HTTP bodies. Do not add zod.

## Consequences
- `Value.Check` only at the edge. Never `Convert` or `Clean` on verbatim lines, because they mutate. Failing disk lines are counted and skipped.
- Line schemas set `additionalProperties: true` so unknown fields survive.
- `scripts/export-json-schemas.ts` writes JSON Schemas into docs; a drift test fails if they differ.
