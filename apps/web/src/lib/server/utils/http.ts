import type { z } from "zod";

export async function parseJsonBody<TSchema extends z.ZodTypeAny>(request: Request, schema: TSchema) {
  const payload = await request.json();
  return schema.parse(payload);
}

export function jsonResponse(payload: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {})
    }
  });
}

export function getClientIp(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "0.0.0.0"
  );
}

export function getUserAgent(request: Request) {
  return request.headers.get("user-agent") ?? "unknown";
}
