import { isSessionBusy, sessionId as makeSessionId, type AgentSession, type Session } from '@harnessdesk/protocol'

import * as gitOps from '../git-ops.js'
import type { MethodsUnder } from './context.js'
import { checkOption } from './runtimes.js'

/**
 * Conversations as the host holds them: listing and search across the
 * runtime's own store and the host's, opening, reopening, forking, and the
 * verbs on one conversation that are not a turn.
 */
export const sessionMethods = {
  'session/list': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    const page = await runtime.listSessions({
      ...(params.cursor ? { cursor: params.cursor } : {}),
      ...(params.pageSize ? { pageSize: params.pageSize } : {}),
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.archived ? { archived: params.archived } : {}),
    })
    return ctx.sessions.withRepos(
      ctx.sessions.routeToHolders(
        runtime,
        await ctx.sessions.applyArchive(runtime, page, params.archived ?? 'exclude'),
      ),
    )
  },

  'session/search': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    return ctx.sessions.withRepos(
      ctx.sessions.routeToHolders(runtime, await runtime.searchSessions(params.query)),
    )
  },

  'transcripts/search': (ctx, params) => ctx.transcripts.search(params.query),

  'session/read': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    const session = await ctx.sessions.read(runtime, makeSessionId(params.sessionId))
    // Cache it so a reconnecting client gets the transcript from sync.
    return ctx.registry.upsert(session, ctx.registry.get(session.runtime, session.id)?.live ?? null).session
  },

  'session/create': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    // Routes resolve here and only here. A client-supplied `route` is
    // discarded: the wire names a route by id, the host exchanges the
    // stored credential for a loopback gateway, and only the resolved
    // gateway address reaches the adapter.
    const { route: _clientRoute, routeId, ...rest } = params.options as typeof params.options & {
      routeId?: string
    }
    let options = rest as typeof params.options
    if (typeof routeId === 'string') {
      options = { ...options, route: await ctx.routes.resolve(runtime, routeId) }
    }
    const live = await runtime.createSession(options)
    return ctx.sessions.attach(runtime, live.id, live)
  },

  'session/resume': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    let live: AgentSession
    try {
      live = await runtime.resumeSession(makeSessionId(params.sessionId), params.options ?? {})
    } catch (error) {
      // A conversation held by another writer is not a failure to explain
      // but a place to be sent; it keeps its own sentence and its code.
      if (isSessionBusy(error)) {
        throw await ctx.sessions.busyElsewhere(runtime, makeSessionId(params.sessionId), error)
      }
      // The same sentence a reopen gives, because it is the same event to
      // the person reading it: the agent's own words alone ("Session not
      // found") name neither the agent nor what was being attempted.
      throw new Error(ctx.sessions.cannotReopen(runtime, error))
    }
    // Resume returns metadata only; the transcript comes from a full read so
    // the user sees their history immediately rather than an empty pane.
    // The read has no settings or options, though — those live on the
    // handle — so both are carried across, or the composer has nothing to
    // render.
    const transcript = await ctx.sessions.read(runtime, live.id)
    const session: Session = { ...transcript, settings: live.settings(), options: live.options() }
    return ctx.registry.upsert(session, live).session
  },

  'session/fork': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    const live = await runtime.forkSession(makeSessionId(params.sessionId), params.options ?? {})
    return ctx.sessions.attach(runtime, live.id, live)
  },

  'session/archive': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    const id = makeSessionId(params.sessionId)
    // The runtime's own archive when it has one, the host's when it does
    // not. Never both: see `SessionArchive`.
    if (runtime.info.capabilities.archiveHistory) {
      await runtime.archiveSession(id, params.archived)
    } else {
      await ctx.archive.set(runtime.info.id, id, params.archived)
    }
    return null
  },

  'session/delete': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    const id = makeSessionId(params.sessionId)
    if (!runtime.info.capabilities.deleteHistory) {
      throw new Error(`${runtime.info.presentation.name} cannot delete a stored conversation.`)
    }
    // The agent's copy first: if it refuses, nothing here is thrown away,
    // and the conversation is exactly as it was.
    const outcome = await runtime.deleteSession(id)
    // Then everything the host was holding about it. A transcript left
    // behind would be re-enriched onto the next session that reused the
    // id, and an archive mark left behind is a row hidden forever.
    await ctx.transcripts.forget(runtime.info.id, id)
    await ctx.archive.forget(runtime.info.id, id)
    await ctx.names.forget(runtime.info.id, id)
    const record = ctx.registry.get(runtime.info.id, id)
    if (record) {
      await record.live?.close().catch(() => {})
      ctx.registry.delete(runtime.info.id, id)
    }
    return {
      disposition: outcome?.disposition ?? 'removed',
      ...(outcome?.removed !== undefined ? { removed: outcome.removed } : {}),
    }
  },

  'session/close': async (ctx, params) => {
    const record = ctx.registry.get(params.runtime, makeSessionId(params.sessionId))
    await record?.live?.close()
    if (record) {
      record.live = null
      /* Closed on purpose, so the handle was not *lost* — which is all
         `detached` has ever meant. It no longer decides whether this
         conversation is in a room: membership does, and a member of a room
         that is not open is drawn as such and reopened by the next thing
         addressed to it. Closing a pane is window management; leaving a room
         is `team/room/leave`. */
      record.detached = false
    }
    return null
  },

  'session/setTitle': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    // The runtime's own name when it keeps one, the host's when it does
    // not. Never both: see `SessionNames`. ACP has no way to name a
    // session at all, so this used to reach the adapter and throw — the
    // rename was offered, went through the store, and failed at the
    // bottom, which is how three conversations on one agent stayed three
    // rows all called after the agent.
    if (runtime.info.capabilities.nameHistory) {
      await (await ctx.sessions.live(params)).setTitle(params.title)
    } else {
      await ctx.names.set(runtime.info.id, makeSessionId(params.sessionId), params.title)
    }
    return null
  },

  'session/settings': async (ctx, params) => {
    await (await ctx.sessions.live(params)).updateSettings(params.patch)
    return null
  },

  'session/options/set': async (ctx, params) => {
    const live = await ctx.sessions.live(params)
    checkOption(live.options(), params.optionId, params.value)
    await live.setOption(params.optionId, params.value)
    return null
  },

  'session/goal': async (ctx, params) => {
    const live = await ctx.sessions.live(params)
    if (!live.setGoal) throw new Error('This runtime does not support session goals.')
    await live.setGoal(params.objective)
    return null
  },

  'session/rollback': async (ctx, params) => {
    const live = await ctx.sessions.live(params)
    if (!live.rollback) throw new Error('This runtime cannot undo turns.')
    await live.rollback(params.turns)
    // The conversation dropped those turns, so the host stops claiming
    // them: a later read that no longer lists them is right, not behind.
    const runtime = ctx.runtimes.resolve(params).info.id
    const id = makeSessionId(params.sessionId)
    ctx.registry.forgetTurns(runtime, id, params.turns)
    /* And so does the transcript store, which fills a thinner read in from
       what it recorded: untold, it brought the dropped turns back after a
       restart (#156). It drops them from what it kept, whatever the host's
       copy holds, and forgets a transcript with no turn left (review of
       #236, round 1). */
    await ctx.transcripts.dropTurns(runtime, id, params.turns)
    return null
  },

  'session/revertTurn': async (ctx, params) => {
    const record = ctx.registry.get(ctx.runtimes.resolve(params).info.id, makeSessionId(params.sessionId))
    const turn = record?.session.turns.find((entry) => entry.id === params.turnId)
    if (!record || !turn) throw new Error('That turn is not loaded; open the conversation first.')
    const direction = params.direction ?? 'undo'
    const { files, skipped } = await gitOps.applyTurn(record.session.cwd, turn, direction, {
      ...(params.skipUnrecoverable ? { skipUnrecoverable: true } : {}),
    })
    ctx.audit.append({
      at: Date.now(),
      runtime: record.runtime,
      sessionId: record.session.id,
      cwd: record.session.cwd,
      kind: direction === 'undo' ? 'turn/reverted' : 'turn/reapplied',
      steps: files.length,
    })
    return { files, skipped }
  },

  'session/compact': async (ctx, params) => {
    const live = await ctx.sessions.live(params)
    if (!live.compact) throw new Error('This runtime cannot compact a conversation on demand.')
    await live.compact()
    return null
  },

  'session/memory': async (ctx, params) => {
    const live = await ctx.sessions.live(params)
    if (!live.setMemoryMode) throw new Error('This runtime has no memory to turn on or off.')
    await live.setMemoryMode(params.enabled)
    return null
  },

  'session/review': async (ctx, params) => {
    const live = await ctx.sessions.live(params)
    if (!live.review) throw new Error('This runtime cannot review changes.')
    await live.review(params.target)
    return null
  },
} satisfies MethodsUnder<'session/' | 'transcripts/'>
