import { useEffect, useState } from 'react';
import type { ProbedServerDto } from '../../../shared/ipc.js';
import type { AccountDto } from '../../../shared/types.js';
import { call, isOwnKeyMismatch } from '../api.js';
import { runAuthExclusive, setState, useStore } from '../store.js';
import { Button, ConfirmDialog, ErrorText, Notice, TextField, useAuthAction } from '../ui.js';
import { AuthLayout, ServerInfoCard, ServerSetup, useServerProbe } from './Setup.js';

const MIN_PASSWORD = 8;

function SecretStorageWarning() {
  const info = useStore((s) => s.info);
  if (!info || info.secretStorage.available) return null;
  return (
    <Notice tone="danger">
      {info.secretStorage.problem ?? 'Secure storage is unavailable.'} Signing in is disabled until
      this is fixed.
    </Notice>
  );
}

function useCanStoreSecrets(): boolean {
  return useStore((s) => s.info?.secretStorage.available ?? false);
}

/** Logged out (or session expired): pick a server, then sign in or register. */
export function SignedOut() {
  const serverUrl = useStore((s) => s.serverUrl);
  const account = useStore((s) => s.account);
  const clientState = useStore((s) => s.clientState);
  const [choosing, setChoosing] = useState(false);
  const address = clientState === 'expired' && account ? account.serverUrl : serverUrl;

  if (!address || choosing) {
    return (
      <ServerSetup
        initial={address ?? ''}
        onDone={() => setChoosing(false)}
        {...(address ? { onCancel: () => setChoosing(false) } : {})}
      />
    );
  }
  return <SignIn serverUrl={address} account={account} onChangeServer={() => setChoosing(true)} />;
}

function SignIn({
  serverUrl,
  account,
  onChangeServer,
}: {
  serverUrl: string;
  account: AccountDto | null;
  onChangeServer: () => void;
}) {
  const expired = account !== null;
  const { info, error: probeError } = useServerProbe(serverUrl, 0);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const notice = useStore((s) => s.authNotice);
  const canStore = useCanStoreSecrets();

  return (
    <AuthLayout title={mode === 'login' ? 'Sign in' : 'Create your account'}>
      <SecretStorageWarning />
      {expired && notice ? <Notice tone="warning">{notice}</Notice> : null}
      {info ? <ServerInfoCard info={info} /> : null}
      {probeError ? <Notice tone="danger">Cannot reach the server: {probeError}</Notice> : null}
      {!expired ? (
        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={mode === 'login'}
            className={mode === 'login' ? 'active' : ''}
            onClick={() => setMode('login')}
          >
            Sign in
          </button>
          <button
            role="tab"
            aria-selected={mode === 'register'}
            className={mode === 'register' ? 'active' : ''}
            onClick={() => setMode('register')}
          >
            Create account
          </button>
        </div>
      ) : null}
      {mode === 'login' ? (
        <LoginForm serverUrl={serverUrl} initialEmail={account?.email ?? ''} disabled={!canStore} />
      ) : (
        <RegisterForm serverUrl={serverUrl} info={info} disabled={!canStore} />
      )}
      <div className="row subtle">
        <Button variant="ghost" onClick={onChangeServer}>
          Change server
        </Button>
        {expired ? <SignOutButton label="Use a different account" /> : null}
      </div>
    </AuthLayout>
  );
}

/**
 * The server reported another account key than this device expected while signing in. No
 * session was stored, so there is nothing to sign out of: say so and go back to the form.
 */
function SignInKeyMismatch({ onBack }: { onBack: () => void }) {
  return (
    <div data-testid="sign-in-key-mismatch">
      <Notice tone="danger">
        Your server reported a different account key than the one this device expected, so it may be
        trying to impersonate you. Ternix did not sign in and saved nothing. Contact the server
        admin before you try again.
      </Notice>
      <div className="row">
        <span />
        <Button onClick={onBack}>Back</Button>
      </div>
    </div>
  );
}

function LoginForm({
  serverUrl,
  initialEmail,
  disabled,
}: {
  serverUrl: string;
  initialEmail: string;
  disabled: boolean;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const action = useAuthAction();
  if (isOwnKeyMismatch(action.error)) return <SignInKeyMismatch onBack={action.clear} />;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await call('auth.login', { serverUrl, email, password });
          setPassword('');
          setState({ authNotice: null });
        });
      }}
    >
      <TextField
        label="Email"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="username"
        autoFocus={initialEmail === ''}
        required
      />
      <TextField
        label="Master password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        autoFocus={initialEmail !== ''}
        required
      />
      <ErrorText error={action.error} />
      <Button
        variant="primary"
        type="submit"
        busy={action.busy}
        disabled={disabled || action.blocked || email === '' || password === ''}
      >
        Sign in
      </Button>
    </form>
  );
}

