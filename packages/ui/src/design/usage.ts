/**
 * When to use which — the layer the design system did not have.
 *
 * The token layer answers *what a value is*. The primitive layer answers *what
 * a component is*. Neither answers the question a person actually has in front
 * of a screen: **which of these do I reach for here, and why?** That question
 * was being answered independently by every screen, and the answers diverged
 * exactly as you would expect. Measured across the app before this file
 * existed, one slot — the action in a page or section head — carried four
 * different treatments:
 *
 *     Library          outline · outline · outline
 *     Settings Models  quiet · quiet · quiet
 *     Settings others  (unqualified, which paints grey)
 *     Agents           quiet · primary
 *
 * Nobody was careless. The vocabulary was short of a word: `outline` existed
 * only in the shadcn layer, while the retired Kit API could not draw a bordered
 * action and fell back to the grey default. The two spellings also disagreed
 * about the default. That measured failure is why every consumer now uses the
 * canonical `Button` vocabulary below.
 *
 * ---------------------------------------------------------------------------
 * Why this is data rather than a document
 *
 * A written convention rots, because nothing reads it. This table is read
 * twice: `script/design-doc.mjs` renders it into `docs/design-system.md`, and
 * `script/design-audit.mjs` enforces the parts a machine can check. So the
 * rule, the documentation of the rule, and the gate that holds the app to it
 * are the same object — which is the claim the rest of this system already
 * makes about values, extended to choices.
 *
 * What a machine can check is deliberately narrow: it holds *slots* whose
 * meaning is unambiguous (a header's action, a dialog's footer), and it never
 * tries to guess whether a given button is "the primary one". Judgement stays
 * with the person; what the gate removes is the drift that comes from nobody
 * having written the judgement down.
 */

/** A place in the interface whose meaning is fixed enough to have a rule. */
export type Slot = 'pageAction' | 'sectionAction' | 'dialogFooter'

export type UsageRule = {
  /** The family this rule governs. */
  readonly family: string
  /** The variant in the canonical button vocabulary. */
  readonly variant: string
  /** The single sentence a reader needs: when do I reach for this? */
  readonly when: string
  /** The case it is most often reached for wrongly, and what to use instead. */
  readonly never: string
  /** Why the app draws it this way rather than some other way. */
  readonly because: string
}

/**
 * The button vocabulary implemented once by `design/ui/button.tsx`. Retired
 * Kit aliases are intentionally absent so new feature code cannot revive a
 * parallel API.
 */
export const BUTTONS: readonly UsageRule[] = [
  {
    family: 'button',
    variant: 'default',
    when: 'The one action a surface exists to perform — the thing you came to do. At most one per screen, and often none.',
    never: 'A second one on the same surface. Two ink buttons is two primaries, which is none.',
    because:
      'It is the ink, the highest contrast the page can make. That is what makes it findable without a label saying "start here" — and what makes a second one cost the first its meaning.',
  },
  {
    family: 'button',
    variant: 'outline',
    when: 'An action in a page or section head, and any action that sits on the page\'s own ground with nothing else to separate it.',
    never: 'Inside a filled row or a card that already encloses it — the edge doubles up and the control reads as nested.',
    because:
      'A header action has no container of its own. Without an edge it is a phrase in a heading; the border is what makes it read as pressable at all.',
  },
  {
    family: 'button',
    variant: 'secondary',
    when: 'An ordinary action inside something that already encloses it — a card, a row, and Cancel or Close in a dialog footer, where it is drawn quiet whenever a filled act stands beside it, so the confirm is the one filled button. Alone in a footer it keeps its fill.',
    never: 'In a page or section head. It is the same grey as the surfaces around it and disappears into them.',
    because:
      'The enclosure supplies the separation, so the control does not have to. It is the app\'s most common button and the one an unqualified `Btn` has always drawn. In a footer that holds a filled act the footer decides its look (`:has()` on the footer slot), so a screen writes `secondary` and gets the quiet way out; a lone Close keeps its frame.',
  },
  {
    family: 'button',
    variant: 'quiet',
    when: 'The way out of a question — Keep, Cancel, Close — when the act beside it is filled.',
    never: 'As the only action on a surface, or for the act itself: a quiet button is the answer that changes nothing.',
    because:
      'A footer with two equally weighted buttons has no default. The quiet one is still a button — it takes the hover fill and the ring — but the eye lands on the filled one first.',
  },
  {
    family: 'button',
    variant: 'ghost',
    when: 'A repeated action inside a dense row or a toolbar, where an edge on every one would draw a grid.',
    never: 'As the only action on a surface — with no edge and no fill there is nothing to say it can be pressed.',
    because:
      'Density. Twelve bordered buttons in a toolbar is a table; twelve glyphs is a toolbar.',
  },
  {
    family: 'button',
    variant: 'destructive',
    when: 'A remove action set among others on a page or in a row — the door to a confirm, not the confirm.',
    never: 'For an action that merely closes, cancels or hides (those are ordinary), and never in a dialog footer: the act of a destructive confirm is `danger`, filled, and the audit refuses the soft red there.',
    because:
      'It is soft — danger ink on nothing, filling on hover — rather than a solid red. On a page a red fill competes with the primary for the loudest thing on the screen, and the loudest thing should be what you came to do, not what you might regret.',
  },
  {
    family: 'button',
    variant: 'danger',
    when: 'The act of a destructive confirm: Delete, Remove worktree, Discard — the one filled button in that footer. `ConfirmDialog tone="destructive"` draws it.',
    never: 'Beside another filled button, or on a page. Anywhere but the answer to "are you sure?" it is `destructive`.',
    because:
      'In the confirm the question has already been asked, so the red is no longer competing with what you came to do — it is what you came to do. A red-text act beside a plain-text Keep was two equal ghosts with no default.',
  },
]

