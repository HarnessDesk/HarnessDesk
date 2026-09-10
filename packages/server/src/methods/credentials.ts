import { randomBytes } from 'node:crypto'

import type { ModelRouteRecord } from '../host.js'
import type { MethodsUnder } from './context.js'

/**
 * Secrets and what refers to them. The broker returns references, never
 * values; a model route names a credential by reference and the host
 * exchanges it for a loopback gateway when a session asks for the route.
 */
export const credentialMethods = {
  /**
   * Every stored secret, each saying what owns it.
   *
   * Two sources, because there are two mechanisms. An agent's sign-in key is
   * recorded as one when it is written (`CredentialBroker.store`), and read
   * back out of its name for entries older than that field. A gateway
   * account's key is named by the slot that holds it, so it is marked from
   * live state and needs no migration at all.
   */
  'credentials/list': async (ctx) => {
    const gateways = new Map(
      ctx.accounts.gatewayCredentials().map((one) => [one.ref, one.name] as const),
    )
    return (await ctx.credentials.describe()).map(({ agent, ...rest }) => {
      const gateway = gateways.get(rest.ref)
      return {
        ...rest,
        owner: gateway
          ? ({ kind: 'gateway', of: gateway } as const)
          : agent
            ? ({ kind: 'agent', of: agent } as const)
            : null,
      }
    })
  },

  'credentials/store': async (ctx, params) => ({ ref: await ctx.credentials.store(params.name, params.value) }),

  'credentials/delete': async (ctx, params) => {
    await ctx.credentials.delete(params.ref)
    return null
  },

  'audit/query': (ctx, params) =>
    ctx.audit.query({
      ...(params.root ? { root: params.root } : {}),
      ...(params.sinceDays ? { sinceDays: params.sinceDays } : {}),
    }),

  'routes/list': (ctx, params) => {
    const runtime = params.runtime ? ctx.runtimes.get(params.runtime) : undefined
    return ctx.routes.list().map((route) => ({
      ...route,
      ...(runtime ? ctx.routes.usable(runtime, route) : {}),
    }))
  },

  'routes/save': async (ctx, params) => {
    const routes = [...ctx.routes.list()]
    const id = params.id ?? `route_${randomBytes(6).toString('hex')}`
    const next: ModelRouteRecord = {
      id,
      name: params.name,
      endpoint: params.endpoint,
      wireProtocol: params.wireProtocol,
      credentialRef: params.credentialRef,
      ...(params.model ? { model: params.model } : {}),
    }
    const index = routes.findIndex((route) => route.id === id)
    if (index === -1) routes.push(next)
    else routes[index] = next
    await ctx.state.setPreferences({ modelRoutes: routes })
    ctx.gateways.stop(id) // an edited route's gateway restarts with the new config
    return { id }
  },

  'routes/delete': async (ctx, params) => {
    const dying = ctx.routes.list().find((route) => route.id === params.id)
    const remaining = ctx.routes.list().filter((route) => route.id !== params.id)
    await ctx.state.setPreferences({ modelRoutes: remaining })
    ctx.gateways.stop(params.id)
    // A credential nothing references any more is deleted with its route:
    // an orphaned key sitting in the store is a liability with no owner.
    if (dying && !remaining.some((route) => route.credentialRef === dying.credentialRef)) {
      await ctx.credentials.delete(dying.credentialRef)
    }
    return null
  },
} satisfies MethodsUnder<'credentials/' | 'routes/' | 'audit/'>
