import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

const entryFile = fileURLToPath(new URL("./src/main.ts", import.meta.url));

export default defineConfig({
	publicDir: false,
	build: {
		lib: {
			entry: entryFile,
			name: "Translator",
			fileName: (format) => `translator.${format}.js`,
			formats: ["es", "cjs"],
		},
		rollupOptions: {
			// Declare external dependencies here when they are introduced.
			external: [],
		},
		copyPublicDir: false,
	},
});
