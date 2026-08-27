import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ['tests/**/*.spec.ts', 'packages/*/tests/**/*.spec.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['vendor/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
    },
  },
})
