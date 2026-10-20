import { beforeAll, describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  ERROR_STATUS,
  addMemberRequestSchema,
  batchRequestSchema,
  batchResultSchema,
  buildPath,
  changePasswordRequestSchema,
  createVaultRequestSchema,
  deleteItemQuerySchema,
  emailSchema,
  encryptItem,
  encryptVaultName,
  envelopeSchema,
  errorEnvelopeSchema,
  generateAccountKeypair,
  itemConflictResponseSchema,
  itemSchema,
  kdfParamsSchema,
  listItemsQuerySchema,
  listItemsResponseSchema,
  listVaultsResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  newKdfParams,
  newVaultKey,
  putItemRequestSchema,
  ready,
  registerRequestSchema,
  rotateRequestSchema,
  routes,
  seal,
  serverInfoSchema,
  toB64,
  userSchema,
  uuidSchema,
  vaultSchema,
  wrapVaultKey,
  wsClientMessageSchema,
  wsServerMessageSchema,
  type RouteName,
} from '../src/index.js';
import { ITEM_ID, NOW, OTHER_ITEM_ID, TEST_KDF_LIMITS, USER_ID, VAULT_ID } from './helpers.js';

let envelope: string;
let wrappedKey: string;
let publicKey: string;
let authKey: string;
let kdf: ReturnType<typeof newKdfParams>;

beforeAll(async () => {
  await ready();
  const vaultKey = newVaultKey();
  const keypair = generateAccountKeypair();
  envelope = encryptVaultName(vaultKey, VAULT_ID, 'Personal');
  wrappedKey = wrapVaultKey(vaultKey, keypair.publicKey);
  publicKey = toB64(keypair.publicKey);
  authKey = toB64(newVaultKey());
  kdf = newKdfParams(TEST_KDF_LIMITS);
});

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(true);
const bad = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);

describe('primitive schemas', () => {
  it('accepts only lowercase UUIDv4', () => {
    ok(uuidSchema, VAULT_ID);
    bad(uuidSchema, VAULT_ID.toUpperCase());
    bad(uuidSchema, '3f2b8c1e-5d4a-1b7e-9c10-2a6f8e1d0b34'); // version 1
    bad(uuidSchema, '3f2b8c1e-5d4a-4b7e-0c10-2a6f8e1d0b34'); // bad variant
    bad(uuidSchema, 'nope');
  });

  it('normalises emails before validating', () => {
    expect(emailSchema.parse('  Alice@Example.COM ')).toBe('alice@example.com');
    bad(emailSchema, 'not an email');
    bad(emailSchema, '');
  });

  it('accepts only v1 envelopes', () => {
    ok(envelopeSchema, envelope);
    bad(envelopeSchema, envelope.slice(3));
    bad(envelopeSchema, 'v1.');
    bad(envelopeSchema, 'v1.AAAA');
    bad(envelopeSchema, 'v2.' + envelope.slice(3));
    bad(envelopeSchema, envelope + '!');
  });

  it('accepts kdf params within bounds only', () => {
    ok(kdfParamsSchema, kdf);
    bad(kdfParamsSchema, { ...kdf, alg: 'argon2i13' });
    bad(kdfParamsSchema, { ...kdf, salt: toB64(new Uint8Array(15)) });
    bad(kdfParamsSchema, { ...kdf, opslimit: 0 });
    bad(kdfParamsSchema, { ...kdf, opslimit: 1000 });
    bad(kdfParamsSchema, { ...kdf, memlimit: 1024 });
    bad(kdfParamsSchema, { ...kdf, memlimit: 2 ** 40 });
    bad(kdfParamsSchema, { ...kdf, memlimit: 65_536.5 });
  });
});

