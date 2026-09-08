import { sessionId as makeSessionId } from '@harnessdesk/protocol'

import { confine } from '../workspace.js'
import type { MethodsUnder } from './context.js'

/** PTYs that outlive a client reload, hosted by whichever runtime runs processes. */
export const terminalMethods = {
  'terminal/open': async (ctx, params) => {
    const requested = ctx.runtimes.resolve(params)
    // A terminal is a workbench tool, not a property of the conversation's
    // backend. When the conversation's runtime runs no processes (ACP
    // agents don't), any ready runtime that does hosts the shell — and the
    // pane is told whose sandbox that is, so the hint stays truthful.
    const provider = requested.processes
      ? requested
      : ctx.runtimes.all().find((candidate) => candidate.processes && candidate.health().state === 'ready')
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
