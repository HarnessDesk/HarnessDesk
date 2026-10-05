# Design rules

HarnessDesk's hand-written design rules: the type scale, ink levels and row
rhythm, and when a row may explain itself on screen rather than waiting to be
asked. It is a companion to [design-system.md](design-system.md), which is
generated from the code; this document holds the reasoning behind the rules no
token can capture.

The tokens live in
[`packages/ui/src/design/foundation/tokens.css`](../packages/ui/src/design/foundation/tokens.css), the
foundation layer; `app.css` is bundled last and keeps only the brand globals.
Use them. A raw `font-size: 12.5px` or literal colour in a component is how the
app ended up with ten sizes and no scale.

## The typographic scale

### The faces

`--hd-font-family` is **Geist**, bundled at `packages/ui/src/assets/fonts/` and
re-vendored by [`script/vendor-fonts.mjs`](../script/vendor-fonts.mjs). One
variable file per unicode range covers weights 400–600, so a weight change costs
nothing in network requests.

Every size in this document is drawn against Geist's metrics, so a row set in
it occupies the space the layout was drawn for. Substituting a face that sets
narrower or shorter makes the same nominal size arrive visibly smaller, and the
whole scale reads denser than it was designed to.

`--hd-font-code` is `ui-monospace` first, then the platform's monospace. It
never prefers a downloaded face: code should look the same on every machine,
and a face like JetBrains Mono means the app looks like itself only where
somebody happened to install it. Neither stack ends in a bare `monospace`:
Windows CJK falls back to
SimSun from there.

`--hd-font-heading` is the face a place's name is set in — the `wordmark`, `page`
and detail titles — with `--hd-tracking-heading` (−0.01em). Both default to the
interface sans; the tokens exist so a foundation that wants its own voice for a
place's name changes one line rather than three patterns.

### The title block

A page's head closes on a hairline with a short mark in the accent at its
start (`PageHead`, `DetailHead`): the rule under the title on a drawing sheet.
The name of a place is set off from what is on it by one line rather than a box
or a band of colour, and the mark is the only place the accent appears on a page
that the reader did not put there. Its colours and measures are the
`--hd-title-rule*` tokens, so a foundation retunes the mark, or sets its width
to 0 to drop it, without touching the pattern.

### The accent

The accent is Blueprint cobalt, `rgb(52, 88, 240)`: deep enough that white
reads on it at 5.5:1 where the lighter blue before it managed 4.1:1 — short of
AA for a 13px label on the fill. Its hover darkens rather than lightens, since a
press presses ink into the page rather than washing it out. The accent still
means what is *yours* — the focus ring, a link, a selection, the title mark —
and a primary button stays ink (`--hd-solid`), as the section on buttons says.

### The sizes

The two default running sizes are **13px for chrome and 14px for reading**.
12px carries meta facts and existing compact controls; headings, readouts and
documents keep their named larger roles. The counts
are a different fact and worth keeping separate from it — by volume the app is
12px and 13px, because a screen is nearly all furniture and most of the
furniture is smaller than a row's own title.

