import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// The legacy Worker under cloudflare-worker/ has its own tests and its own runner.
		include: ['test/**/*.spec.ts'],
	},
});
