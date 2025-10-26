import {
	DEFAULT_ATTRIBUTE_NAMES,
	DEFAULT_DIRECTION_OVERRIDES,
	DEFAULT_VARIABLE_PATTERN,
} from "./constants";
import type {
	ResolvedObserverOptions,
	TranslationObserverOptions,
} from "./types";

export function resolveObserverOptions(
	options?: TranslationObserverOptions
): ResolvedObserverOptions {
	const attributeNames = Array.from(
		new Set(
			(options?.attributeNames ?? DEFAULT_ATTRIBUTE_NAMES)
				.map((name) => name.trim().toLowerCase())
				.filter((name) => name.length > 0)
		)
	);

	const mergedOverrides = {
		...DEFAULT_DIRECTION_OVERRIDES,
		...(options?.directionOverrides ?? {}),
	};

	const directionOverrides: Record<string, "ltr" | "rtl"> = {};
	for (const [key, value] of Object.entries(mergedOverrides)) {
		const normalizedKey = key.trim().toLowerCase();
		if (normalizedKey.length === 0) {
			continue;
		}
		if (value === "ltr" || value === "rtl") {
			directionOverrides[normalizedKey] = value;
		}
	}

	const requireExplicitOptIn = options?.requireExplicitOptIn ?? false;

	const variablePatternInput =
		options?.variablePattern ?? DEFAULT_VARIABLE_PATTERN;
	const variablePattern = cloneRegex(variablePatternInput);

	let variableNameGroup = 1;
	if (
		typeof options?.variableNameGroup === "number" &&
		Number.isFinite(options.variableNameGroup)
	) {
		variableNameGroup = Math.floor(options.variableNameGroup);
	}
	if (variableNameGroup < 0) {
		variableNameGroup = 0;
	}

	return {
		requireExplicitOptIn,
		textSelector:
			options?.textSelector ??
			(requireExplicitOptIn ? "[data-transmut]" : null),
		attributeSelector:
			options?.attributeSelector ?? "[data-transmut-attrs]",
		attributeNames,
		skipEditable: options?.skipEditable ?? true,
		setLanguageAttributes: options?.setLanguageAttributes ?? true,
		direction: options?.direction ?? "auto",
		directionOverrides,
		variablePattern,
		variableNameGroup,
	};
}

export function cloneRegex(pattern: RegExp): RegExp {
	const flags = pattern.flags.includes("g")
		? pattern.flags
		: `${pattern.flags}g`;
	return new RegExp(pattern.source, flags);
}
