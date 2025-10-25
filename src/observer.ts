type TranslationMap = Record<string, string>;
type AsyncTransMap = TranslationMap | Promise<TranslationMap>;
type GetTransMapFn = (
	translation: { langCode: string; region?: string },
	from: string[],
	currentUrl?: string
) => AsyncTransMap;

type DirectionSetting = "ltr" | "rtl" | "auto";

interface TranslationObserverOptions {
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

interface ResolvedObserverOptions {
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

interface AttributeState {
	translated: boolean;
	lastValue: string;
	pendingSource?: string;
	normalizedKey?: string;
	fragments?: DynamicFragment[];
}

interface SectionLocaleDirective {
	localeTag?: string;
	direction?: "ltr" | "rtl";
	skipTranslation: boolean;
}

interface NodeState {
	translated: boolean;
	lastText: string;
	pendingSource?: string;
	normalizedKey?: string;
	fragments?: DynamicFragment[];
}

type DynamicFragment =
	| {
			type: "variable";
			raw: string;
			name?: string;
	  }
	| {
			type: "number";
			raw: string;
	  };

type DynamicFragmentMatch =
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

interface CachedEntry {
	value: string;
	updatedAt: number;
}

type InvalidateFn = (currentDate: Date) => Promise<string[]> | string[];
type IndexedDBFactoryExtended = IDBFactory & {
	databases?: () => Promise<Array<{ name?: string | undefined }>>;
};

const TRANSLATING_CLASS = "transmut-translating";
const STORE_NAME = "translations";

const DEFAULT_ATTRIBUTE_NAMES = [
	"title",
	"aria-label",
	"aria-description",
	"placeholder",
	"alt",
];

const DEFAULT_DIRECTION_OVERRIDES: Record<string, "ltr" | "rtl"> = {
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

const DEFAULT_VARIABLE_PATTERN = /\${\s*([^}]+?)\s*}/g;

const DATA_DIRECTIVE_SKIP_VALUES = new Set([
	"false",
	"off",
	"skip",
	"ignore",
	"no",
	"none",
	"stop",
]);

const DATA_DIRECTIVE_INCLUDE_VALUES = new Set([
	"",
	"true",
	"on",
	"yes",
	"include",
	"auto",
	"all",
]);

const BOOLEAN_FALSE_VALUES = new Set([
	"false",
	"off",
	"no",
	"0",
	"none",
	"exclude",
]);

export default class TranslationObserver {
	#mutObserver: MutationObserver;
	#defaultLanguage = "en";
	#defaultRegion = "";
	#langCode: string;
	#region: string;
	#dbPromise: Promise<IDBDatabase | null> | null = null;
	#dbInstance: IDBDatabase | null = null;
	#expiryMs: number | null;
	#initPromise: Promise<void>;

	#transBatch = new Set<string>();
	#nodeStates = new Map<Text, NodeState>();
	#attrStates = new Map<Element, Map<string, AttributeState>>();
	#observedRoots = new Set<Element | ShadowRoot>();
	#options: ResolvedObserverOptions;

	#getTranslations: GetTransMapFn;

	// Regex patterns for normalizing dynamic content
	#numberPattern = /\b\d+(?:\.\d+)?\b/g;
	#placeholderToken = "{}";
	#variablePattern: RegExp;
	#variableNameGroup: number;

	constructor(
		defaultLangCode = "en",
		locale?: string,
		getTranslations?: GetTransMapFn,
		expiryHours?: number,
		invalidateFn?: InvalidateFn,
		options?: TranslationObserverOptions
	) {
		this.#options = this.#resolveOptions(options);
		this.#variablePattern = this.#cloneRegex(this.#options.variablePattern);
		this.#variableNameGroup = this.#options.variableNameGroup;

		/**
		 * Abort if not a DOM environment
		 */
		if (typeof MutationObserver === "undefined") {
			throw new Error(
				"MutationObserver is not available in this environment."
			);
		}

		const rootNode = document?.body;

		if (!rootNode) {
			throw new Error("Unable to determine a root node to observe.");
		}

		this.#observedRoots.add(rootNode);

		if (!navigator?.language) {
			throw new Error("Unable to access navigator language settings.");
		}

		if (!getTranslations) {
			throw new Error("A getTranslations function must be provided.");
		}

		/**
		 * Set langCode and region from locale and initialize
		 */
		if (locale) {
			const [lang, region] = locale.toLowerCase().split("-");
			this.#langCode = lang;
			this.#region = region ?? "";
		} else {
			[this.#langCode, this.#region] = navigator.language
				.toLowerCase()
				.split("-");
		}

		const [defaultLang, defaultRegion] = defaultLangCode
			.toLocaleLowerCase()
			.split("-");
		this.#defaultLanguage = defaultLang;
		this.#defaultRegion = defaultRegion ?? "";
		this.#langCode = defaultLang;
		this.#region = defaultRegion ?? "";
		this.#initPromise = this.#runInitialInvalidation(invalidateFn);

		// Add translation class
		rootNode.classList.add(TRANSLATING_CLASS);
		this.changeLocale().then(() =>
			rootNode.classList.remove(TRANSLATING_CLASS)
		);

		/**
		 * Set translation functions and langcodes
		 */
		this.#getTranslations = getTranslations;
		this.#expiryMs =
			typeof expiryHours === "number" && expiryHours > 0
				? expiryHours * 60 * 60 * 1000
				: null;

		/**
		 * Observe DOM mutations that may require translation updates
		 */
		this.#mutObserver = new MutationObserver((mutations) => {
			this.#transBatch.clear();

			for (const mutation of mutations) {
				if (mutation.type === "characterData") {
					this.#handlePotentialText(mutation.target);
					continue;
				}

				if (mutation.type === "childList") {
					for (const added of mutation.addedNodes) {
						this.#handlePotentialText(added);
						this.#handlePotentialAttributes(added);
					}

					for (const removed of mutation.removedNodes) {
						this.#cleanupNode(removed);
					}
					continue;
				}

				if (mutation.type === "attributes") {
					const target = mutation.target;
					if (target instanceof Element) {
						this.#handleAttributeMutation(
							target,
							mutation.attributeName ?? null
						);
					}
				}
			}

			const batch = Array.from(this.#transBatch);
			this.#transBatch.clear();
			if (batch.length > 0) {
				void this.#translate(batch);
			}
		});

