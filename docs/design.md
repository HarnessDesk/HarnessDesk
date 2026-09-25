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

### The sizes

The rule is a split: **13px is the chrome, 14px is what is read.** The counts
are a different fact and worth keeping separate from it — by volume the app is
12px and 13px, because a screen is nearly all furniture and most of the
furniture is smaller than a row's own title.

| token | value | what it carries | rules |
| --- | --- | --- | --- |
| `--hd-text-xs` | 12px | counts, badges, tags, timestamps, per-file diff numbers, the smallest button label, the hint under a form field | 217 |
| `--hd-text-sm` | 13px | the chrome: rows, navigation, settings rows, menu items, button labels, a form field's label, notes | 215 |
| `--hd-text` | 14px | what is read: the transcript, the composer, inputs | 82 |
| `--hd-text-lg` | 16px | a dialog's title | 16 |
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
step's 18px line, which is the same trade prose makes at the other end of the
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

## Named text roles

A size and a weight together name a *role*. A role describes what the words
are doing; screens do not invent a new spelling for the same job:

| role | spelling | what wears it |
| --- | --- | --- |
| wordmark | 20 / semibold | the product name beside its mark |
| page | 20 / semibold | the name of a place — a settings page, a review, and a page drilled into (`DetailHead`) alike; by owner decision on 2026-09-19 it matches the wordmark rather than outsizing it, and #832 put the detail head on it too: a detail page adds its mark and its owner chip, never a size of its own |
| group label | 13 / normal, secondary ink | the word over a group — a card of rows, a rail's list, a section of a page (`GroupLabel`). Sentence case, always: no label outside a `Keycap` is set in capitals |
| subject | 14 / medium | the name of the thing a pane, a dialog or a card is about |
| row | 13 / medium | the title of a setting, and the word above a control |
| navigation | 13 / normal | the name of one thing in a navigable list |
| muted | 13 / normal | a description under a name, and chrome that labels rather than names |

Counted before this rule was written down: eight. A dialog's title was 16/600
in one pattern and 14/600 in another; a label above a field was 13/600 in three
screens, 13 at whatever weight it inherited in three more, and 12 in a seventh.
The design system's own head slots said 600 in five components and 500 in the
sixth — so a screen that composed the system got a heavier title than a screen
that drew its own, which is the opposite of what a design system is for.

Nothing is 16 any more. A step between the subject and the page turned out to
be a way of avoiding the choice between them: a dialog names one question and a
page names a place, and 16 said neither.

| step | line | ratio |
| --- | --- | --- |
| 12px | `--hd-line-xs` 16px | 1.33 |
| 13px | `--hd-line-sm` 18px | 1.385 |
| 14px | `--hd-line` 21px | 1.5 |
| 16px | `--hd-line-lg` 24px | 1.5 |
| 20px | `--hd-line-heading` 28px | 1.4 |
| 24px | `--hd-line-title` 30px | 1.25 |
| 36px | `--hd-line-display` 40px | 1.11 |

Larger type wants a tighter ratio, which is why the column falls from 1.5 to
1.11 rather than holding one number. Prose is the exception in the other
direction: the transcript is set on 1.625, because a paragraph wraps and a row
does not.

Rows:

| token | value | note |
| --- | --- | --- |
| `--hd-row-h` | 30px | a one-line row |
| `--hd-nav-h` | `calc(--hd-text * 1.5 + --hd-space-1 * 2)` | a navigation row — solved, not written |
| `--hd-control-h` | 26px | dense toolbar targets and icon buttons |
| `--hd-field-h` | 30px | inputs and selects: matches `--hd-btn-h` |
| `--hd-bar-h` | 46px | the window's own bar, and a pane's |

A navigation row's height is solved from **the reading size**, not from the size
the row itself is set in: `--hd-text` times 1.5, plus one step of padding above
and below. The row's own text is a step smaller than that, which is the point —
every row in every column stands the same height whatever it happens to carry,
and a row of 13px labels does not end up shorter than a row of 14px ones. It is
also what lets the density or the reading size move every one of them without a
second edit, and it is how the two heights that column used to have became one.

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
| 500 | a pane's title, a settings nav row, a settings row's title, button labels |
| 600 | reserved — the sidebar's app name and a page title only |

A column of bold is a column of shouting. Selection is marked by a filled pill
and a check, never by making one row heavier than its neighbours. Button labels
set at weight 500 (`--hd-btn-weight`) because a 400-weight label on an ink
ground reads thin.

### Ink levels

| token | light | dark | what it carries |
| --- | --- | --- | --- |
| `--hdp-alias-label-primary` | `rgb(25, 27, 30)` | `rgb(229, 231, 234)` | anything a person reads: titles, rows, prose, values |
| `--hdp-alias-label-secondary` | `rgb(97, 99, 103)` | `rgb(206, 208, 211)` | structure and explanation: section headings, hints, blurbs, icons beside a label |
| `--hdp-alias-label-tertiary` | `rgb(112, 117, 125)` | `rgb(186, 190, 197)` | facts at the edge of a row: counts, times, keyboard hints |

In components, reach for the semantic tokens `--hd-foreground`,
`--hd-secondary-foreground`, and `--hd-muted-foreground` (`tokens.css`), which
resolve to these three palette aliases.

Three rules, learned the hard way:

1. **A project is not a lesser thing than the conversation inside it.** Rows
   that name something are primary ink, at every level of the tree.
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

1. A JSON value in `SchemaForm` (rendered with the canonical `WireText` pattern),
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
- An icon that labels a row belongs on the row's first line, not centred against
  the title *and* its description.
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

### What the audit refuses

`pnpm design:audit --strict` holds eighteen categories at a baseline.
Seventeen are at zero; `screenAppearance` sits at 895 declarations —
appearance a screen still draws for itself instead of composing it, in
whichever of three spellings it chose.

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

All three have the same shape as the line-height ratios before them: name the
spellings you happen to remember, and everything else is invisible —
confidently, at zero. When adding a rule, the question is not "does this catch
the case I am thinking of" but "what spelling of this would it miss".

A new category is only worth having if it can fail. Add it, then put the defect
back and watch it go red; a check that has never been seen red is a check that
has never been tested.
