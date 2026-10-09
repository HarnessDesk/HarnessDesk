import type { MethodsUnder } from './context.js'

export const historyMethods = {
  'history/import': (ctx, params) => { ctx.history.import(params.runtime); return null },
  'history/cancel': (ctx, params) => { ctx.history.cancel(params.runtime); return null },
  'history/status': (ctx, params) => ctx.history.status(params.runtime),
  'history/list': (ctx, params) => ctx.history.list(params),
  'history/removeImported': (ctx, params) => ctx.history.removeImported(params.runtime),
  'history/clearCached': ctx => ctx.history.clearCached(),
} satisfies MethodsUnder<'history/'>
