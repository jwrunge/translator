import { STORE_NAME } from "./constants";
import type {
	CachedEntry,
	IndexedDBFactoryExtended,
	InvalidateFn,
	TranslationMap,
} from "./types";

export class TranslationCache {
	private readonly defaultLanguage: string;
	private readonly defaultRegion: string;
	private currentLanguage: string;
	private currentRegion: string;
	private dbPromise: Promise<IDBDatabase | null> | null = null;
	private dbInstance: IDBDatabase | null = null;
	private readonly invalidateFn?: InvalidateFn;

	constructor(
		defaultLanguage: string,
		defaultRegion: string,
		invalidateFn?: InvalidateFn
	) {
		this.defaultLanguage = defaultLanguage;
		this.defaultRegion = defaultRegion;
		this.currentLanguage = defaultLanguage;
		this.currentRegion = defaultRegion;
		this.invalidateFn = invalidateFn;
	}

	setLocale(lang: string, region: string): void {
		const nextDbName = this.composeDbName(lang, region);
		if (this.dbInstance && this.dbInstance.name !== nextDbName) {
			this.dbInstance.close();
		}

		this.dbInstance = null;
		this.dbPromise = null;
		this.currentLanguage = lang;
		this.currentRegion = region;
	}

	async initialize(): Promise<void> {
		if (!this.invalidateFn) {
			return;
		}

		if (typeof indexedDB === "undefined") {
			return;
		}

		try {
			const maybeKeys = await this.invalidateFn(new Date());
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

			const dbNames = await this.collectTranslationDbNames();
			await Promise.all(
				dbNames.map((name) => this.deleteKeysFromDb(name, keys))
			);
		} catch (error) {
			console.error("transmut: invalidate callback failed", error);
		}
	}

	async getCachedTranslations(
		keys: string[]
	): Promise<Record<string, CachedEntry>> {
		const db = await this.getDb();
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

	async persistTranslations(map: TranslationMap): Promise<void> {
		const entries = Object.entries(map).filter(
			([, value]) => typeof value === "string" && value.length > 0
		);
		if (entries.length === 0) {
			return;
		}

		const db = await this.getDb();
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

	dispose(): void {
		if (this.dbInstance) {
			this.dbInstance.close();
		}
		this.dbInstance = null;
		this.dbPromise = null;
	}

	private composeDbName(lang: string, region: string): string {
		const regionPart = region ? region : "default";
		return `transmut.${lang}.${regionPart}`;
	}

	private async getDb(): Promise<IDBDatabase | null> {
		if (typeof indexedDB === "undefined") {
			return null;
		}

		if (this.dbInstance) {
			return this.dbInstance;
		}

		if (this.dbPromise) {
			return this.dbPromise;
		}

		const dbName = this.composeDbName(
			this.currentLanguage,
			this.currentRegion
		);
		this.dbPromise = new Promise<IDBDatabase | null>((resolve, reject) => {
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
					if (this.dbInstance === db) {
						this.dbInstance = null;
					}
				};
				this.dbInstance = db;
				resolve(db);
			};

			request.onerror = () => {
				this.dbPromise = null;
				reject(request.error ?? new Error("Failed to open IndexedDB"));
			};

			request.onblocked = () => {
				console.warn(
					`transmut: database ${dbName} upgrade blocked. Close other tabs to continue.`
				);
			};
		});

		try {
			return await this.dbPromise;
		} catch (error) {
			console.error("transmut: unable to open IndexedDB", error);
			return null;
		} finally {
			this.dbPromise = null;
		}
	}

	private async collectTranslationDbNames(): Promise<string[]> {
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

		names.add(this.composeDbName(this.currentLanguage, this.currentRegion));
		names.add(this.composeDbName(this.defaultLanguage, this.defaultRegion));

		return Array.from(names).filter((name) => name.length > 0);
	}

	private async deleteKeysFromDb(
		dbName: string,
		keys: string[]
	): Promise<void> {
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
}
