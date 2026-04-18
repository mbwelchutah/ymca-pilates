import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['client/src/**/*.test.ts', 'client/src/**/*.test.tsx', 'tests/**/*.test.js'],
    environment: 'node',
    // Run test FILES sequentially (still parallel WITHIN a file).
    // Several tests spawn the real server (src/web/server.js) on a unique
    // port to exercise the HTTP API.  Even though ports differ, those
    // servers share data/app.db, data/auth-state.json, seed-jobs.json,
    // and the PostgreSQL connection — running them concurrently causes
    // file-write races that show up as flaky failures (e.g. api-failures-
    // history-reset and destructive-endpoints-method failing only in full-
    // suite runs).  Sequential file execution costs ~5-10 s and removes
    // the flake.
    fileParallelism: false,
    deps: {
      // Transform project source files through vitest's pipeline.
      // CJS mock interception for auto-preflight.js and preflight-loop.js
      // is handled via proxyquire (not vi.mock), which patches Node's CJS
      // require() at load time and reliably intercepts nested require() calls.
      inline: [/^(?!.*node_modules)/],
    },
  },
})
