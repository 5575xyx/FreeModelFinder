import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  dts: false,
  clean: true,
  sourcemap: true,
  shims: true,
  // zen must be inlined too: verify-package.mjs rejects any surviving
  // @freemodelfinder/ import, and it pulls in CJS proxy agents that call
  // require('net'). The shim must bind the name `require` itself: esbuild's
  // fallback probes `typeof require !== "undefined"`, and a local createRequire
  // variable does not satisfy it. Aliased to avoid colliding with zen's own
  // import when it is inlined into this same bundle.
  noExternal: ['@freemodelfinder/core', '@freemodelfinder/server', '@freemodelfinder/zen'],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __fmfCreateRequire } from 'node:module';\nconst require = __fmfCreateRequire(import.meta.url);",
  },
});
