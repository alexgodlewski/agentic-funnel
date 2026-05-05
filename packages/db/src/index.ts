import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema";

export type DatabaseSchema = typeof schema;
export type DatabaseClient = ReturnType<typeof drizzle<DatabaseSchema>>;

export function createPgPool(connectionString: string) {
  return new pg.Pool({
    connectionString,
    max: 10
  });
}

export function createDatabase(connectionString: string) {
  const pool = createPgPool(connectionString);
  return {
    pool,
    db: drizzle(pool, { schema })
  };
}

export { schema };
