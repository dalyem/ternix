/// <reference types="vite/client" />
import type { TernixBridge } from '../../shared/ipc.js';

declare global {
  interface Window {
    /** Exposed by the preload script. */
    readonly ternix: TernixBridge;
  }
}
