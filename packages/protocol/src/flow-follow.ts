import type { FlowPolicy, FlowPolicyRule } from './flow-policy.js'

/**
 * What a finished round of one role goes on to do, read from a Flow's own
 * rules.
 *
 * `opens` names the rule that would fire and the role it opens. `guarded` is
 * true when that rule also reads the Run's evidence: the engine asks it
 * whether the evidence holds before it fires, and goes on to a later rule when
 * it does not, so a caller can say only that it may open that role.
 *
 * `none` is a round no rule continues from, which is how a Run ends. `ruled`
 * says the answers have no successful end: a declared successful round, or
 * an answered role with no rules or declaration, completes the Run. Other
 * answers of a ruled role leave the Run ended without a next step.
 */
export type FlowFollow =
  | { readonly kind: 'opens'; readonly rule: string; readonly role: string; readonly guarded: boolean }
  | { readonly kind: 'none'; readonly ruled: boolean }

/**
 * Whether a rule's answers hold for a round showing exactly these outcomes: a
 * card that has not answered is `null`, and counts for neither `every` nor
 * `any`. A rule with no restrictive guard follows any round that has cards.
 *
 * This is the engine's own reading (`decide` and `guardHolds` in
 * `packages/server`), which a host test holds this to.
 */
const answers = (rule: FlowPolicyRule, outcomes: readonly (string | null)[]): boolean => {
  const every = rule.when?.every ?? []
  const any = rule.when?.any ?? []
  if (outcomes.length === 0) return false
  if (every.length > 0 && !outcomes.every((one) => one !== null && every.includes(one))) return false
  if (any.length > 0 && !outcomes.some((one) => one !== null && any.includes(one))) return false
  return true
}

/**
 * The rule that follows a round of `role` whose cards read `outcomes`, tried in
 * file order, the first match winning. The window uses it to say what an
 * answer, or an abandoned card, will do before it is given: the host's
 * reply to either says nothing of it.
 */
export const followOf = (
  flow: Pick<FlowPolicy, 'rules' | 'complete'>,
  role: string,
  outcomes: readonly (string | null)[],
): FlowFollow => {
  const own = flow.rules.filter((rule) => rule.on === role)
  const found = own.find((rule) => answers(rule, outcomes))
  return found
    ? { kind: 'opens', rule: found.id, role: found.then.role, guarded: (found.when?.evidence?.length ?? 0) > 0 }
    : { kind: 'none', ruled: Object.hasOwn(flow.complete ?? {}, role) ? !completesRound(flow, role, outcomes) : own.length > 0 }
}

/** Explicit success needs an answer from every card; an abandoned card cannot complete a Run. */
export const completesRound = (flow: Pick<FlowPolicy, 'complete'>, role: string, outcomes: readonly (string | null)[]): boolean => {
  const complete = Object.hasOwn(flow.complete ?? {}, role) ? flow.complete![role] : undefined
  return complete !== undefined && outcomes.length > 0 && outcomes.every(word => word !== null && complete.includes(word))
}
