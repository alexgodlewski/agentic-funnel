import { createDatabase, type DatabaseClient } from "@agentic-funnel/db";

import { workerEnv } from "./env";

const database = createDatabase(workerEnv.DATABASE_URL);

export const db = database.db;
export const dbPool = database.pool;

export type WorkerDb = DatabaseClient;
export type WorkerDbTx = Parameters<Parameters<WorkerDb["transaction"]>[0]>[0];
