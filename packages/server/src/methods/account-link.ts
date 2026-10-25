import type { MethodsUnder } from './context.js'

/** Account linking belongs to the host, independently of the LAN phone listener. */
export const accountLinkMethods = {
  'account/link/state': ctx => ctx.accountLink.state(),
  'account/link/start': ctx => ctx.accountLink.start(),
  'account/link/cancel': ctx => ctx.accountLink.cancel(),
} satisfies MethodsUnder<'account/link/'>
