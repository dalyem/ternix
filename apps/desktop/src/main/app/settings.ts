import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type AppSettings,
  DEFAULT_SETTINGS,
  MAX_AUTO_LOCK_MINUTES,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
} from '../../shared/app.js';
import { Serial, writeFileAtomic } from './fsUtil.js';

export const settingsSchema = z.object({
  autoLockMinutes: z.number().int().min(0).max(MAX_AUTO_LOCK_MINUTES),
  terminalFontSize: z.number().int().min(MIN_FONT_SIZE).max(MAX_FONT_SIZE),
  detectHostOs: z.boolean(),
});

export const settingsPatchSchema = settingsSchema.partial().strict();

/** Non-secret preferences, in `settings.json` under `userData`. Bad values fall back to defaults. */
export class SettingsStore {
  private readonly file: string;
  private readonly serial = new Serial();
  private current: AppSettings = { ...DEFAULT_SETTINGS };

  constructor(dir: string) {
    this.file = join(dir, 'settings.json');
  }

  async load(): Promise<AppSettings> {
    let stored: unknown = {};
    try {
      stored = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      // Missing or unreadable: defaults.
    }
    const object = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
    const next: Record<keyof AppSettings, unknown> = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
      const field = settingsSchema.shape[key].safeParse(object[key]);
      if (field.success) next[key] = field.data;
    }
    this.current = next as AppSettings;
    return this.get();
  }

  get(): AppSettings {
    return { ...this.current };
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = settingsSchema.parse({ ...this.current, ...patch });
    await this.serial.run(() => writeFileAtomic(this.file, JSON.stringify(next, null, 2)));
    this.current = next;
    return this.get();
  }
}
