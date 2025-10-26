export const TRANSLATING_CLASS = "transmut-translating";
export const STORE_NAME = "translations";

export const DEFAULT_ATTRIBUTE_NAMES = [
	"title",
	"aria-label",
	"aria-description",
	"placeholder",
	"alt",
];

export const DEFAULT_DIRECTION_OVERRIDES: Record<string, "ltr" | "rtl"> = {
	ar: "rtl",
	fa: "rtl",
	he: "rtl",
	ku: "rtl",
	ur: "rtl",
	ps: "rtl",
	ug: "rtl",
	ckb: "rtl",
	arc: "rtl",
	azb: "rtl",
	dv: "rtl",
	sd: "rtl",
	ug_arab: "rtl",
	yi: "rtl",
};

export const DEFAULT_VARIABLE_PATTERN = /\${\s*([^}]+?)\s*}/g;

export const DATA_DIRECTIVE_SKIP_VALUES = new Set([
	"false",
	"off",
	"skip",
	"ignore",
	"no",
	"none",
	"stop",
]);

export const DATA_DIRECTIVE_INCLUDE_VALUES = new Set([
	"",
	"true",
	"on",
	"yes",
	"include",
	"auto",
	"all",
]);

export const BOOLEAN_FALSE_VALUES = new Set([
	"false",
	"off",
	"no",
	"0",
	"none",
	"exclude",
]);
