import { generateAccountKeypair, newKdfParams, toB64 } from '../src/index.js';

/** Cheap Argon2 limits so tests stay fast. Never use these outside tests. */
export const TEST_KDF_LIMITS = { opslimit: 1, memlimit: 65_536 };

export const testKdf = () => newKdfParams(TEST_KDF_LIMITS);

export const VAULT_ID = '3f2b8c1e-5d4a-4b7e-9c10-2a6f8e1d0b34';
export const OTHER_VAULT_ID = '8a1d6e2c-9b3f-4c58-a7d1-0e4f5b6c7d89';
export const ITEM_ID = 'c4d5e6f7-1a2b-4c3d-8e9f-a0b1c2d3e4f5';
export const OTHER_ITEM_ID = 'd5e6f7a8-2b3c-4d4e-9fa0-b1c2d3e4f5a6';
export const USER_ID = 'e6f7a8b9-3c4d-4e5f-a0b1-c2d3e4f5a6b7';

export const NOW = '2026-10-20T12:00:00.000Z';

export function randomPublicKeyB64(): string {
  return toB64(generateAccountKeypair().publicKey);
}

/** Flip one base64 character in the middle of an envelope's body. */
export function tamper(envelope: string): string {
  const i = Math.floor((envelope.length + 3) / 2);
  const original = envelope[i]!;
  const replacement = original === 'A' ? 'B' : 'A';
  return envelope.slice(0, i) + replacement + envelope.slice(i + 1);
}
