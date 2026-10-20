// Size limits (docs/protocol.md section 7). Clients enforce them before sending.

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * Longest item `ciphertext` the server stores: the whole `v1.<base64>` envelope string, so
 * about 24 KiB of plaintext. Hosts, keys and snippets are far smaller.
 */
export const MAX_ITEM_CIPHERTEXT_LENGTH = 32 * KIB;

/** Most live (non-deleted) items one vault holds. Creating more is `409 vault_full`. */
export const MAX_LIVE_ITEMS_PER_VAULT = 5000;

/** Most operations in one batch request. */
export const MAX_BATCH_OPS = 500;

/**
 * JSON body limit of `POST /vaults/:id/rotate`. A full vault is
 * `MAX_LIVE_ITEMS_PER_VAULT` items of `MAX_ITEM_CIPHERTEXT_LENGTH` characters plus about 100
 * bytes of JSON each, roughly 157 MiB, which leaves room for member keys.
 */
export const MAX_ROTATE_BODY_BYTES = 200 * MIB;

/** JSON body limit of `POST /vaults/:id/items/batch` (500 maximal puts are about 16 MiB). */
export const MAX_BATCH_BODY_BYTES = 20 * MIB;

/** Default JSON body limit of every other endpoint. */
export const DEFAULT_BODY_LIMIT_BYTES = 1 * MIB;

/**
 * Marks the schema issue raised for an over-long item ciphertext (`params.code`), so the
 * server can answer `413 payload_too_large` instead of `400 bad_request`.
 */
export const PAYLOAD_TOO_LARGE_ISSUE = 'payload_too_large';
