import { useEffect, useState } from 'react';
import type {
  LookupUserDto,
  MemberDto,
  RemoveMemberResultDto,
  VaultDto,
  VaultRole,
} from '../../../shared/types.js';
import { call } from '../api.js';
import { vaultTitle } from '../items.js';
import { refreshData, toast, useStore } from '../store.js';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorText,
  Fingerprint,
  formatDate,
  Modal,
  Notice,
  RoleBadge,
  Select,
  TextField,
  useAction,
  useLoad,
} from '../ui.js';

const ROLE_OPTIONS: { value: VaultRole; label: string }[] = [
  { value: 'viewer', label: 'Viewer: can read' },
  { value: 'editor', label: 'Editor: can read and change items' },
  { value: 'owner', label: 'Owner: can also manage members' },
];

export function SharingView() {
  const vaults = useStore((s) => s.vaults);
  const account = useStore((s) => s.account);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const shared = vaults.filter((v) => v.kind === 'shared');
  const selected = shared.find((v) => v.id === selectedId) ?? shared[0];

  return (
    <div className="view">
      <div className="view-header">
        <h1>Sharing</h1>
        <span className="spacer" />
        <Button variant="primary" onClick={() => setCreating(true)}>
          New shared vault
        </Button>
      </div>
      {account ? (
        <div className="server-card">
          <div>
            Your fingerprint: <Fingerprint value={account.user.fingerprint} />
          </div>
          <div className="muted">
            When someone shares a vault with you, they should compare this with what they see. Read
            it to them over a call or in person, not over the same channel as the invite.
          </div>
        </div>
      ) : null}
      <div className="split">
        <div className="vault-list" role="listbox" aria-label="Shared vaults">
          {shared.length === 0 ? (
            <EmptyState>
              No shared vaults yet. Create one to share hosts and keys with other people on this
              server.
            </EmptyState>
          ) : null}
          {shared.map((v) => (
            <button
              key={v.id}
              role="option"
              aria-selected={v.id === selected?.id}
              className={`vault-item ${v.id === selected?.id ? 'active' : ''}`}
              onClick={() => setSelectedId(v.id)}
            >
              <span>{vaultTitle(v)}</span>
              <RoleBadge role={v.role} />
            </button>
          ))}
        </div>
        <div className="split-main">{selected ? <VaultDetail vault={selected} /> : null}</div>
      </div>
      {creating ? <CreateVaultDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function CreateVaultDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const action = useAction();
  const submit = () =>
    action.run(async () => {
      await call('vaults.create', { name });
      await refreshData();
      onClose();
    });
  return (
    <Modal
      title="New shared vault"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={action.busy}
            disabled={name.trim() === ''}
            onClick={() => void submit()}
          >
            Create
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() !== '') void submit();
        }}
      >
        <TextField label="Name" value={name} onChange={setName} autoFocus maxLength={200} />
        <ErrorText error={action.error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function VaultDetail({ vault }: { vault: VaultDto }) {
  const isOwner = vault.role === 'owner';
  const members = useLoad(
    () => call('vaults.members', { vaultId: vault.id }),
    [vault.id, vault.memberCount, vault.keyVersion],
  );
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [rotationNotice, setRotationNotice] = useState<RemoveMemberResultDto | null>(null);
  const rotate = useAction();

  useEffect(() => setRotationNotice(null), [vault.id]);

  return (
    <div className="vault-detail">
      <div className="row">
        <h2>{vaultTitle(vault)}</h2>
        <RoleBadge role={vault.role} />
        <span className="muted">
          {vault.itemCount} items · key version {vault.keyVersion}
        </span>
        <span className="spacer" />
        {isOwner ? (
          <>
            <Button onClick={() => setRenaming(true)}>Rename</Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete vault
            </Button>
          </>
        ) : (
          <Button variant="danger" onClick={() => setLeaving(true)}>
            Leave vault
          </Button>
        )}
      </div>
      {vault.error ? <Notice tone="danger">{vault.error}</Notice> : null}
      {rotationNotice?.rotationError ? (
        <Notice tone="warning">
          The member was removed, but the vault key could not be rotated:{' '}
          {rotationNotice.rotationError.message} Until it is, the removed person could still read
          what they already have and anything encrypted with the old key.{' '}
          <Button
            busy={rotate.busy}
            onClick={() =>
              void rotate.run(async () => {
                await call('vaults.rotate', { vaultId: vault.id });
                setRotationNotice(null);
                toast('Vault key rotated.');
                await refreshData();
              })
            }
          >
            Retry rotation
          </Button>
          <ErrorText error={rotate.error} />
        </Notice>
      ) : null}
      {rotationNotice && !rotationNotice.rotationError && rotationNotice.rotated ? (
        <Notice>Member removed and the vault key rotated, so they cannot read new changes.</Notice>
      ) : null}

      <h3>Members</h3>
      <ErrorText error={members.error} />
      <table className="table">
        <thead>
          <tr>
            <th>Member</th>
            <th>Fingerprint</th>
            <th>Role</th>
            <th>Added</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(members.data ?? []).map((m) => (
            <MemberRow
              key={m.userId}
              vault={vault}
              member={m}
              onChanged={members.reload}
              onRemoved={(result) => {
                setRotationNotice(result);
                members.reload();
              }}
            />
          ))}
        </tbody>
      </table>
      {isOwner ? <AddMember vault={vault} onAdded={members.reload} /> : null}
      {isOwner ? (
        <div className="row">
          <Button
            busy={rotate.busy}
            onClick={() =>
              void rotate.run(async () => {
                await call('vaults.rotate', { vaultId: vault.id });
                toast('Vault key rotated.');
                await refreshData();
              })
            }
          >
            Rotate vault key
          </Button>
          <span className="muted">
            Re-encrypts every item under a new key. It happens automatically when you remove a
            member.
          </span>
        </div>
      ) : null}
      {renaming ? <RenameDialog vault={vault} onClose={() => setRenaming(false)} /> : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete this vault?"
          message={
            <>
              Delete <strong>{vaultTitle(vault)}</strong> and its {vault.itemCount} items for
              everyone. This cannot be undone.
            </>
          }
          confirmLabel="Delete vault"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await call('vaults.delete', { vaultId: vault.id });
            await refreshData();
          }}
        />
      ) : null}
      {leaving ? (
        <ConfirmDialog
          title="Leave this vault?"
          message="You will lose access to its items on this and every other device."
          confirmLabel="Leave"
          danger
          onClose={() => setLeaving(false)}
          onConfirm={async () => {
            await call('vaults.leave', { vaultId: vault.id });
            await refreshData();
          }}
        />
      ) : null}
    </div>
  );
}

