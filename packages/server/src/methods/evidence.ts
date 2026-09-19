import type { MethodsUnder } from './context.js'

/**
 * The evidence plane, read — and, from later in phase 4, asked to run a
 * project's named checks. Everything here reaches the plane as `ctx.evidence`.
 */
export const evidenceMethods = {
  'evidence/seat': (ctx, params) => ctx.evidence.seats.latestOf(params.runtime, params.sessionId),

  'evidence/board': (ctx, params) => ctx.evidence.board(params.room),

  /* Security-critical: every rule a check is held to is `CheckRuns.run`'s, and
     nothing here reads the file or runs anything of its own. */
  'evidence/check/run': (ctx, params) =>
    ctx.evidence.checks.run(params.room, params.card, params.name, { seen: params.seen, digest: params.digest }),

  /* Confined like every folder the renderer names: a project's page can only
     ask about a folder the person opened, or one a conversation works in. */
  'evidence/checks': async (ctx, params) =>
    ctx.evidence.projectChecks(await ctx.workspaces.confineGitRoot(params.project)),
} satisfies MethodsUnder<'evidence/'>
