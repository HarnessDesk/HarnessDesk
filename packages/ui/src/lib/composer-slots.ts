import type { ConfigOption } from '@harnessdesk/protocol'

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
