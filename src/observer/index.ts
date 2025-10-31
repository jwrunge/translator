import {
	BOOLEAN_FALSE_VALUES,
	DATA_DIRECTIVE_INCLUDE_VALUES,
	DATA_DIRECTIVE_SKIP_VALUES,
	DEFAULT_DIRECTION_OVERRIDES,
	TRANSLATING_CLASS,
} from "./constants";
import type {
	AttributeState,
	DirectionSetting,
	DynamicFragment,
	GetTransMapFn,
	InvalidateFn,
	NodeState,
	ResolvedObserverOptions,
	SectionLocaleDirective,
	TranslationMap,
	TranslationObserverOptions,
} from "./types";
import { resolveObserverOptions } from "./options";
import { DynamicContentHelper } from "./dynamic-content";
import { TranslationCache } from "./cache";

export default class TranslationObserver {
	#mutObserver: MutationObserver;
	#defaultLanguage = "en";
	#defaultRegion = "";
	#langCode: string;
	#region: string;
	#expiryMs: number | null;
	#initPromise: Promise<void>;

	#transBatch = new Set<string>();
	#nodeStates = new Map<Text, NodeState>();
	#attrStates = new Map<Element, Map<string, AttributeState>>();
	#observedRoots = new Set<Element | ShadowRoot>();
	#options: ResolvedObserverOptions;
	#dynamicContent: DynamicContentHelper;
	#cache: TranslationCache;

	#getTranslations: GetTransMapFn;
	#debugCycle = 0;

