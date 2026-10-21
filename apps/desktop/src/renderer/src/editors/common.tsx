import type { ItemType } from '@ternix/core/items';
import { type ReactNode, useId, useState } from 'react';
import type { ItemDraftInput, SecretField } from '../../../shared/types.js';
import { call } from '../api.js';
import {
  byLabel,
  canWrite,
  type ItemOf,
  itemsOfType,
  labelOf,
  vaultTitle,
  writableVaults,
} from '../items.js';
import { closeEditor, type EditorTarget, toast, useStore } from '../store.js';
import {
  Button,
  ConfirmDialog,
  Drawer,
  ErrorText,
  Field,
  FormCard,
  Modal,
  Notice,
  useAction,
} from '../ui.js';

export const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  host: 'host',
  group: 'group',
  identity: 'identity',
  ssh_key: 'SSH key',
  snippet: 'snippet',
  port_forward: 'port forward',
  known_host: 'known host',
};

/** Save an item and report a write the server rejected as stale. */
export async function saveItem(vaultId: string, itemId: string | undefined, draft: ItemDraftInput) {
  const result = await call('items.put', {
    vaultId,
    ...(itemId ? { itemId } : {}),
    draft,
  });
  if (result.status === 'dropped') {
    throw new Error(
      'Someone else changed this item more recently, so your change was not applied. Their version is now shown.',
    );
  }
}

/**
 * Shared frame of the item editors: title, vault choice for new items, Save/Delete, errors,
 * and the read-only mode for viewers.
 */
