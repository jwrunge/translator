# transmut Translation Observer

A client-side translation helper that watches the DOM, normalizes dynamic content, and populates localized text or attributes as translations become available. It is designed for single-page applications that need to translate asynchronously fetched content without re-rendering the entire view.

## Installation

This package currently ships as source. Add it to your project as a workspace package or copy the `src/observer` folder into your bundle. Ensure your build pipeline includes the files in `src/observer`.

```bash
# via npm workspaces or a relative dependency
npm install transmut
```

Vitest is configured for local testing (`npm test`).

## Quick Start

```ts
import TranslationObserver from "./src/observer";

const observer = new TranslationObserver(
	"en-US", // default/source locale
	"es-MX", // initial target locale (optional)
	async ({ langCode, region }, keys, currentUrl) => {
		// Fetch translations from your API
		const response = await fetch(
			`/api/translations?lang=${langCode}&region=${region}`
		);
		return (await response.json()) as Record<string, string>;
	},
	24, // hours before cached entries are considered stale (optional)
	async () => ["session.banner"], // invalidate cache keys (optional)
	{
		requireExplicitOptIn: true,
		skipEditable: true,
	}
);

await observer.changeLocale("es", "MX");
```

Place `data-transmut="include"` (or other directives) on elements that provide opt-in. The observer will automatically translate matching text nodes and opted-in attributes.

## Constructor Signature

```ts
new TranslationObserver(
	defaultLangCode?: string,
	initialLocale?: string,
	getTranslations: GetTransMapFn,
	expiryHours?: number,
	invalidateFn?: InvalidateFn,
	options?: TranslationObserverOptions
);
```

-   **defaultLangCode**: BCP 47 tag representing the source language (defaults to `en`).
-   **initialLocale**: Target locale to translate into. If omitted, the browser `navigator.language` is used.
-   **getTranslations**: Required async (or sync) function that returns a map of translation strings keyed by normalized source phrases. Returning a JSON string is also supported.
-   **expiryHours**: Number of hours before cached translations are considered stale. Set to `0` or omit to disable staleness checks.
-   **invalidateFn**: Optional callback invoked on startup to return translation keys that should be removed from IndexedDB before use.
-   **options**: Optional configuration (detailed below).

### Lifecycle Helpers

-   `changeLocale(langCode?: string, region?: string): Promise<void>` — updates the target locale and reapplies language metadata.
-   `observeShadowRoot(root: ShadowRoot): void` — explicitly opt a shadow root into observation.
-   `disconnect(): void` — stop observing mutations and close caches. Call this when tearing down your app.

## HTML Integration

The observer uses `data-transmut-*` directives to decide what to translate.

| Attribute                                | Purpose                                                                                                 | Notes                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `data-transmut="include"`                | Opt-in a node (and descendants) for translation.                                                        | Required when `requireExplicitOptIn` is `true`.     |
| `data-transmut="skip"`                   | Prevent translation for the node and its subtree.                                                       | Equivalent to adding `data-transmut-skip`.          |
| `data-transmut-skip`                     | When present (any truthy value), skips translation for the subtree.                                     | Empty string counts as `true`.                      |
| `data-transmut-attrs="title,aria-label"` | Comma-separated list of attribute names to translate.                                                   | Attributes must exist on the element.               |
| `data-transmut-locale`                   | Override locale for a section. Values such as `inherit`, `auto`, or empty fall back to observer locale. | When set to another locale the subtree is skipped.  |
| `data-transmut-dir`                      | Force text direction (`ltr` or `rtl`).                                                                  | Applied alongside locale metadata.                  |
| `data-transmut-{variable}`               | Supply values for dynamic placeholders (see below).                                                     | The `{variable}` name is derived from placeholders. |

### Dynamic Content Placeholders

Source strings that contain placeholders are normalized before being sent to `getTranslations`. By default, `${variable}` tokens and numbers are replaced with `{}` in the translation key.

Example:

```html
<p data-transmut="include" data-transmut-count="5">
	You have ${count} unread messages.
</p>
```

-   The observer requests a translation for `"You have {} unread messages."`.
-   After receiving the translation (e.g., `"Tienes {} mensajes sin leer."`), the observer reconstructs the sentence and replaces the placeholder with the value from `data-transmut-count`.

You can customise placeholder detection via the `variablePattern` and `variableNameGroup` options if your templates use different syntax.

### Attribute Translation

Attributes listed in `data-transmut-attrs` or matched by the default list (`title`, `aria-label`, `aria-description`, `placeholder`, `alt`) are translated alongside text. Opt in using directives or selectors when `requireExplicitOptIn` is enabled.

## Options Reference

`TranslationObserverOptions` control how the observer targets nodes and handles directionality.

| Option                  | Type                             | Default                                           | Description                                                                                      |
| ----------------------- | -------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `requireExplicitOptIn`  | `boolean`                        | `false`                                           | When `true`, only nodes matching `textSelector` or with `data-transmut="include"` are processed. |
| `textSelector`          | `string \| null`                 | `requireExplicitOptIn ? "[data-transmut]" : null` | Additional CSS selector that opts elements in for text translation.                              |
| `attributeSelector`     | `string \| null`                 | `"[data-transmut-attrs]"`                         | CSS selector used to detect attribute translation candidates.                                    |
| `attributeNames`        | `string[]`                       | See defaults above                                | Attribute names automatically considered for translation.                                        |
| `skipEditable`          | `boolean`                        | `true`                                            | When `true`, editable controls (`input`, `textarea`, contentEditable) are ignored.               |
| `setLanguageAttributes` | `boolean`                        | `true`                                            | Apply `lang`, `dir`, and `data-transmut-*` metadata to observed roots and the document element.  |
| `direction`             | `'ltr' \| 'rtl' \| 'auto'`       | `'auto'`                                          | `auto` infers direction from locale using defaults plus overrides.                               |
| `directionOverrides`    | `Record<string, 'ltr' \| 'rtl'>` | `DEFAULT_DIRECTION_OVERRIDES`                     | Extend or override the built-in map of locale → direction. Keys should be lowercase BCP 47 tags. |
| `variablePattern`       | `RegExp`                         | `/\${\s*([^}]+?)\s*}/g`                           | Pattern used to detect variable placeholders. Must be global (`g`).                              |
| `variableNameGroup`     | `number`                         | `1`                                               | Capture group index that contains the placeholder name.                                          |

## Translation Cache

An IndexedDB-backed cache stores translations per locale.

-   Database names follow `transmut.<lang>.<region>` (`region` defaults to `default`).
-   Cached entries include `updatedAt` timestamps. When `expiryHours` is provided, stale keys are re-fetched.
-   `invalidateFn` runs once on startup. Returning an array of keys deletes them across all known locales before translation begins.

If IndexedDB is unavailable (e.g., SSR or non-browser contexts), the cache gracefully no-ops.

## Environment Requirements

-   Runs in browsers with `MutationObserver` and (optionally) `indexedDB`.
-   For unit testing, the project uses Vitest with a `jsdom` environment (`npm test`).
-   Ensure your bundler supports modern ES modules (`target` is `ES2022`).

## Development Workflow

-   `npm install`
-   `npm test`

## Tips and Patterns

-   Wrap `getTranslations` with your own batching logic or memoization to reduce network chatter.
-   Use `observer.observeShadowRoot(shadowRoot)` for web components.
-   Apply `data-transmut-skip` to sections that should stay in the source language (e.g., brand names).
-   Consider emitting analytics or logs inside `getTranslations` to monitor missing keys.

## License

MIT

```

```