describe('errors', () => {
  it('lists the documented codes and a status for each', () => {
    expect([...ERROR_CODES]).toEqual([
      'bad_request',
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'rate_limited',
      'registration_closed',
      'invalid_invite',
      'email_taken',
      'key_version_mismatch',
      'internal',
    ]);
    for (const code of ERROR_CODES) expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(ERROR_STATUS.unauthorized).toBe(401);
    expect(ERROR_STATUS.not_found).toBe(404);
    expect(ERROR_STATUS.conflict).toBe(409);
  });

  it('validates the envelope', () => {
    ok(errorEnvelopeSchema, { error: { code: 'conflict', message: 'x' } });
    bad(errorEnvelopeSchema, { error: { code: 'teapot', message: 'x' } });
    bad(errorEnvelopeSchema, { error: { code: 'conflict' } });
    bad(errorEnvelopeSchema, { code: 'conflict', message: 'x' });
  });
});

describe('auth', () => {
  const device = { name: 'laptop', platform: 'linux' };
  const register = () => ({
    email: 'Alice@Example.com',
    name: 'Alice',
    kdf,
    auth_key: authKey,
    public_key: publicKey,
    encrypted_private_key: envelope,
    personal_vault: { id: VAULT_ID, name_enc: envelope, wrapped_key: wrappedKey },
    device,
  });
  const user = () => ({
    id: USER_ID,
    email: 'alice@example.com',
    name: 'Alice',
    role: 'admin',
    public_key: publicKey,
    created_at: NOW,
  });

  it('server info', () => {
    ok(serverInfoSchema, { name: 'Ternix', version: '0.1.0', registration: 'invite', protocol: 1 });
    bad(serverInfoSchema, { name: 'Ternix', version: '0.1.0', registration: 'maybe', protocol: 1 });
    bad(serverInfoSchema, { name: 'Ternix', version: '0.1.0', registration: 'open', protocol: 2 });
  });

  it('register request', () => {
    ok(registerRequestSchema, register());
    ok(registerRequestSchema, { ...register(), invite_code: 'abc' });
    expect(registerRequestSchema.parse(register()).email).toBe('alice@example.com');
    bad(registerRequestSchema, { ...register(), auth_key: toB64(new Uint8Array(31)) });
    bad(registerRequestSchema, { ...register(), public_key: 'AAAA' });
    bad(registerRequestSchema, { ...register(), personal_vault: undefined });
    bad(registerRequestSchema, {
      ...register(),
      personal_vault: { id: VAULT_ID, name_enc: envelope, wrapped_key: publicKey },
    });
    bad(registerRequestSchema, { ...register(), device: { name: '', platform: 'linux' } });
    bad(registerRequestSchema, { ...register(), name: '   ' });
  });

  it('login request and response', () => {
    ok(loginRequestSchema, { email: 'a@example.com', auth_key: authKey, device });
    bad(loginRequestSchema, { email: 'a@example.com', device });
    const response = {
      token: 'opaque',
      user: user(),
      device_id: OTHER_ITEM_ID,
      keys: { public_key: publicKey, encrypted_private_key: envelope, kdf },
    };
    ok(loginResponseSchema, response);
    bad(loginResponseSchema, { ...response, keys: undefined });
    bad(loginResponseSchema, { ...response, token: '' });
  });

  it('user and password change', () => {
    ok(userSchema, user());
    bad(userSchema, { ...user(), role: 'root' });
    const change = {
      current_auth_key: authKey,
      new_auth_key: authKey,
      new_kdf: kdf,
      new_encrypted_private_key: envelope,
    };
    ok(changePasswordRequestSchema, change);
    bad(changePasswordRequestSchema, { ...change, new_kdf: undefined });
  });
});

