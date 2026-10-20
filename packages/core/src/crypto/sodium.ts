import sodium from 'libsodium-wrappers-sumo';

/** Thrown for every cryptographic failure: bad key, tampering, wrong AD, malformed input. */
export class CryptoError extends Error {
  override name = 'CryptoError';
}

let initialised = false;

/**
 * Initialise libsodium. Await this once at startup. Every other function in this
 * module (except the async `deriveKeys`, which awaits it itself) throws until then.
 */
export async function ready(): Promise<void> {
  await sodium.ready;
  initialised = true;
}

export function getSodium(): typeof sodium {
  if (!initialised) throw new CryptoError('libsodium is not ready: await ready() first');
  return sodium;
}

export function requireLength(name: string, bytes: Uint8Array, length: number): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new CryptoError(`${name} must be ${length} bytes`);
  }
}
