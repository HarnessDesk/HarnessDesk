import type { MethodsUnder } from './context.js'

/** The window's side of the phone link: pair a phone, answer "Allow this phone?", remove one. */
export const phoneMethods = {
  'phone/state': ctx => ctx.phone.state(),
  'phone/pairing': ctx => ctx.phone.pairing(),
  'phone/allow': (ctx, params) => ctx.phone.allow(params.id, params.tiers),
  'phone/deny': (ctx, params) => ctx.phone.deny(params.id),
  'phone/revoke': (ctx, params) => ctx.phone.revoke(params.device),
  'phone/sessions/list': (ctx, params) => ctx.phoneWorkspace.sessionsList(params),
  'phone/teams/list': (ctx, params) => ctx.phoneWorkspace.teamsList(params),
  'phone/dashboard/read': (ctx, params) => ctx.phoneWorkspace.dashboardRead(params),
} satisfies MethodsUnder<'phone/'>
