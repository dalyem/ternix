import { app, Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * macOS needs a menu for Cmd+C/V/Q to work. Elsewhere the menu bar is removed in release
 * builds; development keeps Electron's default menu for the developer tools.
 */
export function installMenu(): void {
  if (process.platform !== 'darwin') {
    if (app.isPackaged) Menu.setApplicationMenu(null);
    return;
  }
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
