import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fingerprint, fromB64 } from '@ternix/core/crypto';
import { MemberKeyChangedError, toErrorDto } from '../src/main/client/index.js';
import {
  closeClients,
  type Registered,
  registerUser,
  startServer,
  substituteKey,
  type TestServer,
} from './helpers.js';

let server: TestServer;

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  await closeClients();
  await server.close();
});

const idOf = (t: Registered): string => t.client.account!.user.id;
const fp = (publicKey: string): string => fingerprint(fromB64(publicKey));

async function share(owner: Registered, vaultId: string, member: Registered) {
  const found = await owner.client.lookupUser(member.email);
  return owner.client.addMember(vaultId, found.id, 'owner', found.publicKey);
}

describe('markMemberVerified', () => {
  it('refuses when the pinned key is not the one the user compared', async () => {
    const a = await registerUser(server, { realtime: false });
    const b = await registerUser(server, { realtime: false });
    const c = await registerUser(server, { realtime: false });
    const vault = await a.client.createVault('Team');
    await share(a, vault.id, b);
    await b.client.sync();
    await share(b, vault.id, c);

    // The user compares C's real fingerprint (from C's own device) ...
    const real = c.client.account!.user.publicKey;
    // ... while the server hands A another key, which A pins on first use.
    const evil = substituteKey(server, idOf(c));
    const listed = (await a.client.listMembers(vault.id)).find((m) => m.userId === idOf(c))!;
    expect(listed).toMatchObject({ publicKey: evil, verified: false });

    const err = await a.client.markMemberVerified(idOf(c), real).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemberKeyChangedError);
    expect(toErrorDto(err).keyChange).toEqual({
      userId: idOf(c),
      email: c.email,
      pinnedFingerprint: fp(evil),
      serverFingerprint: fp(real),
    });
    const after = (await a.client.listMembers(vault.id)).find((m) => m.userId === idOf(c))!;
    expect(after.verified).toBe(false);

    // Marking the key that is pinned works.
    await a.client.markMemberVerified(idOf(c), evil);
    const marked = (await a.client.listMembers(vault.id)).find((m) => m.userId === idOf(c))!;
    expect(marked.verified).toBe(true);
  });
});
