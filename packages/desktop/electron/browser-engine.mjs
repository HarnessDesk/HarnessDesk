import { ipcMain, session, webContents } from 'electron'

import { createProfileBrowserEngine } from './browser-scopes.mjs'

export const createInlineBrowserEngine = (options) =>
  createProfileBrowserEngine({
    ...options,
    ipc: ipcMain,
    contents: webContents,
    sessionForPartition: (partition) => session.fromPartition(partition),
  })
