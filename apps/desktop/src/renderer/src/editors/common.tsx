import type { ItemType } from '@ternix/core/items';
import { type ReactNode, useState } from 'react';
import type { ItemDraft } from '../../../shared/types.js';
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
import { Button, ConfirmDialog, ErrorText, Field, Modal, Notice, useAction } from '../ui.js';

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
export async function saveItem(vaultId: string, itemId: string | undefined, draft: ItemDraft) {
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
  build: (vaultId: string) => ItemDraft;
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
    <Modal
      title={readOnly ? `${title} (read only)` : title}
      onClose={closeEditor}
      wide
      footer={
        <>
          {editing && !readOnly ? (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          ) : null}
          <span className="spacer" />
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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!readOnly && problem === null) void onSave();
        }}
      >
        {readOnly ? (
          <Notice>You are a viewer in this vault, so you can look but not change.</Notice>
        ) : null}
        {!editing && writable.length > 1 ? (
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
        ) : null}
        {children({ vaultId, readOnly })}
        <ErrorText error={action.error} />
        <button type="submit" hidden />
      </form>
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
    </Modal>
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
