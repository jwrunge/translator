import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createSqliteTranslationProvider,
	listTranslations,
	loadTranslations,
	upsertTranslations,
} from "../sqlite-translations";

describe("SQLite translation backend", () => {
	let tmpDir: string;
	let databasePath: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "translator-test-"));
		databasePath = join(tmpDir, "translations.sqlite");
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("persists and loads translations for a locale", async () => {
		await upsertTranslations({
			databasePath,
			locale: { langCode: "es", region: "MX" },
			translations: {
				"Hello, world!": "¡Hola, mundo!",
				Goodbye: "Adiós",
			},
		});

		const map = await loadTranslations({
			databasePath,
			locale: { langCode: "es", region: "MX" },
			keys: ["Hello, world!", "Goodbye"],
		});

		expect(map).toEqual({
			"Hello, world!": "¡Hola, mundo!",
			Goodbye: "Adiós",
		});

		const provider = createSqliteTranslationProvider(databasePath);
		const providerResult = await provider(
			{ langCode: "es", region: "MX" },
			["Hello, world!", "Missing key"]
		);

		expect(providerResult).toEqual({
			"Hello, world!": "¡Hola, mundo!",
		});
	});

	it("falls back to base locale when region-specific entry is missing", async () => {
		await upsertTranslations({
			databasePath,
			locale: { langCode: "fr" },
			translations: { Checkout: "Paiement" },
		});

		const provider = createSqliteTranslationProvider(databasePath, {
			fallbackToBaseLocale: true,
		});
		const result = await provider({ langCode: "fr", region: "CA" }, [
			"Checkout",
		]);

		expect(result).toEqual({ Checkout: "Paiement" });
	});

	it("retains edited flag across updates and stores metadata", async () => {
		await upsertTranslations({
			databasePath,
			locale: { langCode: "en" },
			translations: [
				{
					key: "Sign in",
					value: "Sign in",
					edited: true,
					metadata: { source: "human" },
				},
			],
		});

		await upsertTranslations({
			databasePath,
			locale: { langCode: "en" },
			translations: { "Sign in": "Sign in" },
		});

		const entries = await listTranslations({
			databasePath,
			locale: { langCode: "en" },
		});

		expect(entries).toHaveLength(1);
		expect(entries[0].edited).toBe(true);
		expect(entries[0].metadata).toEqual({ source: "human" });
		expect(entries[0].updatedAt).toBeGreaterThan(0);
	});
});
