import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['client/src/**/*.test.ts', 'tests/**/*.test.js'],
    environment: 'node',
    deps: {
      // Transform project source files through vitest's pipeline.
      // CJS mock interception for auto-preflight.js and preflight-loop.js
      // is handled via proxyquire (not vi.mock), which patches Node's CJS
      // require() at load time and reliably intercepts nested require() calls.
      inline: [/^(?!.*node_modules)/],
    },
  },
})
