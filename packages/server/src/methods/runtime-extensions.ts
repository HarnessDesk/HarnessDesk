import type { MethodsUnder } from './context.js'

/** The `runtime/*` verbs about a runtime's own extension plane; `runtimes.ts` leaves these to this module. */
export type RuntimeExtensionPrefix =
  | 'runtime/catalog'
  | 'runtime/apps/'
  | 'runtime/plugin/'
  | 'runtime/mcp/'
  | 'runtime/imports/'

/**
 * A runtime's own extension plane — its plugin catalogue, app directory, MCP
 * servers and config import. HarnessDesk runs no store of its own; a runtime
 * without one answers empty, and a write to one it lacks is refused by name.
 */
export const runtimeExtensionMethods = {
  'runtime/catalog': (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    if (!runtime.extensions) return { plugins: [], marketplaces: [], loadErrors: [], featured: [] }
    return runtime.extensions.catalog(params.cwd)
  },

  'runtime/apps/search': (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    if (!runtime.extensions) return { apps: [], nextCursor: null }
    return runtime.extensions.searchApps(params.query, params.cursor ?? null)
  },

  'runtime/plugin/install': async (ctx, params) => {
    await ctx.runtimes.extensionsOf(params).install(params.marketplace, params.pluginName)
    return null
  },

  'runtime/plugin/uninstall': async (ctx, params) => {
    await ctx.runtimes.extensionsOf(params).uninstall(params.pluginId)
    return null
  },

  'runtime/mcp/list': (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    return runtime.extensions ? runtime.extensions.mcpServers(params.cwd) : []
  },

  'runtime/mcp/login': async (ctx, params) => ({ url: await ctx.runtimes.extensionsOf(params).mcpLogin(params.name) }),

  'runtime/mcp/reload': async (ctx, params) => {
    await ctx.runtimes.extensionsOf(params).reloadMcp()
    return null
  },

  'runtime/imports/detect': (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    return runtime.extensions ? runtime.extensions.detectImports(params.cwd) : []
  },

  'runtime/imports/apply': async (ctx, params) => {
    await ctx.runtimes.extensionsOf(params).importConfigs(params.items)
    return null
  },
} satisfies MethodsUnder<RuntimeExtensionPrefix>
