type TranslationMap = Record<string, string>;
type AsyncTransMap = TranslationMap | Promise<TranslationMap>;
type GetTransMapFn = (
	translation: { langCode: string; region?: string },
	from: string[]
) => AsyncTransMap;

const TRANSLATING_CLASS = "transmut-translating";

export default class {
	#mutObserver: MutationObserver;
	#defaultLanguage = "en";
	#defaultRegion = "";
	#langCode: string;
	#region: string;

	#transBatch = new Set<string>();
	#nodeStates = new Map<
		Text,
		{ translated: boolean; lastText: string; pendingSource?: string }
	>();

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

					for (const removed of mutation.removedNodes) {
						this.#cleanupNode(removed);
					}
				}
			}

			const batch = Array.from(this.#transBatch);
			this.#transBatch.clear();
			if (batch.length > 0) {
				void this.#translate(batch);
			}
		});

		this.#mutObserver.observe(rootNode, {
			subtree: true,
			characterData: true,
			childList: true,
		});
	}

	async changeLocale(langCode = ``, region = ``) {
		this.#langCode = langCode || this.#defaultLanguage;
		this.#region = region;
	}

	#handlePotentialText = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			const textNode = node as Text;
			const content = textNode.textContent ?? ``;
			const existing = this.#nodeStates.get(textNode);

			if (existing?.translated && existing.lastText === content) {
				return; // Skip nodes we just translated.
			}

			if (content.length === 0) {
				return;
			}

			this.#transBatch.add(content);
			this.#nodeStates.set(textNode, {
				translated: false,
				lastText: content,
				pendingSource: content,
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

		let transMap: TranslationMap = await this.#getTranslations(
			{ langCode: this.#langCode, region: this.#region },
			batch
		);

		if (typeof transMap === "string") {
			transMap = JSON.parse(transMap) as TranslationMap;
		}

		const requested = new Set(batch);

		for (const [node, state] of this.#nodeStates.entries()) {
			if (!state.pendingSource || !requested.has(state.pendingSource)) {
				continue;
			}

			const currentText = node.textContent ?? ``;
			if (currentText !== state.pendingSource) {
				// Text changed again before we could apply the translation; leave for the next cycle.
				state.translated = false;
				state.lastText = currentText;
				state.pendingSource = undefined;
				this.#nodeStates.set(node, state);
				continue;
			}

			const translatedText = transMap[state.pendingSource];
			if (translatedText && translatedText !== currentText) {
				node.textContent = translatedText;
				state.translated = true;
				state.lastText = translatedText;
				state.pendingSource = undefined;
				this.#nodeStates.set(node, state);
			} else {
				state.translated = true;
				state.lastText = currentText;
				state.pendingSource = undefined;
				this.#nodeStates.set(node, state);
			}
		}
	};

	#cleanupNode = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			this.#nodeStates.delete(node as Text);
			return;
		}

		for (const child of node.childNodes) {
			this.#cleanupNode(child);
		}
	};
}