		this.#observeRoot(rootNode);
		this.#handlePotentialText(rootNode);
		this.#handlePotentialAttributes(rootNode);
		const initialBatch = Array.from(this.#transBatch);
		this.#transBatch.clear();
		if (initialBatch.length > 0) {
			void this.#translate(initialBatch);
		}
	}

	async changeLocale(langCode = ``, region = ``) {
		await this.#initPromise;

		const nextLang = langCode || this.#defaultLanguage;
		const nextRegion = region || this.#defaultRegion;
		const nextDbName = this.#composeDbName(nextLang, nextRegion);
		const db = this.#dbInstance;
		if (db && db.name !== nextDbName) {
			db.close();
		}

		this.#dbInstance = null;
		this.#dbPromise = null;
		this.#langCode = nextLang;
		this.#region = nextRegion;

		if (this.#options.setLanguageAttributes) {
			this.#applyLanguageMetadata();
		}
	}

	observeShadowRoot(root: ShadowRoot): void {
		if (!(root instanceof ShadowRoot)) {
			return;
		}

		if (!this.#observedRoots.has(root)) {
			this.#observedRoots.add(root);
		}

		this.#observeRoot(root);

		if (this.#options.setLanguageAttributes) {
			this.#applyLanguageMetadata();
		}

		this.#handlePotentialText(root);
		this.#handlePotentialAttributes(root);
	}

	#observeRoot(root: Element | ShadowRoot): void {
		if (!this.#observedRoots.has(root)) {
			this.#observedRoots.add(root);
		}

