import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/app.js';
import { AutoLock } from '../src/main/app/autoLock.js';
import { isAppUrl } from '../src/main/app/security.js';
import { SettingsStore } from '../src/main/app/settings.js';
import { parseQuickTarget } from '../src/main/ssh/quick.js';

describe('SettingsStore', () => {
  let dir: string;
  beforeEach(async () => void (dir = await mkdtemp(join(tmpdir(), 'ternix-settings-'))));
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('defaults, persists and reloads', async () => {
    const store = new SettingsStore(dir);
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
    await store.update({ autoLockMinutes: 5 });
    const again = new SettingsStore(dir);
    expect(await again.load()).toEqual({ ...DEFAULT_SETTINGS, autoLockMinutes: 5 });
  });

  it('keeps valid fields and defaults bad ones from a damaged file', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ autoLockMinutes: 'soon', terminalFontSize: 18 }),
    );
    expect(await new SettingsStore(dir).load()).toEqual({
      ...DEFAULT_SETTINGS,
      terminalFontSize: 18,
    });
    await writeFile(join(dir, 'settings.json'), '{not json');
    expect(await new SettingsStore(dir).load()).toEqual(DEFAULT_SETTINGS);
  });

  it('rejects out-of-range updates without touching the file', async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await expect(store.update({ terminalFontSize: 500 })).rejects.toThrow();
    await expect(readFile(join(dir, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('AutoLock', () => {
  function setup(opts: { idle: number; minutes: number; unlocked?: boolean }) {
    const lock = vi.fn();
    const auto = new AutoLock({
      idleSeconds: () => opts.idle,
      minutes: () => opts.minutes,
      isUnlocked: () => opts.unlocked ?? true,
      lock,
    });
    return { auto, lock };
  }

  it('locks once the system has been idle for the timeout', () => {
    const { auto, lock } = setup({ idle: 15 * 60, minutes: 15 });
    auto.tick();
    expect(lock).toHaveBeenCalledOnce();
  });

  it('does not lock before the timeout, when disabled, or when already locked', () => {
    for (const opts of [
      { idle: 14 * 60 + 59, minutes: 15 },
      { idle: 99999, minutes: 0 },
      { idle: 99999, minutes: 15, unlocked: false },
    ]) {
      const { auto, lock } = setup(opts);
      auto.tick();
      expect(lock).not.toHaveBeenCalled();
    }
  });
});

describe('isAppUrl', () => {
  const urls = { devUrl: undefined };

  it('accepts only the app page on the app scheme', () => {
    expect(isAppUrl('ternix://app/index.html', urls)).toBe(true);
    expect(isAppUrl('ternix://app/', urls)).toBe(true);
    expect(isAppUrl('ternix://app/index.html#/x', urls)).toBe(true);
    expect(isAppUrl('ternix://other/index.html', urls)).toBe(false);
    expect(isAppUrl('ternix://app/assets/x.js', urls)).toBe(false);
    expect(isAppUrl('file:///etc/passwd', urls)).toBe(false);
    expect(isAppUrl('file:///opt/Ternix/resources/app/out/renderer/index.html', urls)).toBe(false);
    expect(isAppUrl('https://evil.example/', urls)).toBe(false);
    expect(isAppUrl('data:text/html,hi', urls)).toBe(false);
    expect(isAppUrl('not a url', urls)).toBe(false);
  });

  it('accepts the dev server origin only in development', () => {
    const dev = { devUrl: 'http://localhost:5173/' };
    expect(isAppUrl('http://localhost:5173/src/main.tsx', dev)).toBe(true);
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isAppUrl('http://localhost:5173/', urls)).toBe(false);
  });
});

describe('parseQuickTarget', () => {
  it('parses user, host and port', () => {
    expect(parseQuickTarget('root@10.0.0.1')).toEqual({
      username: 'root',
      host: '10.0.0.1',
      port: 22,
    });
    expect(parseQuickTarget(' me@srv.example.com:2222 ')).toEqual({
      username: 'me',
      host: 'srv.example.com',
      port: 2222,
    });
    expect(parseQuickTarget('me@[fd7a::1]:2200')).toEqual({
      username: 'me',
      host: 'fd7a::1',
      port: 2200,
    });
    expect(parseQuickTarget('me@fd7a::1')).toEqual({ username: 'me', host: 'fd7a::1', port: 22 });
  });

  it('requires a user name and a sane port', () => {
    for (const bad of [
      'host',
      '@host',
      'me@',
      'me@host:0',
      'me@host:99999',
      'me@host:x',
      'a b@host',
    ]) {
      expect(() => parseQuickTarget(bad), bad).toThrow();
    }
  });
});