function RegisterForm({
  serverUrl,
  info,
  disabled,
}: {
  serverUrl: string;
  info: ProbedServerDto | null;
  disabled: boolean;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [invite, setInvite] = useState('');
  const action = useAuthAction();
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready =
    email !== '' && name.trim() !== '' && password.length >= MIN_PASSWORD && confirm === password;
  if (isOwnKeyMismatch(action.error)) return <SignInKeyMismatch onBack={action.clear} />;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await call('auth.register', {
            serverUrl,
            email,
            name,
            password,
            ...(invite.trim() ? { inviteCode: invite.trim() } : {}),
          });
          setPassword('');
          setConfirm('');
          setState({ authNotice: null });
        });
      }}
    >
      <TextField label="Email" type="email" value={email} onChange={setEmail} required />
      <TextField label="Your name" value={name} onChange={setName} required maxLength={100} />
      {info?.registration !== 'open' ? (
        <TextField
          label="Invite code"
          value={invite}
          onChange={setInvite}
          spellCheck={false}
          autoComplete="off"
          hint={
            info?.registration === 'closed'
              ? 'Registration is closed. Only the first account on a new server can be created.'
              : 'From a server admin. Leave empty if you are creating the first account on this server.'
          }
        />
      ) : null}
      <TextField
        label="Master password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        required
        hint={tooShort ? `Use at least ${MIN_PASSWORD} characters.` : undefined}
      />
      <TextField
        label="Repeat master password"
        type="password"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        required
        hint={mismatch ? 'The passwords do not match.' : undefined}
      />
      <Notice tone="warning">
        Your master password encrypts your vaults on this computer. The server never sees it and
        nobody can reset it: if you forget it, your data cannot be recovered.
      </Notice>
      <ErrorText error={action.error} />
      <Button
        variant="primary"
        type="submit"
        busy={action.busy}
        disabled={disabled || action.blocked || !ready}
      >
        Create account
      </Button>
    </form>
  );
}

export function SignOutButton({ label = 'Sign out' }: { label?: string }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        {label}
      </Button>
      {confirming ? <SignOutDialog onClose={() => setConfirming(false)} /> : null}
    </>
  );
}

export function SignOutDialog({
  onClose,
  onSignedOut,
}: {
  onClose: () => void;
  onSignedOut?: () => void;
}) {
  const pending = useStore((s) => s.authPending);
  return (
    <ConfirmDialog
      title="Sign out of Ternix?"
      message="This removes the saved session and the offline copy of your vaults from this computer, and closes open terminals. Your data stays on the server."
      confirmLabel="Sign out"
      danger
      confirmDisabled={pending}
      onClose={onClose}
      onConfirm={async () => {
        // Leaving a session reloads the window (main shows the outcome on the new page); with
        // no session to leave, this page goes on.
        const result = await runAuthExclusive(() => call('auth.logout', {}));
        if (result) onSignedOut?.();
      }}
    />
  );
}

/** Saved session, keys not in memory: password only. */
export function Unlock() {
  const account = useStore((s) => s.account);
  const [password, setPassword] = useState('');
  const action = useAuthAction();
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    // The renderer may be reloaded while locked: make sure the account is loaded.
    if (!account) {
      void call('client.snapshot').then((snap) => setState({ account: snap.account }));
    }
  }, [account]);

  return (
    <AuthLayout title="Ternix is locked">
      {account ? (
        <div className="server-card">
          <div>
            <strong>{account.user.name}</strong> <span className="muted">{account.email}</span>
          </div>
          <div className="muted mono">{account.serverUrl}</div>
        </div>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await call('auth.unlock', { password });
            setPassword('');
          });
        }}
      >
        <TextField
          label="Master password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          autoFocus
          required
        />
        <ErrorText error={action.error} />
        <Button
          variant="primary"
          type="submit"
          busy={action.busy}
          disabled={action.blocked || password === ''}
        >
          Unlock
        </Button>
      </form>
      <div className="row subtle">
        <span className="muted">Open terminals stay connected while locked.</span>
        <Button variant="ghost" onClick={() => setSigningOut(true)}>
          Sign out
        </Button>
      </div>
      {signingOut ? <SignOutDialog onClose={() => setSigningOut(false)} /> : null}
    </AuthLayout>
  );
}

/**
 * The server reported another account key than the one this device pinned for the signed-in
 * user, so it may be impersonating them. Nothing else in the app is usable until the user
 * signs out (which also drops the pins); then the window reloads into the sign-in screen.
 */
export function OwnKeyMismatch() {
  const [signingOut, setSigningOut] = useState(false);
  return (
    <div className="lock-overlay" data-testid="own-key-mismatch">
      <AuthLayout title="Account key mismatch">
        <Notice tone="danger">
          Your server reported a different account key than the one this device saved for your
          account. Ternix stopped, because the server may be trying to impersonate you. Contact the
          server admin before you sign in again.
        </Notice>
        <div className="row">
          <span />
          <Button variant="danger" onClick={() => setSigningOut(true)}>
            Sign out
          </Button>
        </div>
        {signingOut ? (
          <SignOutDialog
            onClose={() => setSigningOut(false)}
            onSignedOut={() => setState({ ownKeyMismatch: false })}
          />
        ) : null}
      </AuthLayout>
    </div>
  );
}
