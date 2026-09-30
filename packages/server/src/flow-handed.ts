import type { CompiledFlow, FlowBinding } from '@harnessdesk/protocol'

import { reviewsIn } from './flow-policy.js'

/**
 * Where a card opens against the predecessor work it is handed (#1053) — the
 * one rule a run seats by and a dry run states, so the two cannot disagree.
 *
 * `handed` is each predecessor writer card the dependency walk reaches, and
 * whether its work was written outside the Goal's own checkout. A card that
 * shares its predecessors' own tree (it is not isolated, and none of that work
 * was written elsewhere) already holds it: `own`. Otherwise one card's work is
 * a lane of the card's own cut from that commit, `lane`; several are named in
 * its order, `named`.
 */
export type HandedCheckout = 'own' | 'lane' | 'named'

export const handedCheckout = (isolate: boolean, handed: readonly { readonly apart: boolean }[]): HandedCheckout =>
  !handed.some((one) => isolate || one.apart) ? 'own' : handed.length === 1 ? 'lane' : 'named'

/** A card of this binding is a writer — its head is what later cards are handed — exactly as a run's walk decides it. */
export const writes = (binding: Pick<FlowBinding, 'agent' | 'grant'>): boolean => binding.grant !== 'read' && !reviewsIn(binding)

/** Whether every route, or only some route, opens a role in a predecessor lane. */
export type PredecessorRoute = 'always' | 'may'

/**
 * The Agent roles a run of this flow may open in a lane cut from the commit
 * they are handed, read from the file alone. A round of a role is handed the
 * nearest round back, along the rule that opened it, that has writer cards —
 * through check, person and reading rounds, as the run's own walk goes — and
 * that round's writers were written apart when their role is isolated or is
 * itself opened this way. The result distinguishes a lane on every route
 * (`always`) from one on only some routes (`may`); a seed or trigger `again`
 * round is a shared-checkout route and therefore cannot mark a role alone.
 */
export const rolesAtPredecessor = (compiled: CompiledFlow, againRole: string | null = null): ReadonlyMap<string, PredecessorRoute> => {
  if (compiled.document.format !== 'agents') return new Map()
  const flow = compiled.document.flow
  const role = new Map(flow.roles.map((one) => [one.id, one]))
  const writers = (id: string): number => compiled.bindings.filter((one) => one.role === id && writes(one)).length
  const before = (id: string): readonly string[] => [...new Set(flow.rules.filter((rule) => rule.then.role === id).map((rule) => rule.on))]
  // Each route reaches the nearest writer roles, never crossing a round twice.
  const nearest = (id: string, seen: Set<string>): readonly (readonly string[])[] => {
    if (seen.has(id)) return [[]]
    seen.add(id)
    const one = role.get(id)
    if (one?.kind === 'agent' && writers(id) > 0) return [[id]]
    const prior = before(id)
    return prior.length === 0 ? [[]] : prior.flatMap((from) => nearest(from, new Set(seen)))
  }
  const routes = (id: string): readonly (readonly string[])[] => [
    ...(flow.seed.role === id ? [[]] : []),
    ...(againRole === id ? [[]] : []),
    ...flow.rules.filter((rule) => rule.then.role === id).flatMap((rule) => nearest(rule.on, new Set())),
  ]
  // A writer reached by mixed routes can be either in the Goal tree or apart;
  // only an isolated role or one whose every route is apart is always apart.
  const apartPossible = new Set<string>()
  const apartAlways = new Set<string>()
  const writerOptions = (id: string): readonly boolean[] => {
    const one = role.get(id)
    if (one?.kind !== 'agent' || one.isolate || apartAlways.has(id)) return [true]
    return apartPossible.has(id) ? [false, true] : [false]
  }
  const handedStates = (handed: readonly string[]): readonly (readonly { readonly apart: boolean }[])[] => {
    let states: readonly (readonly { readonly apart: boolean }[])[] = [[]]
    for (const writer of handed) {
      const next: { readonly apart: boolean }[][] = []
      for (const state of states) {
        for (const apart of writerOptions(writer)) {
          next.push([...state, ...Array.from({ length: writers(writer) }, () => ({ apart }))])
        }
      }
      states = next
    }
    return states
  }
  const routeStates = (id: string): readonly (readonly { readonly apart: boolean }[])[] => routes(id).flatMap(handedStates)
  const laneStates = (id: string): readonly boolean[] => {
    const target = role.get(id)
    if (target?.kind !== 'agent') return []
    return routeStates(id).map((handed) => handedCheckout(target.isolate, handed) === 'lane')
  }
  // Monotone: a role that may have an apart checkout makes its own writers
  // possibly apart, which can only add route outcomes downstream.
  for (let changed = true; changed;) {
    changed = false
    for (const one of flow.roles) {
      if (one.kind !== 'agent') continue
      const lanes = laneStates(one.id)
      const possible = lanes.some(Boolean)
      const always = lanes.length > 0 && lanes.every(Boolean)
      if (possible && !apartPossible.has(one.id)) { apartPossible.add(one.id); changed = true }
      if (always && !apartAlways.has(one.id)) { apartAlways.add(one.id); changed = true }
    }
  }
  const result = new Map<string, PredecessorRoute>()
  for (const one of flow.roles) {
    if (one.kind !== 'agent') continue
    const lanes = laneStates(one.id)
    if (lanes.some(Boolean)) result.set(one.id, lanes.every(Boolean) ? 'always' : 'may')
  }
  return result
}
