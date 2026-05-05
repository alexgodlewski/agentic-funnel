import { createDatabase, type DatabaseClient } from "@agentic-funnel/db";

import { webEnv } from "./env";

const database = createDatabase(webEnv.DATABASE_URL);

export const db = database.db;
export const dbPool = database.pool;

export type AppDb = DatabaseClient;
export type AppDbTx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];
