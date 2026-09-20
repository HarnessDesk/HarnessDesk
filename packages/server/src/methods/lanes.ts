import type { MethodsUnder } from './context.js'

export const laneMethods = {
  'lane/preferences': (ctx) => ctx.laneSettings.read(),
  'lane/list': (ctx) => ctx.lanes.listLanes(),
  'lane/preferences/set': (ctx, params) => ctx.laneSettings.set(params),
  'lane/release': (ctx, params) => ctx.goals.serial.run(() => ctx.lanes.release(params.lane)),
} satisfies MethodsUnder<'lane/'>
