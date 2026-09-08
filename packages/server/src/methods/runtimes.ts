import { findOption, refuseOptionValue, type AgentRuntime, type ConfigOption, type OptionValue } from '@harnessdesk/protocol'

import type { AccountRuntimePrefix } from './accounts.js'
import type { MethodsUnder } from './context.js'
import type { RuntimeExtensionPrefix } from './runtime-extensions.js'

/**
 * A runtime's own surfaces: health, models, options, skills, hooks, and the
 * sign-in flows it can drive. Nothing here names a runtime or a command —
 * sign-in belongs to the runtime, which holds the credentials, runs the flow,
 * and reports the outcome as an event; the host only relays.
 */
export const runtimeMethods = {
  'runtime/health': (ctx, params) => ctx.runtimes.resolve(params).health(),

  'runtime/refreshCatalog': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    const result = await ctx.catalogs.refresh(runtime.info.id)
    // `refreshed` and its reason travel: a caller that asked on somebody's
    // behalf has to be able to say whether it happened.
    return {
      checkedAt: result.checkedAt,
      installation: result.installation,
      refreshed: result.refreshed,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    }
  },

  'runtime/models': (ctx, params) => ctx.runtimes.resolve(params).listModels(),

  'runtime/account': (ctx, params) => ctx.runtimes.resolve(params).getAccount(),

  'runtime/limits': (ctx, params) => {
    // Through the service, so a runtime that cannot meter itself still
    // reaches the surfaces that read this — the footer, the composer ring.
    const runtime = ctx.runtimes.resolve(params)
    const metered = ctx.runtimes.metered().some((entry) => entry.info.id === runtime.info.id)
    return metered ? ctx.usage().limitsFor(runtime) : null
  },

  'runtime/options': (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    return runtime.listOptions ? runtime.listOptions() : []
  },

  'runtime/sessionDefaults': (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    if (!runtime.defaultSessionOptions) return []
    return runtime.defaultSessionOptions(params.cwd, params.values)
  },

  'runtime/options/set': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    if (!runtime.listOptions || !runtime.setOption) {
      throw new Error(`${runtime.info.presentation.name} has no runtime-wide options.`)
    }
    checkOption(await runtime.listOptions(), params.optionId, params.value)
    await runtime.setOption(params.optionId, params.value)
    return null
  },

  'runtime/skills': (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    // Optional on the interface: a runtime without skills says so by not
    // implementing it, rather than by returning a misleading empty list.
    return runtime.listSkills ? runtime.listSkills(params.cwd) : []
  },

  'runtime/skills/setEnabled': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    if (!runtime.setSkillEnabled) throw new Error('This runtime does not let a client toggle skills.')
    await runtime.setSkillEnabled({ name: params.name, path: params.path ?? null }, params.enabled)
    return null
  },

  'runtime/hooks': (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    return runtime.listHooks ? runtime.listHooks(params.cwd) : []
  },

  'runtime/login': (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    if (!runtime.login) throw new Error(signInUnavailable(runtime))
    return runtime.login(params.method)
  },

  'runtime/login/cancel': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    if (runtime.cancelLogin) await runtime.cancelLogin(params.loginId)
    return null
  },

  'runtime/logout': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    if (!runtime.logout) throw new Error(signInUnavailable(runtime))
    await runtime.logout()
    return null
  },
} satisfies MethodsUnder<'runtime/', AccountRuntimePrefix | RuntimeExtensionPrefix>

/**
 * Refuses a value the option does not take, in the protocol's own words, so a
 * runtime-wide option and a session option are refused identically.
 */
export const checkOption = (options: readonly ConfigOption[], id: string, value: OptionValue): void => {
  const option = findOption(options, id)
  if (!option) throw new Error(`There is no option named ${JSON.stringify(id)}.`)
  const refusal = refuseOptionValue(option, value)
  if (refusal) throw new Error(refusal)
}

const signInUnavailable = (runtime: AgentRuntime): string => {
  const how = runtime.info.presentation.signIn?.command
  return how
    ? `${runtime.info.presentation.name} does not sign in from the interface. Run \`${how}\` in a terminal instead.`
    : `${runtime.info.presentation.name} has no sign-in to drive from the interface.`
}