describe('vaults', () => {
  const vault = () => ({
    id: VAULT_ID,
    kind: 'personal',
    name_enc: envelope,
    key_version: 1,
    role: 'owner',
    wrapped_key: wrappedKey,
    seq: 0,
    member_count: 1,
  });

  it('vault list', () => {
    ok(listVaultsResponseSchema, { vaults: [vault()] });
    bad(listVaultsResponseSchema, { vaults: [{ ...vault(), kind: 'secret' }] });
    bad(vaultSchema, { ...vault(), key_version: 0 });
    bad(vaultSchema, { ...vault(), role: 'admin' });
  });

  it('create vault and add member', () => {
    ok(createVaultRequestSchema, { id: VAULT_ID, name_enc: envelope, wrapped_key: wrappedKey });
    bad(createVaultRequestSchema, { id: 'x', name_enc: envelope, wrapped_key: wrappedKey });
    const add = { user_id: USER_ID, role: 'viewer', wrapped_key: wrappedKey, key_version: 2 };
    ok(addMemberRequestSchema, add);
    bad(addMemberRequestSchema, { ...add, role: 'admin' });
    bad(addMemberRequestSchema, { ...add, key_version: undefined });
  });

  it('rotate request', () => {
    const rotate = {
      key_version: 2,
      name_enc: envelope,
      members: [{ user_id: USER_ID, wrapped_key: wrappedKey }],
      items: [{ id: ITEM_ID, ciphertext: envelope }],
    };
    ok(rotateRequestSchema, rotate);
    ok(rotateRequestSchema, { ...rotate, items: [] });
    bad(rotateRequestSchema, { ...rotate, key_version: 1 });
    bad(rotateRequestSchema, { ...rotate, items: [{ id: ITEM_ID }] });
  });
});

describe('items and sync', () => {
  const live = () => ({
    id: ITEM_ID,
    vault_id: VAULT_ID,
    seq: 7,
    deleted: false,
    ciphertext: envelope,
    key_version: 1,
    updated_at: NOW,
    updated_by: USER_ID,
  });
  const tombstone = () => ({ ...live(), deleted: true, ciphertext: null });

  it('live items and tombstones', () => {
    ok(itemSchema, live());
    ok(itemSchema, tombstone());
    bad(itemSchema, { ...live(), ciphertext: null });
    bad(itemSchema, { ...tombstone(), ciphertext: envelope });
    bad(itemSchema, { ...live(), seq: -1 });
  });

  it('list items', () => {
    ok(listItemsResponseSchema, { items: [live(), tombstone()], next_since: 7, has_more: false });
    expect(listItemsQuerySchema.parse({})).toEqual({ since: 0, limit: 500 });
    expect(listItemsQuerySchema.parse({ since: '12', limit: '1000' })).toEqual({
      since: 12,
      limit: 1000,
    });
    bad(listItemsQuerySchema, { limit: '1001' });
    bad(listItemsQuerySchema, { limit: '0' });
    bad(listItemsQuerySchema, { since: '-1' });
    bad(listItemsQuerySchema, { since: 'abc' });
  });

  it('put item', () => {
    ok(putItemRequestSchema, { ciphertext: envelope, key_version: 1, base_seq: null });
    ok(putItemRequestSchema, { ciphertext: envelope, key_version: 1, base_seq: 4 });
    bad(putItemRequestSchema, { ciphertext: envelope, key_version: 1 });
    bad(putItemRequestSchema, { ciphertext: 'plaintext', key_version: 1, base_seq: null });
  });

  it('delete item and conflict body', () => {
    expect(deleteItemQuerySchema.parse({ base_seq: '3' })).toEqual({ base_seq: 3 });
    bad(deleteItemQuerySchema, {});
    ok(itemConflictResponseSchema, {
      error: { code: 'conflict', message: 'stale' },
      current: live(),
    });
    bad(itemConflictResponseSchema, { error: { code: 'conflict', message: 'stale' } });
  });

  it('batch', () => {
    const put = { op: 'put', id: ITEM_ID, ciphertext: envelope, key_version: 1, base_seq: null };
    const del = { op: 'delete', id: OTHER_ITEM_ID, base_seq: 3 };
    ok(batchRequestSchema, { ops: [put, del] });
    bad(batchRequestSchema, { ops: [] });
    bad(batchRequestSchema, { ops: [{ op: 'put', id: ITEM_ID, base_seq: null }] });
    bad(batchRequestSchema, { ops: [{ op: 'rename', id: ITEM_ID, base_seq: 1 }] });
    bad(batchRequestSchema, { ops: Array.from({ length: 501 }, () => del) });
    ok(batchRequestSchema, { ops: Array.from({ length: 500 }, () => del) });

    ok(batchResultSchema, { id: ITEM_ID, status: 'ok', item: live() });
    ok(batchResultSchema, { id: ITEM_ID, status: 'conflict', current: live() });
    ok(batchResultSchema, {
      id: ITEM_ID,
      status: 'error',
      error: { code: 'forbidden', message: 'no' },
    });
    bad(batchResultSchema, { id: ITEM_ID, status: 'ok' });
  });

  it('item ciphertext from encryptItem satisfies the envelope schema', () => {
    const ciphertext = encryptItem(newVaultKey(), VAULT_ID, ITEM_ID, {
      type: 'snippet',
      updated_at: NOW,
      label: 's',
      script: 'ls',
    });
    ok(envelopeSchema, ciphertext);
    ok(envelopeSchema, seal(newVaultKey(), '', 'ad'));
  });
});

