import { Copy } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ECDSA_KEY_BITS,
  type GeneratedKeyDto,
  type KeySpecInput,
  RSA_KEY_BITS,
} from '../../../shared/types.js';
import { call } from '../api.js';
import { canWrite, hostKeyFingerprint, labelOf, vaultTitle, writableVaults } from '../items.js';
import { refreshData, reportError, toast, useStore } from '../store.js';
import { Button, ErrorText, Field, Modal, Notice, Select, TextField, useAction } from '../ui.js';

/** The pieces of an `authorized_keys` line the UI cares about. */
function splitPublicKey(line: string): { type: string; wire: string } | null {
  const [type, wire] = line.trim().split(/\s+/);
  return type && wire && /^[A-Za-z0-9+/]+=*$/.test(wire) ? { type, wire } : null;
}

const KEY_TYPE_NAMES: Record<string, string> = {
  'ssh-ed25519': 'Ed25519',
  'ssh-rsa': 'RSA',
  'ecdsa-sha2-nistp256': 'ECDSA P-256',
  'ecdsa-sha2-nistp384': 'ECDSA P-384',
  'ecdsa-sha2-nistp521': 'ECDSA P-521',
};

/** `Ed25519`, `RSA`, ... for a public key line; null when there is no readable one. */
export function keyTypeName(publicKey: string | undefined): string | null {
  const parts = publicKey ? splitPublicKey(publicKey) : null;
  return parts ? (KEY_TYPE_NAMES[parts.type] ?? parts.type) : null;
}

/** SHA256 fingerprint of a public key line, worked out here from the line itself. */
function useFingerprint(publicKey: string): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const parts = splitPublicKey(publicKey);
    if (!parts) {
      setValue(null);
      return;
    }
    hostKeyFingerprint(parts.wire).then(
      (fp) => alive && setValue(fp),
      () => alive && setValue(null),
    );
    return () => void (alive = false);
  }, [publicKey]);
  return value;
}

function copyPublicKey(publicKey: string): void {
  call('clipboard.write', { text: publicKey.trim() }).then(
    () => toast('Public key copied to the clipboard.'),
    reportError,
  );
}

/**
 * The fingerprint of a public key line and a button that copies it. Renders nothing for text
 * that is not a public key, so a half-typed line shows no fingerprint.
 */
export function PublicKeyMeta({ publicKey }: { publicKey: string }) {
  const fingerprint = useFingerprint(publicKey);
  if (!fingerprint) return null;
  return (
    <div className="public-key-meta">
      <span className="muted">{keyTypeName(publicKey)} fingerprint</span>
      <code className="fingerprint">{fingerprint}</code>
      <Button size="md" icon={Copy} onClick={() => copyPublicKey(publicKey)}>
        Copy public key
      </Button>
    </div>
  );
}

/** A public key to read and copy (it is not a secret), as the result of generating one. */
function PublicKeyPanel({ publicKey }: { publicKey: string }) {
  const id = useId();
  return (
    <>
      <div className="field">
        <label htmlFor={id}>Public key</label>
        <textarea
          id={id}
          className="mono"
          rows={4}
          readOnly
          spellCheck={false}
          value={publicKey}
          onFocus={(e) => e.currentTarget.select()}
        />
      </div>
      <PublicKeyMeta publicKey={publicKey} />
    </>
  );
}

type Kind = 'ed25519' | 'rsa' | 'ecdsa';
const KIND_OPTIONS: { value: Kind; label: string }[] = [
  { value: 'ed25519', label: 'Ed25519 (recommended)' },
  { value: 'rsa', label: 'RSA' },
  { value: 'ecdsa', label: 'ECDSA' },
];
const RSA_OPTIONS = RSA_KEY_BITS.map((bits) => ({ value: String(bits), label: `${bits} bits` }));
const ECDSA_OPTIONS = ECDSA_KEY_BITS.map((bits) => ({
  value: String(bits),
  label: `P-${bits}`,
}));

function requestFor(kind: Kind, rsaBits: string, ecdsaBits: string): KeySpecInput {
  if (kind === 'rsa') {
    return { type: 'rsa', bits: RSA_KEY_BITS.find((b) => String(b) === rsaBits) ?? 4096 };
  }
  if (kind === 'ecdsa') {
    return { type: 'ecdsa', bits: ECDSA_KEY_BITS.find((b) => String(b) === ecdsaBits) ?? 256 };
  }
  return {};
}

/**
 * Generate an SSH key. Main makes the key and saves it as an `ssh_key` item; this dialog only
 * sees the public half, which it shows with a Copy button and the fingerprint. `onGenerated`
 * runs once the key is saved and the item list has caught up (the pickers select it then).
 *
 * The dialog is rendered into `document.body`: it is opened from inside the item editors, whose
 * drawer is a form, and Escape and Enter must not reach it.
 */
