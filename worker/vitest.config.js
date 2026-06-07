import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
			"test/index.spec.js",
			"test/openaiRoutes.spec.js",
			"test/callManager.test.js",
			"test/validator.test.js",
			"test/healthCheck.test.js",
			"test/requestQueue.test.js",
			"test/fallback.test.js",
			"test/textRenderer.test.js",
			"test/imageExporter.test.js",
			"test/aiPromptMode.spec.js",
			"test/recentsRoute.test.js",
		],
	},
});
