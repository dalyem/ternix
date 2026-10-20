import { useEffect } from 'react';
import { SignedOut, Unlock } from './screens/Auth.js';
import { PromptHost } from './screens/Prompts.js';
import { Shell } from './screens/Shell.js';
import { boot, dismissToast, useStore } from './store.js';

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`} role="status">
          <span>{t.message}</span>
          <button aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const booted = useStore((s) => s.booted);
  const state = useStore((s) => s.clientState);
  const hasTerminals = useStore((s) => s.terminals.length > 0);

  useEffect(() => {
    void boot();
  }, []);

  if (!booted) return <div className="splash">Starting Ternix…</div>;

  // While locked (or signed out by the server) the vault UI is hidden but mounted if terminals
  // exist, so their scrollback survives; the lock or sign-in screen is drawn over it.
  const showShell = state === 'unlocked' || (hasTerminals && state !== 'loggedOut');

  return (
    <>
      {showShell ? <Shell locked={state !== 'unlocked'} /> : null}
      {state === 'locked' ? (
        <div className="lock-overlay">
          <Unlock />
        </div>
      ) : null}
      {state === 'loggedOut' || state === 'expired' ? <SignedOut /> : null}
      {state === 'unlocked' ? <PromptHost /> : null}
      <Toasts />
    </>
  );
}
