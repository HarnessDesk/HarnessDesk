import type { FlowModel, FlowRuleView } from './flow-model'
import type { FlowOverlay, FlowRuleRun, FlowStepRun } from './flow-overlay'

export interface ExamplePath {
  readonly steps: readonly string[]
  readonly rules: readonly string[]
  readonly bounded: boolean
}
/** Small, finite illustrations of declared routes, never a prediction or a policy executor.
 * Each step may be revisited once, so a repair is followed by its next review.
 * The round budget also bounds every illustration. */
export const examplePaths = (model: FlowModel, rounds = 12): readonly ExamplePath[] => {
  if (!model.steps.some(step => step.id === model.seed)) return []
  const paths: ExamplePath[] = []
  const limit = Math.max(1, Math.min(24, rounds))
  const walk = (steps: readonly string[], rules: readonly string[]) => {
    if (paths.length >= 16) return
    const next = model.rules.filter(rule => rule.on === steps.at(-1) && model.steps.some(step => step.id === rule.to))
    const available = next.filter(rule => steps.filter(id => id === rule.to).length < 2)
    if (!available.length || steps.length >= limit) {
      paths.push({ steps, rules, bounded: next.length > 0 }); return
    }
    for (const rule of available) walk([...steps, rule.to], [...rules, rule.id])
  }
  walk([model.seed], [])
  return paths
}

export interface ExampleFrame {
  readonly overlay: FlowOverlay
  readonly step: string | null
  readonly rule: FlowRuleView | null
  readonly person: boolean
  readonly complete: boolean
}
/** Presentation state stays wholly separate from flowOverlay's recorded Run projection. */
export const exampleFrame = (model: FlowModel, path: ExamplePath, cursor: number): ExampleFrame => {
  const complete = cursor >= path.steps.length
  const index = Math.max(0, Math.min(cursor, path.steps.length - 1))
  const step = path.steps[index] ?? null
  const person = !complete && model.steps.find(one => one.id === step)?.kind === 'person'
  const steps = new Map<string, FlowStepRun>(model.steps.map(one => {
    const visited = path.steps.slice(0, index + 1).includes(one.id)
    return [one.id, { state: complete ? visited ? 'done' : 'future' : one.id === step ? person ? 'waiting' : 'working' : visited ? 'done' : 'future', runs: null, durationMs: null, since: null, line: null, seats: [] }]
  }))
  const rules = new Map<string, FlowRuleRun>(model.rules.map(rule => [rule.id, {
    count: path.rules.slice(0, index).filter(id => id === rule.id).length,
    current: !complete && index > 0 && path.rules[index - 1] === rule.id,
  }]))
  return { overlay: { steps, rules }, step, rule: model.rules.find(rule => rule.id === path.rules[index - 1]) ?? null, person, complete }
}
