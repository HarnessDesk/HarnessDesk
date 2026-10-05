import { findOption, refuseOptionValue, OptionRefusedError, type AgentRuntime, type FlowSeat, type OptionValue } from '@harnessdesk/protocol'

import { openedOtherwise, runningOf } from './agent-seating.js'
import { SEAT_READ_DEADLINE_MS, within } from './seat-reads.js'

export interface SeatOptionsProblem {
  readonly text: string
  /** A temporary read failure, not a defect in the Flow's requested picks. */
  readonly availability?: true
}

const unavailable = (text: string): SeatOptionsProblem => ({ text, availability: true })
const unsupported = (text: string): SeatOptionsProblem => ({ text })
const readFailure = (label: string, error: unknown): SeatOptionsProblem => {
  const text = `${label}: ${error instanceof Error ? error.message : String(error)}`
  return error instanceof OptionRefusedError ? unsupported(text) : unavailable(text)
}

/**
 * Ask the runtime what the chosen model's session would offer, then use the
 * same refusal as session opening. ACP's draft read may drop an inapplicable
 * dimension, so inspect its returned controls rather than treating a
 * successful draft read as acceptance. Then apply the whole combination and
 * compare what settled with the same read-back as opening. Its hidden probe
 * is never prompted.
 */
export const seatOptionsProblem = async (runtime: AgentRuntime, seat: FlowSeat, cwd: string, deadline = SEAT_READ_DEADLINE_MS): Promise<SeatOptionsProblem | null> => {
  if (!seat.effort && seat.thinking === undefined) return null
  const name = runtime.info.presentation.name
  const catalogue = await within(() => runtime.knownModels ? runtime.knownModels() : runtime.listModels(), deadline)
  if (catalogue.settled !== 'value' || catalogue.value === null) {
    return unavailable(`${name}'s model catalogue could not be read, so this Seat's options cannot be checked. Read the preview again when the agent is ready.`)
  }
  const model = seat.model ? catalogue.value.find((one) => one.id === seat.model) : catalogue.value.find((one) => one.isDefault)
  let label = model ? `${name}'s ${model.displayName}` : name
  if (!runtime.defaultSessionOptions) {
    return unavailable(`${label}'s session options could not be read, so this Seat's options cannot be checked.`)
  }
  const idleProblem = () => unavailable(`${name}'s session options cannot be checked while the agent is idle. Read the preview again when the agent is ready.`)
  // An idle runtime may answer drafts with cached controls. Changing that
  // cache's model value cannot reveal the selected model's real dimensions.
  if (runtime.health().state === 'idle') return idleProblem()
  // Model first: on ACP it decides which effort and thinking controls exist.
  // Do not pass dimensions here: draft APIs may deliberately drop them.
  // Fresh drafts start with the project's new-session defaults, rather than
  // inheriting a composer's last model or dimension picks.
  const selectedModel = seat.model
  const read = await within(() => runtime.defaultSessionOptions!(cwd, selectedModel ? { model: selectedModel } : {}, { fresh: true }), deadline)
  if (runtime.health().state === 'idle') return idleProblem()
  if (read.settled === 'late') return unavailable(`${label}'s session options could not be read within ${deadline} ms. Read the preview again when the agent is ready.`)
  if (read.settled === 'error') return readFailure(label, read.error)
  const actualModel = findOption(read.value, 'model')?.currentValue
  const actual = catalogue.value.find((one) => one.id === actualModel)
  if (actual) label = `${name}'s ${actual.displayName}`
  const picks: Record<string, OptionValue> = {
    ...(seat.effort ? { effort: seat.effort } : {}),
    ...(seat.thinking !== undefined ? { thinking: seat.thinking } : {}),
  }
  let controls = read.value
  const applied: Record<string, OptionValue> = selectedModel ? { model: selectedModel } : {}
  for (const [id, value] of Object.entries(picks)) {
    const option = findOption(controls, id)
    if (!option) return unsupported(id === 'effort' ? `${label} has no effort levels.` : `${label} has no thinking switch.`)
    const refused = refuseOptionValue(option, value)
    if (refused) return unsupported(`${label}: ${refused}`)
    applied[id] = value
    if (id === 'effort' && seat.thinking !== undefined) {
      // Effort can reveal or enable thinking. Validate that next control
      // against what the agent reports after effort, as opening does.
      const afterEffort = await within(() => runtime.defaultSessionOptions!(cwd, applied, { fresh: true }), deadline)
      if (runtime.health().state === 'idle') return idleProblem()
      if (afterEffort.settled === 'late') return unavailable(`${label}'s session options could not be read within ${deadline} ms. Read the preview again when the agent is ready.`)
      if (afterEffort.settled === 'error') return readFailure(label, afterEffort.error)
      controls = afterEffort.value
    }
  }
  // Opening applies model, effort, then thinking, and clears a movable
  // thinking switch when the Seat did not ask for it. A model's individual
  // controls can offer picks whose combination the runtime settles elsewhere.
  const settled = await within(async () => {
    const values = { ...(selectedModel ? { model: selectedModel } : {}), ...picks }
    const options = await runtime.defaultSessionOptions!(cwd, values, { fresh: true })
    const thinking = findOption(options, 'thinking')
    // Effort can reveal or fix the switch, so inspect it after the picks.
    return seat.thinking === undefined && thinking?.currentValue === true && !thinking.disabled
      ? runtime.defaultSessionOptions!(cwd, { ...values, thinking: false }, { fresh: true })
      : options
  }, deadline)
  if (runtime.health().state === 'idle') return idleProblem()
  if (settled.settled === 'late') return unavailable(`${label}'s session options could not be read within ${deadline} ms. Read the preview again when the agent is ready.`)
  if (settled.settled === 'error') return readFailure(label, settled.error)
  const problem = openedOtherwise(
    { ...seat, runtime: label },
    runningOf(settled.value, { cwd, model: actualModel ? String(actualModel) : '' }),
  )
  return problem ? unsupported(problem) : null
}
