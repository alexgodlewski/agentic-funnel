type ExtractedClientMeta = {
  ip?: string;
  userAgent?: string;
  fbp?: string;
  fbc?: string;
};

function readCookie(cookieHeader: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function extractClientMeta(request: Request): ExtractedClientMeta {
  const headers = request.headers;
  const ip =
    headers.get("cf-connecting-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headers.get("x-real-ip") ??
    undefined;
  const userAgent = headers.get("user-agent") ?? undefined;
  const cookieHeader = headers.get("cookie") ?? "";
  // Primary source is the buyer's `_fbp` / `_fbc` cookies. Fall back to the
  // explicit `x-meta-fbp` / `x-meta-fbc` headers the client sets on every
  // tracked request, so EMQ doesn't collapse if a reverse proxy strips cookies
  // before our app sees them.
  const fbp = readCookie(cookieHeader, "_fbp") ?? headers.get("x-meta-fbp") ?? undefined;
  const fbc = readCookie(cookieHeader, "_fbc") ?? headers.get("x-meta-fbc") ?? undefined;
  return { ip, userAgent, fbp: fbp || undefined, fbc: fbc || undefined };
}