/**
 * Everything else that has a rule worth writing down.
 *
 * Each of these was measured rather than decided: the `when` says what the app
 * already does in the majority of cases, and the `never` names the specific
 * way it was found to go wrong.
 */
export const ELEMENTS: readonly UsageRule[] = [
  {
    family: 'proportion',
    variant: 'box ÷ cap ≈ 3.2',
    when: 'Any control with a word in it — a button, an input, a select, a segmented cell.',
    never: 'Judging by box height alone, or by box ÷ font-size. Two faces at one nominal size have different ink, and the eye reads ink.',
    because:
      'Below 3.0 a control reads as a label with a box drawn round it, and above about 3.4 it reads as a banner rather than something to press. 3.0–3.2 is the band a control has to land in, and it is solved for rather than eyeballed.',
  },
  {
    family: 'target',
    variant: '--hd-icon-target',
    when: 'Any control whose whole content is a glyph — an icon button, a ⋮, a ✕.',
    never: 'Below 24px without clearance. WCAG 2.2 SC 2.5.8 asks 24×24, and the spacing exception needs room the control usually has not got.',
    because:
      'The app had nine icon-target sizes and no name for any of them. A rung is what stops the tenth.',
  },
  {
    family: 'fill',
    variant: '--hd-solid',
    when: 'A control that performs the action: a primary button, the composer\'s send coin. What you press to make something happen.',
    never: 'On a control that merely reports a state — an on switch, a ticked box, a selected row. Those are the accent.',
    because:
      'Ink is for what you press; the accent is for what is yours. Conflating them made the brand blue both the product\'s identity and every affordance\'s shout, so a screen with a Save button, a toggle and a selected row said one colour for three unrelated reasons.',
  },
  {
    family: 'fill',
    variant: '--hd-accent',
    when: 'The marks that say where you are or what is on: the selected row, a focus ring, a link, a progress bar, the column a card would land in, and the switch, checkbox or radio that is on.',
    never: 'On a filled button. Settings › Appearance › Accent promises buttons are ink in every accent, and that promise is what makes the dial safe to offer.',
    because:
      'A switch is pressed in both states, so the fill is not marking that you can press it — it is marking that it is on, which is a state and belongs here. Drawing it in ink left a black switch one row under the Accent dial, on the page whose only job is to show what that dial does. Note what the promise above does and does not cover: buttons. Everything else following the accent is the dial showing its work.',
  },
  {
    family: 'shape',
    variant: '--hd-radius-md',
    when: 'A control: a button, an input, a select, a segmented cell.',
    never: 'On a chip or a tag. Those are marks and take `--hd-radius-sm`, one rung down.',
    because:
      'A button and the chip beside it were the same shape, so a row of controls read as a row of labels. One rung apart is what separates them.',
  },
  {
    family: 'choice',
    variant: 'Segmented · NativeSelect · ChoiceList · Checkbox',
    when: 'One answer among two to four short ones: `Segmented`, or a `NativeSelect` when the words are long or the list may grow. One answer that needs a line to explain it: `ChoiceList` — compact radio rows, each with its description under its title in the hint step, so answers can be compared and choosing moves nothing. Several members at once (which Agents to seat, which files to take): checkboxes.',
    never: 'A switch for picking a member — a switch acts the moment it is flipped, and ticking who comes along is not an action. Nor a card of 60px settings rows for four words in a dialog; inside a dialog a `Rows` radio group made only of `RowChoice` rows already draws as a `ChoiceList` (a group of anything else keeps its card).',
    because:
      'A choice is read before it is made, so every answer shows what it means — in the hint step, a size below its title, so the titles still scan as a list. A description shown only on the chosen answer moved the rows under the pointer and hid what a person needed to compare.',
  },
  {
    family: 'form',
    variant: 'Field · Fieldset · FormStack',
    when: 'Anything a dialog asks for. A label sits 6px over its control, the next field starts 16px below, a group of controls takes a `Fieldset` legend the way a field takes a label, and a field that may be left empty says `optional` at its label\'s end.',
    never: 'Spacing a dialog\'s fields by hand, or a page\'s `SectionHead` as a group label: inside a dialog the body is already the form stack and a `SectionHead` already draws as a legend.',
    because:
      'A form is scanned by its labels. When every label is the same distance from its control and every field the same distance from the next, the eye stops measuring and reads; the "toy dialog" was one where each of those distances was a different accident.',
  },
  {
    family: 'surface',
    variant: '--hd-surface-*',
    when: 'A dialog, a command palette, a sheet — something that takes the window.',
    never: 'A popover or a hover card. Those are the popover\'s lighter surface, and they match each other rather than the dialog.',
    because:
      'A hover card that wore a dialog\'s shadow would claim the window\'s attention for something the pointer merely passed over.',
  },
]

