import type { MethodsUnder } from './context.js'

export const storageMethods = {
  'storage/usage': ctx => ctx.storage.usage(),
  'storage/kept': ctx => ctx.sessionWorktrees.kept(),
  'storage/cleanupPreview': (ctx, params) => ctx.sessionWorktrees.cleanupPreview(params),
  'storage/cleanup': async (ctx, params) => {
    const result = await ctx.sessionWorktrees.cleanupInactive(params)
    await ctx.storage.refresh()
    return result
  },
} satisfies MethodsUnder<'storage/'>
