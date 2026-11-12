/**
 * Server-side persistence for the graph render settings (the settings-panel
 * controls): data/render-settings.json — read-modify-write, NOT a ledger.
 *
 * The shape, defaults, and sanitizer live in src/core/render-settings.ts
 * (pure, shared with the client); this module only moves bytes. Whatever
 * comes off disk is sanitized by the caller on load — and we sanitize on
 * write too, so the file can never hold an out-of-range value that would
 * silently shift a slider.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { DEFAULT_RENDER_SETTINGS, sanitizeRenderSettings, type GraphRenderSettings } from "../core/render-settings.ts";
import type { RenderSettingsStore } from "../core/ports.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import { beforeWrite } from "./marker.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

/** A file RenderSettingsStore over `graphDir` (data/graph); `dataDir` defaults to its parent. */
export function createRenderSettingsStore(graphDir: string, opts: { dataDir?: string } = {}): RenderSettingsStore {
	const dataDir = opts.dataDir ?? path.dirname(path.resolve(graphDir));
	const file = path.join(/* turbopackIgnore: true */ graphDir, "render-settings.json");
	const formatFile = path.join(/* turbopackIgnore: true */ graphDir, "format.json");
	return {
		/** The persisted settings, or null when no file exists yet (first boot). */
		readRenderSettings(): GraphRenderSettings | null {
			assertGraphFormat(formatFile); // honest refusal on a newer-stamped data dir
			let raw: string;
			try {
				raw = fs.readFileSync(file, "utf-8");
			} catch {
				return null; // never booted / unreadable → caller uses defaults
			}
			try {
				return sanitizeRenderSettings(JSON.parse(raw));
			} catch {
				return null; // corrupt → defaults, never crash the view
			}
		},
		/** Persist settings (sanitized). Returns what was written. */
		writeRenderSettings(raw: unknown): GraphRenderSettings {
			const settings = sanitizeRenderSettings(raw);
			assertGraphFormat(formatFile);
			beforeWrite(dataDir);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			ensureGraphFormat(formatFile); // the lazy format stamp (graph-format.ts)
			writeFileAtomicSync(file, JSON.stringify(settings, null, "\t"), { allowInPlaceFallback: true });
			return settings;
		},
	};
}

/** The app's instance, built from config paths. */
export const renderSettingsStore: RenderSettingsStore = createRenderSettingsStore(PATHS.graph, { dataDir: PATHS.data });
export const readRenderSettings = (): GraphRenderSettings | null => renderSettingsStore.readRenderSettings();
export const writeRenderSettings = (raw: unknown): GraphRenderSettings => renderSettingsStore.writeRenderSettings(raw);

export { DEFAULT_RENDER_SETTINGS };
