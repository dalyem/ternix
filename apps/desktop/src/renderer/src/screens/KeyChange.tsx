import { type ReactNode, useCallback, useState } from 'react';
import type { KeyChangeDto } from '../../../shared/types.js';
import { call, keyChangeOf } from '../api.js';
import { Button, ErrorText, Fingerprint, Modal, Notice, useAction } from '../ui.js';

/** A public key and its fingerprint, as the server reports it for one person. */
export interface ReportedKey {
  publicKey: string;
  fingerprint: string;
}

/**
 * Shown when the client refuses to wrap a vault key because a member's key is not the one
 * this device pinned (`member_key_changed`). Nothing was sent. The only way on is to compare
 * the new fingerprint with the person through another channel and accept it.
 */
export function KeyChangeDialog({
  change,
  resolveKey,
  onAccepted,
  onClose,
}: {
  change: KeyChangeDto;
  /** The key the server reports for the person now; its fingerprint must be the one shown. */
  resolveKey(): Promise<ReportedKey>;
  /** The new key is pinned as verified; the caller retries whatever was refused. */
  onAccepted(): void;
  onClose(): void;
}) {
  const action = useAction();
  const who = change.email || 'this person';
  const accept = () =>
    action.run(async () => {
      const key = await resolveKey();
      if (key.fingerprint !== change.serverFingerprint) {
        throw new Error(
          `The server now reports yet another key for ${who}. Close this dialog and start again.`,
        );
      }
      await call('vaults.acceptMemberKey', { userId: change.userId, publicKey: key.publicKey });
      onAccepted();
    });
  return (
    <Modal
      title="Encryption key changed"
      danger
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" busy={action.busy} onClick={() => void accept()}>
            I verified the new fingerprint with {who}
          </Button>
        </>
      }
    >
      <Notice tone="danger">
        <strong>The key of {who} is not the one this device saw before.</strong> Nothing was sent.
      </Notice>
      <dl className="facts">
        <dt>Pinned (earlier)</dt>
        <dd>
          <Fingerprint value={change.pinnedFingerprint} />
        </dd>
        <dt>Server reports now</dt>
        <dd>
          <Fingerprint value={change.serverFingerprint} />
        </dd>
      </dl>
      <p>
        This may be an attack: whoever controls the server can hand out a key of their own and read
        everything you share with {who} afterwards. It can also be harmless, for example when {who}{' '}
        registered their account again or lost their keys.
      </p>
      <p>
        Ask {who} for their fingerprint over a call or in person (Sharing page, “Your fingerprint”).
        Continue only if it matches the one the server reports now.
      </p>
      <ErrorText error={action.error} />
    </Modal>
  );
}

/**
 * Runs vault operations that wrap keys for members (rotation, adding a member). When one is
 * refused with `member_key_changed` it opens the key change dialog; accepting the key runs
 * the operation again, and a further changed key opens the dialog again.
 */
export function useKeyChangeGuard(resolve: (change: KeyChangeDto) => Promise<ReportedKey>) {
  const action = useAction();
  const { run: runAction } = action;
  const [pending, setPending] = useState<{
    change: KeyChangeDto;
    task: () => Promise<void>;
  } | null>(null);

  const run = useCallback(
    (task: () => Promise<void>) =>
      runAction(async () => {
        try {
          await task();
        } catch (err) {
          const change = keyChangeOf(err);
          if (!change) throw err;
          setPending({ change, task });
        }
      }),
    [runAction],
  );
  const open = useCallback(
    (change: KeyChangeDto, task: () => Promise<void>) => setPending({ change, task }),
    [],
  );

  const dialog: ReactNode = pending ? (
    <KeyChangeDialog
      change={pending.change}
      resolveKey={() => resolve(pending.change)}
      onAccepted={() => {
        const { task } = pending;
        setPending(null);
        void run(task);
      }}
      onClose={() => setPending(null)}
    />
  ) : null;

  return { run, open, busy: action.busy, error: action.error, dialog };
}
