import type { MethodsUnder } from './context.js'

/**
 * Agents working together: the shared board and the inter-agent channel. The
 * engine is `Team`; the host answers the wire because it is the host that
 * owns every conversation, so a claim can be a transaction and a message can
 * be routed with one set of guards.
 */
export const teamMethods = {
  'team/state': (ctx, params) => ctx.team.stateFor(params.room),

  'team/add': async (ctx, params) => {
    const intent = ctx.team.addIntentAsUser(params.room, {
      title: params.title,
      ...(params.detail !== undefined ? { detail: params.detail } : {}),
      ...(params.files !== undefined ? { files: params.files } : {}),
      ...(params.dependsOn !== undefined ? { dependsOn: params.dependsOn } : {}),
      ...(params.plan !== undefined ? { plan: params.plan } : {}),
    })
    await ctx.team.flush()
    return intent
  },

  'team/intent': async (ctx, params) => {
    ctx.team.intentAction(
      params.room,
      params.id,
      params.action,
      params.reason,
      params.outcome,
      params.context,
    )
    await ctx.team.flush()
    return null
  },

  'team/post': async (ctx, params) => {
    await ctx.team.post(
      params.room,
      params.text,
      params.to ? { runtime: params.to.runtime, sessionId: String(params.to.sessionId) } : undefined,
    )
    await ctx.team.flush()
    return null
  },

  'team/handout': async (ctx, params) => {
    const answer = await ctx.team.handout(
      params.room,
      params.template,
      params.recipients.map((one) => ({
        runtime: one.runtime,
        sessionId: String(one.sessionId),
        ...(one.vars !== undefined ? { vars: one.vars } : {}),
      })),
    )
    await ctx.team.flush()
    return answer
  },

  'team/messaging': async (ctx, params) => {
    ctx.team.setMessaging(params.room, params.enabled)
    await ctx.team.flush()
    return null
  },

  'team/deliver': async (ctx, params) => {
    await ctx.team.deliverHeld(params.room, params.entryId)
    await ctx.team.flush()
    return null
  },

  'team/inbound': async (ctx, params) => {
    ctx.team.setInbound(params.runtime, String(params.sessionId), params.mode)
    await ctx.team.flush()
    return null
  },

  'team/rooms': (ctx, params) => ctx.team.roomsFor(params.root),

  'team/peers': (ctx, params) => ctx.team.peersFor(params.room),
} satisfies MethodsUnder<'team/'>
