import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agentic-funnel/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      "@agentic-funnel/shared/crypto": fileURLToPath(new URL("./packages/shared/src/crypto.ts", import.meta.url)),
      "@agentic-funnel/db": fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
