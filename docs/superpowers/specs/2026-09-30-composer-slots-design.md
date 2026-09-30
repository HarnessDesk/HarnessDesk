# The composer's controls in fixed slots — design (#979)

Status: **proposal, awaiting the owner's sign-off.** No implementation starts before it.

## The problem

The composer's toolbar draws one control per kind of setting an agent offers
(`components/Composer.tsx` ~1199, `components/ComposerControls.tsx`). Every
control returns nothing when its agent does not offer that kind of setting,
so the row reshuffles from agent to agent: the same decision sits in a
different place depending on which agent or model is chosen, and "More"
comes and goes beside the model picker. Configuration also lags the agent:
an option that disappears is silently dropped, and a saved pick that no
longer exists is pruned without a word.

## What each agent offers today

Measured from the adapters and their fakes ("conditional" = depends on the
model or on what the agent declares):

| Agent shape | Mode | Model | Model config | Reasoning | Permissions | Other |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | yes | yes | no | conditional | yes | yes |
| Claude Code bridge | yes | yes | yes | yes | no | conditional |
| Cursor bridge | yes | conditional | no | conditional | no | yes |
| An ACP agent (fake) | yes | yes | no | yes | yes | yes |

So Permissions, Model config, Reasoning and "Other" are each missing for at
least one agent — which is exactly the reshuffle the owner saw.

## The rule

**Within a composer, a control's position never depends on which agent is
chosen.** There are two layouts, fixed and known: the *draft* composer (no
conversation yet) and the *live* composer (in a conversation). Switching
agent, model or option set inside either one moves nothing.

The row is two groups. The left group is anchored to the left edge and the
right group to the send button, with a flexible gap between. So a missing
control can only move the controls on its *inner* side — to its right in the
left group, to its left in the right group. That decides, per slot, whether
it must always be drawn.

## Slots

| Side | Slot | Draws | Source |
| --- | --- | --- | --- |
| Left 1 | Add | attach / add context | the existing `+` action |
| Left 2 | Work in | where a new conversation runs | draft only (a live conversation's place is in its header) |
| Left 3 | Agent | who answers | the session's runtime, or the draft target |
| Left 4 | Permissions | what it may do unasked | category `_permissions` |
| Left 5 | Mode | how it works | category `mode` |
| Left 6 | Extension | a plugin's composer action | `composer.action` |
| — | flexible gap | | |
| Right 1 | More | everything else | `other`, `model_config`, any unknown category |
| Right 2 | Context | how full the context is | session usage |
| Right 3 | Model | model and reasoning | `model` and `thought_level` |
| Right 4 | Send / Stop | the turn | |

The category → slot mapping lives in one pure module (below) that the
composer and Settings › an agent's page both read, so a new or unknown
category lands in the same place everywhere: More.

## When an agent does not offer a slot

| Slot | Treatment | Why |
| --- | --- | --- |
| Agent | **Greyed**, reason "Only one agent is available" | It is a real decision that is moot here; its place stays learnable. |
| Permissions | **Greyed**, reason "This agent has no permission setting" | Absent must not read as "unrestricted". |
| Mode | **Greyed**, reason "This agent has no mode setting" | Keeps Extension still. |
| Extension | **Absent** | It is the last of the left group; its absence moves nothing. |
| More | **Absent** | The outermost of the right group; its absence moves nothing, and a greyed "More" would promise options that do not exist. |
| Context | **Always drawn**; an empty ring with "No usage yet" until the agent reports | It sits between More and Model; drawing it keeps More still. |
| Model | **Always drawn**; greyed "This agent has no model setting" when missing; if only reasoning is missing, the menu says so | One slot carries both; a live conversation's model is always worth seeing. |
| Send / Stop | Always drawn | |

**Every slot is a fixed-width track**, and its control sits inside it,
truncating a label longer than the track. A cap alone is not enough: the
mock frames show that with capped labels a shorter permission label or a
longer model name still slides Mode and More by tens of pixels between
agents. With fixed tracks the left slots and More, Context and Model stand
at the same x for every agent, which is what the acceptance test measures.
Track widths are tokens sized to the common labels, not per screen.

At narrow widths the existing 560px / 320px folds turn labels into glyphs;
a folded slot keeps its (narrower) fixed track, so the rule holds at every
width. The draft layout is the tightest — Work in, Agent, Permissions and
Mode with labels do not all fit at the column width — so the fold order for
drafts (which labels fold to glyphs first) is settled in implementation and
shown in its frames.

## Stale defaults

A saved pick for new conversations (today `draftValues`, per agent) is
**stale** when the option it sets no longer exists, its value is no longer
offered, or the agent answers with a different value. It is never sent. It
shows:

- in the composer: a small warning mark on the affected control, and a
  first row in its menu naming the saved value and why it no longer applies;
- in Settings › that agent › New sessions: the same row, with
  **Use the agent's current value**, which deletes the saved pick in one
  click.

Today stale picks are pruned silently (`state/store.ts` ~5261, ~6993); the
change keeps the fact that one was pruned until the person clears it.

## Live updates

A `config_option_update` already replaces the session's whole option list.
The slots are recomputed from that list in one render: a removed model
leaves the Model menu, a new mode appears in the Mode slot — positions do
not change. If the **current** value itself disappears, it stays visible
with "Unavailable" and the menu offers the valid choices; nothing is
switched silently. Legacy `models` / `modes` stay the adapter's business: it
synthesises them only when no config option exists.

## The mapping module

`lib/composer-slots.ts`, pure:

- `slotForCategory(category)` → `'permissions' | 'mode' | 'model' | 'more'`;
- `optionsBySlot(options)` → the options grouped by slot, in the agent's order;
- `staleDefaults(saved, options)` → which saved picks no longer apply, and why.

The composer owns the layout; the module owns the mapping; Settings reads
the same module.

## Several agents at once (the race / room view)

The Race view's shared composer sits in this same spot and may address two
to four agents on different runtimes. The slots are the same. A slot shows
the union of what its targets offer; where their values differ it reads
**Mixed** and its menu lists each target's value (and why a target lacks
it). A change applies only to the targets that offer that option, and says
which before it is sent. Adding or removing a target moves nothing.

## Tests

- Unit: the category → slot table, including `model_config`, an unknown
  `_x`, a missing category and two options in one category; `staleDefaults`.
- Mock frames of today and the proposal, per agent, are in the PR/issue
  (a preview-only frame, not merged).
- Browser: the draft and the live composer for each agent shape above, at
  1280 and 1440 and at 720 with the floating sidebar — every slot's
  x-position identical across agents; the greyed reasons, focus order and
  accessible names; no clipping and no send-button drift.
- Browser: a live `config_option_update` that removes the selected model and
  adds a mode — the "Unavailable" row, the new mode, unchanged positions,
  and no setter call made on the person's behalf.
- Store: a stale saved pick is flagged, never sent, and cleared by
  **Use the agent's current value**.

## For the owner to decide

1. **Two fixed layouts (draft and live) rather than one**, so a live
   conversation does not carry an empty "Work in" gap. Recommended.
2. **More is absent, not greyed, when there is nothing in it.** Recommended —
   a greyed "More" promises options that do not exist.
3. **A live conversation whose current model became unavailable can still
   send**, with the warning shown; the agent owns that conversation's
   selection. Recommended.
