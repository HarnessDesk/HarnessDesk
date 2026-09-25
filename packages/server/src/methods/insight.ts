import type { MethodsUnder } from './context.js'

export const insightMethods = {
  'insight/goal': (ctx, params) => ctx.insight.goal(params.goal),
  'insight/usage': (ctx, params) => ctx.insight.usage(params),
  'insight/agent': (ctx, params) => ctx.insight.agent(params.root, params.agent, params.origin),
  'insight/compare': (ctx, params) => ctx.insight.compare(params),
  'insight/order/preview': (ctx, params) => ctx.insight.previewOrder(params),
  'insight/order/apply': (ctx, params) => ctx.insight.applyOrder(params.stamp),
} satisfies MethodsUnder<'insight/'>
