import type { Flow, FlowProblem } from '@harnessdesk/protocol'

import { CHANGED_PREVIEW } from '../flow-preview.js'
import { sourceDigest } from '../flow-execution.js'
import { dryRun, parseFlow, validateFlow } from '../flow.js'
import type { HostContext, MethodsUnder } from './context.js'

/**
 * Flows: reading one, checking one, and running one.
 *
 * Only `flow/start` spends anything, and it is the only verb here a person can
 * reach by pressing something — which is what makes the trigger manual in v1
 * and `dry run` honest about costing nothing. Everything else reads a file or
 * asks the pure engine a question.
 */
export const flowMethods = {
  /* Both read files under their root, so both are held to what is open before
     anything is read, on the rule a room is: the room dialog asks them about
     the root it will make its room at, which for a linked worktree is the main
     checkout. `flow/dry` is not held: it reads nothing, and only names its
     root in the report. */
  'flow/list': async (ctx, params) => {
    await ctx.workspaces.confineRoom(params.root)
    return ctx.flows.list(params.root)
  },

  'flow/read': async (ctx, params) => {
    await ctx.workspaces.confineRoom(params.root)
    return ctx.flows.source(params.root, params.path)
  },

  /**
   * Takes the flow's *text*, not a path, so the dialog checks what is in the
   * box rather than what was last saved. Nothing is seated, nothing is
   * billed, no card reaches a board, and a check's command is printed rather
   * than run.
   */
  'flow/dry': async (ctx, params) => {
    const { flow, problems } = parseFlow(params.source)
    if (!flow) {
      return {
        flow: null,
        problems,
        seats: [],
        seatingTurns: 0,
        commands: [],
        trace: [],
        settled: false,
      }
    }
    const report = dryRun(flow, {
      ...(params.answers ? { answers: params.answers } : {}),
      repo: params.root,
    })
    return {
      ...report,
      problems: [...problems, ...report.problems, ...(await unavailableSeats(ctx, flow))],
    }
  },

  'flow/start': (ctx, params) =>
    ctx.flows.start({
      room: params.room,
      source: params.source,
      ...(params.path !== undefined ? { path: params.path } : {}),
      ...(params.vars !== undefined ? { vars: params.vars } : {}),
    }),

  'flow/stop': (ctx, params) => ctx.flows.stop(params.run),

  'flow/runs': (ctx, params) => ctx.flows.runsFor(params.room),

  // ------------------------------------------------------------------- v2

  'flow/catalog': (ctx, params) => ctx.flows.catalog(params.root),

  'flow/source': (ctx, params) => ctx.flows.catalogSource(params.root, params.id, params.origin),

  /**
   * Spends nothing: every read here is the kind `agent/seat/dry` already
   * makes, and the token this mints authorizes only the exact text and
   * inputs it was taken of.
   */
  'flow/preview': (ctx, params) => ctx.flowPreviews.preview(params.root, params.source, params.vars, params.retry),

  /**
   * The only v2 call that spends anything. Redeems the token first — a
   * caller-supplied `compiled`, ceiling or evidence is not a wire param at
   * all, so there is nothing here to trust but what the token itself froze —
   * then hands the frozen policy to `Flows`, which mints the run and its
   * Goal together.
   */
  'flow/start-goal': async (ctx, params) => {
    const redeemed = await ctx.flowPreviews.redeem(params.token, params.root, params.source, params.vars ?? {})
    if (!redeemed) throw new Error(CHANGED_PREVIEW)
    /* The held-seat policy and the reused Goal are the token's, never the
       request's: a front-door token started without its Goal, or with another,
       is refused, and nothing here can turn it into an ordinary start. */
    const bound = redeemed.frontDoor
    if (JSON.stringify(bound?.goal ?? null) !== JSON.stringify(params.goal ?? null)) throw new Error(CHANGED_PREVIEW)
    return ctx.flows.startGoal({
      root: params.root,
      sentence: params.sentence,
      source: params.source,
      sourcePath: null,
      compiled: redeemed.compiled,
      ...(params.vars ? { vars: params.vars } : {}),
      ...(bound ? { requireHeld: true as const } : {}),
      ...(bound?.goal ? { goal: bound.goal } : {}),
      /* Where the run works and what it works on, as the host resolved them
         for the token — the folder its context named, and the commit every
         Seat is pinned to — never re-read from the request. */
      ...(bound ? { cwd: bound.target.context.root } : {}),
      ...(bound?.target.resolved ? { target: bound.target.resolved } : {}),
      authorization: {
        sourceDigest: sourceDigest(params.source),
        commandDigest: sourceDigest(JSON.stringify(redeemed.commands)),
        approvedAt: Date.now(),
        ...(bound ? { start: 'front-door' as const } : {}),
      },
    })
  },

  'flow/execution': (ctx, params) => {
    const execution = ctx.flows.executionOf(params.run)
    if (!execution) throw new Error(`There is no flow run ${params.run}.`)
    return execution
  },

  /**
   * The exact source/vars this run was started with, so `flow/preview`'s own
   * `retry` equality check can be satisfied by a renderer that only just
   * read this run — never by one that started it, which already has them.
   */
  'flow/execution/source': (ctx, params) => {
    const stored = ctx.flows.storedRun(params.run)
    if (!stored) throw new Error(`There is no saved source for flow run ${params.run}.`)
    return stored
  },

  /**
   * Re-runs an interrupted check, once a person has looked. The token is a
   * fresh `flow/preview` one, additionally bound to this exact run and card —
   * `flow/preview`'s own `retry` param is what mints it, validated there
   * against the run's saved source and inputs, so nothing here re-chooses the
   * command or checkout.
   */
  'flow/check/retry': async (ctx, params) => {
    const bound = ctx.flowPreviews.retryTarget(params.token)
    if (!bound || bound.run !== params.run || bound.card !== params.card) throw new Error(CHANGED_PREVIEW)
    const stored = ctx.flows.storedRun(params.run)
    const execution = ctx.flows.executionOf(params.run)
    if (!stored || !execution) throw new Error(CHANGED_PREVIEW)
    const goal = await ctx.goals.view(execution.goal)
    const redeemed = await ctx.flowPreviews.redeem(params.token, goal.goal.root, stored.source, stored.vars)
    if (!redeemed) throw new Error(CHANGED_PREVIEW)
    return ctx.flows.retryCheck(params.run, params.card)
  },

  'flow/update/preview': (ctx, params) => ctx.flowUpdates.preview(params.root, params.id),

  'flow/update/apply': (ctx, params) => ctx.flowUpdates.apply(params.root, params.token),

  'flow/customize/preview': (ctx, params) => ctx.flowUpdates.customizePreview(params.root, params.id),

  'flow/customize/apply': (ctx, params) => ctx.flowUpdates.customizeApply(params.root, params.id, params.token),
} satisfies MethodsUnder<'flow/'>

