import type { MethodsUnder } from './context.js'

export const goalMethods = {
  'goal/list': (ctx, params) => ctx.goals.list(params.root),
  'goal/read': (ctx, params) => ctx.goals.view(params.goal),
  'goal/create': (ctx, params) => ctx.goals.create(params),
  'goal/update': (ctx, params) => ctx.goals.update(params.goal, params.revision, {
    ...(params.sentence === undefined ? {} : { sentence: params.sentence }),
    ...(params.dependsOn === undefined ? {} : { dependsOn: params.dependsOn }),
  }),
  'goal/seat': (ctx, params) => ctx.goals.seat(params),
  'goal/assign': (ctx, params) => ctx.goals.assign(params.goal, params.card, params.session),
  'goal/release': async (ctx, params) => {
    await ctx.goals.release(params.goal, params.seat)
    return null
  },
  'goal/preview': (ctx, params) => ctx.goals.preview(params.goal, params.choices),
  'goal/wrap': (ctx, params) => ctx.goals.wrap(params.goal, params.stamp, params.choices),
  'goal/receipt': (ctx, params) => ctx.goals.receipt(params.goal),
  'goal/cite': async (ctx, params) => {
    await ctx.goals.cite(params.goal, params.citation)
    return null
  },
  'goal/migration/ack': async (ctx) => {
    await ctx.goals.store.acknowledgeMigration()
    return null
  },
} satisfies MethodsUnder<'goal/'>
