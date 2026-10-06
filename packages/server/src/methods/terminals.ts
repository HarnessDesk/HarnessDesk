import { sessionId as makeSessionId } from '@harnessdesk/protocol'

import { within } from '../seat-reads.js'
import { confine } from '../workspace.js'
import type { MethodsUnder } from './context.js'

export const TERMINAL_ACCOUNT_READ_DEADLINE_MS = 2_000

/** PTYs that outlive a client reload, hosted by whichever runtime runs processes. */
export const terminalMethods = {
  'terminal/open': async (ctx, params) => {
    const requested = ctx.runtimes.resolve(params)
    // A terminal is a workbench tool, not a property of the conversation's
    // backend. When the conversation's runtime runs no processes (ACP
    // agents don't), prefer providers that are ready, then already starting,
    // then idle. The managed process surface joins or starts the runtime.
    // Only a ready tier has a choice worth ordering; a starting provider's
    // account read would wait for its start.
    let provider = requested.processes ? requested : undefined
    if (!provider) {
      const candidates = ctx.runtimes.all().filter((candidate) => candidate.processes)
      for (const state of ['ready', 'starting', 'idle'] as const) {
        const tier = candidates.filter((candidate) => candidate.health().state === state)
        if (tier.length === 0) continue
        if (state !== 'ready' || tier.length === 1) {
          provider = tier[0]
          break
        }

        let answered: typeof requested | undefined
        for (const candidate of tier) {
          const result = await within(async () => {
            const account = await candidate.getAccount()
            return account.accounts.length === 0 && account.signInMethods.length > 0
          }, TERMINAL_ACCOUNT_READ_DEADLINE_MS)
          if (result.settled !== 'value') {
            ctx.logger.warn('a terminal provider account read did not answer, so other providers are preferred', {
              runtime: candidate.info.id,
              ...(result.settled === 'late'
                ? { afterMs: TERMINAL_ACCOUNT_READ_DEADLINE_MS }
                : { error: String(result.error) }),
            })
            continue
          }
          answered ??= candidate
          if (!result.value) {
            provider = candidate
            break
          }
        }
        provider ??= answered ?? tier[0]
        break
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
