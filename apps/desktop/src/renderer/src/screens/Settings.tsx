import { useState } from 'react';
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from '../../../shared/app.js';
import { call } from '../api.js';
import { runAuthExclusive, toast, useStore } from '../store.js';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorText,
  Fingerprint,
  formatDate,
  Notice,
  Select,
  TextField,
  useAction,
  useLoad,
} from '../ui.js';
import { SignOutDialog } from './Auth.js';
import { ServerAddressHint } from './Setup.js';

type Tab = 'account' | 'security' | 'terminal' | 'devices' | 'admin';

export function SettingsView() {
  const isAdmin = useStore((s) => s.account?.user.role === 'admin');
  const [tab, setTab] = useState<Tab>('account');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'account', label: 'Account' },
    { id: 'security', label: 'Security' },
    { id: 'terminal', label: 'Terminal' },
    { id: 'devices', label: 'Devices' },
    ...(isAdmin ? [{ id: 'admin' as const, label: 'Admin' }] : []),
  ];
  return (
    <div className="view">
      <div className="view-header">
        <h1>Settings</h1>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="settings-body">
        {tab === 'account' ? <AccountTab /> : null}
        {tab === 'security' ? <SecurityTab /> : null}
        {tab === 'terminal' ? <TerminalTab /> : null}
        {tab === 'devices' ? <DevicesTab /> : null}
        {tab === 'admin' && isAdmin ? <AdminTab /> : null}
      </div>
    </div>
  );
}

function AccountTab() {
  const account = useStore((s) => s.account);
  const connection = useStore((s) => s.connection);
  const pending = useStore((s) => s.authPending);
  const [signOut, setSignOut] = useState(false);
  const [changeServer, setChangeServer] = useState(false);
  if (!account) return null;
  return (
    <>
      <dl className="facts">
        <dt>Name</dt>
        <dd>{account.user.name}</dd>
        <dt>Email</dt>
        <dd>{account.email}</dd>
        <dt>Role</dt>
        <dd>
          <Badge>{account.user.role}</Badge>
        </dd>
        <dt>Server</dt>
        <dd>
          <span className="mono">{account.serverUrl}</span>{' '}
          <Badge tone={connection === 'online' ? 'good' : 'warn'}>{connection}</Badge>
        </dd>
        <dt>Fingerprint</dt>
        <dd>
          <Fingerprint value={account.user.fingerprint} />
        </dd>
      </dl>
      <ChangePassword />
      <div className="row">
        <Button onClick={() => setChangeServer(true)}>Change server…</Button>
        <Button variant="danger" onClick={() => setSignOut(true)}>
          Sign out
        </Button>
      </div>
      {signOut ? <SignOutDialog onClose={() => setSignOut(false)} /> : null}
      {changeServer ? (
        <ConfirmDialog
          title="Change server?"
          message={
            <>
              <p>
                Your session and this computer's offline copy belong to the current server, so
                changing it signs you out and closes open terminals.
              </p>
              <p className="muted">
                <ServerAddressHint />
              </p>
            </>
          }
          confirmLabel="Sign out and change"
          danger
          confirmDisabled={pending}
          onClose={() => setChangeServer(false)}
          onConfirm={async () => {
            // The window reloads once signed out; main forgets the server address itself.
            await runAuthExclusive(() => call('auth.logout', { forgetServer: true }));
          }}
        />
      ) : null}
    </>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const action = useAction();
  const valid = current !== '' && next.length >= 8 && next === confirm;
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        void action.run(async () => {
          await call('auth.changePassword', { current, next });
          setCurrent('');
          setNext('');
          setConfirm('');
          toast('Master password changed. Your other devices were signed out.');
        });
      }}
    >
      <h3>Change master password</h3>
      <TextField
        label="Current password"
        type="password"
        value={current}
        onChange={setCurrent}
        autoComplete="current-password"
      />
      <TextField
        label="New password"
        type="password"
        value={next}
        onChange={setNext}
        autoComplete="new-password"
        hint={next !== '' && next.length < 8 ? 'Use at least 8 characters.' : undefined}
      />
      <TextField
        label="Repeat new password"
        type="password"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        hint={confirm !== '' && confirm !== next ? 'The passwords do not match.' : undefined}
      />
      <Notice>Changing the password signs out every other device.</Notice>
      <ErrorText error={action.error} />
      <Button type="submit" variant="primary" busy={action.busy} disabled={!valid}>
        Change password
      </Button>
    </form>
  );
}

const AUTO_LOCK_OPTIONS = ['0', '1', '5', '10', '15', '30', '60', '120'] as const;

function SecurityTab() {
  const settings = useStore((s) => s.settings);
  const action = useAction();
  const minutes = String(settings.autoLockMinutes);
  const options = AUTO_LOCK_OPTIONS.includes(minutes as (typeof AUTO_LOCK_OPTIONS)[number])
    ? [...AUTO_LOCK_OPTIONS]
    : [...AUTO_LOCK_OPTIONS, minutes];
  return (
    <>
      <div className="row">
        <Button variant="primary" onClick={() => void action.run(() => call('auth.lock'))}>
          Lock now
        </Button>
        <ErrorText error={action.error} />
      </div>
      <Select
        label="Lock automatically after"
        value={minutes}
        onChange={(value) =>
          void action.run(() => call('settings.set', { autoLockMinutes: Number(value) }))
        }
        options={options.map((value) => ({
          value,
          label:
            value === '0' ? 'Never' : `${value} minute${value === '1' ? '' : 's'} without activity`,
        }))}
        hint="Also locks when the computer sleeps or the screen locks."
      />
      <Notice>
        Locking forgets your vault keys and hides the vault. Terminals that are already connected
        stay connected, and their output keeps arriving behind the lock screen; you cannot open new
        connections until you unlock.
      </Notice>
    </>
  );
}

