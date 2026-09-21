const DEFAULT_BASE_URL = "https://zsign.io";

// Call sites append `/api/v1/...` themselves, so the base is an origin. The
// zSign API reference page quoted the base URL as https://zsign.io/api — strip
// a trailing /api (or /api/v1) so a value that already carries the API prefix
// doesn't produce /api/api/v1/.
export function resolveBaseUrl(configured: string | undefined): string {
  const base = configured?.trim() || DEFAULT_BASE_URL;
  return base.replace(/\/+$/, "").replace(/\/api(\/v1)?$/, "");
}
