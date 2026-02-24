// @vitest-environment jsdom
import { JSDOM } from "jsdom";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import TranslationObserver from "../index";

const flushAsync = async (): Promise<void> => {
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("TranslationObserver", () => {
	let observer: TranslationObserver | null = null;
	let dom: JSDOM | null = null;
	const originalWindow = globalThis.window;
	const originalDocument = globalThis.document;
	const originalNavigator = globalThis.navigator;
	const originalNode = globalThis.Node;
	const originalElement = globalThis.Element;
	const originalHTMLElement = globalThis.HTMLElement;
	const originalShadowRoot = globalThis.ShadowRoot;
	const originalText = globalThis.Text;
	const OriginalMutationObserver = globalThis.MutationObserver;

	class TestMutationObserver implements MutationObserver {
		readonly callback: MutationCallback;
		constructor(callback: MutationCallback) {
			this.callback = callback;
		}
		observe(_target: Node, _options?: MutationObserverInit): void {}
		disconnect(): void {}
		takeRecords(): MutationRecord[] {
			return [];
		}
	}

	beforeAll(() => {
		dom = new JSDOM("<!doctype html><html><body></body></html>", {
			url: "https://example.test",
		});

		(
			globalThis as unknown as {
				window: Window & typeof globalThis;
			}
		).window = dom.window as unknown as Window & typeof globalThis;
		(
			globalThis as unknown as {
				document: Document;
			}
		).document = dom.window.document;
		(
			globalThis as unknown as {
				navigator: Navigator;
			}
		).navigator = dom.window.navigator;
		(
			globalThis as unknown as {
				Node: typeof Node;
			}
		).Node = dom.window.Node;
		(
			globalThis as unknown as {
				Element: typeof Element;
			}
		).Element = dom.window.Element;
		(
			globalThis as unknown as {
				HTMLElement: typeof HTMLElement;
			}
		).HTMLElement = dom.window.HTMLElement;
		(
			globalThis as unknown as {
				ShadowRoot: typeof ShadowRoot;
			}
		).ShadowRoot = dom.window.ShadowRoot;
		(
			globalThis as unknown as {
				Text: typeof Text;
			}
		).Text = dom.window.Text;

		(
			globalThis as unknown as {
				MutationObserver: typeof MutationObserver;
			}
		).MutationObserver =
			TestMutationObserver as unknown as typeof MutationObserver;
	});

	afterEach(() => {
		observer?.disconnect();
		observer = null;
		document.body.innerHTML = "";
	});

	afterAll(() => {
		if (originalWindow) {
			(
				globalThis as unknown as {
					window: Window & typeof globalThis;
				}
			).window = originalWindow;
		}
		if (originalDocument) {
			(
				globalThis as unknown as {
					document: Document;
				}
			).document = originalDocument;
		}
		if (originalNavigator) {
			(
				globalThis as unknown as {
					navigator: Navigator;
				}
			).navigator = originalNavigator;
		}
		if (originalNode) {
			(
				globalThis as unknown as {
					Node: typeof Node;
				}
			).Node = originalNode;
		}
		if (originalElement) {
			(
				globalThis as unknown as {
					Element: typeof Element;
				}
			).Element = originalElement;
		}
		if (originalHTMLElement) {
			(
				globalThis as unknown as {
					HTMLElement: typeof HTMLElement;
				}
			).HTMLElement = originalHTMLElement;
		}
		if (originalShadowRoot) {
			(
				globalThis as unknown as {
					ShadowRoot: typeof ShadowRoot;
				}
			).ShadowRoot = originalShadowRoot;
		}
		if (originalText) {
			(
				globalThis as unknown as {
					Text: typeof Text;
				}
			).Text = originalText;
		}
		(
			globalThis as unknown as {
				MutationObserver?: typeof MutationObserver;
			}
		).MutationObserver = OriginalMutationObserver;

		dom?.window.close();
		dom = null;
	});

	it("translates text nodes with dynamic placeholders", async () => {
		document.body.innerHTML = `
			<main data-transmut="include">
				<p data-transmut="include" data-transmut-count="5">You have \${count} unread messages.</p>
			</main>
		`;

		const getTranslations = vi.fn(async (_locale, keys: string[]) => {
			const map = new Map<string, string>();
			for (const key of keys) {
				if (key === "You have {} unread messages.") {
					map.set(key, "Tienes {} mensajes sin leer.");
				} else {
					map.set(key, key);
				}
			}
			return Object.fromEntries(map);
		});

		observer = new TranslationObserver(
			"en",
			"es-MX",
			getTranslations,
			undefined,
			undefined,
			{ requireExplicitOptIn: true }
		);

		await flushAsync();

		const paragraph = document.querySelector("p");
		expect(paragraph?.textContent).toBe("Tienes 5 mensajes sin leer.");
		expect(getTranslations).toHaveBeenCalled();
	});

	it("translates opted-in attributes alongside text", async () => {
		document.body.innerHTML = `
			<button data-transmut="include" data-transmut-attrs="title" title="Open inbox">Open inbox</button>
		`;

		const getTranslations = vi.fn(async (_locale, keys: string[]) => {
			return Object.fromEntries(
				keys.map((key) => [
					key,
					key === "Open inbox" ? "Abrir bandeja" : key,
				])
			);
		});

		observer = new TranslationObserver(
			"en",
			"es-MX",
			getTranslations,
			undefined,
			undefined,
			{ requireExplicitOptIn: true }
		);

		await flushAsync();

		const button = document.querySelector("button");
		expect(button?.textContent).toBe("Abrir bandeja");
		expect(button?.getAttribute("title")).toBe("Abrir bandeja");
	});

	it("honors data-transmut-skip for entire subtrees", async () => {
		document.body.innerHTML = `
			<section data-transmut="include" data-transmut-skip>
				<p>Do not translate me</p>
			</section>
		`;

		const getTranslations = vi.fn(async (_locale, keys: string[]) => {
			return Object.fromEntries(
				keys.map((key) => [key, `translated:${key}`])
			);
		});

		observer = new TranslationObserver(
			"en",
			"es-MX",
			getTranslations,
			undefined,
			undefined,
			{ requireExplicitOptIn: true }
		);

		await flushAsync();

		const requestedKeys = getTranslations.mock.calls.flatMap(
			([, keys]) => keys
		);
		expect(requestedKeys).not.toContain("Do not translate me");
		expect(document.querySelector("p")?.textContent).toBe(
			"Do not translate me"
		);
	});

	it("preserves protected email, uuid, and url values while translating surrounding text", async () => {
		document.body.innerHTML = `
			<p data-transmut="include">
				My email is person@example.com, session 550e8400-e29b-41d4-a716-446655440000, docs https://example.com/help and 12 alerts.
			</p>
		`;

		const getTranslations = vi.fn(async (_locale, keys: string[]) => {
			return Object.fromEntries(
				keys.map((key) => {
					const normalizedKey = key.replace(/\s+/g, " ").trim();
					if (
						normalizedKey ===
						"My email is {}, session {}, docs {} and {} alerts."
					) {
						return [
							key,
							"Mi correo es {}, sesión {}, docs {} y {} alertas.",
						];
					}

					return [key, key];
				})
			);
		});

		observer = new TranslationObserver(
			"en",
			"es-MX",
			getTranslations,
			undefined,
			undefined,
			{ requireExplicitOptIn: true }
		);

		await flushAsync();

		const requestedKeys = getTranslations.mock.calls
			.flatMap(([, keys]) => keys)
			.map((key) => key.replace(/\s+/g, " ").trim());
		expect(requestedKeys).toContain(
			"My email is {}, session {}, docs {} and {} alerts."
		);

		const paragraph = document.querySelector("p");
		expect(paragraph?.textContent?.replace(/\s+/g, " ").trim()).toBe(
			"Mi correo es person@example.com, sesión 550e8400-e29b-41d4-a716-446655440000, docs https://example.com/help y 12 alertas."
		);
	});
});
