export type TranslationFn = (
	input: string,
	node: Text
) => string | Promise<string>;

export interface TextTranslationObserverOptions {
	root?: Node;
	processExisting?: boolean;
	filter?: (node: Text) => boolean;
	onError?: (error: unknown, node: Text) => void;
}

interface NodeState {
	lastSource: string;
	lastTranslated: string;
	inFlight?: Promise<void>;
}

type TranslationCache = Record<string, { value: string; edited?: boolean }>;

export class TranslationObserver {
	#mutObserver: MutationObserver;
	#defaultLanguage = "en";
	#defaultRegion = "";
	#langCode: string;
	#region: string;
	#currentTranslation: Promise<TranslationCache> | TranslationCache = {};

	#nodeStates = new WeakMap<Text, NodeState>(); // Tracks the last processed text per node to avoid translation loops.

	#getTranslationCache: (
		lanCode: string,
		region?: string
	) => Promise<TranslationCache> | TranslationCache;
	#getTranslation: (
		translation: { langCode: string; region?: string },
		from: string
	) => Promise<string> | string;

	constructor(
		translate: TranslationFn,
		defaultLangCode = "en",
		getTranslationCache: () => Promise<TranslationCache> | TranslationCache,
		getTranslation: (
			translation: { langCode: string; region?: string },
			from: string
		) => Promise<string> | string,
		options: TextTranslationObserverOptions = {},
		locale?: string
	) {
		// Set translation functions and langcodes
		this.#getTranslationCache = getTranslationCache;
		this.#getTranslation = getTranslation;

		[this.#langCode, this.#region] = defaultLangCode
			.toLocaleLowerCase()
			.split("-");
		this.#defaultLanguage = this.#langCode;
		this.#defaultRegion = this.#defaultRegion;

		/**
		 * Abort if not a DOM environment
		 */
		if (typeof MutationObserver === "undefined") {
			throw new Error(
				"MutationObserver is not available in this environment."
			);
		}

		const rootNode =
			options.root ??
			(typeof document !== "undefined"
				? document.body ?? document
				: undefined);

		if (!rootNode) {
			throw new Error("Unable to determine a root node to observe.");
		}

		if (!navigator?.language) {
			throw new Error("Unable to access navigator language settings.");
		}

		/**
		 * Set langCode and region from locale
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

		/**
		 * Observe text nodes
		 */
		const { processExisting = true, onError } = options;

		const handlePotentialText = (node: Node): void => {
			if (node.nodeType === Node.TEXT_NODE) {
				scheduleTranslation(node as Text);
				return;
			}

			for (const child of node.childNodes) {
				handlePotentialText(child);
			}
		};

		if (processExisting) {
			handlePotentialText(rootNode);
		}

		this.#mutObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				if (
					mutation.type === "characterData" &&
					mutation.target.nodeType === Node.TEXT_NODE
				) {
					scheduleTranslation(mutation.target as Text);
				}

				if (mutation.type === "childList") {
					for (const added of mutation.addedNodes) {
						handlePotentialText(added);
					}
				}
			}
		});

		this.#mutObserver.observe(rootNode, {
			subtree: true,
			characterData: true,
			childList: true,
		});
	}

	async changeLocale(langCode = ``) {
		const [code, region] = langCode.split(`-`);

		if (
			(code === this.#defaultLanguage && !region) ||
			region === this.#defaultRegion
		)
			this.#currentTranslation = {};
		else if (code)
			try {
				const translationCacheFromBackend =
					await this.#getTranslationCache(code, region);
				const newTranslation: TranslationCache =
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

	scheduleTranslation = async (node: Text) => {
		const currentText = node.textContent ?? "";
		const existingState = this.#nodeStates.get(node);

		if (existingState?.inFlight) {
			if (
				existingState.lastSource === currentText ||
				existingState.lastTranslated === currentText
			) {
				return;
			}
		}

		if (existingState && existingState.lastTranslated === currentText) {
			return;
		}

		if (
			existingState &&
			existingState.lastSource === currentText &&
			!existingState.inFlight
		) {
			return;
		}

		const state: NodeState = existingState ?? {
			lastSource: currentText,
			lastTranslated: currentText,
		};

		state.lastSource = currentText;

		const translated = await this.#getTranslation(
			{ langCode: this.#langCode, region: this.#region },
			currentText
		);

		const inFlight = Promise.resolve()
			.then(() => translate(currentText, node))
			.then((translated) => {
				if (translated == null) {
					return;
				}

				const latestText = node.textContent ?? "";
				if (latestText !== currentText) {
					return;
				}

				if (translated !== latestText) {
					node.textContent = translated;
				}

				state.lastTranslated = translated;
			})
			.catch((error) => {
				state.lastTranslated = state.lastTranslated ?? currentText;
				if (onError) {
					onError(error, node);
				} else {
					console.error(
						"observeTextTranslations: translation failed",
						error
					);
				}
			})
			.finally(() => {
				state.inFlight = undefined;
			});

		state.inFlight = inFlight;
		this.#nodeStates.set(node, state);
	};
}
