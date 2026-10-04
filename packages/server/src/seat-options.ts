import { findOption, refuseOptionValue, type AgentRuntime, type FlowSeat, type OptionValue } from '@harnessdesk/protocol'

import { SEAT_READ_DEADLINE_MS, within } from './seat-reads.js'

/**
 * Ask the runtime what the chosen model's session would offer, then use the
 * same refusal as session opening. ACP's draft read may drop an inapplicable
 * dimension, so inspect its returned controls rather than treating a
 * successful draft read as acceptance. Its hidden probe is never prompted.
 */
export const seatOptionsProblem = async (runtime: AgentRuntime, seat: FlowSeat, cwd: string, deadline = SEAT_READ_DEADLINE_MS): Promise<string | null> => {
  if (!seat.effort && seat.thinking === undefined) return null
  const name = runtime.info.presentation.name
  const catalogue = await within(() => runtime.knownModels ? runtime.knownModels() : runtime.listModels(), deadline)
  if (catalogue.settled !== 'value' || catalogue.value === null) {
    return `${name}'s model catalogue could not be read, so this Seat's options cannot be checked. Read the preview again when the agent is ready.`
  }
  const model = seat.model ? catalogue.value.find((one) => one.id === seat.model) : catalogue.value.find((one) => one.isDefault)
  let label = model ? `${name}'s ${model.displayName}` : name
  if (!runtime.defaultSessionOptions) {
    return `${label}'s session options could not be read, so this Seat's options cannot be checked.`
  }
  const idleProblem = () => `${name}'s session options cannot be checked while the agent is idle. Read the preview again when the agent is ready.`
  // An idle runtime may answer drafts with cached controls. Changing that
  // cache's model value cannot reveal the selected model's real dimensions.
  if (runtime.health().state === 'idle') return idleProblem()
  // Model first: on ACP it decides which effort and thinking controls exist.
  // Do not pass dimensions here: draft APIs may deliberately drop them.
  // Session-declared catalogues retain the first opening's default, while
  // their draft probe can have moved to another model. Reset that probe.
  // Other runtimes read the effective project configuration: leaving model
  // absent is how they choose the same default as session opening.
  const selectedModel = seat.model ?? (runtime.knownModels ? model?.id : undefined)
  const read = await within(() => runtime.defaultSessionOptions!(cwd, selectedModel ? { model: selectedModel } : {}), deadline)
  if (runtime.health().state === 'idle') return idleProblem()
  if (read.settled === 'late') return `${label}'s session options could not be read within ${deadline} ms. Read the preview again when the agent is ready.`
  if (read.settled === 'error') return `${label}: ${read.error instanceof Error ? read.error.message : String(read.error)}`
  const actualModel = findOption(read.value, 'model')?.currentValue
  const actual = catalogue.value.find((one) => one.id === actualModel)
  if (actual) label = `${name}'s ${actual.displayName}`
  const picks: Record<string, OptionValue> = {
    ...(seat.effort && seat.effort !== 'default' ? { effort: seat.effort } : {}),
    ...(seat.thinking !== undefined ? { thinking: seat.thinking } : {}),
  }
  for (const [id, value] of Object.entries(picks)) {
    const option = findOption(read.value, id)
    if (!option) return id === 'effort' ? `${label} has no effort levels.` : `${label} has no thinking switch.`
    const refused = refuseOptionValue(option, value)
    if (refused) return `${label}: ${refused}`
  }
  return null
}
