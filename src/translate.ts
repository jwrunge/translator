// https://www.npmjs.com/package/translate

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { styleText } from "node:util";

import translate from "translate";

type Translations = Record<string, { value: string; edited?: boolean }>;

let overrideFlagSet = false;
let existingFlagSet = false;
let overwriteEditedValues = false;
let overwriteExistingValues = false;

const languagesPath = join(
	import.meta.dirname,
	`..`,
	`src`,
	`lib`,
	`modules`,
	`Languages`
);
const translationsPath = join(
	import.meta.dirname,
	`..`,
	`static`,
	`translations`
);
if (!existsSync(translationsPath)) mkdirSync(translationsPath);

const localeCodes = JSON.parse(
	readFileSync(join(languagesPath, `localeCodes.json`), `utf-8`)
) as Record<string, { text: string; flag: string }>;

const langCodes = process.argv.slice(2);
// const overwriteExisting = false;

console.log(
	styleText([`underline`, `blue`, `bold`], `\n\nCompiling translations...`)
);
if (!langCodes.length)
	console.log(
		styleText(
			[`red`],
			`No language codes provided; cancelling translation. Use "all" to compile all languages.\n`
		)
	);

const translations: Record<string, Translations> = {};
const rxTransFn = /\btrans\s*`\s*?(.*?)\s*(?<!{\s*)`(?!}\s*`)\s*/g;
const rxReplacements = /\${.*?}/g;

// For each file
const srcPath = join(import.meta.dirname, `..`, `src`);
for (const file of readdirSync(srcPath, { recursive: true }).filter(
	(f) => (f as string).endsWith(`.ts`) || (f as string).endsWith(`.svelte`)
)) {
	console.log(styleText([`green`, `bold`], `\tProcessing ${file}...`));

	const contents = readFileSync(join(srcPath, file as string), `utf-8`);

	// For each language
	for (const langCode of Object.keys(localeCodes)) {
		if (
			(langCodes[0] !== `all` && !langCodes.includes(langCode)) ||
			[`en-us`, `en`].includes(langCode)
		)
			continue;

		// eslint-disable-next-line unused-imports/no-unused-vars
		const [lang, _region] = langCode.split(/[_-]/);
		const langPath = join(translationsPath, `${langCode}.json`);
		if (!existsSync(langPath)) writeFileSync(langPath, ``);

		const langFile = readFileSync(langPath, `utf-8`) || `{}`;
		translations[langCode] ??= JSON.parse(langFile) as Translations;

		let matches = rxTransFn.exec(contents);
		while (matches) {
			// eslint-disable-next-line unused-imports/no-unused-vars
			const [_dump, key] = matches;

			const replacedKey = key?.replaceAll(rxReplacements, `{}`) ?? ``;

			// Check if we should overwrite existing values
			if (
				translations[langCode][replacedKey] &&
				!overwriteExistingValues
			) {
				if (!existingFlagSet) {
					let response = ``;
					const rl = createInterface({
						input: process.stdin,
						output: process.stdout,
					});

					while (![`skip`, `overwrite`].includes(response)) {
						// eslint-disable-next-line no-await-in-loop
						response = await rl.question(
							styleText(
								[`yellow`, `italic`, `bold`],

								`Some translations already exist. Type "overwrite" to overwrite them, or "skip" to skip them: `
							)
						);

						if (response === `overwrite`) {
							existingFlagSet = true;
							overwriteExistingValues = true;
						} else if (response === `skip`) {
							existingFlagSet = true;
							overwriteExistingValues = false;
						}

						if ([`overwrite`, `skip`].includes(response))
							console.log(
								`OK -- when existing values are found, the script will ${response} them`
							);
					}
				}

				if (!overwriteExistingValues) {
					matches = rxTransFn.exec(contents);
					continue;
				}
			}

			// Check if we should overwrite edited values
			if (
				translations[langCode][replacedKey]?.edited &&
				!overwriteEditedValues
			) {
				if (!overrideFlagSet) {
					let response = ``;
					const rl = createInterface({
						input: process.stdin,
						output: process.stdout,
					});

					while (![`skip`, `overwrite`].includes(response)) {
						// eslint-disable-next-line no-await-in-loop
						response = await rl.question(
							styleText(
								[`red`, `italic`, `bold`],
								// eslint-disable-next-line @stylistic/max-len
								`Some translations are marked as having been manually edited. Do you want to retranslate these? This may overwrite human-translated or validated text. Type "overwrite" to overwrite them, or "skip" to skip them: `
							)
						);

						if (response === `overwrite`) {
							overrideFlagSet = true;
							overwriteEditedValues = true;
						} else if (response === `skip`) {
							overrideFlagSet = true;
							overwriteEditedValues = false;
						}

						if ([`overwrite`, `skip`].includes(response))
							console.log(
								`OK -- when edited values are found, the script will ${response} them`
							);
					}
				}

				if (!overwriteEditedValues) {
					matches = rxTransFn.exec(contents);
					continue;
				}
			}

			// eslint-disable-next-line no-await-in-loop
			const translation = await translate(replacedKey, { to: lang });
			if (key && translation)
				translations[langCode][replacedKey] = { value: translation };
			matches = rxTransFn.exec(contents);
		}
	}
}

console.log(
	styleText([`blue`, `bold`], `\nTranslations complete. Writing files...`)
);

for (const [langCode, translation] of Object.entries(translations)) {
	console.log(styleText([`green`, `bold`], `\tWriting ${langCode}...`));

	writeFileSync(
		join(translationsPath, `${langCode}.json`),
		// eslint-disable-next-line no-await-in-loop
		await JSON.stringify(translation)
	);
}

console.log(
	styleText([`blue`, `bold`], `\nTranslations compiled successfully!`)
);

process.exit();
