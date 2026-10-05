import { sessionId as makeSessionId } from '@harnessdesk/protocol'

import { confine } from '../workspace.js'
import type { MethodsUnder } from './context.js'

/** PTYs that outlive a client reload, hosted by whichever runtime runs processes. */
export const terminalMethods = {
  'terminal/open': async (ctx, params) => {
    const requested = ctx.runtimes.resolve(params)
    // A terminal is a workbench tool, not a property of the conversation's
    // backend. When the conversation's runtime runs no processes (ACP
    // agents don't), prefer a ready provider, then an idle one whose managed
    // process surface will restart it. The pane names the hosting sandbox.
    let provider = requested.processes ? requested : undefined
    if (!provider) {
      const candidates = ctx.runtimes.all()
      for (const state of ['ready', 'idle'] as const) {
        for (const candidate of candidates) {
          if (!candidate.processes || candidate.health().state !== state) continue
          const account = await candidate.getAccount()
          if (account.accounts.length === 0 && account.signInMethods.length > 0) continue
          provider = candidate
          break
        }
        if (provider) break
      }
    }
    if (!provider?.processes) {
      throw new Error(
        `${requested.info.presentation.name} does not run commands for the interface, ` +
          'and no other runtime is available to host a terminal.',
      )
    }
    const cwd = confine(params.cwd, ctx.workspaces.openRoots())
    const terminalId = await ctx.terminals.open({
      runtime: provider.info.id,
      processes: provider.processes,
      cwd,
      size: params.size,
      ...(params.sessionId && provider === requested ? { sessionId: makeSessionId(params.sessionId) } : {}),
      ...(params.command ? { command: params.command } : {}),
    })
    return { terminalId, runtime: provider.info.id }
  },

  'terminal/attach': (ctx, params) => ctx.terminals.attach(params.terminalId),

  'terminal/write': async (ctx, params) => {
    await ctx.terminals.write(params.terminalId, Buffer.from(params.data, 'base64'))
    return null
  },

  'terminal/resize': async (ctx, params) => {
    await ctx.terminals.resize(params.terminalId, params.size)
    return null
  },

  'terminal/close': async (ctx, params) => {
    await ctx.terminals.close(params.terminalId)
    return null
  },
} satisfies MethodsUnder<'terminal/'>