	constructor(
		defaultLangCode = "en",
		locale?: string,
		getTranslations?: GetTransMapFn,
		expiryHours?: number,
		invalidateFn?: InvalidateFn,
		options?: TranslationObserverOptions
	) {
		this.#options = resolveObserverOptions(options);
		this.#dynamicContent = new DynamicContentHelper({
			variablePattern: this.#options.variablePattern,
			variableNameGroup: this.#options.variableNameGroup,
		});

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

		this.#cache = new TranslationCache(
			this.#defaultLanguage,
			this.#defaultRegion,
			invalidateFn
		);
		this.#cache.setLocale(this.#langCode, this.#region);
		this.#initPromise = this.#cache.initialize();

		rootNode.classList.add(TRANSLATING_CLASS);
		this.changeLocale().then(() =>
			rootNode.classList.remove(TRANSLATING_CLASS)
		);

		this.#getTranslations = getTranslations;
		this.#expiryMs =
			typeof expiryHours === "number" && expiryHours > 0
				? expiryHours * 60 * 60 * 1000
				: null;

		this.#mutObserver = new MutationObserver((mutations) => {
			if (this.#debugEnabled() && mutations.length > 0) {
				this.#debugCycle += 1;
				let attributeMutations = 0;
				let characterMutations = 0;
				let childMutations = 0;
				const attributeNames = new Set<string>();

				for (const mutation of mutations) {
					if (mutation.type === "attributes") {
						attributeMutations += 1;
						if (mutation.attributeName) {
							attributeNames.add(mutation.attributeName);
						}
						continue;
					}

					if (mutation.type === "characterData") {
						characterMutations += 1;
						continue;
					}

					if (mutation.type === "childList") {
						childMutations += 1;
					}
				}

				this.#debugLog(
					`mutation cycle #${
						this.#debugCycle
					}: attrs=${attributeMutations} text=${characterMutations} children=${childMutations}`,
					attributeNames.size > 0
						? { attributes: Array.from(attributeNames).sort() }
						: undefined
				);
			}

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

	async changeLocale(langCode = "", region = "") {
		await this.#initPromise;

		const nextLang = langCode || this.#defaultLanguage;
		const nextRegion = region || this.#defaultRegion;
		this.#langCode = nextLang;
		this.#region = nextRegion;
		this.#cache.setLocale(nextLang, nextRegion);

		if (this.#options.setLanguageAttributes) {
			this.#applyLanguageMetadata();
		}
	}

	disconnect(): void {
		this.#mutObserver.disconnect();
		this.#transBatch.clear();
		this.#nodeStates.clear();
		this.#attrStates.clear();
		this.#observedRoots.clear();
		this.#cache.dispose();
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

	#debugEnabled(): boolean {
		if (typeof window === "undefined") {
			return false;
		}

		const flag = (
			window as typeof window & {
				__TRANSMUT_DEBUG__?: boolean;
			}
		).__TRANSMUT_DEBUG__;
		if (typeof flag === "boolean") {
			return flag;
		}

		return true;
	}

	#debugLog(...args: unknown[]): void {
		if (!this.#debugEnabled()) {
			return;
		}

		console.log("[transmut-debug]", ...args);
	}

	#describeElement(element: Element): string {
		const tag = element.tagName
			? element.tagName.toLowerCase()
			: element.constructor?.name ?? "element";
		const id = element.getAttribute("id");
		const classes = element.getAttribute("class");
		const parts: string[] = [`<${tag}>`];
		if (id) {
			parts.push(`#${id}`);
		}
		if (classes) {
			parts.push(`.${classes.split(/\s+/).filter(Boolean).join(".")}`);
		}
		return parts.join("");
	}

	#setAttributeIfChanged(
		element: Element,
		name: string,
		value: string
	): void {
		if (element.getAttribute(name) === value) {
			return;
		}

		element.setAttribute(name, value);
		this.#debugLog(
			`set ${name}="${value}" on ${this.#describeElement(element)}`
		);
	}

	#applyLanguageMetadata(): void {
		if (typeof document === "undefined") {
			return;
		}

		const localeTag = this.#getCurrentLocaleTag();
		const direction = this.#resolveDirection(this.#langCode);

		const documentElement = document.documentElement;
		if (documentElement) {
			this.#setAttributeIfChanged(documentElement, "lang", localeTag);
			this.#setAttributeIfChanged(documentElement, "dir", direction);
			this.#setAttributeIfChanged(
				documentElement,
				"data-transmut-lang",
				localeTag
			);
			this.#setAttributeIfChanged(
				documentElement,
				"data-transmut-dir",
				direction
			);
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

			this.#setAttributeIfChanged(target, "lang", localeTag);
			this.#setAttributeIfChanged(
				target,
				"data-transmut-lang",
				localeTag
			);
			this.#setAttributeIfChanged(target, "dir", direction);
			this.#setAttributeIfChanged(target, "data-transmut-dir", direction);
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
			this.#setAttributeIfChanged(element, "lang", directive.localeTag);
			this.#setAttributeIfChanged(
				element,
				"data-transmut-lang",
				directive.localeTag
			);
		}

		const direction =
			directive.direction ??
			this.#directionForLocale(directive.localeTag);
		if (direction) {
			this.#setAttributeIfChanged(element, "dir", direction);
			this.#setAttributeIfChanged(
				element,
				"data-transmut-dir",
				direction
			);
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
		if (this.#debugEnabled()) {
			this.#debugLog(
				`attribute mutation: ${normalizedAttribute} on ${this.#describeElement(
					element
				)}`
			);
		}

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

	#normalizeText = (text: string) => this.#dynamicContent.normalize(text);

	#reconstructText = (
		translatedBase: string,
		fragments: DynamicFragment[] | undefined,
		container: Element | null
	): string =>
		this.#dynamicContent.reconstruct(
			translatedBase,
			fragments,
			(variableFragment) =>
				this.#resolveVariableValue(container, variableFragment)
		);

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
			const content = textNode.textContent ?? "";
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
				return;
			}

			if (content.length === 0) {
				return;
			}

			const { normalized, hasVariables, hasNumbers, fragments } =
				this.#normalizeText(content);
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

		if (this.#debugEnabled()) {
			const preview = batch.slice(0, 10);
			this.#debugLog(
				`translate batch size=${batch.length}`,
				preview,
				batch.length > preview.length
					? { truncated: batch.length - preview.length }
					: undefined
			);
		}

		await this.#initPromise;

		const cachedEntries = await this.#cache.getCachedTranslations(batch);
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
			if (this.#debugEnabled()) {
				const preview = keysNeedingFetch.slice(0, 10);
				this.#debugLog(
					`fetching ${
						keysNeedingFetch.length
					} key(s) for locale ${this.#getCurrentLocaleTag()}`,
					preview,
					keysNeedingFetch.length > preview.length
						? {
								truncated:
									keysNeedingFetch.length - preview.length,
						  }
						: undefined
				);
			}
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
				await this.#cache.persistTranslations(fetched);
				Object.assign(resolved, fetched);
			}
		}

		const requested = new Set(batch);

		for (const [node, state] of this.#nodeStates.entries()) {
			if (!state.pendingSource || !requested.has(state.pendingSource)) {
				continue;
			}

			const currentText = node.textContent ?? "";
			if (currentText !== state.lastText) {
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

				const currentValue = element.getAttribute(attributeName) ?? "";
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
}
