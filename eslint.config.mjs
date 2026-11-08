import { defineConfig, globalIgnores } from "eslint/config";
import nextPlugin from "@next/eslint-plugin-next";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import { leakAllowlist } from "./eslint/leak-allowlist.mjs";

/**
 * ESLint with one job here: ENFORCE THE IMPORT LAW (the shell/core
 * architecture, docs/architecture.md). Everything else stays out of the
 * way — this is not a style linter.
 *
 *   components/**  →  "@/src/core"  (the pure core barrel) — ONLY
 *   app/**         →  "@/src/core" + "@/src/server" (the server barrel) — ONLY
 *   src/core/**    →  never imports src/agent, src/server, src/store (pure
 *                    core: adapters implement core/ports.ts, never the reverse)
 *   src/agent/**   →  never imports src/server, src/store (dependencies —
 *                    the storage ports, the composition — arrive via
 *                    factories/closures from the chat-handler)
 *
 *   node:sqlite, @dolthub/doltlite → only src/store/sql/drivers/** may import
 *                    them (static, dynamic import() and require() forms);
 *                    src/seed gets a driver injected by scripts/seed.ts
 *   src/seed/**    →  never imports src/store, src/server, src/agent (CB7:
 *                    scripts/seed.ts is the only composition root)
 *
 * tests/ and scripts/ are internal — unrestricted.
 */

const leakedFiles = [...new Set(leakAllowlist.map((leak) => leak.file))];

// `except` is relative to `from`. A listed file may keep only its own listed adapters.
const serverStoreRule = (except) => ({
	"import/no-restricted-paths": [
		"error",
		{
			zones: [
				{
					target: "./src/server",
					from: "./src/store",
					except,
					message: "src/server reaches store adapters only through the composition root, src/server/stores.ts (known leaks: eslint/leak-allowlist.mjs).",
				},
			],
		},
	],
});

const driverMessage = "Only src/store/sql/drivers may import node:sqlite or @dolthub/doltlite; src/seed gets a driver injected by scripts/seed.ts.";
const driverModule = "node:sqlite|@dolthub/doltlite";
// esquery regexes cannot contain "/", so "." stands for it and the subpath boundary is dropped.
const driverSource = "/^(node:sqlite|@dolthub.doltlite)/";
// Selectors cover what no-restricted-imports cannot see: import("x"), import(`x`), require("x").
const driverSyntax = [
	`ImportExpression[source.value=${driverSource}]`,
	`ImportExpression[source.expressions.length=0][source.quasis.0.value.cooked=${driverSource}]`,
	`CallExpression[callee.name="require"][arguments.0.value=${driverSource}]`,
].map((selector) => ({ selector, message: driverMessage }));

export default defineConfig([
	// electron/** — the desktop shell: plain Node, no framework, outside the
// import law (same rationale as scripts/).
	globalIgnores([".worktrees/**", ".next/**", "node_modules/**", "data/**", "next-env.d.ts", "scripts/**", "electron/**", "dist/**"]),
	{
		files: ["**/*.{js,mjs,ts,tsx}"],
		languageOptions: {
			parser: tsParser,
			parserOptions: { ecmaVersion: "latest", sourceType: "module" },
		},
		plugins: { "@next/next": nextPlugin, import: importPlugin },
		settings: {
			"import/resolver": { typescript: { alwaysTryTypes: true } },
		},
		rules: {
			...nextPlugin.configs.recommended.rules,
			"no-restricted-imports": ["error", { patterns: [{ regex: `^(${driverModule})(/|$)`, message: driverMessage }] }],
			"no-restricted-syntax": ["error", ...driverSyntax],
			"import/no-restricted-paths": [
				"error",
				{
					zones: [
						{
							target: "./components",
							from: "./src",
							// NOTE: the plugin resolves `except` relative to the zone's `from` path.
							except: ["./core/index.ts"],
							message:
								"Browser shell imports ONLY the pure core barrel: `from \"@/src/core\"` (architecture: docs/architecture.md).",
						},
						{
							target: "./app",
							from: "./src",
							except: ["./core/index.ts", "./server/index.ts"],
							message:
								"app/ (transport + server components) imports ONLY the barrels: `@/src/core` and `@/src/server` (architecture: docs/architecture.md).",
						},
						{
							target: "./src/core",
							from: ["./src/agent", "./src/server", "./src/store"],
							message:
								"Pure core never imports IO layers (agent/server/store): adapters implement core/ports.ts, and the composition root (src/server/stores.ts) passes them in (architecture: docs/architecture.md).",
						},
						{
							target: "./src/agent",
							from: ["./src/server", "./src/store"],
							message:
								"The agent layer receives its dependencies (storage ports via factories/closures) — it never imports the server layer or store adapters (architecture: docs/architecture.md).",
						},
						{
							target: "./src/seed",
							from: ["./src/store", "./src/server", "./src/agent"],
							message:
								"src/seed sees ports only; scripts/seed.ts is the only composition root that bridges seed and store/server (CB7).",
						},
					],
				},
			],
		},
	},
	{
		files: ["src/store/sql/drivers/**"],
		rules: { "no-restricted-imports": "off", "no-restricted-syntax": "off" },
	},
	{
		files: ["src/server/**/*.{ts,tsx}"],
		ignores: ["src/server/stores.ts", ...leakedFiles],
		rules: serverStoreRule([]),
	},
	...leakedFiles.map((file) => ({
		files: [file],
		rules: serverStoreRule([...new Set(leakAllowlist.filter((leak) => leak.file === file).map((leak) => `./${leak.module}`))]),
	})),
]);
