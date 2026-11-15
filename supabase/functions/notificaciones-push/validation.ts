export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };

// Restrict outgoing requests to known browser push providers; never follow redirects.
export function validEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return false;
    const host = u.hostname;
    return (host === 'fcm.googleapis.com' && u.pathname.startsWith('/fcm/send/')) ||
      (host.endsWith('.push.services.mozilla.com') && u.pathname.startsWith('/wpush/')) ||
      (host === 'web.push.apple.com' && u.pathname.length > 1) ||
      (host.endsWith('.notify.windows.com') && u.pathname.length > 1);
  } catch { return false; }
}

function keyBytes(value: unknown, length: number): Uint8Array | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    return bytes.length === length ? bytes : null;
  } catch { return null; }
}

export function validSubscription(value: unknown): value is Subscription {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<Subscription>;
  return validEndpoint(s.endpoint) && !!s.keys &&
    keyBytes(s.keys.p256dh, 65)?.[0] === 4 && !!keyBytes(s.keys.auth, 16);
}

export function sameSecret(expected: string | undefined, supplied: string | null): boolean {
  if (!expected || expected.length < 32 || !supplied || expected.length !== supplied.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return difference === 0;
}