function RenameDialog({ vault, onClose }: { vault: VaultDto; onClose: () => void }) {
  const [name, setName] = useState(vault.name ?? '');
  const action = useAction();
  return (
    <Modal
      title="Rename vault"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={action.busy}
            disabled={name.trim() === ''}
            onClick={() =>
              void action.run(async () => {
                await call('vaults.rename', { vaultId: vault.id, name });
                await refreshData();
                onClose();
              })
            }
          >
            Rename
          </Button>
        </>
      }
    >
      <TextField label="Name" value={name} onChange={setName} autoFocus maxLength={200} />
      <ErrorText error={action.error} />
    </Modal>
  );
}

function MemberRow({
  vault,
  member,
  onChanged,
  onRemoved,
}: {
  vault: VaultDto;
  member: MemberDto;
  onChanged: () => void;
  onRemoved: (result: RemoveMemberResultDto) => void;
}) {
  const isOwner = vault.role === 'owner';
  const [removing, setRemoving] = useState(false);
  const action = useAction();
  return (
    <tr>
      <td>
        <strong>{member.name}</strong> {member.isSelf ? <Badge>you</Badge> : null}
        <div className="muted">{member.email}</div>
      </td>
      <td>
        <Fingerprint value={member.fingerprint} />
      </td>
      <td>
        {isOwner && !member.isSelf ? (
          <select
            aria-label={`Role of ${member.name}`}
            value={member.role}
            disabled={action.busy}
            onChange={(e) =>
              void action.run(async () => {
                await call('vaults.changeRole', {
                  vaultId: vault.id,
                  userId: member.userId,
                  role: e.target.value as VaultRole,
                });
                onChanged();
              })
            }
          >
            {(['viewer', 'editor', 'owner'] as const).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        ) : (
          <RoleBadge role={member.role} />
        )}
        <ErrorText error={action.error} />
      </td>
      <td className="muted">{formatDate(member.addedAt)}</td>
      <td>
        {isOwner && !member.isSelf ? (
          <Button variant="danger" onClick={() => setRemoving(true)}>
            Remove
          </Button>
        ) : null}
        {removing ? (
          <ConfirmDialog
            title={`Remove ${member.name}?`}
            message="They lose access, and the vault key is rotated so they cannot read future changes."
            confirmLabel="Remove"
            danger
            onClose={() => setRemoving(false)}
            onConfirm={async () => {
              const result = await call('vaults.removeMember', {
                vaultId: vault.id,
                userId: member.userId,
              });
              onRemoved(result);
              await refreshData();
            }}
          />
        ) : null}
      </td>
    </tr>
  );
}

function AddMember({ vault, onAdded }: { vault: VaultDto; onAdded: () => void }) {
  const [email, setEmail] = useState('');
  const [found, setFound] = useState<LookupUserDto | null>(null);
  const [verified, setVerified] = useState(false);
  const [role, setRole] = useState<VaultRole>('viewer');
  const lookup = useAction();
  const add = useAction();

  const reset = () => {
    setFound(null);
    setVerified(false);
  };

  return (
    <div className="card">
      <h3>Add a member</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          reset();
          void lookup.run(async () => setFound(await call('vaults.lookupUser', { email })));
        }}
      >
        <div className="input-row">
          <input
            aria-label="Email of the person to add"
            placeholder="Email address"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              reset();
            }}
          />
          <Button type="submit" busy={lookup.busy} disabled={email.trim() === ''}>
            Look up
          </Button>
        </div>
        <ErrorText error={lookup.error} />
      </form>
      {found ? (
        <div className="stack">
          <dl className="facts">
            <dt>Person</dt>
            <dd>
              {found.name} <span className="muted">{found.email}</span>
            </dd>
            <dt>Fingerprint</dt>
            <dd>
              <Fingerprint value={found.fingerprint} />
            </dd>
          </dl>
          <Notice tone="warning">
            The server could swap in someone else's key. Ask {found.name} to read you their
            fingerprint (Sharing page, “Your fingerprint”) over a call or in person, and make sure
            it matches before you continue.
          </Notice>
          <Checkbox
            label={`I checked this fingerprint with ${found.name} through another channel.`}
            checked={verified}
            onChange={setVerified}
          />
          <Select label="Role" value={role} onChange={setRole} options={ROLE_OPTIONS} />
          {/* TODO(member-key-pinning): when the client reports `member_key_changed` for a member
              (their key differs from the one pinned earlier), show their old and new
              fingerprints here and ask the owner to confirm before calling
              `acceptMemberKey(userId, publicKey)`. Until then the error is shown as text. */}
          <ErrorText error={add.error} />
          <div className="row">
            <Button
              variant="primary"
              busy={add.busy}
              disabled={!verified}
              onClick={() =>
                void add.run(async () => {
                  await call('vaults.addMember', {
                    vaultId: vault.id,
                    userId: found.id,
                    role,
                    expectedPublicKey: found.publicKey,
                  });
                  toast(`${found.name} can now open ${vaultTitle(vault)}.`);
                  setEmail('');
                  reset();
                  onAdded();
                  await refreshData();
                })
              }
            >
              Add to vault
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
