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
  /** A shape's exact YAML for one policy — the ordered editor and its graph both render through this. */
  'authoring/shape/render': (ctx: HostContext, params) => ctx.authoring.renderShape(params.policy),
  /** A brand-new trigger's phase-8 defaults. Drafts only: nothing is written or armed. */
  'authoring/triggers/draft': (ctx: HostContext, params) => ctx.authoring.triggerDraft({ id: params.id, on: params.on, opens: params.opens }),
  /** Every trigger's exact YAML, `parseTriggers`-checked before it is offered. */
  'authoring/triggers/render': (ctx: HostContext, params) => ctx.authoring.renderTriggers(params.definitions),
} satisfies MethodsUnder<'authoring/'>
