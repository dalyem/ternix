import { describe, expect, it, vi } from 'vitest';
import {
  confirmHostKey,
  confirmMember,
  confirmNewHosts,
  type HostKeyFacts,
  type MessageBoxRequest,
} from '../src/main/app/trust.js';

const unknown: HostKeyFacts = {
  hopLabel: 'box',
  hopIndex: 0,
  hopTotal: 1,
  host: 'box.example.com',
  port: 2222,
  keyType: 'ssh-ed25519',
  fingerprint: 'SHA256:abc',
  status: 'unknown',
};
const mismatch: HostKeyFacts = {
  ...unknown,
  status: 'mismatch',
  stored: { keyType: 'ssh-ed25519', fingerprint: 'SHA256:old' },
};

function box(response: number, checkboxChecked = false) {
  const asked: MessageBoxRequest[] = [];
  const fn = vi.fn(async (request: MessageBoxRequest) => {
    asked.push(request);
    return { response, checkboxChecked };
  });
  return { fn, asked };
}

describe('native trust dialogs', () => {
  it('show the host facts, default to deny, and trust only on the approve button', async () => {
    const yes = box(1);
    expect(await confirmHostKey(yes.fn, unknown)).toBe('trust');
    const [request] = yes.asked;
    expect(request!.message).toContain('box.example.com:2222');
    expect(request!.detail).toContain('ssh-ed25519');
    expect(request!.detail).toContain('SHA256:abc');
    expect(request!.defaultId).toBe(0);
    expect(request!.cancelId).toBe(0);
    expect(request!.buttons[0]).toBe('Cancel');
    expect(await confirmHostKey(box(0).fn, unknown)).toBe('reject');
  });

  it('replace a changed key only with the approve button and the checkbox', async () => {
    const asked = box(1, false);
    expect(await confirmHostKey(asked.fn, mismatch)).toBe('reject');
    expect(asked.asked[0]!.detail).toContain('SHA256:old');
    expect(asked.asked[0]!.buttons[asked.asked[0]!.defaultId]).toBe('Disconnect');
    expect(await confirmHostKey(box(1, true).fn, mismatch)).toBe('replace');
    expect(await confirmHostKey(box(0, true).fn, mismatch)).toBe('reject');
  });

  it('deny when the dialog is aborted or fails', async () => {
    const abort = new AbortController();
    abort.abort();
    const never = box(1);
    expect(await confirmHostKey(never.fn, unknown, abort.signal)).toBe('reject');
    expect(never.fn).not.toHaveBeenCalled();

    const late = new AbortController();
    const slow = vi.fn(async () => {
      late.abort();
      return { response: 1, checkboxChecked: false };
    });
    expect(await confirmHostKey(slow, unknown, late.signal)).toBe('reject');
    const broken = vi.fn(async () => {
      throw new Error('no window');
    });
    expect(await confirmHostKey(broken, unknown)).toBe('reject');
  });

  it('show the email and fingerprint of a member, and default to cancel', async () => {
    const who = { email: 'bob@example.com', name: 'Bob', fingerprint: 'ab12 cd34' };
    for (const action of [
      { kind: 'add' as const, vaultName: 'Team', role: 'editor' as const },
      { kind: 'accept' as const, pinnedFingerprint: 'ff00 ee11' },
      { kind: 'verify' as const },
    ]) {
      const no = box(0);
      expect(await confirmMember(no.fn, who, action)).toBe(false);
      const request = no.asked[0]!;
      expect(`${request.message}\n${request.detail}`).toContain('bob@example.com');
      expect(request.detail).toContain('ab12 cd34');
      expect(request.defaultId).toBe(request.cancelId);
      expect(request.buttons[request.cancelId]).toBe('Cancel');
      expect(await confirmMember(box(1).fn, who, action)).toBe(true);
    }
  });
});

describe('new host dialog', () => {
  it('shows the address verbatim, defaults to Cancel, and approves only on Connect', async () => {
    const long = `${'a'.repeat(60)}.secret-in-the-name.attacker.example`;
    const yes = box(1);
    expect(await confirmNewHosts(yes.fn, [{ host: long, port: 22, isNew: true }])).toBe(true);
    const [request] = yes.asked;
    expect(request!.title).toBe('Connect to a new host?');
    expect(request!.message).toContain(`${long}:22`);
    expect(request!.buttons[request!.defaultId]).toBe('Cancel');
    expect(request!.cancelId).toBe(request!.defaultId);
    expect(await confirmNewHosts(box(0).fn, [{ host: long, port: 22, isNew: true }])).toBe(false);
  });

  it('lists a jump route in order and marks the new hops', async () => {
    const asked = box(1);
    await confirmNewHosts(asked.fn, [
      { host: 'jump.example.com', port: 22, isNew: false },
      { host: '2001:db8::1', port: 2222, isNew: true },
    ]);
    expect(asked.asked[0]!.detail).toContain(
      '1. jump.example.com:22 (jump host)\n2. [2001:db8::1]:2222 (target, new)',
    );
  });

  it('cannot be given extra lines or hidden text by the address', async () => {
    const asked = box(1);
    await confirmNewHosts(asked.fn, [
      { host: 'evil.example\nTrusted yes\u202e', port: 22, isNew: true },
    ]);
    const shown = asked.asked[0]!.message + asked.asked[0]!.detail;
    expect(shown).not.toContain('\u202e');
    expect(shown).toContain('evil.example\\u{a}Trusted yes\\u{202e}:22');
  });

  it('does not ask when every hop is known, and denies when aborted', async () => {
    const never = box(1);
    expect(await confirmNewHosts(never.fn, [{ host: 'a', port: 22, isNew: false }])).toBe(true);
    expect(never.fn).not.toHaveBeenCalled();
    const abort = new AbortController();
    abort.abort();
    expect(
      await confirmNewHosts(box(1).fn, [{ host: 'a', port: 22, isNew: true }], abort.signal),
    ).toBe(false);
  });
});
