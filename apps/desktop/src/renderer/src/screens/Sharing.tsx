import { useEffect, useState } from 'react';
import type {
  KeyChangeDto,
  LookupUserDto,
  MemberDto,
  RemoveMemberResultDto,
  VaultDto,
  VaultRole,
} from '../../../shared/types.js';
import { call, keyChangeOf } from '../api.js';
import { vaultTitle } from '../items.js';
import { refreshData, toast, useStore } from '../store.js';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorText,
  Fingerprint,
  formatDate,
  Modal,
  Notice,
  PinBadge,
  RoleBadge,
  Select,
  TextField,
  useAction,
  useLoad,
} from '../ui.js';
import { KeyChangeDialog, type ReportedKey, useKeyChangeGuard } from './KeyChange.js';

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
  // A member whose key changed blocks rotation; the dialog resolves the key from the live list.
  const rotate = useKeyChangeGuard(async (change): Promise<ReportedKey> => {
    const list = await call('vaults.members', { vaultId: vault.id });
    const member = list.find((m) => m.userId === change.userId);
    if (!member) throw new Error('This person is no longer a member of the vault.');
    return member;
  });
  const rotateNow = async () => {
    await call('vaults.rotate', { vaultId: vault.id });
    setRotationNotice(null);
    toast('Vault key rotated.');
    await refreshData();
    members.reload();
  };

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
          {rotationNotice.rotationError.keyChange ? (
            <Button
              variant="danger"
              onClick={() => {
                const change = rotationNotice.rotationError?.keyChange;
                if (change) rotate.open(change, rotateNow);
              }}
            >
              Review changed key
            </Button>
          ) : (
            <Button busy={rotate.busy} onClick={() => void rotate.run(rotateNow)}>
              Retry rotation
            </Button>
          )}
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
          <Button busy={rotate.busy} onClick={() => void rotate.run(rotateNow)}>
            Rotate vault key
          </Button>
          <span className="muted">
            Re-encrypts every item under a new key. It happens automatically when you remove a
            member.
          </span>
        </div>
      ) : null}
      {isOwner && !rotationNotice?.rotationError ? <ErrorText error={rotate.error} /> : null}
      {rotate.dialog}
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
  const verify = useAction();
  const [reviewing, setReviewing] = useState<KeyChangeDto | null>(null);
  const action = useAction();
  const canVerify = !member.isSelf && !member.verified && !member.keyChanged;
  return (
    <tr data-testid={`member-${member.email}`}>
      <td>
        <strong>{member.name}</strong> {member.isSelf ? <Badge>you</Badge> : null}
        <div className="muted">{member.email}</div>
      </td>
      <td>
        <Fingerprint value={member.fingerprint} />{' '}
        <PinBadge verified={member.verified} keyChanged={member.keyChanged} />
        {member.keyChanged ? (
          <div className="muted">
            Pinned earlier: <Fingerprint value={member.pinnedFingerprint} />
          </div>
        ) : null}
        {canVerify ? (
          <div>
            <Button
              busy={verify.busy}
              title="Ternix shows the fingerprint to compare in a system dialog"
              onClick={() =>
                void verify.run(async () => {
                  try {
                    // Main asks the user to compare the fingerprint in a native dialog.
                    await call('vaults.markMemberVerified', {
                      userId: member.userId,
                      publicKey: member.publicKey,
                    });
                    onChanged();
                  } catch (err) {
                    // The pinned key is another one by now: the key change dialog takes over.
                    const change = keyChangeOf(err);
                    if (!change) throw err;
                    setReviewing(change);
                  }
                })
              }
            >
              Mark verified
            </Button>
            <ErrorText error={verify.error} />
          </div>
        ) : null}
        {member.keyChanged && !member.isSelf ? (
          <div>
            <Button
              variant="danger"
              onClick={() =>
                setReviewing({
                  userId: member.userId,
                  email: member.email,
                  pinnedFingerprint: member.pinnedFingerprint,
                  serverFingerprint: member.fingerprint,
                })
              }
            >
              Review changed key
            </Button>
          </div>
        ) : null}
        {reviewing ? (
          <KeyChangeDialog
            change={reviewing}
            resolveKey={async () => {
              const list = await call('vaults.members', { vaultId: vault.id });
              const current = list.find((m) => m.userId === reviewing.userId);
              if (!current) throw new Error('This person is no longer a member of the vault.');
              return current;
            }}
            onAccepted={() => {
              setReviewing(null);
              onChanged();
            }}
            onClose={() => setReviewing(null)}
          />
        ) : null}
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
  const [role, setRole] = useState<VaultRole>('viewer');
  const lookup = useAction();
  // `member_key_changed` while adding: the key the owner verified differs from the pin.
  const add = useKeyChangeGuard(async (change): Promise<ReportedKey> => {
    if (!found || found.id !== change.userId) {
      throw new Error('Look the person up again before accepting their key.');
    }
    return found;
  });

  const reset = () => setFound(null);

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
              <Fingerprint value={found.fingerprint} />{' '}
              {found.pinnedFingerprint !== null ? (
                <PinBadge verified={found.verified} keyChanged={found.keyChanged} />
              ) : null}
            </dd>
          </dl>
          {found.keyChanged && found.pinnedFingerprint !== null ? (
            <Notice tone="danger">
              This device saw another key for {found.name} before (
              <Fingerprint value={found.pinnedFingerprint} />
              ). The server may have swapped it, or {found.name} registered again. Compare the
              fingerprint above with {found.name} before you go on.
            </Notice>
          ) : null}
          <Notice tone="warning">
            The server could swap in someone else's key. Ask {found.name} to read you their
            fingerprint (Sharing page, “Your fingerprint”) over a call or in person. Ternix shows it
            again in a system dialog before anything is shared; confirm there only if it matches.
          </Notice>
          <Select label="Role" value={role} onChange={setRole} options={ROLE_OPTIONS} />
          <ErrorText error={add.error} />
          {add.dialog}
          <div className="row">
            <Button
              variant="primary"
              busy={add.busy}
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
