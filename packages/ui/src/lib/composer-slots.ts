import type { ConfigOption, OptionValue } from '@harnessdesk/protocol'

/**
 * The composer and Settings need to make the same decision about where an
 * agent-declared option belongs. Unknown categories stay reachable in More.
 */

/** The four places an option can appear in the composer. */
export type ComposerOptionSlot = 'permissions' | 'mode' | 'model' | 'more'

/** Every composer slot with its options in the order the agent declared them. */
export type ComposerOptionsBySlot = Record<ComposerOptionSlot, ConfigOption[]>

/** Puts unknown and missing categories in More so new options remain reachable. */
export const slotForCategory = (category?: string): ComposerOptionSlot => {
  switch (category) {
    case '_permissions':
      return 'permissions'
    case 'mode':
      return 'mode'
    case 'model':
    case 'thought_level':
      return 'model'
    default:
      return 'more'
  }
}

/** Groups one option list for the composer and the matching Settings view. */
export const optionsBySlot = (options: readonly ConfigOption[] | undefined): ComposerOptionsBySlot => {
  const slots: ComposerOptionsBySlot = {
    permissions: [],
    mode: [],
    model: [],
    more: [],
  }
  for (const option of options ?? []) slots[slotForCategory(option.category)].push(option)
  return slots
}

/** The saved pick survives separately from the values allowed to start a session. */
export type StaleDefault = {
  readonly id: string
  readonly label: string
  readonly category?: string
  readonly value: OptionValue
  readonly valueLabel: string
  readonly reason: string
}

/** Explains saved picks the agent's answer no longer honours, in saved order. */
export const staleDefaults = (
  saved: Readonly<Record<string, OptionValue>>,
  options: readonly ConfigOption[],
  previous: readonly ConfigOption[] = [],
): StaleDefault[] => {
  // Some agents declare controls only after opening a conversation.
  if (options.length === 0 && previous.length === 0) return []
  return Object.entries(saved).flatMap(([id, value]) => {
    const option = options.find((one) => one.id === id)
    const earlier = previous.find((one) => one.id === id)
    const choice = option?.type === 'select' ? option.choices.find((one) => one.value === value) : undefined
    const oldChoice = earlier?.type === 'select' ? earlier.choices.find((one) => one.value === value) : undefined
    const reason = !option ? 'This setting is no longer offered.'
      : option.disabled || choice?.disabled
        || (option.type === 'select' && !choice ? 'This value is no longer offered.'
          : option.currentValue !== value ? 'The agent returned a different value.' : null)
    if (!reason) return []
    const metadata = earlier ?? option
    return [{ id, label: metadata?.label ?? id, ...(metadata?.category ? { category: metadata.category } : {}),
      value, valueLabel: oldChoice?.label ?? choice?.label ?? String(value), reason }]
  })
}
