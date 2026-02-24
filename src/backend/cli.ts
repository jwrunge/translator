#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
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
	port: number;
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
		port: 4000,
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
			case "--port": {
				const raw = rest[++index] ?? "";
				const parsed = Number.parseInt(raw, 10);
				if (!Number.isFinite(parsed) || parsed <= 0) {
					throw new Error("--port must be a positive integer.");
				}
				result.port = parsed;
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

function splitKeys(value: string | null): string[] {
	if (!value) {
		return [];
	}

	return value
		.split(",")
		.map((key) => key.trim())
		.filter(Boolean);
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}

	const body = Buffer.concat(chunks).toString("utf8").trim();
	if (!body) {
		return {};
	}

	return JSON.parse(body);
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
	transmut serve --db <path> [--port <number>] [--no-fallback]

Examples:
  transmut upsert --db translations.sqlite --locale es-MX --input translations.json
  cat translations.json | transmut upsert --db translations.sqlite --locale es
	transmut serve --db translations.sqlite --port 4000
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

		switch (args.command) {
			case "upsert": {
				const locale = normalizeLocaleInput(args.locale);
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
				const locale = normalizeLocaleInput(args.locale);
				const results = await listTranslations({
					databasePath: args.databasePath,
					locale,
				});
				process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
				break;
			}
			case "load": {
				const locale = normalizeLocaleInput(args.locale);
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

				const server = createServer(async (request, response) => {
					try {
						const requestUrl = new URL(
							request.url ?? "/",
							`http://localhost:${args.port}`
						);

						if (requestUrl.pathname !== "/translations") {
							response.statusCode = 404;
							response.setHeader("Content-Type", "application/json");
							response.end(
								JSON.stringify({ error: "Not found" })
							);
							return;
						}

						let langCode = requestUrl.searchParams.get("langCode") ?? "";
						let region = requestUrl.searchParams.get("region") ?? "";
						let keys = splitKeys(requestUrl.searchParams.get("keys"));

						if (request.method === "POST") {
							const payload = await readRequestJson(request);
							if (payload && typeof payload === "object") {
								const data = payload as {
									langCode?: unknown;
									region?: unknown;
									keys?: unknown;
								};
								if (typeof data.langCode === "string") {
									langCode = data.langCode;
								}
								if (typeof data.region === "string") {
									region = data.region;
								}
								if (Array.isArray(data.keys)) {
									keys = data.keys.filter(
										(key): key is string =>
											typeof key === "string" &&
											key.trim().length > 0
									);
								}
							}
						}

						if (!langCode || keys.length === 0) {
							response.statusCode = 400;
							response.setHeader("Content-Type", "application/json");
							response.end(
								JSON.stringify({
									error: "langCode and keys are required",
								})
							);
							return;
						}

						const translations = await provider(
							{ langCode, region: region || undefined },
							keys
						);

						response.statusCode = 200;
						response.setHeader("Content-Type", "application/json");
						response.end(JSON.stringify(translations));
					} catch (error) {
						response.statusCode = 500;
						response.setHeader("Content-Type", "application/json");
						response.end(
							JSON.stringify({
								error:
									error instanceof Error
										? error.message
										: "Failed to load translations",
							})
						);
					}
				});

				server.listen(args.port, () => {
					process.stdout.write(
						`Transmut server listening on http://localhost:${args.port}/translations\n`
					);
					process.stdout.write(
						`Using database ${args.databasePath}\n`
					);
				});
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