describe('websocket messages', () => {
  it('client messages', () => {
    ok(wsClientMessageSchema, { type: 'auth', token: 't' });
    ok(wsClientMessageSchema, { type: 'ping' });
    bad(wsClientMessageSchema, { type: 'auth' });
    bad(wsClientMessageSchema, { type: 'pong' });
  });

  it('server messages', () => {
    ok(wsServerMessageSchema, { type: 'ready' });
    ok(wsServerMessageSchema, { type: 'pong' });
    ok(wsServerMessageSchema, { type: 'vault.changed', vault_id: VAULT_ID, seq: 3 });
    ok(wsServerMessageSchema, { type: 'vaults.changed' });
    ok(wsServerMessageSchema, { type: 'session.revoked' });
    bad(wsServerMessageSchema, { type: 'vault.changed', vault_id: VAULT_ID });
    bad(wsServerMessageSchema, { type: 'vault.changed', vault_id: 'x', seq: 3 });
    bad(wsServerMessageSchema, { type: 'ping' });
  });
});

describe('routes', () => {
  it('describes every endpoint of the protocol', () => {
    const entries = Object.entries(routes).map(([, r]) => `${r.method} ${r.path}`);
    expect(entries.sort()).toEqual(
      [
        'GET /api/v1/server',
        'POST /api/v1/auth/prelogin',
        'POST /api/v1/auth/register',
        'POST /api/v1/auth/login',
        'POST /api/v1/auth/logout',
        'GET /api/v1/me',
        'POST /api/v1/me/password',
        'GET /api/v1/devices',
        'DELETE /api/v1/devices/:id',
        'GET /api/v1/users/lookup',
        'POST /api/v1/admin/invites',
        'GET /api/v1/admin/invites',
        'DELETE /api/v1/admin/invites/:code',
        'GET /api/v1/admin/users',
        'DELETE /api/v1/admin/users/:id',
        'GET /api/v1/vaults',
        'POST /api/v1/vaults',
        'PATCH /api/v1/vaults/:id',
        'DELETE /api/v1/vaults/:id',
        'GET /api/v1/vaults/:id/members',
        'POST /api/v1/vaults/:id/members',
        'PATCH /api/v1/vaults/:id/members/:user_id',
        'DELETE /api/v1/vaults/:id/members/:user_id',
        'POST /api/v1/vaults/:id/rotate',
        'GET /api/v1/vaults/:id/items',
        'PUT /api/v1/vaults/:id/items/:item_id',
        'DELETE /api/v1/vaults/:id/items/:item_id',
        'POST /api/v1/vaults/:id/items/batch',
        'GET /api/v1/ws',
      ].sort(),
    );
    const name: RouteName = 'putItem';
    expect(routes[name].method).toBe('PUT');
  });

  it('builds paths with encoded params and query strings', () => {
    expect(buildPath(routes.putItem.path, { id: VAULT_ID, item_id: ITEM_ID })).toBe(
      `/api/v1/vaults/${VAULT_ID}/items/${ITEM_ID}`,
    );
    expect(buildPath(routes.listItems.path, { id: VAULT_ID }, { since: 5, limit: undefined })).toBe(
      `/api/v1/vaults/${VAULT_ID}/items?since=5`,
    );
    expect(buildPath(routes.deleteInvite.path, { code: 'a/b c' })).toBe(
      '/api/v1/admin/invites/a%2Fb%20c',
    );
    expect(buildPath(routes.lookupUser.path, undefined, { email: 'a+b@example.com' })).toBe(
      '/api/v1/users/lookup?email=a%2Bb%40example.com',
    );
  });
});
