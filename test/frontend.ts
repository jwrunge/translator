import TranslationObserver from "../src/observer";
import type { GetTransMapFn } from "../src/observer/types";

type Locale = Parameters<GetTransMapFn>[0];

const API_URL = "http://localhost:4000/translations";

console.log(
	`[translator-demo] bundle loaded at ${new Date().toISOString()}`
);

let requestCounter = 0;

const formatLocaleTag = (locale: Locale): string => {
	const region = locale.region ?? "";
	return region ? `${locale.langCode}-${region}` : locale.langCode;
};

const getTranslations = async (
	locale: Locale,
	keys: string[]
): Promise<Record<string, string>> => {
	if (locale.langCode === "en") {
		console.log(
			`[translator-demo] skip fetch for source locale (${formatLocaleTag(
				locale
			)}), ${keys.length} key(s)`
		);
		return {};
	}

	const requestId = ++requestCounter;
	console.log(
		`[translator-demo] request #${requestId} for ${formatLocaleTag(
			locale
		)} (${keys.length} key(s))`
	);
	if (keys.length > 0) {
		console.log(`[translator-demo] keys #${requestId}`, keys);
	}

	try {
		const response = await fetch(API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				langCode: locale.langCode,
				region: locale.region,
				keys,
			}),
		});

		if (!response.ok) {
			console.error(
				`Translation backend responded with ${response.status}. Falling back to source strings.`
			);
			return {};
		}

		const payload = (await response.json()) as Record<string, string>;
		console.log(
			`[translator-demo] response #${requestId} (${
				Object.keys(payload).length
			} key(s))`
		);
		return payload;
	} catch (error) {
		console.error(`[translator-demo] request #${requestId} failed`, error);
		return {};
	}
};

const observer = new TranslationObserver(
	"en",
	navigator.language,
	getTranslations,
	0,
	undefined,
	{
		requireExplicitOptIn: true,
	}
);

const languagePicker =
	document.querySelector<HTMLSelectElement>("#language-picker");

const updateLocale = async (localeTag: string) => {
	const [langCode, region = ""] = localeTag.split("-");
	console.log(`[translator-demo] changeLocale(${localeTag})`);
	await observer.changeLocale(langCode, region);
};

if (languagePicker) {
	languagePicker.addEventListener("change", async (event) => {
		const target = event.target;
		if (!(target instanceof HTMLSelectElement)) {
			return;
		}

		await updateLocale(target.value);
	});

	void updateLocale(languagePicker.value);
}

document.addEventListener("click", (event) => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) {
		return;
	}

	if (!target.matches('[data-demo-action="populate"]')) {
		return;
	}

	event.preventDefault();

	const message =
		document.querySelector<HTMLParagraphElement>("#cart-message");

	if (!message) {
		return;
	}

	if (message.dataset.transmutVariant === "filled") {
		message.dataset.transmutVariant = "empty";
		message.textContent = "Your cart is empty.";
		return;
	}

	message.dataset.transmutVariant = "filled";
	message.textContent = "Your cart now has a featured item.";
});
