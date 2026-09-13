import type { Flow, FlowProblem } from '@harnessdesk/protocol'

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
  'flow/list': (ctx, params) => ctx.flows.list(params.root),

  'flow/read': (ctx, params) => ctx.flows.source(params.root, params.path),

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
