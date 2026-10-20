import type { HostKeyDecision } from '../../shared/app.js';
import type { VaultRole } from '../../shared/types.js';

/**
 * Trust decisions the renderer must not be able to make on the user's behalf: accepting an
 * SSH host key, adding a vault member, accepting a member's changed key and marking a member
 * verified. Main opens a native dialog for each, with the facts it validated itself. The
 * deny button is the default and what Escape or closing the dialog answers.
 */

/** The subset of Electron's `MessageBoxOptions` these dialogs use. */
export interface MessageBoxRequest {
  type: 'question' | 'warning';
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: true;
  checkboxLabel?: string;
  /** Aborting closes the dialog as if the user cancelled. */
  signal?: AbortSignal;
}

export interface MessageBoxAnswer {
  response: number;
  checkboxChecked: boolean;
}

/** `dialog.showMessageBox` on the app window (a fake in tests). */
export type MessageBox = (request: MessageBoxRequest) => Promise<MessageBoxAnswer>;

/** What main knows about a host key the server presented. */
export interface HostKeyFacts {
  hopLabel: string;
  hopIndex: number;
  hopTotal: number;
  host: string;
  port: number;
  keyType: string;
  /** `SHA256:...` as OpenSSH prints it. */
  fingerprint: string;
  status: 'unknown' | 'mismatch';
  stored?: { keyType: string; fingerprint: string };
}

const DENY = 0;
const APPROVE = 1;

/** Ask, and count anything but an explicit approval (an error, an abort) as a no. */
async function approved(
  box: MessageBox,
  request: MessageBoxRequest,
): Promise<MessageBoxAnswer | null> {
  if (request.signal?.aborted) return null;
  try {
    const answer = await box(request);
    if (request.signal?.aborted || answer.response !== APPROVE) return null;
    return answer;
  } catch {
    return null;
  }
}

const hostPort = (facts: { host: string; port: number }) =>
  facts.host.includes(':') ? `[${facts.host}]:${facts.port}` : `${facts.host}:${facts.port}`;

export async function confirmHostKey(
  box: MessageBox,
  facts: HostKeyFacts,
  signal?: AbortSignal,
): Promise<HostKeyDecision> {
  const via =
    facts.hopTotal > 1
      ? ` (${facts.hopLabel}, hop ${facts.hopIndex + 1} of ${facts.hopTotal})`
      : '';
  const key = `${facts.keyType} key fingerprint:\n${facts.fingerprint}`;
  if (facts.status === 'mismatch') {
    const stored = facts.stored
      ? `\n\nTrusted before (${facts.stored.keyType}):\n${facts.stored.fingerprint}`
      : '';
    const answer = await approved(box, {
      type: 'warning',
      title: 'Host key changed',
      message: `WARNING: the host key of ${hostPort(facts)} has changed${via}`,
      detail:
        `Someone may be intercepting your connection, or the server was reinstalled. Do not ` +
        `continue unless you know why it changed.\n\nNew ${key}${stored}`,
      buttons: ['Disconnect', 'Replace stored key and connect'],
      defaultId: DENY,
      cancelId: DENY,
      noLink: true,
      checkboxLabel: 'I know why the key changed and want to trust the new one.',
      ...(signal ? { signal } : {}),
    });
    return answer?.checkboxChecked ? 'replace' : 'reject';
  }
  const answer = await approved(box, {
    type: 'question',
    title: 'Trust this host?',
    message: `First connection to ${hostPort(facts)}${via}`,
    detail:
      `Check that this fingerprint matches the one the server reports (for example ` +
      `ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub on the server).\n\n${key}`,
    buttons: ['Cancel', 'Trust and connect'],
    defaultId: DENY,
    cancelId: DENY,
    noLink: true,
    ...(signal ? { signal } : {}),
  });
  return answer ? 'trust' : 'reject';
}

/** A person whose key is about to be trusted. `email` is what the server reported to main. */
export interface MemberFacts {
  email: string;
  name: string;
  /** Fingerprint of the key that will be pinned. */
  fingerprint: string;
}

export type MemberAction =
  | { kind: 'add'; vaultName: string; role: VaultRole }
  | { kind: 'accept'; pinnedFingerprint?: string }
  | { kind: 'verify' };

const compare = (who: MemberFacts) =>
  `Ask ${who.name || who.email} to read you their fingerprint (Sharing page, "Your ` +
  `fingerprint") over a call or in person. Continue only if it matches.`;

export async function confirmMember(
  box: MessageBox,
  who: MemberFacts,
  action: MemberAction,
): Promise<boolean> {
  const person = who.name ? `${who.name} <${who.email}>` : who.email;
  const fingerprint = `Fingerprint:\n${who.fingerprint}`;
  let request: MessageBoxRequest;
  switch (action.kind) {
    case 'add':
      request = {
        type: 'question',
        title: 'Share vault',
        message: `Give ${person} access to "${action.vaultName}" as ${action.role}?`,
        detail: `The server could swap in someone else's key. ${compare(who)}\n\n${fingerprint}`,
        buttons: ['Cancel', 'It matches, share'],
        defaultId: DENY,
        cancelId: DENY,
        noLink: true,
      };
      break;
    case 'accept':
      request = {
        type: 'warning',
        title: 'Encryption key changed',
        message: `Trust the new key of ${person}?`,
        detail:
          `This may be an attack: whoever controls the server can hand out a key of their own ` +
          `and read everything you share with ${who.email} afterwards. ${compare(who)}\n\n` +
          `New ${fingerprint}` +
          (action.pinnedFingerprint ? `\n\nPinned earlier:\n${action.pinnedFingerprint}` : ''),
        buttons: ['Cancel', 'I verified the new fingerprint'],
        defaultId: DENY,
        cancelId: DENY,
        noLink: true,
      };
      break;
    case 'verify':
      request = {
        type: 'question',
        title: 'Mark key as verified',
        message: `Mark the key of ${person} as verified?`,
        detail: `${compare(who)}\n\n${fingerprint}`,
        buttons: ['Cancel', 'It matches, mark verified'],
        defaultId: DENY,
        cancelId: DENY,
        noLink: true,
      };
      break;
  }
  return (await approved(box, request)) !== null;
}
