/**
 * Pure helpers for the `b64` wire format: standard base64 with padding.
 * No libsodium here, so the protocol schemas stay usable without `ready()`.
 */

const B64_BODY = '(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?';

/** Matches any (possibly empty) standard padded base64 string. */
export const B64_RE = new RegExp(`^${B64_BODY}$`);

/** Matches the padded base64 encoding of exactly `byteLength` bytes. */
export function b64Pattern(byteLength: number): RegExp {
  const full = Math.floor(byteLength / 3);
  const rest = byteLength % 3;
  const chars = full * 4;
  const tail = rest === 0 ? '' : rest === 1 ? '[A-Za-z0-9+/]{2}==' : '[A-Za-z0-9+/]{3}=';
  return new RegExp(`^[A-Za-z0-9+/]{${chars}}${tail}$`);
}

/** Length in characters of the padded base64 encoding of `byteLength` bytes. */
export function b64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}
