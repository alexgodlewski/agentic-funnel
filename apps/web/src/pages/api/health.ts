import type { APIRoute } from "astro";
import { sql } from "drizzle-orm";

import { db } from "../../lib/server/db";
import { jsonResponse } from "../../lib/server/utils/http";

export const GET: APIRoute = async () => {
  await db.execute(sql`select 1`);

  return jsonResponse({
    status: "ok",
    service: "web",
    timestamp: new Date().toISOString()
  });
};
