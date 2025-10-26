import { cloneRegex } from "./options";
import type { DynamicFragment, DynamicFragmentMatch } from "./types";

export interface NormalizationResult {
	normalized: string;
	hasVariables: boolean;
	hasNumbers: boolean;
	fragments: DynamicFragment[];
}

interface DynamicContentConfig {
	variablePattern: RegExp;
	variableNameGroup: number;
	placeholderToken?: string;
}

const NUMBER_PATTERN = /\b\d+(?:\.\d+)?\b/g;
const DEFAULT_PLACEHOLDER_TOKEN = "{}";

export class DynamicContentHelper {
	private readonly placeholderToken: string;
	private readonly variablePattern: RegExp;
	private readonly variableNameGroup: number;

	constructor({
		variablePattern,
		variableNameGroup,
		placeholderToken = DEFAULT_PLACEHOLDER_TOKEN,
	}: DynamicContentConfig) {
		this.placeholderToken = placeholderToken;
		this.variablePattern = cloneRegex(variablePattern);
		this.variableNameGroup = variableNameGroup;
	}

	normalize(text: string): NormalizationResult {
		const matches = this.collectMatches(text);
		if (matches.length === 0) {
			return {
				normalized: text,
				hasVariables: false,
				hasNumbers: false,
				fragments: [],
			};
		}

		const fragments: DynamicFragment[] = matches.map((match) => {
			if (match.type === "variable") {
				return {
					type: "variable" as const,
					raw: match.raw,
					name: match.name,
				};
			}

			return {
				type: "number" as const,
				raw: match.raw,
			};
		});

		const normalizedParts: string[] = [];
		let lastIndex = 0;
		for (const match of matches) {
			normalizedParts.push(text.slice(lastIndex, match.start));
			normalizedParts.push(this.placeholderToken);
			lastIndex = match.end;
		}
		normalizedParts.push(text.slice(lastIndex));

		const hasVariables = fragments.some(
			(fragment) => fragment.type === "variable"
		);
		const hasNumbers = fragments.some(
			(fragment) => fragment.type === "number"
		);

		return {
			normalized: normalizedParts.join(""),
			hasVariables,
			hasNumbers,
			fragments,
		};
	}

	reconstruct(
		translatedBase: string,
		fragments: DynamicFragment[] | undefined,
		resolveVariable: (
			fragment: Extract<DynamicFragment, { type: "variable" }>
		) => string | null
	): string {
		if (!fragments || fragments.length === 0) {
			return translatedBase;
		}

		let result = translatedBase;
		for (const fragment of fragments) {
			let replacement = fragment.raw;
			if (fragment.type === "variable") {
				const resolved = resolveVariable(fragment);
				replacement = resolved ?? fragment.raw;
			}

			result = result.replace(this.placeholderToken, replacement);
		}

		return result;
	}

	collectMatches(text: string): DynamicFragmentMatch[] {
		const matches: DynamicFragmentMatch[] = [];

		this.variablePattern.lastIndex = 0;
		let variableMatch: RegExpExecArray | null;
		while ((variableMatch = this.variablePattern.exec(text)) !== null) {
			const raw = variableMatch[0];

			let captureValue: string | undefined;
			if (
				this.variableNameGroup >= 0 &&
				this.variableNameGroup < variableMatch.length
			) {
				const candidate = variableMatch[this.variableNameGroup];
				if (typeof candidate === "string") {
					captureValue = candidate;
				}
			}

			let name = this.sanitizeVariableName(captureValue);
			if (!name) {
				name = this.sanitizeVariableName(raw);
			}

			matches.push({
				type: "variable",
				raw,
				name,
				start: variableMatch.index,
				end: variableMatch.index + raw.length,
			});
		}

		NUMBER_PATTERN.lastIndex = 0;
		let numberMatch: RegExpExecArray | null;
		while ((numberMatch = NUMBER_PATTERN.exec(text)) !== null) {
			const raw = numberMatch[0];
			matches.push({
				type: "number",
				raw,
				start: numberMatch.index,
				end: numberMatch.index + raw.length,
			});
		}

		matches.sort((a, b) => a.start - b.start);
		return matches;
	}

	private sanitizeVariableName(name: string | undefined): string | undefined {
		if (!name) {
			return undefined;
		}

		const trimmed = name.trim();
		if (trimmed.length === 0) {
			return undefined;
		}

		const normalized = trimmed
			.replace(/\s+/g, "-")
			.replace(/[^a-zA-Z0-9_-]+/g, "-")
			.replace(/-{2,}/g, "-")
			.replace(/^-+|-+$/g, "");

		return normalized.length > 0 ? normalized.toLowerCase() : undefined;
	}

	get placeholder(): string {
		return this.placeholderToken;
	}
}
