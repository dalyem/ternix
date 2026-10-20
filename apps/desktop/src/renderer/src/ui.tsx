import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type { VaultRole } from '../../shared/types.js';
import { errorMessage, isCancelled } from './api.js';
import { runAuthExclusive, useStore } from './store.js';

export function Button({
  variant = 'default',
  busy,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      className={`btn btn-${variant} ${props.className ?? ''}`}
      disabled={props.disabled || busy}
    >
      {busy ? <span className="spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  ...input
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  required?: boolean;
  autoComplete?: string;
  maxLength?: number;
  spellCheck?: boolean;
  inputMode?: 'numeric' | 'text';
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <input id={id} value={value} onChange={(e) => onChange(e.target.value)} {...input} />
      )}
    </Field>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  hint,
  rows = 4,
  mono,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  rows?: number;
  mono?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <textarea
          id={id}
          rows={rows}
          className={mono ? 'mono' : undefined}
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          {...rest}
        />
      )}
    </Field>
  );
}

export function Select<T extends string>({
  label,
  value,
  onChange,
  options,
  hint,
  disabled,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as T)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="error-text" role="alert">
      {errorMessage(error)}
    </div>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'danger';
  children: ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'info' ? 'status' : 'alert'}>
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'good' | 'warn' | 'bad';
  title?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/**
 * What this device knows about a person's key: `key changed` when the server reports another
 * key than the pinned one, `unverified` when the pin was only trusted on first use,
 * `verified` once the fingerprint was compared out of band.
 */
export function PinBadge({ verified, keyChanged }: { verified: boolean; keyChanged: boolean }) {
  if (keyChanged) {
    return (
      <Badge tone="bad" title="The server reports a different key than the one this device pinned">
        key changed
      </Badge>
    );
  }
  if (!verified) {
    return (
      <Badge
        tone="warn"
        title="Seen for the first time and trusted, but never compared out of band"
      >
        unverified
      </Badge>
    );
  }
  return (
    <Badge tone="good" title="You compared this fingerprint out of band">
      verified
    </Badge>
  );
}

const ROLE_TONE: Record<VaultRole, 'accent' | 'good' | 'neutral'> = {
  owner: 'accent',
  editor: 'good',
  viewer: 'neutral',
};

export function RoleBadge({ role }: { role: VaultRole }) {
  return <Badge tone={ROLE_TONE[role]}>{role}</Badge>;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  danger,
  dismissable = true,
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  danger?: boolean;
  dismissable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(
      'input:not([disabled]), textarea, select, button.btn-primary',
    );
    first?.focus();
    return () => previous?.focus?.();
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose?.();
      }}
      onKeyDown={(e) => {
        if (dismissable && e.key === 'Escape') onClose?.();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? 'modal-wide' : ''} ${danger ? 'modal-danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>{title}</h2>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  confirmDisabled,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => Promise<unknown> | unknown;
  onClose: () => void;
}) {
  const action = useAction();
  return (
    <Modal
      title={title}
      onClose={onClose}
      danger={danger}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            busy={action.busy}
            disabled={confirmDisabled}
            onClick={() => void action.run(async () => (await onConfirm(), onClose()))}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div>{message}</div>
      <ErrorText error={action.error} />
    </Modal>
  );
}

/** Tracks a pending async action and its error, for buttons and forms. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);
  const run = useCallback(async <T,>(task: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await task();
    } catch (err) {
      // Cancelled by lock, logout or quit: the screen is changing anyway, so no error.
      if (mounted.current && !isCancelled(err)) setError(err);
      return undefined;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  return { busy, error, run, clear: () => setError(null) };
}

/**
 * Like `useAction`, for login, register, unlock and logout: only one of them runs at a time
 * across the whole window. `blocked` is true while any of them is pending; disable buttons
 * with it.
 */
export function useAuthAction() {
  const action = useAction();
  const blocked = useStore((s) => s.authPending);
  const { run: plainRun } = action;
  const run = useCallback(
    <T,>(task: () => Promise<T>): Promise<T | undefined> =>
      plainRun(async () => runAuthExclusive(task)),
    [plainRun],
  );
  return { ...action, run, blocked };
}

/** Load something once and on demand; `reload` refetches. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    load().then(
      (value) => {
        if (!alive) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!alive) return;
        setError(err);
        setLoading(false);
      },
    );
    return () => void (alive = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  return { data, error, loading, reload: () => setVersion((v) => v + 1) };
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** A fingerprint in a monospace box, selectable so people can read it aloud or copy it. */
export function Fingerprint({ value }: { value: string }) {
  return <code className="fingerprint">{value}</code>;
}
