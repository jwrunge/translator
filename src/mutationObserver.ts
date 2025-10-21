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

export class TranslationObserver {
	#mutObserver: MutationObserver;
	#langCode: string;
	#region: string;
	#currentTranslation = new Map<
		string,
		{ value: string; edited?: boolean }
	>();

	constructor(
		translate: TranslationFn,
		getTranslation: (
			translation: { langCode: string; region?: string },
			from: string
		) => string,
		options: TextTranslationObserverOptions = {},
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
		const nodeStates = new WeakMap<Text, NodeState>(); // Tracks the last processed text per node to avoid translation loops.

		const scheduleTranslation = (node: Text): void => {
			const currentText = node.textContent ?? "";
			const existingState = nodeStates.get(node);

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
			nodeStates.set(node, state);
		};

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

	async changeLocale(code?: string) {
		await this.changeTranslation(code);
		localeOverride.value = code;
	}

	async changeTranslation(langCode = ``) {
		const [code] = langCode.split(`-`);

		if (code === `en`) this.currentTranslation = {};
		else if (code)
			try {
				const newTranslation = (await (
					await fetch(`/translations/${code}.json`)
				).json()) as Record<
					string,
					{ value: string; edited?: boolean }
				> | null;
				if (newTranslation) this.#currentTranslation = newTranslation;
			} catch {}
	}
}
