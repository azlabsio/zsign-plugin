const DEFAULT_BASE_URL = "https://zsign.io";

// Call sites append `/api/v1/...` themselves, so the base is an origin. The
// public docs quote the base URL as https://zsign.io/api (and llms.txt as
// https://zsign.io/api/v1) — strip either suffix so a value copied from them
// doesn't produce /api/api/v1/.
export function resolveBaseUrl(configured: string | undefined): string {
  const base = configured?.trim() || DEFAULT_BASE_URL;
  return base.replace(/\/+$/, "").replace(/\/api(\/v1)?$/, "");
}
