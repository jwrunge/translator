type TranslationMap = Record<string, string>;
type AsyncTransMap = TranslationMap | Promise<TranslationMap>;
type GetTransMapFn = (
	translation: { langCode: string; region?: string },
	from: string[],
	currentUrl?: string
) => AsyncTransMap;

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
	#nodeStates = new Map<
		Text,
		{
			translated: boolean;
			lastText: string;
			pendingSource?: string;
			normalizedKey?: string;
		}
	>();

	#getTranslations: GetTransMapFn;

	// Regex patterns for normalizing dynamic content
	#numberPattern = /\b\d+(?:\.\d+)?\b/g;
	#variablePattern = /\${[^}]*}/g;
	#placeholderToken = "{}";

	constructor(
		defaultLangCode = "en",
		locale?: string,
		getTranslations?: GetTransMapFn,
		expiryHours?: number,
		invalidateFn?: InvalidateFn
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
	}

	/**
	 * Normalizes text content by replacing numbers and template variables with placeholders
	 * This allows the same base translation to be reused for dynamic content
	 */
	#normalizeText = (
		text: string
	): { normalized: string; hasVariables: boolean; hasNumbers: boolean } => {
		let normalized = text;
		let hasVariables = false;
		let hasNumbers = false;

		// Replace template variables like ${variable} with {}
		if (this.#variablePattern.test(text)) {
			hasVariables = true;
			normalized = normalized.replace(
				this.#variablePattern,
				this.#placeholderToken
			);
		}

		// Replace numbers with {}
		if (this.#numberPattern.test(normalized)) {
			hasNumbers = true;
			normalized = normalized.replace(
				this.#numberPattern,
				this.#placeholderToken
			);
		}

		return { normalized, hasVariables, hasNumbers };
	};

	/**
	 * Reconstructs translated text by replacing placeholders with original dynamic values
	 */
	#reconstructText = (
		translatedBase: string,
		originalText: string
	): string => {
		const originalNumbers = originalText.match(this.#numberPattern) || [];
		const originalVariables =
			originalText.match(this.#variablePattern) || [];

		let result = translatedBase;

		// Replace placeholders with original values in order
		[...originalVariables, ...originalNumbers].forEach((value) => {
			result = result.replace(this.#placeholderToken, value);
		});

		return result;
	};

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

			// Normalize the text to handle dynamic content
			const { normalized, hasVariables, hasNumbers } =
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
				this.#nodeStates.set(node, state);
				continue;
			}

			const translatedBase = resolved[state.pendingSource];
			if (translatedBase && translatedBase !== currentText) {
				// If this was normalized text with dynamic content, reconstruct it
				const finalTranslation = state.normalizedKey
					? this.#reconstructText(translatedBase, state.lastText)
					: translatedBase;

				node.textContent = finalTranslation;
				state.translated = true;
				state.lastText = finalTranslation;
				state.pendingSource = undefined;
				state.normalizedKey = undefined;
				this.#nodeStates.set(node, state);
			} else {
				state.translated = true;
				state.lastText = currentText;
				state.pendingSource = undefined;
				state.normalizedKey = undefined;
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
