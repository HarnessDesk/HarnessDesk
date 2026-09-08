import type { ConfigOption, OptionChoice, SelectOption } from '@harnessdesk/protocol'

/**
 * Reading the capability surface for display. The renderer knows two option
 * types and a few categories, and these are the only questions it asks.
 */

export type Tone = 'calm' | 'warn' | 'alert'

/** The choice a select is currently on. Always present for a well-formed option. */
export const selectedChoice = (option: SelectOption): OptionChoice | undefined =>
  option.choices.find((choice) => choice.value === option.currentValue)

/**
 * How loudly to render a group of options, from the risk their current
 * choices carry. Codex's own client colours its permission control this way,
 * and it is right to: "full access" is the one setting nobody should drift
 * into without noticing. The risk itself comes from the runtime; this only
 * picks the colour.
 */
export const riskTone = (options: readonly ConfigOption[]): Tone => {
  let tone: Tone = 'calm'
  for (const option of options) {
    if (option.type !== 'select') continue
    const risk = selectedChoice(option)?.risk
    if (risk === 'high') return 'alert'
    if (risk === 'elevated') tone = 'warn'
  }
  return tone
}

/** A short label for the current state of a group, e.g. "Workspace write · Agent decides". */
export const summarise = (options: readonly ConfigOption[]): string =>
  options
    .map((option) =>
      option.type === 'select'
        ? (selectedChoice(option)?.label ?? option.currentValue)
        : option.currentValue
          ? option.label
          : null,
    )
    .filter((label): label is string => label !== null)
    .join(' · ')

/**
 * Whether a select's descriptions are a column or a ragged edge.
 *
 * Two things have to be true before a list of choices explains itself on
 * screen, and both come from the one job a description has in a picker:
 * helping you choose between these rows.
 *
 * **Every row has one.** A fact that varies earns its line when it varies
 * across *all* of them — a column the eye can compare down the list. A field
 * the data merely happens to carry sometimes is not that: Claude Code's
 * auto-compact describes "Default" and "Automatic" and says nothing about
 * 100k, 200k, 500k or 1M, so two rows stand two lines tall beside four that
 * stand one, which reads as a rendering fault rather than a distinction.
 *
 * **No two rows say the same thing.** A sentence printed twice cannot tell
 * the two rows apart, which is the whole reason it was on screen. Claude
 * Code's list gives "Default (recommended)" and "Opus (1M context)" the
 * byte-identical "Opus 5 with 1M context · Best for everyday, complex tasks";
 * the reader has to compare two grey lines to learn they are the same model,
 * which is a poor way to say so. This is docs/design.md's "same sentence
 * N times" — the hand-off list collapsed three identical lines into one note
 * over the group — read down to the pair.
 *
 * Both hold for Codex, whose six codenames carry six distinct sentences, and
 * for the permission tiers, where being wrong is expensive. Neither holds for
 * Claude Code's models, so its list reads as six names. Nothing is thrown
 * away: `ChoiceRows` still hangs every description on the row's `title`.
 *
 * Judged from the runtime's complete list rather than whatever a filter box
 * is currently showing — otherwise typing three letters would change how the
 * remaining rows look.
 */
export const describesEveryChoice = (option: SelectOption): boolean => {
  const seen = new Set<string>()
  for (const choice of option.choices) {
    const description = (choice.description ?? '').trim()
    if (description === '' || seen.has(description)) return false
    seen.add(description)
  }
  return true
}
