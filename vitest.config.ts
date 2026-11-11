import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const vitestShim = fileURLToPath(
	new URL('./test/vitest-shim.ts', import.meta.url),
)

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^vitest$/,
				replacement: vitestShim,
			},
		],
	},
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
		// Worker globals and this alias avoid a second Vitest
		// copy on Windows (drive-letter case). Tests can still
		// `import { describe } from 'vitest'`.
		globals: true,
	},
})
