import http from "node:http";

import { JOB_NAMES } from "@agentic-funnel/shared";

import { getWorkerBoss } from "./lib/boss";
import { workerEnv } from "./lib/env";
import { shutdownPosthogClient } from "./lib/posthog";
import { processPendingOutbox } from "./jobs/outbox";
import { expireOpenFunnel } from "./jobs/funnel-expire";
import { queueFulfillmentEmail } from "./jobs/fulfillment";

async function startHealthServer() {
  const server = http.createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        status: "ok",
        service: "worker",
        timestamp: new Date().toISOString()
      })
    );
  });

  await new Promise<void>((resolve) => {
    server.listen(workerEnv.WORKER_HEALTH_PORT, resolve);
  });
}

async function main() {
  const boss = await getWorkerBoss();

  await boss.work(JOB_NAMES.EXPIRE_FUNNEL, async (jobs) => {
    for (const job of jobs) {
      await expireOpenFunnel(job.data as { orderId: string; funnelSessionId: string });
    }
  });

  await boss.work(JOB_NAMES.SEND_FULFILLMENT_EMAIL, async (jobs) => {
    for (const job of jobs) {
      await queueFulfillmentEmail(job.data as { orderId: string });
    }
  });

  setInterval(() => {
    void processPendingOutbox().catch((error) => {
      console.error("[worker] processPendingOutbox failed:", error);
    });
  }, 5000);

  await startHealthServer();
  await processPendingOutbox();
}

process.on("uncaughtException", (error) => {
  console.error("[worker] uncaughtException:", error);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandledRejection:", reason);
  process.exit(1);
});

let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received — draining boss + flushing PostHog`);
  // pg-boss first: lets in-flight handlers finish + releases their job locks
  // so the next worker doesn't see them as stuck in "processing".
  try {
    const boss = await getWorkerBoss();
    await boss.stop({ graceful: true });
  } catch (error) {
    console.error("[worker] pg-boss stop failed:", error);
  }
  try {
    await shutdownPosthogClient();
  } catch (error) {
    console.error("[worker] PostHog shutdown failed:", error);
  }
  process.exit(0);
}
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

main().catch((error) => {
  console.error("[worker] main() failed:", error);
  process.exitCode = 1;
});
