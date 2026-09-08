import { homedir } from 'node:os'

import { installedBrowsers } from '@harnessdesk/cordis-host'
import { PROTOCOL_VERSION } from '@harnessdesk/protocol'

import type { MethodsUnder } from './context.js'

/**
 * The host about itself: the handshake, diagnostics, the renderer's stored
 * preferences, and the backup file.
 */
export const appMethods = {
  'host/hello': (ctx) => ({
    protocolVersion: PROTOCOL_VERSION,
    hostVersion: ctx.options.version ?? '0.1.0',
    runtimes: ctx.runtimes.all().map((runtime) => ctx.runtimes.infoOf(runtime)),
    credentialProtection: ctx.credentials.protection,
    // Read here rather than carried on the context: the renderer has no home
    // of its own, and this is the one place that tells it whose machine it is
    // drawing. `homedir()` is what every path in the library report was
    // already resolved against, so the two agree by construction.
    home: homedir(),
  }),

  'diagnostics/bundle': (ctx) => ctx.diagnostics(),

  'backup/export': (ctx) => ctx.backup.export(),

  'backup/import': (ctx, params) => ctx.backup.import(params.backup),

  'app/state/get': (ctx) => ctx.state.state.preferences,

  'app/browsers': () => installedBrowsers(),

  'app/state/set': async (ctx, params) => {
    await ctx.state.setPreferences(params.patch)
    // Where pages open is the one preference that is not only the
    // window's business: plugins in another process act on it.
    if ('browserPrefs' in params.patch) ctx.settings.applyBrowser()
    return null
  },
} satisfies MethodsUnder<'host/' | 'diagnostics/' | 'backup/' | 'app/'>
