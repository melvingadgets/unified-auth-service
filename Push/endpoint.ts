// Which push endpoints auth will ever call (Shortwork/docs/notifications.md §8). Pure.
//
// A subscription's endpoint comes from the browser, so it is untrusted input that auth later
// POSTs to: without this check anyone signed in could make auth call an internal address. Only
// the browsers' own push services are allowed, over https on the default port.

export const DEFAULT_PUSH_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge, Android
  "updates.push.services.mozilla.com", // Firefox
  "*.push.apple.com", // Safari, and iPhone web apps added to the Home Screen
  "*.notify.windows.com", // older Edge on Windows
] as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_ENDPOINT_LENGTH = 2048;

/** `PUSH_ALLOWED_HOSTS`: comma-separated extra hosts, for tests and the e2e harness only. */
export const parseAllowedHosts = (raw: string | undefined): string[] =>
  String(raw ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

const hostMatches = (hostname: string, pattern: string): boolean =>
  pattern.startsWith("*.") ? hostname.endsWith(pattern.slice(1)) : hostname === pattern;

export const isAllowedPushEndpoint = (raw: unknown, extraHosts: readonly string[] = []): raw is string => {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_ENDPOINT_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (url.protocol === "https:") {
    if (url.port !== "") return false;
    return [...DEFAULT_PUSH_HOSTS, ...extraHosts].some((pattern) => hostMatches(host, pattern));
  }
  // Plain http only for a loopback host the environment names: a local test push service.
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(host) && extraHosts.includes(host);
};

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export class PushInputError extends Error {}

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

const decodedLength = (value: unknown): number | null =>
  typeof value === "string" && value.length <= 256 && BASE64URL.test(value) ? Buffer.from(value, "base64url").length : null;

/**
 * A browser PushSubscription's JSON ({ endpoint, keys: { p256dh, auth } }), checked: the endpoint
 * against the allow-list, p256dh as an uncompressed P-256 point (65 bytes) and auth as 16 bytes.
 */
export const parseSubscription = (body: unknown, extraHosts: readonly string[] = []): SubscriptionInput => {
  const input = (body && typeof body === "object" ? body : {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (!isAllowedPushEndpoint(input.endpoint, extraHosts)) throw new PushInputError("endpoint is not a supported push service");
  const p256dh = input.keys?.p256dh;
  const auth = input.keys?.auth;
  if (decodedLength(p256dh) !== 65 || Buffer.from(String(p256dh), "base64url")[0] !== 0x04) {
    throw new PushInputError("keys.p256dh must be a P-256 public key");
  }
  if (decodedLength(auth) !== 16) throw new PushInputError("keys.auth must be 16 bytes");
  return { endpoint: input.endpoint, keys: { p256dh: String(p256dh), auth: String(auth) } };
};

/** `{ endpoint }`, for removing a subscription. */
export const parseEndpoint = (body: unknown): string => {
  const endpoint = (body && typeof body === "object" ? (body as { endpoint?: unknown }).endpoint : undefined) ?? "";
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw new PushInputError("endpoint is required");
  }
  return endpoint;
};
