import { type ReactNode, useEffect, useState } from 'react';
import type { ProbedServerDto } from '../../../shared/ipc.js';
import { call, errorMessage } from '../api.js';
import { rememberServerUrl } from '../store.js';
import { Badge, Button, Notice, TextField } from '../ui.js';

export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ▍
          </span>
          Ternix
        </div>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

/** What addresses are accepted: https, except plain http for this computer. */
export function ServerAddressHint() {
  return (
    <>
      On Tailscale, use <code>https://&lt;machine&gt;.&lt;tailnet&gt;.ts.net</code> (Tailscale serve
      provides the certificate; this device must be on the tailnet). Plain <code>http://</code>{' '}
      works only for localhost.
    </>
  );
}

/** Probes an address as the user types; resolves to server info or a message. */
export function useServerProbe(address: string, delayMs = 450) {
  const [info, setInfo] = useState<ProbedServerDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    setInfo(null);
    setError(null);
    if (address.trim() === '') {
      setChecking(false);
      return;
    }
    setChecking(true);
    let alive = true;
    const timer = setTimeout(() => {
      call('server.probe', { address }).then(
        (result) => {
          if (!alive) return;
          setInfo(result);
          setChecking(false);
        },
        (err: unknown) => {
          if (!alive) return;
          setError(errorMessage(err));
          setChecking(false);
        },
      );
    }, delayMs);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [address, delayMs]);
  return { info, error, checking };
}

export function ServerInfoCard({ info }: { info: ProbedServerDto }) {
  return (
    <div className="server-card" data-testid="server-info">
      <div>
        <strong>{info.name}</strong> <span className="muted">v{info.version}</span>
      </div>
      <div>
        <span className="muted mono">{info.serverUrl}</span>{' '}
        {info.tailnet ? <Badge tone="accent">Tailscale</Badge> : null}
      </div>
      <div>
        Registration:{' '}
        <Badge tone={info.registration === 'open' ? 'good' : 'neutral'}>{info.registration}</Badge>
        {info.registration === 'invite' ? (
          <span className="muted"> an invite code from an admin is needed</span>
        ) : null}
        {info.registration === 'closed' ? (
          <span className="muted"> only existing accounts can sign in</span>
        ) : null}
      </div>
    </div>
  );
}

/** First run: choose the server. */
export function ServerSetup({
  initial,
  onDone,
  onCancel,
}: {
  initial: string;
  onDone: (info: ProbedServerDto) => void;
  onCancel?: () => void;
}) {
  const [address, setAddress] = useState(initial);
  const { info, error, checking } = useServerProbe(address);

  return (
    <AuthLayout title="Connect to your server">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!info) return;
          rememberServerUrl(info.serverUrl);
          onDone(info);
        }}
      >
        <TextField
          label="Server address"
          value={address}
          onChange={setAddress}
          placeholder="https://ternix.your-tailnet.ts.net"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          hint={<ServerAddressHint />}
        />
        {checking ? <div className="muted">Checking the server…</div> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {info ? <ServerInfoCard info={info} /> : null}
        <div className="row">
          {onCancel ? <Button onClick={onCancel}>Back</Button> : <span />}
          <Button variant="primary" type="submit" disabled={!info}>
            Continue
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
