import { PgBoss } from "pg-boss";
import { JOB_NAMES } from "@agentic-funnel/shared";

import { workerEnv } from "./env";

let bossPromise: Promise<PgBoss> | undefined;

async function ensureQueues(boss: PgBoss) {
  for (const queueName of Object.values(JOB_NAMES)) {
    const queue = await boss.getQueue(queueName);
    if (!queue) {
      await boss.createQueue(queueName);
    }
  }
}

export async function getWorkerBoss() {
  if (!bossPromise) {
    bossPromise = (async () => {
      const boss = new PgBoss({
        connectionString: workerEnv.DATABASE_URL
      });

      await boss.start();
      await ensureQueues(boss);
      return boss;
    })();
  }

  return bossPromise;
}