function TerminalTab() {
  const size = useStore((s) => s.settings.terminalFontSize);
  const action = useAction();
  const set = (value: number) =>
    void action.run(() => call('settings.set', { terminalFontSize: value }));
  return (
    <>
      <div className="field">
        <label htmlFor="font-size">Terminal font size</label>
        <div className="input-row">
          <Button
            onClick={() => set(Math.max(MIN_FONT_SIZE, size - 1))}
            disabled={size <= MIN_FONT_SIZE}
          >
            −
          </Button>
          <input
            id="font-size"
            type="number"
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            value={size}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isInteger(value) && value >= MIN_FONT_SIZE && value <= MAX_FONT_SIZE)
                set(value);
            }}
          />
          <Button
            onClick={() => set(Math.min(MAX_FONT_SIZE, size + 1))}
            disabled={size >= MAX_FONT_SIZE}
          >
            +
          </Button>
        </div>
      </div>
      <ErrorText error={action.error} />
    </>
  );
}

function DevicesTab() {
  const devices = useLoad(() => call('devices.list'));
  const action = useAction();
  const [revoking, setRevoking] = useState<string | null>(null);
  return (
    <>
      <ErrorText error={devices.error} />
      <table className="table">
        <thead>
          <tr>
            <th>Device</th>
            <th>Platform</th>
            <th>Added</th>
            <th>Last seen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(devices.data ?? []).map((d) => (
            <tr key={d.id}>
              <td>
                {d.name} {d.current ? <Badge tone="good">this device</Badge> : null}
              </td>
              <td>{d.platform}</td>
              <td className="muted">{formatDate(d.createdAt)}</td>
              <td className="muted">{formatDate(d.lastSeenAt)}</td>
              <td>
                {!d.current ? (
                  <Button variant="danger" onClick={() => setRevoking(d.id)}>
                    Revoke
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorText error={action.error} />
      {revoking ? (
        <ConfirmDialog
          title="Revoke this device?"
          message="It is signed out immediately and has to sign in again with the master password."
          confirmLabel="Revoke"
          danger
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await call('devices.revoke', { deviceId: revoking });
            devices.reload();
          }}
        />
      ) : null}
    </>
  );
}

function AdminTab() {
  return (
    <>
      <InvitesSection />
      <UsersSection />
    </>
  );
}

function InvitesSection() {
  const invites = useLoad(() => call('admin.invites.list'));
  const [email, setEmail] = useState('');
  const [hours, setHours] = useState('72');
  const create = useAction();
  const remove = useAction();
  const [created, setCreated] = useState<string | null>(null);
  const copy = (text: string) =>
    void call('clipboard.write', { text }).then(() => toast('Copied to the clipboard.'));
  return (
    <section>
      <h3>Invites</h3>
      <form
        className="input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void create.run(async () => {
            const result = await call('admin.invites.create', {
              ...(email.trim() ? { email: email.trim() } : {}),
              expiresInHours: Math.max(1, Number(hours) || 72),
            });
            setCreated(result.code);
            setEmail('');
            invites.reload();
          });
        }}
      >
        <input
          aria-label="Restrict the invite to this email (optional)"
          placeholder="Email (optional)"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          aria-label="Valid for hours"
          className="narrow"
          inputMode="numeric"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
        />
        <span className="muted">hours</span>
        <Button type="submit" variant="primary" busy={create.busy}>
          Create invite
        </Button>
      </form>
      <ErrorText error={create.error} />
      {created ? (
        <Notice>
          New invite code: <code data-testid="invite-code">{created}</code>{' '}
          <Button onClick={() => copy(created)}>Copy</Button>
        </Notice>
      ) : null}
      <ErrorText error={invites.error ?? remove.error} />
      {(invites.data ?? []).length === 0 && !invites.loading ? (
        <EmptyState>No invites.</EmptyState>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>For</th>
              <th>Expires</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(invites.data ?? []).map((i) => (
              <tr key={i.code}>
                <td>
                  <code>{i.code}</code>
                </td>
                <td>{i.email ?? 'anyone'}</td>
                <td className="muted">{formatDate(i.expiresAt)}</td>
                <td>{i.usedAt ? <Badge>used</Badge> : <Badge tone="good">open</Badge>}</td>
                <td className="actions">
                  <Button onClick={() => copy(i.code)}>Copy</Button>
                  <Button
                    variant="danger"
                    onClick={() =>
                      void remove.run(async () => {
                        await call('admin.invites.delete', { code: i.code });
                        invites.reload();
                      })
                    }
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function UsersSection() {
  const users = useLoad(() => call('admin.users.list'));
  const account = useStore((s) => s.account);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  return (
    <section>
      <h3>Users</h3>
      <ErrorText error={users.error} />
      <table className="table">
        <thead>
          <tr>
            <th>User</th>
            <th>Fingerprint</th>
            <th>Role</th>
            <th>Joined</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(users.data ?? []).map((u) => (
            <tr key={u.id}>
              <td>
                <strong>{u.name}</strong>
                <div className="muted">{u.email}</div>
              </td>
              <td>
                <Fingerprint value={u.fingerprint} />
              </td>
              <td>
                <Badge>{u.role}</Badge>
              </td>
              <td className="muted">{formatDate(u.createdAt)}</td>
              <td>
                {u.id !== account?.user.id ? (
                  <Button variant="danger" onClick={() => setDeleting({ id: u.id, name: u.name })}>
                    Delete
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {deleting ? (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          message="Their account, devices and personal vault are removed from the server. Shared vaults that have other members stay."
          confirmLabel="Delete user"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await call('admin.users.delete', { userId: deleting.id });
            users.reload();
          }}
        />
      ) : null}
    </section>
  );
}
