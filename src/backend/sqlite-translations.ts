import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import initSqlJs from "sql.js";
import type SqlJs from "sql.js";

import type { GetTransMapFn } from "../observer/types";

const require = createRequire(import.meta.url);
const SQL_WASM_PATH = require.resolve("sql.js/dist/sql-wasm.wasm");

let sqlJsInstancePromise: Promise<SqlJs.SqlJsStatic> | null = null;

async function loadSqlJs(): Promise<SqlJs.SqlJsStatic> {
	if (!sqlJsInstancePromise) {
		sqlJsInstancePromise = initSqlJs({
			locateFile: (file: string) =>
				file === "sql-wasm.wasm" ? SQL_WASM_PATH : resolve(file),
		});
	}

	return sqlJsInstancePromise;
}

async function readDatabaseFile(path: string): Promise<Uint8Array | null> {
	try {
		const buffer = await fs.readFile(path);
		return new Uint8Array(buffer);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

async function ensureDirectoryForFile(path: string): Promise<void> {
	const directory = dirname(path);
	await fs.mkdir(directory, { recursive: true });
}

async function writeDatabaseFile(
	path: string,
	db: SqlJs.Database
): Promise<void> {
	await ensureDirectoryForFile(path);
	const binary = db.export();
	await fs.writeFile(path, binary);
}

type DatabaseMode = "readonly" | "readwrite";

async function withDatabase<T>(
	databasePath: string,
	mode: DatabaseMode,
	handler: (db: SqlJs.Database) => T | Promise<T>
): Promise<T> {
	const SQL = await loadSqlJs();
	const fileBytes = await readDatabaseFile(databasePath);
	const db = fileBytes ? new SQL.Database(fileBytes) : new SQL.Database();

	try {
		if (mode === "readwrite") {
			ensureSchema(db);
		}

		const result = await handler(db);

		if (mode === "readwrite") {
			await writeDatabaseFile(databasePath, db);
		}

		return result;
	} finally {
		db.close();
	}
}

function ensureSchema(db: SqlJs.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS translations (
			lang TEXT NOT NULL,
			region TEXT NOT NULL DEFAULT '',
			locale TEXT NOT NULL,
			key TEXT NOT NULL,
			value TEXT NOT NULL,
			edited INTEGER NOT NULL DEFAULT 0,
			metadata TEXT,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (lang, region, key)
		);

		CREATE INDEX IF NOT EXISTS idx_translations_locale
			ON translations (lang, region, key);
	`);
}

function hasTranslationTable(db: SqlJs.Database): boolean {
	const stmt = db.prepare(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='translations' LIMIT 1;"
	);
	try {
		return stmt.step();
	} finally {
		stmt.free();
	}
}

function normalizeLang(lang: string | undefined): string {
	const value = lang?.trim().toLowerCase();
	if (!value) {
		throw new Error("A language code is required.");
	}
	return value;
}

function normalizeRegion(region: string | undefined): string {
	if (!region) {
		return "";
	}
	const trimmed = region.trim();
	if (trimmed.length === 0) {
		return "";
	}
	return trimmed.toUpperCase();
}

function composeLocaleTag(lang: string, region: string): string {
	return region ? `${lang}-${region}` : lang;
}

function parseLocaleInput(
	locale: TranslationLocale | string
): TranslationLocale {
	if (typeof locale === "string") {
		const [lang, region] = locale.split(/[-_]/);
		return { langCode: lang ?? "", region };
	}
	return locale;
}

interface NormalizedLocale {
	lang: string;
	region: string;
	tag: string;
}

function normalizeLocale(locale: TranslationLocale | string): NormalizedLocale {
	const parsed = parseLocaleInput(locale);
	const lang = normalizeLang(parsed.langCode);
	const region = normalizeRegion(parsed.region);
	return { lang, region, tag: composeLocaleTag(lang, region) };
}

export interface TranslationLocale {
	langCode: string;
	region?: string;
}

export interface TranslationRecordInput {
	key: string;
	value: string;
	edited?: boolean;
	metadata?: unknown;
}

export interface UpsertTranslationsParams {
	databasePath: string;
	locale: TranslationLocale | string;
	translations: Record<string, string> | TranslationRecordInput[];
	markAsEdited?: boolean;
	touchedAt?: Date;
}

export interface LoadTranslationsParams {
	databasePath: string;
	locale: TranslationLocale | string;
	keys: string[];
	fallbackToBaseLocale?: boolean;
}

export interface StoredTranslationRecord {
	key: string;
	value: string;
	edited: boolean;
	metadata?: unknown;
	updatedAt: number;
}

export interface SqliteTranslationProviderOptions {
	fallbackToBaseLocale?: boolean;
}

function toRecordArray(
	translations: Record<string, string> | TranslationRecordInput[]
): TranslationRecordInput[] {
	if (Array.isArray(translations)) {
		return translations.filter(
			(entry) =>
				typeof entry?.key === "string" && entry.key.trim().length > 0
		);
	}

	return Object.entries(translations)
		.filter(
			([key, value]) =>
				typeof key === "string" &&
				key.trim().length > 0 &&
				typeof value === "string"
		)
		.map(([key, value]) => ({ key, value }));
}

function serializeMetadata(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}

	if (typeof value === "string") {
		return value;
	}

	try {
		return JSON.stringify(value);
	} catch (_error) {
		return null;
	}
}

function deserializeMetadata(value: unknown): unknown {
	if (typeof value !== "string") {
		return value ?? undefined;
	}

	try {
		return JSON.parse(value);
	} catch (_error) {
		return value;
	}
}

export async function upsertTranslations({
	databasePath,
	locale,
	translations,
	markAsEdited = false,
	touchedAt,
}: UpsertTranslationsParams): Promise<void> {
	const records = toRecordArray(translations);
	if (records.length === 0) {
		return;
	}

	const { lang, region, tag } = normalizeLocale(locale);
	const updatedAt = touchedAt?.getTime() ?? Date.now();

	await withDatabase(databasePath, "readwrite", (db) => {
		const statement = db.prepare(`
			INSERT INTO translations (
				lang,
				region,
				locale,
				key,
				value,
				edited,
				metadata,
				updated_at
			) VALUES (
				$lang,
				$region,
				$locale,
				$key,
				$value,
				$edited,
				$metadata,
				$updated_at
			)
			ON CONFLICT(lang, region, key) DO UPDATE SET
				value = excluded.value,
				edited = CASE
					WHEN translations.edited = 1 THEN 1
					ELSE excluded.edited
				END,
				metadata = CASE
					WHEN excluded.metadata IS NULL THEN translations.metadata
					ELSE excluded.metadata
				END,
				updated_at = excluded.updated_at;
		`);

		try {
			db.exec("BEGIN IMMEDIATE TRANSACTION;");
			for (const entry of records) {
				const trimmedKey = entry.key.trim();
				if (
					trimmedKey.length === 0 ||
					typeof entry.value !== "string"
				) {
					continue;
				}

				const editedFlag = markAsEdited || entry.edited ? 1 : 0;
				statement.run({
					$lang: lang,
					$region: region,
					$locale: tag,
					$key: trimmedKey,
					$value: entry.value,
					$edited: editedFlag,
					$metadata: serializeMetadata(entry.metadata ?? null),
					$updated_at: updatedAt,
				});
			}
			db.exec("COMMIT;");
		} catch (error) {
			db.exec("ROLLBACK;");
			throw error;
		} finally {
			statement.free();
		}
	});
}

function collectTranslations(
	db: SqlJs.Database,
	lang: string,
	region: string,
	keys: string[]
): Record<string, string> {
	const result: Record<string, string> = {};
	const statement = db.prepare(
		`SELECT value FROM translations WHERE lang = $lang AND region = $region AND key = $key LIMIT 1;`
	);

	try {
		for (const key of keys) {
			statement.bind({ $lang: lang, $region: region, $key: key });
			if (statement.step()) {
				const row = statement.getAsObject() as { value?: unknown };
				if (typeof row.value === "string") {
					result[key] = row.value;
				}
			}
			statement.reset();
		}
	} finally {
		statement.free();
	}

	return result;
}

export async function loadTranslations({
	databasePath,
	locale,
	keys,
	fallbackToBaseLocale = true,
}: LoadTranslationsParams): Promise<Record<string, string>> {
	if (!Array.isArray(keys) || keys.length === 0) {
		return {};
	}

	const { lang, region } = normalizeLocale(locale);

	return withDatabase(databasePath, "readonly", (db) => {
		if (!hasTranslationTable(db)) {
			return {};
		}

		const primary = collectTranslations(db, lang, region, keys);
		if (!fallbackToBaseLocale || region === "") {
			return primary;
		}

		const missing = keys.filter((key) => !(key in primary));
		if (missing.length === 0) {
			return primary;
		}

		const fallback = collectTranslations(db, lang, "", missing);
		return { ...fallback, ...primary };
	});
}

export async function listTranslations({
	databasePath,
	locale,
}: {
	databasePath: string;
	locale: TranslationLocale | string;
}): Promise<StoredTranslationRecord[]> {
	const { lang, region } = normalizeLocale(locale);

	return withDatabase(databasePath, "readonly", (db) => {
		if (!hasTranslationTable(db)) {
			return [];
		}

		const statement = db.prepare(
			`SELECT key, value, edited, metadata, updated_at FROM translations WHERE lang = $lang AND region = $region ORDER BY key ASC;`
		);

		const results: StoredTranslationRecord[] = [];
		try {
			statement.bind({ $lang: lang, $region: region });
			while (statement.step()) {
				const row = statement.getAsObject() as {
					key?: unknown;
					value?: unknown;
					edited?: unknown;
					metadata?: unknown;
					updated_at?: unknown;
				};

				if (
					typeof row.key !== "string" ||
					typeof row.value !== "string"
				) {
					continue;
				}

				results.push({
					key: row.key,
					value: row.value,
					edited: Number(row.edited) === 1,
					metadata: deserializeMetadata(row.metadata),
					updatedAt:
						typeof row.updated_at === "number"
							? row.updated_at
							: typeof row.updated_at === "string"
							? Number.parseInt(row.updated_at, 10)
							: 0,
				});
			}
		} finally {
			statement.free();
		}

		return results;
	});
}

export function createSqliteTranslationProvider(
	databasePath: string,
	options?: SqliteTranslationProviderOptions
): GetTransMapFn {
	const { fallbackToBaseLocale = true } = options ?? {};

	return async ({ langCode, region }, keys) =>
		loadTranslations({
			databasePath,
			locale: { langCode, region },
			keys,
			fallbackToBaseLocale,
		});
}