/**
 * The slots a machine can hold, and what it holds them to.
 *
 * Deliberately few. A slot earns a rule when its meaning does not depend on
 * what the screen is about — a page head's action is a page head's action on
 * every page. Anything that needs to know whether *this particular* button is
 * the important one is a judgement, and judgement is what the `when` column
 * above is for.
 *
 * A page head and a section head were one slot here for about an hour, and
 * they are not: measured across the app, every section action was already a
 * rung shorter than every page action, and nothing had written that down. A
 * slot that holds two answers is two slots.
 */
export const SLOTS: readonly {
  readonly slot: Slot
  readonly what: string
  readonly allow: readonly string[]
  /** `full` is `--hd-btn-h`; `sm` is the rung below it. */
  readonly size: 'full' | 'sm'
  /**
   * Whether the slot may hold more than one filled action (`default`,
   * `primary`, `danger`).
   *
   * "At most one per screen" is the loudest claim the button vocabulary makes
   * and the one a machine can least often check, because a screen is not a
   * syntactic thing. A slot is, so the part that *can* be checked is: two
   * filled buttons in one header or one footer is two primaries, which is
   * none.
   */
  readonly oneInk?: true
  readonly why: string
}[] = [
  {
    slot: 'pageAction',
    what: 'the `actions` of a `PageHead`',
    allow: ['outline', 'default', 'primary', 'destructive', 'danger'],
    size: 'full',
    oneInk: true,
    why: 'It sits on the page\'s own ground with nothing enclosing it, so it needs an edge or a fill. The unqualified grey and `ghost` both vanish there — which is exactly how one settings window came to carry four different treatments of one slot.',
  },
  {
    slot: 'sectionAction',
    what: 'the `action` of a `SectionHead`',
    allow: ['outline', 'destructive', 'danger'],
    size: 'sm',
    why: 'One rung down, because a section heading is one rank down and its action should not outweigh the page\'s. `default` is missing on purpose: the page gets one ink action, and a section that claims a second one takes the first\'s meaning with it.',
  },
  {
    slot: 'dialogFooter',
    what: 'the `footer` of a `Dialog`',
    allow: ['default', 'primary', 'secondary', 'quiet', 'danger', 'outline'],
    size: 'full',
    oneInk: true,
    why: 'A footer of two or more buttons has exactly one filled act: the confirm, `default` — or `danger` when it destroys — never none (three text buttons with no default) and never two. A lone button is exempt: a sheet with only Close has nothing to act. Cancel and Close are `secondary`, which the footer draws quiet when a filled act stands beside it, or `quiet` itself. Write the proceeding action first; the footer is `row-reverse`, so it paints rightmost and is the first a Tab reaches. A disabled act is dimmed toward the footer ground, never faded to half opacity. `destructive` is not allowed: soft red text is a page\'s remove action, not a confirm\'s act. Nor is `ghost`: its ink is the full foreground, so beside the confirm it reads as a second answer of equal weight. The audit reads every branch of the footer and its `footerAside`.',
  },
]
