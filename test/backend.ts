import { createServer, type IncomingMessage } from "node:http";
import { URL } from "node:url";

const PORT = Number.parseInt(process.env.PORT ?? "4000", 10);

const translations: Record<string, Record<string, string>> = {
	es: {
		"Transmut demo": "Demostración de Transmut",
		"This page demonstrates the TranslationObserver running against a tiny HTTP backend.":
			"Esta página demuestra TranslationObserver conectándose a un pequeño backend HTTP.",
		"Choose a language": "Elige un idioma",
		"Language picker": "Selector de idioma",
		English: "Inglés",
		Spanish: "Español",
		French: "Francés",
		"Cart status": "Estado del carrito",
		"Your cart is empty.": "Tu carrito está vacío.",
		"Your cart now has a featured item.":
			"Tu carrito ahora tiene un artículo destacado.",
		"Add featured item": "Agregar artículo destacado",
		"Add a featured item": "Agregar un artículo destacado",
	},
	fr: {
		"Transmut demo": "Démo Transmut",
		"This page demonstrates the TranslationObserver running against a tiny HTTP backend.":
			"Cette page montre TranslationObserver connecté à un petit backend HTTP.",
		"Choose a language": "Choisissez une langue",
		"Language picker": "Sélecteur de langue",
		English: "Anglais",
		Spanish: "Espagnol",
		French: "Français",
		"Cart status": "Statut du panier",
		"Your cart is empty.": "Votre panier est vide.",
		"Your cart now has a featured item.":
			"Votre panier contient maintenant un article vedette.",
		"Add featured item": "Ajouter l'article vedette",
		"Add a featured item": "Ajouter un article vedette",
	},
};

type TranslationRequest = {
	langCode?: string;
	region?: string;
	keys?: string[];
};

const readRequestBody = async (req: IncomingMessage) => {
	const chunks: Uint8Array[] = [];

	for await (const chunk of req) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}

	return Buffer.concat(chunks).toString("utf8");
};

const server = createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	if (!req.url) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Missing request URL." }));
		return;
	}

	const url = new URL(req.url, `http://localhost:${PORT}`);

	if (url.pathname !== "/translations" || req.method !== "POST") {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Not found." }));
		return;
	}

	try {
		const rawBody = await readRequestBody(req);
		const payload = rawBody
			? (JSON.parse(rawBody) as TranslationRequest)
			: {};
		const langCode = (payload.langCode ?? "en").toLowerCase();
		const keys = Array.isArray(payload.keys) ? payload.keys : [];

		const localeTranslations = translations[langCode];
		if (!localeTranslations || keys.length === 0) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({}));
			return;
		}

		const result: Record<string, string> = {};
		for (const key of keys) {
			if (localeTranslations[key]) {
				result[key] = localeTranslations[key];
			}
		}

		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(result));
	} catch (error) {
		console.error("Failed to handle translation request", error);
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Internal server error." }));
	}
});

server.listen(PORT, () => {
	console.log(`Translation backend listening on http://localhost:${PORT}`);
});
