import type { AgentRuntime, InstallInfo } from '@harnessdesk/protocol'

import { CredentialBroker } from '../credentials.js'
import type { HostContext, MethodsUnder } from './context.js'

/**
 * Every copy of one agent on this machine, scanned afresh. Null when the
 * host has no knowledge of that agent — which is what the page then says,
 * rather than an empty section pretending the machine was searched.
 */
const describeInstall = async (
  ctx: HostContext,
  runtime: AgentRuntime,
): Promise<InstallInfo | null> => {
  const installs = ctx.options.installs
  const config = ctx.options.agents?.configOf(String(runtime.info.id))
  if (!installs || !config) return null
  return installs.describe(config)
}

/**
 * The `runtime/*` verbs that are about an account rather than about the
 * runtime — answered here, and carved out of `runtimes.ts` by name.
 */
export type AccountRuntimePrefix = 'runtime/account/' | 'runtime/apiKey/'

/**
 * Who is registered and who is signed in: the writable agent registry, extra
 * accounts of one agent, and the API keys the host stores on an agent's
 * behalf.
 */
export const accountMethods = {
  'agents/catalog': (ctx) => {
    const agents = ctx.options.agents
    if (!agents) return []
    return agents.templates(ctx.runtimes.ids())
  },

  'agents/registry': (ctx) => {
    const agents = ctx.options.agents
    if (!agents) {
      return { agents: [], fetchedAt: null, unavailable: 'This host has no writable agent registry.' }
    }
    return agents.registryCatalog(ctx.runtimes.ids())
  },

  'agents/register': async (ctx, params) => {
    const agents = ctx.options.agents
    if (!agents) throw new Error('This host has no writable agent registry.')
    const { runtime, usage } = await agents.register(params, ctx.runtimes.ids())
    if (usage) ctx.runtimes.bindUsage(runtime.info.id, usage)
    ctx.runtimes.register(runtime)
    const info = ctx.runtimes.infoOf(runtime)
    ctx.push({ method: 'runtime/added', params: { info } })
    // Failing to start is the runtime's own health to report, not a
    // failed registration: the row exists, and the screen says why it is
    // not ready.
    //
    // Not awaited, unlike an added *account*, which does wait — the caller
    // there signs the new account in on the next line, and only a started
    // agent can say how. Registering an agent has no such next step, and an
    // ACP agent answers `runtime/account` from its configuration without a
    // process at all.
    void ctx.runtimes.start(runtime)
    ctx.logger.info('agent registered from the interface', { runtime: runtime.info.id })
    return { runtime: runtime.info.id, info }
  },

  'agents/remove': async (ctx, params) => {
    const agents = ctx.options.agents
    const runtime = ctx.runtimes.resolve(params)
    if (!agents?.owns(runtime.info.id)) {
      throw new Error(
        `${runtime.info.presentation.name} is not in the agent registry, so there is nothing to unregister.`,
      )
    }
    await ctx.runtimes.unregister(runtime.info.id)
    await agents.remove(runtime.info.id)
    ctx.logger.info('agent unregistered from the interface', { runtime: runtime.info.id })
    return null
  },

  'agents/installs': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    const info = await describeInstall(ctx, runtime)
    if (!info) {
      throw new Error(`HarnessDesk has no install knowledge for ${runtime.info.presentation.name}.`)
    }
    return info
  },

  'agents/installs/use': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    const installs = ctx.options.installs
    if (!installs || !ctx.options.agents?.owns(runtime.info.id)) {
      throw new Error(
        `${runtime.info.presentation.name} is not an agent whose install HarnessDesk chooses.`,
      )
    }
    installs.pin(String(runtime.info.id), params.path)
    // The next start honours the pin; an idle runtime is moved onto it now.
    if (runtime.checkInstallation) {
      await runtime.checkInstallation().catch((error: unknown) => {
        ctx.logger.warn('the pinned install was not adopted yet', {
          runtime: runtime.info.id,
          error: String(error),
        })
      })
    }
    const info = await describeInstall(ctx, runtime)
    if (!info) {
      throw new Error(`HarnessDesk has no install knowledge for ${runtime.info.presentation.name}.`)
    }
    ctx.push({
      method: 'runtime/infoChanged',
      params: { runtime: runtime.info.id, info: ctx.runtimes.infoOf(runtime) },
    })
    ctx.logger.info('install pinned', { runtime: runtime.info.id, path: params.path })
    return info
  },

  'agents/update': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    const agents = ctx.options.agents
    if (!agents?.owns(runtime.info.id)) {
      throw new Error(
        `${runtime.info.presentation.name} was not installed by HarnessDesk, so its package manager updates it.`,
      )
    }
    const { from, to } = await agents.updateManaged(runtime.info.id)
    let restarted = false
    // A runtime that cannot be asked has nothing to move onto the new build,
    // and the row already points at it — so the superseded download is
    // collected either way. Only a runtime that *was* asked and stayed busy
    // keeps both, until its next idle check moves it.
    let collectable = runtime.checkInstallation === undefined
    if (runtime.checkInstallation) {
      const check = await runtime.checkInstallation().catch(() => ({ changed: false as const }))
      restarted = check.changed && check.restarted
      collectable = restarted
    }
    if (collectable && from !== to) agents.discardVersion(runtime.info.id, from)
    await describeInstall(ctx, runtime)
    const info = ctx.runtimes.infoOf(runtime)
    ctx.push({ method: 'runtime/infoChanged', params: { runtime: runtime.info.id, info } })
    ctx.logger.info('managed install updated', { runtime: runtime.info.id, from, to, restarted })
    return { runtime: runtime.info.id, info }
  },

  'runtime/account/add': (ctx, params) => ctx.accounts.add(params.runtime, params.gateway),

  'runtime/account/remove': async (ctx, params) => {
    await ctx.accounts.remove(params.runtime)
    return null
  },

  'runtime/apiKey/store': async (ctx, params) => {
    const env = params.methodId.replace(/^apiKey:/, '')
    await ctx.credentials.put(CredentialBroker.secretName(params.runtime, env), params.value)
    // The agent read its environment when it started, so storing a key
    // is only half the job: tell the runtime, which restarts to pick it
    // up. Without this a user stored a key and the very next turn failed
    // saying there was none.
    const applied = await ctx.accounts.reloadSecrets(params.runtime)
    await ctx.accounts.announce(params.runtime)
    return { applied }
  },

  'runtime/apiKey/clear': async (ctx, params) => {
    const env = params.methodId.replace(/^apiKey:/, '')
    await ctx.credentials.forget(CredentialBroker.secretName(params.runtime, env))
    const applied = await ctx.accounts.reloadSecrets(params.runtime)
    await ctx.accounts.announce(params.runtime)
    return { applied }
  },
} satisfies MethodsUnder<'agents/' | AccountRuntimePrefix>
