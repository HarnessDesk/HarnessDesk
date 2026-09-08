/**
 * Configuration options — the capability surface.
 *
 * A runtime describes its controls as data and the interface renders them
 * generically. This is ACP's `SessionConfigOption` shape, adopted because ~40
 * agents already implement it and because Codex's own lists — `model/list`,
 * `collaborationMode/list`, `permissionProfile/list`,
 * `experimentalFeature/list` — normalise onto it cleanly.
 *
 * What it replaces is a closed settings struct: every runtime-specific control
 * used to cost a protocol change and a renderer change, and the renderer ended
 * up knowing Codex's vocabulary by heart. Here the interface knows two option
 * types and a handful of categories, and a control it has never heard of still
 * gets a working control.
 *
 * Constraints between options — "these two cannot be combined" — are not
 * modelled as rules. The runtime re-declares the whole list after every
 * change, so the list *after* a change is the truth about what is now
 * possible, and an option it will refuse right now says so in `disabled`.
 */

/**
 * Where the interface places an option. The four unprefixed values are ACP's;
 * names beginning with `_` are HarnessDesk's own, following ACP's convention
 * for custom categories. Unknown categories are treated as `other`.
 */
export type OptionCategory =
  | 'mode'
  | 'model'
  | 'thought_level'
  | 'other'
  /** What the agent may do without asking — permissions, approvals. */
  | '_permissions'
  | `_${string}`

/**
 * What to put to the person before a control is turned on, when turning it on
 * is a decision rather than a preference — one that spends money, or widens
 * what the agent may do.
 *
 * The runtime supplies the words because only it knows what the setting
 * actually costs; the interface only guarantees that the setting cannot be
 * reached without them being read. A control with no `confirm` is switched
 * the moment it is clicked, which is what almost every control should do.
 */
export interface OptionConfirm {
  /** A few words naming the thing being turned on. */
  readonly title: string
  /** What it does and what it costs, in the runtime's own words. */
  readonly body: string
  /** The button that goes through with it — "Enable Max mode", not "OK". */
  readonly action: string
  /** Where the full terms are, when the runtime publishes them. */
  readonly learnMore?: string
}

export interface OptionChoice {
  readonly value: string
  readonly label: string
  readonly description?: string
  /**
   * Set when choosing this value widens what the agent may do. A hint for the
   * interface to colour the control — "full access" is the one setting nobody
   * should drift into unnoticed. Nothing depends on it for correctness.
   */
  readonly risk?: 'elevated' | 'high'
  /** Heading this choice is listed under, when the runtime groups its choices. */
  readonly group?: string
  /**
   * When set, this specific choice cannot be selected — a managed policy
   * forbids it, say — and the string is the reason. Shown greyed with the
   * reason rather than removed. The whole-option `disabled` on `OptionBase`
   * blocks every choice; this blocks one.
   */
  readonly disabled?: string
}

interface OptionBase {
  /** Stable within a runtime. Opaque to the interface beyond display and round-tripping. */
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly category?: OptionCategory
  /**
   * Present when the runtime would refuse a change right now, with the reason.
   * Rendered greyed with the reason, never hidden: an absent control is a
   * support ticket, a greyed one is an explanation.
   */
  readonly disabled?: string
  /**
   * Put to the person before this control is changed — for a switch, before
   * it is turned *on*; turning something expensive off should take one click.
   * See {@link OptionConfirm}.
   */
  readonly confirm?: OptionConfirm
}

export interface SelectOption extends OptionBase {
  readonly type: 'select'
  readonly currentValue: string
  readonly choices: readonly OptionChoice[]
}

export interface BooleanOption extends OptionBase {
  readonly type: 'boolean'
  readonly currentValue: boolean
}

export type ConfigOption = SelectOption | BooleanOption

export type OptionValue = string | boolean

/**
 * Why a proposed value would be refused, or null when it is acceptable.
 *
 * Shared by the host, which checks every write before it reaches a runtime,
 * and by the conformance suite. Kept here rather than in each adapter because
 * some runtimes accept anything — Codex takes an unknown model id without
 * complaint — and the interface should never be the only thing standing
 * between a typo and a silently broken session.
 */
export const refuseOptionValue = (option: ConfigOption, value: OptionValue): string | null => {
  /*
   * Setting an option to what it already says is not a change, so there is
   * nothing to refuse. This has to come first, before the disabled check.
   *
   * A greyed control still *has* a value, and the value it has is legitimate:
   * Cursor's Gemini and Codex families offer one context window, so their Max
   * mode switch is disabled and reads `false`. Refusing `false` there is
   * refusing to leave a switch where it already is — and the refusal did not
   * stay local. It rode into the agent's stored picks, and every later
   * `session/create` on that agent sent it again and died on it, which is an
   * agent that cannot open a session because of a setting nobody changed.
   */
  if (value === option.currentValue) return null
  if (option.disabled) return option.disabled
  if (option.type === 'boolean') {
    return typeof value === 'boolean' ? null : `${option.label} is on or off, not ${JSON.stringify(value)}.`
  }
  if (typeof value !== 'string') return `${option.label} takes one of its listed values.`
  const choice = option.choices.find((entry) => entry.value === value)
  if (!choice) return `${JSON.stringify(value)} is not one of the values ${option.label} offers.`
  if (choice.disabled) return choice.disabled
  return null
}

/** The option with this id, if the runtime declared one. */
export const findOption = (
  options: readonly ConfigOption[] | undefined,
  id: string,
): ConfigOption | undefined => options?.find((option) => option.id === id)

/** Options placed in a category, with unknown categories falling into `other`. */
export const optionsIn = (
  options: readonly ConfigOption[] | undefined,
  category: OptionCategory,
): ConfigOption[] =>
  (options ?? []).filter((option) => normaliseCategory(option.category) === category)

const KNOWN: ReadonlySet<string> = new Set(['mode', 'model', 'thought_level', 'other', '_permissions'])

export const normaliseCategory = (category: OptionCategory | undefined): OptionCategory =>
  category && KNOWN.has(category) ? category : 'other'
