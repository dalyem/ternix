import { CircleAlert, Info, TriangleAlert, X } from 'lucide-react';
import { useEffect } from 'react';
import { OwnKeyMismatch, SignedOut, Unlock } from './screens/Auth.js';
import { PromptHost } from './screens/Prompts.js';
import { Shell } from './screens/Shell.js';
import { boot, dismissToast, useStore } from './store.js';

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`} role="status">
          {t.level === 'error' ? (
            <CircleAlert size={14} aria-hidden />
          ) : t.level === 'warning' ? (
            <TriangleAlert size={14} aria-hidden />
          ) : (
            <Info size={14} aria-hidden />
          )}
          <span>{t.message}</span>
          <button className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X size={12} aria-hidden />
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
  const ownKeyMismatch = useStore((s) => s.ownKeyMismatch);

  useEffect(() => {
    void boot();
  }, []);

  if (!booted) {
    return (
      <div className="splash">
        <span className="welcome-drag" />
        Starting Ternix…
      </div>
    );
  }

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
      {ownKeyMismatch ? <OwnKeyMismatch /> : null}
      <Toasts />
    </>
  );
}
