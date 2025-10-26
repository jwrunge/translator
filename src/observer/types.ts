export type TranslationMap = Record<string, string>;
export type AsyncTransMap = TranslationMap | Promise<TranslationMap>;
export type GetTransMapFn = (
	translation: { langCode: string; region?: string },
	from: string[],
	currentUrl?: string
) => AsyncTransMap;

export type DirectionSetting = "ltr" | "rtl" | "auto";

export interface TranslationObserverOptions {
	requireExplicitOptIn?: boolean;
	textSelector?: string | null;
	attributeSelector?: string | null;
	attributeNames?: string[];
	skipEditable?: boolean;
	setLanguageAttributes?: boolean;
	direction?: DirectionSetting;
	directionOverrides?: Record<string, "ltr" | "rtl">;
	variablePattern?: RegExp;
	variableNameGroup?: number;
}

export interface ResolvedObserverOptions {
	requireExplicitOptIn: boolean;
	textSelector: string | null;
	attributeSelector: string | null;
	attributeNames: string[];
	skipEditable: boolean;
	setLanguageAttributes: boolean;
	direction: DirectionSetting;
	directionOverrides: Record<string, "ltr" | "rtl">;
	variablePattern: RegExp;
	variableNameGroup: number;
}

export interface AttributeState {
	translated: boolean;
	lastValue: string;
	pendingSource?: string;
	normalizedKey?: string;
	fragments?: DynamicFragment[];
}

export interface SectionLocaleDirective {
	localeTag?: string;
	direction?: "ltr" | "rtl";
	skipTranslation: boolean;
}

export interface NodeState {
	translated: boolean;
	lastText: string;
	pendingSource?: string;
	normalizedKey?: string;
	fragments?: DynamicFragment[];
}

export type DynamicFragment =
	| {
			type: "variable";
			raw: string;
			name?: string;
	  }
	| {
			type: "number";
			raw: string;
	  };

export type DynamicFragmentMatch =
	| {
			type: "variable";
			raw: string;
			name?: string;
			start: number;
			end: number;
	  }
	| {
			type: "number";
			raw: string;
			start: number;
			end: number;
	  };

export interface CachedEntry {
	value: string;
	updatedAt: number;
}

export type InvalidateFn = (currentDate: Date) => Promise<string[]> | string[];
export type IndexedDBFactoryExtended = IDBFactory & {
	databases?: () => Promise<Array<{ name?: string | undefined }>>;
};
