#!/bin/sh
# Railway entrypoint — dispatches to web or worker based on RAILWAY_SERVICE_NAME.
# Build command is shared (pnpm --filter @agentic-funnel/web build) — worker ignores
# the web dist, web uses it. Saves us from per-service config files (which
# Railway only honors via dashboard "Config-as-code Path", not env vars).
set -e

case "$RAILWAY_SERVICE_NAME" in
  worker)
    echo "[start.sh] Booting worker (pg-boss + outbox processor)"
    echo "[start.sh] node $(node --version), pnpm $(pnpm --version 2>/dev/null || echo missing)"
    # Run node directly (not through `pnpm start`) so child stderr isn't
    # swallowed by the pnpm wrapper — we need real stack traces on boot crash.
    cd apps/worker
    exec node --import tsx src/index.ts
    ;;
  *)
    echo "[start.sh] Booting web (Astro SSR via @astrojs/node)"
    exec node apps/web/dist/server/entry.mjs
    ;;
esac
