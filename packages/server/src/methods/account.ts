import type { MethodsUnder } from './context.js'

/** The app's account, kept apart from runtime account and sign-out methods. */
export const harnessDeskAccountMethods = {
  'account/status': (ctx) => ctx.harnessDeskAccount.status(),
  'account/signIn': (ctx) => ctx.harnessDeskAccount.signIn(),
  'account/openSignIn': (ctx) => ctx.harnessDeskAccount.openSignIn(),
  'account/cancel': (ctx) => ctx.harnessDeskAccount.cancel(),
  'account/signOut': (ctx, params) => ctx.harnessDeskAccount.signOut(params.localOnly),
  'account/unlinkPhone': (ctx, params) => ctx.harnessDeskAccount.unlinkPhone(params.deviceId),
  'account/renameDesk': (ctx, params) => ctx.harnessDeskAccount.renameDesk(params.name),
  'account/setReachable': (ctx, params) => ctx.harnessDeskAccount.setReachable(params.reachable),
} satisfies MethodsUnder<'account/'>
