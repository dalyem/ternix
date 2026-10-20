import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes, base64url. Only `hashToken(token)` is ever stored. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A single-use invite code. */
export function newInviteCode(): string {
  return randomBytes(18).toString('base64url');
}