		this.#mutObserver.observe(root, {
			subtree: true,
			characterData: true,
			childList: true,
			attributes: true,
		});
	}

	#applyLanguageMetadata(): void {
		if (typeof document === "undefined") {
			return;
		}

		const localeTag = this.#getCurrentLocaleTag();
		const direction = this.#resolveDirection(this.#langCode);

		const documentElement = document.documentElement;
		if (documentElement) {
			documentElement.setAttribute("lang", localeTag);
			documentElement.setAttribute("dir", direction);
			documentElement.setAttribute("data-transmut-lang", localeTag);
			documentElement.setAttribute("data-transmut-dir", direction);
		}

		for (const root of this.#observedRoots) {
			const target =
				root instanceof ShadowRoot
					? root.host instanceof Element
						? root.host
						: null
					: root;

			if (!target) {
				continue;
			}

			target.setAttribute("lang", localeTag);
			target.setAttribute("data-transmut-lang", localeTag);
			target.setAttribute("dir", direction);
			target.setAttribute("data-transmut-dir", direction);
		}
	}

	#getCurrentLocaleTag(): string {
		return this.#composeLocaleTag(this.#langCode, this.#region);
	}

	#composeLocaleTag(lang: string, region: string): string {
		const trimmedLang = (lang ?? "").toLowerCase();
		const trimmedRegion = (region ?? "").toUpperCase();
		return trimmedRegion ? `${trimmedLang}-${trimmedRegion}` : trimmedLang;
	}

	#resolveDirection(lang: string): DirectionSetting {
		if (this.#options.direction !== "auto") {
			return this.#options.direction;
		}

		const normalized = (lang ?? "").toLowerCase();
		const base = normalized.split(/[-_]/)[0] ?? normalized;
		const override =
			this.#options.directionOverrides[normalized] ??
			this.#options.directionOverrides[base];

		if (override) {
			return override;
		}

		const defaultOverride =
			DEFAULT_DIRECTION_OVERRIDES[normalized] ??
			DEFAULT_DIRECTION_OVERRIDES[base];

		return defaultOverride ?? "ltr";
	}

	#directionForLocale(locale?: string): "ltr" | "rtl" | undefined {
		if (!locale) {
			return undefined;
		}

		const normalized = locale.toLowerCase();
		const base = normalized.split(/[-_]/)[0] ?? normalized;
		const override =
			this.#options.directionOverrides[normalized] ??
			this.#options.directionOverrides[base];

		if (override) {
			return override;
		}

		return (
			DEFAULT_DIRECTION_OVERRIDES[normalized] ??
			DEFAULT_DIRECTION_OVERRIDES[base]
		);
	}

	#formatLocaleTag(value: string): string {
		const normalized = value.trim().replace(/_/g, "-");
		if (normalized.length === 0) {
			return normalized;
		}

		const segments = normalized.split("-");
		const [lang, ...rest] = segments;
		const formattedLang = (lang ?? "").toLowerCase();
		const formattedRest = rest.map((segment, index) =>
			index === 0 ? segment.toUpperCase() : segment
		);
		const remainder = formattedRest.filter(Boolean).join("-");
		return remainder ? `${formattedLang}-${remainder}` : formattedLang;
	}

	#readDirectionOverride(element: Element): "ltr" | "rtl" | undefined {
		const rawDir =
			element.getAttribute("data-transmut-dir") ??
			element.getAttribute("dir");
		if (!rawDir) {
			return undefined;
		}

		const normalized = rawDir.trim().toLowerCase();
		return normalized === "ltr" || normalized === "rtl"
			? (normalized as "ltr" | "rtl")
			: undefined;
	}

	#normalizeLocaleDirective(
		value: string | null
	): SectionLocaleDirective | null {
		if (value === null) {
			return { skipTranslation: false };
		}

		const trimmed = value.trim();
		if (trimmed.length === 0) {
			return { skipTranslation: false };
		}

		const lower = trimmed.toLowerCase();
		if (lower === "inherit" || lower === "auto" || lower === "target") {
			return { skipTranslation: false };
		}

		if (
			lower === "skip" ||
			lower === "source" ||
			lower === "original" ||
			lower === "none"
		) {
			return { skipTranslation: true };
		}

		const localeTag = this.#formatLocaleTag(trimmed);
		const skipTranslation =
			localeTag.toLowerCase() !==
			this.#getCurrentLocaleTag().toLowerCase();
		return {
			localeTag,
			skipTranslation,
		};
	}

	#applyLocaleAttributes(
		element: Element,
		directive: SectionLocaleDirective
	): void {
		if (!this.#options.setLanguageAttributes) {
			return;
		}

		if (directive.localeTag) {
			element.setAttribute("lang", directive.localeTag);
			element.setAttribute("data-transmut-lang", directive.localeTag);
		}

		const direction =
			directive.direction ??
			this.#directionForLocale(directive.localeTag);
		if (direction) {
			element.setAttribute("dir", direction);
			element.setAttribute("data-transmut-dir", direction);
		}
	}

	#applyLocaleAttributesToElement(element: Element): void {
		const directive = this.#compileLocaleDirective(element);
		if (!directive) {
			return;
		}

		this.#applyLocaleAttributes(element, directive);
	}

	#compileLocaleDirective(element: Element): SectionLocaleDirective | null {
		const currentLocale = this.#getCurrentLocaleTag();

		if (element.hasAttribute("data-transmut-locale")) {
			const directive = this.#normalizeLocaleDirective(
				element.getAttribute("data-transmut-locale")
			);
			if (!directive) {
				return null;
			}

			const directionOverride = this.#readDirectionOverride(element);
			if (directionOverride) {
				directive.direction = directionOverride;
			} else if (directive.localeTag) {
				directive.direction = this.#directionForLocale(
					directive.localeTag
				);
			}

			return directive;
		}

		if (element.hasAttribute("lang")) {
			const langAttr = element.getAttribute("lang");
			if (!langAttr) {
				return null;
			}

			const localeTag = this.#formatLocaleTag(langAttr);
			if (localeTag.length === 0) {
				return null;
			}

			const skipTranslation =
				localeTag.toLowerCase() !== currentLocale.toLowerCase();
			const directionOverride = this.#readDirectionOverride(element);
			return {
				localeTag,
				direction:
					directionOverride ?? this.#directionForLocale(localeTag),
				skipTranslation,
			};
		}

		if (element.hasAttribute("data-transmut-dir")) {
			const directionOverride = this.#readDirectionOverride(element);
			if (directionOverride) {
				return {
					direction: directionOverride,
					skipTranslation: false,
				};
			}
		}

		return null;
	}

	#handlePotentialAttributes = (node: Node): void => {
		if (node.nodeType !== Node.ELEMENT_NODE) {
			return;
		}

		const element = node as Element;
		this.#queueAttributesForElement(element);

		for (const child of Array.from(element.childNodes)) {
			this.#handlePotentialAttributes(child);
		}
	};

	#queueAttributesForElement(element: Element): void {
		const targetAttributes = this.#resolveAttributeTargets(element);

		if (targetAttributes.length === 0) {
			this.#attrStates.delete(element);
			return;
		}

		const attrMap =
			this.#attrStates.get(element) ?? new Map<string, AttributeState>();
		const normalizedTargets = new Set(
			targetAttributes.map((name) => name.toLowerCase())
		);

		for (const existing of Array.from(attrMap.keys())) {
			if (!normalizedTargets.has(existing.toLowerCase())) {
				attrMap.delete(existing);
			}
		}

		for (const attributeName of targetAttributes) {
			this.#queueAttributeTranslation(element, attributeName, attrMap);
		}

		if (attrMap.size > 0) {
			this.#attrStates.set(element, attrMap);
		} else {
			this.#attrStates.delete(element);
		}
	}

	#resolveAttributeTargets(element: Element): string[] {
		const directive = this.#findTransmutDirective(element);
		if (directive === "skip" || this.#hasSkipAttribute(element)) {
			return [];
		}

		const override = this.#getSectionLocaleInfo(element);
		if (override?.skipTranslation) {
			return [];
		}

		const explicitList = this.#parseAttributeList(
			element.getAttribute("data-transmut-attrs")
		);
		const attrNames = new Set<string>();

		for (const attr of explicitList) {
			attrNames.add(attr);
		}

		const hasExplicitAttribute = element.hasAttribute(
			"data-transmut-attrs"
		);
		const matchesSelector = this.#matchesAttributeSelector(element);

		if (
			matchesSelector ||
			directive === "include" ||
			(hasExplicitAttribute && explicitList.length === 0)
		) {
			for (const defaultName of this.#options.attributeNames) {
				if (element.hasAttribute(defaultName)) {
					attrNames.add(defaultName);
				}
			}
		}

		if (this.#options.requireExplicitOptIn && attrNames.size === 0) {
			return [];
		}

		return Array.from(attrNames).filter((name) =>
			element.hasAttribute(name)
		);
	}

	#parseAttributeList(value: string | null): string[] {
		if (!value) {
			return [];
		}

		return value
			.split(",")
			.map((attr) => attr.trim().toLowerCase())
			.filter((attr) => attr.length > 0);
	}

	#matchesAttributeSelector(element: Element): boolean {
		const selector = this.#options.attributeSelector;
		if (!selector) {
			return false;
		}

		try {
			return element.matches(selector);
		} catch (_error) {
			return false;
		}
	}

	#handleAttributeMutation(
		element: Element,
		attributeName: string | null
	): void {
		if (!attributeName) {
			return;
		}

		const normalizedAttribute = attributeName.toLowerCase();

		if (
			normalizedAttribute === "data-transmut" ||
			normalizedAttribute === "data-transmut-attrs" ||
			normalizedAttribute === "data-transmut-skip"
		) {
			if (
				normalizedAttribute === "data-transmut-skip" &&
				this.#hasSkipAttribute(element)
			) {
				this.#cleanupNode(element);
			}
			this.#queueAttributesForElement(element);
			this.#handlePotentialText(element);
			this.#handlePotentialAttributes(element);
			return;
		}

		if (
			normalizedAttribute === "data-transmut-locale" ||
			normalizedAttribute === "data-transmut-dir" ||
			normalizedAttribute === "lang" ||
			normalizedAttribute === "dir"
		) {
			this.#applyLocaleAttributesToElement(element);
			this.#queueAttributesForElement(element);
			for (const child of Array.from(element.childNodes)) {
				this.#handlePotentialText(child);
			}
			return;
		}

		this.#queueAttributesForElement(element);
	}

	#queueAttributeTranslation(
		element: Element,
		attributeName: string,
		attrMap: Map<string, AttributeState>
	): void {
		const currentValue = element.getAttribute(attributeName);
		if (currentValue === null || currentValue.length === 0) {
			attrMap.delete(attributeName);
			if (attrMap.size === 0) {
				this.#attrStates.delete(element);
			}
			return;
		}

		const existing = attrMap.get(attributeName);
		if (existing?.translated && existing.lastValue === currentValue) {
			return;
		}

		const { normalized, hasVariables, hasNumbers, fragments } =
			this.#normalizeText(currentValue);
		const translationKey =
			hasVariables || hasNumbers ? normalized : currentValue;

		this.#transBatch.add(translationKey);
		attrMap.set(attributeName, {
			translated: false,
			lastValue: currentValue,
			pendingSource: translationKey,
			normalizedKey: hasVariables || hasNumbers ? normalized : undefined,
			fragments: fragments.length > 0 ? fragments : undefined,
		});
	}

	#getSectionLocaleInfo(element: Element): SectionLocaleDirective | null {
		let current: Element | null = element;
		while (current) {
			const directive = this.#compileLocaleDirective(current);
			if (directive) {
				this.#applyLocaleAttributes(current, directive);
				if (directive.skipTranslation) {
					return directive;
				}
			}
			current = current.parentElement;
		}

		return null;
	}

	#shouldProcessTextNode(textNode: Text): boolean {
		const container = this.#getTextContainer(textNode);
		if (!container) {
			return !this.#options.requireExplicitOptIn;
		}

		if (this.#options.skipEditable && this.#isEditable(container)) {
			return false;
		}

		if (this.#isProhibitedContainer(container)) {
			return false;
		}

		const directive = this.#findTransmutDirective(container);
		if (directive === "skip") {
			return false;
		}

		const override = this.#getSectionLocaleInfo(container);
		if (override?.skipTranslation) {
			return false;
		}

		if (this.#options.requireExplicitOptIn) {
			return (
				this.#matchesTextSelector(container) || directive === "include"
			);
		}

		if (this.#matchesTextSelector(container)) {
			return true;
		}

		if (directive === "include") {
			return true;
		}

		return true;
	}

	#getTextContainer(textNode: Text): Element | null {
		const parentElement = textNode.parentElement;
		if (parentElement) {
			return parentElement;
		}

		const parentNode = textNode.parentNode;
		if (parentNode instanceof ShadowRoot) {
			return parentNode.host instanceof Element ? parentNode.host : null;
		}

		return null;
	}

	#isEditable(element: Element): boolean {
		if (!(element instanceof HTMLElement)) {
			return false;
		}

		if (element.isContentEditable) {
			return true;
		}

		switch (element.tagName) {
			case "INPUT":
			case "TEXTAREA":
			case "SELECT":
				return true;
			default:
				return false;
		}
	}

	#isProhibitedContainer(element: Element): boolean {
		const tag = element.tagName;
		return tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT";
	}

	#findTransmutDirective(element: Element): "include" | "skip" | null {
		let current: Element | null = element;
		while (current) {
			if (this.#hasSkipAttribute(current)) {
				return "skip";
			}

			if (current.hasAttribute("data-transmut")) {
				const directive = this.#parseTransmutDirective(
					current.getAttribute("data-transmut")
				);
				if (directive !== "inherit") {
					return directive;
				}
			}
			current = current.parentElement;
		}

		return null;
	}

	#hasSkipAttribute(element: Element): boolean {
		const attr = element.getAttribute("data-transmut-skip");
		if (attr === null) {
			return false;
		}

		const normalized = attr.trim().toLowerCase();
		if (normalized.length === 0) {
			return true;
		}

		return !BOOLEAN_FALSE_VALUES.has(normalized);
	}

	#parseTransmutDirective(
		value: string | null
	): "include" | "skip" | "inherit" {
		if (value === null) {
			return "include";
		}

		const normalized = value.trim().toLowerCase();
		if (DATA_DIRECTIVE_SKIP_VALUES.has(normalized)) {
			return "skip";
		}

		if (normalized === "inherit") {
			return "inherit";
		}

		if (DATA_DIRECTIVE_INCLUDE_VALUES.has(normalized)) {
			return "include";
		}

		return "include";
	}

	#matchesTextSelector(element: Element): boolean {
		const selector = this.#options.textSelector;
		if (!selector) {
			return false;
		}

		try {
			return Boolean(element.closest(selector));
		} catch (_error) {
			return false;
		}
	}

	#resolveOptions(
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
		const variablePattern = this.#cloneRegex(variablePatternInput);

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

	#cloneRegex(pattern: RegExp): RegExp {
		const flags = pattern.flags.includes("g")
			? pattern.flags
			: `${pattern.flags}g`;
		return new RegExp(pattern.source, flags);
	}

	/**
	 * Normalizes text content by replacing numbers and template variables with placeholders
	 * This allows the same base translation to be reused for dynamic content
	 */
	#normalizeText = (
		text: string
	): {
		normalized: string;
		hasVariables: boolean;
		hasNumbers: boolean;
		fragments: DynamicFragment[];
	} => {
		const matches = this.#collectDynamicMatches(text);
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
			normalizedParts.push(this.#placeholderToken);
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
	};

	#collectDynamicMatches(text: string): DynamicFragmentMatch[] {
		const matches: DynamicFragmentMatch[] = [];

		this.#variablePattern.lastIndex = 0;
		let variableMatch: RegExpExecArray | null;
		while ((variableMatch = this.#variablePattern.exec(text)) !== null) {
			const raw = variableMatch[0];
			let captureValue: string | undefined;
			if (
				this.#variableNameGroup >= 0 &&
				this.#variableNameGroup < variableMatch.length
			) {
				const candidate = variableMatch[this.#variableNameGroup];
				if (typeof candidate === "string") {
					captureValue = candidate;
				}
			}
			let name = this.#sanitizeVariableName(captureValue);
			if (!name) {
				name = this.#sanitizeVariableName(raw);
			}
			matches.push({
				type: "variable",
				raw,
				name,
				start: variableMatch.index,
				end: variableMatch.index + raw.length,
			});
		}

		this.#numberPattern.lastIndex = 0;
		let numberMatch: RegExpExecArray | null;
		while ((numberMatch = this.#numberPattern.exec(text)) !== null) {
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

	#sanitizeVariableName(name: string | undefined): string | undefined {
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

	/**
	 * Reconstructs translated text by replacing placeholders with original dynamic values
	 */
	#reconstructText = (
		translatedBase: string,
		fragments: DynamicFragment[] | undefined,
		container: Element | null
	): string => {
		if (!fragments || fragments.length === 0) {
			return translatedBase;
		}

		let result = translatedBase;
		for (const fragment of fragments) {
			let replacement = fragment.raw;
			if (fragment.type === "variable") {
				const resolved = this.#resolveVariableValue(
					container,
					fragment
				);
				replacement = resolved ?? fragment.raw;
			}
			result = result.replace(this.#placeholderToken, replacement);
		}

		return result;
	};

	#resolveVariableValue(
		container: Element | null,
		fragment: Extract<DynamicFragment, { type: "variable" }>
	): string | null {
		if (!container) {
			return null;
		}

		const name = fragment.name;
		if (!name) {
			return null;
		}

		const attributeName = this.#buildVariableAttributeName(name);
		let current: Element | null = container;
		const visited = new Set<Element>();

		while (current && !visited.has(current)) {
			visited.add(current);
			const value = this.#getAttributeCaseInsensitive(
				current,
				attributeName
			);
			if (value !== null) {
				return value;
			}

			const parentElement: Element | null = current.parentElement;
			if (parentElement) {
				current = parentElement;
				continue;
			}

			const parentNode: Node | null = current.parentNode;
			if (parentNode instanceof ShadowRoot) {
				current =
					parentNode.host instanceof Element ? parentNode.host : null;
			} else {
				current = null;
			}
		}

		return null;
	}

	#buildVariableAttributeName(name: string): string {
		return `data-transmut-${name}`;
	}

	#getAttributeCaseInsensitive(
		element: Element,
		name: string
	): string | null {
		const target = name.toLowerCase();
		for (const attr of Array.from(element.attributes)) {
			if (attr.name.toLowerCase() === target) {
				return attr.value;
			}
		}

		return null;
	}

	#handlePotentialText = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			const textNode = node as Text;
			const content = textNode.textContent ?? ``;
			if (!this.#shouldProcessTextNode(textNode)) {
				this.#nodeStates.delete(textNode);
				return;
			}

			if (content.trim().length === 0) {
				this.#nodeStates.delete(textNode);
				return;
			}
			const existing = this.#nodeStates.get(textNode);

			if (existing?.translated && existing.lastText === content) {
				return; // Skip nodes we just translated.
			}

			if (content.length === 0) {
				return;
			}

			// Normalize the text to handle dynamic content
			const { normalized, hasVariables, hasNumbers, fragments } =
				this.#normalizeText(content);

			// Use normalized text as the translation key if it has dynamic content
			const translationKey =
				hasVariables || hasNumbers ? normalized : content;

			this.#transBatch.add(translationKey);
			this.#nodeStates.set(textNode, {
				translated: false,
				lastText: content,
				pendingSource: translationKey,
				normalizedKey:
					hasVariables || hasNumbers ? normalized : undefined,
				fragments: fragments.length > 0 ? fragments : undefined,
			});
			return;
		}

		for (const child of node.childNodes) {
			this.#handlePotentialText(child);
		}
	};

	#translate = async (batch: string[]): Promise<void> => {
		if (batch.length === 0) {
			return;
		}

		await this.#initPromise;

		const cachedEntries = await this.#getCachedTranslations(batch);
		const resolved: TranslationMap = {};
		const missingKeys: string[] = [];
		const staleKeys: string[] = [];
		const now = Date.now();
		const expiryMs = this.#expiryMs;

		for (const key of batch) {
			const entry = cachedEntries[key];
			if (!entry) {
				missingKeys.push(key);
				continue;
			}

			resolved[key] = entry.value;
			if (
				expiryMs !== null &&
				expiryMs >= 0 &&
				now - entry.updatedAt >= expiryMs
			) {
				staleKeys.push(key);
			}
		}

		const isOffline =
			typeof navigator !== "undefined"
				? navigator.onLine === false
				: false;
		const keysNeedingFetch = isOffline
			? []
			: Array.from(new Set([...missingKeys, ...staleKeys]));
		let fetched: TranslationMap = {};

		if (keysNeedingFetch.length > 0) {
			try {
				const fetchedRaw = await this.#getTranslations(
					{ langCode: this.#langCode, region: this.#region },
					keysNeedingFetch,
					window.location.href
				);

				if (typeof fetchedRaw === "string") {
					try {
						fetched = JSON.parse(fetchedRaw) as TranslationMap;
					} catch (error) {
						console.error(
							"Failed to parse translation payload",
							error
						);
						fetched = {};
					}
				} else {
					fetched = fetchedRaw ?? {};
				}
			} catch (error) {
				console.error("transmut: fetching translations failed", error);
				fetched = {};
			}

			if (Object.keys(fetched).length > 0) {
				await this.#persistTranslations(fetched);
				Object.assign(resolved, fetched);
			}
		}

		const requested = new Set(batch);

		for (const [node, state] of this.#nodeStates.entries()) {
			if (!state.pendingSource || !requested.has(state.pendingSource)) {
				continue;
			}

			const currentText = node.textContent ?? ``;
			if (currentText !== state.lastText) {
				// Text changed again before we could apply the translation; leave for the next cycle.
				state.translated = false;
				state.lastText = currentText;
				state.pendingSource = undefined;
				state.normalizedKey = undefined;
				state.fragments = undefined;
				this.#nodeStates.set(node, state);
				continue;
			}

			const translatedBase = resolved[state.pendingSource];
			if (translatedBase && translatedBase !== currentText) {
				// If this was normalized text with dynamic content, reconstruct it
				const container = this.#getTextContainer(node);
				const finalTranslation = state.normalizedKey
					? this.#reconstructText(
							translatedBase,
							state.fragments,
							container
					  )
					: translatedBase;

				node.textContent = finalTranslation;
				state.translated = true;
				state.lastText = finalTranslation;
				state.pendingSource = undefined;
				state.normalizedKey = undefined;
				state.fragments = undefined;
				this.#nodeStates.set(node, state);
			} else {
				state.translated = true;
				state.lastText = currentText;
				state.pendingSource = undefined;
				state.normalizedKey = undefined;
				state.fragments = undefined;
				this.#nodeStates.set(node, state);
			}
		}

		for (const [element, attrMap] of this.#attrStates.entries()) {
			for (const [attributeName, attrState] of attrMap.entries()) {
				if (
					!attrState.pendingSource ||
					!requested.has(attrState.pendingSource)
				) {
					continue;
				}

				const currentValue = element.getAttribute(attributeName) ?? ``;
				if (currentValue !== attrState.lastValue) {
					attrState.translated = false;
					attrState.lastValue = currentValue;
					attrState.pendingSource = undefined;
					attrState.normalizedKey = undefined;
					attrState.fragments = undefined;
					attrMap.set(attributeName, attrState);
					continue;
				}

				const translatedBase = resolved[attrState.pendingSource];
				if (translatedBase && translatedBase !== currentValue) {
					const finalValue = attrState.normalizedKey
						? this.#reconstructText(
								translatedBase,
								attrState.fragments,
								element
						  )
						: translatedBase;

					element.setAttribute(attributeName, finalValue);
					attrState.translated = true;
					attrState.lastValue = finalValue;
					attrState.pendingSource = undefined;
					attrState.normalizedKey = undefined;
					attrState.fragments = undefined;
					attrMap.set(attributeName, attrState);
				} else {
					attrState.translated = true;
					attrState.lastValue = currentValue;
					attrState.pendingSource = undefined;
					attrState.normalizedKey = undefined;
					attrState.fragments = undefined;
					attrMap.set(attributeName, attrState);
				}
			}
		}
	};

	#cleanupNode = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			this.#nodeStates.delete(node as Text);
			return;
		}

		if (node.nodeType === Node.ELEMENT_NODE) {
			this.#attrStates.delete(node as Element);
		}

		for (const child of node.childNodes) {
			this.#cleanupNode(child);
		}
	};

	#composeDbName(lang: string, region: string): string {
		const regionPart = region ? region : "default";
		return `transmut.${lang}.${regionPart}`;
	}

	async #runInitialInvalidation(invalidateFn?: InvalidateFn): Promise<void> {
		if (!invalidateFn) {
			return;
		}

		if (typeof indexedDB === "undefined") {
			return;
		}

		try {
			const maybeKeys = await invalidateFn(new Date());
			const keys = Array.isArray(maybeKeys)
				? Array.from(
						new Set(
							maybeKeys.filter(
								(key): key is string =>
									typeof key === "string" && key.length > 0
							)
						)
				  )
				: [];

			if (keys.length === 0) {
				return;
			}

			const dbNames = await this.#collectTranslationDbNames();
			await Promise.all(
				dbNames.map((name) => this.#deleteKeysFromDb(name, keys))
			);
		} catch (error) {
			console.error("transmut: invalidate callback failed", error);
		}
	}

	async #collectTranslationDbNames(): Promise<string[]> {
		if (typeof indexedDB === "undefined") {
			return [];
		}

		const factory = indexedDB as IndexedDBFactoryExtended;
		const names = new Set<string>();

		if (typeof factory.databases === "function") {
			try {
				const databases = await factory.databases();
				for (const info of databases) {
					const name = info?.name;
					if (name && name.startsWith("transmut.")) {
						names.add(name);
					}
				}
			} catch (error) {
				console.warn(
					"transmut: unable to enumerate IndexedDB databases",
					error
				);
			}
		}

		names.add(this.#composeDbName(this.#langCode, this.#region));
		names.add(
			this.#composeDbName(this.#defaultLanguage, this.#defaultRegion)
		);

		return Array.from(names).filter((name) => name.length > 0);
	}

	async #deleteKeysFromDb(dbName: string, keys: string[]): Promise<void> {
		if (keys.length === 0) {
			return;
		}

		await new Promise<void>((resolve) => {
			const request = indexedDB.open(dbName, 1);

			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME);
				}
			};

			request.onerror = () => resolve();

			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction(STORE_NAME, "readwrite");
				const store = tx.objectStore(STORE_NAME);

				for (const key of keys) {
					store.delete(key);
				}

				tx.oncomplete = () => {
					db.close();
					resolve();
				};

				tx.onabort = () => {
					db.close();
					resolve();
				};

				tx.onerror = () => {
					db.close();
					resolve();
				};
			};
		});
	}

	async #getDb(): Promise<IDBDatabase | null> {
		if (typeof indexedDB === "undefined") {
			return null;
		}

		if (this.#dbInstance) {
			return this.#dbInstance;
		}

		if (this.#dbPromise) {
			return this.#dbPromise;
		}

		const dbName = this.#composeDbName(this.#langCode, this.#region);
		this.#dbPromise = new Promise<IDBDatabase | null>((resolve, reject) => {
			const request = indexedDB.open(dbName, 1);

			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME);
				}
			};

			request.onsuccess = () => {
				const db = request.result;
				db.onversionchange = () => {
					db.close();
					if (this.#dbInstance === db) {
						this.#dbInstance = null;
					}
				};
				this.#dbInstance = db;
				resolve(db);
			};

			request.onerror = () => {
				this.#dbPromise = null;
				reject(request.error ?? new Error("Failed to open IndexedDB"));
			};

			request.onblocked = () => {
				console.warn(
					`transmut: database ${dbName} upgrade blocked. Close other tabs to continue.`
				);
			};
		});

		try {
			return await this.#dbPromise;
		} catch (error) {
			console.error("transmut: unable to open IndexedDB", error);
			return null;
		} finally {
			this.#dbPromise = null;
		}
	}

	async #getCachedTranslations(
		keys: string[]
	): Promise<Record<string, CachedEntry>> {
		const db = await this.#getDb();
		if (!db || keys.length === 0) {
			return {};
		}

		const tx = db.transaction(STORE_NAME, "readonly");
		const store = tx.objectStore(STORE_NAME);
		const result: Record<string, CachedEntry> = {};

		await Promise.all(
			keys.map(
				(key) =>
					new Promise<void>((resolve) => {
						const request = store.get(key);
						request.onsuccess = () => {
							const raw = request.result;
							if (typeof raw === "string") {
								result[key] = { value: raw, updatedAt: 0 };
							} else if (
								raw &&
								typeof raw === "object" &&
								typeof (raw as CachedEntry).value === "string"
							) {
								const entry = raw as CachedEntry;
								result[key] = {
									value: entry.value,
									updatedAt:
										typeof entry.updatedAt === "number"
											? entry.updatedAt
											: 0,
								};
							}
							resolve();
						};
						request.onerror = () => resolve();
					})
			)
		);

		return result;
	}

	async #persistTranslations(map: TranslationMap): Promise<void> {
		const entries = Object.entries(map).filter(
			([, value]) => typeof value === "string" && value.length > 0
		);
		if (entries.length === 0) {
			return;
		}

		const db = await this.#getDb();
		if (!db) {
			return;
		}

		const tx = db.transaction(STORE_NAME, "readwrite");
		const store = tx.objectStore(STORE_NAME);

		const completion = new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onabort = () =>
				reject(tx.error ?? new Error("Transaction aborted"));
			tx.onerror = () =>
				reject(tx.error ?? new Error("Transaction failed"));
		});

		await Promise.all(
			entries.map(
				([key, value]) =>
					new Promise<void>((resolve, reject) => {
						const request = store.put(
							{
								value,
								updatedAt: Date.now(),
							},
							key
						);

						request.onsuccess = () => resolve();
						request.onerror = () => reject(request.error);
					})
			)
		);

		await completion.catch((error: unknown) => {
			console.error("transmut: failed to commit translations", error);
		});
	}
}