export function GenerateKeyDialog({
  vaultId,
  onClose,
  onGenerated,
}: {
  /** Vault to offer first (the lists' vault filter, or the vault of the item being edited). */
  vaultId?: string | undefined;
  onClose: () => void;
  onGenerated?: (itemId: string) => void;
}) {
  const vaults = useStore((s) => s.vaults);
  const vaultById = useStore((s) => s.vaultById);
  const writable = writableVaults(vaults);
  const [vault, setVault] = useState(
    (vaultId && canWrite(vaultById.get(vaultId)) ? vaultId : undefined) ??
      writable.find((v) => v.kind === 'personal')?.id ??
      writable[0]?.id ??
      '',
  );
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<Kind>('ed25519');
  const [rsaBits, setRsaBits] = useState('4096');
  const [ecdsaBits, setEcdsaBits] = useState('256');
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [comment, setComment] = useState('');
  const [created, setCreated] = useState<GeneratedKeyDto | null>(null);
  const action = useAction();

  const problem =
    vault === ''
      ? 'You do not have write access to any vault.'
      : label.trim() === ''
        ? 'Enter a name'
        : passphrase !== repeat
          ? 'The passphrases do not match'
          : null;
  const shared = vaultById.get(vault)?.kind === 'shared';

  const generate = () =>
    action.run(async () => {
      const result = await call('keys.generate', {
        vaultId: vault,
        label: label.trim(),
        ...requestFor(kind, rsaBits, ecdsaBits),
        ...(comment.trim() !== '' ? { comment: comment.trim() } : {}),
        ...(passphrase !== '' ? { passphrase } : {}),
      });
      // The key is saved; clear what was typed and let the lists catch up before it is selected.
      setPassphrase('');
      setRepeat('');
      await refreshData().catch(() => undefined);
      setCreated(result);
      onGenerated?.(result.item.id);
    });

  let body: ReactNode;
  let footer: ReactNode;
  if (created) {
    body = (
      <>
        <Notice>
          {keyTypeName(created.publicKey)} key <strong>{labelOf(created.item.payload)}</strong> is
          saved in {vaultTitle(vaultById.get(created.item.vaultId))}. Add the public key to{' '}
          <code>~/.ssh/authorized_keys</code> on the servers it should open. The private key stays
          in the vault.
        </Notice>
        <PublicKeyPanel publicKey={created.publicKey} />
      </>
    );
    footer = (
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    );
  } else {
    body = (
      <>
        {writable.length > 1 ? (
          <Field
            label="Vault"
            hint={
              shared ? (
                <span className="warn">Everyone in this vault can read the key.</span>
              ) : undefined
            }
          >
            {(id) => (
              <select id={id} value={vault} onChange={(e) => setVault(e.target.value)}>
                {writable.map((v) => (
                  <option key={v.id} value={v.id}>
                    {vaultTitle(v)}
                    {v.kind === 'shared' ? ' (shared)' : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        <TextField label="Name" value={label} onChange={setLabel} autoFocus maxLength={200} />
        <div className="grid-2">
          <Select label="Type" value={kind} onChange={setKind} options={KIND_OPTIONS} />
          {kind === 'rsa' ? (
            <Select label="Size" value={rsaBits} onChange={setRsaBits} options={RSA_OPTIONS} />
          ) : kind === 'ecdsa' ? (
            <Select
              label="Curve"
              value={ecdsaBits}
              onChange={setEcdsaBits}
              options={ECDSA_OPTIONS}
            />
          ) : null}
        </div>
        <TextField
          label="Passphrase (optional)"
          type="password"
          value={passphrase}
          onChange={setPassphrase}
          autoComplete="off"
          maxLength={1024}
          hint="Encrypts the private key. It is saved with the key in your vault, so connections can unlock it."
        />
        {passphrase !== '' ? (
          <TextField
            label="Repeat passphrase"
            type="password"
            value={repeat}
            onChange={setRepeat}
            autoComplete="off"
            maxLength={1024}
            hint={
              repeat !== '' && repeat !== passphrase ? (
                <span className="warn">The passphrases do not match.</span>
              ) : undefined
            }
          />
        ) : null}
        <TextField
          label="Comment (optional)"
          value={comment}
          onChange={setComment}
          placeholder={label.trim()}
          spellCheck={false}
          maxLength={200}
          hint="Added to the public key. Defaults to the name."
        />
        {kind === 'rsa' && rsaBits === '4096' && action.busy ? (
          <div className="hint">A 4096-bit RSA key can take several seconds.</div>
        ) : null}
        <ErrorText error={action.error} />
      </>
    );
    footer = (
      <>
        <Button onClick={onClose} disabled={action.busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          busy={action.busy}
          disabled={problem !== null}
          title={problem ?? undefined}
          onClick={() => void generate()}
        >
          Generate
        </Button>
      </>
    );
  }

  return createPortal(
    <div
      className="contents"
      onKeyDown={(e) => {
        // The editor drawer under this dialog closes on Escape: keep the key to ourselves.
        if (e.key === 'Escape') e.stopPropagation();
      }}
    >
      <Modal
        title={created ? 'Key generated' : 'Generate SSH key'}
        onClose={onClose}
        dismissable={!action.busy}
        wide={created !== null}
        footer={footer}
      >
        <form
          onSubmit={(e) => {
            // A form in a portal still submits the drawer's form in React's tree.
            e.preventDefault();
            e.stopPropagation();
            if (!created && problem === null && !action.busy) void generate();
          }}
        >
          {body}
          <button type="submit" hidden />
        </form>
      </Modal>
    </div>,
    document.body,
  );
}
