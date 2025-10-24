type TranslationMap = Record<string, string>;
type AsyncTransMap = TranslationMap | Promise<TranslationMap>;
type GetTransMapFn = (
	translation: { langCode: string; region?: string },
	from: string[]
) => AsyncTransMap;

const TRANSLATING_CLASS = "transmut-translating";

export class TranslationObserver {
	#mutObserver: MutationObserver;
	#defaultLanguage = "en";
	#defaultRegion = "";
	#langCode: string;
	#region: string;
	#currentTranslation: AsyncTransMap = {};

	#transBatch = new Set<string>();
	#nodeStates = new WeakMap<
		Node,
		{ translated: boolean; lastText: string }
	>();

	#getTranslationCache: (lanCode: string, region?: string) => AsyncTransMap;
	#getTranslations: GetTransMapFn;

	constructor(
		getTranslationCache: () => AsyncTransMap,
		getTranslations: GetTransMapFn,
		defaultLangCode = "en",
		locale?: string
	) {
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

		if (!navigator?.language) {
			throw new Error("Unable to access navigator language settings.");
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

		// Add translation class
		rootNode.classList.add(TRANSLATING_CLASS);
		this.changeLocale().then(() =>
			rootNode.classList.remove(TRANSLATING_CLASS)
		);

		/**
		 * Set translation functions and langcodes
		 */
		this.#getTranslationCache = getTranslationCache;
		this.#getTranslations = getTranslations;

		[this.#langCode, this.#region] = defaultLangCode
			.toLocaleLowerCase()
			.split("-");
		this.#defaultLanguage = this.#langCode;
		this.#defaultRegion = this.#defaultRegion;

		/**
		 * Observe text nodes
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
					}
				}
			}

			this.#translate();
		});

		this.#mutObserver.observe(rootNode, {
			subtree: true,
			characterData: true,
			childList: true,
		});
	}

	async changeLocale(langCode = ``, region = ``) {
		if (
			(langCode === this.#defaultLanguage && !region) ||
			region === this.#defaultRegion
		)
			this.#currentTranslation = {};
		else if (langCode)
			try {
				const translationCacheFromBackend =
					await this.#getTranslationCache(langCode, region);
				const newTranslation: TranslationMap =
					typeof translationCacheFromBackend === "string"
						? JSON.parse(translationCacheFromBackend)
						: translationCacheFromBackend;

				if (newTranslation) this.#currentTranslation = newTranslation;
			} catch {
				console.error(
					`Could not load translation for ${langCode}${
						region ? `-${region}` : ``
					}`
				);
			}
	}

	#handlePotentialText = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			if (node.textContent) {
				const oldState = this.#nodeStates.get(node);
				if (
					oldState?.translated &&
					oldState.lastText === node.textContent
				)
					return;

				this.#transBatch.add(node.textContent || ``);
				this.#nodeStates.set(node, {
					translated: false,
					lastText: node.textContent,
				});
			}
			return;
		}

		for (const child of node.childNodes) {
			this.#handlePotentialText(child);
		}
	};

	#translate = async (): Promise<void> => {
		let transMap: TranslationMap = await this.#getTranslations(
			{ langCode: this.#langCode, region: this.#region },
			Array.from(this.#transBatch)
		);

		if (typeof transMap === "string") {
			transMap = JSON.parse(transMap) as TranslationMap;
		}

		for (const [node, state] of this.#nodeStates) {
			if (state.status !== "inflight") continue;

			const translatedText = translationMap[state.untranslated];

			if (translatedText) {
				node.textContent = translatedText;
				this.#nodeStates.set(node, {
					status: "translated",
					untranslated: state.untranslated,
				});
			} else {
				this.#nodeStates.set(node, {
					status: "translated",
					untranslated: state.untranslated,
				});
			}
		}
	};
}
