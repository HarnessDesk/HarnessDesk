import type { HarnessContext, HarnessPlugin } from '@harnessdesk/cordis-host'

import { PerSession } from './session-state.js'

/**
 * Policies that catch an agent going in circles.
 *
 * DeepSeek Harness splits these across `dsh-repeat-tool-reminder` and
 * `dsh-tool-call-timeout-policy`. They are grouped here because they answer one
 * question — is this turn still making progress — and because a user deciding
 * whether to enable "guardrails" is making one decision, not two.
 *
 * Nothing here denies. A policy that blocks work on a heuristic is worse than
 * the loop it was trying to stop; these escalate to the user instead.
 */

interface Config {
  readonly repeatThreshold?: number
  readonly warnAfterCalls?: number
}

/** A stable key for "the same call again", ignoring key order in the arguments. */
export const callSignature = (tool: string, args: unknown): string => {
  const normalise = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalise)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, normalise(entry)]),
      )
    }
    return value
  }
  return `${tool}::${JSON.stringify(normalise(args))}`
}

export const guardrailsPlugin: HarnessPlugin = {
  manifest: {
    id: 'guardrails',
    name: 'Guardrails',
    description: 'Notices when a turn repeats itself or runs unusually long, and asks you.',
    permissions: {},
    configSchema: {
      type: 'object',
      properties: {
        repeatThreshold: {
          type: 'number',
          title: 'Identical calls before asking',
          description: 'How many times the same call may repeat before you are consulted.',
        },
        warnAfterCalls: {
          type: 'number',
          title: 'Tool calls in a turn before asking',
        },
      },
    },
  },
  plugin: {
    name: 'guardrails',
    inject: ['hooks'],
    apply(ctx: HarnessContext, config: Config) {
      const repeatThreshold = Math.max(config?.repeatThreshold ?? 3, 2)
      const warnAfter = Math.max(config?.warnAfterCalls ?? 60, 5)

      /* Per conversation, not per process: the kernel is one instance for the
         whole application, so a shared counter meant one turn starting anywhere
         cleared everyone's, and concurrent calls from different conversations
         all incremented the same total. */
      const sessions = new PerSession(() => ({
        counts: new Map<string, number>(),
        callsThisTurn: 0,
        warnedAboutLength: false,
      }))

      ctx.hooks.register({
        event: 'preTurn',
        handle: (invocation) => {
          // Counters are per turn: a repeat across turns is the user asking
          // again, which is not a loop.
          sessions.reset(invocation.scope)
        },
      })

      ctx.hooks.register({
        event: 'preToolUse',
        priority: 50,
        handle: (invocation) => {
          const state = sessions.get(invocation.scope)
          state.callsThisTurn += 1

          if (state.callsThisTurn === warnAfter && !state.warnedAboutLength) {
            state.warnedAboutLength = true
            return {
              decision: 'ask',
              reason: `This turn has made ${warnAfter} tool calls. Continue?`,
            }
          }

          if (!invocation.toolName) return
          const key = callSignature(invocation.toolName, invocation.arguments)
          const seen = (state.counts.get(key) ?? 0) + 1
          state.counts.set(key, seen)

          // Only on the threshold itself: asking on every subsequent repeat
          // would turn one loop into a stream of prompts.
          if (seen === repeatThreshold) {
            return {
              decision: 'ask',
              reason: `\`${invocation.toolName}\` has been called ${seen} times with identical arguments. It may be stuck.`,
            }
          }
          return
        },
      })
    },
  },
}
