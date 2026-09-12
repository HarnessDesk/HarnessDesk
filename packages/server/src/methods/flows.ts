import { dryRun, parseFlow, validateFlow } from '../flow.js'
import type { MethodsUnder } from './context.js'

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
  'flow/dry': (ctx, params) => {
    void ctx
    const { flow, problems } = parseFlow(params.source)
    if (!flow) {
      return {
        flow: null,
        problems,
        seats: [],
        requests: 0,
        commands: [],
        trace: [],
        settled: false,
      }
    }
    const report = dryRun(flow, {
      ...(params.answers ? { answers: params.answers } : {}),
      repo: params.root,
    })
    return { ...report, problems: [...problems, ...report.problems] }
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

/** Re-exported so `flow/dry` and the start path cannot drift about what is valid. */
export { validateFlow }
