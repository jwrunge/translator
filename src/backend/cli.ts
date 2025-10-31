#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { argv, execPath, stdin as input } from "node:process";

import {
	createSqliteTranslationProvider,
	listTranslations,
	loadTranslations,
	upsertTranslations,
} from "./sqlite-translations";

interface CliArgs {
	command: string | null;
	databasePath: string | null;
	locale: string | null;
	inputPath: string | null;
	keys: string[];
	markAsEdited: boolean;
	fallbackToBaseLocale: boolean;
}

const inferredWasmPath = join(dirname(execPath), "sql-wasm.wasm");
if (!process.env.SQLJS_WASM_PATH) {
	process.env.SQLJS_WASM_PATH = inferredWasmPath;
}

function parseArgs(argv: string[]): CliArgs {
	const result: CliArgs = {
		command: null,
		databasePath: null,
		locale: null,
		inputPath: null,
		keys: [],
		markAsEdited: false,
		fallbackToBaseLocale: true,
	};

	const [command, ...rest] = argv;
	result.command = command ?? null;

	for (let index = 0; index < rest.length; index += 1) {
		const token = rest[index];
		switch (token) {
			case "--db":
			case "--database":
				result.databasePath = rest[++index] ?? null;
				break;
			case "--locale":
				result.locale = rest[++index] ?? null;
				break;
			case "--input":
				result.inputPath = rest[++index] ?? null;
				break;
			case "--keys": {
				const value = rest[++index];
				if (value) {
					result.keys = value
						.split(",")
						.map((key) => key.trim())
						.filter(Boolean);
				}
				break;
			}
			case "--mark-edited":
				result.markAsEdited = true;
				break;
			case "--no-fallback":
			case "--no-fallback-to-base":
				result.fallbackToBaseLocale = false;
				break;
			default:
				throw new Error(`Unknown argument: ${token}`);
		}
	}

	return result;
}

function normalizeLocaleInput(locale: string | null): {
	langCode: string;
	region?: string;
} {
	if (!locale) {
		throw new Error("A --locale value (e.g. 'es-MX') is required.");
	}

	const [lang, region] = locale.split(/[-_]/);
	if (!lang) {
		throw new Error("Locale must include a language code.");
	}

	return region ? { langCode: lang, region } : { langCode: lang };
}

async function readInputJson(inputPath: string | null): Promise<unknown> {
	if (!inputPath || inputPath === "-") {
		const chunks: Buffer[] = [];
		for await (const chunk of input) {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		}
		const merged = Buffer.concat(chunks).toString("utf8");
		return merged.length > 0 ? JSON.parse(merged) : {};
	}

	const content = await readFile(inputPath, "utf8");
	return content.length > 0 ? JSON.parse(content) : {};
}

function printUsage(): void {
	console.error(`Usage:

  transmut upsert --db <path> --locale <lang[-REGION]> --input <file|- > [--mark-edited]
  transmut list --db <path> --locale <lang[-REGION]>
  transmut load --db <path> --locale <lang[-REGION]> --keys key1,key2 [--no-fallback]

Examples:
  transmut upsert --db translations.sqlite --locale es-MX --input translations.json
  cat translations.json | transmut upsert --db translations.sqlite --locale es
`);
}

async function main(): Promise<void> {
	try {
		const args = parseArgs(argv.slice(2));

		if (
			!args.command ||
			args.command === "--help" ||
			args.command === "help"
		) {
			printUsage();
			process.exit(args.command ? 0 : 1);
		}

		if (!args.databasePath) {
			throw new Error("A --db path is required.");
		}

		const locale = normalizeLocaleInput(args.locale);

		switch (args.command) {
			case "upsert": {
				const payload = await readInputJson(args.inputPath);
				if (typeof payload !== "object" || payload === null) {
					throw new Error("Input JSON must be an object or array.");
				}

				const translations = Array.isArray(payload)
					? payload
					: (payload as Record<string, string>);

				await upsertTranslations({
					databasePath: args.databasePath,
					locale,
					translations,
					markAsEdited: args.markAsEdited,
				});
				break;
			}
			case "list": {
				const results = await listTranslations({
					databasePath: args.databasePath,
					locale,
				});
				process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
				break;
			}
			case "load": {
				if (args.keys.length === 0) {
					throw new Error("--keys is required for the load command.");
				}
				const results = await loadTranslations({
					databasePath: args.databasePath,
					locale,
					keys: args.keys,
					fallbackToBaseLocale: args.fallbackToBaseLocale,
				});
				process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
				break;
			}
			case "serve": {
				const provider = createSqliteTranslationProvider(
					args.databasePath,
					{ fallbackToBaseLocale: args.fallbackToBaseLocale }
				);
				process.stdout.write(
					`Translation provider ready for database ${args.databasePath}.\n`
				);
				process.stdout.write(
					`Invoke this function from your server code.\n`
				);
				process.stdout.write(`${provider.toString()}\n`);
				break;
			}
			default:
				throw new Error(`Unknown command: ${args.command}`);
		}
	} catch (error) {
		printUsage();
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Error: ${message}`);
		process.exit(1);
	}
}

void main();
