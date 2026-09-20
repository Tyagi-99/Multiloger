/**
 * Log-safe secret redaction: scrub known secret values out of strings and
 * nested log payloads before they reach any logger, API response, or audit
 * sink. Matching is literal (never regex) so secrets containing regex
 * metacharacters are handled safely.
 */

export const REDACTED = '[REDACTED]';

/** Mask a secret for display. Never reveals any part of the secret. */
export function maskSecret(_secret: string): string {
  return REDACTED;
}

function activeSecrets(secrets: string[]): string[] {
  return [...new Set(secrets.filter((s) => s !== ''))].sort((a, b) => b.length - a.length);
}

/** Replace every occurrence of each non-empty secret with '[REDACTED]'. */
export function redactSecretsText(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of activeSecrets(secrets)) {
    // split/join: literal replacement, no regex escaping needed.
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Deep-clone a value, redacting any string that contains a secret.
 * Arrays and plain objects are cloned; other values pass through unchanged.
 */
export function redactSecretsDeep(value: unknown, secrets: string[]): unknown {
  const redact = activeSecrets(secrets);
  if (redact.length === 0) {
    return value;
  }
  const redactText = (text: string): string => {
    let out = text;
    for (const secret of redact) {
      out = out.split(secret).join(REDACTED);
    }
    return out;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return redactText(node);
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (typeof node === 'object' && node !== null) {
      const proto: unknown = Object.getPrototypeOf(node);
      if (proto !== Object.prototype && proto !== null) {
        return node;
      }
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(node)) {
        out[key] = walk(val);
      }
      return out;
    }
    return node;
  };
  return walk(value);
}
