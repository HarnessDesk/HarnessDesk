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
    when: 'An ordinary action inside something that already encloses it — a dialog footer, a card, a row.',
    never: 'In a page or section head. It is the same grey as the surfaces around it and disappears into them.',
    because:
      'The enclosure supplies the separation, so the control does not have to. It is the app\'s most common button and the one an unqualified `Btn` has always drawn.',
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
    when: 'An action that removes something a person cannot get back.',
    never: 'For an action that merely closes, cancels or hides. Those are ordinary.',
    because:
      'It is soft in this app — danger ink on nothing, filling on hover — rather than a solid red. A red fill competes with the primary for the loudest thing on the screen, and the loudest thing should be what you came to do, not what you might regret.',
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
    family: 'surface',
    variant: '--hd-surface-*',
    when: 'A dialog, a command palette, a sheet — something that takes the window.',
    never: 'A popover or a hover card. Those are the popover\'s lighter surface, and they match each other rather than the dialog.',
    because:
      'A hover card that wore a dialog\'s shadow would claim the window\'s attention for something the pointer merely passed over.',
  },
  {
    family: 'tone',
    variant: 'warning',
    when: 'The person must act now — sign in, approve, free a limit — and the thing cannot go on without them. Chip, Badge, Note and Banner all read it this way.',
    never: 'For a default or a normal state: a permission that is "asked" by default, an open finding, a shadowed copy, a limit working as designed. Those are neutral or carry no chip.',
    because:
      'The Permissions page once drew 48 identical amber chips for the default. Amber on every row is how the one row that does need someone stops being found.',
  },
  {
    family: 'tone',
    variant: 'danger',
    when: 'Something is broken, or will be lost: a failed check, a missing executable, an action that deletes.',
    never: 'For a stop the person asked for. "The agent was stopped." after pressing Stop is neutral — it is the outcome they chose.',
    because:
      'Red is the loudest thing a screen can say. Spent on an outcome the reader chose, it teaches them to look past the red that matters.',
  },
  {
    family: 'tone',
    variant: 'neutral',
    when: 'Every default, every normal state and every fact that asks nothing of the reader — or no chip at all.',
    never: 'Promoted to a colour to make a row look busier. A tone is a claim about what the reader should do.',
    because:
      'Most of what a desk reports is fine. Neutral is what lets the exceptions be seen.',
  },
  {
    family: 'chip',
    variant: 'one line',
    when: 'Always. A chip never wraps: it stops at its box (at most 240px), ellipsises, and names itself whole in `title` while it is cut. The Chip enforces this.',
    never: 'Forced into two lines by a caller. A fact that needs a second line is a row\'s description or a dialog\'s, not a chip.',
    because:
      'A pill with two lines in it is a card pretending to be a mark — the board\'s wrapped evidence chips were the loudest thing on every card that carried one.',
  },
  {
    family: 'chip',
    variant: 'stale',
    when: 'A fact recorded before what is there now. Pass `stale`: the Chip mutes it, drops its tone, leads with the history glyph and says "stale" to a screen reader.',
    never: 'A strikethrough. Struck text reads as "wrong", and a stale fact was right when it was recorded.',
    because:
      'Muted with a glyph keeps the fact legible for what it was, and still says it is no longer current.',
  },
  {
    family: 'chip',
    variant: 'count',
    when: 'A chip that counts something takes `count`, and a zero draws nothing. `showZero` is for the rare set where zero is itself the finding.',
    never: 'A row of zero-count chips, or "+0 −0 in 0 files" on every card: a chip that counts none has nothing to say.',
    because:
      'A zero draws the eye exactly as much as a seven, and it asks nothing.',
  },
  {
    family: 'chip',
    variant: 'earned',
    when: 'A chip says something the row does not already say. A chip that is identical on every row of a group belongs in the group\'s heading, once.',
    never: 'Repeating the row\'s own title ("Healthy" beside a row titled Healthy), or the state a control beside it already shows ("Off" beside a switch that is off).',
    because:
      'Every chip costs the row some of its name. One that repeats the title or the control is paid for twice and says nothing.',
  },
  {
    family: 'empty-state',
    variant: 'panel',
    when: 'Nothing yet on a page, a pane or a dialog body that exists to hold it: centred icon, title, sentence and the ways to fill it. `tight` inside a card.',
    never: 'With its own ink action when the header above already has the primary. The empty state\'s action is then secondary — two ink buttons is two primaries, which is none.',
    because:
      'The empty Goal board once had "New job" in its header and "Add the first job" under it, both black.',
  },
  {
    family: 'empty-state',
    variant: 'inline',
    when: 'Nothing in a list, a column or a pane that already says what it is: one muted line, no icon, no heading.',
    never: 'Under a node of a navigation tree. An empty node has no children and at most a count; only a whole list with nothing in it at all may carry one inline line.',
    because:
      'A sentence under every empty Goal in the sidebar made the tree twice as tall and said the same thing four times.',
  },
  {
    family: 'empty-state',
    variant: 'row',
    when: 'Nothing in a `Rows` card: a row with the Row\'s own padding and hairline, its title a step quieter so it is never read as an item.',
    never: 'A hand-drawn `Row` titled "No … yet", or a bold title in a card of its own. Both were how the app came to have five empty layouts.',
    because:
      'The card keeps its shape whether it holds nothing or twelve things, so the page does not jump when the first one arrives.',
  },
  {
    family: 'key-value',
    variant: 'default',
    when: 'Facts about one thing, read as an inspector: muted keys in one column of a shared width, values left-aligned and wrapping as sentences.',
    never: 'Right-aligning a sentence. A ragged left edge cannot be scanned, and a three-line "Declares" set flush right was the worst line in its dialog.',
    because:
      'The eye runs down the keys and across to the value; a value that starts at the same x every time is the thing it lands on.',
  },
  {
    family: 'key-value',
    variant: 'numeric',
    when: 'A count, a total, money — a value a reader compares by place. The row says `numeric`, and only then is it right-aligned on tabular figures.',
    never: 'On a row that holds words, or as the list\'s default. Right alignment is a claim that the digits line up.',
    because:
      'A totals column that lines up by place is read in one glance; the same alignment on a sentence is read in none.',
  },
  {
    family: 'key-value',
    variant: 'path',
    when: 'A file or folder path as a value: `kind="path"` (or `MiddleTruncate` elsewhere) gives up the middle, keeps the last segment, and names the whole in its title while cut.',
    never: 'A bare path in a value: it has no break opportunities, so it either runs past the container or loses the file name at the end.',
    because:
      'A path\'s informative ends are whose it is and what it names. The middle is what every path in the list shares.',
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
   * Whether the slot may hold more than one ink action.
   *
   * "At most one per screen" is the loudest claim the button vocabulary makes
   * and the one a machine can least often check, because a screen is not a
   * syntactic thing. A slot is, so the part that *can* be checked is: two ink
   * buttons in one header is two primaries, which is none.
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
    allow: ['default', 'primary', 'secondary', 'destructive', 'danger', 'outline'],
    size: 'full',
    oneInk: true,
    why: 'The dialog encloses them, so `secondary` is the ordinary answer and the confirm is the one `default`. `ghost` is not: a footer button with no edge reads as a link in a place where every choice should look equally pressable.',
  },
]
