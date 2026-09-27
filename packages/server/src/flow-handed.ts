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

/**
 * The Agent roles a run of this flow may open in a lane cut from the commit
 * they are handed, read from the file alone. A round of a role is handed the
 * nearest round back, along whichever rule opened it, that has writer cards —
 * through check, person and reading rounds, as the run's own walk goes — and
 * that round's writers were written apart when their role is isolated or is
 * itself opened this way. Every rule into a role is a way it may be reached,
 * so a role is marked when any of them hands it exactly one writer's work
 * from apart, or it is isolated and handed exactly one writer's work at all.
 */
export const rolesAtPredecessor = (compiled: CompiledFlow): ReadonlySet<string> => {
  const marked = new Set<string>()
  if (compiled.document.format !== 'agents') return marked
  const flow = compiled.document.flow
  const role = new Map(flow.roles.map((one) => [one.id, one]))
  const writers = (id: string): number => compiled.bindings.filter((one) => one.role === id && writes(one)).length
  const before = (id: string): readonly string[] => [...new Set(flow.rules.filter((rule) => rule.then.role === id).map((rule) => rule.on))]
  // The writer roles each way into `id` reaches: the nearest back along its rules, never crossing a round twice.
  const nearest = (id: string, seen: Set<string>): readonly string[] => {
    if (seen.has(id)) return []
    seen.add(id)
    const one = role.get(id)
    if (one?.kind === 'agent' && writers(id) > 0) return [id]
    return before(id).flatMap((prior) => nearest(prior, seen))
  }
  // Monotone: a role marked makes its own writers apart, which can only mark more.
  for (let changed = true; changed;) {
    changed = false
    for (const one of flow.roles) {
      if (one.kind !== 'agent' || marked.has(one.id)) continue
      const handed = before(one.id).flatMap((prior) => nearest(prior, new Set()))
      const lane = handed.some((writer) => {
        const apart = role.get(writer)?.kind === 'agent' && ((role.get(writer) as { isolate: boolean }).isolate || marked.has(writer))
        return handedCheckout(one.isolate, Array.from({ length: writers(writer) }, () => ({ apart }))) === 'lane'
      })
      if (lane) {
        marked.add(one.id)
        changed = true
      }
    }
  }
  return marked
}
