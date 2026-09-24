import type { HostContext, MethodsUnder } from './context.js'

/**
 * Authoring: an Agent, a flow or a project's triggers, read and saved as the
 * files they are. Every verb goes to the one owner, `AuthoringPlane`, which
 * resolves where a target lives itself — the params name an origin and an id,
 * never a path — and writes nothing but what one preview showed.
 */
export const authoringMethods = {
  'authoring/read': (ctx: HostContext, params) => ctx.authoring.read(params.target),
  'authoring/agent/patch': (ctx: HostContext, params) => ctx.authoring.patch(params.target, params.expected, params.edit),
  'authoring/save/preview': (ctx: HostContext, params) => ctx.authoring.preview({
    target: params.target,
    expected: params.expected,
    source: params.source,
    ...(params.agents ? { agents: params.agents } : {}),
  }),
  'authoring/save/apply': (ctx: HostContext, params) => ctx.authoring.apply(params.token),
  'authoring/save/pending': (ctx: HostContext) => ctx.authoring.pending(),
  'authoring/save/resume': (ctx: HostContext, params) => ctx.authoring.resume(params.id),
  'authoring/save/discard': (ctx: HostContext, params) => ctx.authoring.discard(params.id),
  /** Spends nothing: the context is resolved on the host and the dry run is phase 6's, strict. Start is `flow/start-goal`. */
  'authoring/start/preview': (ctx: HostContext, params) => ctx.frontDoor.preview({
    context: params.context,
    source: params.source,
    vars: params.vars,
    ...(params.goal ? { goal: params.goal } : {}),
  }),
} satisfies MethodsUnder<'authoring/'>
