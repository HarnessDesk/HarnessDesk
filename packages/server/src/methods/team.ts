import { sessionId as makeSessionId } from '@harnessdesk/protocol'

import type { MethodsUnder } from './context.js'

/**
 * Agents working together: the shared board and the inter-agent channel. The
 * engine is `Team`; the host answers the wire because it is the host that
 * owns every conversation, so a claim can be a transaction and a message can
 * be routed with one set of guards.
 */
export const teamMethods = {
  'team/state': (ctx, params) => ctx.team.stateFor(params.room),

  'team/add': (ctx, params) =>
    ctx.team.addIntentAsUser(params.room, {
      title: params.title,
      ...(params.detail !== undefined ? { detail: params.detail } : {}),
      ...(params.files !== undefined ? { files: params.files } : {}),
      ...(params.dependsOn !== undefined ? { dependsOn: params.dependsOn } : {}),
      ...(params.plan !== undefined ? { plan: params.plan } : {}),
    }),

  'team/plan': (ctx, params) => ctx.team.planWork(params.room, params.goal),

  'team/wrap': (ctx, params) => ctx.team.wrapPlan(params.room, params.plan),

  'team/intent': (ctx, params) => {
    ctx.team.intentAction(params.room, params.id, params.action, params.reason)
    return null
  },

  'team/post': async (ctx, params) => {
    await ctx.team.post(
      params.room,
      params.text,
      params.to ? { runtime: params.to.runtime, sessionId: String(params.to.sessionId) } : undefined,
    )
    return null
  },

  'team/handout': (ctx, params) =>
    ctx.team.handout(
      params.room,
      params.template,
      params.recipients.map((one) => ({
        runtime: one.runtime,
        sessionId: String(one.sessionId),
        ...(one.vars !== undefined ? { vars: one.vars } : {}),
      })),
    ),

  'team/messaging': (ctx, params) => {
    ctx.team.setMessaging(params.room, params.enabled)
    return null
  },

  'team/deliver': async (ctx, params) => {
    await ctx.team.deliverHeld(params.room, params.entryId)
    return null
  },

  'team/inbound': (ctx, params) => {
    ctx.team.setInbound(params.runtime, String(params.sessionId), params.mode)
    return null
  },

  'team/rooms': (ctx, params) => ctx.team.roomsFor(params.root),

  'team/room/create': async (ctx, params) =>
    ctx.team.stateFor((await ctx.team.createRoom(params.root, params.name)).id),

  'team/room/rename': (ctx, params) => {
    ctx.team.renameRoom(params.room, params.name)
    return null
  },

  'team/room/delete': (ctx, params) => ctx.team.deleteRoom(params.room),

  'team/room/join': async (ctx, params) => {
    /* A conversation nothing can account for is not a member of anything.
       The engine cannot make this call: it sees only what the desk holds
       open, and a member whose conversation is merely not open is still a
       member — deliberately, so one that comes back keeps its name. So the
       check belongs here, where both the registry and the agents' own
       stores can be asked.
       Found by a recording: a caller that split a session key wrongly
       joined a name that had never named anything, and the room counted a
       member the tree could not draw and the delete dialog promised would
       "leave the room and carry on". */
    const runtime = ctx.runtimes.resolve(params)
    const id = makeSessionId(String(params.sessionId))
    /* The registry first, and the agent's own store when the registry has
       never heard of it. That second half is what a relaunched desk needs:
       every conversation in the sidebar is stored rather than open, so
       requiring a record refused exactly the conversations the "add an
       agent" dialog was offering — "There is no codex conversation
       0199…", about a conversation plainly on screen. Reading it is what
       opening it would do anyway, and this is a deliberate press. */
    /* A *live handle* is the only thing the host holds that proves the agent
       has this conversation, because a handle is the agent holding it. A mere
       record is not: `session/read` caches whatever `ctx.sessions.read`
       answered, and that one falls back to the host's own stored transcript
       when the runtime cannot serve the conversation (`Host#read` →
       `transcripts.recover`). So opening a conversation the agent has lost
       leaves a record behind, and taking the record as proof let that
       conversation into a room — accepted, then dropped by the first
       delivery, which is the exact outcome this check exists to prevent.
       Reading the registry *first* is what made the earlier fix incomplete:
       it changed the fallback and left the shortcut in front of it.

       Everything else asks the agent. Held live is checked first rather than
       last because the read is the thing that can fail for a conversation
       that is perfectly fine — Codex answers a `thread/read` with
       "list_turns is not supported yet" for a thread it is holding open,
       which is why `Host#read` carries a held-transcript fallback of its
       own. */
    const held = ctx.registry.get(params.runtime, id)
    const known = held?.live
      ? held.session
      : await runtime.readSession(id).catch(() => null)
    if (!known) {
      throw new Error(`There is no ${params.runtime} conversation ${params.sessionId}. Nothing was added to the room.`)
    }
    /* And the project it works in, which is a fact about the *stored*
       conversation rather than about a running process. Proving the
       registry had heard of it was not enough: a stopped record exists
       with `live = null`, so the engine's own check — which reads the live
       peer list — found nothing to look at and let the join through. A
       conversation in another project could be made a member here, and
       resuming that membership would hand it a board belonging to a
       project it has never worked in. */
    const board = ctx.team.stateFor(params.room)
    const home = await ctx.workspaces.boardRootOf(known.cwd)
    if (home !== board.root) {
      throw new Error(
        `That conversation is working in ${known.cwd}, which is outside ${board.root}. A room only holds conversations from its own project.`,
      )
    }
    /* Handed over with the join, so the room can draw the member at once.
       The roster is what the rail lists, and a member added from a stored
       conversation would otherwise be a key with nothing to render until
       somebody opened it — which is the very step this exists to avoid. */
    await ctx.team.joinRoom(params.room, params.runtime, String(params.sessionId), {
      title: ctx.names.nameOf(params.runtime, id) ?? known.title ?? null,
      agent: runtime.info.presentation.name,
      cwd: known.cwd,
      model: known.settings?.model ?? null,
      at: Date.now(),
    })
    return null
  },

  'team/room/leave': (ctx, params) => {
    ctx.team.leaveRoom(params.room, params.runtime, String(params.sessionId))
    return null
  },

  'team/peers': (ctx, params) => ctx.team.peersFor(params.room),
} satisfies MethodsUnder<'team/'>
