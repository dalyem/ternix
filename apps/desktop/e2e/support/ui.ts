import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';

/** The vault picker is a menu under the Vaults tab: open it, run `read`, close it again. */
async function withVaultMenu<T>(page: Page, read: () => Promise<T>): Promise<T> {
  await page.getByRole('button', { name: 'Choose vault' }).click();
  const result = await read();
  await page.keyboard.press('Escape');
  return result;
}

/** Whether the vault picker lists a vault whose name matches. */
export function hasVault(page: Page, name: RegExp): Promise<boolean> {
  return withVaultMenu(page, async () => {
    const names = await page.getByRole('menuitemradio').allTextContents();
    return names.some((n) => name.test(n));
  });
}

/** Choose a vault in the picker: the lists show only its items. */
export async function pickVault(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Choose vault' }).click();
  await page.getByRole('menuitemradio', { name }).click();
}

const ARTIFACTS = resolve(import.meta.dirname, '..', 'artifacts');

/** A full-window PNG for the restyle review, `artifacts/restyle-<name>.png`. */
export async function restyleShot(page: Page, name: string): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  // Let the drawer's slide-in and the theme fades finish.
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(ARTIFACTS, `restyle-${name}.png`), type: 'png' });
}
