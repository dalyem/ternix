import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  EVENT_CHANNEL,
  PAGE_CHANNEL,
  RPC_CHANNEL,
  TERMINAL_CHANNEL_PREFIX,
  type TernixBridge,
} from '../shared/ipc.js';

/**
 * The renderer's only door to the main process: three narrow functions. Method names are
 * not allow-listed here (main does that and validates every argument); what this file
 * guarantees is that the renderer never touches `ipcRenderer`, an event object, or any
 * channel but these.
 */
const SESSION_ID = /^[0-9a-f-]{36}$/;

/**
 * This page load's generation, asked before any page script runs and kept out of their reach.
 * After a sign-out main reloads the window and refuses requests that carry an older one.
 */
const page: unknown = ipcRenderer.sendSync(PAGE_CHANNEL);

const bridge: TernixBridge = {
  invoke: (method, arg) => ipcRenderer.invoke(RPC_CHANNEL, page, method, arg),

  onEvent(listener) {
    const handler = (_event: IpcRendererEvent, name: unknown, payload: unknown) => {
      if (typeof name === 'string') listener(name, payload);
    };
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => void ipcRenderer.off(EVENT_CHANNEL, handler);
  },

  onTerminalData(id, listener) {
    if (!SESSION_ID.test(id)) throw new Error('Invalid terminal id');
    const channel = TERMINAL_CHANNEL_PREFIX + id;
    const handler = (_event: IpcRendererEvent, data: unknown) => {
      if (data instanceof Uint8Array) listener(data);
    };
    ipcRenderer.on(channel, handler);
    return () => void ipcRenderer.off(channel, handler);
  },
};

contextBridge.exposeInMainWorld('ternix', bridge);
