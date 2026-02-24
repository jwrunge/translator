export const DEFAULT_DYNAMIC_TOKEN_PATTERN = /\$\{\s*[^}]+?\s*\}|\b\d+(?:\.\d+)?\b/g;

export function normalizeTranslationKey(
	value: string,
	pattern: RegExp = DEFAULT_DYNAMIC_TOKEN_PATTERN,
	placeholder = "{}"
): string {
	if (typeof value !== "string" || value.length === 0) {
		return "";
	}

	return value.replace(pattern, placeholder);
}

export function normalizeTranslationEntries(
	entries: Record<string, string>,
	pattern: RegExp = DEFAULT_DYNAMIC_TOKEN_PATTERN,
	placeholder = "{}"
): Record<string, string> {
	const result: Record<string, string> = {};

	for (const [key, value] of Object.entries(entries)) {
		if (typeof key !== "string" || key.trim().length === 0) {
			continue;
		}
		if (typeof value !== "string") {
			continue;
		}

		result[normalizeTranslationKey(key, pattern, placeholder)] = value;
	}

	return result;
}