/**
 * Seats this desk cannot actually open: an agent it does not have, or a model
 * that agent does not offer.
 *
 * `flow.ts` is pure and cannot ask a runtime anything, so this is the half of
 * validation that needs the desk. It belongs in the dry run because that is
 * the surface a person reads *before* pressing the thing, and the failure it
 * catches is otherwise found at seating — which is late, even though nothing
 * is spent: a flow that opens three of four seats and then stops is a room
 * somebody has to clean up.
 *
 * Effort is deliberately not checked here. A runtime declares its efforts per
 * *session*, so asking would mean opening one, and a dry run that opens a
 * conversation is not a dry run. The start path refuses it by name with the
 * choices listed, before any seat is opened.
 */
const unavailableSeats = async (ctx: HostContext, flow: Flow): Promise<FlowProblem[]> => {
  const problems: FlowProblem[] = []
  for (const role of flow.roles) {
    for (const [index, seat] of role.seats.entries()) {
      const at = `roles.${role.id}.seat${role.seats.length > 1 ? `[${index}]` : ''}`
      const runtime = ctx.runtimes.get(seat.runtime)
      if (runtime && !ctx.runtimes.infoOf(runtime).capabilities.pluginTools) {
        /* A seat that cannot be handed the desk's tools cannot claim, finish
           or wait — it can only sit there while the run stalls. The agent
           declares this once it has been offered the bridge and refused it
           (`pluginTools` is "offered and not refused", per the ACP adapter),
           so this catches the refusing case before a turn is spent. It does
           *not* catch an agent that accepts the offer and ignores it — see
           #333 and `#attendance` in flows.ts, which stops that after the
           fact. */
        problems.push({
          level: 'error',
          at,
          text: `${runtime.info.presentation.name} does not take HarnessDesk's tools, so a seat on it could never claim a card`,
        })
        continue
      }
      if (!runtime) {
        problems.push({
          level: 'error',
          at,
          text: `this desk has no agent called "${seat.runtime}" — it has ${[...ctx.runtimes.ids()].join(', ') || 'none'}`,
        })
        continue
      }
      if (!seat.model) continue
      const models = await runtime.listModels().catch(() => [])
      if (models.length === 0) continue
      if (models.some((one) => one.id === seat.model)) continue
      /* The compact form splits the effort off after a `/`, so a model id
         that contains one is read as a model and an effort. Say so, rather
         than "no such model": the author wrote a real id and the grammar
         took it apart. */
      const rejoined = seat.effort ? `${seat.model}/${seat.effort}` : null
      if (rejoined && models.some((one) => one.id === rejoined)) {
        problems.push({
          level: 'error',
          at,
          text: `"${rejoined}" is one model id, not a model and an effort — write the seat as a map: { runtime: ${seat.runtime}, model: ${rejoined} }`,
        })
        continue
      }
      problems.push({
        level: 'error',
        at,
        text: `${runtime.info.presentation.name} does not offer a model called "${seat.model}"`,
      })
    }
  }
  return problems
}

/** Re-exported so `flow/dry` and the start path cannot drift about what is valid. */
export { validateFlow }
