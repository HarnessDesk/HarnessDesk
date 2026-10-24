import type { MethodsUnder } from './context.js'

/** These operations exist only on the authenticated window wire. */
export const leadMethods = {
  'lead/thread/read': ctx => ctx.leadThreadRead(),
  'lead/thread/send': (ctx, params) => ctx.leadThreadSend(params),
  'lead/card/decide': (ctx, params) => ctx.leadCardDecide(params),
  'lead/action/perform': (ctx, params) => ctx.leadActionPerform(params),
  'lead/settings/read': ctx => ctx.leadSettingsRead(),
  'lead/settings/update': (ctx, params) => ctx.leadSettingsUpdate(params),
  'lead/stop': (ctx, params) => ctx.leadStop(params),
  'lead/resume': (ctx, params) => ctx.leadResume(params),
  'lead/steer': (ctx, params) => ctx.leadSteer(params),
} satisfies MethodsUnder<'lead/'>
