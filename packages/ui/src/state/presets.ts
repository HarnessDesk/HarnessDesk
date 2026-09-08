import type { ConfigOption, OptionValue } from '@harnessdesk/protocol'

/**
 * Presets.
 *
 * A preset is a named snapshot of a session's option values, saved from a
 * session set up the way you like it. It belongs to one runtime, because the
 * option ids are that runtime's: a Codex profile id means nothing to another
 * agent, and a preset that pretended otherwise would half-apply silently.
 *
 * There are no built-in presets. The runtime's own bundles — Codex calls them
 * collaboration modes — arrive through the `mode` option, which is where a
 * built-in belongs: described by the agent that implements it.
 */

export interface AgentPreset {
  readonly id: string
  readonly name: string
  readonly description: string
  /** The runtime whose options these are. */
  readonly runtime: string
  readonly values: Readonly<Record<string, OptionValue>>
}

/** The option values a session is currently on, as a preset would record them. */
export const snapshotValues = (
  options: readonly ConfigOption[],
): Record<string, OptionValue> =>
  Object.fromEntries(options.map((option) => [option.id, option.currentValue]))

/**
 * Reads user-defined presets out of persisted app state.
 *
 * Validated on the way in rather than trusted: the state file is a plain JSON
 * document a user can edit, and a malformed entry should be skipped, not crash
 * the settings pane. Entries in the pre-option shape (`settings` rather than
 * `values`) are dropped — their vocabulary no longer exists.
 */
export const readCustomPresets = (raw: unknown): AgentPreset[] => {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as Record<string, unknown>
    if (typeof record['id'] !== 'string' || typeof record['name'] !== 'string') return []
    if (typeof record['runtime'] !== 'string') return []
    const values = record['values']
    if (typeof values !== 'object' || values === null || Array.isArray(values)) return []
    const clean: Record<string, OptionValue> = {}
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'boolean') clean[key] = value
    }
    return [
      {
        id: record['id'],
        name: record['name'],
        description: typeof record['description'] === 'string' ? record['description'] : '',
        runtime: record['runtime'],
        values: clean,
      },
    ]
  })
}

/**
 * The preset a session's current options correspond to, if any.
 *
 * Reported rather than stored, so hand-editing one control shows the session as
 * customised instead of leaving a stale preset name attached to options that
 * no longer match it. A preset matches when every value it records is the
 * session's current value; options the preset does not mention are free.
 */
export const matchPreset = (
  runtime: string,
  options: readonly ConfigOption[] | undefined,
  presets: readonly AgentPreset[],
): AgentPreset | undefined => {
  if (!options) return undefined
  const current = snapshotValues(options)
  return presets.find(
    (preset) =>
      preset.runtime === runtime &&
      Object.keys(preset.values).length > 0 &&
      Object.entries(preset.values).every(([id, value]) => current[id] === value),
  )
}

/** Presets that belong to the selected runtime. Others are kept but not offered. */
export const presetsFor = (
  runtime: string | null,
  presets: readonly AgentPreset[],
): AgentPreset[] => presets.filter((preset) => preset.runtime === runtime)