export function EditorFrame({
  target,
  title,
  children,
  validate,
  build,
}: {
  target: EditorTarget;
  title: string;
  children: (ctx: { vaultId: string; readOnly: boolean }) => ReactNode;
  /** Returns a message when the form is not ready to save. */
  validate: () => string | null;
  build: (vaultId: string) => ItemDraftInput;
}) {
  const vaults = useStore((s) => s.vaults);
  const vaultById = useStore((s) => s.vaultById);
  const editing = target.item;
  const writable = writableVaults(vaults);
  const initialVault =
    editing?.vaultId ??
    (target.vaultId && writable.some((v) => v.id === target.vaultId)
      ? target.vaultId
      : undefined) ??
    writable.find((v) => v.kind === 'personal')?.id ??
    writable[0]?.id ??
    '';
  const [vaultId, setVaultId] = useState(initialVault);
  const vault = vaultById.get(vaultId);
  const readOnly = editing ? !canWrite(vault) : false;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const action = useAction();
  const problem = validate();

  const onSave = () =>
    action.run(async () => {
      await saveItem(vaultId, editing?.id, build(vaultId));
      closeEditor();
    });

  if (!editing && writable.length === 0) {
    return (
      <Modal
        title={title}
        onClose={closeEditor}
        footer={<Button onClick={closeEditor}>Close</Button>}
      >
        <Notice tone="warning">You do not have write access to any vault.</Notice>
      </Modal>
    );
  }

  return (
    <>
      <Drawer
        title={readOnly ? `${title} (read only)` : title}
        subtitle={vault ? vaultTitle(vault) : undefined}
        onClose={closeEditor}
        onSubmit={() => {
          if (!readOnly && problem === null) void onSave();
        }}
        footer={
          <>
            {editing && !readOnly ? (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            ) : null}
            <Button onClick={closeEditor}>{readOnly ? 'Close' : 'Cancel'}</Button>
            {!readOnly ? (
              <Button
                variant="primary"
                busy={action.busy}
                disabled={problem !== null}
                title={problem ?? undefined}
                onClick={() => void onSave()}
              >
                Save
              </Button>
            ) : null}
          </>
        }
      >
        {readOnly ? (
          <Notice>You are a viewer in this vault, so you can look but not change.</Notice>
        ) : null}
        {!editing && writable.length > 1 ? (
          <FormCard>
            <Field label="Vault">
              {(id) => (
                <select id={id} value={vaultId} onChange={(e) => setVaultId(e.target.value)}>
                  {writable.map((v) => (
                    <option key={v.id} value={v.id}>
                      {vaultTitle(v)}
                      {v.kind === 'shared' ? ' (shared)' : ''}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </FormCard>
        ) : null}
        {children({ vaultId, readOnly })}
        <ErrorText error={action.error} />
      </Drawer>
      {confirmDelete && editing ? (
        <ConfirmDialog
          title={`Delete ${ITEM_TYPE_LABEL[editing.payload.type]}?`}
          message={
            <>
              Delete <strong>{labelOf(editing.payload)}</strong>
              {vault?.kind === 'shared' ? ` for everyone in ${vaultTitle(vault)}` : ''}? This cannot
              be undone.
            </>
          }
          confirmLabel="Delete"
          danger
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            const result = await call('items.delete', { vaultId, itemId: editing.id });
            if (result.status === 'dropped') {
              toast('The item was changed elsewhere, so it was not deleted.', 'warning');
            }
            closeEditor();
          }}
        />
      ) : null}
    </>
  );
}

/** Pick an item of one type, from every vault the user can read. */
export function ItemSelect<T extends ItemType>({
  label,
  type,
  value,
  onChange,
  targetVaultId,
  exclude,
  disabled,
  noneLabel = 'None',
  create,
}: {
  label: string;
  type: T;
  value: string;
  onChange: (id: string) => void;
  /** Vault the referring item is saved in, to warn about references other members may not read. */
  targetVaultId: string;
  exclude?: ReadonlySet<string>;
  disabled?: boolean;
  noneLabel?: string;
  /** An action under the picker, for example "Generate new key…". Hidden when disabled. */
  create?: { label: string; onClick: () => void };
}) {
  const items = useStore((s) => s.items);
  const vaultById = useStore((s) => s.vaultById);
  const vaultCount = useStore((s) => s.vaults.length);
  const options: ItemOf<T>[] = itemsOfType(items, type)
    .filter((i) => !exclude?.has(i.id))
    .sort(byLabel);
  const selected = options.find((i) => i.id === value);
  const dangling = value !== '' && !selected;
  const foreign = selected && selected.vaultId !== targetVaultId;
  const targetVault = vaultById.get(targetVaultId);
  return (
    <>
      <Field
        label={label}
        hint={
          dangling ? (
            'This item was deleted or is not readable; it is treated as unset.'
          ) : foreign && targetVault?.kind === 'shared' ? (
            <span className="warn">
              Lives in {vaultTitle(vaultById.get(selected.vaultId))}. Other members of{' '}
              {vaultTitle(targetVault)} who cannot read that vault will not see it.
            </span>
          ) : undefined
        }
      >
        {(id) => (
          <select
            id={id}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">{noneLabel}</option>
            {dangling ? <option value={value}>(missing item)</option> : null}
            {options.map((i) => (
              <option key={i.id} value={i.id}>
                {labelOf(i.payload)}
                {vaultCount > 1 ? ` — ${vaultTitle(vaultById.get(i.vaultId))}` : ''}
              </option>
            ))}
          </select>
        )}
      </Field>
      {create && !disabled ? (
        <div className="field-action">
          <Button variant="quiet" size="sm" onClick={create.onClick}>
            {create.label}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** Empty form strings mean "not set". */
export const optional = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value;
export const optionalId = (value: string): string | undefined => (value === '' ? undefined : value);

export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
    ),
  ];
}

export function parsePort(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * One secret field of an item (password, passphrase, private key). Lists do not carry
 * secrets, so the field starts empty: left untouched it keeps the stored value, "Show" fetches
 * it from main (`items.reveal`), typing replaces it and "Remove" clears it. The value lives in
 * this editor's state only, which goes away when the editor closes or the vault locks.
 */
export interface SecretState {
  value: string;
  /** The stored item has a value for this field. */
  stored: boolean;
  /** The user typed, imported or removed: the draft carries `value` (or null). */
  touched: boolean;
  revealed: boolean;
  set(value: string): void;
  reveal(): Promise<void>;
  remove(): void;
  busy: boolean;
  error: unknown;
  /** For the draft: undefined keeps the stored value, null clears it. */
  draftValue(normalize?: (value: string) => string): string | null | undefined;
}

export function useSecret(target: EditorTarget, field: SecretField): SecretState {
  const item = target.item;
  const stored = item
    ? (item.payload as unknown as Record<string, unknown>)[`has_${field}`] === true
    : false;
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const action = useAction();
  return {
    value,
    stored,
    touched,
    revealed,
    busy: action.busy,
    error: action.error,
    set: (next) => {
      setValue(next);
      setTouched(true);
    },
    reveal: async () => {
      if (!item || touched || revealed) return;
      await action.run(async () => {
        const secrets = await call('items.reveal', { vaultId: item.vaultId, itemId: item.id });
        setValue(secrets[field] ?? '');
        setRevealed(true);
      });
    },
    remove: () => {
      setValue('');
      setTouched(true);
    },
    draftValue: (normalize = (v) => v) => {
      if (!touched) return undefined;
      return value === '' ? null : normalize(value);
    },
  };
}

/** Spread into a draft: `{field: value}` when the field changed, nothing when it is kept. */
export function secretDraft<K extends SecretField>(
  field: K,
  value: string | null | undefined,
): Partial<Record<K, string | null>> {
  return value === undefined ? {} : ({ [field]: value } as Partial<Record<K, string | null>>);
}

export function SecretInput({
  label,
  secret,
  readOnly,
  multiline,
  hint,
  placeholder,
  optional = true,
}: {
  label: string;
  secret: SecretState;
  readOnly: boolean;
  /** A textarea (private keys) instead of a password input. */
  multiline?: boolean;
  hint?: ReactNode;
  placeholder?: string;
  /** Whether the user may remove the stored value. */
  optional?: boolean;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const keptPlaceholder =
    secret.stored && !secret.touched && !secret.revealed
      ? readOnly
        ? 'Stored. Show to see it.'
        : 'Stored. Leave empty to keep it, or type to replace it.'
      : placeholder;
  const show = async () => {
    await secret.reveal();
    setVisible(true);
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-row">
        {multiline ? (
          <textarea
            id={id}
            rows={8}
            className="mono"
            value={secret.value}
            spellCheck={false}
            disabled={readOnly}
            placeholder={keptPlaceholder}
            onChange={(e) => secret.set(e.target.value)}
          />
        ) : (
          <input
            id={id}
            type={visible ? 'text' : 'password'}
            value={secret.value}
            disabled={readOnly}
            autoComplete="off"
            placeholder={keptPlaceholder}
            onChange={(e) => secret.set(e.target.value)}
          />
        )}
        {secret.stored && !secret.touched && !secret.revealed ? (
          <Button variant="quiet" size="md" busy={secret.busy} onClick={() => void show()}>
            Show
          </Button>
        ) : !multiline ? (
          <Button variant="quiet" size="md" onClick={() => setVisible((v) => !v)}>
            {visible ? 'Hide' : 'Show'}
          </Button>
        ) : null}
        {optional && !readOnly && secret.stored && !(secret.touched && secret.value === '') ? (
          <Button variant="quiet" size="md" onClick={secret.remove}>
            Remove
          </Button>
        ) : null}
      </div>
      {secret.touched && secret.value === '' && secret.stored ? (
        <div className="hint">The stored value is removed when you save.</div>
      ) : hint ? (
        <div className="hint">{hint}</div>
      ) : null}
      <ErrorText error={secret.error} />
    </div>
  );
}
