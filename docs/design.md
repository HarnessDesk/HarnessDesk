# Design rules

HarnessDesk's hand-written design rules: the type scale, ink levels and row
rhythm, and when a row may explain itself on screen rather than waiting to be
asked. It is a companion to [design-system.md](design-system.md), which is
generated from the code; this document holds the reasoning behind the rules no
token can capture.

The tokens live in
[`packages/ui/src/design/tokens.css`](../packages/ui/src/design/tokens.css), the
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

Four steps carry the entire interface, plus one heading step:

| token | value | what it carries |
| --- | --- | --- |
| `--hd-text-xs` | 12px | counts, badges, tags, timestamps, per-file diff numbers, small button labels |
| `--hd-text-sm` | 13px | the line that supports a row, section headings, hints, notes, button labels |
| `--hd-text` | **14px** | **the interface**: sidebar rows, project rows, nav, menu rows, settings rows, chips, inputs |
| `--hd-text-lg` | 16px | the transcript, and the name of the thing on screen |
| `--hd-heading` | 20px | the app's own name; a settings page's title |

**14px is the default answer.** If a new surface or row shows text, it is 14px
until there is a reason it is not. This was a claim before it was true: the app
once had 115 rules at 12px and 102 at 13px against 51 at 14px, so the default
answer was the rarest one on screen. A row is a thing you read, and interface
rows are 14px; 12px was pushed back to what the table above says it carries —
counts, badges, tags, timestamps — and to code, which keeps its own smaller
measure. Buttons step down to 13px (`--hd-btn-text`) and 12px (`--hd-btn-text-sm`)
to hold the proportion between their box and the cap height of the label inside.
Most of the app is one size, and that is what makes the exceptions legible: a
13px line reads as support because it sits under something bigger, and a 12px
number reads as a count because everything around it is larger.

**16px is for reading, not for chrome.** The transcript is the one column a
person reads rather than scans, so it is a step above the furniture around it.
The conversation's name in the pane header shares that step, because it names
what you are reading. Nothing else does.

Prose keeps its own scale, in `Markdown.module.css` rather than here, and it is
the one place allowed to exceed this table. It is four ratios of the
transcript's 16px body — 1.5, 1.25, 1.125, 1 — so `h1` is 24px, `h2` is 20px
and lands on `--hd-heading` exactly, `h3` is 18px, and `h4` is the body's own
size in semibold with no gap under it.

Every prose heading is therefore at or above the body size. Anchoring the
ladder's *top* rung on `--hd-heading` instead keeps the scale inside the
interface's four steps, which reads as a tidy rule and produces a flat
document: `##`, the heading an agent actually writes, comes out at 18px
against a 16px body. Furniture stays inside the table; a document does not
have to.

### Line and row rhythm

| token | value | note |
| --- | --- | --- |
| `--hd-line` | 21px | 14px at 1.5 — the line height for interface text |
| `--hd-line-sm` | 18px | the line for 13px support text: hints, blurbs, notes |
| `--hd-row-h` | 30px | a one-line row: 21px of line plus 4–5px of padding |
| `--hd-nav-h` | 31px | a nav row: carries an icon and no second line |
| `--hd-control-h` | 26px | dense toolbar targets and icon buttons |
| `--hd-field-h` | 30px | inputs and selects: matches `--hd-btn-h` |

Support text has its own line (18px) because it is the thing that wraps. A hint
under a label, a blurb under a page title and a note under a group heading are
the same 13px doing the same job, so they share one line and stack to the same
rhythm.

A nav row is 31px (`--hd-nav-h`), one pixel taller than a list row, because it
carries an icon and no second line. A list row that shows a supporting line
grows; it does not shrink its title to fit.

Rows sit 2px apart. Without that gap a hover or selection pill reads as a band
across the column rather than as one row.

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

Two button idioms exist, and they share one set of numbers: the shadcn `Button`
in `design/ui/button.tsx` for new and rebuilt surfaces, and `Btn` in
`design/primitives/Kit.tsx` for settings-surface primitives. Both read the same
`--hd-btn-*` tokens, pinned by `button.test.tsx`. The variants speak shadcn's
vocabulary, with Kit's older names aliased:

| variant | where |
| --- | --- |
| `secondary` / *(none)* | the ordinary action, and the default answer (grey frame) |
| `default` / `primary` | the one action a group exists for — at most one per group (ink fill) |
| `outline` | bordered action on a transparent ground |
| `ghost` / `quiet` | no frame until hover, for an action that repeats down a list |
| `destructive` / `danger` | does the irreversible thing, red on the label only |

Two rules keep `destructive` / `danger` meaning something:

1. A button that only opens a confirmation is ordinary — the red belongs on the
   step that cannot be taken back.
2. Red is never a fill: a column of filled red buttons is a column nobody reads,
   the same way a column of bold is a column of shouting. It is soft danger ink
   on a transparent ground that fills on hover (`--hd-btn-danger-ink`,
   `--hd-btn-danger-hover`).

`Segmented` is not a button. It is a piece of a segmented control — a choice
between two or three words, one of which is on — and using it for actions is
what produced those thirty captions.

### Weight

| weight | where |
| --- | --- |
| 400 | everything, unless named below |
| 500 | the app's name, a pane's title, a settings nav row, a settings row's title, button labels |
| 600 | reserved — the sidebar's app name and a settings page's title only |

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

So a skill's name, a hook's event, a plugin's id, a contribution, a workspace
path, a worktree's branch and path, a route's endpoint and a changed file all
read in the interface's face. They are names, whatever produced them.

Two uses of the code face survive in components, and both are the rule rather
than an exception to it:

1. A JSON value in `SchemaForm` (rendered with `kit.wire`), which is output.
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

- `MenuItem` in `packages/ui/src/components/Menu.tsx` takes `hint` and `title`
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
| Agent tagline (Settings › Agents card) | truncated line | hover — a definition of an agent you already installed; still shown in full in Add agent, first run and sign-in |
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

## Adding to the app

When adding a control, row or surface to HarnessDesk:

- Reach for `--hd-text` (14px) first, then justify anything else. Buttons and
  form fields use `--hd-btn-text` (13px, `--hd-text-sm`) to preserve the
  box-to-cap ratio (~3.2).
- Never introduce a fifth size. If something needs to feel smaller, ask whether
  it needs to be on screen at all; if it needs to feel bigger, it is probably a
  title, and titles have a step already.
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
