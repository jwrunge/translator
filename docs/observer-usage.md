# Translation Observer Quick Start

This example shows how to opt-in elements, translate attributes, and work with shadow roots using `TranslationObserver`.

```html
<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>Translation Observer Demo</title>
	</head>
	<body>
		<main data-transmut="include">
			<h1 data-transmut="include">Welcome back!</h1>

			<!-- Text nodes & attributes marked for translation -->
			<p data-transmut="include">
				<span data-transmut="include" data-transmut-count="12">
					You have ${count} unread messages.
				</span>
				<button
					data-transmut="include"
					data-transmut-attrs="title, aria-label"
					data-transmut-label="Open inbox"
					title="View inbox"
					aria-label="View inbox"
				>
					${label}
				</button>
			</p>

			<!-- Skip user-editable input entirely -->
			<label>
				Nickname
				<input placeholder="Enter nickname" />
			</label>

			<!-- Section rendered in a different locale -->
			<section data-transmut-locale="fr-CA">
				<p>Bonjour! Cette section reste en français.</p>
			</section>

			<!-- Opt out of translation for a subtree -->
			<section data-transmut-skip>
				<p>This block remains in the source language.</p>
			</section>
		</main>

		<script type="module">
			import TranslationObserver from "./src/observer.js";

			const observer = new TranslationObserver(
				"en",
				"es-MX",
				async ({ langCode, region }, keys) => {
					// Replace with your own translation loader
					const response = await fetch(
						`/api/translations?lang=${langCode}&region=${region}`,
						{
							method: "POST",
							body: JSON.stringify({ keys }),
						}
					);
					return response.ok ? response.json() : {};
				},
				24,
				undefined,
				{
					requireExplicitOptIn: true,
					textSelector: "[data-transmut]",
					attributeSelector: "[data-transmut-attrs]",
					attributeNames: ["title", "aria-label", "placeholder"],
					skipEditable: true,
					setLanguageAttributes: true,
					direction: "auto",
					// Optional custom overrides (use ISO codes as keys)
					directionOverrides: {
						"es-mx": "ltr",
					},
				}
			);

			// Optional: translate a shadow root
			const shadowHost = document.getElementById("shadow-example");
			if (shadowHost && shadowHost.shadowRoot) {
				observer.observeShadowRoot(shadowHost.shadowRoot);
			}
		</script>

		<!-- Shadow DOM example -->
		<div id="shadow-example"></div>
		<script>
			const host = document.getElementById("shadow-example");
			const root = host.attachShadow({ mode: "open" });
			root.innerHTML = `
				<p
					data-transmut="include"
					data-transmut-alerts="3"
					title="New alerts"
				>
					You have ${alerts} new alerts.
				</p>
			`;
		</script>
	</body>
</html>
```

**Key ideas**

-   `data-transmut="include"` opts a subtree into translation when `requireExplicitOptIn` is `true`.
-   `data-transmut-skip` disables translation for an element and all of its descendants.
-   `data-transmut-attrs` lists attribute names that should be translated on a specific element.
-   `data-transmut-{name}` binds placeholder values (e.g. `${name}`) so the observer can reinsert dynamic content after translation.
-   Language metadata (`lang`, `dir`, `data-transmut-lang`, `data-transmut-dir`) is applied automatically to observed roots and locale overrides.
-   Shadow DOM content must be registered via `observeShadowRoot` so it receives translations and metadata updates.
