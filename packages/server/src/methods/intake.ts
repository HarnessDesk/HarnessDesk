import type { MethodsUnder } from './context.js'

/**
 * Intake, as a person drives it: the triggers a project commits, how this
 * machine stands on each, arming one with the exact preview a person read,
 * the machine's pause and daily cap, a trigger's history and a trigger
 * Goal's waits. Every parameter was held to its shape at the wire; the plane
 * confines each root and checks each cursor against the trigger it pages.
 * No verb here takes an origin, a grant, a fact or a command, and none is
 * projected into an Agent's tools.
 */
export const intakeMethods = {
  'trigger/list': (ctx, params) => ctx.intake.list(params.root),
  'trigger/preview': (ctx, params) => ctx.intake.preview(params.root, params.id),
  'trigger/arm': (ctx, params) => ctx.intake.arm(params.root, params.id, params.token),
  'trigger/disarm': (ctx, params) => ctx.intake.disarm(params.root, params.id),
  'trigger/rebaseline': (ctx, params) => ctx.intake.rebaseline(params.root, params.id),
  'trigger/preferences': (ctx) => ctx.intake.preferences(),
  'trigger/preferences/set': (ctx, params) => ctx.intake.setPreferences(params.revision, params.paused, params.dailyUsd),
  'trigger/history': (ctx, params) => ctx.intake.history(params.root, params.id, params.cursor),
  'trigger/goal': (ctx, params) => ctx.intake.goal(params.goal),
} satisfies MethodsUnder<'trigger/'>