| token | value | what it carries | rules |
| --- | --- | --- | --- |
| `--hd-text-xs` | 12px | counts, badges, tags, timestamps, per-file diff numbers, the smallest button label, the hint under a form field | 217 |
| `--hd-text-sm` | 13px | the chrome: rows, navigation, settings rows, menu items, button labels, a form field's label, notes | 215 |
| `--hd-text` | 14px | what is read: the transcript, the composer, inputs and content names | 82 |
| `--hd-text-lg` | 16px | a section heading or metric readout | 16 |
| `--hd-heading` | 20px | every page's title — a list page's and a detail page's alike — and the wordmark | 14 |
| `--hd-title` | 24px | reserved; no page head wears it since the detail head joined the page title (#832). Markdown's h1 fallback | 0 |
| `--hd-display` | 36px | a figure that fills a card | 1 |

The counts are measured, not aspirational. The sizes above 14 are rare because
each names one thing — a dialog asks one question, a page has one title, a card
carries one figure — and a step that names one thing is a step you can pick
without thinking.

**There is nothing below 12px.** Nine- and ten-pixel steps existed once and had
three call sites between them; the one that looked as if it really needed nine
was measured, and the string it was shrinking for fitted at twelve with three
pixels to spare on each side. If something needs to feel smaller, it needs
less prominence, not less type: change its ink, not its size.

**The interface reads a step below the thing it is about.** A sidebar row, a
settings row and a menu item are all 13px; the transcript and the composer are
14. That is a step, not a whim: the furniture is scanned and the column is
read, and one step is enough to say which is which without either of them
shouting. Buttons are on the chrome side, at 13px (`--hd-btn-text`) and 12px
(`--hd-btn-text-sm`), which is also what holds the proportion between a button's
box and the cap height of the label inside it.

Prose keeps its own scale, in `Markdown.module.css` rather than here, and it is
the one place allowed off this table. It is four ratios of the transcript's own
14px body — 1.5, 1.25, 1.125, 1 — so `h1` is 21px, `h2` is 17.5px, `h3` is
15.75px, and `h4` is the body's own size in semibold with no gap under it.
Multiplying rather than naming pixels is what keeps the ladder true if the body
ever moves, which it has: the ladder followed the body down a step without a
line of it being edited.

Every prose heading is therefore at or above the body size. Anchoring the
ladder's *top* rung on a step of this table instead would keep the scale tidy
and produce a flat document: `##`, the heading an agent actually writes, would
come out barely above the paragraph under it. Furniture stays inside the table;
a document does not have to.

### Line and row rhythm

A size and its line are one decision, so every step names its pair and a surface
picks the pair rather than the size. Before that rule the 13px step was set on
eight different line-heights across the tree and the 12px step on five — ten
line values serving six sizes, which is what an inconsistency looks like before
anybody has counted it.

The pair is the default, not the only legal answer, and the deviation that is
allowed has a direction. **Text that wraps may take the next line up; nothing
takes a line tighter than its own.** Counted today: 132 rules on the pair, 38 a
step looser, none tighter. The 38 are almost all a 12px caption set on the 13px
step's 20px line, which is the same trade prose makes at the other end of the
scale and for the same reason — a paragraph needs air between its lines and a
row does not. A tighter line is not a trade, it is a crush.

There is a second rule, and leaving it unsaid is what let the first one be
broken quietly. **A single line inside a box that already states its height
sets `line-height: 1`** — a chip, a badge, a meter's caption, a figure in a
stat tile. The box's padding is the rhythm and the line only has to be the
glyph; anything above 1 is the box arguing with itself. Seventeen rules do
this, and before it was written down they read as seventeen violations of the
first rule, which is why nobody could tell them from the real ones.

Both rules are counted off the same two spellings and no others: a
`line-height` naming a `--hd-line-*` token, or Tailwind's `leading-(--hd-line-*)`.
A ratio is neither. Twenty-one stylesheets and twenty-two components set their
line as `1.15`, `1.4`, `leading-snug`, `leading-tight`, and every one of them
was outside the count that reported none tighter — nine of them were. The
ratios are gone and Tailwind's own steps now name their pair too, `text-xs`
and `text-xl` included: those two agreed with the table by coincidence across
a hundred and fifty call sites, and a coincidence does not follow a change.

## Content insets

A filled or bordered content surface earns an inset by its role, not by the
screen drawing it. Use the tier token on every slot; top and bottom match.
A border adds its width outside the inset. A larger gap left by short content
is free space, not a larger padding tier. A settings row's mark and control
stay centred on the whole row; its visible boxes keep the named inset. A row's
bottom hairline is additional to its content inset.

| Container role | Tier | Token | Slots that own it |
| --- | --- | --- | --- |
| Card and board card, chart's inner card, sent-message bubble | card · 16px | `--hd-inset-card` | A card's header, content and footer share its inline inset; its outer top and bottom share the same tier. A standalone board card, chart card or bubble owns all four sides. |
| Settings row with a description, mark or face, summary fact, comfortable list row, compact report card, agent/publication card band and crest, approval's code block | row · 12px | `--hd-inset-row` | Each row owns its inset, including inside a flush outer card. A label over a `Rows` card aligns with the row tier plus the card's border. |
| Bare Settings row (no description, mark or face) | dense block · 8px; row inline · 12px | `--hd-inset-dense` / `--hd-inset-row` | The 44px bare floor holds a 28px control with 8px above and below. Taller controls can grow the row; face rows always keep the full row tier. |
| Activity lines above a composer | row · 12px | `--hd-inset-row` | Each filled line in `ComposerTail` owns all four sides, overriding the unframed live line's smaller rhythm. Faces are content too. |
| Board column around its cards, inspector group band, tool-pane content aligned with its bar | dense · 8px | `--hd-inset-dense` | The filled inspector band keeps symmetric vertical air and the rows' 12px inline edge; a non-bleeding tool body shares its header's leading edge. |
| Compact panel section | row · 12px | `--hd-inset-row` | The section owns all four sides. |
| Modal question or sheet | dialog · 24px | `--hd-inset-dialog` | Header, body and footer; a bare primitive dialog owns the outer inset instead. A flush list body delegates to its rows. A subhead is a bar, keeping the same inline edge. |
| Pane's reading column | reading · 24px | `PaneColumn inset="reading"` | The pane owns the gutter before the reading measure; scrollbar reservation is additional layout space. A floating composer's bottom reserve is clearance, not a surface inset. |
| Bar and navigation rail | bar · 8px | `--hd-bar-pad`, `--hd-rail-inset` | The bar owns the control-box edge; `--hd-bar-ink` includes the control's own inset for labels. Native window controls may add clearance. |

An approval's outer edge uses the dialog tier in an overlay and the card
tier when docked beside a composer. Its warning mark hangs before the text
column; title and body keep that same column in both placements.

A prose inspector chooses `PanelFrame inset="reading"`: its tool bar and body
share one `PaneColumn` gutter, rather than adding dense body padding before it.
A page section can name its body tier (`Section inset="row"` or `"card"`);
its label shares that edge. An unframed empty body uses `SectionBody spacing="inline"`,
leaving its vertical rhythm to the inline empty state. The table family's
`--hd-table-edge` follows the row inset in both densities; its minimum row
heights, face sizes and centring remain the family's own geometry.
An explicitly compact `ListRow` keeps 1px symmetric vertical padding for
unwrapped copy; `wrapTitle` or `wrapSubtitle` earns the dense 8px block inset.
Both keep the 40px full or 32px bare row floor and the 12px inline inset.
A responsive framed table uses `Table inset="row"`
to keep the same inline cell inset as the list replacing it. The table retains
its existing head and data-cell pitch; this contract only sets the content edge. Borders stay outside
those content insets. A board column's state dot hangs before its card-text
edge; the heading and empty line derive that edge from the card tier and
border. `ToolPaneHeader contentInset="board"` derives the same text column
through the dense body and column, and the card tier, rather than fixing their old numbers.

The tier rule judges **content containers**. Buttons, inputs, chips, compact
navigation targets and menu panels keep their own measured control rhythm;
their glyph is not a card's content. A scroll viewport, an editor, a full-bleed
row highlight, a chart's 2px matte and a graph's positioned marks also have
named geometry rather than four content insets. Do not add a second gutter to
these: measure the content-owning slot inside them. Preview frames are a rig's
outer boundary, not another product card.

`e2e/ui-system/container-insets.spec.ts` checks the known slots in both themes
at wide and narrow widths. It reads the tier from the loaded foundation,
checks padding and symmetry, and measures the union of visible text, faces and
painted controls. Transparent hit targets contribute their visible ink instead
of their invisible hit region. Ellipsized and clamped text is clipped to its viewport; a floating
overlay belongs to its own surface. A figure set on `line-height: 1` is measured
by its line box, because a text Range includes unused font-em space outside it.

## Named text roles

A size and a weight together name a *role*. A role describes what the words
are doing; screens do not invent a new spelling for the same job:

| role | spelling | what wears it |
| --- | --- | --- |
| wordmark | 20 / semibold | the product name beside its mark |
| page | 20 / semibold | the name of a place — a settings page, a review, and a page drilled into (`DetailHead`) alike; by owner decision on 2026-09-19 it matches the wordmark rather than outsizing it, and #832 put the detail head on it too: a detail page adds its mark and its owner chip, never a size of its own |
| section | 16 / semibold | a page band's heading (a Dashboard band) — below the page title, above a subject (#1122) |
| group label | 13 / normal, secondary ink | the word over a group — a card of rows, a rail's list, a section of a page (`GroupLabel`). Sentence case, always: no label outside a `Keycap` is set in capitals |
| subject | 14 / medium | the name of the thing a pane, a dialog or a card is about |
| member | 14 / medium | the name of someone — an agent at work or a person — beside its face: a chat's sender, a member named inside a sentence (`MemberName`); `--hd-member-weight` owns the weight |
| row | 13 / medium | the title of a setting, and the word above a control |
| navigation | 13 / normal | the name of one thing in a navigable list |
| muted | 13 / normal | a description under a name, and chrome that labels rather than names |

Counted before this rule was written down: eight. A dialog's title was 16/600
in one pattern and 14/600 in another; a label above a field was 13/600 in three
screens, 13 at whatever weight it inherited in three more, and 12 in a seventh.
The design system's own head slots said 600 in five components and 500 in the
sixth — so a screen that composed the system got a heavier title than a screen
that drew its own, which is the opposite of what a design system is for.

At the time this rule was written, nothing was 16. A step between the subject
and the page turned out to be a way of avoiding the choice between them: a
dialog names one question and a page names a place, and 16 said neither.

| step | line | ratio |
| --- | --- | --- |
| 12px | `--hd-line-xs` 16px | 1.33 |
| 13px | `--hd-line-sm` 20px | 1.538 |
| 14px | `--hd-line` 20px | 1.429 |
| 16px | `--hd-line-lg` 24px | 1.5 |
| 20px | `--hd-line-heading` 28px | 1.4 |
| 24px | `--hd-line-title` 30px | 1.25 |
| 36px | `--hd-line-display` 40px | 1.11 |

The Desk foundation sets both running sizes on a 20px line. Above those
sizes the ratios tighten from 1.5 to 1.11. Prose is the exception in the other
direction: the transcript is set on 1.625, because a paragraph wraps and a row
does not.

Rows:

| token | value | note |
| --- | --- | --- |
| `--hd-row-h` | 30px | a one-line row |
| `--hd-nav-h` | `calc(--hd-line-sm + --hd-space-1 * 2 + 2px)` | a navigation row — solved, not written (30px) |
| `--hd-control-h` | 26px | dense toolbar targets and icon buttons |
| `--hd-field-h` | 30px | inputs and selects: matches `--hd-btn-h` |
| `--hd-bar-h` | 46px | the window's own bar, and a pane's |

A navigation row's height is solved from **the row's real box**, not written:
its small line (`--hd-line-sm`), one step of padding above and below, and the
1px border it keeps on each side for focus and selection. Every row in every
column stands that height whatever it happens to carry, so a row of 13px labels
does not end up shorter than a row of 14px ones, and moving the line or the
density moves every one of them without a second edit. It used to be solved
from the reading size alone (`--hd-text` times 1.5), which came to 29px — a
pixel under the rows that carried their border, so the settings rail sat
lower than the sidebar and a menu beside it (#1073).

Rows sit 2px apart. Without that gap a hover or selection pill reads as a band
across the column rather than as one row.

### One title, one group label

There were two page titles and three group labels. A list page's `PageHead`
said 20px semibold and a detail page's `DetailHead` said 24px regular, so the
page you drilled into read lighter and less finished than the list you came
from. The word over a group was 13px secondary in the sidebar, 13px in the
faint ink over a settings card, and 12px tracked capitals in the room's rail,
the trajectory's roles and the agent card.

Now every page head is the page role, and every group heading is
`GroupLabel`. The interfaces vary a label's weight and the air above a rail's
group, never its size, its ink or its case. Capitals are counted: the design
audit's `uppercaseLabel` finds every `text-transform: uppercase`, `uppercase`
utility and inline `textTransform` outside a `Keycap`, and its ceiling may only
fall. The screens still spelling them — the room's rail, the trajectory, the
agent card and the transcript's small tags — are the burn-down.

### Where a label lands

One inset for a whole column or bar, and one derived place for the words in it.

| token | value | what it is |
| --- | --- | --- |
| `--hd-bar-pad` | 8px | where a **boxed** control's edge sits |
| `--hd-bar-ink` | `calc(--hd-bar-pad + --hd-nav-inset + --hd-border-width)` | where a **label** lands once a control has been composed |

A control's glyph is at the inset, plus the control's own padding, plus the
hairline it reserves whether or not it paints one. Anything with no box of its
own — a wordmark, a section label, a page title — states the sum instead, and
then everything in the column shares one x.

A `SectionHead` over a `Rows` card aligns with the first row's leading edge:
its mark when present, otherwise its first text glyph. The shared-column rule
is for bars and columns, not a card's row leads.

Getting this wrong is not subtle and is easy to do: handing the box inset to
things that have no box put the sidebar's wordmark, its section labels and the
conversation's title nine pixels left of everything they were meant to line up
with. An inset token is ambiguous unless it says *whose* edge it is, which is
why there are two of them.

### Controls and buttons

A control is a thing you aim at: 12px inside a 24px target is how Settings ended
up with thirty actions that read as captions.

`--hd-control-h` (26px, with `-sm` at 24px) answers how tall a square toolbar
target or icon button stands. Boxed text controls and buttons answer a different
question: they need proportion between the box height and the cap height of the
label inside it (about 0.715em in Geist). Measured across references:

- GitHub small: 28px box / 12px text, box/cap ratio 3.16, air above cap 9.6px
- GitHub medium: 32px box / 14px text, box/cap ratio 3.11, air above cap 10.9px
- reui.io: 28px box / 12.8px text, box/cap ratio 3.01, air above cap 9.3px
- This app's Banner action: 34px box / 14px text, box/cap ratio 3.40
- Previous app small button: 26px box / 13px text, box/cap ratio 2.80

The small button had become the tightest button in the comparison: the smallest
box with the largest ink. Both rungs are solved for a ratio of ~3.2:

- `sm`: 28px box / 12px text (`--hd-btn-text-sm`) → 28 / 8.58 = 3.26
- `default`: 30px box / 13px text (`--hd-btn-text`) → 30 / 9.30 = 3.23

Horizontal button padding is solved against cap height (1.1–1.35 × cap):
`--hd-btn-padding` is `0 12px`, and `--hd-btn-padding-sm` is `0 10px`. Text
controls (inputs and selects) share the 30px rung via `--hd-field-h:
var(--hd-btn-h)` so form rows line up across buttons and fields.

One button implementation exists: `Button` in `design/ui/button.tsx`. Every
surface, including Settings, consumes it through `design/index.ts`; its
`--hd-btn-*` contracts are pinned by `button.test.tsx`. The retired Kit aliases
do not remain as a second public vocabulary:

| variant | where |
| --- | --- |
| `secondary` | the ordinary action (grey frame); drawn quiet in a dialog footer beside a filled act |
| `default` | the one action a group exists for — at most one per group (ink fill) |
| `outline` | bordered action on a transparent ground |
| `ghost` | no frame until hover, for an action that repeats down a list |
| `quiet` | the way out of a question — Keep, Cancel, Close — beside a filled act |
| `destructive` | a remove action on a page or in a row, red on the label only |
| `danger` | the act of a destructive confirm, filled red |

Two rules keep red meaning something:

1. A button that only opens a confirmation is ordinary — the red belongs on the
   step that cannot be taken back.
2. Red is a fill in exactly one place: the act of a destructive confirm
   (`danger`, which `ConfirmDialog tone="destructive"` draws). By then the
   question has been asked, and the red is what you came to do. Everywhere
   else it is soft danger ink on a transparent ground that fills on hover
   (`destructive`), because a column of filled red buttons is a column nobody
   reads.

**A dialog footer has one filled button.** Every footer has exactly one
filled act: the confirm, `default`, or `danger` when it destroys — never none
(three text buttons with no default) and never two. A lone button is that
act, filled: a lone Close or Done in `secondary` was a frame the grey of the
footer it stood on (245 on 245, 49 on 49 in dark) and read as a caption.
Beside a filled act, `secondary` is drawn quiet (no
fill, secondary ink; the footer reads the act's `data-filled`), or write
`quiet` itself. `destructive` never stands in a footer. Write the proceeding
action first: the footer is `row-reverse`, so it paints rightmost and is the
first a Tab reaches.

A disabled filled act — ink or red — is drawn one way: its fill kept at 16%
over the footer's ground and its label in its own ink mixed into that ground,
solved so both land just over 3:1 (`--hd-btn-disabled-*-share`,
`--hd-btn-danger-disabled-ink-share`, `--hd-btn-{primary,danger}-disabled-*`).
The red ink loses contrast on its pale fill faster than the ink does on grey,
so it keeps 85% of itself where the ink keeps 60%. It stays the act, in its own
hue, and is clearly weaker than enabled: measured, the label goes from 17.2:1
to 3.2:1 on the ink button in light (10.5 → 3.1 dark) and from 4.9:1 to 3.2:1
on the red one (4.9 → 3.3 dark). Half opacity mixed the button into whatever
lay under it — a mid-grey slab on the grey footer.

The design audit reads every `Dialog` footer as a syntax tree: both arms of
each `?:`, with and without each `&&`, the `footerAside`, a hoisted `const`, a
component written in the same file (read through to what it returns), and a
control drawn with `buttonVariants(...)`. A component it cannot see into, a
spread child, or a spread that can set a button's variant is reported as
unread — never counted as an empty footer. All 54 footers in the app are
read.

### Dialog forms

A dialog that asks for more than one thing is a form, and its body is already
one (`design/patterns/DialogForm.tsx`): children 16px apart, a `Field`'s label
6px over its control and its hint 6px under it at 12px, a `Fieldset` legend
6px over its group. The Settings parts read the dialog around them, so a
screen composes them without saying a number: `SectionHead` draws a legend,
`FormStack`, `Note` and `Rows` drop their page spacing, and a `Rows` radio
group made only of `RowChoice` rows draws as a `ChoiceList` — compact rows, a
radio on the title's line, and every answer's description under its title in
the hint step, so answers can be compared and choosing moves nothing. A radio
group of anything else (New worktree's branch picker) keeps its card. The
scope stops where the form does: a `flush` body is a list, and dialog and
alert content, popovers and menus start outside any form, even when opened
from a dialog's field (React context crosses portals).

Which control a choice takes: `Segmented` or a `NativeSelect` for two to four
short answers; `ChoiceList` when answers need a line; checkboxes for several
members at once — never switches, which act the moment they flip. A field
that may be left empty says `optional` at its label's end rather than in the
label.

A dialog, a confirm, a menu or a popover that holds focus never wears the
focus ring round itself; the controls inside keep theirs. A dialog focuses its
first field when it has one, and otherwise its own surface.

`Segmented` is not a button. It is a piece of a segmented control — a choice
between two or three words, one of which is on — and using it for actions is
what produced those thirty captions.

### Weight

| weight | where |
| --- | --- |
| 400 | everything, unless named below |
| 500 | subject and member names, row titles and button labels |
| 600 | wordmark and page (20px), section (16px), figure (36px) and metric (16px) roles; document headings keep their prose scale |

A column of bold is a column of shouting. Selection is marked by a filled pill
and a check, never by making one row heavier than its neighbours. Button labels
set at weight 500 (`--hd-btn-weight`) because a 400-weight label on an ink
ground reads thin.

### Ink levels

| token | light | dark | what it carries |
| --- | --- | --- | --- |
| `--hdp-alias-label-primary` | `rgb(25, 27, 30)` | `rgb(229, 231, 234)` | anything a person reads: titles, rows, prose, values |
| `--hd-secondary-foreground` | `rgb(49, 49, 49)` | `rgb(224, 224, 224)` | structure and explanation: section headings, hints, blurbs, icons beside a label |
| `--hd-muted-foreground` | `rgb(71, 71, 71)` | `rgb(208, 208, 208)` | facts at the edge of a row: counts, times, keyboard hints |

In components, reach for the semantic tokens `--hd-foreground`,
`--hd-secondary-foreground`, and `--hd-muted-foreground` (`tokens.css`), which
resolve to these three palette aliases.

Three levels have to read as three, not two. Secondary uses the existing
grey-800 step in light mode and grey-200 in dark mode; muted uses grey-750 and
grey-300. These steps preserve the distinction from primary and between
secondary and muted, while keeping both lower tiers on their existing palette
ramps. The contrast test measures the semantic tokens on the app's real text
grounds in both themes.

Three rules, learned the hard way:

1. **A project groups its conversations.** Its quiet header uses secondary
   ink; conversation names keep primary ink at every level of the tree.
2. **Explanation is content.** A sentence describing what a setting does is
   secondary, not tertiary. If it were not worth reading it would not be on
   screen.
3. **Tertiary is for facts, not for text.** "3h", "+8 −0", "⌘K". A label
   nobody can read is not quiet, it is missing.

The tertiary step is deliberately darker than the platform's default in light
mode (and lighter in dark mode), because in this app it carries more than a
design system usually gives it.

### The code face

`--hd-font-code` (aliased as `--hdp-font-family-code`) is for code and for
output: Markdown code spans and blocks, diffs, the terminal, log lines, tokens
counted in a monospace column.

It is **not** for names that merely came from a machine. A branch, a folder, a
file in a list of files is a name, and names are set in the interface's own font.
A menu that mixes the two faces reads as two menus.

Real code set inside a sentence — a flag like `--force`, a command, a key
in a config file — is `CodeText`, and it takes its size from the sentence:
`--hd-code-inline`, 0.92em with the 12px step as its floor. The monospace
face's x-height is larger than the interface face's (0.547 against 0.530 of
the em) and its glyphs are wider and evenly weighted, so at the same size a
flag read a step larger than the words around it; at 0.92 it sits level with
them. It adds no step to the scale — it lands on the step of whatever
sentence holds it.

So a skill's name, a hook's event, a plugin's id, a contribution, a workspace
path, a worktree's branch and path, a route's endpoint and a changed file all
read in the interface's face. They are names, whatever produced them.

Two uses of the code face survive in components, and both are the rule rather
than an exception to it:

1. A JSON value in `SchemaForm` (`CodeText` in the `meta` text role),
   which is output.
2. A slash command in `TriggerMenu` (`.nameMono`), which is something you type.

Inline code inside a sentence is a `<code>` element, not `.mono`, so it picks up
the frame the Markdown column gives it.

## The second line

Almost every row in this app can carry a small grey line under its label — a menu
item's `hint`, a popover option's `optionHint`, a settings row's description.
They are cheap to write and they read well one at a time, so they accumulate:
someone adds a row, writes a helpful sentence under it, and the menu is one line
longer forever.

The rule is that the second line is **earned, not default**.

### What it costs

A hint roughly doubles a row: 30px of label becomes 47px of label and prose. Six
rows become a wall, and the eye stops scanning names and starts reading
paragraphs — which is the wrong motion for a menu, where the reader already
knows what they came for and only needs to find it.

The larger cost is dilution. When every row explains itself, the one row that is
explaining a genuine consequence — *files are not reverted* — looks exactly like
the five around it saying nothing. Prose everywhere is prose nowhere.

### The test

A second line is earned by exactly three things:

1. **A consequence the label cannot carry.** What the row also touches, what it
   pointedly does not touch, that it cannot be taken back. *"History only —
   files are left as they are."* *"Puts the request in the composer; you send
   it."* — that second one is the whole point of the row: it says the action
   does **not** do the thing it names, and without it the click is a surprise.
2. **A fact that varies.** A path, a count, an endpoint, a branch, the reason a
   row is refused. This is data wearing a hint's clothes. It differs per row, so
   it cannot be learned once and carried away, and a tooltip that must be hunted
   for one row at a time is worse than a column.
3. **A name that carries no meaning.** `GPT-5.6-Luna` is a codename; "Fast and
   affordable agentic coding model" is the only thing in that row a person can
   act on. The model menu keeps every one of its descriptions for this reason,
   and loses the one under **Refresh models**, whose label is already the
   sentence.

Everything else goes on hover, as `title`.

### What fails the test

**Restating the verb.** *Open workspace — "Make this the folder the app works
in."* The label said that. The line is a translation of English into English.

**Describing a destination.** *Trajectory. Agents. Activity.* A view is one
click away and one click back, so guessing wrong costs nothing — and discovery by
doing beats discovery by reading. Reserve the visible line for rows where being
wrong is expensive.

**Advertising a shortcut.** *Attach images… — "Or paste, or drop them here."* A
true and useful fact that is not about this row: it names two other routes to
the same place. It cannot change whether you click, so it does not need to be
read before you do.

**The same sentence N times.** Three agents in a hand-off list, each with an
identical *"Starts a new conversation there with what happened here."* If the
line is the same for every row in a group it is not a property of the rows — it
belongs to the group, as one `MenuNote` under the label. N copies are N times the
height and one sentence of information.

Read this down to a *pair*, because in a picker it is sharper there. Claude Code
sends the byte-identical *"Opus 5 with 1M context · Best for everyday, complex
tasks"* for both **Default (recommended)** and **Opus (1M context)**. A
description in a picker has one job — telling these rows apart — and a sentence
printed twice cannot do it. It is not even an efficient way to say the two are
the same model: the reader has to compare two grey paragraphs to notice. A
description that is not unique to its row is not a description, and the list is
judged as if it were absent.

**A line only some rows have.** Test 2 says a fact that varies is earned, and
that is true when it varies *across all of them* — a column of paths, a column of
counts, something the eye can compare down the list. It is not true of a field
the data merely happens to carry sometimes. **Start with** listed Codex with its
tagline and Claude and Cursor without one, because only Codex declares the
field: one row two lines tall and two rows one, which reads as a rendering fault
rather than a distinction. A fact that half the rows lack is not a column; it is
a ragged edge, and it belongs on hover until every row can fill it.

These two requirements are captured by one predicate, `describesEveryChoice` in
`packages/ui/src/lib/options.ts`: a select shows its descriptions when every
choice has one **and** no two are the same. It is judged on the runtime's
complete list, not on what a filter box is showing, so typing three letters
cannot change how the remaining rows look.

### An earned line has to arrive whole

A line that passes the test still fails if it cannot be read. Two of them were
set to `white-space: nowrap` with an ellipsis inside a fixed-width surface, so
the sentence was cut every time: the account menu's *"Local only — nothing syncs
betwe…"* and an agent card's tagline. A consequence delivered as an ellipsis is
not delivered — it costs the height and pays nothing back.

So the ellipsis is a fork in the road, not a layout detail, and it has three
ways out rather than two:

1. The line wraps, if it is earned — the design system's own `.hint` sets
   `white-space: normal` for exactly this reason.
2. It goes on hover, if it is not earned.
3. Or, best of the three where it fits: **it stops being a sentence.**

### The shortest earned line is a chip

The account menu is the case. *"Local only — nothing syncs between machines"*
passes test 1 outright — without it, "HarnessDesk" beside an avatar reads as an
account you are signed into — so hover was the wrong answer and wrapping only
made a true sentence take two lines to say one word. What the reader needs is the
word: a **Local** chip beside the name. It cannot be cut, it costs no row height
at all, and it reads at a glance rather than on a second pass. The sentence still
exists — on the row's `title`, and in full on Settings › Account, where there is
room for it.

Before writing a second line, ask whether the fact is really a sentence. A
state, a mode, a kind, a plan, a count — anything that fits in one or two words —
belongs in a chip on the label's own line, where the app already puts "Active",
"Browser sign-in" and an account's plan. A second line is for what genuinely
needs a clause. Truncate names, counts and paths, which the reader can recognise
from a fragment. Never truncate a sentence — and prefer not to write one where a
word will do.

### The exceptions

**A refused row keeps its reason on screen.** A disabled control cannot be
relied on to raise a tooltip at all — pointer events are suppressed, and the
browsers disagree about the rest. The one line that makes a greyed row useful
must not be the line nobody can reach. `MenuItem` encodes this: a `disabled`
string renders as the hint *and* the title.

**Settings are not menus.** A settings page is a reference document, read
deliberately and left; a menu is a list, scanned under time pressure and
dismissed. Rows in Settings keep their descriptions. So do banners, which exist
to explain, and confirmation dialogs, which exist to make you stop.

**A destination whose name the app invented.** Where a view's label is a word
this app coined rather than one the reader brought with them, the gloss is
doing the work of a name — that is test 3, not an exception to it.

**A plugin's words are not ours to trim.** The context providers under the
paperclip carry a `chip.description` written by whichever plugin contributed
them. Those pass test 2 by construction — they vary per plugin, and the label is
that plugin's own word — so they stay on screen. The rule governs the rows this
app writes.

### Where the string goes

Both slots take the same string; only the timing differs. `hint` renders,
`title` waits to be asked. Moving a line to hover throws nothing away, and the
sentence usually keeps earning its keep in more than one place. For example,
view definitions registered via `registerView` in
`packages/ui/src/panels/builtins.tsx` (queried via `summonable()` in
`packages/ui/src/panels/views.tsx`) hand one sentence (`hint`) to
consumers across surfaces: the dock's tabs, ⌘K keyword search scoring, and
view menus. One string, one edit, multiple surfaces.

Two of this app's row vocabularies are involved:

- `MenuItem` in `packages/ui/src/design/patterns/Menu.tsx` takes `hint` and `title`
  as separate props. `MenuToggle` takes `hint` (and populates `title` from
  `disabled` when given a refusal string).
- Older popover rows in `Conversation.tsx` and `Composer.tsx` build the same
  shape by hand: a `title` on the `<button>`, and an `optionHint` element under
  the label only when one is earned.

### The pass of 2026-08-29

Fifteen visible lines went to hover, one became a chip, one became a count, and
one group of three collapsed to a single note. Nothing was deleted — every
sentence remains either as an earned visible hint or on the row's `title`.

The last five rows below were not edited one at a time. They are what the rule
does once it is written down as a predicate (`describesEveryChoice`) that the
renderer applies to every select, in every runtime, on its own.

| Row | Was | Now |
| --- | --- | --- |
| Trajectory · Agents · Activity | three hints | hover — one click there, one click back |
| Open workspace | hint | hover — the label already said it |
| New worktree… (project menu, sidebar) | hint | hover — "worktree" is git's word, not ours |
| History | hint | hover — a destination |
| Refresh models | hint | hover — the label is the sentence |
| Attach images… | hint | hover — a shortcut, not a consequence |
| Reply here with X | hint | hover — the check mark already says it |
| Hand off to X… (×N) | N identical hints | one `MenuNote` over the group |
| Agent taglines (Start with) | hint on the one agent that had one | hover — a line only some rows have is a ragged edge, not a column |
| Runtime tagline (Settings › Runtimes card) | truncated line | hover — a definition of a runtime you already installed; still shown in full in Add a runtime, first run and sign-in |
| HarnessDesk, in the account menu | truncated line | a **Local** chip — earned, but a word, not a sentence; the clause is on `title` and on Settings › Account |
| Two entries of one agent in the desk survey | two identical rows | the second wears the name it was registered under; “Use this agent” stops being a coin toss |
| Auto-compact · Output style · Reasoning effort (Claude Code) | a hint on the one or two rows that had one | hover — the same ragged edge, now caught by the renderer rather than by hand |
| Mode (Codex) | a hint on *Plan* and none on *Default* | hover — likewise |
| Manage models… | hint | hover — the label already said it |
| Collapse all | hint | the count became the row's `value`; the sentence went to hover |
| Model descriptions (Claude Code) | six hints, two of them identical | hover — *Default (recommended)* and *Opus (1M context)* carried the same sentence, so the column could not tell its own rows apart |

What stayed, and why:

| Row | Why it keeps its line |
| --- | --- |
| Remember this conversation | The scope is invisible: it changes *other* conversations. |
| Compact now | Older turns are replaced by a summary, and not put back. |
| Undo the last turn | Files on disk are **not** reverted. The strongest line in the app. |
| New session (other folder) | Silently switches the workspace first. |
| Unavailable agent (Start with) | The failure is a consequence: the label names the state and the visible hint says selecting it shows the fix. |
| Copy path · route endpoints · branch ages | Data, not prose. |
| Move down (at the end) | Drops the project back into automatic order. |
| Model descriptions (Codex) | The labels are codenames, and the six sentences are six. |
| Ask the agent to revert / cherry-pick | Drafts a message; does not do the thing. |
| Open links in Browser pane · Persist sessions | Each says what the *off* state does. |
| Clear browsing data | Names its blast radius: this pane, not your browser. |
| Every disabled row's reason | A tooltip on a disabled control is unreachable. |

## Shapes say what a mark is

Three shapes, and each one means something wherever it appears:

| Shape | What it is | Examples |
| --- | --- | --- |
| Face | Someone: an agent at work, a runtime or a person | A sender in the chat, a member on a team's rail, a board card's holder, a runtime, session or member card, your seat, a name inside a sentence |
| Ring | An account | The seat menu's account marks, an account card |
| Square | A thing or a category | A plugin, a skill, a file, a section |

A face takes its corner from `--hd-face-radius` and never from the tile it sits
in. It is square by default, and a person can make every face round in
Settings › Appearance › Faces (`body[data-hd-faces='round']`). Draw a face with
`IconTile shape="face"` or `Face`, and an agent named inside a sentence with
`MemberName`. A face drawn as a bare `square` tile would be the one face that
ignores the setting. The ring and the square do not move with Faces: an
account was already round, and a thing staying square is how a round face
still reads as someone.

A tinted face is filled with its tint's ink and uses the accent foreground for
its mark or initials. Other tinted tiles, including square and round ones,
keep the soft tint wash.

A new surface cannot draw someone in a fixed corner without a test failing.
`IconTile`, `DetailMark`, `AvatarStack`, `Face`, `AccountMark` and a notice’s
face each declare what they drew with `data-shape` (`face`, `round`, `square`), and two tests read
the result:

- `design/faces.census.test.ts` reads the source of every screen and refuses an
  agent's mark (`BrandMark`, `RuntimeMark`, `AgentIcon`) in an `IconTile` or
  `DetailMark` that is not a `face`, an `AvatarStack` that is not, and a tile
  or detail mark whose shape is decided at run time (its mark may arrive as a prop, so it has to be named). It
  reaches the screens a page cannot mount, such as the Agents panel's rows. A
  tile on its exception list is a claim that it is not someone, or that another
  test pins its shape, with the reason beside it; the entry also counts the tiles
  it excuses, so a second one in the same file is a finding until it is named.
- `e2e/ui-system/faces.spec.ts` ("rule: faces") measures the mounted screens
  under each Faces setting: every declared face computes `--hd-face-radius` and
  is filled solid (a notice's face keeps its tone's translucent wash, and is held
  to the wash its tone paints: not opaque, not faint, not gone), every tile that
  holds an agent's mark is a face, an account's ring or a named exception, and
  each surface it lists (the rail, the chat, a notice, a board holder, the
  Activity rows, a channel, your seat and profile, side by side, an avatar
  stack) is present as a face.

Draw a new face with one of those primitives. If it needs its own markup, it
declares `data-shape="face"` and takes `--hd-face-radius`, and the surface goes
in the spec's list.

## The Team composer tail

Short live activity and a notice about what sending does sit in one tinted
strip above the Team composer. `ComposerTail` (in the notices family, beside
`ComposerNoticeStack`) gives those lines the muted ground, rounded outside
corners, smaller secondary text, and joined edges when both are present. The
conversation composer has queued notices and actionable alerts rather than
this live-and-room-state pair, so it keeps its own notice stack.

## Motion

Motion says where a thing came from and where it went, and nothing else. It is
tokens, like type and space, and `design-audit` counts a time written out in a
transition, an animation or a Tailwind utility (`rawDuration`), so a surface
cannot pick its own clock.

| token | value | what it times |
| --- | --- | --- |
| `--hd-duration-fast` | 100ms | a change the finger caused: a hover, a press, a colour. Tailwind's bare `transition-*` utilities default to it |
| `--hd-duration-enter` | 180ms | something arriving: a menu, a dialog, a fold's body |
| `--hd-duration-exit` | 120ms | the same thing leaving — quicker, because nobody waits to watch a menu close |
| `--hd-duration` / `-slow` | 200 / 300ms | a surface resizing, or crossing the window; rare |
| `--hd-duration-pulse` / `-sweep` / `-cadence` | 1.6s / 1.8s / 1s | the only loops: a live dot, the sweep over words still being written, the stepped working line |

Three curves, one per direction of travel: `--hd-ease` for a state changing in
place, `--hd-ease-out` for an arrival (fast off the mark, settling), and
`--hd-ease-in` for a departure (accelerating away). An arriving surface grows
from `--hd-motion-scale` (0.97) toward its trigger, or rises
`--hd-motion-rise` into place; small on purpose, a hint of direction rather
than a flourish.

Overlays do not choose any of this. `design/ui/motion.ts` holds it once:
`floatingMotion` for anything anchored to a trigger (menus, popovers, selects,
tooltips, hover cards), `modalMotion` and `scrimMotion` for a dialog, and
`revealMotion` for a block that appears in place when something opens, such as
a turn's work fold. They are transitions from Base UI's `data-starting-style`
and `data-ending-style`, never keyframe animations keyed on them: the starting
attribute is gone a frame later and an animation declared on it goes with it,
which is how every menu in the app used to cut in rather than arrive.

`prefers-reduced-motion` takes every duration to an instant in `app.css`; the
tokens need no reduced variant of their own.

## A page: sections and summaries

A page is a head and a column of sections, and a section is a label over one
card. That was always the intent; what the pages had instead was a
`SectionHead`, a free `Note` and a `Rows` card stacked by hand, each with its
own margin and nothing owning the space between them. On the Agent page the
label "Ceiling" sat 18px under the card above it and 20px over its own, so it
named neither, and eight labels each over a card of one row read as a column of
floating grey words.

**`Section` owns the rhythm.** `<Section title description action>` renders
`<section aria-label={title}>`, its label a `GroupLabel`, and spaces itself:

| between | space | why |
| --- | --- | --- |
| the label and its card | 8px (`--hd-space-2`) | the label belongs to the card under it |
| one section and the next | 32px (`--hd-space-8`) | four times the label's gap, so no label is ever nearer the card above it |
| the page head and the first section | 32px | the head's 24px collapses into the section's own margin, so the first gap is every gap |
| things inside one section | 8px | a card's or a note's own margin is dropped; a lone button keeps its width |

The label sits on its card: an action beside it (the `sectionAction` slot, a
small `outline` button) grows the head upward, so every label on a page is the
same 8px above what it names — a `SectionHead`'s too, which used to stand
centred in a 26px box 13px above its card. A screen composing sections writes no margin of
its own. A `SectionHead` on a page keeps the same 32px — including one that
opens a `<section>` wrapper, which used to lose its margin to `:first-child`
and start 6px under the card before it — so a page half converted still reads
as one page. A dialog keeps its tighter step.

**The description is one sentence.** It says what the section is, muted,
directly under the label. A paragraph of how it works is not a description:
Project, Permissions and Triggers each opened every section with two or three
lines of it under the page's own blurb, and the one warning that mattered read
like the four around it.

**Several facts about one thing are one card.** `SummaryList` is the key/value
inspector drawn as a settings card — the `Rows` ground, edge and hairline — with
a key column, a value that wraps as a sentence (`kind="path"` gives up its
middle, `numeric` right-aligns tabular figures), an optional one-line `note`
under the value, and an optional small action at the row's end. Once any row has
an action every row stands as tall as one, so the card keeps one row height;
narrow, each key rises over its value and the action keeps the end. An account's
sign-in, plan, credential and default are one card; so should be an Agent's
file, ceiling, skills, servers and brief.

**A wrapped control lands by what it is.** When a row is too narrow for its
control beside the title, the control drops under it. A compact control — a
switch, a button, a chip, a select, a `RowValue numeric` amount — keeps the
row's end, in a plain `Row`
exactly as in a `RowButton`, whose control travels with a chevron that cannot
leave the end. A text answer (`RowValue`) takes its whole line and starts
where the title starts: pushed to the end, a sentence narrower than the row
began at whatever indent its length left. The row reads which from the
control, so no caller has to remember.

**Groups inside a section are sub-heads.** A `SectionHead` among a `Section`'s
children sits 24px under the card above and 8px over its own — a step between
the 8px of a label and the 32px of a section — so Permissions' twelve runtimes
read as groups of Approvals, and a project's flows as its own, yours and the
built-in ones, each under one label instead of a chip on every row.

**The outline is real.** A page's title and a detail page's title are h1s;
every section label, `Section` or `SectionHead`, is an h2, and a sub-head
inside a `Section` is an h3. A detail head's
owner is either text — a place, a path — that gives way at its end, or a mark
such as a status chip that stays whole while the name wraps.

## The rules

The UI consistency programme (#831) decided nine rules. Each used to be
enforced only by reading, by a unit test of one component, or by an audit
category that counts a declaration in source — none of which fails when a
component edit changes what the browser actually renders. `e2e/ui-system/
rules.spec.ts` asks the running catalogue and `/preview.html`'s real screens
these nine questions directly, in every theme and interface, and mutates the
page under test to prove each check is not vacuous. Where the rendered app
disagreed with a rule, the app was fixed, or the rule was scoped where the
difference is a deliberate interface choice; the sections below say which.

### Names

Every element wearing a name role — `Text role=…` (`design/patterns/
Settings.tsx`) or `PageHead`'s own title — computes one of the pairs the
"Named text roles" table above states: wordmark and page at 20/600, section at
16/600, subject and member at 14/500, row at 13/500, navigation and
muted at 13/400. Section is the one name role at 16px; section, wordmark and
page are the name roles in semibold. A content name uses the member role,
including chat senders and inline roster status names. The dashboard
readouts `Text` also draws (`meta`, `figure`, `metric`, `value`, `prose`) are
not names and sit outside the rule; `figure`/`metric` are deliberately
semibold.

Enforced by `rules.spec.ts` ("rule: names"), reading every `Text` role and
`data-slot="page-title"` across mounted screens against that role's pair. It
also checks every visible h1-h4 and `*-title` slot outside `Text` against the
same pairs, without guessing a role from the tag or slot. A readout is
declared, never read off its text: `ChartTitle`'s `figure` marks itself
`data-figure` and is left to its own role, while a title that merely reads as
a number is still a name. The preview harness marks its own caption with
`data-preview-caption` so it is excluded too. Findings include text, tag,
slot, computed size and weight. A mutation catches an injected 16/500 h3 and
proves the marked caption is ignored.

The small `ListRow` title uses the navigation pair (13/400), including when
selected; selection is shown by the row's fill. Its default title remains the
subject pair (14/500). The title declares which (`data-role`), and the rule
reads it against that pair exactly. The Dashboard's band heads are `section` (16/600),
drawn through `SectionHead`'s heading level (#1122).

The owner's 1A decision on 2026-10-03 keeps list navigation and the Team
rail's member rows at 13/400. The heavier rail variant proposed in #1220 is
not planned; a member named in the rail follows its navigation role.

### Group labels

`GroupLabel`'s computed `text-transform` is never `uppercase`, in every
group-label role — see "One title, one group label" above, where the design
audit's `uppercaseLabel` already refuses the capitals in source. Its weight is
the interface's label weight, `--hd-label-weight`: regular in Desk, and
medium in Studio, which varies only the weight and the air above a rail's
group, on purpose. Size, ink and case are the same in both. Quiet sidebar bands
(Pinned, Projects and Other projects) use muted ink; other group labels keep
secondary ink. `GroupLabel ink="muted"` and `NavigationGroupHeader labelInk="muted"`
carry that choice without changing the label’s inset.

Enforced by `rules.spec.ts` ("rule: group labels"), which asserts the
rendered result in both interfaces and both themes, with a mutation each for
capitals and for a heavier weight.

### Sidebar trailing rail

The trailing rail is inset from the sidebar edge. `--hd-sidebar-end-rail`
places a trailing target’s right edge; `--hd-sidebar-end-column` places its
ink centre. The visible rail is the session dot's right edge, inside that
target; a whole state label ends there, one target left of any adjacent marks.
Sidebar states opt into `Chip variant="quiet"`: the same tone and type, with
no background, border or horizontal padding. The text itself ends on the rail.
A label uses its actual width at rest. Its title consumes the remaining
space, without a faded label or a reservation for hidden actions.

On hover, focus or an open menu, the label folds to a dot and the actions take
the rail. Marks step left by the action count. The title never loses space
in that exchange. Counts beside state labels yield when the row is 200px wide
or narrower; the query measures the row, including a nested row, rather than
the window. A room’s header and its members each own their hover surface.


### Sidebar hierarchy

State stays on its row: a small neutral `Spinner` for a running conversation or
Team, still under reduced motion, and **Needs you** when it waits. No sidebar row
uses a Working label. Pinned is one plain section for loose conversations, whose
leading marks and titles take the same indent step as a project’s children. Every active
Team is one row in its project with its Seats collapsed initially; Seats stay
under their Team through running, waiting and pinning. Wrapped Teams live on the
Teams page. Project children and Team Seats each take one shared nested-rail
step, using `SidebarGroupContent nested` for leading content and
`SidebarMenu nested` for the existing Seat list. Pinned keeps its heading,
separator and row boxes; project children keep their full row boxes. Only the Seat list draws a
vertical guide.
Project headers have no folder icon: their names use regular 14px secondary ink,
one tier above the muted section labels. Hover or keyboard focus reveals a fold
chevron immediately after the name and the two end actions. Folding leaves only
the header. Indentation moves the leading content alone; every trailing target
keeps the enclosing rail, including Seats two steps in. A Seat row at 200px or
narrower folds Needs you to its compact mark, preserving a readable title.
The sidebar catalogue and `preview.html?sidebar-structure` mount the same
production tree with three projects, three Seats, loose conversations and Pinned.

### Destination rows

A navigation row is at least `--hd-nav-h` tall wherever it appears, and
every row of one kind stands at one height. There are three kinds:

- the sidebar's session row (`components/SessionTree.tsx`);
- the settings and usage rail row (`AppWindow.tsx`'s `WindowNavItem` and `WindowNavIdentity`);
- a dropdown menu item (`design/ui/dropdown-menu.tsx`).

All three are `Button size="navigation"` or the menu's own row, floored at
`--hd-nav-h`.

The kinds also agree with each other, in both interfaces. In Studio
`--hd-nav-h` is a literal 34px. In Desk it is solved from the row's real
box — its 20px line, 4+4px block padding and 1+1px border — to 30px, so the
settings and usage rail rows stand with the sidebar's rows and a menu item
rather than a pixel under them on a floor solved from the type alone
(#1073).

This is a claim about one-line rows. The session list's comfortable density
gives a session a second line and more air — a preview under a working row,
a chip where one needs you — so those rows are taller than a rail row by
design and can differ from each other with what they carry. They are still
floored at `--hd-nav-h`. The rule is measured at the compact density the
preview uses.

The settings rail's identity row was the one row out of step with its own
kind. Its 28px face in what was then a 29px row with 1px borders pushed it to 30px. It
now draws the seat's 24px face, the size the sidebar's seat row uses.

Enforced by `rules.spec.ts` ("rule: destination rows"), on every visible row
of every kind, in both themes and interfaces. Mutations cover a row shrunk
under the floor and one row taller than its siblings.

### Fields

A default-size text field (`Input`, and `Search`'s inner input) is 30px tall
at 14px — matching the programme's own number — **including** inside
`[data-hd-density="comfortable"]` (the settings and usage windows) under
Desk: the universal `[data-hd-density="comfortable"]` block only restates
`--hd-control-h` ("Controls and buttons" above), never `--hd-btn-h` or
`--hd-field-h`. `design/foundation/tokens.css`'s own comment records the regression
that happens when it does — every labelled control in the settings and
usage windows quietly dropped to 26px, because a derived token like
`--hd-field-h: var(--hd-btn-h)` freezes to a number where it is declared,
so restating `--hd-btn-h` in the wrong scope silently moved every consumer
that had already frozen a copy of it. Only inside
`body[data-hd-interface="studio"] [data-hd-density="comfortable"]` does
`--hd-field-h` become `--hd-control-h-lg`, 36px — a second, intentional
density rung, not a second field system, checked as its own number rather
than excluded. `Search`'s `compact` size (the sidebar's own filter) is a
third, deliberate rung of the same pattern — 24px tall, at the same 14px —
not a second Search: every filter field in the app renders through the one
`Search` component.

Enforced by `rules.spec.ts` ("rule: fields"), which asserts 30px/14px
everywhere except Studio's comfortable scope, 36px/14px inside it, that the
compact and default rungs agree on font size, and that every input whose
placeholder reads as a filter sits under `[data-slot="search"]`.

### Selection

A chosen row keeps its resting neighbour's weight and gains a fill the
neighbour lacks — never the other way round; see "Weight" above ("Selection
is marked by a filled pill and a check, never by making one row heavier than
its neighbours"). `visual-contracts.spec.ts`'s "every chosen row, destination
and option is filled, and none changes weight" test already proves this,
pairwise, on the `view=propagation` catalogue rig. `rules.spec.ts` ("rule:
selection") does not repeat that comparison; it wraps the identical read in
a checker function and mutates the page (`page.addStyleTag`, removing a
chosen row's fill) to prove the check is not vacuous, which the existing
spec does not do. A second check reads two real destinations `/preview.html`
selects by default — the sidebar's active session row and the settings
rail's current page — against an unselected sibling of the same kind, in
every theme and interface: the catalogue rig proves the contract in the
abstract, this proves it on the app.

### Tertiary ink

The tertiary label tier clears 4.5:1, rendered, on the page, card, plate,
popover and sidebar grounds — the same bar "Ink levels" above sets, and the
same three-tier separation that section measures at the token level.
`tokens.contrast.test.ts` covers the tokens on `--hd-background`, `--hd-card`,
`--hd-sidebar` and `--hd-popover`; `rules.spec.ts` ("rule: tertiary ink")
mounts a real `Text role="meta"` on each real ground — the real `Card`
component for the card ground, and, since a plate has no bare ground of its
own to mount into any more than a popover or the sidebar do, the raw
`--hd-card-fill` token applied directly for the plate — and measures what
the browser actually composites, including the plate ground
`tokens.contrast.test.ts` does not cover. Holds today, measured in every
theme and interface, and the checker now asserts all five grounds were
actually read: an earlier version of the walk started at the ground
container and climbed *up* looking for a background, which finds the page's
own ground behind the card rather than the card's, since the card's painted
background is a child of that container, not an ancestor of it — a bug that
had the card ground silently reporting the page's contrast as its own.

### Focus ring

Keyboard focus marks the control, and no wrapper repeats the indicator.
A button uses the document outline: 2px solid with 2px clearance at Desk,
3px solid with no clearance at Studio (`--hd-ring-width` and
`--hd-ring-offset`). Pointer focus stays quiet, including focus returned
from a menu or dialog; Escape preserves that input mode, while Tab, list
navigation and keyboard activation enable the keyboard indicator.

A field locates its caret with a border in `--hd-ring`, for pointer and
keyboard use, without an offset outline or added shadow. Its normal
`--hd-input-shadow` elevation stays in place. The command palette's only,
always-focused field uses its caret alone. The composer's own
`--hd-composer-ring` remains a separate contract.

`surface-focus.spec.ts` proves that popup surfaces draw no ring of their
own. `rules.spec.ts` ("rule: focus ring") checks the button outline and
field border against their resting states on a fixture nested two wrappers
deep. Positive controls remove the field's focus border and add a wrapper's
`:focus-within` outline, proving both a missing cue and a repeated cue are
caught. `focus-ring.spec.ts` checks pointer and keyboard paths through the
sidebar, menus, dialogs and palette, and fields in both themes and interfaces.

### Monospace

Only a code-role element computes the monospace family — see "The code face"
above. `rules.spec.ts` ("rule: monospace") scopes the rendered check to
`[data-slot="text"][data-role]`, the closed set every name and label in the
app passes through, rather than the whole DOM: a DOM-wide scan would have to
know every legitimate monospace surface (a terminal's screen buffer, a
diff's line numbers) to avoid false positives, where the named-role set is
exhaustive by construction. A positive control on the code catalogue
(`view=code`) confirms real code elements do compute the family, so the
probe is proven meaningful. Holds today.

### Health takes no tone

A reading that says nothing is wrong is not painted the success colour —
`Chip`'s own doc comment already says this ("A default or normal state is
`neutral` or has no chip at all… Colour on every row is noise that hides the
one row that needs someone"); this rule extends it to `Progress` and `Text`
readings generally. `rules.spec.ts` ("rule: health takes no tone") looks for
the app's own words for a resting, nothing-to-report state — "Healthy",
"Armed", "On", "Loaded" — rendered in the resolved `--hd-success-ink`, or
sitting on a fill of `--hd-success-dim`/`--hd-success`. A verdict or a
recorded fact — "Open", "Merged", "Passed", a `+120` diff count — is not
this rule's target and was left out of the word list on purpose: those name
what happened, not a normal condition that persists until something changes.

Widening past "Healthy" alone found three more, all fixed the same way —
the resting half of a pair goes untoned, the half that means something is
wrong keeps its own:

- `lib/provenance.ts`'s `captureWords`: a healthy capture read "Healthy" in
  the success tone.
- `components/ProjectTriggers.tsx`'s former "Armed" chip read in the
  success tone; the switch now carries Off and Armed, while Changed, Refused
  and Paused retain their exceptional-state chips.
- `components/SkillSheet.tsx`'s runtime-reach row: a skill a runtime reaches
  read "On" in the success tone; "Off" already had none.
- `components/SeatAttachments.tsx`: a loaded attachment read "Loaded" in the
  success tone; "Not loaded" keeps its warning, which is a verdict rather
  than a resting state.

Budget meters follow the same rule (#1061): plenty left is the untoned resting
state, a low budget is warning, and a spent budget is danger. The AgentCard
catalogue shows all three states, and the rule spec checks that a plenty-left
meter remains neutral and does not compute the success colour.

## Adding to the app

When adding a control, row or surface to HarnessDesk:

- Chrome is 13px and what is read is 14px. A row, a menu item, a settings line
  and a button label are furniture; the transcript, the composer and an input
  are not. Reach for the side you are on and justify anything else.
- Never add a step. There are seven and each names one thing; a new one is
  either a step you already have or a sign that the thing wants less prominence
  rather than less type — in which case change its ink.
- Never pick a size without its line. Every step names its pair; take the next
  line up when the text wraps, and never a tighter one. A size set on somebody
  else's line is how the 13px step came to have eight of them.
- Set an explicit `line-height` only when the row's height depends on it.
- The code face marks a face, never a size. `.mono` sets `font-family` and
  nothing else, so a row whose title happens to be an identifier stays the size
  of the rows around it.
- Table, list and settings faces centre on the whole row. Other icon leads
  belong on the first text line, not centred against
  the title *and* its description.
- A single line is centred in its container. In a notice row, text, lead, action
  and dismiss share one centre; when copy wraps, the lead moves to its first
  line while the action stays centred on the row. A banner's dismiss follows
  the lead onto the first line, the layout rule for every trailing control
  (`edge-alignment.spec.ts` holds it). Measure text by its
  cap-height glyph box. The font's own ascent/descent asymmetry (about 1px at
  13px) is a separate, pending correction. Trailing notice buttons use
  `edge="end"` so the glyph, not the hit target, lands on the surface edge.
  Above a composer that edge is the toolbar's trailing inset, shared with Send.
  A window-corner header is measured from its ordinary inset edge after
  subtracting only the extra padding spent on native window controls; an
  additional offset still counts as an alignment finding. The body reference
  follows input and navigation labels before status chips, and compares a
  nested approval code box at its own outer edge. A plain dock label shares Search's leading
  glyph column; a tab with a mark shares the input's text column.
- Write the label so the second line is not needed. A verb and its object beat a
  verb and a paragraph.
- Default to no second line. Add one only when you can name which of the three
  tests it passes; if naming it takes a moment, it fails.
- Put the sentence in `title` rather than dropping it. It costs nothing there,
  and ⌘K may want it as keywords.
- Write a group's sentence once, as a `MenuNote` over the group.
- Count before you ship: a menu where every row has a hint has no hints. If a
  new row's line makes that true, the problem is the rows above it, not the row
  you are adding.
- Check both themes before calling it done: the greys are where a light-mode
  design usually breaks. Watch for opaque hover fills in particular — the
  platform's solid hover equals the raised-control fill in dark mode, so a hover
  painted with it does nothing at night.

### Where a change belongs

One place per kind of change. If a change needs two of these rows, it is two
changes.

| change | canonical source |
| --- | --- |
| Every button and icon-button contract | `packages/ui/src/design/ui/button.tsx` |
| Every Settings row/group/page contract | `packages/ui/src/design/patterns/Settings.tsx` and its CSS module |
| All density, spacing, typography, radius, focus, and semantic colours | `packages/ui/src/design/foundation/tokens.css` |
| Generic dialog mechanics and focus/portal behaviour | `packages/ui/src/design/ui/dialog.tsx` |
| Modal, confirmation, approval and lightbox policy | `packages/ui/src/design/patterns/ModalDialog.tsx`, `ConfirmDialog.tsx`, `ApprovalDialog.tsx` and `Lightbox.tsx` |
| A dialog's form rhythm, legend and choice list | `packages/ui/src/design/patterns/DialogForm.tsx` and its CSS module |
| Disabled or refused actions and their focusable explanation | `packages/ui/src/design/patterns/RefusedAction.tsx` |
| Menus and popovers | `packages/ui/src/design/patterns/Menu.tsx` and `Popover.tsx`, over `design/ui` |
| CodeMirror and xterm theme integration | `packages/ui/src/design/adapters/` |
| Public imports | `packages/ui/src/design/index.ts` |
| The live component catalogue | `packages/ui/src/design/catalog/` and `packages/ui/src/design/explorer/` |

| The stacking order, and which shadow a surface wears | the `--hd-z-*` and `--hd-shadow-*` ladders in `tokens.css` |
| Mounting a shipped screen outside the app | `packages/ui/src/preview/harness.tsx`, used by both `/preview.html` and the catalogue's surfaces |

### The catalogue shows the screen, not a picture of it

`pnpm design` serves `/design.html`. Foundation, primitives and patterns render
from the production modules, and so do the whole-screen surfaces: Conversation,
Composer, Left bar, Git history, Group project, Browser · Terminal · Editor and
Panels mount the shipped screens — `components/*`, and `panels/Workbench.tsx`
— through `preview/harness.tsx`, the same store stub `/preview.html` uses.

This is a rule rather than an arrangement, because the alternative was tried.
Those surfaces used to be pages in `design/showcase` built to look like the
screen — over 1,500 lines of CSS that shared nothing with the app but its shape.
They were right on the day each was drawn and wrong every day after, and there
was no way to tell by looking: the catalogue is exactly where you go *because*
you do not already know what the screen looks like. Edit
`components/Sidebar.module.css` now and the Left bar surface moves with it,
because it is that sidebar.

`script/check-ui-system.mjs` keeps it true. Every surface row in
`design/catalog/manifest.ts` names the module it mounts and the one export in
`design/surfaces/surfaces.tsx` that mounts it, and the check holds three things:
that export reaches the module, the explorer tab for the row loads that exact
export, and the app ships the module. The walk starts at the export, not the
file — from the file, a surface that stopped mounting its screen passed on a
sibling that mounts the same one. So a row naming something the app does not
ship fails, a surface that quietly stops mounting what it claims fails, and
two tabs that swap their screens fail.

One surface is marked `catalogOnly`: Foundation propagation, a test rig built
only from production implementations, which two browser specs drive. There is
no shipped screen for it to point at, and its description says it is a rig.

A real screen with no data does not fail — it renders something plausible. The
git pane mounted with no repository drew an empty frame; the editor sat on
"Loading…" for good. So the harness answers what the mounted screens read
(`preview/git-fixture.ts`, typed as the protocol's result types), and each
surface's description says what the tab shows *on this fixture* and names what
it does not. A description written for a richer picture than the tab renders is
the same misleading a drawing was, in words. The only check that has caught
these is opening every tab in a browser.

### What the engine checks

Some of the rules here are about the words a screen happens to hold, not
about a declaration, and the audit cannot read them from source.
`e2e/ui-system/taste.spec.ts` lays out every frame of the preview harness and
a confirm from the catalogue, and fails on four of them:

- **A sentence cut off by an ellipsis.** Names and paths truncate; sentences
  wrap. A `Row`'s description wraps by default, and `truncateDesc` is the
  opt-in for one that is a name or a path.
- **A page, section or dialog title that wraps** at 1440px.
- **A one-word last line** in a description, a blurb or a message. A
  confirm's body is left to the engine's own breaks, by decision. `app.css` sets `text-wrap: pretty` on everything read as a
  sentence and `balance` on titles, so this should not need a hand.
- **A second line every row of a group repeats**, which belongs to the group
  as one note.

`pnpm test:ui-system -- alignment-census.spec.ts` also measures three rendered
alignment rules across every preview frame and design explorer board: table,
list and settings leads against the whole row centre, other icon leads against
their first text line, trailing icon actions against a surface's text
column, and card headings against their body. Its checked-in table records a
multiplicity for each stable signature; frame and board headings are diagnostic
labels only. When a change fixes a recorded instance, re-record with
`pnpm design:alignment`. A signature's count may fall, but it may not rise; the
table is a ceiling that only shrinks. Because the spec reads the table it is
graded against, `script/check-alignment-census.mjs` (in `pnpm verify` and CI)
compares the committed table with the one at the branch's merge base and
refuses a new or risen signature: a re-record is for a fall, and a part that
renders a new misalignment is fixed in the part.

### What the audit refuses

`pnpm design:audit --strict` holds every category at zero, except three
burn-down ceilings that may only fall: `patternClass`, `uppercaseLabel` and
`singleAreaPrimitive` (the first two are already at zero). `screenAppearance`
— appearance a screen draws for itself instead of composing it, in whichever
of three spellings it chose — is a hard zero since #838. It began at 895. The
Git pane's three own declarations are named exemptions, each with its reason,
rather than a ceiling of three (see below).

Every ordinary property has to match one of two explicit tables after its
vendor prefix is stripped, wherever it is spelled. `APPEARANCE_PROPERTIES`
owns type, ink and ground, edges and the inner box; its open-ended families
match by prefix, so `font-variant-numeric`, `background-image`,
`border-image-source` and the next standards longhand do not slip past a
remembered list. `LAYOUT_BEHAVIOUR_PROPERTIES` owns geometry, flow,
interaction and motion. Height, minimum height and maximum height share one
value rule: a non-zero fixed or token metric counts as appearance, while zero
— the flex/grid shrink reset — percentages, intrinsic sizes and viewport or
container-query shares remain layout. Custom properties define values rather
than either side and remain outside the split. In a stylesheet, anything else
is a `screenUnclassified` finding that names the property and sheet and fails
the strict gate.

`screenAppearance` is the appearance side of that total boundary, read in
three spellings rather than one: a screen's own `.module.css`; a Tailwind
utility in a `className` (or a `className:` key in an object literal, or a
bare `cn`/`clsx`/`cx` call), resolved through a variant prefix, the important
marker, a template literal, a ternary, an array joined with `.join(' ')`, or
one hop through a named import to the `const` that actually declares it —
`LibraryActions.tsx`'s `SWITCH_TRACK`, imported by `Library.tsx` too, counts
once, at its definition, not once per file that reaches for it; and a key in
an inline `style` object, including a `{ color }` shorthand, a `['color']`
computed key, and a `satisfies CSSProperties` assertion, both branches of a
conditional read. A class name cannot say whether `.head` is a title bar, a
table header or a card heading, which is why `patternClass` could safely keep
only `empty`; the declaration says what the screen actually owns. Markdown's
prose ratio ladder and the diff viewer remain named specialized-renderer
exemptions, in both the stylesheet and the `.tsx` that renders each.

Two single declarations are exempt by name, in
`SCREEN_APPEARANCE_DECLARATION_EXEMPTIONS`. Each is `GitPane.module.css`'s own:

- the commit table header's end inset, which is the rows' own, so the columns line up;
- the opened commit's floor (`--hd-history-detail-min-h`).

Each has no second screen to share a part with, so a part made for it would
be a one-screen part. The exemption is the exact declaration: sheet, selector,
property and value. A new appearance declaration in that sheet is a finding,
and so is one of these three taking another value. A named exemption that
matches nothing is a finding of its own, so the list cannot outlive what it
names.

The same boundary reaches into `design/patterns/` — typed, product-specific
composition contracts — but not into `design/ui/`, the shadcn-registry
primitive layer. A pattern export whose every screen consumer sits in one
screen area — one file, or a named multi-file family such as Git or the
conversation transcript — is that screen's own appearance parked in the
design folder rather than composed, so its CSS-module rules, its own
Tailwind utilities and its own inline styles are charged to
`screenAppearance` the same way a screen's are; an export two or more areas
reach for stays uncharged, because moving it would break whichever area lost
it. Consumers are resolved per exported name, not per file: one export used
everywhere does not make a single-area sibling in the same module look
shared, and a re-export — `export *`, a renamed named export, or a shim
entirely outside `design/` forwarding a name back out — is followed to
wherever the name is actually declared before its consumers are counted. A
part imported by *another design part* inherits that part's own resolved
reach, cycles guarded, rather than stopping at the design file that happens
to import it directly — `RailSection` has one direct screen importer
(Sidebar.tsx), but `AppWindow.tsx` also composes it into `AppWindowRailTop`
and `AppWindowRailScroll`, which the app's shared window shell mounts for
Settings, the Agents window and more, so `RailSection` reads as several areas
rather than Sidebar's alone. A CSS-module class is charged to a single-area
export only when nothing else in the module — another export, or a local
helper neither exports — also reaches for it: `Settings.tsx`'s `RowMark`
alone draws `.rowMark`, but `Row` and `RowButton` in the same file draw it
too, and those are used everywhere, so that class stays uncharged even
though `RowMark` itself is genuinely SignIn's alone.

Screen areas are not asserted by hand — a handful of named roots
(Conversation, Settings, TeamRoomPane/TeamBoardPane, AgentsWindow, GitPane,
Workbench) seed the closure, and every other screen file's area is the
closure of single-host files: a screen imported by only one already-resolved
family belongs to it too, iterated to a fixed point. `pnpm design:audit`'s
own test suite holds this to an invariant — a single-host screen file that
sits outside its host's family fails the gate — the same way every other
category here is held to a check that has been made to fail once, not only
to pass.

`design/ui/`'s primitives — the chart kit, `Board`, `ToolPane`, `Card`,
`Bar`, `KeyValue`, `Spark`, `Dialog`, `Breadcrumb`, `Delta` and the rest — are
never charged to `screenAppearance` even when every screen that reaches for
one sits in a single area today: a primitive is meant to exist before it has
grown a second caller, the way a design system's own vocabulary always does,
and charging one under `screenAppearance` for that would make that strict
zero unreachable without inventing a pointless second caller. That does not
make it nothing, though: `singleAreaPrimitive` is a burn-down ceiling of its
own, so a single-area primitive is still held to "may only fall," and moving
a genuine screen composition into `design/ui/` to dodge the
`screenAppearance` charge just raises this one instead — it never zeroes the
move out. `pnpm design:audit --verbose` lists each one by name.
The named data-geometry and native-boundary exceptions are listed in `SINGLE_AREA_PRIMITIVE_EXEMPTIONS`
and remain exempt only while each export stays single to its recorded area.

Both ledgers count *exports*, not declarations, which prices a move unevenly
on purpose: `screenAppearance` charges every appearance-side declaration a
single-area pattern's exports draw (a large composition can cost dozens),
while `singleAreaPrimitive` charges one line per single-area export
regardless of how much it draws (`ChannelMessage.tsx`'s ninety-nine
declarations would cost `design/ui/` all of seven — one per export). A move
that looks cheap by this count is not a loophole: the ceiling still moves,
`--strict` still fails until it is re-recorded, and a reviewer reading
`--verbose`'s named list sees exactly which export moved and can still ask
whether it belongs there.

The workbench dock is the one deliberate exception to all of this: there is
exactly one workbench, by design, so `panels/Workbench.tsx`'s thirteen own
`design/patterns/DockPanel.tsx` exports (`WorkbenchRail`, `DockPanel`, and
the rest of the dock chrome) are a named, documented exemption, the same way
Markdown's prose ladder and the diff viewer's own ink are — a second consumer
to compose them generically for is never coming, so charging them asks for a
fix with no destination. `RailSection`, DockPanel.tsx's other export, needs
no such exemption: it is not single-area at all, for the reason above.

Three of those categories spent a long time reporting zero while they were
simply unable to see:

- `screenAppearance` read only a screen's `.module.css`, so moving a
  declaration into a Tailwind utility string or an inline `style` object —
  exactly what the rest of the app had been doing — made it disappear from a
  count that said it was clean. Reading a `className`'s literal text closed
  most of that gap, but not all of it on the first pass: a plain string
  constant, a ternary, an array joined with `.join(' ')`, and a `className`
  written as an object key rather than a JSX attribute were all still
  invisible, because none of them are literal text at the class site itself —
  they are a name that only leads to one through its own `const`. A second
  pass found a fifth miss going the other way: an unknown (non-literal)
  `height` value was defaulting to a metric it could not actually read, an
  over-count now decided explicitly as layout instead of assumed.

- `rawColour` named five properties and `box-shadow` was not one of them, so ten
  hand-written shadows sat outside a count that said there were none. It now
  reads every declaration, whatever its property, through a scanner that reads
  CSS the way the browser does — strings, comments, `url()` and escapes: a `;`,
  a `/*` or a `)` inside a string ends nothing, `r\65 d` is `red` and `c\6f lor`
  is `color`, and a URL's payload is never read as a colour; and it counts
  a colour however it is spelled — hex, a colour function, or a name like
  `red`. The exemptions are named rather than left out: masks, which read
  alpha, and — for colour names only — the properties whose values are names
  an author chose (`animation-name`, `grid-area`, counters, font families).
- `rawZIndex` did not exist. The ladder in `tokens.css` had said in prose since
  it was written that stacking "never writes a number", and twenty-four places
  wrote a number. Single digits are ordering inside one component's own stacking
  context and are not counted; from 10 up is the band two components can
  genuinely collide in, and that is what the ladder is for. A number counts
  however it is written — any CSS math function, escaped or not (`calc(5 + 5)`,
  `abs(-12)`, `round(up, 10.1, 1)`), read with CSS's own tokens, so
  `calc(5 +5)` is no number at all — or anything a `var()` in the value can
  come to: a custom property's value, its fallback wherever the property can
  be unset or invalid, an `@property` initial value, what a registered value
  computes to. A rung may be named, chosen between (`min()`, `max()`,
  `clamp()`, or `calc()` and parentheses around one), or nudged by a whole
  number from 0 to 9 — `calc(var(--hd-z-sticky) + 1)`, the app's one such
  case, moves with the ladder — and anything else done to a rung (`+ 60`,
  `* 2`, `abs()`, `+ 9.9`) writes a plane of its own, and counts.

  Which rules reach an element is the page's business, so the audit does not
  guess. A property set for the same elements — the same selector under the
  same conditions, a broader one outside any style rule (`.a` for
  `.a:hover`), a rule it sits in through `&` or conditions only — is what the
  rules here set it to. One set
  on an element it descends from — a rule it is nested in through `& .b`, the
  element of a pseudo-element, an unconditional `:root`, `html` or `*` — is
  inherited from there when the property inherits. Any other may be
  inherited from anywhere, set by another stylesheet, or not set at all. A
  declaration the browser drops sets nothing, and a cycle is invalid in
  whichever order the browser meets it. Where the audit cannot tell — a rule
  under a condition, a selector list it does not wholly cover, a registration
  it cannot prove, a registered value this stylesheet animates or
  transitions, `if()` or `attr()`, a chain deeper than it follows — it keeps
  every possibility, and reports what it cannot compute rather than assume
  it small.

- The single-consumer half of `screenAppearance` could not see four shapes of
  its own use. `export *` — `design/ui`, `InspectorPanel`, `DockPanel` — hid
  every part behind it entirely, because only a named `export { X } from 'y'`
  was read. Only the Git surface was a named multi-file screen area, so the
  conversation transcript's own files (Items, TurnWork, StepGroup, TurnFiles,
  Trajectory, ConversationMap) read as four separate areas and a part spread
  across any two of them looked cross-area. A module's exports were resolved
  as one merged list of consumers rather than one list per export, so a
  widely used export made a genuinely single-area sibling in the same file
  look shared too. And a re-export shim entirely outside `design/`
  (`components/Panel.tsx`, forwarding `GroupLine` and `PanelRow` back out
  from `'../design'`) traced no consumer to `design/` at all. Following
  `export *` and a shim however many hops deep, naming the conversation,
  settings, agent-roster and room families, and resolving consumers per
  export rather than per module closed all four.

  The first pass over-corrected in two ways review caught before merge:
  charging `design/ui/`'s primitives the same way as a `design/patterns/`
  composition would have made the strict zero unreachable the moment any
  generic primitive picked up a first caller, and stopping consumer
  resolution at the nearest design file — rather than following it into
  whatever *that* file's own exports reach — read `RailSection` as
  Sidebar's alone when `AppWindow.tsx` also composes it into parts the
  app's shared window shell mounts for Settings and the Agents window too.
  Restricting the charge to `design/patterns/` and resolving through
  design-to-design use, cycles guarded, closed both; the baseline rose from
  480 to 607.

  A second review round found the closure itself still asserted by hand
  rather than derived, and a false positive in what it charged. Screen
  families are now the closure of single-host files (above), which corrected
  two wrong assumptions the hand-written version made: Trajectory's real host
  is Details.tsx, not Conversation, and Branch/Changes/NewWorktree were never
  Git's — each is reached from a different, unhosted screen or from
  `app/App.tsx`, which is not a screen source at all. A type-only import
  (`import type`, `{ type X }`) is skipped in both the screen host graph and
  `designImportsOf`: `CommandPalette.tsx` and `Sidebar.tsx` both `import type
  { Section } from './Settings'`, and counting that as importing Settings.tsx
  made a pattern used only by Settings.tsx read as shared with either of
  them. And a stylesheet class is now charged to a single-area export only
  when no other declaration in the module also reaches for it — `RowMark`
  alone draws `.rowMark`, but `Row` and `RowButton` in the same module do
  too, and those are used everywhere; the six `Settings.module.css [settings]`
  findings the first pass reported were entirely that false positive.
  `design/ui/` gained its own ceiling (`singleAreaPrimitive`) rather than
  only ever being watched, design-to-design reach was widened to `export
  function` composers, local helpers, namespace and dynamic imports, and the
  workbench dock's own chrome (thirteen `DockPanel.tsx` exports
  `panels/Workbench.tsx` alone uses) became a named exemption rather than a
  charge with nowhere to be composed to. `screenAppearance` settled at 820
  (607 plus Settings.tsx's newly-correct `settings`-area exports, minus the
  workbench exemption and the false-positive class charge; #924 has since
  removed `AccessHeader`, one of the SignIn-area exports this rule counts).

  A third review round found two more false positives, both from consumer
  resolution stopping one hop too early. `panels/builtins.tsx` (the pane
  registry) was skipped entirely as an importer, which correctly kept a
  bare registry mount (GitPane, mounted nowhere else) from reading as
  cross-area — but it also hid that `Approvals.tsx` is drawn in the
  registry's own session view beside Conversation *and* docked by
  TeamRoomPane, two different places, so it wrongly folded into `room`
  (`ApprovalDialog.module.css [room]`, 48 findings). And composition within
  one file was never followed at all: `Dialog` composes `DialogBody` and
  `DialogSubhead` in the same `ModalDialog.tsx`, with no import needed, so
  their reach read as SkillSheet.tsx's alone instead of the ~46 screens
  `Dialog` itself reaches (`ModalDialog.module.css [settings]`, 9 findings).
  A registry or `app/` mount now counts as its own host area, but only
  alongside a real screen import, and a same-module composer's own reach is
  now followed the same way a cross-file one already was. Family resolution
  also moved from a DFS with a visiting set — which memoized a partial,
  order-dependent result the moment it hit a cycle — to a monotone fixed
  point, so the answer no longer depends on which file is visited first.
  `screenAppearance` settled at 656 after also merging main past #920
  (Agents and Goals brought onto shared design parts, which changed several
  unrelated screen-appearance findings of its own).
- From 656 the count fell by composition, never by moving declarations:
  - the three families: column inset, message rhythm and status dot (#1016);
  - the image cap, the loading row, the rename box and the ticking digits (#1046);
  - many smaller conversions in between.

  At 3, all of them the Git pane's own, the owner chose named exemptions over
  a ceiling, and `screenAppearance` left the burn-down set: a hard zero (#838).

All four have the same shape as the line-height ratios before them: name the
spellings you happen to remember, and everything else is invisible —
confidently, at zero. When adding a rule, the question is not "does this catch
the case I am thinking of" but "what spelling of this would it miss".

A new category is only worth having if it can fail. Add it, then put the defect
back and watch it go red; a check that has never been seen red is a check that
has never been tested.

## The Team overview

Overview is the first destination on a Team's rail. A Team with a Run opens
there; one without a Run opens on Chat. The Run's current round and recorded
usage lead, followed by what needs the person and the Seats in attention order:
Needs you, Unread, Working, then Idle. Each Seat carries its face, role, card,
round, doing line, time in state and cost in the unit its account meters.
Unavailable usage stays a dash. Idle and Done use quiet text with no chip or
health colour; done Seats fold beneath the active rows and return when they
need attention. At a narrow pane width each Seat becomes one ListRow, with its
state beside its name and cost at the end. The rail, Overview and sidebar use
one conversation-keyed membership list, including Seats a Flow opened and
conversations whose process is no longer held.

The Run strip uses the Team chat's live line, including a kept answer's way
on and a pending release. A Seat's face centres on the whole row, or its first cell including the name
and role.

Attention summaries use ListRow's wrapping sentence slot, so questions and
approval reasons arrive whole even in a narrow pane. Recorded usage is read
when Overview is selected, on card completion while it is shown, and each
minute of a running Run while it stays selected.

### Answering what needs you

A Needs-you row carries the way to answer it, in the row's own `meta` slot, so
its sentence stays whole above the controls at every width. The seat that asks
is named beside the kind chip.

- **A request for approval** offers the agent's own choices in the docked
  card's order and words (refusals first, the plain yes last), with only the
  plain yes filled and a grant that outlives the answer quiet. What is being
  approved is shown with it: the command whole in the code face, wrapped and
  never cut, the files a change touches, the folders and hosts an access would
  open (a long list names its first six and how many more, and the whole list
  is one hover away), and the reason the runtime gave. A yes is never given
  blind. An approval that offers no choice here leaves to its conversation. The
  answer is the call the docked card makes, so whichever door answers first
  wins and the other row goes with it.
- **A question** with one single-choice question offers each option and Cancel.
  A question that needs a form (several questions, a multiple choice, a free
  answer) and a tool's request for information leave to their conversation,
  and offer only Cancel here, beside **Answer in the conversation**, the one
  filled act.
- **A person's step** is answered with the words its role declares, one button
  each, an optional note the next step reads, and one sentence saying what
  each answer does, read from the Run's own frozen Flow. A word no rule follows
  says the Run ends without a next step; a role no rule starts from says it
  finishes the Run. A role that declares no words is marked done, as the board
  does. A review step records the attempt it answers for, which only the
  board's picker does, so its row says **Pick an attempt on the board** and
  opens it.
- **A refusal** stays on screen, in the danger alert under the controls, with
  the answer it refused disabled and the others open: the host does not yet say
  beforehand what it will take. The same controls stand in the Run inspector's
  step.

The `team-overview` catalogue board draws each of these on the production row:
a command, an access request, a step, a question, a form, a review step, a
refused answer and a narrow pane, in both themes.

### The Run timeline

The Run view composes `PaneColumn`, `ListRows`, `ListRow`, `Text` and `Chip`.
Selection uses the same filled row as an inspector, with no navigation colour.
Round headings group the oldest-first story; outcomes stay neutral unless the
host names that outcome as the reason no step follows. Done and waiting are
quiet text. Wrapped record titles centre their lead on the whole row. Sentences wrap at
narrow widths, while the brief previews two lines.
A check that has run more than once draws each recorded result under its row,
oldest first, as plain lines in the check row's own words (Passed, Failed, Timed
out, Did not finish, or the Flow's own word). *Run again…* is a quiet link at the
row's trailing slot, centred on the whole row. The row stays keyboard-selectable
without nesting its retry button inside another button, so both controls keep
their own action. It appears only where the Run and the check
allow it; a refused row shows nothing, so one sentence is not repeated down every
check row of an ended Run, and the inspector is where the reason is read.
The `run-view` catalogue board mounts the production component for every Run
state, a check with two attempts, empty and failed reads, a long timeline, and
the narrow pane. The header's `Segmented` switch offers the Flow beside the
timeline; the Flow drawing below is its other half.

### The Run inspector

A selected timeline row opens recorded detail in `PanelFrame`, `PanelTools`
and `PanelBody`, with the same section labels as other inspectors. Cards show
Input, Handoff, Findings, Review and recorded Seat cost; Open the conversation
is last. A check shows its command, recorded folder, timeout, exit mapping and
latest evidence output. A person’s step shows its sentence and declared
outcomes as text. Run details keeps the full brief, frozen Flow revision and
base, Seats, origin and recorded budgets. Missing facts say so.
Input handoffs follow the card's recorded dependencies. Card and person detail
keeps the authored sentence without the host's appended tool instructions,
however many blank lines a `|` block sentence leaves before them, and keeps the
sentence's own line breaks as written.
The round budget includes authorized extra rounds and their recorded reason.
A Run that recorded no budget says its limit was not recorded: the Flow's own
or the default budget is what a new Run would freeze, never what an older one
had, so it is not read back in its place.
Findings follow the same rule: "No findings recorded" is said only of a list
read whole. While it is still being read, or has more pages to come, the card
says "Reading findings…"; when the read failed or the ledger cannot be shown
whole, "Findings could not be read". Findings already in hand stay on screen
through a reload, and a card shows the ones that are its own whatever else is
unread. Cards and cost follow the Team the timeline beside the inspector reads,
and a Seat's cost stays on screen while the report is read again.

A check that has run more than once lists its recorded attempts under
Attempts, newest first: each with its result, exit, the commit it ran at (twelve
characters, the whole on hover) and its time, and its output behind *Show output*,
shown as text through the shared sanitiser, so an earlier output is read as it was
recorded. While they are being read the section says so, and when the read failed
it says that: a check is never said to have run once before the desk has been
asked, and attempts already in hand stay on screen through a failed refresh.
*Run again…* is the last control. Where the Run has ended or the check is still
running it stays, disabled, with the host's own sentence on screen
(`checkRetryRefusal`); everything else the host refuses (a moved checkout, cleanup
still pending, a Team that cannot take work) is said in the consent dialog, which
shows the command exactly as it will run and keeps its answer disabled while there
is no token to redeem.

At pane widths below 48rem, a selection pushes detail over the timeline;
Run timeline returns to the selected row, and Run details opens the summary.
Cost is recorded for the Seats, which may have worked in more than one Run.
Handoffs and finding text preserve literal markup and discard terminal escapes
through the shared sanitiser. The `run-inspector` catalogue and preview use
the production component for every kind, findings still being read or
unreadable, a check with two attempts, one whose Run has ended, and one whose
attempts are still being read or could not be, empty, pending and failed reads,
narrow navigation and both themes.

### The Flow drawing

`FlowGraph` draws a Flow read-only, and is the one picture that says what the
product does: agents handing work on, a check that cannot be talked round, a
person at the gate, a loop that has to end. A step is a raised `Card` with an
`IconTile` for its kind (violet for an Agent, sky for a check, amber for a
person: the tints the rail already uses), its name in a word, and one earned
line — what an Agent may do (once a Run has seated it, the level its seats ran
at, which is below the Flow's grant when the Agent's own ceiling is, and whether
the runtime held it or only asked), the command a check runs, the words a
person may answer. An Agent is a square tile: the Flow defines it, a Run seats
it, and only then does it become a face. A step that opens several seats is a
fan of up to three cards, so a count reads without a number. A rule is a line
with an arrowhead and, only when something guards it, the outcome word above it
in a neutral `Chip` with a ground of its own; a loop is a curve under the line
whose word carries the retry mark. Cards sit on a faint dot grid with hairline
borders and one soft shadow (`Card variant="raised"`). Colour is for what a step
is, never decoration, and every value is a token.

Where things go is `lib/flow-layout.ts`, a pure function of the document:
steps run left to right in the order their rules reach them, a loop falls under
the line, a person who closes the Flow hangs under what handed it over, and a
Flow's own `layout.positions` win when it carries them, with the edges derived
again from the cards' boxes. A rule to a step the file does not define is
skipped in the drawing and still named in the list. The component only draws
what the layout says, so a screenshot, the list and a test read one answer.

On the Flow tab the drawing has the whole pane: the inspector explains a row of
the timeline and steps aside, and returns with the timeline.

A Run lays its recorded state over this same drawing. `FlowStepSurface` keeps
done badges at the upper right and durations and repeat counts at the lower
left. Current work has a breathing ring and a Working chip; its doing line
sits beneath the card, with room reserved inside the canvas. A waiting person
has the warning ring and Needs you. `FlowFaces` uses the marks of the actual
Seats, overlapping when several occupy a round. Unreached steps and routes
are dashed and quiet; travelled routes have the accent and a soft glow, and
a loop records how often its rule fired. `FlowBaton` glides along the incoming
curve, keeping its phase on snapshot updates and waiting for the faded end
before changing curves. Reduced motion stops the baton and ring. A blueprint
has neither. The step list carries the same state and shares selection with
all the timeline rows of a step, including earlier rounds.

The drawing is for the eye. It is `aria-hidden`, and the list of steps and
rules under it, built from `Rows`, carries the same facts. The drawing hides
below `38rem` of its own container's width — the pane's, not the window's — and
the list is then the view. Its curves and arrowheads are data geometry, as a
chart's are: attributes on SVG marks that read `--hd-*` tokens, recorded in the
design audit's list of such modules rather than excused. Everything else in it
is composed from the system, so a palette, density or faces change reaches it
and no screen draws its appearance. The `flow-graph` catalogue board mounts the
production pattern for a straight Flow, a loop, a fan-out, a person step, a
Flow with its own positions, a long Flow, one in the older format and one with
no steps, in both faces.

### The wrapped Team

Wrap retains the same pane and navigation, opening on Receipt. The receipt
scrolls in the body, leaving the rail and its Agents available. In a narrow
pane Receipt is the half that shows, for a Team that never had a Run as much as
for one a Run wrapped, and the Agents list is one tap behind it. Overview and
Run stay readable. The shared Seat list reads the receipt's captured
conversations, then an older receipt's answers, naming each conversation once
however many Seats were retained for it; an unlinked Seat remains a face and
name with **Conversation not kept**, without an opening action, and the rail's
**No Agents were kept** line is for a receipt that kept no Seat at all.
Dispatching controls and both composers are disabled with **This Team is
wrapped**, the conversation menu's **Compact now** and the branch chip's
**Review uncommitted changes** among them; **Stop** is the exception while a
turn is still running in a kept conversation, since stopping adds nothing, and
it stands alone in the corner — the refused send is drawn only when nothing
runs, as the corner holds one coin. A
dialog that chooses a conversation for a card does not list one a wrapped Team
keeps. A dialog open when the Team wraps
stays open, with its final action disabled and a note carrying the same reason;
Cancel still closes it. Wrapped Teams leave the sidebar and remain on the Teams
page; their retained conversations stay readable from the Team’s Agents list.
The `team-record` catalogue board mounts the production pane with
retained conversations, an older receipt, a conversation seated twice, a
receipt whose every Seat lost its conversation, no Seats, a narrow rail, a
Team that never had a Run in a narrow pane and a turn still running in a kept
conversation; its
preview also mounts the production sidebar and an open Team that can be wrapped
under a dialog, and an open Team whose Assign dialog sits beside a wrapped Team's
kept conversation.

### Run controls

A card that has not finished (open, claimed or blocked) offers **Abandon
card…** in its inspector, an ordinary outline button before the conversation
link: the door to a question is not red, because abandoning sets a card aside
and a card can be put back in play. The question is a `ConfirmDialog` (Keep it,
and Abandon card as the one filled act) whose first sentence says what the rule
after the card's role will do. The window's reply to an abandon says nothing
of that, so the sentence is read from the Run's own frozen Flow, the way the
engine reads it: the rule that follows still fires and opens the next round; no
rule accepts a card with no answer, so the Run ends without a next step and
reads Needs you; the round stays open until its other cards finish; or nothing
follows because the Run is not running or the round is over. A claimed card
adds who holds it and that they cannot finish it. A refusal stays in the
question, with the act disabled; asked again, it starts fresh. A person's
step is answered in the inspector with the controls the Overview uses.

The `run-controls` catalogue board and `preview.html?run-controls` draw the
inspector's controls and, one at a time as a dialog is, the question for each
way the Flow can answer it (`&abandon=opens|ends|waits|refused`).

## Tables and rows

One row anatomy: optional face, name or label, earned second line, one reading,
control, and an opening chevron when the whole row opens. The face and control
centre on the whole row, including a wrapped sentence. Names and facts truncate;
sentences wrap whole. The second line uses muted ink. A settings label stays
13px medium and its description stays 13px in both densities; a record name is
14px medium in comfortable and 13px in compact.

Six arrangements share this grammar: a data table compares records; a list
names things with a reading; settings rows label controls; a matrix compares
reach; a log keeps its windowed pitch; key-value rows describe one object.
Comfortable is the page default (40px header, 56px row or 44px bare).
`data-hd-table="compact"` uses 32px headers, 40px rows or 32px bare rows;
panel tables choose compact. Inspectors and project panels use the same compact
record anatomy: 13px medium names, 12px quiet facts, and centred readings.
Git's log keeps its fixed 26px pitch, with a 28px header from `TableHeader`'s
log variant, card dividers and the shared selected fill.

A data table compares three or more facts and has a header. Three or more
unlabelled numbers also need a header. Omit a column empty in every row; show
one quiet — for an empty cell. Numbers align to the end in tabular figures.
Show one status per row and tint it only when it needs attention. Draw a face
only when it tells rows apart. Only interactive rows hover; selected table,
matrix and record-list rows use the same selected fill. Navigation keeps its
own destination semantics. The Tables catalogue board and “Tables: the family”
preview frame mount the same real components in both densities.

Library switches from its Skill/Server, State and Loaded by table to list rows
below 600px of list-container width. The title keeps the name and command,
the description wraps for at most two lines with its full sentence in the
definition, the state sits on the meta line, and loading faces and the opening
chevron keep the trail. Wider tables keep a 192px floor on the identity cell.
