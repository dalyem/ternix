import type { RpcResult, SessionNotice } from '../../shared/ipc.js';
import type { ClientState } from '../../shared/types.js';
import type { TernixClient } from '../client/index.js';

/** The part of `TernixClient` the gate watches. */
export type SessionSource = Pick<TernixClient, 'state' | 'on'>;

type Dispatch = (method: unknown, arg: unknown) => Promise<RpcResult<unknown>>;

const signedIn = (state: ClientState) => state === 'locked' || state === 'unlocked';
const signedOut = (state: ClientState) => state === 'loggedOut' || state === 'expired';

/** Leaving an authenticated session: logout, expiry, revocation (account switches log out). */
export const leavesSession = (previous: ClientState, next: ClientState): boolean =>
  signedIn(previous) && signedOut(next);

const stale: RpcResult<never> = {
  ok: false,
  error: {
    name: 'AppError',
    code: 'stale_page',
    message: 'This page was replaced after you signed out. Request refused.',
  },
};

/**
 * A page that was signed in may hold revealed secrets in its own JavaScript, and once signed
 * out it could reach `server.probe` (any URL) or `auth.login` (any server). So when the client
 * leaves a session, main reloads the window and refuses every request from the page that was
 * there before the reload.
 *
 * Each page load gets the current generation from its preload, once, before any page script
 * runs; the preload sends it with every request (page scripts cannot reach `ipcRenderer`, so
 * they cannot change it). Leaving a session bumps the generation, so the old page's requests
 * carry a number that is no longer current. Locking does not reload: everything that could
 * send data out is already refused while locked.
 */
export class PageGate {
  private generation = 1;

  constructor(private readonly reload: () => void) {}

  /** For the preload of a page that is starting. */
  issue(): number {
    return this.generation;
  }

  isCurrent(token: unknown): boolean {
    return token === this.generation;
  }

  /** Retire the current page: its requests are refused from now on, and a fresh one loads. */
  retire(): void {
    this.generation += 1;
    this.reload();
  }

  /** Retire the page whenever `client` leaves an authenticated session. */
  watch(client: SessionSource): () => void {
    let previous = client.state;
    return client.on('state', (state) => {
      const left = leavesSession(previous, state);
      previous = state;
      if (left) this.retire();
    });
  }

  /** `dispatch`, for requests that carry the generation of the page that sent them. */
  guard(dispatch: Dispatch) {
    return (token: unknown, method: unknown, arg: unknown): Promise<RpcResult<unknown>> =>
      this.isCurrent(token) ? dispatch(method, arg) : Promise.resolve(stale);
  }
}

/**
 * Why the last session ended, kept for the page that loads after the reload (the page that saw
 * it happen is gone). Cleared when a session starts again.
 */
export class SessionNotices {
  current: SessionNotice | null = null;

  watch(client: SessionSource): void {
    client.on('state', (state) => {
      if (signedIn(state)) this.current = null;
    });
    client.on('session-revoked', ({ reason }) => (this.current = reason));
  }
}
