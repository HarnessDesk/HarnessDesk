import type { MethodsUnder } from './context.js'

export const provenanceMethods = {
  'provenance/commits': async (ctx, params) =>
    ctx.provenance.read(await ctx.workspaces.confineGitRoot(params.root), params.shas),
  'provenance/status': async (ctx, params) => params.root !== undefined
    ? ctx.provenance.status(await ctx.workspaces.confineGitRoot(params.root))
    : ctx.provenance.status(),
  'provenance/capture': async (ctx, params) =>
    ctx.provenance.setCapture(await ctx.workspaces.confineGitRoot(params.root), params.enabled),
  'provenance/retry': async (ctx, params) =>
    ctx.provenance.retry(await ctx.workspaces.confineGitRoot(params.root)),
  'provenance/seat': async (ctx, params) =>
    ctx.provenance.seat(await ctx.workspaces.confineGitRoot(params.root), params.seat),
} satisfies MethodsUnder<'provenance/'>
