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
		(
			globalThis as unknown as {
				MutationObserver?: typeof MutationObserver;
			}
		).MutationObserver = OriginalMutationObserver;
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
});
