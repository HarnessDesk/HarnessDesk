# Agents in the App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Agent a person can reach: nine Agents ship with the app, this machine can choose their seats in `~/.harnessdesk/seating.json`, a dry run says which seat each would take here and why not the others, and Settings, the new-session dialog, ⌘K, a conversation's header, its name card and a room's roster all show and start Agents — while a seat passed over leaves nothing behind and a runtime that never answers is passed over rather than hanging the seating.

**Architecture:** Two stacked pull requests. **Part A** (Tasks 1–10) is host, files and shipped content with no screen: the pure chooser learns a structured reason and fix for every candidate (`agent-seating.ts`), the reads before choosing get a deadline, a passed-over seat is discarded where its runtime keeps it and forgotten by the desk (`#discardSeat`, `session/removed`), `agent/seat/dry` answers the plan without opening anything, a refusal travels as a typed error carrying every candidate, `seating.json` is read and written by one module (`agent-seating-file.ts`) at the precedence the spec gives it, nine `AGENT.md` files ship under `packages/server/agents/`, a watcher re-reads the roster and pushes `agent/changed`, four file verbs (`agent/create`, `agent/copy`, `agent/remove`, `agent/reveal`) give the pages their actions, and a backup carries your Agents and this Mac's seats. **Part B** (Tasks 11–22) is the interface on top: the Settings route split (`agents` → `runtimes`, then `agents` is the roster), the roster in the renderer and its words, the roster page, starting as an Agent from the new-session dialog and ⌘K with the refusal sheet, an Agent's page and its *On this Mac*, a project's page, a conversation headed by its Agent with its name card, *Save as an Agent…*, Agents in a room, the documentation, and a verification run in the real app with one picture per surface.

**Tech Stack:** TypeScript (ESM, `node16` resolution — every relative import in `packages/server` ends `.js`), `node:test` + `node:assert/strict` for server tests built into `packages/server/dist/test`, React 19 + Vitest + Testing Library (jsdom) for the renderer, the repository's own `parseYaml` (`packages/server/src/yaml.ts`), Electron for the desktop shell, pnpm workspaces. No new dependency.

**Tasks** — 22, every one written with its complete code, commands and expected output:

- Part A: 1 a reason and a fix on every candidate · 2 the reads before choosing have a deadline · 3 a passed-over seat leaves nothing behind · 4 `agent/seat/dry` · 5 the refusal carries every candidate · 6 `seating.json` · 7 the nine shipped Agents · 8 the roster watcher · 9 an Agent's files · 10 the backup carries Agents and seats.
- Part B: 11 Settings › Runtimes, the route split · 12 the roster in the renderer · 13 Settings › Agents · 14 starting as an Agent, ⌘K and the refusal sheet · 15 an Agent's page · 16 *On this Mac* · 17 Workspaces › a project · 18 a conversation seated as an Agent · 19 *Save as an Agent…* · 20 Agents in a room · 21 the documentation · 22 verified in the real app, one picture per surface.

## Global Constraints

- **This plan is phase 2 of 12.** Ceilings that hold (`edit`, *held*, enforcement at the tool surface), evidence, the Seat record, Goal, lanes and triggers are later phases. Do not reach into them. The seated-as record stays in memory (`SessionRecord.seatedAs`) until phase 4 makes it durable.
- **Design source:** `docs/superpowers/specs/2026-09-17-agents-and-goals-design.md`. Where this plan and the spec disagree, the spec is right and the plan is a bug. The roadmap's phase 2 section is `docs/superpowers/plans/2026-09-17-agents-and-goals-roadmap.md` › *2. Agents in the app*.
- **No competitor or third-party product names** in code, comments, commit messages, PR titles or PR bodies. The runtimes the desk integrates (Claude Code, Codex, Cursor, Gemini CLI, …) are fine where the code already names them; rendered UI text still names a runtime only through `RuntimeInfo.presentation` or a name the host supplies (AGENTS.md rule 8 — `pnpm layering` fails a brand name in rendered text).
- **No real accounts, emails or handles** in fixtures, docs, commit messages or screenshots. Identities are placeholders (`Jane Doe`, `dev@example.com`) or the demo persona, **Shane** at `harnessdesk.app`, which `packages/ui/src/preview/sidebar-fixture.ts` defines (AGENTS.md rule 13). Every frame comes from the rig, never from a real desk.
- **`permission` is a ceiling, never a grant.** A seat holds `min(Agent ceiling, grant)`, and no surface in this phase grants anything: every seat started from the app holds `read`, and every ceiling on every surface is labelled *asked* (`Read · asked`), because nothing enforces one yet.
- **Ceilings use today's vocabulary: `read | publish | merge`, under today's key, `permission:`.** `read` still permits editing and committing inside the checkout (it forbids push, merge, reset and force — `GIT_RULES.read` in `packages/server/src/flow.ts`). **This phase neither parses nor writes `ceiling:`** — that key is phase 3's, which brings the four-word ladder under it and moves the shipped Agents there (`researcher` and `requirements-analyst` to `edit`). Everything this phase writes — the nine shipped `AGENT.md` files, *Save as an Agent…*, *Customize…* — says `permission:`, the only key the parser knows.
- **Refuse, never substitute.** When no candidate can be seated, nothing is opened and every candidate is listed with its reason and its fix. A seating override that cannot be read refuses the seating; it is never replaced by the Agent's `prefer`.
- **Precedence is project → user → built-in** for Agents, and a shadowed Agent is listed and marked, never hidden. **Seat precedence is a seating's own `seats`, then this machine's `seating.json`, then the Agent's `prefer`** — and the machine's entry *replaces* `prefer`, it does not merge with it.
- **Runtime ids are the registry's.** The Claude runtime is `claude-code` (template key in `packages/server/src/agent-registry.ts`, `known-agents.ts`), Codex is `codex`, Cursor is `cursor`. The roadmap's `prefer: [claude, codex, cursor]` and the spec's `claude=opus-5/high` name an id that does not exist; the shipped Agents say `prefer: [claude-code, codex, cursor]`.
- **Sentences, not wire.** No verb name (`agent/seat`), no seat spec (`claude-code=opus-5/high`) and no digest appears in rendered text. A seat reads *Claude · Opus 5 · High*; a brief that moved on reads *The brief has changed since this started*. The runtime's brand mark stays the runtime's; an Agent is its name.
- **Greyed, never withdrawn.** An Agent that cannot be seated here stays in every menu that lists Agents, greyed, with its first reason (AGENTS.md rule 9: a refused row keeps its reason on screen).
- **A row's second line is earned** (AGENTS.md rule 9). A description is an earned line on the roster (it is the only thing that says what an Agent is for); a paraphrase of the verb goes in `title`.
- **Build screens from `packages/ui/src/design`** (AGENTS.md rules 10–12): `PageHead`, `SectionHead`, `Rows`, `Row`, `RowButton`, `BackLink`, `DetailHead`, `Note`, `Chip`, `Button`, `Dialog`, `ConfirmDialog`, `Field`, `FormStack`, `Input`, `Textarea`, `NativeSelect`, `Menu*`. No raw font size, colour, radius or spacing literal; no hand-rolled overlay; icons only from `components/Icons.tsx`. `node script/design-audit.mjs --strict` must stay at zero.
- **Every new screen gets a fixture in the preview harness** (`packages/ui/preview.html` → `src/preview/main.tsx`). The preview store answers an unknown method with `undefined`, so every new store method the screen calls is stubbed there.
- **A wire method is three edits in a fixed order** (AGENTS.md rule 2): declare in `packages/protocol/src/wire.ts`, validate in `packages/protocol/src/wire-validators.ts`, answer in `packages/server/src/methods/<domain>.ts`. A handler reaches the host only through `HostContext`.
- **A verb with no caller is pinned in `UNREACHED`** in `script/check-reachable.mjs` with its reason while Part A lands, and its line is removed **in the same task** that gives it a `transport.request('…')` caller in `packages/ui/src` — the gate fails either way round.
- **Testing.** Server: `node:test` with `node:assert/strict`; build with `pnpm run build:node` (it is the typecheck — **never** `pnpm run typecheck`, which fails with TS6310 whatever you change), then `node --test --test-reporter=spec packages/server/dist/test/<file>.test.js`. UI: `pnpm --filter @harnessdesk/ui exec vitest run <path under packages/ui>`. Every test must be able to fail; a regression test is shown red against the unfixed code before the fix.
- **Commit after every task**, with `pnpm verify` green first, run **unpiped** with a short temp dir, reading its exit status: `mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"`. Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Part A ships on its own.** After Task 10, `pnpm verify` is green and every new verb is either called or pinned. Part B is stacked on Part A's branch, and from Task 19 on `UNREACHED` holds only what it held before phase 1 (`team/state`, `team/rooms`).

---

## File map

| File | Part | Responsibility |
| --- | --- | --- |
| `packages/protocol/src/agent.ts` | A, B | `SeatReason`, `SeatFix`, `SeatLeft`, `SeatCandidate`, `SeatPlan` (and its `own`, Task 15), `MachineSeating`, `SeatingProblem` |
| `packages/protocol/src/session.ts` | A | `SessionSettings` gains host-held `seatLabel` and `passedOver` |
| `packages/protocol/src/errors.ts` | A | `SeatRefusedError`, `wireDataOf`, `isSeatRefused` |
| `packages/protocol/src/wire.ts`, `wire-validators.ts` | A, B | `agent/seat/dry`, `agent/seating/read`, `agent/seating/set`, `agent/create`, `agent/copy`, `agent/remove`, `agent/reveal`; notifications `agent/changed`, `session/removed`; `WireError.data`; the backup's two new fields; `host/hello`'s `stateDir` (Task 13) |
| `packages/server/src/agent-seating.ts` | A | Pure: reasons, fixes, what a passed-over seat left, words for a seat; `planSeats` |
| `packages/server/src/seat-reads.ts` | A | The deadline every pre-choice read is held to |
| `packages/server/src/agent-seating-file.ts` | A | `seating.json`: read, validate, write one Agent's entry |
| `packages/server/src/agent-files.ts` | A | Create, copy, trash and back up an Agent's folder; the id rule |
| `packages/server/src/agent-watch.ts` | A | Watches the three roots and pushes `agent/changed` |
| `packages/server/src/methods/agents.ts` | A, B | The verbs; reads held to the deadline; the checkout's top as the project (Task 12); `own` (Task 15); the seat keeps the Agent's name (Task 20) |
| `packages/server/src/host.ts` | A, B | `#discardSeat`, the deadline option, the watcher's lifetime, `#fileRoots`, `trashPath`, the backup, `topLevel`, a room's peers carry the Agent's name |
| `packages/server/src/registry.ts` | A, B | `SeatedAs` gains `seatLabel`, `passedOver` and (Task 20) `name` |
| `packages/server/src/team.ts` | B | A member seated as an Agent is named for it |
| `packages/server/src/server.ts`, `bootstrap.ts`, `methods/context.ts`, `methods/sessions.ts`, `methods/workspace.ts`, `methods/app.ts` | A, B | The plumbing each of the above needs |
| `packages/server/agents/<id>/AGENT.md` ×9 | A | The shipped Agents |
| `packages/server/package.json`, `packages/desktop/script/packaging.test.mjs`, `packages/desktop/script/smoke-packaged.mjs` | A | The folder ships with the server package, and the packaged app is checked to carry it |
| `packages/desktop/electron/main.mjs` | A | `trashPath`, through the OS Trash |
| `packages/ui/src/lib/transport.ts` | A | A rejection keeps the host's `data` |
| `packages/ui/src/components/Settings.tsx`, `SettingsAgents.tsx` | B | The route split, the *Runtimes* page, the roster's nav row, `focus`, Workspaces rows that drill |
| `packages/ui/src/components/AgentRoster.tsx` (+ `.module.css`) | B | Settings › Agents |
| `packages/ui/src/components/AgentPage.tsx` (+ `.module.css`) | B | An Agent's page, and *On this Mac* |
| `packages/ui/src/components/ProjectPage.tsx` | B | Workspaces › a project |
| `packages/ui/src/components/SeatSheet.tsx`, `packages/ui/src/app/seat-fixes.ts` | B | The refusal sheet, and where a fix goes |
| `packages/ui/src/components/SaveAsAgent.tsx` | B | *Save as an Agent…* |
| `packages/ui/src/lib/agents.ts` | B | Agents in words: ceilings, origins, reasons, fixes, seats |
| `packages/ui/src/state/store.ts`, `snapshot.ts`, `seat-agent.ts` | B | The roster, its plans, this Mac's seats and the Agents conversations were seated as; `startAsAgent`; `useSeatAgent` |
| `App.tsx`, `NewSessionChoice.tsx`, `CommandPalette.tsx`, `Conversation.tsx`, `SessionTree.tsx`, `ComposerControls.tsx`, `AgentCards.tsx`, `design/patterns/AgentCard.tsx`, `AddMember.tsx`, `WorkspaceMenu.tsx`, `Icons.tsx` | B | The surfaces that list, start and show Agents |
| `packages/ui/src/preview/main.tsx` | B | Fixtures for every new screen |
| `docs/agents.md` (new), `docs/README.md`, `interface.md`, `runtimes.md`, `multi-agent.md`, `getting-started.md`, `design.md`, `design-system.md` (generated) | B | What ships |
| `script/check-reachable.mjs` | A, B | Pins each new verb, then unpins it with its first caller |
| `script/shots/seed.mjs`, `accounts.mjs`, `shoot.mjs`, `script/shots-isolation.test.mjs` | B | The staged desk gains Agents; one scene per surface |
---

# Part A — host, files and shipped content

Part A has no screen. Every task in it ends with `pnpm verify` green, and after Task 10 the branch is a pull request of its own.

---

### Task 1: A reason and a fix on every candidate

Today a passed-over candidate is a sentence (`PassedOver.why`) written with the runtime's wire id — "cursor is signed out". A surface cannot offer *Sign in* from a sentence without reading English, and it may not show the id (AGENTS.md rule 8). This task gives every candidate a structured `reason` and a `fix` beside the sentence, without changing a single sentence the refusal already says.

It also splits one reason in two. "Not installed" covers a runtime nobody added to the desk *and* one that is added and whose program is missing — two different fixes (*Add Codex* against *Install Codex*). The sentence stays the same for both; the reason says which.

**Files:**
- Modify: `packages/protocol/src/agent.ts` (add `SeatReason`, `SeatFix`)
- Modify: `packages/server/src/agent-seating.ts` (`SeatOffer.notInstalled`, `PassedOver.reason`, `reasonAgainst`, `sentenceOf`, `fixOf`, `passedFor`; `chooseSeat` and `openedOtherwise` rewritten on them)
- Modify: `packages/server/src/methods/agents.ts` (`offerOf` offers a runtime whose program is missing instead of dropping it; `openAsAsked` answers a `PassedOver`)
- Test: `packages/server/test/agent-seating.test.ts`

**Interfaces:**
- Consumes: `FlowSeat` (`@harnessdesk/protocol`), `chooseSeat`, `differences`, `explainRefusal` (phase 1).
- Produces:
  - `type SeatReason` and `type SeatFix` in `@harnessdesk/protocol` (exact union below).
  - `interface SeatOffer { …; readonly notInstalled?: boolean }`
  - `interface PassedOver { readonly seat: FlowSeat; readonly why: string; readonly reason: SeatReason }`
  - `reasonAgainst(seat: FlowSeat, offers: readonly SeatOffer[]): SeatReason | null`
  - `sentenceOf(runtime: string, reason: SeatReason): string`
  - `fixOf(runtime: string, reason: SeatReason): SeatFix`
  - `passedFor(seat: FlowSeat, reason: SeatReason): PassedOver`

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/test/agent-seating.test.ts`, and add `fixOf`, `passedFor`, `reasonAgainst` and `sentenceOf` to its import from `'../src/agent-seating.js'`:

```ts
/*
 * A reason a surface can act on. The sentence is the host's — it quotes the
 * runtime's wire id, which a surface may not show — so every candidate also
 * carries what the reason is and what removes it, and a surface words both.
 */

test('every reason carries what removes it, and the sentence is unchanged', () => {
  const chosen = chooseSeat(
    ['ghost=m1', 'gone=m1', 'old=m1', 'out=m1', 'spent=m1', 'unread=m1', 'cursor=nope', 'cursor=m1/xhigh'].map(written),
    [
      offer('gone', { notInstalled: true }),
      offer('old', { unavailable: 'Old 0.1 is too old.' }),
      offer('out', { signedIn: false }),
      offer('spent', { spent: true }),
      offer('unread', { models: null }),
      offer('cursor'),
    ],
  )
  assert.equal(chosen.seat, null)
  assert.deepEqual(
    chosen.passed.map((one) => [one.reason, fixOf(one.seat.runtime, one.reason)]),
    [
      [{ kind: 'notInstalled', added: false }, { kind: 'add', runtime: 'ghost' }],
      [{ kind: 'notInstalled', added: true }, { kind: 'install', runtime: 'gone' }],
      [{ kind: 'unavailable', detail: 'Old 0.1 is too old' }, { kind: 'runtime', runtime: 'old' }],
      [{ kind: 'signedOut' }, { kind: 'signIn', runtime: 'out' }],
      [{ kind: 'spent' }, { kind: 'usage', runtime: 'spent' }],
      [{ kind: 'modelsUnread', model: 'm1' }, { kind: 'runtime', runtime: 'unread' }],
      [{ kind: 'noModel', model: 'nope' }, { kind: 'seats' }],
      [{ kind: 'noEffort', effort: 'xhigh' }, { kind: 'seats' }],
    ],
  )
  // The sentence is still the one a refusal has always said, and one function says it.
  assert.deepEqual(
    chosen.passed.map((one) => one.why),
    [
      'ghost is not installed',
      'gone is not installed',
      'old is unavailable: Old 0.1 is too old',
      'out is signed out',
      "spent's window is spent",
      'cannot tell whether unread offers m1: its model list could not be read',
      'cursor does not offer nope',
      'cursor does not offer xhigh effort',
    ],
  )
  for (const one of chosen.passed) assert.equal(one.why, sentenceOf(one.seat.runtime, one.reason))
})

test('a runtime nobody added and one whose program is missing read the same and are fixed differently', () => {
  // Both are "not installed" to a reader of the refusal; the first is fixed in
  // Settings by adding it, the second by installing what it runs.
  assert.deepEqual(reasonAgainst(written('codex'), []), { kind: 'notInstalled', added: false })
  assert.deepEqual(reasonAgainst(written('codex'), [offer('codex', { notInstalled: true })]), {
    kind: 'notInstalled',
    added: true,
  })
  assert.equal(reasonAgainst(written('codex'), [offer('codex')]), null)
})

test('what only an open seat can say is a reason too, worded as the refusal always worded it', () => {
  const asked = written('cursor=m1/high')
  const opened = passedFor(asked, { kind: 'openedOtherwise', detail: 'at medium effort, not high' })
  assert.equal(opened.why, 'cursor runs it at medium effort, not high')
  assert.equal(opened.why, openedOtherwise(asked, running({ effort: 'medium' })))
  assert.deepEqual(fixOf('cursor', opened.reason), { kind: 'seats' })
  const failed = passedFor(asked, { kind: 'couldNotOpen', detail: 'the bridge exited' })
  assert.equal(failed.why, 'cursor could not open a conversation: the bridge exited')
  assert.deepEqual(fixOf('cursor', failed.reason), { kind: 'runtime', runtime: 'cursor' })
})
```

`running` is declared further down the file than these tests; move the three tests below the `running` helper (after the last existing test) so the helper is in scope where they read it.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Module '"../src/agent-seating.js"' has no exported member 'fixOf'` (and the same for `passedFor`, `reasonAgainst`, `sentenceOf`), and `Object literal may only specify known properties, and 'notInstalled' does not exist in type 'Partial<SeatOffer>'`.

- [ ] **Step 3: Add the two types to the protocol**

Append to `packages/protocol/src/agent.ts`:

```ts
/**
 * Why one candidate seat cannot be taken here, as a fact rather than a
 * sentence.
 *
 * The host words each of these for its own refusals and logs, with the
 * runtime's wire id in them. A surface may show neither the id nor the
 * host's sentence (it words a runtime by its presentation), so it reads this
 * instead, and the fix beside it (`SeatFix`).
 *
 * The first seven are known before anything is opened; the last two only
 * once a conversation exists.
 */
export type SeatReason =
  /**
   * No runtime by this id can be asked. `added` false: nothing by that id is
   * added to the desk. `added` true: it is added, and the program it runs is
   * not on this machine. One sentence, two fixes.
   */
  | { readonly kind: 'notInstalled'; readonly added: boolean }
  /** It cannot open a conversation right now — too old, crashed, still starting — in its own words. */
  | { readonly kind: 'unavailable'; readonly detail: string }
  | { readonly kind: 'signedOut' }
  /** An account-wide window is used up. */
  | { readonly kind: 'spent' }
  /** The seat names a model and the runtime's model list could not be read, so whether it offers it is unknown. */
  | { readonly kind: 'modelsUnread'; readonly model: string }
  | { readonly kind: 'noModel'; readonly model: string }
  | { readonly kind: 'noEffort'; readonly effort: string }
  /** Asked for a conversation, and it failed to open one. */
  | { readonly kind: 'couldNotOpen'; readonly detail: string }
  /** It opened, and runs something other than the seat asked for: each difference named in `detail`. */
  | { readonly kind: 'openedOtherwise'; readonly detail: string }

/**
 * What removes a reason, as a thing a surface can offer. Never a sentence:
 * the words are the surface's, and the runtime is named by its presentation.
 */
export type SeatFix =
  /** Nothing by this id is added: Settings › Runtimes, where one is added. */
  | { readonly kind: 'add'; readonly runtime: string }
  /** Added, with its program missing: the runtime's own page, which says how to install it. */
  | { readonly kind: 'install'; readonly runtime: string }
  | { readonly kind: 'signIn'; readonly runtime: string }
  /** Its window is spent: the usage dashboard, which says when it comes back. */
  | { readonly kind: 'usage'; readonly runtime: string }
  /** Something about the runtime itself: its page in Settings › Runtimes. */
  | { readonly kind: 'runtime'; readonly runtime: string }
  /** The seat asks for what this runtime does not do here: this Mac's seats for the Agent. */
  | { readonly kind: 'seats' }
```

`packages/protocol/src/index.ts` already re-exports the whole module (`export * from './agent.js'`), so nothing else changes there.

- [ ] **Step 4: Rewrite the chooser on the reason**

In `packages/server/src/agent-seating.ts`:

1. Change the first import to take the two types:

```ts
import type { ConfigOption, FlowPermission, FlowSeat, SeatFix, SeatReason, SessionSettings } from '@harnessdesk/protocol'
```

2. In `interface SeatOffer`, after `readonly runtime: string`, add:

```ts
  /**
   * Added to the desk, and the program it runs is not on this machine. Not
   * the same fix as a runtime nobody added — that is no offer at all — so it
   * is said apart, though a refusal words both "not installed". When it is
   * set the rest of the offer is not consulted.
   */
  readonly notInstalled?: boolean
```

3. Replace `interface PassedOver` with:

```ts
export interface PassedOver {
  readonly seat: FlowSeat
  /** A sentence for the host's refusal and its log: the runtime by its id, and what it lacks. */
  readonly why: string
  /** The same fact, for a surface to word and to offer the fix for (`fixOf`). */
  readonly reason: SeatReason
}
```

4. Replace the whole `whyNot` function and `chooseSeat` with:

```ts
/** Why this candidate cannot be taken, as a fact a surface can act on, or null when it can. */
export const reasonAgainst = (seat: FlowSeat, offers: readonly SeatOffer[]): SeatReason | null => {
  const offer = offers.find((one) => one.runtime === seat.runtime)
  if (!offer) return { kind: 'notInstalled', added: false }
  if (offer.notInstalled) return { kind: 'notInstalled', added: true }
  if (offer.unavailable) return { kind: 'unavailable', detail: quoted(offer.unavailable) }
  /* Before anything the candidate asked for: signed out, a runtime may list no
     models at all, and "does not offer" would then send the reader to change a
     spec that was right. */
  if (!offer.signedIn) return { kind: 'signedOut' }
  if (offer.spent) return { kind: 'spent' }
  /* A model or effort left out, or written as null, is not asked for, so there
     is nothing to check it against. */
  if (seat.model) {
    if (offer.models === null) return { kind: 'modelsUnread', model: seat.model }
    if (!offer.models.includes(seat.model)) return { kind: 'noModel', model: seat.model }
  }
  if (seat.effort && offer.efforts !== null && !offer.efforts.includes(seat.effort)) {
    return { kind: 'noEffort', effort: seat.effort }
  }
  return null
}

/**
 * A reason as the host says it: in a refusal, and in its log. The runtime is
 * named by the id a seat spec writes, because that is the text a person can
 * find in an `AGENT.md` and change. A surface words the reason itself.
 */
export const sentenceOf = (runtime: string, reason: SeatReason): string => {
  switch (reason.kind) {
    case 'notInstalled':
      return `${runtime} is not installed`
    case 'unavailable':
      return `${runtime} is unavailable: ${reason.detail}`
    case 'signedOut':
      return `${runtime} is signed out`
    case 'spent':
      return `${runtime}'s window is spent`
    case 'modelsUnread':
      return `cannot tell whether ${runtime} offers ${reason.model}: its model list could not be read`
    case 'noModel':
      return `${runtime} does not offer ${reason.model}`
    case 'noEffort':
      return `${runtime} does not offer ${reason.effort} effort`
    case 'couldNotOpen':
      return `${runtime} could not open a conversation: ${reason.detail}`
    case 'openedOtherwise':
      return `${runtime} runs it ${reason.detail}`
  }
}

/**
 * What removes a reason. Three places a person goes: the runtime (add it,
 * install it, sign in, look at what is wrong with it), its usage, or this
 * machine's seats for the Agent — the last being the answer whenever the seat
 * itself asks for something the runtime does not do here.
 */
export const fixOf = (runtime: string, reason: SeatReason): SeatFix => {
  switch (reason.kind) {
    case 'notInstalled':
      return reason.added ? { kind: 'install', runtime } : { kind: 'add', runtime }
    case 'signedOut':
      return { kind: 'signIn', runtime }
    case 'spent':
      return { kind: 'usage', runtime }
    case 'unavailable':
    case 'modelsUnread':
    case 'couldNotOpen':
      return { kind: 'runtime', runtime }
    case 'noModel':
    case 'noEffort':
    case 'openedOtherwise':
      return { kind: 'seats' }
  }
}

/** One candidate passed over, the sentence and the fact from one reason so the two cannot disagree. */
export const passedFor = (seat: FlowSeat, reason: SeatReason): PassedOver => ({
  seat,
  why: sentenceOf(seat.runtime, reason),
  reason,
})

/**
 * The first candidate this machine can seat, exactly as it was written, and
 * each one above it with the reason it was passed over.
 */
export const chooseSeat = (candidates: readonly FlowSeat[], offers: readonly SeatOffer[]): Seating => {
  const passed: PassedOver[] = []
  for (const seat of candidates) {
    const reason = reasonAgainst(seat, offers)
    if (reason === null) return { seat, passed }
    passed.push(passedFor(seat, reason))
  }
  return { seat: null, passed }
}
```

5. Replace `openedOtherwise` with the same sentence, said by `sentenceOf`:

```ts
export const openedOtherwise = (asked: FlowSeat, running: SeatRunning): string | null => {
  const found = differences(asked, running)
  return found.length === 0 ? null : sentenceOf(asked.runtime, { kind: 'openedOtherwise', detail: found.join(', and ') })
}
```

- [ ] **Step 5: Make the method keep the fact**

In `packages/server/src/methods/agents.ts`:

1. Extend the import from `'../agent-seating.js'` to:

```ts
import {
  agentOrder,
  chooseSeat,
  differences,
  explainRefusal,
  passedFor,
  permissionWithin,
  type PassedOver,
  type SeatOffer,
} from '../agent-seating.js'
```

(`openedOtherwise` is no longer used here; drop it from the import.)

2. In `'agent/seat'`, replace the block

```ts
      const opened = await openAsAsked(ctx, seat, { cwd: params.cwd, title: definition.name })
      if (typeof opened === 'string') {
        passed.push({ seat, why: opened })
        continue
      }
```

with

```ts
      const opened = await openAsAsked(ctx, seat, { cwd: params.cwd, title: definition.name })
      if ('reason' in opened) {
        passed.push(opened)
        continue
      }
```

3. Replace `openAsAsked` with:

```ts
/**
 * Opens one candidate and holds it to what it asked for: the open seat, or the
 * candidate passed over with why — and then nothing of it is left open.
 *
 * A seat that fails part-way through opening is closed by the host before the
 * failure reaches here; one that opens on something else is closed here, and
 * the close is waited for, so the next candidate is only opened once this one
 * is gone.
 */
const openAsAsked = async (
  ctx: HostContext,
  seat: FlowSeat,
  where: { readonly cwd: string; readonly title: string },
): Promise<OpenedSeat | PassedOver> => {
  let opened: OpenedSeat
  try {
    opened = await ctx.seats.open(seat, where)
  } catch (error) {
    return passedFor(seat, { kind: 'couldNotOpen', detail: messageOf(error) })
  }
  const found = differences(seat, opened.running)
  if (found.length === 0) return opened
  await ctx.seats.retire(opened.runtime, opened.sessionId)
  return passedFor(seat, { kind: 'openedOtherwise', detail: found.join(', and ') })
}
```

4. In `offerOf`, replace

```ts
  if (health.state === 'unavailable' && health.reason === 'notInstalled') return null
  // Nothing else is read about a runtime that cannot open a conversation; the chooser stops at why.
  const unread = { models: null, efforts: null, signedIn: false, spent: false }
```

with

```ts
  // Nothing else is read about a runtime that cannot open a conversation; the chooser stops at why.
  const unread = { models: null, efforts: null, signedIn: false, spent: false }
  /* Added, and its program is missing. Offered with that said rather than
     dropped: a runtime nobody added is fixed by adding it, and this one by
     installing what it runs, and only an offer can carry the difference. */
  if (health.state === 'unavailable' && health.reason === 'notInstalled') {
    return { runtime: id, notInstalled: true, ...unread }
  }
```

and change `offerOf`'s return type from `Promise<SeatOffer | null>` to `Promise<SeatOffer>`, and in `offersFor` replace

```ts
  const offers = await Promise.all(runtimes.map((runtime) => offerOf(ctx, runtime, reports)))
  return offers.filter((offer): offer is SeatOffer => offer !== null)
```

with

```ts
  return Promise.all(runtimes.map((runtime) => offerOf(ctx, runtime, reports)))
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-seating.test.js packages/server/dist/test/agent-seat.test.js`
Expected: PASS — `agent-seating.test.js` 25 tests (22 before, three new), `agent-seat.test.js` 37 tests, 0 failures. `each thing the desk knows before opening is its own reason, read from the desk` still passes unchanged: the sentence for `gone` is the same, only its reason now says it was added.

- [ ] **Step 7: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/protocol/src/agent.ts packages/server/src/agent-seating.ts packages/server/src/methods/agents.ts packages/server/test/agent-seating.test.ts
git commit -m "feat(agents): every passed-over seat carries its reason and its fix

A refusal was a list of sentences with the runtime's wire id in them, which a
surface can neither show nor act on without reading English. Each candidate
now also carries what the reason is and what removes it, from the one function
that words the sentence, so the two cannot disagree. A runtime nobody added and
one whose program is missing still read 'not installed'; they are fixed in
different places, so the reason says which.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 2: The reads before choosing have a deadline

`offersFor` asks each named runtime for its account (`getAccount`), its model list (`knownModels` or `listModels`) and every runtime's usage (`ctx.usage().reports()`), and waits for all of them. A runtime that never answers — a bridge wedged on a login shell, an agent that swallowed a request — holds the seating open for ever, and with it every menu that will draw from the dry run in Task 4. This task holds each read to a deadline. A runtime that does not say whether it is signed in within it is passed over with that reason; a model list that does not arrive is *unread* (the existing reason); usage that does not arrive is replaced by the last reading the desk already holds.

A read that misses its deadline is not cancelled — none of these calls takes a signal — it is only no longer waited for, and its late answer is dropped.

**Files:**
- Create: `packages/server/src/seat-reads.ts`
- Modify: `packages/server/src/agent-seating.ts` (`SeatOffer.silent`, the `noAnswer` reason, `durationWords`)
- Modify: `packages/protocol/src/agent.ts` (`SeatReason` gains `noAnswer`)
- Modify: `packages/server/src/host.ts` (`HostOptions.seatReadDeadlineMs`)
- Modify: `packages/server/src/methods/agents.ts` (`offersFor`, `offerOf`, `modelsOf`, `usageWithin`)
- Test: `packages/server/test/seat-reads.test.ts` (new), `packages/server/test/agent-seat.test.ts`

**Interfaces:**
- Consumes: `reasonAgainst`, `sentenceOf`, `fixOf` (Task 1).
- Produces:
  - `SEAT_READ_DEADLINE_MS = 10_000` and `within<T>(read: () => Promise<T>, ms: number): Promise<Within<T>>` where `type Within<T> = { settled: 'value'; value: T } | { settled: 'error'; error: unknown } | { settled: 'late' }` (`seat-reads.ts`).
  - `SeatOffer.silent?: number | null` — the deadline in ms the account read missed.
  - `SeatReason` member `{ kind: 'noAnswer'; after: number }`; `fixOf` answers `{ kind: 'runtime', runtime }` for it.
  - `durationWords(ms: number): string`.
  - `HostOptions.seatReadDeadlineMs?: number`.
  - `offersFor(ctx, candidates)` unchanged in signature; Task 4 changes what it returns.

- [ ] **Step 1: Write the failing test for the deadline itself**

Create `packages/server/test/seat-reads.test.ts`:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SEAT_READ_DEADLINE_MS, within } from '../src/seat-reads.js'

/**
 * One read, held to a deadline. Three answers, because three different things
 * happened: it answered, it failed, or it was not waited for.
 */

test('a read that answers in time is its answer', async () => {
  assert.deepEqual(await within(async () => 7, 1_000), { settled: 'value', value: 7 })
})

test('a read that fails in time is its failure, not a late read', async () => {
  const read = await within(async () => {
    throw new Error('refused')
  }, 1_000)
  assert.equal(read.settled, 'error')
  assert.equal(read.settled === 'error' && (read.error as Error).message, 'refused')
})

test('a read that throws before it is a promise is a failure too', async () => {
  const read = await within((): Promise<number> => {
    throw new Error('at once')
  }, 1_000)
  assert.equal(read.settled, 'error')
})

test('a read that never answers is let go at the deadline', async () => {
  const started = Date.now()
  assert.deepEqual(await within(() => new Promise<never>(() => {}), 25), { settled: 'late' })
  const took = Date.now() - started
  assert.ok(took >= 20 && took < 1_000, `let go after ${took} ms`)
})

test('the deadline a seating uses is ten seconds', () => {
  assert.equal(SEAT_READ_DEADLINE_MS, 10_000)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/seat-reads.js' or its corresponding type declarations`.

- [ ] **Step 3: Write the deadline**

Create `packages/server/src/seat-reads.ts`:

```ts
/**
 * The reads a seating makes before it chooses, held to a deadline.
 *
 * A seating asks each runtime it names whether it is signed in and what it
 * offers, and asks the desk what is left of each plan. Any of those can fail
 * to answer at all — a bridge wedged on a login shell, an agent that swallowed
 * a request — and a read nobody bounds holds the seating, and every menu drawn
 * from a dry run of it, open for as long as that runtime stays silent.
 *
 * None of these calls takes a signal, so a late read is not cancelled. It is
 * only no longer waited for; whatever it answers afterwards is dropped.
 */

/** How long one read before choosing may take: long enough for a CLI that shells out, short enough for a menu. */
export const SEAT_READ_DEADLINE_MS = 10_000

/** What became of one read: its answer, its failure, or the deadline first. */
export type Within<T> =
  | { readonly settled: 'value'; readonly value: T }
  | { readonly settled: 'error'; readonly error: unknown }
  | { readonly settled: 'late' }

export const within = async <T>(read: () => Promise<T>, ms: number): Promise<Within<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Within<T>>((resolve) => {
    timer = setTimeout(() => resolve({ settled: 'late' }), ms)
  })
  // Started inside a promise, so a read that throws before it is one is a failure like any other.
  const answered = Promise.resolve()
    .then(read)
    .then(
      (value): Within<T> => ({ settled: 'value', value }),
      (error: unknown): Within<T> => ({ settled: 'error', error }),
    )
  try {
    return await Promise.race([answered, late])
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/seat-reads.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing tests for the seating**

In `packages/server/test/agent-seat.test.ts`:

1. Add two fields to `interface Pretend`:

```ts
  /** Asked whether it is signed in, it never answers. */
  readonly accountHangs?: boolean
  /** Asked for its models, it never answers. */
  readonly modelsHang?: boolean
```

2. In `pretendRuntime`, make both reads honour them — replace the `getAccount`, `listModels` and `knownModels` members with:

```ts
    getAccount: async () => {
      if (pretend.accountHangs) return new Promise<never>(() => {})
      if (pretend.accountFails) throw new Error('the account endpoint timed out')
      return { accounts: pretend.signedOut ? [] : [{ kind: 'apiKey', label: 'key' }], signInMethods: [] }
    },
    listModels: async () => {
      if (pretend.modelsHang) return new Promise<never>(() => {})
      if (pretend.modelsFail) throw new Error('the catalogue did not load')
      return pretend.modelsUnknown ? [] : catalogue
    },
    ...(pretend.modelsUnknown !== undefined
      ? {
          knownModels: async () => {
            if (pretend.modelsHang) return new Promise<never>(() => {})
            return pretend.modelsUnknown ? null : catalogue
          },
        }
      : {}),
```

3. Give `rig`'s `options` parameter three more fields:

```ts
    /** Asked for usage, the desk never answers. */
    readonly usageHangs?: boolean
    /** The last readings the desk already holds, by runtime. */
    readonly cached?: readonly UsageReport[]
    /** How long each read before choosing may take. A second unless a test says otherwise. */
    readonly deadlineMs?: number
```

4. In `rig`, declare `const warned: string[] = []` beside `created`, and replace the context's `usage` line with these three members:

```ts
    options: { seatReadDeadlineMs: options.deadlineMs ?? 1_000 },
    logger: { warn: (message: string) => warned.push(message) },
    usage: () => ({
      reports: async () => (options.usageHangs ? new Promise<never>(() => {}) : (options.reports ?? [])),
      cached: (id: string) => (options.cached ?? []).find((one) => String(one.runtime) === id) ?? null,
    }),
```

and add `warned` to the object `rig` returns.

5. Append the tests:

```ts
/*
 * The reads a seating makes before it chooses, each held to a deadline. A
 * runtime that never answers would otherwise hold the seating — and every menu
 * drawn from a dry run — open for ever.
 */

test('a runtime that never says whether it is signed in is passed over, and the next candidate is seated', async () => {
  const started = Date.now()
  const seen = await rig(
    'mute=m1, claude=opus-5',
    { mute: { models: ['m1'], accountHangs: true }, claude: { models: ['opus-5'] } },
    { deadlineMs: 30 },
  )
  await agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(seen.created, [{ runtime: 'claude', model: 'opus-5', cwd: '/tmp/x' }])
  assert.ok(Date.now() - started < 2_000, 'the silent runtime was not waited for')
})

test('when the only candidate never answers, the refusal says so and nothing is opened', async () => {
  const seen = await rig('mute=m1', { mute: { models: ['m1'], accountHangs: true } }, { deadlineMs: 30 })
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(
        error.message,
        'No seat could be opened for this Agent:\n' +
          '  mute=m1 — mute did not answer within 30 ms when asked whether it is signed in',
      )
      return true
    },
  )
  untouched(seen)
})

test('a model list that never arrives is unread, and a candidate that names no model is still seated', async () => {
  const named = await rig('slow=m1', { slow: { models: ['m1'], modelsHang: true } }, { deadlineMs: 30 })
  await assert.rejects(
    () => agentMethods['agent/seat'](named.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    /slow=m1 — cannot tell whether slow offers m1: its model list could not be read$/,
  )
  untouched(named)
  const bare = await rig('slow', { slow: { models: ['m1'], modelsHang: true } }, { deadlineMs: 30 })
  await agentMethods['agent/seat'](bare.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(bare.created, [{ runtime: 'slow', cwd: '/tmp/x' }])
})

test('usage that never arrives holds no seating: the last reading stands in, and the log says so', async () => {
  const seen = await rig(
    'spent=m1, claude=opus-5',
    { spent: { models: ['m1'] }, claude: { models: ['opus-5'] } },
    { deadlineMs: 30, usageHangs: true, cached: [reportFor('spent', [{ usedPercent: 100 }])] },
  )
  await agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  // Spent by the last reading, so passed over; claude has no reading, so is not known to be spent.
  assert.deepEqual(seen.created, [{ runtime: 'claude', model: 'opus-5', cwd: '/tmp/x' }])
  assert.deepEqual(seen.warned, ['a seating read no usage within its deadline, so the last readings stand in'])
})
```

- [ ] **Step 6: Run them to see them fail**

Run: `pnpm run build:node && node --test --test-reporter=spec --test-timeout=5000 packages/server/dist/test/agent-seat.test.js`
Expected: FAIL. On the unfixed code the two account tests, the model-list test and the usage test never return, and each is reported failing with `test timed out after 5000ms`. That timeout is the defect: the seating waits on a runtime that never answers.

- [ ] **Step 7: Give silence a reason, and the offers a deadline**

1. In `packages/protocol/src/agent.ts`, add a member to `SeatReason`, after `unavailable`:

```ts
  /** Asked whether it is signed in, it did not answer within `after` milliseconds, and was not waited for. */
  | { readonly kind: 'noAnswer'; readonly after: number }
```

2. In `packages/server/src/agent-seating.ts`:

   - In `interface SeatOffer`, after `unavailable`, add:

```ts
  /**
   * Asked whether it is signed in, it did not answer within this many
   * milliseconds, so nothing else about it is known. Not `unavailable`: that
   * is a runtime saying what is wrong with it, and this is one saying nothing.
   */
  readonly silent?: number | null
```

   - Add, above `reasonAgainst`:

```ts
/** A deadline, in the unit a person would say it. */
export const durationWords = (ms: number): string => {
  if (ms < 1_000) return `${ms} ms`
  const seconds = Math.round(ms / 1_000)
  return seconds === 1 ? '1 second' : `${seconds} seconds`
}
```

   - In `reasonAgainst`, after the `unavailable` line, add:

```ts
  if (offer.silent) return { kind: 'noAnswer', after: offer.silent }
```

   - In `sentenceOf`, add the case:

```ts
    case 'noAnswer':
      return `${runtime} did not answer within ${durationWords(reason.after)} when asked whether it is signed in`
```

   - In `fixOf`, add `case 'noAnswer':` to the group that answers `{ kind: 'runtime', runtime }`.

3. In `packages/server/src/host.ts`, in `interface HostOptions`, after `sendAcceptDeadlineMs`, add:

```ts
  /**
   * How long each read a seating makes before it chooses may take — an
   * account, a model list, the usage. See `SEAT_READ_DEADLINE_MS`.
   */
  readonly seatReadDeadlineMs?: number
```

4. In `packages/server/src/methods/agents.ts`:

   - Add the imports:

```ts
import { SEAT_READ_DEADLINE_MS, within } from '../seat-reads.js'
```

   (`AgentRuntime` and `UsageReport` are already imported from `@harnessdesk/protocol` there.)

   - Replace `offersFor`, `offerOf` and `modelsOf` with:

```ts
const offersFor = async (ctx: HostContext, candidates: readonly FlowSeat[]): Promise<SeatOffer[]> => {
  const runtimes = [...new Set(candidates.map((one) => one.runtime))].flatMap((id) => {
    const runtime = ctx.runtimes.get(id)
    return runtime ? [runtime] : []
  })
  if (runtimes.length === 0) return []
  const deadline = ctx.options.seatReadDeadlineMs ?? SEAT_READ_DEADLINE_MS
  const reports = await usageWithin(ctx, runtimes, deadline)
  return Promise.all(runtimes.map((runtime) => offerOf(ctx, runtime, reports, deadline)))
}

/**
 * The usage each runtime reports, within the deadline — or, past it, the last
 * reading the desk already holds for it.
 *
 * Usage is read for every runtime at once, so one silent source would hold
 * every seating. A window the desk cannot read now is one the runtime states
 * again on the first turn, and the last reading is still a reading; a runtime
 * with none is not known to be spent, exactly as before a reading exists.
 */
const usageWithin = async (
  ctx: HostContext,
  runtimes: readonly AgentRuntime[],
  deadline: number,
): Promise<readonly UsageReport[]> => {
  const read = await within(() => ctx.usage().reports(), deadline)
  if (read.settled === 'value') return read.value
  ctx.logger.warn('a seating read no usage within its deadline, so the last readings stand in')
  return runtimes.flatMap((runtime) => {
    const last = ctx.usage().cached(runtime.info.id)
    return last ? [last] : []
  })
}

const offerOf = async (
  ctx: HostContext,
  runtime: AgentRuntime,
  reports: readonly UsageReport[],
  deadline: number,
): Promise<SeatOffer> => {
  const id = String(runtime.info.id)
  const health = runtime.health()
  // Nothing else is read about a runtime that cannot open a conversation; the chooser stops at why.
  const unread = { models: null, efforts: null, signedIn: false, spent: false }
  /* Added, and its program is missing. Offered with that said rather than
     dropped: a runtime nobody added is fixed by adding it, and this one by
     installing what it runs, and only an offer can carry the difference. */
  if (health.state === 'unavailable' && health.reason === 'notInstalled') {
    return { runtime: id, notInstalled: true, ...unread }
  }
  if (health.state === 'unavailable') {
    const why = health.remediation ? `${health.message} ${health.remediation}` : health.message
    return { runtime: id, unavailable: why, ...unread }
  }
  if (health.state === 'starting') return { runtime: id, unavailable: 'it is still starting', ...unread }

  let signedIn = true
  // An agent that keeps its own credential is never asked to sign in here.
  if (ctx.runtimes.infoOf(runtime).capabilities.account !== false) {
    const account = await within(() => runtime.getAccount(), deadline)
    if (account.settled === 'late') return { runtime: id, silent: deadline, ...unread }
    if (account.settled === 'error') {
      return { runtime: id, unavailable: `its account could not be read — ${messageOf(account.error)}`, ...unread }
    }
    signedIn = account.value.accounts.length > 0
  }
  const report = reports.find((one) => one.runtime === runtime.info.id)
  return {
    runtime: id,
    models: await modelsOf(runtime, deadline),
    efforts: null,
    signedIn,
    spent: report ? isBlocked(report) : false,
  }
}

/**
 * The ids of the models a runtime offers, or null when it could not say —
 * failing, or not saying within the deadline, which is the same "could not
 * say" to the chooser.
 *
 * `listModels` is the picker's question, and a picker would rather draw nothing
 * than an error: the ACP adapter answers it with an empty list when its agent
 * never managed to declare a catalogue. To the chooser empty is "offers none",
 * so a runtime that can tell the two apart is asked the way that does
 * (`knownModels`); any other is asked `listModels`.
 */
const modelsOf = async (runtime: AgentRuntime, deadline: number): Promise<readonly string[] | null> => {
  const read = await within(() => (runtime.knownModels ? runtime.knownModels() : runtime.listModels()), deadline)
  if (read.settled !== 'value') return null
  return read.value?.map((one) => one.id) ?? null
}
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/seat-reads.test.js packages/server/dist/test/agent-seat.test.js packages/server/dist/test/agent-seating.test.js`
Expected: PASS — `seat-reads.test.js` 5 tests, `agent-seat.test.js` 41 tests (37 + 4), `agent-seating.test.js` 25 tests; 0 failures, 0 cancelled. The whole file finishes in seconds, not at the test timeout.

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/protocol/src/agent.ts packages/server/src/seat-reads.ts packages/server/src/agent-seating.ts packages/server/src/host.ts packages/server/src/methods/agents.ts packages/server/test/seat-reads.test.ts packages/server/test/agent-seat.test.ts
git commit -m "fix(agents): a runtime that never answers is passed over, not waited for

Seating asked each runtime for its account and its models, and the desk for
everyone's usage, and waited for all of it. One silent bridge held the seating
open for good. Each read now has ten seconds: an account that does not answer
passes the candidate over with that reason, a model list that does not arrive
is unread, and usage that does not arrive is replaced by the last reading.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 3: A passed-over seat leaves nothing behind

A candidate that opens and is then passed over — it runs another model or effort than asked, or broke part-way through opening — is closed and let go by `#retireSeat`, and that is all. What it leaves (`SEAT_PREFERENCE_LIMIT`'s own docstring says so) is: an empty conversation in the runtime's history; the Agent's name for it in the desk's `names.json`; the host's registry record, which a reconnecting window receives in `sync`; and a row in every open window's sidebar, because each window took it into `snapshot.sessions` from the conversation's `session/started` and `SessionTree` draws every such session the history does not list (`liveRows` in `useProjectGroups`).

This task adds `#discardSeat`: close, let go, remove where the runtime keeps it, forget everything the desk holds, and tell every window (`session/removed`). What "remove where the runtime keeps it" can honestly mean differs per runtime:

| Runtime | How | What is left |
| --- | --- | --- |
| **Codex** (`deleteHistory: true`) | `thread/delete` through the app server | Nothing. The thread is erased from Codex's own history — erased, not moved to the Trash, which is Codex's delete. Nothing a person wrote is lost: the brief goes only to the seat that is kept, so a passed-over thread never took a message. |
| **Claude Code** (`claude-acp`, declares `deleteSession`) | `_harnessdesk/session/delete` | Nothing. Claude Code writes a transcript only when a conversation takes its first message, so an unprompted seat has none; the bridge drops its own per-session options entry, and anything that does exist for the id goes to the Trash (`packages/claude-acp/src/store.ts`). |
| **Cursor** (`cursor-acp`, declares `deleteSession`) | `_harnessdesk/session/delete` | Nothing. The chat `create-chat` minted was never in the bridge's index (a chat is indexed on its first prompt); its folder in Cursor's store goes to the Trash if Cursor wrote one, and the bridge's scratch and per-chat configuration directories are removed. |
| **Every other ACP runtime** — Gemini CLI, OpenClaw, Hermes, anything added from the registry (`deleteHistory: false`) | None exists: ACP has no delete, and only a bridge that knows the agent's store can offer one | Possibly an empty conversation in the agent's own history — the desk cannot tell whether the agent recorded a session that never took a message. The desk forgets everything it holds and archives the conversation (in the runtime's own archive if it has one, the desk's otherwise), so that if the agent did record it, it does not come back as a row. The refusal and the kept seat's record say so, for that candidate. |
| **A runtime that is asked and refuses** | — | Whatever it kept, in its own words: the passed-over line says the conversation could not be deleted, and why. |

The same discard applies when a seat fails part-way through opening (`#openSeat`'s own failure path), because a conversation that broke while opening is passed over too. That path is shared with the flow engine, so a flow seat that breaks while opening is now discarded instead of only closed; nothing else in a flow changes. A seat whose **brief could not be handed over** is still only closed (`retire`): the brief may have reached it, and deleting a conversation that may hold the start of a turn is not the desk's call.

**Files:**
- Modify: `packages/protocol/src/agent.ts` (add `SeatLeft`)
- Modify: `packages/protocol/src/wire.ts` (notification `session/removed`)
- Modify: `packages/server/src/agent-seating.ts` (`PassedOver.left`, `leftWords`, `explainRefusal`)
- Modify: `packages/server/src/host.ts` (`#discardSeat`, `#openSeat`'s failure path, `seats.discard` in the context)
- Modify: `packages/server/src/methods/context.ts` (`seats.discard`)
- Modify: `packages/server/src/methods/agents.ts` (`openAsAsked` discards)
- Modify: `packages/server/src/methods/sessions.ts` (`session/delete` tells every window too)
- Modify: `packages/ui/src/state/store.ts` (drop a removed conversation)
- Test: `packages/server/test/agent-seat.test.ts`, `packages/ui/src/state/store.sessions.test.ts`

**Interfaces:**
- Consumes: `passedFor`, `sentenceOf` (Task 1); `#letGo`, `#archive`, `#names`, `#transcripts`, `registry` (host).
- Produces:
  - `type SeatLeft = { kind: 'kept' } | { kind: 'undeleted'; detail: string }` (`@harnessdesk/protocol`).
  - `PassedOver.left?: SeatLeft | null`; `leftWords(runtime: string, left: SeatLeft): string`.
  - `HostContext['seats']['discard'](runtime: string, sessionId: string): Promise<SeatLeft | null>`.
  - Notification `{ method: 'session/removed'; params: { runtime: RuntimeId; sessionId: SessionId } }`, pushed by the discard and by `session/delete`.

- [ ] **Step 1: Let the seat fake be a second runtime, one that cannot delete**

In `packages/server/test/agent-seat.test.ts`:

1. Add `type RuntimeCapabilities` and `type RuntimeId` to the `@harnessdesk/protocol` import.
2. Give `SeatFake` a constructor that takes an id and capability overrides — replace its constructor with:

```ts
  constructor(identity: { readonly id?: string; readonly capabilities?: Partial<RuntimeCapabilities> } = {}) {
    super({
      id: runtimeId(identity.id ?? 'seatfake'),
      name: 'Seat Fake',
      ...(identity.capabilities ? { capabilities: identity.capabilities } : {}),
    })
    // The name a label is built from; the base fixture's is fixed.
    const info = this.info
    ;(this as { info: RuntimeInfo }).info = { ...info, presentation: { ...info.presentation, name: 'Seat Fake' } }
  }
```

3. Make `SeatSession` belong to whichever fake opened it — replace `readonly runtime = runtimeId('seatfake')` with `readonly runtime: RuntimeId`, and make the first line of its constructor body `this.runtime = owner.info.id`.

- [ ] **Step 2: Write the failing tests**

1. In `rig`, give the context's `seats` a `discard` beside `retire`, recording into a `discarded` list as well as `retired` (a discarded seat is closed too), and add `leaves` to the rig's options. Declare `const discarded: string[] = []` beside `retired`, add `discarded` to what `rig` returns, add this to `rig`'s options type:

```ts
    /** What a discarded seat leaves behind, per runtime; nothing unless a test says so. */
    readonly leaves?: (runtime: string) => SeatLeft | null
```

(import `type SeatLeft` from `@harnessdesk/protocol`), and add to `seats`:

```ts
      discard: async (runtime: string, id: string): Promise<SeatLeft | null> => {
        await new Promise((resolve) => setImmediate(resolve))
        alive -= 1
        retired.push(`${runtime} ${id}`)
        discarded.push(`${runtime} ${id}`)
        return options.leaves?.(runtime) ?? null
      },
```

2. Append the tests:

```ts
/*
 * A seat passed over leaves nothing behind: not in the runtime's history, not
 * in the desk's records, not as a row in any window. What a runtime cannot
 * remove is said, on the candidate's own line.
 */

test('a seat passed over once open is discarded, not merely closed; one whose brief may have arrived is only closed', async () => {
  const passed = await rig('claude=opus-5/high, claude=sonnet-5/high', { claude: { models: ['opus-5', 'sonnet-5'] } }, {
    comesBackAs: (seat) => (seat.model === 'opus-5' ? { effort: 'medium' } : {}),
  })
  await agentMethods['agent/seat'](passed.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(passed.discarded, ['claude s1'])

  const ordered = await rig('claude=opus-5/high', { claude: { models: ['opus-5'] } }, { orderFails: 'Claude is not running.' })
  await assert.rejects(() => agentMethods['agent/seat'](ordered.ctx, { id: 'reviewer', cwd: '/tmp/x' }))
  assert.deepEqual(ordered.retired, ['claude s1'])
  assert.deepEqual(ordered.discarded, [], 'a brief may have reached it, so it is not the desk’s to delete')
})

test('what a runtime could not remove is said on its own line of the refusal', async () => {
  const seen = await rig('claude=opus-5/high', { claude: { models: ['opus-5'] } }, {
    comesBackAs: () => ({ effort: 'medium' }),
    leaves: () => ({ kind: 'kept' }),
  })
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(
        error.message,
        'No seat could be opened for this Agent:\n' +
          "  claude=opus-5/high — claude runs it at medium effort, not high (the conversation it opened stays in claude's own history, which it cannot delete from; it is archived here)",
      )
      return true
    },
  )
})

test('through the host: a seat passed over is deleted where its runtime keeps it, forgotten by the desk, and dropped from every window', async (t) => {
  const { harness, seats, client, work } = await desk(t)
  await writeReviewer(harness.stateDir, 'seatfake=small/high, seatfake=big/high')

  const session = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  const [passed, kept] = seats.opened
  assert.ok(passed && kept && seats.opened.length === 2)
  assert.equal(String(kept.id), String(session.id))
  // Where the runtime keeps it…
  assert.deepEqual(seats.deleted, [String(passed.id)])
  // …and everything the desk held: its record, and the name it was given.
  assert.equal(harness.host.registry.get(runtimeId('seatfake'), passed.id), undefined)
  const names = await readFile(join(harness.stateDir, 'names.json'), 'utf8').catch(() => '')
  assert.equal(names.includes(String(passed.id)), false, 'the name the seat was given is gone')
  // …and every window, which took it in from its session/started.
  await client.until(
    () =>
      client.notifications.some(
        (one) => 'method' in one && one.method === 'session/removed' && String(one.params.sessionId) === String(passed.id),
      ),
    2_000,
    'session/removed for the seat passed over',
  )
  // The kept seat is untouched.
  assert.ok(harness.host.registry.get(runtimeId('seatfake'), kept.id))
})

test('through the host: a runtime that cannot delete keeps what it keeps, archived, and the refusal says so', async (t) => {
  const { harness, client, work } = await desk(t)
  const keeper = new SeatFake({ id: 'keeper', capabilities: { deleteHistory: false, archiveHistory: false } })
  harness.host.register(keeper)
  await keeper.start()
  await writeReviewer(harness.stateDir, 'keeper=small/high')

  await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work }), (error: Error) => {
    assert.equal(
      error.message,
      'No seat could be opened for this Agent:\n' +
        "  keeper=small/high — keeper runs it at medium effort, not high (the conversation it opened stays in keeper's own history, which it cannot delete from; it is archived here)",
    )
    return true
  })
  const [opened] = keeper.opened
  assert.ok(opened)
  assert.deepEqual(keeper.deleted, [], 'nothing was asked of a runtime that cannot delete')
  const archive = JSON.parse(await readFile(join(harness.stateDir, 'archive.json'), 'utf8')) as {
    entries: { runtime: string; sessionId: string }[]
  }
  assert.deepEqual(
    archive.entries.map((one) => [one.runtime, one.sessionId]),
    [['keeper', String(opened.id)]],
  )
  assert.equal(harness.host.registry.get(runtimeId('keeper'), opened.id), undefined)
})
```

3. Append to `packages/ui/src/state/store.sessions.test.ts`:

```ts
describe('a conversation the host removed', () => {
  it('leaves this window: its row, its queue and its background tasks', () => {
    const handlers = (store.transport as unknown as {
      handlers: {
        onEvent(runtime: RuntimeId, event: AgentEvent): void
        onNotification(notification: unknown): void
      }
    }).handlers
    handlers.onEvent(RUNTIME, { type: 'session/started', session: session({ title: 'Code reviewer' }) })
    expect(store.getSnapshot().sessions.has(KEY)).toBe(true)

    handlers.onNotification({ method: 'session/removed', params: { runtime: RUNTIME, sessionId: ID } })

    expect(store.getSnapshot().sessions.has(KEY)).toBe(false)
    expect(store.getSnapshot().queues.has(KEY)).toBe(false)
    expect(store.getSnapshot().tasks.has(KEY)).toBe(false)
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Module '"@harnessdesk/protocol"' has no exported member 'SeatLeft'`.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/state/store.sessions.test.ts`
Expected: FAIL — `a conversation the host removed › leaves this window…`: `expected true to be false`.

- [ ] **Step 4: Add the type and the notification**

1. Append to `packages/protocol/src/agent.ts`:

```ts
/**
 * What a seat passed over after opening may have left behind, where the desk
 * could not remove all of it. Null (on `PassedOver.left`) when nothing is.
 */
export type SeatLeft =
  /**
   * The runtime keeps its own history and offers no way to remove a
   * conversation from it. Whether it recorded one that never took a message
   * the desk cannot tell; it archived it, so a row does not come back.
   */
  | { readonly kind: 'kept' }
  /** The runtime was asked to delete it, and refused, in these words. */
  | { readonly kind: 'undeleted'; readonly detail: string }
```

2. In `packages/protocol/src/wire.ts`, add a member to `WireNotification`, after `runtime/removed`:

```ts
  | {
      /**
       * A conversation the host no longer holds and no window should draw:
       * deleted, or opened for a seat and passed over. Without this a window
       * kept the row the conversation's `session/started` gave it until it was
       * reloaded — and a reload brought it back from the host's own record.
       */
      readonly method: 'session/removed'
      readonly params: { readonly runtime: RuntimeId; readonly sessionId: SessionId }
    }
```

- [ ] **Step 5: Say what was left, in the refusal**

In `packages/server/src/agent-seating.ts`:

1. Add `SeatLeft` to the `@harnessdesk/protocol` type import.
2. Add to `interface PassedOver`:

```ts
  /** What its opening left behind that could not be removed; absent or null when nothing is. */
  readonly left?: SeatLeft | null
```

3. Add, above `explainRefusal`:

```ts
/** What a passed-over seat left behind, as a clause of its line. */
export const leftWords = (runtime: string, left: SeatLeft): string =>
  left.kind === 'kept'
    ? `the conversation it opened stays in ${runtime}'s own history, which it cannot delete from; it is archived here`
    : `the conversation it opened could not be deleted: ${quoted(left.detail)}`
```

4. In `explainRefusal`, replace the `lines` line with:

```ts
  const lines = passed.map(
    (one) => `  ${seatSpec(one.seat)} — ${one.why}${one.left ? ` (${leftWords(one.seat.runtime, one.left)})` : ''}`,
  )
```

- [ ] **Step 6: Discard in the host**

In `packages/server/src/host.ts`:

1. Add `type SeatLeft` to the `@harnessdesk/protocol` import.
2. Add, after `#retireSeat`:

```ts
  /**
   * Takes a seat a seating opened and passed over out of the world: closed,
   * let go, removed where its runtime keeps it, forgotten by the desk, and
   * dropped from every window. Answers what could not be removed, or null.
   *
   * What "removed" means is the runtime's. One that can delete is asked to:
   * Codex erases the thread from its own history, and the Claude Code and
   * Cursor bridges move whatever their agent wrote to the Trash — for a
   * conversation that never took a message, nothing but the bridge's own
   * bookkeeping. Nothing a person wrote is lost either way, because the brief
   * goes only to the seat that is kept.
   *
   * One that cannot has no way in to its own store from here, and the desk
   * cannot tell whether it recorded a conversation nobody spoke in. So the
   * desk forgets what it holds and archives the conversation — in the
   * runtime's own archive when it has one, the desk's otherwise — so that if
   * it was recorded it does not come back as a row, and says so.
   */
  async #discardSeat(runtime: RuntimeId, id: SessionId, live?: AgentSession | null): Promise<SeatLeft | null> {
    const owner = this.#runtimes.get(runtime)
    await this.#letGo(runtime, id, live === undefined ? this.registry.get(runtime, id)?.live : live)
    let left: SeatLeft | null = null
    if (owner?.info.capabilities.deleteHistory) {
      try {
        await owner.deleteSession(id)
      } catch (error) {
        left = { kind: 'undeleted', detail: describeError(error) }
        this.#logger.warn('a seat passed over could not be deleted where its runtime keeps it', {
          runtime: String(runtime),
          session: String(id),
          error: describeError(error),
        })
      }
    } else if (owner) {
      left = { kind: 'kept' }
      try {
        if (owner.info.capabilities.archiveHistory) await owner.archiveSession(id, true)
        else await this.#archive.set(runtime, id, true)
      } catch (error) {
        this.#logger.warn('a seat passed over could not be archived', {
          runtime: String(runtime),
          session: String(id),
          error: describeError(error),
        })
      }
    }
    await this.#transcripts.forget(runtime, id)
    // The archive mark is what hides a kept one; only a deleted one loses it.
    if (left === null) await this.#archive.forget(runtime, id)
    await this.#names.forget(runtime, id)
    this.registry.delete(runtime, id)
    this.#push({ method: 'session/removed', params: { runtime, sessionId: id } })
    return left
  }
```

3. In `#openSeat`, replace the `catch` block

```ts
    } catch (error) {
      await this.#letGo(runtime.info.id, live.id, live)
      throw error
    }
```

with

```ts
    } catch (error) {
      // Passed over part-way through opening, so discarded like any other seat passed over.
      await this.#discardSeat(runtime.info.id, live.id, live).catch(() => null)
      throw error
    }
```

and in `#openSeat`'s docstring replace "A conversation that opened and then failed on the way to being handed back is closed here" with "A conversation that opened and then failed on the way to being handed back is discarded here (`#discardSeat`)".

4. In `#buildContext`, add to `seats`, after `retire`:

```ts
        discard: (runtime, sessionId) => this.#discardSeat(runtime as RuntimeId, makeSessionId(sessionId)),
```

5. In `packages/server/src/methods/context.ts`, add `SeatLeft` to the `@harnessdesk/protocol` type import and add to `seats`, after `retire`:

```ts
    /**
     * Takes a seat a seating opened and passed over out of the world: closed,
     * let go, deleted where its runtime keeps it, forgotten by the desk, and
     * dropped from every window. Answers what could not be removed, or null.
     */
    discard(runtime: string, sessionId: string): Promise<SeatLeft | null>
```

- [ ] **Step 7: Discard from the seating, and tell every window on a delete**

1. In `packages/server/src/methods/agents.ts`, in `openAsAsked`, replace

```ts
  await ctx.seats.retire(opened.runtime, opened.sessionId)
  return passedFor(seat, { kind: 'openedOtherwise', detail: found.join(', and ') })
```

with

```ts
  const left = await ctx.seats.discard(opened.runtime, opened.sessionId)
  return { ...passedFor(seat, { kind: 'openedOtherwise', detail: found.join(', and ') }), left }
```

2. In `packages/server/src/methods/sessions.ts`, in `'session/delete'`, after the `if (record) { … }` block and before `return`, add:

```ts
    // Every window, not only the one that asked: another may be drawing it.
    ctx.push({ method: 'session/removed', params: { runtime: runtime.info.id, sessionId: id } })
```

3. In `packages/ui/src/state/store.ts`, in the constructor's `onNotification`, after the `runtime/removed` block, add:

```ts
        if (notification.method === 'session/removed') {
          /* Deleted, or opened for a seat and passed over: either way nothing
             holds it now, and a window that kept it would draw a row the
             host can no longer answer for. */
          const key = sessionKey(notification.params.runtime, notification.params.sessionId)
          const sessions = new Map(this.#snapshot.sessions)
          const queues = new Map(this.#snapshot.queues)
          const tasks = new Map(this.#snapshot.tasks)
          sessions.delete(key)
          queues.delete(key)
          tasks.delete(key)
          this.#patch({
            sessions,
            queues,
            tasks,
            history: this.#snapshot.history.filter((entry) => sessionKey(entry.runtime, entry.id) !== key),
          })
        }
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-seat.test.js packages/server/dist/test/agent-seating.test.js packages/server/dist/test/archive.test.js`
Expected: PASS — `agent-seat.test.js` 45 tests (41 + 4), `agent-seating.test.js` 25, `archive.test.js` unchanged; 0 failures. `through the host: one seat at a time…` still passes: the seat lost part-way through opening is discarded, so the registry holds nothing for it.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/state/store.sessions.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/protocol/src/agent.ts packages/protocol/src/wire.ts packages/server/src/agent-seating.ts packages/server/src/host.ts packages/server/src/methods/context.ts packages/server/src/methods/agents.ts packages/server/src/methods/sessions.ts packages/server/test/agent-seat.test.ts packages/ui/src/state/store.ts packages/ui/src/state/store.sessions.test.ts
git commit -m "fix(agents): a seat passed over leaves nothing behind

A candidate that opened and was passed over was only closed: its empty
conversation stayed in the runtime's history, its name in the desk's, its
record in the host, and a row in every window's sidebar. It is now deleted
where the runtime can delete — Codex erases it, the Claude Code and Cursor
bridges trash whatever exists — and forgotten by the desk, and every window is
told to drop it. A runtime that cannot delete has it archived, and the refusal
says the agent may still keep it. A seat whose brief may have arrived is still
only closed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 4: `agent/seat/dry` — which seat would win here, opening nothing

Every menu that lists Agents (Tasks 13–20) is drawn from this: for each Agent, every candidate in order, whether it would be taken, passed over or never reached, the reason and fix of each one passed over, and the seat in words (*Claude · Opus 5 · High*) — the runtime by the name the desk calls it, even when nothing by that id is added, and the model and effort by the labels the runtime gave them. One read of the desk serves every Agent asked about, so the menus do not ask each runtime once per Agent.

A dry run can only know what is knowable before opening. A candidate it calls *taken* can still be passed over by the real seating once open — the model or effort it runs is read back then — and the real call's refusal (Task 5) carries that too.

**Files:**
- Modify: `packages/protocol/src/agent.ts` (add `SeatCandidate`, `SeatPlan`)
- Modify: `packages/protocol/src/wire.ts`, `packages/protocol/src/wire-validators.ts` (`agent/seat/dry`)
- Modify: `packages/server/src/agent-seating.ts` (`SeatWords`, `describeSeat`, `effortWord`, `planSeats`, `blockedPlan`)
- Modify: `packages/server/src/methods/agents.ts` (`readDesk` replaces `offersFor`, `wordsFor`, `unusable`, the verb)
- Modify: `script/check-reachable.mjs` (pin the verb until Part B calls it)
- Test: `packages/server/test/agent-seating.test.ts`, `packages/server/test/agent-seat.test.ts`

**Interfaces:**
- Consumes: `chooseSeat`, `fixOf` (Task 1); `within`, `SEAT_READ_DEADLINE_MS` (Task 2); `knownAgent` (`packages/server/src/installs/known-agents.ts`).
- Produces:
  - `interface SeatCandidate { seat: FlowSeat; label: string; runtimeName: string; state: 'taken' | 'passed' | 'untried'; reason: SeatReason | null; fix: SeatFix | null; left?: SeatLeft | null }`
  - `interface SeatPlan { id: AgentId; from: 'prefer' | 'machine'; candidates: readonly SeatCandidate[]; winner: number | null; blocked: string | null }`
  - `'agent/seat/dry': { params: { ids?: readonly string[]; project?: string }; result: readonly SeatPlan[] }`
  - `interface SeatWords { runtime(id: string): string; model(runtime: string, model: string): string; effort(runtime: string, model: string | null | undefined, effort: string): string }`, `describeSeat(seat, words): string`, `effortWord(effort: string): string`, `planSeats(id, candidates, offers, words, from = 'prefer'): SeatPlan`, `blockedPlan(id, why, from = 'prefer'): SeatPlan`, `candidateOf(one: PassedOver, words): SeatCandidate` (all in `agent-seating.ts`).
  - In `methods/agents.ts`: `readDesk(ctx, candidates): Promise<Desk>` with `Desk = { offers: readonly SeatOffer[]; catalogues: ReadonlyMap<string, readonly ModelInfo[]> }`, `wordsFor(ctx, catalogues): SeatWords`, `unusable(entry: AgentEntry): string`.

- [ ] **Step 1: Write the failing tests**

1. Append to `packages/server/test/agent-seating.test.ts` (import `describeSeat`, `effortWord` and `type SeatWords` from `'../src/agent-seating.js'`):

```ts
/** Words as a desk that knows each runtime's name and the model's labels would give them. */
const words: SeatWords = {
  runtime: (id) => ({ claude: 'Claude', cursor: 'Cursor' })[id] ?? id,
  model: (_runtime, model) => ({ 'opus-5': 'Opus 5' })[model] ?? model,
  effort: (_runtime, _model, effort) => effortWord(effort),
}

test('a seat is said in words: the runtime by its name, the model and effort by their labels, never the spec', () => {
  assert.equal(describeSeat(written('claude=opus-5/high'), words), 'Claude · Opus 5 · High')
  assert.equal(describeSeat(written('claude=opus-5/xhigh+thinking'), words), 'Claude · Opus 5 · Extra high · thinking')
  assert.equal(describeSeat(written('cursor'), words), 'Cursor')
  // An effort nobody has a word for is said as written, never dropped.
  assert.equal(effortWord('turbo'), 'turbo')
  assert.equal(effortWord('constructor'), 'constructor')
})
```

2. In `packages/server/test/agent-seat.test.ts`:

   - Add `type ModelInfo` and `type SeatPlan` to the `@harnessdesk/protocol` import.
   - Add to `interface Pretend`:

```ts
  /** What the desk calls it. Its id unless a test names it. */
  readonly name?: string
  /** The models it answers with, labels and all; built from `models` when absent. */
  readonly catalogue?: readonly ModelInfo[]
```

   - In `pretendRuntime`, build the catalogue from the override when given, and give the runtime a presentation:

```ts
  const catalogue: readonly ModelInfo[] =
    pretend.catalogue ??
    (pretend.models ?? []).map((one) => ({ id: one, displayName: one, reasoningLevels: [], supportsImages: false }))
  return {
    info: {
      id: runtimeId(id),
      capabilities: { account: pretend.keepsOwnAccount !== true },
      presentation: { name: pretend.name ?? id },
    },
```

   (the rest of `pretendRuntime` is unchanged).

   - Append the tests:

```ts
/*
 * The dry run: which seat would win here and why not the ones above it —
 * the reads a seating makes, and nothing it opens.
 */

test('the dry run says which seat would win here and why not the ones above it, and opens nothing', async () => {
  const seen = await rig('cursor=gemini-3.8-flash/high, claude=opus-5/high, codex/high', {
    cursor: { name: 'Cursor', models: ['gemini-3.8-flash'], signedOut: true },
    claude: {
      name: 'Claude',
      catalogue: [
        { id: 'opus-5', displayName: 'Opus 5', reasoningLevels: [{ id: 'high', label: 'High' }], supportsImages: true },
      ],
    },
  })
  const plans = await agentMethods['agent/seat/dry'](seen.ctx, { ids: ['reviewer'] })
  assert.deepEqual(plans, [
    {
      id: 'reviewer',
      from: 'prefer',
      winner: 1,
      blocked: null,
      candidates: [
        {
          seat: { runtime: 'cursor', model: 'gemini-3.8-flash', effort: 'high' },
          label: 'Cursor · gemini-3.8-flash · High',
          runtimeName: 'Cursor',
          state: 'passed',
          reason: { kind: 'signedOut' },
          fix: { kind: 'signIn', runtime: 'cursor' },
        },
        {
          seat: { runtime: 'claude', model: 'opus-5', effort: 'high' },
          label: 'Claude · Opus 5 · High',
          runtimeName: 'Claude',
          state: 'taken',
          reason: null,
          fix: null,
        },
        {
          // Nothing by this id is added and the desk knows no name for it, so its id is the last word left.
          seat: { runtime: 'codex', effort: 'high' },
          label: 'codex · High',
          runtimeName: 'codex',
          state: 'untried',
          reason: null,
          fix: null,
        },
      ],
    },
  ])
  untouched(seen)
})

test('no ids is every Agent in force; one that cannot be weighed says why; one nobody defined is named', async () => {
  const seen = await rig('claude=opus-5', { claude: { name: 'Claude', models: ['opus-5'] } })
  const brokenFile = join(seen.root, 'user', 'broken', 'AGENT.md')
  await mkdir(join(seen.root, 'user', 'broken'), { recursive: true })
  await writeFile(brokenFile, '---\npermission: admin\n---\nx\n', 'utf8')

  const plans = await agentMethods['agent/seat/dry'](seen.ctx, {})
  assert.deepEqual(
    plans.map((one) => [one.id, one.winner, one.blocked]),
    [
      ['broken', null, `${brokenFile} cannot be used: permission — "admin" is not a permission — it is read, publish or merge`],
      ['reviewer', 0, null],
    ],
  )
  assert.deepEqual(await agentMethods['agent/seat/dry'](seen.ctx, { ids: ['ghost'] }), [
    { id: 'ghost', from: 'prefer', candidates: [], winner: null, blocked: 'No Agent called “ghost”.' },
  ])
  untouched(seen)
})

test('through the host: a dry run opens nothing, and says each seat in the words the desk uses', async (t) => {
  const { harness, seats, client } = await desk(t)
  await writeReviewer(harness.stateDir, 'ghost=m1, seatfake=big/high')
  const plans = (await client.call('agent/seat/dry', { ids: ['reviewer'] })) as SeatPlan[]
  assert.equal(seats.opened.length, 0, 'nothing was opened')
  assert.deepEqual(
    plans[0]?.candidates.map((one) => [one.label, one.state, one.fix?.kind ?? null]),
    [
      ['ghost · m1', 'passed', 'add'],
      ['Seat Fake · Big · High', 'taken', null],
    ],
  )
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Property ''agent/seat/dry'' does not exist on type` the agent methods table, and `Module '"../src/agent-seating.js"' has no exported member 'describeSeat'`.

- [ ] **Step 3: Add the plan to the protocol**

1. Append to `packages/protocol/src/agent.ts`:

```ts
/** One candidate seat, as a dry run or a refusal shows it. */
export interface SeatCandidate {
  /** The seat as written, for the surface that edits this machine's seats. Never shown. */
  readonly seat: FlowSeat
  /** How it reads: "Claude · Opus 5 · High". The runtime's name and the runtime's own labels, never the spec. */
  readonly label: string
  /** The runtime as the desk calls it, even when nothing by that id is added here. */
  readonly runtimeName: string
  /** Would be taken, was passed over, or was never reached because one above it would be taken. */
  readonly state: 'taken' | 'passed' | 'untried'
  /** Why it was passed over; null unless `state` is `passed`. */
  readonly reason: SeatReason | null
  /** What removes the reason; null unless `state` is `passed`. */
  readonly fix: SeatFix | null
  /** What opening it left behind; only on a candidate passed over after it was opened. */
  readonly left?: SeatLeft | null
}

/**
 * Which seat an Agent would take here, and why not the others — the reads a
 * seating makes before it chooses, and nothing it opens. A candidate the plan
 * takes can still be passed over by the real seating once open, when what it
 * runs is read back; the plan knows only what is knowable before.
 */
export interface SeatPlan {
  readonly id: AgentId
  /**
   * Where the candidates came from: the Agent's own `prefer`, or this
   * machine's entry in `seating.json`, which replaces `prefer` here rather
   * than merging with it.
   */
  readonly from: 'prefer' | 'machine'
  /** Every candidate, in the order the seating would try them. Empty when the Agent names none. */
  readonly candidates: readonly SeatCandidate[]
  /** Where in `candidates` the seat that would be taken is; null when none can be. */
  readonly winner: number | null
  /**
   * Why this Agent cannot be weighed at all — its file does not parse, or
   * nobody defined it — in the host's words; null otherwise. When it is set
   * `candidates` is empty and `winner` null.
   */
  readonly blocked: string | null
}
```

2. In `packages/protocol/src/wire.ts`, import `SeatPlan` beside `AgentEntry` from `./agent.js`, and declare after `'agent/read'`:

```ts
  /**
   * Which seat each Agent would take here, and why not the others — opening
   * nothing. The reads a seating makes before it chooses, each held to the
   * same deadline; one read of the desk serves every Agent asked about. `ids`
   * absent is every Agent in force, in the roster's order; an id nobody
   * defined is answered with why, never dropped.
   */
  'agent/seat/dry': {
    params: { readonly ids?: readonly string[]; readonly project?: string }
    result: readonly SeatPlan[]
  }
```

3. In `packages/protocol/src/wire-validators.ts`, after `'agent/read'`:

```ts
  'agent/seat/dry': shape({ ids: optional(arrayOf(isString)), project: optional(isString) }),
```

- [ ] **Step 4: Plan in the chooser**

In `packages/server/src/agent-seating.ts`:

1. Add `AgentId`, `SeatCandidate` and `SeatPlan` to the `@harnessdesk/protocol` type import.
2. Append:

```ts
// ------------------------------------------------------------ in words

/**
 * How a seat is said to a person: the runtime by the name the desk calls it,
 * and a model and an effort by the labels the runtime gave them where it gave
 * any. The caller knows the names; this only puts them in order.
 */
export interface SeatWords {
  runtime(id: string): string
  model(runtime: string, model: string): string
  effort(runtime: string, model: string | null | undefined, effort: string): string
}

/**
 * Effort ids as a person says them, for a runtime that did not label them.
 * An id not here is said as written — a vendor adds levels faster than this
 * table learns them, and a word borrowed for one would lie about the next.
 */
const EFFORT_WORDS: Readonly<Record<string, string>> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
}

export const effortWord = (effort: string): string =>
  Object.hasOwn(EFFORT_WORDS, effort) ? (EFFORT_WORDS[effort] ?? effort) : effort

/** "Claude · Opus 5 · High · thinking" — what a surface shows where a spec would otherwise be. */
export const describeSeat = (seat: FlowSeat, words: SeatWords): string =>
  [
    words.runtime(seat.runtime),
    seat.model ? words.model(seat.runtime, seat.model) : null,
    seat.effort ? words.effort(seat.runtime, seat.model, seat.effort) : null,
    seat.thinking ? 'thinking' : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')

/** One candidate passed over, as a surface shows it. */
export const candidateOf = (one: PassedOver, words: SeatWords): SeatCandidate => ({
  seat: one.seat,
  label: describeSeat(one.seat, words),
  runtimeName: words.runtime(one.seat.runtime),
  state: 'passed',
  reason: one.reason,
  fix: fixOf(one.seat.runtime, one.reason),
  ...(one.left ? { left: one.left } : {}),
})

/**
 * The plan for one Agent: every candidate in order, the one that would be
 * taken, and why each above it would not be. Every candidate above the winner
 * is passed over, so the chooser's list lines up with the candidates by index.
 */
export const planSeats = (
  id: AgentId,
  candidates: readonly FlowSeat[],
  offers: readonly SeatOffer[],
  words: SeatWords,
  from: SeatPlan['from'] = 'prefer',
): SeatPlan => {
  const chosen = chooseSeat(candidates, offers)
  const winner = chosen.seat === null ? null : chosen.passed.length
  return {
    id,
    from,
    winner,
    blocked: null,
    candidates: candidates.map((seat, index): SeatCandidate => {
      const passed = chosen.passed[index]
      if (passed) return candidateOf(passed, words)
      return {
        seat,
        label: describeSeat(seat, words),
        runtimeName: words.runtime(seat.runtime),
        state: index === winner ? 'taken' : 'untried',
        reason: null,
        fix: null,
      }
    }),
  }
}

/** An Agent that cannot be weighed at all, with why. */
export const blockedPlan = (id: AgentId, why: string, from: SeatPlan['from'] = 'prefer'): SeatPlan => ({
  id,
  from,
  candidates: [],
  winner: null,
  blocked: why,
})
```

- [ ] **Step 5: Read the desk once, and answer the plan**

In `packages/server/src/methods/agents.ts`:

1. Replace the `@harnessdesk/protocol` import with:

```ts
import {
  isBlocked,
  type AgentEntry,
  type AgentRuntime,
  type FlowSeat,
  type ModelInfo,
  type UsageReport,
} from '@harnessdesk/protocol'
```

   and extend the `'../agent-seating.js'` import with `blockedPlan`, `effortWord`, `planSeats` and `type SeatWords`, and add:

```ts
import { knownAgent } from '../installs/known-agents.js'
```

2. Add the verb to `agentMethods`, after `'agent/read'`:

```ts
  /**
   * Which seat each Agent would take here, and why not the others, opening
   * nothing. The desk is read once for every runtime any of them names — the
   * same reads, and the same deadline, as a real seating — so a menu listing
   * ten Agents asks each runtime once, not ten times.
   */
  'agent/seat/dry': async (ctx, params) => {
    const roster = await ctx.agents.list(await projectOf(ctx, params.project))
    const ids = params.ids ?? roster.map((one) => one.id)
    const entries = ids.map((id) => ({ id, entry: roster.find((one) => one.id === id) ?? null }))
    const desk = await readDesk(
      ctx,
      entries.flatMap(({ entry }) => entry?.definition?.prefer ?? []),
    )
    const words = wordsFor(ctx, desk.catalogues)
    return entries.map(({ id, entry }) => {
      if (!entry) return blockedPlan(id, `No Agent called “${id}”.`)
      if (!entry.definition || entry.digest === null) return blockedPlan(id, unusable(entry))
      return planSeats(id, entry.definition.prefer, desk.offers, words)
    })
  },
```

3. In `'agent/seat'`, replace the refusal of an unusable entry

```ts
    if (!definition || digest === null) {
      const problem = entry.problems.find((one) => one.level === 'error')
      throw new Error(
        `${entry.path} cannot be used: ${problem ? `${problem.at} — ${problem.text}` : 'it could not be read'}`,
      )
    }
```

   with

```ts
    if (!definition || digest === null) throw new Error(unusable(entry))
```

   and replace `const offers = await offersFor(ctx, candidates)` with `const { offers } = await readDesk(ctx, candidates)`.

4. Add, below `projectOf`:

```ts
/** Why an entry cannot be seated: its first error, where it is, in the file's own terms. */
const unusable = (entry: AgentEntry): string => {
  const problem = entry.problems.find((one) => one.level === 'error')
  return `${entry.path} cannot be used: ${problem ? `${problem.at} — ${problem.text}` : 'it could not be read'}`
}

/**
 * The words a seat is said in here. A runtime added to the desk by the name
 * it presents; one that is not, by the name the desk knows it by; and one the
 * desk has never heard of, by its id, which is the last word left. A model and
 * an effort by the labels its runtime answered with, where it answered.
 */
const wordsFor = (ctx: HostContext, catalogues: ReadonlyMap<string, readonly ModelInfo[]>): SeatWords => {
  const model = (runtime: string, id: string | null | undefined) =>
    id ? catalogues.get(runtime)?.find((one) => one.id === id) : undefined
  return {
    runtime: (id) => {
      const runtime = ctx.runtimes.get(id)
      return runtime ? ctx.runtimes.infoOf(runtime).presentation.name : (knownAgent(id)?.name ?? id)
    },
    model: (runtime, id) => model(runtime, id)?.displayName ?? id,
    effort: (runtime, id, effort) =>
      model(runtime, id)?.reasoningLevels.find((level) => level.id === effort)?.label ?? effortWord(effort),
  }
}
```

5. Replace `offersFor`, `offerOf` and `modelsOf` (Task 2's versions) with `readDesk`, `offerOf` and `catalogueOf` — `usageWithin` stays as Task 2 wrote it:

```ts
/** What this desk can seat on each runtime named, and the models each answered with. */
interface Desk {
  readonly offers: readonly SeatOffer[]
  /** Each runtime's models as it named them, where the list was read — for the words, not the choice. */
  readonly catalogues: ReadonlyMap<string, readonly ModelInfo[]>
}

/**
 * What this desk can seat on each runtime the candidates name, read from the
 * desk itself — never assumed, and never a failed read passed off as an answer.
 *
 * - **Installed** is the runtime registry: a runtime this desk has not added has
 *   no offer; one it added whose program is missing says so (`notInstalled`).
 * - **Unavailable** is its own health when that is not ready — too old, crashed,
 *   still starting — in its own words, and an account that would not answer.
 * - **Silent** is an account read that did not answer within the deadline.
 * - **Signed in** is the accounts plane: an account on it, or an agent that keeps
 *   its own credential where the desk cannot see it and so never asks for one.
 * - **Spent** is the usage the desk already reads, judged by the one rule every
 *   surface uses (`isBlocked`): an account-wide window, never one model's.
 * - **Models** is the runtime's own list, or null when it could not be read in
 *   time — never empty for unread, which the chooser would take for "offers none".
 * - **Efforts** are null: a runtime declares them per session, so they are held
 *   to account once the seat is open, not guessed at here.
 */
const readDesk = async (ctx: HostContext, candidates: readonly FlowSeat[]): Promise<Desk> => {
  const runtimes = [...new Set(candidates.map((one) => one.runtime))].flatMap((id) => {
    const runtime = ctx.runtimes.get(id)
    return runtime ? [runtime] : []
  })
  if (runtimes.length === 0) return { offers: [], catalogues: new Map() }
  const deadline = ctx.options.seatReadDeadlineMs ?? SEAT_READ_DEADLINE_MS
  const reports = await usageWithin(ctx, runtimes, deadline)
  const read = await Promise.all(runtimes.map((runtime) => offerOf(ctx, runtime, reports, deadline)))
  return {
    offers: read.map((one) => one.offer),
    catalogues: new Map(
      read.flatMap((one) => (one.catalogue ? [[one.offer.runtime, one.catalogue] as const] : [])),
    ),
  }
}

const offerOf = async (
  ctx: HostContext,
  runtime: AgentRuntime,
  reports: readonly UsageReport[],
  deadline: number,
): Promise<{ readonly offer: SeatOffer; readonly catalogue: readonly ModelInfo[] | null }> => {
  const id = String(runtime.info.id)
  const health = runtime.health()
  // Nothing else is read about a runtime that cannot open a conversation; the chooser stops at why.
  const unread = { models: null, efforts: null, signedIn: false, spent: false }
  const only = (offer: SeatOffer) => ({ offer, catalogue: null })
  /* Added, and its program is missing. Offered with that said rather than
     dropped: a runtime nobody added is fixed by adding it, and this one by
     installing what it runs, and only an offer can carry the difference. */
  if (health.state === 'unavailable' && health.reason === 'notInstalled') {
    return only({ runtime: id, notInstalled: true, ...unread })
  }
  if (health.state === 'unavailable') {
    const why = health.remediation ? `${health.message} ${health.remediation}` : health.message
    return only({ runtime: id, unavailable: why, ...unread })
  }
  if (health.state === 'starting') return only({ runtime: id, unavailable: 'it is still starting', ...unread })

  let signedIn = true
  // An agent that keeps its own credential is never asked to sign in here.
  if (ctx.runtimes.infoOf(runtime).capabilities.account !== false) {
    const account = await within(() => runtime.getAccount(), deadline)
    if (account.settled === 'late') return only({ runtime: id, silent: deadline, ...unread })
    if (account.settled === 'error') {
      return only({ runtime: id, unavailable: `its account could not be read — ${messageOf(account.error)}`, ...unread })
    }
    signedIn = account.value.accounts.length > 0
  }
  const report = reports.find((one) => one.runtime === runtime.info.id)
  const catalogue = await catalogueOf(runtime, deadline)
  return {
    offer: {
      runtime: id,
      models: catalogue?.map((one) => one.id) ?? null,
      efforts: null,
      signedIn,
      spent: report ? isBlocked(report) : false,
    },
    catalogue,
  }
}

/**
 * The models a runtime offers, or null when it could not say — failing, or
 * not saying within the deadline, which is the same "could not say" here.
 *
 * `listModels` is the picker's question, and a picker would rather draw nothing
 * than an error: the ACP adapter answers it with an empty list when its agent
 * never managed to declare a catalogue. To the chooser empty is "offers none",
 * so a runtime that can tell the two apart is asked the way that does
 * (`knownModels`); any other is asked `listModels`.
 */
const catalogueOf = async (runtime: AgentRuntime, deadline: number): Promise<readonly ModelInfo[] | null> => {
  const read = await within(() => (runtime.knownModels ? runtime.knownModels() : runtime.listModels()), deadline)
  return read.settled === 'value' ? (read.value ?? null) : null
}
```

- [ ] **Step 6: Pin the verb until a surface calls it**

In `script/check-reachable.mjs`, add to `UNREACHED` after `'agent/seat'`:

```js
  'agent/seat/dry':
    'likewise — every menu that lists Agents is drawn from it, and those menus are the second half of the same phase',
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-seating.test.js packages/server/dist/test/agent-seat.test.js packages/server/dist/test/methods.test.js && node script/check-reachable.mjs`
Expected: PASS — `agent-seating.test.js` 26 tests, `agent-seat.test.js` 48 tests, `methods.test.js` unchanged; then `… host methods reachable from a surface; 6 pinned as not.`

- [ ] **Step 8: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/protocol/src packages/server/src/agent-seating.ts packages/server/src/methods/agents.ts packages/server/test/agent-seating.test.ts packages/server/test/agent-seat.test.ts script/check-reachable.mjs
git commit -m "feat(agents): a dry run of seating, which opens nothing

agent/seat/dry answers, for each Agent, every candidate in order: the one that
would be taken here, why each above it would not be and what would fix it, and
the seat in words — the runtime by the name the desk calls it and the model and
effort by the labels the runtime gave them. One read of the desk, under the
seating's own deadline, serves every Agent asked about.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 5: The seating says what it passed over — to the refusal sheet and to the name card

Two surfaces need the real seating's candidates as a list, not a sentence. The refusal sheet (Task 14) lists every candidate with its reason and fix — including a candidate passed over only once it was open, which no dry run can know. The name card (Task 18) shows the seat a conversation took, as read back, and the candidates passed over on the way. Today the refusal is an `Error` whose only structure is its English, and the kept seat records its Agent, brief digest and permission but neither what it runs nor what it passed.

So: the refusal becomes a `SeatRefusedError` whose candidates travel on the wire as the error's `data` (a failure with a way out already travels by code — `sessionBusy`, `sessionFolderGone` — and this is the first whose way out needs a list), and the kept seat's host-held record gains `seatLabel` and `passedOver`, laid over its settings like the other three and refused from anyone else.

**Files:**
- Modify: `packages/protocol/src/errors.ts` (`SeatRefusedError`, `wireDataOf`, `isSeatRefused`)
- Modify: `packages/protocol/src/wire.ts` (`WireError.data`), `packages/protocol/src/wire-validators.ts` (`wireError` takes `data`)
- Modify: `packages/protocol/src/session.ts` (`SessionSettings.seatLabel`, `SessionSettings.passedOver`)
- Modify: `packages/server/src/server.ts` (send the data)
- Modify: `packages/server/src/registry.ts` (`SeatedAs` gains the two; `seatedSettings` lays and strips them)
- Modify: `packages/server/src/methods/agents.ts` (throw the typed refusal; record the two)
- Modify: `packages/ui/src/lib/transport.ts` (keep `data` on the rejection)
- Modify: `packages/server/test/fixtures/harness.ts` (the test client keeps `data` too)
- Test: `packages/server/test/agent-seat.test.ts`, `packages/ui/src/lib/transport.test.ts`

**Interfaces:**
- Consumes: `candidateOf`, `SeatWords` (Task 4); `wordsFor`, `readDesk` (Task 4).
- Produces:
  - `class SeatRefusedError extends Error { readonly wireCode = 'seatRefused'; readonly wireData: { readonly candidates: readonly SeatCandidate[] } }`, `wireDataOf(error: unknown): unknown`, `isSeatRefused(error: unknown): boolean` (`@harnessdesk/protocol`).
  - `WireError.data?: unknown`; `wireError(code, message, details?, data?)`.
  - `SessionSettings.seatLabel?: string` — what the seat runs, as read back ("Seat Fake · Big · High"); `SessionSettings.passedOver?: readonly SeatCandidate[]`. Both host-held.
  - `SeatedAs { agent; briefDigest; permission; seatLabel: string; passedOver: readonly SeatCandidate[] }`.
  - The renderer's rejection is `Error & { code: string; data?: unknown }`.

- [ ] **Step 1: Write the failing tests**

1. In `packages/server/test/fixtures/harness.ts`, make the test client keep the data, as the renderer will — replace the rejection line with:

```ts
          reject(
            Object.assign(new Error(message.error.message), {
              code: message.error.code,
              ...(message.error.data !== undefined ? { data: message.error.data } : {}),
            }),
          )
```

2. In `packages/server/test/agent-seat.test.ts` (import `type SeatCandidate` from `@harnessdesk/protocol`):

   - Update the two assertions that pin the record, because the record now carries what the seat runs and what it passed. In `the seat is told the narrower of the Agent's ceiling…` replace the `seen.recorded` assertion with:

```ts
    assert.deepEqual(
      seen.recorded,
      [{ agent: 'reviewer', briefDigest: digestOf(seen.source), permission: held, seatLabel: 'claude', passedOver: [] }],
      said,
    )
```

   and in `a seat that runs another effort than asked is closed, and the next candidate the Agent named is seated` replace it with:

```ts
  assert.deepEqual(seen.recorded, [
    {
      agent: 'reviewer',
      briefDigest: digestOf(seen.source),
      permission: 'read',
      seatLabel: 'claude',
      passedOver: [
        {
          seat: { runtime: 'claude', model: 'opus-5', effort: 'high' },
          label: 'claude · opus-5 · High',
          runtimeName: 'claude',
          state: 'passed',
          reason: { kind: 'openedOtherwise', detail: 'at medium effort, not high' },
          fix: { kind: 'seats' },
        },
      ],
    },
  ])
```

   - In `a renderer cannot make a conversation wear an Agent the host never seated it as`, forge the two new fields too — add `seatLabel: 'forged'` and `passedOver: []` to both the `options` and the `patch`, and add:

```ts
  assert.equal(settingsSeen(client, String(session.id))?.seatLabel, undefined)
  assert.equal(settingsSeen(client, String(session.id))?.passedOver, undefined)
```

   - Append:

```ts
/*
 * What the seating passed over, as a list: on the refusal, for the sheet that
 * lists every candidate with its fix; and on the seat it kept, for the card
 * that says what it runs and what it passed on the way.
 */

test('a refusal carries every candidate as a surface shows it, beside the sentence', async () => {
  const seen = await rig(
    'cursor=gemini-3.8-flash/high, claude=opus-5/high',
    { cursor: { name: 'Cursor', models: ['gemini-3.8-flash'], signedOut: true }, claude: { name: 'Claude', models: ['opus-5'] } },
    { comesBackAs: () => ({ effort: 'medium' }), leaves: () => ({ kind: 'kept' }) },
  )
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error & { wireCode?: string; wireData?: { candidates: readonly SeatCandidate[] } }) => {
      assert.equal(error.wireCode, 'seatRefused')
      assert.match(error.message, /^No seat could be opened for this Agent:/)
      assert.deepEqual(
        error.wireData?.candidates.map((one) => [one.label, one.reason?.kind, one.fix?.kind, one.left?.kind ?? null]),
        [
          ['Cursor · gemini-3.8-flash · High', 'signedOut', 'signIn', null],
          ['Claude · opus-5 · High', 'openedOtherwise', 'seats', 'kept'],
        ],
      )
      return true
    },
  )
})

test('the seat kept records what it runs and every candidate passed over on the way', async () => {
  const seen = await rig('cursor=gemini-3.8-flash/high, claude=opus-5/high', {
    cursor: { name: 'Cursor', models: ['gemini-3.8-flash'], signedOut: true },
    claude: { name: 'Claude', models: ['opus-5'] },
  })
  const session = await agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  // The rig's read-back label is the runtime's id; the host's is the desk's words (below).
  assert.equal(session.settings?.seatLabel, 'claude')
  assert.deepEqual(
    session.settings?.passedOver?.map((one) => [one.label, one.reason]),
    [['Cursor · gemini-3.8-flash · High', { kind: 'signedOut' }]],
  )
})

test('through the host: the seat kept arrives with what it runs, and a refusal with its candidates', async (t) => {
  const { harness, client, work } = await desk(t)
  await writeReviewer(harness.stateDir, 'ghost=m1, seatfake=big/high')
  const session = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  assert.equal(session.settings?.seatLabel, 'Seat Fake · Big · High')
  assert.deepEqual(
    session.settings?.passedOver?.map((one) => [one.label, one.fix]),
    [['ghost · m1', { kind: 'add', runtime: 'ghost' }]],
  )

  await writeReviewer(harness.stateDir, 'ghost=m1')
  await assert.rejects(
    client.call('agent/seat', { id: 'reviewer', cwd: work }),
    (error: Error & { code?: string; data?: { candidates: readonly SeatCandidate[] } }) => {
      assert.equal(error.code, 'seatRefused')
      assert.deepEqual(error.data?.candidates.map((one) => [one.label, one.state]), [['ghost · m1', 'passed']])
      return true
    },
  )
})
```

3. Append to `packages/ui/src/lib/transport.test.ts` (import `rejectionFor` from `./transport` if the file does not already):

```ts
it('keeps what a failure carries for the interface beside its code and sentence', () => {
  const candidates = [{ label: 'Claude · Opus 5 · High', state: 'passed' }]
  const error = rejectionFor({ code: 'seatRefused', message: 'No seat could be opened for this Agent', data: { candidates } })
  expect((error as Error & { code?: string }).code).toBe('seatRefused')
  expect((error as Error & { data?: unknown }).data).toEqual({ candidates })
  // And a failure with nothing more to say carries nothing more.
  expect('data' in rejectionFor({ code: 'methodFailed', message: 'no' })).toBe(false)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Property 'data' does not exist on type 'WireError'` (harness) and `Object literal may only specify known properties, and 'seatLabel' does not exist in type 'SeatedAs'`.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/transport.test.ts`
Expected: FAIL — `expected undefined to deeply equal { candidates: [...] }`.

- [ ] **Step 3: Let a failure carry a list**

1. In `packages/protocol/src/wire.ts`, replace `interface WireError` with:

```ts
export interface WireError {
  readonly code: string
  readonly message: string
  readonly details?: string | null
  /**
   * What a failure with a way out carries for the interface to draw it, when
   * a sentence is not enough — a seating's refusal lists every candidate with
   * its reason and its fix. Read only by a caller that knows the code.
   */
  readonly data?: unknown
}
```

2. In `packages/protocol/src/wire-validators.ts`, replace `wireError` with:

```ts
export const wireError = (code: string, message: string, details?: string | null, data?: unknown): WireError => ({
  code,
  message,
  details: details ?? null,
  ...(data !== undefined && data !== null ? { data } : {}),
})
```

3. Append to `packages/protocol/src/errors.ts` (with `import type { SeatCandidate } from './agent.js'` at the top):

```ts
/** What a failure carries for the interface beyond its sentence, read structurally; null when nothing. */
export const wireDataOf = (error: unknown): unknown => {
  const data = error instanceof Error ? (error as { wireData?: unknown })['wireData'] : undefined
  return data ?? null
}

/**
 * No seat could be opened for an Agent, and here is every candidate and why.
 *
 * The sentence is the host's, for its log and for a banner. The candidates
 * are what the refusal sheet is drawn from: a list with a fix on every line is
 * only possible when the list arrives as a list, and reading it back out of
 * the English would break the first time a sentence was improved.
 */
export class SeatRefusedError extends Error {
  readonly wireCode = 'seatRefused'
  constructor(
    message: string,
    readonly wireData: { readonly candidates: readonly SeatCandidate[] },
  ) {
    super(message)
    this.name = 'SeatRefusedError'
  }
}

export const isSeatRefused = (error: unknown): boolean => wireCodeOf(error) === 'seatRefused'
```

4. In `packages/server/src/server.ts`, import `wireDataOf` beside `wireCodeOf`, and in `handleMessage`'s `catch` send it:

```ts
      error: wireError(wireCodeOf(error) ?? 'methodFailed', describeError(error), details, wireDataOf(error)),
```

5. In `packages/ui/src/lib/transport.ts`, replace `rejectionFor` with:

```ts
export const rejectionFor = (error: WireError): Error =>
  Object.assign(new Error(sentenceOf(error)), {
    code: error.code,
    // A list the interface draws a way out from, when the failure has one (a seating's refusal).
    ...(error.data !== undefined ? { data: error.data } : {}),
  })
```

- [ ] **Step 4: Keep the seat's words and what it passed, host-held**

1. In `packages/protocol/src/session.ts`, import `type SeatCandidate` from `./agent.js`, and add to `SessionSettings`, after `permission`:

```ts
  /**
   * What the seat runs, as the desk said it when the seat was kept — read
   * back from the conversation, never the request: "Claude · Opus 5 · High".
   * Held like `agent`, by the host alone.
   */
  readonly seatLabel?: string
  /**
   * Every candidate the seating passed over before it kept this one, each
   * with its reason and its fix, as a surface shows them. Held like `agent`.
   */
  readonly passedOver?: readonly SeatCandidate[]
```

2. In `packages/server/src/registry.ts`, import `type SeatCandidate` from `@harnessdesk/protocol`, and replace `interface SeatedAs` and `seatedSettings` with:

```ts
/**
 * Which Agent a conversation was seated as, the digest of the brief it was
 * handed, the permission its standing order told it it holds, what the seat
 * runs as read back when it was kept, and the candidates passed over on the way.
 */
export interface SeatedAs {
  readonly agent: string
  readonly briefDigest: string
  readonly permission: FlowPermission
  readonly seatLabel: string
  readonly passedOver: readonly SeatCandidate[]
}

/**
 * Settings with the host's record of which Agent this is laid over them — and
 * nobody else's.
 *
 * All five fields are the host's to write. A runtime that re-announces its
 * settings drops them; a renderer can name them in a patch that a runtime
 * echoes back, or in the options it opens a conversation with. So they are put
 * back from the record after every fold, and taken off a conversation the host
 * never seated as an Agent: when one is there, it is the host's. A permission
 * anybody could write would be a permission anybody could raise.
 */
export const seatedSettings = (settings: SessionSettings, seated: SeatedAs | null): SessionSettings => {
  if (seated) {
    return settings.agent === seated.agent &&
      settings.briefDigest === seated.briefDigest &&
      settings.permission === seated.permission &&
      settings.seatLabel === seated.seatLabel &&
      settings.passedOver === seated.passedOver
      ? settings
      : {
          ...settings,
          agent: seated.agent,
          briefDigest: seated.briefDigest,
          permission: seated.permission,
          seatLabel: seated.seatLabel,
          passedOver: seated.passedOver,
        }
  }
  if (
    settings.agent === undefined &&
    settings.briefDigest === undefined &&
    settings.permission === undefined &&
    settings.seatLabel === undefined &&
    settings.passedOver === undefined
  ) {
    return settings
  }
  const {
    agent: _agent,
    briefDigest: _briefDigest,
    permission: _permission,
    seatLabel: _seatLabel,
    passedOver: _passedOver,
    ...theirs
  } = settings
  return theirs
}
```

- [ ] **Step 5: Refuse with the list, and record it on the seat kept**

In `packages/server/src/methods/agents.ts`:

1. Add `SeatRefusedError` to the value import from `@harnessdesk/protocol`, and `candidateOf` to the import from `'../agent-seating.js'`.
2. In `'agent/seat'`, replace `const { offers } = await readDesk(ctx, candidates)` with:

```ts
    const desk = await readDesk(ctx, candidates)
    const offers = desk.offers
    const words = wordsFor(ctx, desk.catalogues)
    const said = (list: readonly PassedOver[]) => list.map((one) => candidateOf(one, words))
```

3. Replace `if (!chosen.seat) throw new Error(explainRefusal(passed))` with:

```ts
      if (!chosen.seat) throw new SeatRefusedError(explainRefusal(passed), { candidates: said(passed) })
```

4. Replace the `recordAgent` call with:

```ts
      return ctx.seats.recordAgent(opened.runtime, opened.sessionId, {
        agent: definition.id,
        briefDigest: digest,
        permission,
        seatLabel: opened.label,
        passedOver: said(passed),
      })
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-seat.test.js packages/server/dist/test/wire.test.js packages/server/dist/test/registry.test.js`
Expected: PASS — `agent-seat.test.js` 51 tests (48 + 3), `wire.test.js` and `registry.test.js` unchanged, 0 failures.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/transport.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/protocol/src packages/server/src/server.ts packages/server/src/registry.ts packages/server/src/methods/agents.ts packages/server/test/fixtures/harness.ts packages/server/test/agent-seat.test.ts packages/ui/src/lib/transport.ts packages/ui/src/lib/transport.test.ts
git commit -m "feat(agents): a seating says what it passed over, as a list

A refusal was one sentence, and a sheet that lists every candidate with its fix
cannot be drawn from English. It is now a SeatRefusedError whose candidates
travel as the error's data, the way a failure with a way out already travels by
code. The seat kept records what it runs, as read back, and the candidates it
passed on the way — host-held beside its Agent, refused from anyone else.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 6: `~/.harnessdesk/seating.json` — this machine's seats

The brief travels with the code; the seating stays on the machine. `seating.json` in the desk's state directory (`~/.harnessdesk` unless `HARNESSDESK_HOME` moves it) maps an Agent id to an ordered list of seats, in the grammar `prefer` uses:

```json
{ "code-reviewer": ["claude-code=opus-5/high", "codex/high"] }
```

Three rules, all from the spec:

1. **An entry replaces its Agent's `prefer` on this machine**, it never merges with it — two ordered lists merged have no order anyone chose.
2. **Precedence is a seating's own `seats`, then this machine's entry, then `prefer`.** The flow engine does not seat Agents until phase 6, so today `seats` arrives only on `agent/seat`'s params.
3. **Validated on the way in; an entry that fails is surfaced, never dropped.** Dropped, it would seat the Agent on the `prefer` the person replaced, without a word — so an entry that does not read *refuses* the seating (and blocks the Agent's plan) with where and why. A file that is not JSON is one problem for every Agent, and is never written over by the verb.

**Files:**
- Create: `packages/server/src/agent-seating-file.ts`
- Modify: `packages/protocol/src/agent.ts` (`MachineSeating`, `SeatingProblem`)
- Modify: `packages/protocol/src/wire.ts`, `packages/protocol/src/wire-validators.ts` (`agent/seating/read`, `agent/seating/set`; notification `agent/changed`)
- Modify: `packages/server/src/host.ts`, `packages/server/src/methods/context.ts` (`ctx.seating`)
- Modify: `packages/server/src/methods/agents.ts` (`candidatesFor`; the seat and the dry run use it; the two verbs)
- Modify: `script/check-reachable.mjs` (pin the two verbs)
- Test: `packages/server/test/agent-seating-file.test.ts` (new), `packages/server/test/agent-seat.test.ts`

**Interfaces:**
- Consumes: `parseSeat`, `seatFromMap`, `seatSpec`, `asList`, `asRecord`, `asText` (`packages/server/src/flow.ts`); `planSeats(…, from)`, `blockedPlan(…, from)` (Task 4).
- Produces:
  - `interface SeatingProblem { id: AgentId | null; at: string; text: string }` and `interface MachineSeating { path: string; entries: readonly { id: AgentId; seats: readonly FlowSeat[] }[]; problems: readonly SeatingProblem[] }` (`@harnessdesk/protocol`).
  - `SEATING_FILE = 'seating.json'`, `parseSeating(text: string): { entries; problems }`, `class MachineSeatingFile { readonly path: string; read(): Promise<MachineSeating>; set(id: string, seats: readonly FlowSeat[] | null): Promise<MachineSeating> }` (`agent-seating-file.ts`).
  - `HostContext.seating: MachineSeatingFile`.
  - `'agent/seating/read': { params: Record<string, never>; result: MachineSeating }`, `'agent/seating/set': { params: { id: string; seats: readonly FlowSeat[] | null }; result: MachineSeating }`.
  - Notification `{ method: 'agent/changed'; params: { project: string | null } }` — Task 8 pushes it from the watcher too.
  - `candidatesFor(definition, machine, seats?)` in `methods/agents.ts`.

- [ ] **Step 1: Write the failing tests for the file**

Create `packages/server/test/agent-seating-file.test.ts`:

```ts
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { MachineSeatingFile, parseSeating } from '../src/agent-seating-file.js'
import { tempDir } from './scratch.js'

/**
 * This machine's seats. An entry that does not read is reported by its Agent,
 * never dropped — dropped, the Agent would be seated on the list the person
 * replaced — and a file that is not JSON is never written over.
 */

test('each Agent id reads to its seats, in both forms a seat is written in', () => {
  const read = parseSeating(
    JSON.stringify({
      'code-reviewer': ['claude-code=opus-5/high', 'codex/high'],
      researcher: [{ runtime: 'cursor', model: 'vendor/model-1', effort: 'high' }],
    }),
  )
  assert.deepEqual(read.problems, [])
  assert.deepEqual(read.entries, [
    {
      id: 'code-reviewer',
      seats: [
        { runtime: 'claude-code', model: 'opus-5', effort: 'high' },
        { runtime: 'codex', effort: 'high' },
      ],
    },
    { id: 'researcher', seats: [{ runtime: 'cursor', model: 'vendor/model-1', effort: 'high' }] },
  ])
})

test('an entry that does not read is a problem with its Agent and its place, and the others still read', () => {
  const read = parseSeating(JSON.stringify({ judge: ['codex', 'claude-code+fast'], implementer: ['codex'] }))
  assert.deepEqual(read.entries, [{ id: 'implementer', seats: [{ runtime: 'codex' }] }])
  assert.deepEqual(read.problems, [
    { id: 'judge', at: '[1]', text: '"+fast" is not a switch a seat takes — the only one is +thinking' },
  ])
})

test('an entry with no seat, or more than an Agent may name, is refused whole; a lone seat is one seat', () => {
  const nine = Array.from({ length: 9 }, () => 'codex')
  const read = parseSeating(JSON.stringify({ empty: [], long: nine, word: 'codex' }))
  assert.deepEqual(read.entries, [{ id: 'word', seats: [{ runtime: 'codex' }] }])
  assert.deepEqual(
    read.problems.map((one) => [one.id, one.at]),
    [
      ['empty', ''],
      ['long', ''],
    ],
  )
})

test('a file that is not JSON is one problem, for every Agent', () => {
  const read = parseSeating('{ "judge": [codex] }')
  assert.deepEqual(read.entries, [])
  assert.equal(read.problems.length, 1)
  assert.equal(read.problems[0]?.id, null)
  assert.match(read.problems[0]?.text ?? '', /^it is not JSON/)
})

test('no file is no entries and nothing wrong', async () => {
  const file = new MachineSeatingFile(join(tempDir('hd-seating-'), 'seating.json'))
  assert.deepEqual(await file.read(), { path: file.path, entries: [], problems: [] })
})

test('setting one Agent leaves every other entry as it was written, in its place', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  await writeFile(path, JSON.stringify({ judge: ['codex', 'claude-code+fast'], researcher: ['cursor'] }), 'utf8')
  const file = new MachineSeatingFile(path)
  const after = await file.set('code-reviewer', [
    { runtime: 'claude-code', model: 'opus-5', effort: 'high' },
    { runtime: 'cursor', model: 'vendor/model-1' },
  ])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    // Broken, and kept exactly as written: it is the person's, and they will fix it.
    judge: ['codex', 'claude-code+fast'],
    researcher: ['cursor'],
    // A model whose name the compact form cannot carry is written the long way.
    'code-reviewer': ['claude-code=opus-5/high', { runtime: 'cursor', model: 'vendor/model-1' }],
  })
  assert.deepEqual(
    after.entries.map((one) => one.id),
    ['researcher', 'code-reviewer'],
  )
  await file.set('researcher', null)
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf8'))), ['judge', 'code-reviewer'])
})

test('a file that is not JSON is never written over, and an empty list is not a way to clear', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  await writeFile(path, '{ oops', 'utf8')
  const file = new MachineSeatingFile(path)
  await assert.rejects(() => file.set('judge', [{ runtime: 'codex' }]), /was not changed/)
  assert.equal(await readFile(path, 'utf8'), '{ oops')
  const fresh = new MachineSeatingFile(join(tempDir('hd-seating-'), 'seating.json'))
  await assert.rejects(() => fresh.set('judge', []), /at least one seat/)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/agent-seating-file.js'`.

- [ ] **Step 3: Add the types**

Append to `packages/protocol/src/agent.ts`:

```ts
/** One thing wrong with this machine's seating file, and whose entry it is in. */
export interface SeatingProblem {
  /** The Agent whose entry it is; null when the file as a whole could not be read. */
  readonly id: AgentId | null
  /** Where in the entry — `[2]` — or empty for the entry or the file as a whole. */
  readonly at: string
  readonly text: string
}

/**
 * This machine's seats for its Agents, as `seating.json` holds them: every
 * entry that reads, in the file's order, and every one that does not, with why.
 * An entry replaces its Agent's `prefer` here; it never merges with it.
 */
export interface MachineSeating {
  /** Where the file is: `seating.json` in the desk's state directory. */
  readonly path: string
  readonly entries: readonly { readonly id: AgentId; readonly seats: readonly FlowSeat[] }[]
  readonly problems: readonly SeatingProblem[]
}
```

- [ ] **Step 4: Write the file module**

Create `packages/server/src/agent-seating-file.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { SEAT_PREFERENCE_LIMIT, type FlowSeat, type MachineSeating, type SeatingProblem } from '@harnessdesk/protocol'

import { asList, asRecord, asText, parseSeat, seatFromMap, seatSpec } from './flow.js'

/**
 * This machine's seats for its Agents: `seating.json` in the state directory.
 *
 * The brief travels with the code; the seating stays on the machine. Which
 * model is installed, signed in and unspent is a fact about one laptop, so an
 * Agent's `prefer` names what its author could expect anywhere, and this file
 * is where a person says "on this Mac, seat the reviewer on Opus".
 *
 * An entry **replaces** its Agent's `prefer` here and never merges with it:
 * two ordered lists merged have no order anyone chose.
 *
 * Validated on the way in, and an entry that fails is reported by its Agent's
 * id, never dropped — dropped, the Agent would be seated on the list the
 * person replaced, without a word. A file that is not JSON is one problem for
 * every Agent, and is never written over: it is hand-edited, and what is in it
 * is somebody's.
 *
 * Seats are read by the same two functions a flow and an `AGENT.md` read
 * them with — the compact spec, or the long form for a model whose name the
 * spec cannot carry — so one spec string means one seat wherever it is written.
 */

export const SEATING_FILE = 'seating.json'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** What one file's text says: the entries that read, in order, and why the others did not. Pure. */
export const parseSeating = (
  text: string,
): { entries: { id: string; seats: FlowSeat[] }[]; problems: SeatingProblem[] } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { entries: [], problems: [{ id: null, at: '', text: `it is not JSON: ${messageOf(error)}` }] }
  }
  const file = asRecord(parsed)
  if (!file) {
    return { entries: [], problems: [{ id: null, at: '', text: 'it is not an object of Agent ids to lists of seats' }] }
  }
  const entries: { id: string; seats: FlowSeat[] }[] = []
  const problems: SeatingProblem[] = []
  for (const [id, value] of Object.entries(file)) {
    // A lone seat is one seat, the way `prefer` reads one.
    const listed = asList(value) ?? (asText(value) !== null || asRecord(value) ? [value] : null)
    if (listed === null) {
      problems.push({ id, at: '', text: 'its seats are written as a list, like ["claude-code=opus-5/high", "codex"]' })
      continue
    }
    if (listed.length === 0) {
      problems.push({ id, at: '', text: "it names no seat — remove the entry to seat this Agent on its own prefer" })
      continue
    }
    if (listed.length > SEAT_PREFERENCE_LIMIT) {
      problems.push({
        id,
        at: '',
        text: `it names ${listed.length} seats, and an Agent may name at most ${SEAT_PREFERENCE_LIMIT} — each seat that opens and is passed over costs a conversation`,
      })
      continue
    }
    const seats: FlowSeat[] = []
    let broken = false
    listed.forEach((one, index) => {
      const map = asRecord(one)
      const seat = map ? seatFromMap(map) : parseSeat(asText(one) ?? '')
      if (typeof seat === 'string') {
        problems.push({ id, at: `[${index}]`, text: seat })
        broken = true
        return
      }
      seats.push(seat)
    })
    // Refused whole: trying a shorter list than the file says would be the quiet kind of wrong.
    if (!broken) entries.push({ id, seats })
  }
  return { entries, problems }
}

/** A seat as the file writes it: the compact spec, or the long form when the model's name would not survive the spec. */
const written = (seat: FlowSeat): string | Record<string, unknown> =>
  seat.model && /[=/+]/.test(seat.model)
    ? {
        runtime: seat.runtime,
        model: seat.model,
        ...(seat.effort ? { effort: seat.effort } : {}),
        ...(seat.thinking ? { thinking: true } : {}),
      }
    : seatSpec(seat)

export class MachineSeatingFile {
  #writes: Promise<unknown> = Promise.resolve()

  constructor(readonly path: string) {}

  async read(): Promise<MachineSeating> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      // No file is no entries: nobody has chosen seats on this machine yet.
      if ((error as { code?: unknown }).code === 'ENOENT') return { path: this.path, entries: [], problems: [] }
      return { path: this.path, entries: [], problems: [{ id: null, at: '', text: `it could not be read — ${messageOf(error)}` }] }
    }
    return { path: this.path, ...parseSeating(text) }
  }

  /**
   * Sets one Agent's seats here, or clears them (`null`) so its `prefer`
   * applies again. Every other entry is kept exactly as written — a broken one
   * included, because it is the person's to fix — and in its place. Refused
   * while the file cannot be read as a whole, so a hand-edit is never lost.
   */
  set(id: string, seats: readonly FlowSeat[] | null): Promise<MachineSeating> {
    const run = async (): Promise<MachineSeating> => {
      if (seats !== null && seats.length === 0) {
        throw new Error("An Agent's seats on this Mac need at least one seat; clear them to seat it on its own prefer.")
      }
      const now = await this.read()
      const whole = now.problems.find((one) => one.id === null)
      if (whole) {
        throw new Error(`${this.path} was not changed: ${whole.text}. Fix it or remove it first, so what is in it is not lost.`)
      }
      let raw: Record<string, unknown> = {}
      try {
        raw = asRecord(JSON.parse(await readFile(this.path, 'utf8'))) ?? {}
      } catch {
        // No file yet: the first entry makes it.
      }
      // Pairs, then `fromEntries`: an Agent id is a folder name, and a folder
      // called `__proto__` assigned with `[]=` would set a prototype, not a key.
      const pairs: [string, unknown][] = []
      let placed = false
      for (const [key, value] of Object.entries(raw)) {
        if (key !== id) {
          pairs.push([key, value])
          continue
        }
        placed = true
        if (seats) pairs.push([key, seats.map(written)])
      }
      if (!placed && seats) pairs.push([id, seats.map(written)])
      await mkdir(dirname(this.path), { recursive: true })
      // Write-then-rename, like every file the host owns.
      const temp = `${this.path}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(Object.fromEntries(pairs), null, 2)}\n`)
      await rename(temp, this.path)
      return this.read()
    }
    // One write at a time, so two quick edits cannot each read the file before the other wrote it.
    const current = this.#writes.then(run, run)
    this.#writes = current.catch(() => undefined)
    return current
  }
}
```

- [ ] **Step 5: Run the file tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-seating-file.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Write the failing tests for the precedence and the verbs**

In `packages/server/test/agent-seat.test.ts`:

1. Import `MachineSeatingFile` from `'../src/agent-seating-file.js'` and `type MachineSeating` from `@harnessdesk/protocol`.
2. Add to `rig`'s options type:

```ts
    /** What `seating.json` holds on this machine, written before the seating; no file when absent. */
    readonly machine?: string
```

3. In `rig`, after the Agent file is written, add:

```ts
  if (options.machine !== undefined) await writeFile(join(root, 'seating.json'), options.machine, 'utf8')
```

   and add to the context: `seating: new MachineSeatingFile(join(root, 'seating.json')),`.

4. Append:

```ts
/*
 * This machine's seats: an entry replaces the Agent's prefer here, a seating's
 * own seats replace both, and an entry that cannot be read refuses the seating
 * rather than fall back to the list it replaced.
 */

test("this machine's entry replaces the Agent's prefer, and is not merged with it", async () => {
  const seen = await rig(
    'cursor=gemini-3.8-flash',
    { claude: { name: 'Claude', models: ['opus-5'] }, cursor: { name: 'Cursor', models: ['gemini-3.8-flash'] } },
    { machine: JSON.stringify({ reviewer: ['claude=opus-5'] }) },
  )
  // Cursor is seatable, and first in prefer: merged, it would have been taken.
  await agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(seen.created, [{ runtime: 'claude', model: 'opus-5', cwd: '/tmp/x' }])
  const [plan] = await agentMethods['agent/seat/dry'](seen.ctx, { ids: ['reviewer'] })
  assert.equal(plan?.from, 'machine')
  assert.deepEqual(plan?.candidates.map((one) => one.label), ['Claude · opus-5'])
})

test("a seating's own seats beat this machine's", async () => {
  const seen = await rig(
    'cursor=gemini-3.8-flash',
    { claude: { models: ['opus-5'] }, cursor: { models: ['gemini-3.8-flash'] } },
    { machine: JSON.stringify({ reviewer: ['claude=opus-5'] }) },
  )
  await agentMethods['agent/seat'](seen.ctx, {
    id: 'reviewer',
    cwd: '/tmp/x',
    seats: [{ runtime: 'cursor', model: 'gemini-3.8-flash' }],
  })
  assert.deepEqual(seen.created, [{ runtime: 'cursor', model: 'gemini-3.8-flash', cwd: '/tmp/x' }])
})

test('an entry this machine cannot read refuses the seating — never the prefer it replaced — and blocks the plan', async () => {
  const seen = await rig('claude=opus-5', { claude: { models: ['opus-5'] } }, {
    machine: JSON.stringify({ reviewer: ['claude=opus-5', 'claude+fast'] }),
  })
  const why = `this Mac's seats for it in ${join(seen.root, 'seating.json')} cannot be read at [1]: "+fast" is not a switch a seat takes — the only one is +thinking`
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(error.message, `Reviewer cannot be seated: ${why}`)
      return true
    },
  )
  untouched(seen)
  const [plan] = await agentMethods['agent/seat/dry'](seen.ctx, { ids: ['reviewer'] })
  assert.deepEqual(plan, { id: 'reviewer', from: 'machine', candidates: [], winner: null, blocked: why })
})

test("through the host: this Mac's seats are set and cleared by one verb, and every window is told", async (t) => {
  const { harness, client } = await desk(t)
  await writeReviewer(harness.stateDir, 'seatfake=big/high')
  const set = (await client.call('agent/seating/set', {
    id: 'reviewer',
    seats: [{ runtime: 'seatfake', model: 'small' }],
  })) as MachineSeating
  assert.equal(set.path, join(harness.stateDir, 'seating.json'))
  assert.deepEqual(set.entries, [{ id: 'reviewer', seats: [{ runtime: 'seatfake', model: 'small' }] }])
  assert.deepEqual(JSON.parse(await readFile(set.path, 'utf8')), { reviewer: ['seatfake=small'] })
  await client.until(
    () => client.notifications.some((one) => 'method' in one && one.method === 'agent/changed'),
    2_000,
    'agent/changed',
  )
  const [plan] = (await client.call('agent/seat/dry', { ids: ['reviewer'] })) as SeatPlan[]
  assert.equal(plan?.from, 'machine')
  assert.deepEqual(plan?.candidates.map((one) => one.label), ['Seat Fake · Small'])

  const cleared = (await client.call('agent/seating/set', { id: 'reviewer', seats: null })) as MachineSeating
  assert.deepEqual(cleared.entries, [])
  assert.deepEqual(await client.call('agent/seating/read', {}), cleared)
})

test('the wire refuses more seats than an Agent may name, and the file refuses an empty list', async (t) => {
  const { client } = await desk(t)
  const nine = Array.from({ length: 9 }, () => ({ runtime: 'seatfake' }))
  await assert.rejects(client.call('agent/seating/set', { id: 'reviewer', seats: nine }), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'badRequest')
    return true
  })
  await assert.rejects(client.call('agent/seating/set', { id: 'reviewer', seats: [] }), /at least one seat/)
})
```

- [ ] **Step 7: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Argument of type '"agent/seating/set"' is not assignable to parameter of type 'HostMethodName'` in the two through-the-host tests. The three method tests compile, because the rig's context is cast; once the verbs exist they fail at run time until Step 9 seats by the precedence — `this machine's entry replaces…` seats Cursor, the first of `prefer`.

- [ ] **Step 8: Declare the two verbs and the notification**

1. In `packages/protocol/src/wire.ts`, import `MachineSeating` from `./agent.js`, and declare after `'agent/seat'`:

```ts
  /**
   * This machine's seats for its Agents — `seating.json` in the state
   * directory — as read: every entry that reads, in the file's order, and
   * every one that does not, with where and why. Never committed.
   */
  'agent/seating/read': { params: Record<string, never>; result: MachineSeating }
  /**
   * Sets one Agent's seats on this machine, replacing its `prefer` here, or
   * clears them (`seats: null`) so its `prefer` applies again. Every other
   * entry is kept as written. Refused while the file as a whole cannot be read,
   * so a hand-edit is never written over; an empty list is refused too — it is
   * not a way to clear. Every window is told (`agent/changed`).
   */
  'agent/seating/set': {
    params: { readonly id: string; readonly seats: readonly FlowSeat[] | null }
    result: MachineSeating
  }
```

   and add a member to `WireNotification`, after `session/removed`:

```ts
  | {
      /**
       * The roster changed under one of its roots, or this machine's seats for
       * it did: every listing and every dry run drawn from them is stale.
       * `project` names the project whose own Agents changed; null means this
       * machine's — its Agents or its seats — or the built-in ones, which
       * every listing shows.
       */
      readonly method: 'agent/changed'
      readonly params: { readonly project: string | null }
    }
```

2. In `packages/protocol/src/wire-validators.ts`, after `'agent/seat'`:

```ts
  'agent/seating/read': isObject,
  'agent/seating/set': shape({
    id: isFilled,
    seats: (value: unknown, path = '') => (value === null ? null : seatListValidator(value, path)),
  }),
```

- [ ] **Step 9: Give the host the file, and seat by the precedence**

1. In `packages/server/src/host.ts`: import `MachineSeatingFile` and `SEATING_FILE` from `./agent-seating-file.js`; add a field `readonly #seating: MachineSeatingFile` beside `#agents`; construct it right after `#agents`:

```ts
    // Beside everything else the desk keeps on this machine, so a rig's
    // HARNESSDESK_HOME moves it with the rest.
    this.#seating = new MachineSeatingFile(join(this.#state.directory, SEATING_FILE))
```

   and add `seating: this.#seating,` to `#buildContext` after `agents: this.#agents,`.

2. In `packages/server/src/methods/context.ts`, import `type MachineSeatingFile` from `'../agent-seating-file.js'` and add after `agents`:

```ts
  /** This machine's seats for its Agents: `seating.json`, which replaces an Agent's `prefer` here. */
  readonly seating: MachineSeatingFile
```

3. In `packages/server/src/methods/agents.ts`:

   - Add `type AgentDefinition` and `type MachineSeating` to the `@harnessdesk/protocol` import.
   - Add below `unusable`:

```ts
/**
 * The seats one Agent tries here, highest precedence first: a seating's own
 * `seats`, then this machine's entry for it, then its `prefer` — each replacing
 * the next, never merged with it.
 *
 * An entry this machine has for it that cannot be read is a refusal, never a
 * fall back to `prefer`: the person replaced that list here, and seating on it
 * anyway is the quiet kind of substitution. So is a file that cannot be read
 * at all, because nobody can say whether it held an entry for this Agent.
 */
const candidatesFor = (
  definition: AgentDefinition,
  machine: MachineSeating,
  seats?: readonly FlowSeat[],
):
  | { readonly from: 'seats' | 'machine' | 'prefer'; readonly seats: readonly FlowSeat[] }
  | { readonly refused: string } => {
  if (seats?.length) return { from: 'seats', seats }
  const broken = machine.problems.find((one) => one.id === definition.id || one.id === null)
  if (broken) {
    return {
      refused: `this Mac's seats for it in ${machine.path} cannot be read${broken.at ? ` at ${broken.at}` : ''}: ${broken.text}`,
    }
  }
  const entry = machine.entries.find((one) => one.id === definition.id)
  return entry ? { from: 'machine', seats: entry.seats } : { from: 'prefer', seats: definition.prefer }
}
```

   - In `'agent/seat'`, replace `const candidates = params.seats?.length ? params.seats : definition.prefer` with:

```ts
    const list = candidatesFor(definition, await ctx.seating.read(), params.seats)
    if ('refused' in list) throw new Error(`${definition.name} cannot be seated: ${list.refused}`)
    const candidates = list.seats
```

   - Replace the whole `'agent/seat/dry'` handler with:

```ts
  'agent/seat/dry': async (ctx, params) => {
    const roster = await ctx.agents.list(await projectOf(ctx, params.project))
    const machine = await ctx.seating.read()
    const ids = params.ids ?? roster.map((one) => one.id)
    const weighed = ids.map((id) => {
      const entry = roster.find((one) => one.id === id)
      if (!entry) return { plan: blockedPlan(id, `No Agent called “${id}”.`) }
      if (!entry.definition || entry.digest === null) return { plan: blockedPlan(id, unusable(entry)) }
      const list = candidatesFor(entry.definition, machine)
      if ('refused' in list) return { plan: blockedPlan(id, list.refused, 'machine') }
      return { id, list }
    })
    const desk = await readDesk(
      ctx,
      weighed.flatMap((one) => ('list' in one ? one.list.seats : [])),
    )
    const words = wordsFor(ctx, desk.catalogues)
    return weighed.map((one) =>
      'plan' in one
        ? one.plan
        : planSeats(one.id, one.list.seats, desk.offers, words, one.list.from === 'machine' ? 'machine' : 'prefer'),
    )
  },
```

   - Add the two verbs after it:

```ts
  'agent/seating/read': (ctx) => ctx.seating.read(),

  'agent/seating/set': async (ctx, params) => {
    const after = await ctx.seating.set(params.id, params.seats)
    // Every plan drawn before this is stale, in every window.
    ctx.push({ method: 'agent/changed', params: { project: null } })
    return after
  },
```

4. In `script/check-reachable.mjs`, add to `UNREACHED`:

```js
  'agent/seating/read':
    "likewise — an Agent's page reads this machine's seats for it, in the second half of the same phase",
  'agent/seating/set': 'likewise — the same page edits them',
```

- [ ] **Step 10: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-seating-file.test.js packages/server/dist/test/agent-seat.test.js packages/server/dist/test/methods.test.js && node script/check-reachable.mjs`
Expected: PASS — `agent-seating-file.test.js` 7 tests, `agent-seat.test.js` 56 tests (51 + 5), `methods.test.js` unchanged; `… 8 pinned as not.`

- [ ] **Step 11: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/protocol/src packages/server/src/agent-seating-file.ts packages/server/src/host.ts packages/server/src/methods/context.ts packages/server/src/methods/agents.ts packages/server/test/agent-seating-file.test.ts packages/server/test/agent-seat.test.ts script/check-reachable.mjs
git commit -m "feat(agents): this machine's seats, in seating.json

An Agent's prefer names what its author could expect anywhere; seating.json
says what this machine seats it on, and replaces prefer here rather than
merging with it. A seating's own seats still come first. An entry that does
not read refuses the seating and says where, instead of quietly seating the
Agent on the list the person replaced, and a file that is not JSON is never
written over. One verb sets or clears one Agent's entry and tells every window.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 7: The nine Agents that ship with the app

Enough for every one of the spec's eight shapes to start without writing an Agent: five reviewers (independent review, and UC3's three blind reviewers), an implementer (fan-out, relay, comparison), a judge (comparison, UC2), a researcher (investigation) and a requirements analyst (UC1's positions, debate and acceptance). A worked flow that needs a specialist — UC1's `requirements-editor`, UC5's `integrator`, UC6's `game-builder` — defines it in its project.

Decisions this task takes, each for a reason:

- **`prefer: [claude-code, codex, cursor]` on all nine, in that order.** The spec says shipped Agents name runtimes, not models, so no release carries a model name that has gone stale. One order for all nine keeps vendor preference out of the product: a machine's `seating.json` is where a person puts the reviewer on one runtime and the implementer on another.
- **Ceilings in today's vocabulary.** Every reviewer, the judge, the researcher and the analyst are `read`; the implementer is `publish`. Today's `read` still permits editing and committing in the checkout (`GIT_RULES.read` forbids push, merge, reset and force), which is exactly what the researcher and the analyst need to commit what they write. **Phase 3 moves `researcher` and `requirements-analyst` to `edit`** when `read` comes to mean read, and leaves the others as they are. Each brief says in words what the role must never do — the ceiling is *asked*, not held, until phase 3.
- **`answers`** are the words the spec's flows branch on: reviewers `approve | request-changes`, the judge `picked | neither`, the researcher `gathered`, the analyst `agreed | disagree | met | not-met`. The implementer names none: UC1 has it answer `published`, UC2 `delivered` and UC5 `agreed`, so the step decides.
- **Every brief ends its report with a `Verdict:` line** and says to finish a board card with the same word, because a conversation started from the app has no board and a flow's card does.
- **No brief names a vendor or a product**, and none names a model.

**Files:**
- Create: `packages/server/agents/code-reviewer/AGENT.md`
- Create: `packages/server/agents/security-reviewer/AGENT.md`
- Create: `packages/server/agents/performance-reviewer/AGENT.md`
- Create: `packages/server/agents/api-reviewer/AGENT.md`
- Create: `packages/server/agents/test-reviewer/AGENT.md`
- Create: `packages/server/agents/implementer/AGENT.md`
- Create: `packages/server/agents/judge/AGENT.md`
- Create: `packages/server/agents/researcher/AGENT.md`
- Create: `packages/server/agents/requirements-analyst/AGENT.md`
- Modify: `packages/server/package.json` (`files` carries `agents`)
- Modify: `packages/server/src/host.ts` (the `builtinAgentRoot` docstring: something ships there now)
- Modify: `packages/server/test/agent-methods.test.ts` (two listings now carry the built-ins)
- Modify: `packages/desktop/script/packaging.test.mjs`, `packages/desktop/script/smoke-packaged.mjs`
- Test: `packages/server/test/shipped-agents.test.ts` (new)

**Interfaces:**
- Consumes: `builtinAgentRoot()` (`host.ts`), `Agents`, `agent/seat`, `agent/seat/dry` (Tasks 4–6), `FakeRuntime` (`test/fixtures/fake-runtime.ts`).
- Produces: nine built-in Agent ids — `api-reviewer`, `code-reviewer`, `implementer`, `judge`, `performance-reviewer`, `requirements-analyst`, `researcher`, `security-reviewer`, `test-reviewer` — which Part B lists, the preview harness fixtures copy, and the screenshot rig starts as.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/shipped-agents.test.ts`:

```ts
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { test, type TestContext } from 'node:test'

import { runtimeId, type FlowPermission, type SeatPlan, type Session } from '@harnessdesk/protocol'

import { Agents } from '../src/agents.js'
import { builtinAgentRoot } from '../src/host.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * The Agents that ship with the app, each held to what a person relies on: it
 * parses with nothing wrong — not even a warning — it names runtimes and never
 * a model, its ceiling is the one this phase gives it, its brief says how it
 * reports and what it must never do, and it seats on the runtimes a desk
 * registers under those ids.
 */

const SHIPPED: Readonly<Record<string, FlowPermission>> = {
  'api-reviewer': 'read',
  'code-reviewer': 'read',
  implementer: 'publish',
  judge: 'read',
  'performance-reviewer': 'read',
  'requirements-analyst': 'read',
  researcher: 'read',
  'security-reviewer': 'read',
  'test-reviewer': 'read',
}

test('the nine ship, and nothing else does', async () => {
  const folders = (await readdir(builtinAgentRoot(), { withFileTypes: true }))
    .filter((one) => one.isDirectory())
    .map((one) => one.name)
    .sort()
  assert.deepEqual(folders, Object.keys(SHIPPED).sort())
})

test('each parses with nothing wrong, names runtimes and not models, and says how it reports and what it never does', async () => {
  const agents = new Agents({ user: tempDir('hd-shipped-user-'), builtin: builtinAgentRoot() })
  for (const [id, ceiling] of Object.entries(SHIPPED)) {
    const entry = await agents.read(id)
    assert.ok(entry, `${id} is listed`)
    assert.deepEqual(entry.problems, [], `${id} has nothing wrong with it`)
    assert.equal(entry.origin, 'builtin')
    const definition = entry.definition
    assert.ok(definition, `${id} parsed`)
    assert.equal(definition.permission, ceiling, `${id}'s ceiling`)
    assert.deepEqual(
      definition.prefer,
      [{ runtime: 'claude-code' }, { runtime: 'codex' }, { runtime: 'cursor' }],
      `${id} names runtimes, in the one order every shipped Agent uses`,
    )
    assert.ok(definition.description && definition.description.length <= 120, `${id} says what it is for in one line`)
    assert.ok(definition.brief.includes('## How to report'), `${id}'s brief says how it reports`)
    assert.ok(definition.brief.includes('## What you never do'), `${id}'s brief says what it must never do`)
    assert.ok(/Verdict:/.test(definition.brief), `${id}'s brief ends a report on a verdict line`)
  }
})

/** A desk with the three runtimes the shipped Agents name, each a fake registered under its real id. */
const desk = async (t: TestContext, ids: readonly string[] = ['claude-code', 'codex', 'cursor']) => {
  const harness = await start()
  t.after(() => stop(harness))
  const fakes = ids.map((id) => new FakeRuntime({ id: runtimeId(id), name: id }))
  for (const fake of fakes) {
    harness.host.register(fake)
    await fake.start()
  }
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const work = tempDir('hd-shipped-work-')
  await client.call('workspace/open', { path: work })
  return { fakes, client, work }
}

test('each would sit on the first runtime it names, and seats there, holding read', async (t) => {
  const { fakes, client, work } = await desk(t)
  const plans = (await client.call('agent/seat/dry', { ids: Object.keys(SHIPPED) })) as SeatPlan[]
  for (const plan of plans) {
    assert.equal(plan.blocked, null, `${plan.id} can be weighed`)
    assert.equal(plan.winner, 0, `${plan.id} would sit on the first runtime it names`)
  }
  for (const id of Object.keys(SHIPPED)) {
    const session = (await client.call('agent/seat', { id, cwd: work })) as Session
    assert.equal(session.settings?.agent, id)
    assert.equal(String(session.runtime), 'claude-code')
    // Seated with no grant, so each holds read here whatever its ceiling: a ceiling is never a grant.
    assert.equal(session.settings?.permission, 'read')
  }
  assert.equal(fakes[0]?.sessions.size, Object.keys(SHIPPED).length)
})

test('with the first runtime not on this desk, each moves down its own list and says why', async (t) => {
  const { client, work } = await desk(t, ['codex', 'cursor'])
  const session = (await client.call('agent/seat', { id: 'code-reviewer', cwd: work })) as Session
  assert.equal(String(session.runtime), 'codex')
  assert.deepEqual(
    session.settings?.passedOver?.map((one) => [one.runtimeName, one.reason?.kind, one.fix?.kind]),
    [['Claude', 'notInstalled', 'add']],
  )
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/shipped-agents.test.js`
Expected: FAIL — `the nine ship, and nothing else does`: `ENOENT: no such file or directory, scandir '…/packages/server/agents'`; the others fail with `code-reviewer is listed`.

- [ ] **Step 3: Write the nine Agents**

Create `packages/server/agents/code-reviewer/AGENT.md`:

```markdown
---
name: Code reviewer
description: Reads a change it did not write and reports every problem it finds, blocking or not.
permission: read
answers: [approve, request-changes]
produces: [review]
prefer: [claude-code, codex, cursor]
---

You review a change somebody else wrote. You are the second pair of eyes its author cannot be for themselves, so your value is in what you notice that they did not.

## What to review

Review the change you were pointed at: a branch against its base, a pull request, a range of commits, or the uncommitted work in this checkout. If you were not told which, ask once; if nobody answers, review the uncommitted work against `HEAD` and say that is what you reviewed.

Read the whole change before you write anything. Then read the code around it — the callers of what changed, the tests that cover it, the documentation that describes it. A change is judged by what it does to the code it lands in, not only by its own lines.

## What to look for

- Correctness: logic errors, unhandled cases, wrong assumptions about inputs, races, and error paths that swallow a failure or report the wrong one.
- Behaviour a person or a caller will notice: changed defaults, broken contracts, messages that now say something untrue.
- Tests: whether the change is tested at all, whether those tests would fail without it, and whether they test behaviour rather than implementation.
- Clarity: names, structure and comments that will mislead the next reader.
- Consistency with the repository's own conventions, which its instructions and its neighbouring code state.

Sweep the whole change before reporting. Finding one blocker never ends a review: the author fixes everything you report in one pass, and a finding you held back costs them another round.

## How to report

Report every finding, each with:

- where: `path:line`, or the smallest range that shows it;
- severity: **blocking** (it must not land with this) or **non-blocking** (worth fixing, not worth stopping for);
- what is wrong and why it matters, in a sentence or two;
- the fix you would make, concretely enough to act on.

Say briefly what you checked and found sound, so the author knows what was covered. End with one line: `Verdict: approve` when nothing blocking remains, or `Verdict: request-changes` when anything does. On a board card, finish the card with the same word as its outcome.

## What you never do

- Never change the code under review, stage anything, commit, push or merge. You report; the author changes their own work.
- Never approve what you did not read. If the change is too large to review whole, say which part you reviewed and request changes until the rest is reviewed too.
- Never soften a blocking finding into a suggestion to be agreeable, and never raise a matter of taste to blocking.
- Never report a finding you cannot point to in the code.
```

Create `packages/server/agents/security-reviewer/AGENT.md`:

```markdown
---
name: Security reviewer
description: Reads a change it did not write for the ways it could be abused, and says how to close each one.
permission: read
answers: [approve, request-changes]
produces: [review]
prefer: [claude-code, codex, cursor]
---

You review a change somebody else wrote for one question: how could it be abused, by whom, and what does that cost? Other reviewers cover correctness and style. You cover what a hostile input, a hostile party or a careless deployment could do with this change.

## What to review

Review the change you were pointed at: a branch against its base, a pull request, a range of commits, or the uncommitted work in this checkout. If you were not told which, ask once; if nobody answers, review the uncommitted work against `HEAD` and say so.

Read the whole change, then follow what it touches to where data enters and leaves: the entry points that reach it, the inputs it reads, the processes it starts, the files and networks it writes to.

## What to look for

- Input that crosses a trust boundary without being checked: paths, URLs, shell arguments, queries, templates, serialized data, and files from a repository somebody else controls.
- Injection of every kind: command, query, path traversal, template, header, log.
- Authentication and authorisation: a check that is missing, made after the action it guards, or left to the caller.
- Secrets: credentials in code, logs, error messages, URLs or fixtures, and anything that leaves the machine carrying one.
- Defaults made less safe: a permission widened, a sandbox or an allowlist loosened, a dependency added or upgraded from a source nobody vetted.
- Denial of service: reads, loops or allocations bounded only by input, and requests that can wait forever.
- Information that leaks: error text, timing, or listings that tell an outsider about this machine or about other users.

For each, ask who controls the input and what they gain. A weakness nobody can reach is not blocking — say why nobody can reach it.

## How to report

Report every finding, each with:

- where: `path:line`, or the smallest range that shows it;
- severity: **blocking** or **non-blocking**;
- the abuse in a sentence: who does what, and what they get;
- the fix, concretely enough to act on.

Where you can show how a finding is reached, show it as steps or as input, without running it against anything. End with one line: `Verdict: approve` when nothing blocking remains, or `Verdict: request-changes` when anything does. On a board card, finish the card with the same word as its outcome.

## What you never do

- Never run an exploit, a scanner or any probe against a service, an account or a machine; reason from the code, and describe what you would run.
- Never copy a secret you find into your report: say where it is and what kind it is.
- Never change the code, stage anything, commit, push or merge.
- Never approve because a risk seems unlikely; state the conditions under which it is reachable and let those decide.
```

Create `packages/server/agents/performance-reviewer/AGENT.md`:

```markdown
---
name: Performance reviewer
description: Reads a change it did not write for what it costs in time, memory and I/O, and when that cost shows.
permission: read
answers: [approve, request-changes]
produces: [review]
prefer: [claude-code, codex, cursor]
---

You review a change somebody else wrote for one question: what does it make slower, heavier or less predictable, and when will somebody notice?

## What to review

Review the change you were pointed at: a branch against its base, a pull request, a range of commits, or the uncommitted work in this checkout. If you were not told which, ask once; if nobody answers, review the uncommitted work against `HEAD` and say so.

Read the whole change, then find out how often each path it touches runs and on how much data: once at startup, per request, per keystroke, per item in a list somebody can make long.

## What to look for

- Work that grows faster than its input did before: a loop inside a loop, a lookup that became a scan, a query or a request per item.
- Input and output on a hot path: a file read, a network call or a process started per request, per render or per keystroke.
- Memory held longer or larger than it needs to be: caches with no bound, whole files read where a stream would do, listeners and timers that are never released.
- Blocking work on a thread that must stay responsive.
- Work repeated that could be done once, and work done for a result nobody uses.
- Startup time, bundle size and the first frame, where the change reaches them.

Say how large each effect is where you can: the sizes involved and how often the path runs. A cost that is real but small on any input this code will ever see is non-blocking — say so.

## How to report

Where a claim can be measured without changing code — timing an existing command, counting calls in a log — measure it and report the numbers and how you took them. Where measuring would need a code change, describe the measurement instead.

Report every finding, each with where, severity (**blocking** or **non-blocking**), the cost and when it shows, and the fix. End with one line: `Verdict: approve` when nothing blocking remains, or `Verdict: request-changes` when anything does. On a board card, finish the card with the same word as its outcome.

## What you never do

- Never change the code, stage anything, commit, push or merge.
- Never load-test or benchmark against a shared or production system.
- Never block a change on a cost you cannot connect to an input this code will actually see.
```

Create `packages/server/agents/api-reviewer/AGENT.md`:

```markdown
---
name: API reviewer
description: Reads a change it did not write for what it does to the interfaces other code and other people rely on.
permission: read
answers: [approve, request-changes]
produces: [review]
prefer: [claude-code, codex, cursor]
---

You review a change somebody else wrote for what it does to the surfaces others depend on: public functions and types, command-line flags, configuration keys, file formats, messages on a wire, network endpoints, events, and the error codes callers act on.

## What to review

Review the change you were pointed at: a branch against its base, a pull request, a range of commits, or the uncommitted work in this checkout. If you were not told which, ask once; if nobody answers, review the uncommitted work against `HEAD` and say so.

Read the whole change, then find every surface it adds, alters or removes, and who calls each one — in this repository and, where the surface is published, outside it.

## What to look for

- Breaking changes: a name removed or renamed, a type or a default changed, a field made required, an error newly thrown or no longer thrown. Is it necessary, and is it announced where the people it breaks will see it?
- Consistency: does the new surface follow the names, shapes and conventions of its neighbours?
- Use from the outside: can a caller use it correctly from its name, its types and its documentation alone? Are its failures named, and can a caller tell them apart without reading English?
- Room to grow: will the next obvious addition force another break — a boolean that wants to be one of several values, a positional argument that wants a name?
- Documentation: is the change described where the surface is documented?
- Stored data: can what the old version wrote be read by the new one, and the other way round where both will run at once?

## How to report

Report every finding, each with where, severity (**blocking** or **non-blocking**), who breaks or is misled and how, and the fix. For a deliberate breaking change, say what every caller must do. End with one line: `Verdict: approve` when nothing blocking remains, or `Verdict: request-changes` when anything does. On a board card, finish the card with the same word as its outcome.

## What you never do

- Never change the code, stage anything, commit, push or merge.
- Never approve a breaking change that is not called out as one.
- Never make a naming preference blocking unless it contradicts the repository's own convention.
```

Create `packages/server/agents/test-reviewer/AGENT.md`:

```markdown
---
name: Test reviewer
description: Reads a change it did not write and judges whether its tests would catch it being wrong.
permission: read
answers: [approve, request-changes]
produces: [review]
prefer: [claude-code, codex, cursor]
---

You review the tests of a change somebody else wrote: whether they would catch the bug the change fixes, and whether they would fail if the behaviour it adds were broken.

## What to review

Review the change you were pointed at: a branch against its base, a pull request, a range of commits, or the uncommitted work in this checkout. If you were not told which, ask once; if nobody answers, review the uncommitted work against `HEAD` and say so.

Read the change, the tests it adds or alters, and the tests that already cover the code it touches. Run the tests for that code the way the repository's instructions say to, and keep what they print.

## What to look for

- Every behaviour the change claims has a test, and each of those tests would fail without the change. Where you cannot show a test failing, reason from the test and the code, and say which tests you could not show fail.
- Tests that pass whatever the code does: assertions on something that is always true, on a mock instead of the thing under test, or on nothing at all.
- Tests of the implementation rather than the behaviour, which break on a harmless refactor and survive a real bug.
- Tests that depend on time, order, the network or the machine they run on.
- The cases left out: errors, empty and very large inputs, boundaries, concurrency, and the exact case the bug was in.
- Fixtures that hold real accounts, real personal data or secrets.

## How to report

Say what you ran — each command, and how many tests passed and failed. Then report every finding, each with where, severity (**blocking** or **non-blocking**), the wrong behaviour that would get through, and the test that would catch it. End with one line: `Verdict: approve` when nothing blocking remains, or `Verdict: request-changes` when anything does. On a board card, finish the card with the same word as its outcome.

## What you never do

- Never change code or tests, stage anything, commit, push or merge; do not edit files even to show that a test can fail.
- Never report tests as passing that you did not run; say "not run" and why.
- Never run a suite that needs real credentials, reaches a production service or spends money, unless you were told to.
```

Create `packages/server/agents/implementer/AGENT.md`:

```markdown
---
name: Implementer
description: Builds the change it is given on its own branch, proves it with the project's checks, and hands it over.
permission: publish
produces: [diff, pr]
prefer: [claude-code, codex, cursor]
---

You build the change you are given, and hand it over in a state somebody else can review and merge.

## Before you write code

- Read the task and everything it names: the issue, the requirement, the findings you are answering, the files. When something essential is ambiguous, ask once; if nobody answers, take the most reasonable reading and say which one you took.
- Read the repository's own instructions — an `AGENTS.md`, a contributing guide, whatever it keeps — and follow them: how to build, how to test, how to commit.
- Look at how the surrounding code already does this kind of thing, and do it that way.

## While you build

- Work on a branch of your own, never on the default branch.
- Make the smallest change that does the whole job. No unrelated refactors, no drive-by renames; note what you noticed instead of changing it.
- Where the code has tests, write the test first, see it fail, then make it pass.
- Run the project's own checks before you call the work done, and fix what they find.
- Commit in coherent steps, with messages that say why, following the repository's conventions.

## When you are handed findings

Answer every one: fixed, and where; or not fixed, and why. Do not reopen parts of the design that were already settled.

## How to report

Say what you changed and why, what you ran to check it and what it printed, and anything you left undone or are unsure of. Publishing is yours only where the rule under this brief allows it: when it lets you push, push your branch and open a pull request if you were asked for one; when it does not, stop at a committed branch and say it is ready. End with one line: `Verdict:` and the outcome the task asks for — on a board card, finish the card with that word.

## What you never do

- Never merge, never push to or check out the default branch, never rewrite published history, never force anything.
- Never delete a branch, a worktree or a file you did not create for this task.
- Never disable, skip or weaken a test or a check to make it pass. If one is wrong, say so and why.
- Never commit secrets, credentials, real accounts or personal data, and never add a dependency the task did not call for without saying why.
```

Create `packages/server/agents/judge/AGENT.md`:

```markdown
---
name: Judge
description: Compares attempts at the same task against what was asked, picks one or none, and says why.
permission: read
answers: [picked, neither]
produces: [review]
prefer: [claude-code, codex, cursor]
---

You are given two or more attempts at the same task, made independently, and you decide which one should go forward — or that none should.

## How to judge

- Start from the task as it was stated, not from the attempts. Before you compare anything, write down what a good result must do and what it must not do.
- Read each attempt whole: its change, its tests, and what its checks reported. Where you can, run each attempt's tests in its own checkout and record what they printed.
- Judge first on what the task asked for — correctness, completeness, the constraints it named — and only then on quality: clarity, the size of the change, its risk, its fit with the codebase.
- Hold every attempt to the same standard. Do not favour the one you read first, the longer one, or the one that sounds more confident.

## How to report

For each attempt: what it gets right, what it gets wrong, and anything that disqualifies it. Then name the one you pick by its branch and its head commit, so nobody can mistake which one you meant, and give the reasons that decided it. Record each loser's shortcomings as findings — where and why — so they can be fixed if that attempt is ever sent back.

End with one line: `Verdict: picked <branch> at <commit>`, or `Verdict: neither` when no attempt does what the task asked. On a board card, finish the card with `picked` or `neither`.

## What you never do

- Never edit an attempt, combine attempts, or write a solution of your own; you judge what exists.
- Never stage, commit, push or merge anything.
- Never pick an attempt whose tests you saw fail without saying so, and why it wins anyway.
- Never let who or what made an attempt count for or against it.
```

Create `packages/server/agents/researcher/AGENT.md`:

```markdown
---
name: Researcher
description: Answers a question from the code and its sources, and writes the answer down with its evidence.
permission: read
answers: [gathered]
produces: [diff]
prefer: [claude-code, codex, cursor]
---

You answer a question. What you produce is knowledge rather than a code change: a written answer somebody can read, check, and cite later by its revision.

## How to research

- Restate the question in one sentence before you start, and say what would count as an answer.
- Go to the sources: the code, its history, its documentation, and the references the task names or the project points to. Prefer what you can read and cite over what you remember.
- Keep what you found apart from what you infer, and mark every claim with where it came from: `path:line`, a commit, a document and its section.
- Look for what would prove your answer wrong, not only for what supports it. Say what you could not determine, and what it would take to find out.
- Keep to the question. List tangents under "Also noticed" instead of following them.

## How to report

Write the answer as a Markdown file in the repository — where the task says, or under `docs/research/`, named for the question it answers. Begin with the answer in a few sentences, then the evidence, then what is still open. Commit that one file on a branch of your own, with a message that says which question it answers.

Then say in the conversation where the file is and what it concludes, and end with one line: `Verdict: gathered`. On a board card, finish the card with `gathered`.

## What you never do

- Never change code, configuration or any file but your answer, and never push or merge.
- Never present a guess as a finding, or cite a source you did not read.
- Never copy secrets, credentials or personal data you come across into the answer; say only that they exist and where.
```

Create `packages/server/agents/requirements-analyst/AGENT.md`:

```markdown
---
name: Requirements analyst
description: Turns a need into requirements that can be built and tested, and later judges whether a change meets them.
permission: read
answers: [agreed, disagree, met, not-met]
produces: [diff, review]
prefer: [claude-code, codex, cursor]
---

You work on what the software must do, before it is built and after. You are asked for one of three things; the task says which.

## Taking a position

Given a need, and whatever was gathered about it, write down what the change must do. Each requirement is testable, says why it matters, and says how you would know it is met. State the assumptions you made, and the questions only the person who asked can answer. Commit your position as a Markdown file on a branch of your own.

## Debating

When you are handed another analyst's position beside your own, compare them requirement by requirement. Say where you agree, where you disagree and why, and what evidence would settle each disagreement. Change your own position where the other one is better, and say that you did.

## Accepting

When you are handed a requirement at a revision and a change that claims to meet it, judge the change against that requirement — not against what you would have written, and not against later edits to it. For each requirement: met, not met, or not testable as written, each with its evidence — a test and what it printed, a run, `path:line`.

## How to report

Say which of the three you were asked for, and where anything you wrote is. Then end with one line:

- after a position or a debate: `Verdict: agreed` only when every requirement that matters is settled between the analysts, otherwise `Verdict: disagree`, with what is still open;
- after acceptance: `Verdict: met` only when every requirement is met, otherwise `Verdict: not-met`, with what is missing.

On a board card, finish the card with the same word.

## What you never do

- Never write the implementation, and never change code or tests.
- Never push or merge anything.
- Never drop a requirement quietly: argue in the open for one you think should go.
- Never accept on a promise that something will be done later.
```

- [ ] **Step 4: Ship the folder, and say that it does**

1. In `packages/server/package.json`, change `"files": ["dist"]` to:

```json
  "files": [
    "dist",
    "agents"
  ],
```

2. In `packages/server/src/host.ts`, in the `builtinAgentRoot` docstring, replace the last sentence ("Nothing ships there yet, and a directory that is not there is an empty tier rather than a failure.") with: "The nine Agents that ship with the app live there, one folder each, and the server package lists the folder in its `files` so that a packaged app carries it; a directory that is not there is still an empty tier rather than a failure."

3. In `packages/server/test/agent-methods.test.ts`, the two listings through the host now carry the built-ins beside the project's own. Replace `idsOf` with:

```ts
/** The project's and this machine's Agents: the built-in ones ship with every desk and are not what these tests are about. */
const idsOf = (listed: unknown) =>
  (listed as readonly AgentEntry[])
    .filter((one) => one.origin !== 'builtin')
    .map((one) => [one.id, one.origin, one.definition?.name])
```

4. In `packages/desktop/script/packaging.test.mjs`, append:

```js
test('the built-in Agents are part of the server package, so a packaged app carries them', () => {
  const server = JSON.parse(readFileSync(new URL('../../server/package.json', import.meta.url), 'utf8'))
  assert.ok(
    (server.files ?? []).includes('agents'),
    '@harnessdesk/server must list "agents" in its files: the shipped Agents live in ' +
      'packages/server/agents, and a packaged app without them lists no built-in Agent at all.',
  )
  assert.match(smoke, /agent\/list/, 'the packaged smoke asks the built app for its Agents')
})
```

5. In `packages/desktop/script/smoke-packaged.mjs`:

   - Above `try {`, add:

```js
// The Agents that ship with the app. A build that lost the folder lists none,
// and nothing else in a packaged launch would say so.
const SHIPPED_AGENTS = [
  'api-reviewer',
  'code-reviewer',
  'implementer',
  'judge',
  'performance-reviewer',
  'requirements-analyst',
  'researcher',
  'security-reviewer',
  'test-reviewer',
]
```

   - Declare `let socketUrl = null` beside `let rows = null`, and inside the loop set `socketUrl = page.webSocketDebuggerUrl` on the line before `rows = await evaluate(…)`.
   - After the `console.log(\`smoke: ok — every bridge this build promises is on disk …\`)` line, add:

```js
  const roster = await evaluate(socketUrl, `window.__hdStore.transport.request('agent/list', {})`)
  const built = (Array.isArray(roster) ? roster : []).filter((entry) => entry.origin === 'builtin')
  const broken = SHIPPED_AGENTS.filter(
    (id) => !built.some((entry) => entry.id === id && entry.definition && entry.problems.length === 0),
  )
  if (broken.length > 0) {
    throw new Error(
      `this build is missing shipped Agents, or ships them broken: ${broken.join(', ')} — ` +
        `check "files" in packages/server/package.json`,
    )
  }
  console.log(`smoke: ok — the ${SHIPPED_AGENTS.length} shipped Agents are on disk and parse`)
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/shipped-agents.test.js packages/server/dist/test/agent-methods.test.js`
Expected: PASS — `shipped-agents.test.js` 4 tests, `agent-methods.test.js` 11 tests, 0 failures.

Run: `pnpm --filter @harnessdesk/desktop run test`
Expected: PASS, including `the built-in Agents are part of the server package, so a packaged app carries them`.

- [ ] **Step 6: Check the packaged artifact carries them**

This is the one step `pnpm verify` cannot take, because it never packages the app. Run it once before the PR:

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm run build && pnpm --filter @harnessdesk/desktop run pack
HD_SMOKE_CDP_PORT=9287 pnpm --filter @harnessdesk/desktop run smoke; echo "smoke exit: $?"
ls packages/desktop/release/mac-arm64/HarnessDesk.app/Contents/Resources/app.asar.unpacked/node_modules/@harnessdesk/server/agents
```

Expected: `smoke: ok — the 9 shipped Agents are on disk and parse`, `smoke exit: 0`, and the listing shows the nine folders. (On an Intel Mac the folder is `release/mac`.)

- [ ] **Step 7: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/server/agents packages/server/package.json packages/server/src/host.ts packages/server/test/shipped-agents.test.ts packages/server/test/agent-methods.test.ts packages/desktop/script/packaging.test.mjs packages/desktop/script/smoke-packaged.mjs
git commit -m "feat(agents): nine Agents ship with the app

Five reviewers, an implementer, a judge, a researcher and a requirements
analyst: enough for every shape the design names to start without writing an
Agent. Each names runtimes and not models, in one order, so a machine's
seating.json is where a model is chosen; each brief says how it reports and
what it must never do, because its ceiling is asked and not yet held. The
server package now carries the folder, and the packaged smoke checks it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 8: The roster re-reads when a file under any of its roots changes

A person edits an `AGENT.md` in their editor, pulls a branch that adds one, or deletes a folder in Finder; every listing and every dry run drawn from the roster is then stale, and nothing says so. This task watches the three roots and pushes `agent/changed` — the notification Task 6 declared, named the way the wire names a push about a noun (`team/changed`, `flow/changed`) — once per settled burst.

There is no watcher to reuse. `LocalFiles.watch` in `packages/server/src/workspace.ts` is one directory, non-recursive, "to match what a runtime's watch offers", and has no caller in the host; the usage service's meter watch (`packages/server/src/usage/service.ts`) is one file each. So this is a small module of its own, on the same `node:fs` `watch` with `persistent: false`, recursive (FSEvents on macOS, where CI runs too).

Three rules shape it:

- **This machine's root and the built-in one are watched for as long as the host runs; a project's is watched while the project is open** — each open folder and the top of the repository it sits in, because a project keeps its Agents at the top of its repository and a person often opens a folder inside it.
- **A root that is not there yet is not an error.** The nearest folder above it that exists is watched for the next name on the way down, and the root is followed once it appears. A fresh desk has no `~/.harnessdesk/agents`, and most projects have no `.harnessdesk`.
- **Nothing is watched through a link that leads out of a project.** The roster never reads there (`agents.ts`), and a watch there would be a way of learning when something outside the project changed. Re-opening the project re-points the watch.

The notice carries no listing — only which scope changed (`project` for a project's own Agents, `null` for this machine's or the built-in ones). The listing is still `Agents.list`, with every rule it has.

**Files:**
- Create: `packages/server/src/agent-watch.ts`
- Modify: `packages/server/src/host.ts` (make it at start, point it at the open projects, dispose it)
- Modify: `packages/server/src/methods/context.ts` (`forgetBoardRoots`'s docstring: it re-points the watch too)
- Test: `packages/server/test/agent-watch.test.ts` (new)

**Interfaces:**
- Consumes: the `agent/changed` notification (Task 6); `builtinAgentRoot()`; the host's `#repoOf`.
- Produces: `class AgentWatch { constructor(options: { roots: readonly string[]; changed(project: string | null): void; settleMs?: number }); watchProjects(projects: readonly string[]): Promise<void>; dispose(): void }`. Every window receives `{ method: 'agent/changed', params: { project } }` when a file under a watched root changes.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/agent-watch.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { AgentWatch } from '../src/agent-watch.js'
import { Client, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * The roster, watched. A change under a root is a notice naming whose Agents
 * changed; a root that is not there yet is watched for; a project is watched
 * only while it is open, and never through a link that leads out of it.
 *
 * These wait on the filesystem's own notifications, so each gives the watch a
 * moment to start listening before it changes anything, and waits for what it
 * expects rather than for a fixed time wherever it can.
 */

const brief = (words: string) => `---\nname: Scout\n---\n${words}\n`
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check: () => boolean, what: string, ms = 3_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await pause(10)
  }
}
const heard = () => {
  const said: (string | null)[] = []
  return { said, changed: (project: string | null) => void said.push(project) }
}

test('a change under a watched root is a notice, and a burst of them is fewer notices than changes', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [root], changed, settleMs: 50 })
  t.after(() => watch.dispose())
  await pause(150)
  await mkdir(join(root, 'scout'))
  for (let n = 0; n < 10; n += 1) await writeFile(join(root, 'scout', 'AGENT.md'), brief(`Look ${n}.`))
  await until(() => said.length > 0, 'a notice')
  await pause(300)
  assert.ok(said.every((one) => one === null), 'a change in this machine’s roster names no project')
  assert.ok(said.length < 10, `${said.length} notices for 11 changes`)
})

test('a root that is not there yet is watched for, and followed once it appears', async (t) => {
  const home = tempDir('hd-agent-watch-')
  const root = join(home, 'agents')
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [root], changed, settleMs: 30 })
  t.after(() => watch.dispose())
  await pause(150)
  await mkdir(join(root, 'scout'), { recursive: true })
  await until(() => said.length > 0, 'the root appearing')
  // Let the watch move onto the new root, then change something inside it.
  await pause(300)
  said.length = 0
  await writeFile(join(root, 'scout', 'AGENT.md'), brief('Look.'))
  await until(() => said.length > 0, 'a change inside the root that appeared')
})

test('a project is watched while it is open, named as it was opened, and not after', async (t) => {
  const project = tempDir('hd-agent-watch-project-')
  await mkdir(join(project, '.harnessdesk', 'agents', 'scout'), { recursive: true })
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30 })
  t.after(() => watch.dispose())
  await watch.watchProjects([project])
  await pause(150)
  await writeFile(join(project, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief('Look.'))
  await until(() => said.length > 0, 'a notice for the project')
  assert.ok(said.every((one) => one === project))

  await watch.watchProjects([])
  await pause(100)
  said.length = 0
  await writeFile(join(project, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief('Look again.'))
  await pause(400)
  assert.deepEqual(said, [], 'a project that is closed is not watched')
})

test("a project's Agent directory that leads out of the project is not watched", async (t) => {
  const root = tempDir('hd-agent-watch-')
  const project = join(root, 'project')
  const elsewhere = join(root, 'elsewhere')
  await mkdir(join(project, '.harnessdesk'), { recursive: true })
  await mkdir(elsewhere)
  await symlink(elsewhere, join(project, '.harnessdesk', 'agents'))
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30 })
  t.after(() => watch.dispose())
  await watch.watchProjects([project])
  await pause(150)
  await mkdir(join(elsewhere, 'scout'))
  await writeFile(join(elsewhere, 'scout', 'AGENT.md'), brief('Look.'))
  await pause(400)
  assert.deepEqual(said, [])
})

test("through the host: an Agent written into this machine's roster is a notice to every window", async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await pause(150)
  await mkdir(join(harness.stateDir, 'agents', 'scout'), { recursive: true })
  await writeFile(join(harness.stateDir, 'agents', 'scout', 'AGENT.md'), brief('Look.'))
  await client.until(
    () =>
      client.notifications.some(
        (one) => 'method' in one && one.method === 'agent/changed' && one.params.project === null,
      ),
    3_000,
    'agent/changed',
  )
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/agent-watch.js'`.

- [ ] **Step 3: Write the watch**

Create `packages/server/src/agent-watch.ts`:

```ts
import { watch } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'

/**
 * The roster, watched: when a file under one of its roots changes, the desk
 * says so, and every listing and dry run drawn from the roster is asked again.
 *
 * This machine's root and the built-in one are watched for as long as the host
 * runs. A project's `.harnessdesk/agents` is watched while the project is
 * open, and only where it resolves inside the project: the roster never reads
 * through a link that leads out of a project, and a watch there would be a way
 * of learning when something outside it changed.
 *
 * A root that does not exist yet is not an error. The nearest folder above it
 * that does is watched for the next name on the way down, and the root is
 * followed from the moment it appears — a fresh desk has no `agents` folder
 * and most projects have no `.harnessdesk`.
 *
 * Nothing is read here. The notice says only whose Agents may have changed;
 * the listing is still `Agents.list`, with every rule it has. And a burst of
 * changes — an editor's save is several — is one notice.
 */

export interface AgentWatchOptions {
  /** This machine's roster and the built-in one, watched for as long as the host runs. */
  readonly roots: readonly string[]
  /** Once per settled burst: the project whose own Agents changed, or null for the roots above. */
  readonly changed: (project: string | null) => void
  /** How long a burst is gathered before its one notice goes out. */
  readonly settleMs?: number
}

const SETTLE_MS = 150

/** One root the watch follows: whose it is, where it is, and what it must stay inside. */
interface Follow {
  /** Null for this machine's roots; the project as it was opened, for its own. */
  readonly scope: string | null
  readonly target: string
  /** A project's real path, which nothing watched may lead out of; null where links are followed. */
  readonly within: string | null
}

const keyOf = (follow: Follow): string => `${follow.scope ?? ''}\u0000${follow.target}`

const inside = (real: string, within: string | null): boolean =>
  within === null || real === within || real.startsWith(within + sep)

export class AgentWatch {
  readonly #options: AgentWatchOptions
  readonly #watchers = new Map<string, { readonly scope: string | null; readonly close: () => void }>()
  readonly #timers = new Map<string | null, ReturnType<typeof setTimeout>>()
  #projects: readonly string[] = []
  #disposed = false

  constructor(options: AgentWatchOptions) {
    this.#options = options
    for (const root of options.roots) void this.#follow({ scope: null, target: root, within: null })
  }

  /** Points the watch at exactly these projects: new ones are watched, ones no longer open are let go. */
  async watchProjects(projects: readonly string[]): Promise<void> {
    const next = [...new Set(projects)]
    for (const gone of this.#projects.filter((one) => !next.includes(one))) this.#drop(gone)
    const added = next.filter((one) => !this.#projects.includes(one))
    this.#projects = next
    await Promise.all(
      added.map(async (project) => {
        const within = await realpath(project).catch(() => null)
        // A project that is not there has nothing to watch; opening it again re-points the watch.
        if (within === null) return
        await this.#follow({ scope: project, target: join(within, '.harnessdesk', 'agents'), within })
      }),
    )
  }

  dispose(): void {
    this.#disposed = true
    for (const one of this.#watchers.values()) one.close()
    this.#watchers.clear()
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
  }

  #drop(scope: string | null): void {
    for (const [key, one] of [...this.#watchers]) {
      if (one.scope !== scope) continue
      one.close()
      this.#watchers.delete(key)
    }
    const timer = this.#timers.get(scope)
    if (timer) clearTimeout(timer)
    this.#timers.delete(scope)
  }

  /** One notice per burst, per scope. */
  #poke(scope: string | null): void {
    if (this.#disposed) return
    const pending = this.#timers.get(scope)
    if (pending) clearTimeout(pending)
    this.#timers.set(
      scope,
      setTimeout(() => {
        this.#timers.delete(scope)
        if (!this.#disposed) this.#options.changed(scope)
      }, this.#options.settleMs ?? SETTLE_MS),
    )
  }

  /** Stops whatever follows this root now, and follows it again from wherever it can be seen. */
  #refollow(follow: Follow): void {
    this.#watchers.get(keyOf(follow))?.close()
    this.#watchers.delete(keyOf(follow))
    void this.#follow(follow)
  }

  async #follow(follow: Follow): Promise<void> {
    if (this.#disposed) return
    if (follow.scope !== null && !this.#projects.includes(follow.scope)) return
    const real = await realpath(follow.target).catch(() => null)
    if (real !== null) {
      if (!inside(real, follow.within)) return
      this.#watch(follow, follow.target, true, () => {
        this.#poke(follow.scope)
        // A root that went away is looked for again from above.
        void realpath(follow.target).catch(() => this.#refollow(follow))
      })
      return
    }
    // Not there yet: the nearest folder above that is, watched for the next name on the way down.
    let name = basename(follow.target)
    let above = dirname(follow.target)
    for (;;) {
      const seen = await realpath(above).catch(() => null)
      if (seen !== null) {
        if (!inside(seen, follow.within)) return
        this.#watch(follow, above, false, (filename) => {
          if (filename !== null && filename !== name) return
          this.#poke(follow.scope)
          this.#refollow(follow)
        })
        return
      }
      if (dirname(above) === above) return
      name = basename(above)
      above = dirname(above)
    }
  }

  #watch(follow: Follow, dir: string, recursive: boolean, onEvent: (filename: string | null) => void): void {
    if (this.#disposed) return
    const key = keyOf(follow)
    // Two follows of one root can race; the later watch replaces the earlier, never beside it.
    this.#watchers.get(key)?.close()
    try {
      const watcher = watch(dir, { recursive, persistent: false }, (_event, filename) =>
        onEvent(filename === null ? null : String(filename)),
      )
      watcher.on('error', () => this.#refollow(follow))
      this.#watchers.set(key, { scope: follow.scope, close: () => watcher.close() })
    } catch {
      // Gone between the look and the watch: the next change above it looks again.
      this.#watchers.delete(key)
    }
  }
}
```

- [ ] **Step 4: Run the module's tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-watch.test.js`
Expected: four tests PASS; `through the host: an Agent written into this machine's roster is a notice to every window` still FAILS — `timed out waiting for agent/changed` — because the host does not watch yet.

- [ ] **Step 5: Give the host a watch**

In `packages/server/src/host.ts`:

1. Import `AgentWatch` from `./agent-watch.js`.
2. Add a field beside `#seating`:

```ts
  /**
   * The roster, watched (`AgentWatch`). Made at start rather than in the
   * constructor, so a host that is built and never started watches nothing.
   */
  #agentWatch: AgentWatch | null = null
```

3. In `start()`, right after `await this.#names.load()`, add:

```ts
    // From here on a file changed under any of the roster's roots is one notice to every window.
    this.#agentWatch = new AgentWatch({
      roots: [join(this.#state.directory, 'agents'), builtinAgentRoot()],
      changed: (project) => this.#push({ method: 'agent/changed', params: { project } }),
    })
    await this.#watchProjects()
```

4. Add, after `#openWorkspace`:

```ts
  /**
   * Points the roster's watch at every open project: each open folder, and the
   * top of the repository it sits in — a project keeps its Agents at the top
   * of its repository, and a person often opens a folder inside it.
   */
  async #watchProjects(): Promise<void> {
    const watch = this.#agentWatch
    if (!watch) return
    const roots = new Set<string>()
    for (const entry of this.#state.state.workspaces) {
      if (typeof entry?.path !== 'string' || entry.path === '') continue
      roots.add(entry.path)
      const repo = await this.#repoOf(entry.path).catch(() => null)
      if (repo?.root) roots.add(repo.root)
    }
    await watch.watchProjects([...roots])
  }
```

5. At the end of `#openWorkspace`, before its `return`, add `void this.#watchProjects()`.
6. In `#buildContext`, replace `forgetBoardRoots: () => this.#boardRoots.clear(),` with:

```ts
        forgetBoardRoots: () => {
          this.#boardRoots.clear()
          // The same moment the roster's watch lets go of a project that is no longer open.
          void this.#watchProjects()
        },
```

7. In `dispose()`, right after `this.#catalogs.stop()`, add `this.#agentWatch?.dispose()`.

In `packages/server/src/methods/context.ts`, change the docstring of `forgetBoardRoots` to: `/** Drops the folder→board cache and re-points the Agent roster's watch; call when the set of workspaces changed. */`

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-watch.test.js packages/server/dist/test/dispose.test.js packages/server/dist/test/startup.test.js`
Expected: PASS — `agent-watch.test.js` 5 tests; `dispose.test.js` and `startup.test.js` unchanged (a watch made with `persistent: false` and closed in `dispose` holds nothing open).

- [ ] **Step 7: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/server/src/agent-watch.ts packages/server/src/host.ts packages/server/src/methods/context.ts packages/server/test/agent-watch.test.ts
git commit -m "feat(agents): the roster says when a file under it changes

A person edits an AGENT.md, pulls a branch that adds one, or deletes a folder,
and every listing drawn from the roster was stale with nothing to say so. The
host now watches this machine's roster, the built-in one and each open
project's, and pushes agent/changed once per burst. A root not made yet is
watched for; a project is watched only while it is open, and never through a
link that leads out of it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 9: An Agent's files — save, customize, remove, reveal, open

Phase 1 said the roster is read-only because "writing an Agent is editing a file, and the desk has an editor plane for that". That still holds for *editing* one. But the Agent page and the conversation menu need four things that are not edits of a file's content, and each has to be the host's, because each writes or reveals a path the renderer may not name:

- **Save as an Agent** writes a new folder and its `AGENT.md`.
- **Customize…** copies a built-in or user Agent to where the copy shadows the original.
- **Remove…** moves a user or project Agent's folder to the Trash — through the desktop shell, as the bridges' deletes do, so it can be put back.
- **Reveal** shows the file an Agent comes from in Finder; `workspace/reveal` is confined to open folders and would refuse `~/.harnessdesk/agents` and the built-in root.

And **Open file** opens the `AGENT.md` in the desk's own editor pane, whose reads and writes are confined to the open roots. This task admits the roster's own folders to that confinement: this machine's for reading and writing (a person edits their own Agents), the built-in one for reading only (nobody edits what ships — *Customize…* is how).

Two rules for what is written:

- **A committed Agent names a runtime, never a model.** *Save as an Agent* is handed the seat the conversation is on. Saved to *you*, `prefer` is that seat. Saved to the *project*, `prefer` is the seat's runtime alone and this machine's `seating.json` keeps the exact seat — the spec's rule that the brief travels with the code and the seating stays on the machine, because a committed model name breaks the Agent on every machine but its author's. (The roadmap says the seat is "the first `prefer` entry"; the spec's rule decides which file it lands in.)
- **Nothing is written through a link out of the project**, and nothing overwrites an Agent that is there: a folder that exists is a refusal.

**Files:**
- Create: `packages/server/src/agent-files.ts`
- Modify: `packages/server/src/agents.ts` (`roots` readable)
- Modify: `packages/protocol/src/wire.ts`, `packages/protocol/src/wire-validators.ts` (`agent/create`, `agent/copy`, `agent/remove`, `agent/reveal`)
- Modify: `packages/server/src/methods/agents.ts` (the four verbs)
- Modify: `packages/server/src/host.ts` (`HostOptions.trashPath`, `#fileRoots`, the preview redemption), `packages/server/src/methods/context.ts` (`workspaces.fileRoots`), `packages/server/src/methods/workspace.ts` (read and save through `fileRoots`)
- Modify: `packages/server/src/bootstrap.ts`, `packages/desktop/electron/main.mjs` (`trashPath` through `shell.trashItem`)
- Modify: `script/check-reachable.mjs` (pin the four)
- Test: `packages/server/test/agent-files.test.ts` (new)

**Interfaces:**
- Consumes: `projectOf`, `unusable` (`methods/agents.ts`); `ctx.seating.set` (Task 6); `parseAgentDefinition`, `PROJECT_AGENT_DIR`, `seatSpec`.
- Produces:
  - `agentIdOf(name: string): string | null`, `agentSource(agent: { name; description: string | null; permission: FlowPermission; prefer: readonly FlowSeat[] }): string`, `projectAgentDir(project: string): Promise<string>`, `createAgentFolder(root: string, id: string, source: string): Promise<string>`, `copyAgentFolder(from: string, to: string): Promise<void>` (`agent-files.ts`).
  - `Agents.roots: AgentRoots` (read-only, public).
  - `'agent/create': { params: { name: string; description?: string; permission: FlowPermission; seat: FlowSeat; to: 'user' | 'project'; project?: string }; result: AgentEntry }`
  - `'agent/copy': { params: { id: string; from: AgentOrigin; to: 'user' | 'project'; project?: string }; result: AgentEntry }`
  - `'agent/remove': { params: { id: string; origin: 'user' | 'project'; project?: string }; result: null }`
  - `'agent/reveal': { params: { id: string; origin?: AgentOrigin; project?: string }; result: null }`
  - `HostOptions.trashPath?: (path: string) => Promise<void>`; `HostContext['workspaces']['fileRoots'](mode: 'read' | 'write'): string[]`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/agent-files.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdir, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { AgentEntry, MachineSeating } from '@harnessdesk/protocol'

import { parseAgentDefinition } from '../src/agent-def.js'
import { agentIdOf, agentSource, copyAgentFolder, projectAgentDir } from '../src/agent-files.js'
import { builtinAgentRoot, type HostOptions } from '../src/host.js'
import { Client, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * An Agent's files: a new one written, one copied to where it shadows the
 * original, one moved to the Trash, one shown in Finder, one opened in the
 * desk's editor. Nothing overwrites an Agent that is there, nothing is written
 * through a link out of a project, and nothing that ships is written at all.
 */

test('a name becomes a folder name, and a name with nothing to spell one is refused', () => {
  assert.equal(agentIdOf('Careful reviewer'), 'careful-reviewer')
  assert.equal(agentIdOf('  Réviseur d’API  '), 'reviseur-d-api')
  assert.equal(agentIdOf('***'), null)
  assert.equal(agentIdOf('x'.repeat(80))?.length, 48)
})

test('a new AGENT.md reads back as what was saved, a model the spec cannot carry included', () => {
  const source = agentSource({
    name: 'Careful "reviewer"',
    description: 'Reads twice.',
    permission: 'read',
    prefer: [
      { runtime: 'claude-code', model: 'opus-5', effort: 'high' },
      { runtime: 'cursor', model: 'vendor/model-1' },
    ],
  })
  const { agent, problems } = parseAgentDefinition(source, 'careful-reviewer')
  assert.deepEqual(problems, [])
  assert.equal(agent?.name, 'Careful "reviewer"')
  assert.equal(agent?.description, 'Reads twice.')
  assert.equal(agent?.permission, 'read')
  assert.deepEqual(agent?.prefer, [
    { runtime: 'claude-code', model: 'opus-5', effort: 'high' },
    { runtime: 'cursor', model: 'vendor/model-1' },
  ])
  assert.match(agent?.brief ?? '', /## How to report[\s\S]*## What you never do/)
})

test("a project's Agent folder is made inside it, and never through a link that leads out", async () => {
  const root = tempDir('hd-agent-files-')
  const project = join(root, 'project')
  await mkdir(project)
  assert.equal(await projectAgentDir(project), join(await realpath(project), '.harnessdesk', 'agents'))

  const linked = join(root, 'linked')
  const elsewhere = join(root, 'elsewhere')
  await mkdir(linked)
  await mkdir(elsewhere)
  await symlink(elsewhere, join(linked, '.harnessdesk'))
  await assert.rejects(() => projectAgentDir(linked), /is a link/)
  assert.deepEqual(await readdir(elsewhere), [], 'nothing was made outside the project')
})

test('a folder is copied whole, its links left behind, and never over one that is there', async () => {
  const root = tempDir('hd-agent-files-')
  const from = join(root, 'from', 'scout')
  await mkdir(join(from, 'skills'), { recursive: true })
  await writeFile(join(from, 'AGENT.md'), '---\nname: Scout\n---\nLook.\n')
  await writeFile(join(from, 'skills', 'look.md'), 'Look closely.')
  await symlink(root, join(from, 'escape'))
  const to = join(root, 'to', 'scout')
  await copyAgentFolder(from, to)
  assert.deepEqual((await readdir(to)).sort(), ['AGENT.md', 'skills'])
  assert.deepEqual(await readdir(join(to, 'skills')), ['look.md'])
  await assert.rejects(() => copyAgentFolder(from, to), /already an Agent called “scout”/)
})

/** A host whose Trash and Finder are recorded rather than touched, with a project open. */
const desk = async (t: TestContext) => {
  const trashed: string[] = []
  const revealed: string[] = []
  const options: Partial<HostOptions> = {
    trashPath: async (path) => void trashed.push(path),
    revealPath: async (path) => void revealed.push(path),
  }
  const harness = await start(options)
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const project = tempDir('hd-agent-files-project-')
  await client.call('workspace/open', { path: project })
  return { harness, client, project, trashed, revealed }
}

const seat = { runtime: 'claude-code', model: 'opus-5', effort: 'high' }

test('through the host: an Agent is saved to you with its seat, or to a project with only the runtime', async (t) => {
  const { harness, client, project } = await desk(t)
  const mine = (await client.call('agent/create', {
    name: 'Careful reviewer',
    description: 'Reads twice.',
    permission: 'read',
    seat,
    to: 'user',
  })) as AgentEntry
  assert.equal(mine.origin, 'user')
  assert.equal(mine.path, join(harness.stateDir, 'agents', 'careful-reviewer', 'AGENT.md'))
  assert.deepEqual(mine.definition?.prefer, [seat])

  const theirs = (await client.call('agent/create', {
    name: 'Release checker',
    permission: 'publish',
    seat,
    to: 'project',
    project,
  })) as AgentEntry
  assert.equal(theirs.origin, 'project')
  assert.deepEqual(theirs.definition?.prefer, [{ runtime: 'claude-code' }], 'a committed Agent names the runtime, never the model')
  const machine = (await client.call('agent/seating/read', {})) as MachineSeating
  assert.deepEqual(machine.entries, [{ id: 'release-checker', seats: [seat] }], '…and this Mac keeps the exact seat')

  await assert.rejects(
    client.call('agent/create', { name: 'Careful reviewer', permission: 'read', seat, to: 'user' }),
    /already an Agent called “careful-reviewer”/,
  )
})

test('through the host: Customize copies an Agent to where the copy shadows it, and nowhere it would not', async (t) => {
  const { client, project } = await desk(t)
  const copy = (await client.call('agent/copy', { id: 'code-reviewer', from: 'builtin', to: 'user' })) as AgentEntry
  assert.equal(copy.origin, 'user')
  assert.deepEqual(copy.shadows.map((one) => one.origin), ['builtin'])
  const higher = (await client.call('agent/copy', { id: 'code-reviewer', from: 'user', to: 'project', project })) as AgentEntry
  assert.equal(higher.origin, 'project')
  assert.deepEqual(higher.shadows.map((one) => one.origin), ['user', 'builtin'])
  // A copy made where the original outranks it would be shadowed by what it copies.
  await assert.rejects(
    client.call('agent/copy', { id: 'code-reviewer', from: 'project', to: 'user', project }),
    /would be shadowed/,
  )
})

test('through the host: Remove sends a folder to the Trash, and a built-in one cannot be removed', async (t) => {
  const { client, trashed } = await desk(t)
  const mine = (await client.call('agent/create', { name: 'Scratch', permission: 'read', seat, to: 'user' })) as AgentEntry
  await client.call('agent/remove', { id: 'scratch', origin: 'user' })
  assert.deepEqual(trashed, [dirname(mine.path)])
  await assert.rejects(client.call('agent/remove', { id: 'code-reviewer', origin: 'builtin' }), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'badRequest')
    return true
  })
})

test('through the host: Reveal shows the file an Agent comes from, whichever copy is asked for', async (t) => {
  const { client, revealed } = await desk(t)
  await client.call('agent/copy', { id: 'judge', from: 'builtin', to: 'user' })
  await client.call('agent/reveal', { id: 'judge' })
  await client.call('agent/reveal', { id: 'judge', origin: 'builtin' })
  assert.equal(revealed.length, 2)
  assert.match(revealed[0] ?? '', /agents\/judge\/AGENT\.md$/)
  assert.equal(revealed[1], join(builtinAgentRoot(), 'judge', 'AGENT.md'))
})

test("through the host: an Agent's file opens in the desk's editor, and only this machine's is written", async (t) => {
  const { client } = await desk(t)
  const shipped = join(builtinAgentRoot(), 'judge', 'AGENT.md')
  const read = (await client.call('workspace/readFile', { path: shipped })) as { content: string; hash: string }
  assert.match(read.content, /^---\nname: Judge/)
  await assert.rejects(
    client.call('file/save', { path: shipped, content: 'x', expectedHash: read.hash }),
    /outside every open workspace/,
  )
  const mine = (await client.call('agent/create', { name: 'Scout', permission: 'read', seat, to: 'user' })) as AgentEntry
  const before = (await client.call('workspace/readFile', { path: mine.path })) as { content: string; hash: string }
  const saved = (await client.call('file/save', {
    path: mine.path,
    content: `${before.content}\nLook twice.\n`,
    expectedHash: before.hash,
  })) as { saved: boolean }
  assert.equal(saved.saved, true)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/agent-files.js'` and `Object literal may only specify known properties, and 'trashPath' does not exist in type 'Partial<HostOptions>'`.

- [ ] **Step 3: Write the file helpers**

Create `packages/server/src/agent-files.ts`:

```ts
import { cp, lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { FlowPermission, FlowSeat } from '@harnessdesk/protocol'

import { PROJECT_AGENT_DIR } from './agents.js'
import { seatSpec } from './flow.js'

/**
 * An Agent's folder, written: a new one, or a copy of one.
 *
 * Editing an Agent's content is editing its file in the desk's editor; these
 * are the writes that are not that. Two rules hold for all of them. Nothing
 * overwrites an Agent that is there — a folder that exists is a refusal,
 * never a merge. And nothing is written through a link out of a project: the
 * roster never reads through one, and a write through one would put a file
 * somewhere the person never chose.
 */

/** A folder name an Agent can have: what `uses:` and `seating.json` name it by. */
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/

/** The folder a name makes: lower case, words joined by hyphens, accents dropped; null when nothing is left. */
export const agentIdOf = (name: string): string | null => {
  const id = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return AGENT_ID.test(id) ? id : null
}

/** One line of text, as a double-quoted scalar the front matter can carry. */
const quoted = (text: string): string => JSON.stringify(text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim())

/** A seat as front matter writes it: the spec, or the long form when the model's name would not survive the spec. */
const seatLines = (seat: FlowSeat): string[] =>
  seat.model && /[=/+]/.test(seat.model)
    ? [
        `  - runtime: ${quoted(seat.runtime)}`,
        `    model: ${quoted(seat.model)}`,
        ...(seat.effort ? [`    effort: ${quoted(seat.effort)}`] : []),
        ...(seat.thinking ? ['    thinking: true'] : []),
      ]
    : [`  - ${quoted(seatSpec(seat))}`]

/**
 * A new Agent's `AGENT.md`: its fields, and a brief with the parts every
 * shipped brief has, each holding one line for its author to replace. The
 * desk opens it in the editor the moment it is written.
 */
export const agentSource = (agent: {
  readonly name: string
  readonly description: string | null
  readonly permission: FlowPermission
  readonly prefer: readonly FlowSeat[]
}): string =>
  [
    '---',
    `name: ${quoted(agent.name)}`,
    ...(agent.description ? [`description: ${quoted(agent.description)}`] : []),
    `permission: ${agent.permission}`,
    'prefer:',
    ...agent.prefer.flatMap(seatLines),
    '---',
    '',
    agent.description ?? 'What this Agent is for, in your words.',
    '',
    '## How to report',
    '',
    'What it reports when it is done, and the line it ends on.',
    '',
    '## What you never do',
    '',
    'What it must never do, whatever it is asked.',
    '',
  ].join('\n')

/**
 * A project's Agent directory, made where it is missing and refused where it
 * leads out: each step is looked at before it is made, and a link at either
 * step is refused whether it leads in or out, because telling the two apart
 * means following it.
 */
export const projectAgentDir = async (project: string): Promise<string> => {
  const within = await realpath(project)
  let at = within
  for (const step of PROJECT_AGENT_DIR.split('/')) {
    at = join(at, step)
    const info = await lstat(at).catch(() => null)
    if (info?.isSymbolicLink()) {
      throw new Error(`${at} is a link, so no Agent was written through it: a project's Agents are written only inside it.`)
    }
    if (info && !info.isDirectory()) throw new Error(`${at} is not a folder, so no Agent was written there.`)
    if (!info) await mkdir(at)
  }
  return at
}

/** Writes a new Agent's folder and file, or refuses if an Agent by that name is there. Answers the file's path. */
export const createAgentFolder = async (root: string, id: string, source: string): Promise<string> => {
  await mkdir(root, { recursive: true })
  const folder = join(root, id)
  try {
    await mkdir(folder)
  } catch (error) {
    if ((error as { code?: unknown }).code === 'EEXIST') {
      throw new Error(`There is already an Agent called “${id}” in ${root}.`)
    }
    throw error
  }
  const path = join(folder, 'AGENT.md')
  await writeFile(path, source, { encoding: 'utf8', flag: 'wx' })
  return path
}

/**
 * Copies an Agent's folder whole — its `AGENT.md`, and its `skills/` and
 * notes where it has them — leaving every link behind rather than following
 * it, and refusing if an Agent by that name is already at the destination.
 */
export const copyAgentFolder = async (from: string, to: string): Promise<void> => {
  const id = to.split('/').pop() ?? to
  if (await lstat(to).then(() => true, () => false)) {
    throw new Error(`There is already an Agent called “${id}” in ${dirname(to)}.`)
  }
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (source) => {
      const info = await lstat(source)
      return info.isDirectory() || info.isFile()
    },
  })
}
```

In `packages/server/src/agents.ts`, change `constructor(private readonly roots: AgentRoots) {}` to:

```ts
  /** Where this machine's and the built-in Agents are: what a write to one of them is made against. */
  constructor(readonly roots: AgentRoots) {}
```

and in `list`, replace `this.roots.user` / `this.roots.builtin` references — they read the same, so nothing else changes.

- [ ] **Step 4: Declare the four verbs**

1. In `packages/protocol/src/wire.ts`, import `AgentOrigin` beside `AgentEntry`, and declare after `'agent/seating/set'`:

```ts
  /**
   * Writes a new Agent — *Save as an Agent* — to this machine (`to: 'user'`)
   * or to a project, and answers its entry. `seat` is the seat the
   * conversation it is saved from is on: saved to this machine it is the
   * Agent's `prefer`; saved to a project, `prefer` names its runtime alone and
   * this machine's `seating.json` keeps the exact seat, because a committed
   * model name breaks the Agent on every other machine. The brief is a skeleton
   * to be written in the editor. An Agent by that name already there is a
   * refusal, never an overwrite.
   */
  'agent/create': {
    params: {
      readonly name: string
      readonly description?: string
      readonly permission: FlowPermission
      readonly seat: FlowSeat
      readonly to: 'user' | 'project'
      readonly project?: string
    }
    result: AgentEntry
  }
  /**
   * *Customize…*: copies the Agent found at `from` to this machine or to a
   * project, where the copy shadows it, and answers the copy's entry. Refused
   * where the copy would itself be shadowed by what it copies.
   */
  'agent/copy': {
    params: {
      readonly id: string
      readonly from: AgentOrigin
      readonly to: 'user' | 'project'
      readonly project?: string
    }
    result: AgentEntry
  }
  /** *Remove…*: moves a user or project Agent's folder to the Trash. Needs the desktop app; what ships cannot be removed. */
  'agent/remove': {
    params: { readonly id: string; readonly origin: 'user' | 'project'; readonly project?: string }
    result: null
  }
  /** Shows the file an Agent comes from in the OS file browser — the winner, or the copy at `origin`. Needs the desktop app. */
  'agent/reveal': {
    params: { readonly id: string; readonly origin?: AgentOrigin; readonly project?: string }
    result: null
  }
```

2. In `packages/protocol/src/wire-validators.ts`, after `'agent/seating/set'`:

```ts
  'agent/create': shape({
    name: isFilled,
    description: optional(isString),
    permission: grantValidator,
    seat: flowSeatValidator,
    to: literalUnion('user', 'project'),
    project: optional(isString),
  }),
  'agent/copy': shape({
    id: isFilled,
    from: literalUnion('project', 'user', 'builtin'),
    to: literalUnion('user', 'project'),
    project: optional(isString),
  }),
  'agent/remove': shape({ id: isFilled, origin: literalUnion('user', 'project'), project: optional(isString) }),
  'agent/reveal': shape({
    id: isFilled,
    origin: optional(literalUnion('project', 'user', 'builtin')),
    project: optional(isString),
  }),
```

- [ ] **Step 5: Give the host a Trash, and the editor the roster's folders**

1. In `packages/server/src/host.ts`, in `interface HostOptions`, after `revealPath`:

```ts
  /**
   * Moves a file or folder to the OS Trash, where it can be put back.
   * Supplied by the desktop shell; without it, removing an Agent says so.
   */
  readonly trashPath?: (path: string) => Promise<void>
```

2. Add, after `#openRoots()`:

```ts
  /**
   * Where the renderer may read or write a file by path: the open roots, and
   * the roster's own folders — this machine's for both, because a person
   * edits their own Agents in the desk's editor; the built-in one for reading
   * only, because nobody edits what ships (*Customize…* copies it first).
   */
  #fileRoots(mode: 'read' | 'write'): string[] {
    return [
      ...this.#openRoots(),
      join(this.#state.directory, 'agents'),
      ...(mode === 'read' ? [builtinAgentRoot()] : []),
    ]
  }
```

3. In `redeemPreviewTicket`, replace `confine(entry.path, this.#openRoots())` with `confine(entry.path, this.#fileRoots('read'))`.
4. In `#buildContext`, add to `workspaces`: `fileRoots: (mode) => this.#fileRoots(mode),`.
5. In `packages/server/src/methods/context.ts`, add to `workspaces`:

```ts
    /** Where a file may be read or written by path: the open roots and the roster's own folders (`#fileRoots`). */
    fileRoots(mode: 'read' | 'write'): string[]
```

6. In `packages/server/src/methods/workspace.ts`, change the confinement of exactly these four: `'workspace/readFile'` and `'workspace/stat'` and `'preview/ticket'` to `confine(params.path, ctx.workspaces.fileRoots('read'))`, and `'file/save'` to `confine(params.path, ctx.workspaces.fileRoots('write'))`. Leave every other `openRoots()` caller as it is: listing, revealing, terminals and git stay confined to what is open.

7. In `packages/server/src/bootstrap.ts`, add to `BootstrapOptions` after `revealPath`: `readonly trashPath?: HostOptions['trashPath']`, and to the `new Host({…})` options after the `revealPath` spread: `...(options.trashPath ? { trashPath: options.trashPath } : {}),`.

8. In `packages/desktop/electron/main.mjs`, after `revealPath`:

```js
/** The Trash, where a removed Agent can be dragged back out — what "Move to Trash" means on a Mac. */
const trashPath = async (path) => {
  await shell.trashItem(path)
}
```

   and pass `trashPath,` to the bootstrap call beside `revealPath,`.

- [ ] **Step 6: Answer the four verbs**

In `packages/server/src/methods/agents.ts`:

1. Add imports:

```ts
import { dirname, isAbsolute, join } from 'node:path'
```

(replacing the existing `isAbsolute`-only import), `type AgentOrigin` to the `@harnessdesk/protocol` import, and:

```ts
import { agentIdOf, agentSource, copyAgentFolder, createAgentFolder, projectAgentDir } from '../agent-files.js'
```

2. Add the verbs to `agentMethods`, after `'agent/seating/set'`:

```ts
  'agent/create': async (ctx, params) => {
    const id = agentIdOf(params.name)
    if (!id) throw new Error(`“${params.name}” leaves nothing to name a folder by — use letters or digits.`)
    const project = await projectOf(ctx, params.project)
    const root = await rootOf(ctx, params.to, project)
    // Committed, a model name breaks the Agent on every other machine: the project names the runtime, this Mac keeps the seat.
    const bare = { runtime: params.seat.runtime }
    const exact = Boolean(params.seat.model || params.seat.effort || params.seat.thinking)
    await createAgentFolder(
      root,
      id,
      agentSource({
        name: params.name.trim(),
        description: params.description?.trim() || null,
        permission: params.permission,
        prefer: params.to === 'project' ? [bare] : [params.seat],
      }),
    )
    if (params.to === 'project' && exact) await ctx.seating.set(id, [params.seat])
    ctx.push({ method: 'agent/changed', params: { project: params.to === 'project' ? (project ?? null) : null } })
    return found(await ctx.agents.read(id, project), id)
  },

  'agent/copy': async (ctx, params) => {
    const project = await projectOf(ctx, params.project)
    const entry = await ctx.agents.read(params.id, project)
    const source = entry ? copyAt(entry, params.from) : null
    if (!entry || !source) throw new Error(`There is no ${params.from} Agent called “${params.id}” to copy.`)
    if (RANK[params.to] >= RANK[params.from]) {
      throw new Error(
        `A copy in ${params.to === 'user' ? 'your Agents' : 'the project'} would be shadowed by the ${params.from} one it copies — copy it somewhere that comes first.`,
      )
    }
    const root = await rootOf(ctx, params.to, project)
    await copyAgentFolder(dirname(source), join(root, params.id))
    ctx.push({ method: 'agent/changed', params: { project: params.to === 'project' ? (project ?? null) : null } })
    return found(await ctx.agents.read(params.id, project), params.id)
  },

  'agent/remove': async (ctx, params) => {
    if (!ctx.options.trashPath) throw new Error('Moving an Agent to the Trash needs the desktop app.')
    const project = await projectOf(ctx, params.project)
    const entry = await ctx.agents.read(params.id, project)
    const path = entry ? copyAt(entry, params.origin) : null
    if (!path) throw new Error(`There is no ${params.origin} Agent called “${params.id}” to remove.`)
    await ctx.options.trashPath(dirname(path))
    ctx.push({ method: 'agent/changed', params: { project: params.origin === 'project' ? (project ?? null) : null } })
    return null
  },

  'agent/reveal': async (ctx, params) => {
    if (!ctx.options.revealPath) throw new Error('Showing a file in the file browser needs the desktop app.')
    const entry = await ctx.agents.read(params.id, await projectOf(ctx, params.project))
    const path = entry ? (params.origin ? copyAt(entry, params.origin) : entry.path) : null
    if (!path) throw new Error(`There is no Agent called “${params.id}” here.`)
    await ctx.options.revealPath(path)
    return null
  },
```

3. Add, below `candidatesFor`:

```ts
/** Which tier outranks which: a copy is only worth making where it comes first. */
const RANK: Readonly<Record<AgentOrigin, number>> = { project: 0, user: 1, builtin: 2 }

/** The file of the copy of an Agent found at one tier — the winner, or one it shadows — or null. */
const copyAt = (entry: AgentEntry, origin: AgentOrigin): string | null =>
  entry.origin === origin ? entry.path : (entry.shadows.find((one) => one.origin === origin)?.path ?? null)

/** Where a new or copied Agent goes: this machine's roster, or the project's own, made inside it. */
const rootOf = async (ctx: HostContext, to: 'user' | 'project', project: string | undefined): Promise<string> => {
  if (to === 'user') return ctx.agents.roots.user
  if (!project) throw new Error('Name the project to write the Agent into.')
  return projectAgentDir(project)
}

/** The entry just written, which the roster must now list. */
const found = (entry: AgentEntry | null, id: string): AgentEntry => {
  if (!entry) throw new Error(`“${id}” was written and is not in the roster — look for it in the folder it was written to.`)
  return entry
}
```

4. In `script/check-reachable.mjs`, add to `UNREACHED`:

```js
  'agent/create': 'likewise — Save as an Agent, in a conversation’s menu, is the second half of the same phase',
  'agent/copy': "likewise — an Agent's page offers Customize…",
  'agent/remove': "likewise — an Agent's page offers Remove…",
  'agent/reveal': "likewise — an Agent's page offers Reveal",
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-files.test.js packages/server/dist/test/agents.test.js packages/server/dist/test/methods.test.js && node script/check-reachable.mjs`
Expected: PASS — `agent-files.test.js` 9 tests, `agents.test.js` unchanged; `… 12 pinned as not.`

Run: `pnpm --filter @harnessdesk/desktop run test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/protocol/src packages/server/src/agent-files.ts packages/server/src/agents.ts packages/server/src/host.ts packages/server/src/bootstrap.ts packages/server/src/methods packages/server/test/agent-files.test.ts packages/desktop/electron/main.mjs script/check-reachable.mjs
git commit -m "feat(agents): save, copy, remove and reveal an Agent's folder

The roster stays read-only for content — an Agent is edited in the editor, and
its own folders are now admitted there, the built-in one for reading only. The
four writes that are not edits belong to the host: a new Agent saved from a
conversation, a copy made where it shadows its original, a folder moved to the
Trash, and the file shown in Finder. A committed Agent names its runtime and
this machine keeps the model; nothing overwrites an Agent that is there, and
nothing is written through a link out of a project.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 10: A backup carries your Agents and this machine's seats

The roadmap's settings table gives phase 2 one line on General › Backup: it *carries your Agents and `seating.json`*. A user Agent is versioned by nothing — it is not in any repository — so a backup that leaves it out loses it for good on a new Mac, and `seating.json` is the one file that says which model each Agent runs on here.

`BackupFile.agents` is already taken: it is the ACP registry's entries — the runtimes — which is the word's old meaning. The new fields are `agentFolders` and `seating`, optional, so a backup written before this still restores and one written after it still restores on a desk from before it. Restore stays additive, the rule the rest of the backup keeps: a folder already here is left as it is, an entry this machine already has is left as it is, and a path in a backup that would climb out of its folder is refused.

The Settings sentence that reports a backup changes in Task 11, with the rest of Settings' words.

**Files:**
- Modify: `packages/protocol/src/wire.ts` (`BackupFile.agentFolders`, `BackupFile.seating`, `BackupReport.agentFolders`, `BackupReport.seating`)
- Modify: `packages/server/src/agent-files.ts` (`exportAgentFolders`, `importAgentFolder`)
- Modify: `packages/server/src/agent-seating-file.ts` (`MachineSeatingFile.raw`)
- Modify: `packages/server/src/host.ts` (`#backupExport`, `#backupImport`)
- Test: `packages/server/test/backup.test.ts`

**Interfaces:**
- Consumes: `MachineSeatingFile` (Task 6), `parseSeating` (Task 6).
- Produces:
  - `BackupFile.agentFolders?: readonly { id: string; files: readonly { path: string; text: string }[] }[]`, `BackupFile.seating?: Readonly<Record<string, unknown>> | null`.
  - `BackupReport.agentFolders: { restored: number; skipped: number }`, `BackupReport.seating: { restored: number; skipped: number }`.
  - `exportAgentFolders(root: string): Promise<AgentFolderCopy[]>`, `importAgentFolder(root: string, copy: unknown): Promise<boolean>`, `MachineSeatingFile.raw(): Promise<Record<string, unknown> | null>`.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/backup.test.ts` (add `readFile`, `readdir` to its `node:fs/promises` import):

```ts
test("a backup carries this machine's Agents and their seats, and a restore adds them without touching what is here", async (t) => {
  const dirA = await mkdtemp(join(tmpdir(), 'hd-backup-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'hd-backup-b-'))
  t.after(async () => {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  })
  const a = await hostAt(dirA)
  t.after(() => a.host.dispose())
  await mkdir(join(dirA, 'agents', 'scout', 'skills'), { recursive: true })
  await writeFile(join(dirA, 'agents', 'scout', 'AGENT.md'), '---\nname: Scout\n---\nLook around.\n')
  await writeFile(join(dirA, 'agents', 'scout', 'skills', 'look.md'), 'Look closely.')
  await writeFile(join(dirA, 'seating.json'), JSON.stringify({ scout: ['claude-code=opus-5/high'], judge: ['codex'] }))

  const backup = await a.host.call('backup/export', {})
  assert.deepEqual(backup.agentFolders, [
    {
      id: 'scout',
      files: [
        { path: 'AGENT.md', text: '---\nname: Scout\n---\nLook around.\n' },
        { path: 'skills/look.md', text: 'Look closely.' },
      ],
    },
  ])
  assert.deepEqual(backup.seating, { scout: ['claude-code=opus-5/high'], judge: ['codex'] })

  // The second desk already has its own judge seat and its own scout: both are kept.
  const b = await hostAt(dirB)
  t.after(() => b.host.dispose())
  await writeFile(join(dirB, 'seating.json'), JSON.stringify({ judge: ['cursor'] }))
  const report = await b.host.call('backup/import', {
    backup: {
      ...backup,
      agentFolders: [
        ...(backup.agentFolders ?? []),
        { id: 'climber', files: [{ path: 'AGENT.md', text: 'x' }, { path: '../escape.md', text: 'x' }] },
      ],
    },
  })
  assert.deepEqual(report.agentFolders, { restored: 2, skipped: 0 })
  assert.deepEqual(report.seating, { restored: 1, skipped: 1 })
  assert.equal(await readFile(join(dirB, 'agents', 'scout', 'skills', 'look.md'), 'utf8'), 'Look closely.')
  assert.deepEqual(await readdir(join(dirB, 'agents', 'climber')), ['AGENT.md'], 'a path that climbs out is not written')
  assert.deepEqual(JSON.parse(await readFile(join(dirB, 'seating.json'), 'utf8')), {
    judge: ['cursor'],
    scout: ['claude-code=opus-5/high'],
  })

  // Twice is the same as once.
  const again = await b.host.call('backup/import', { backup })
  assert.deepEqual(again.agentFolders, { restored: 0, skipped: 1 })
  assert.deepEqual(again.seating, { restored: 0, skipped: 2 })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm run build:node`
Expected: FAIL — `Property 'agentFolders' does not exist on type 'BackupFile'`.

- [ ] **Step 3: Widen the backup's shape**

In `packages/protocol/src/wire.ts`, add to `interface BackupFile`, after `transcripts`:

```ts
  /**
   * This machine's own Agents — each folder under `agents` in the state
   * directory, every file as text — because a user Agent is in no repository
   * and a backup is its only copy. Not `agents`, which is the ACP registry's
   * runtimes and kept its name. Absent in a backup from before it existed.
   */
  readonly agentFolders?: readonly {
    readonly id: string
    readonly files: readonly { readonly path: string; readonly text: string }[]
  }[]
  /** This machine's `seating.json` as written, or null when it had none that could be read. */
  readonly seating?: Readonly<Record<string, unknown>> | null
```

and to `interface BackupReport`, after `transcripts`:

```ts
  readonly agentFolders: { readonly restored: number; readonly skipped: number }
  readonly seating: { readonly restored: number; readonly skipped: number }
```

- [ ] **Step 4: Copy folders out and back in**

1. Append to `packages/server/src/agent-files.ts` (add `readdir` and `readFile` to its `node:fs/promises` import):

```ts
/** What a backup carries of one Agent: its folder's files, as text. */
export interface AgentFolderCopy {
  readonly id: string
  readonly files: readonly { readonly path: string; readonly text: string }[]
}

/** The most of one file, and of one folder, a backup carries: a brief and what sits beside it, never a stray archive. */
const BACKUP_FILE_LIMIT = 256 * 1024
const BACKUP_FOLDER_LIMIT = 1024 * 1024

/** Every Agent folder under this machine's root, for a backup. Links are left behind; a folder with no `AGENT.md` is not an Agent. */
export const exportAgentFolders = async (root: string): Promise<AgentFolderCopy[]> => {
  let ids: string[]
  try {
    ids = (await readdir(root, { withFileTypes: true }))
      .filter((one) => one.isDirectory())
      .map((one) => one.name)
      .sort()
  } catch {
    return []
  }
  const copies: AgentFolderCopy[] = []
  for (const id of ids) {
    const files: { path: string; text: string }[] = []
    let total = 0
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), path)
          continue
        }
        if (!entry.isFile()) continue
        const bytes = await readFile(join(dir, entry.name))
        if (bytes.length > BACKUP_FILE_LIMIT || total + bytes.length > BACKUP_FOLDER_LIMIT) continue
        total += bytes.length
        files.push({ path, text: bytes.toString('utf8') })
      }
    }
    await walk(join(root, id), '')
    if (files.some((one) => one.path === 'AGENT.md')) copies.push({ id, files })
  }
  return copies
}

/** One path segment that names a folder and climbs nowhere. */
const isSegment = (name: string): boolean =>
  name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes('\0')

/**
 * Restores one Agent folder from a backup, unless an Agent by that id is here
 * — a restore adds, it never overwrites — and answers whether it did. A file
 * whose path would climb out of the folder is not written.
 */
export const importAgentFolder = async (root: string, copy: unknown): Promise<boolean> => {
  const record = (copy ?? {}) as { id?: unknown; files?: unknown }
  const id = typeof record.id === 'string' ? record.id : ''
  if (!isSegment(id) || !Array.isArray(record.files)) return false
  const files = record.files.flatMap((one) => {
    const file = (one ?? {}) as { path?: unknown; text?: unknown }
    if (typeof file.path !== 'string' || typeof file.text !== 'string') return []
    return file.path.split('/').every(isSegment) ? [{ path: file.path, text: file.text }] : []
  })
  if (!files.some((one) => one.path === 'AGENT.md')) return false
  await mkdir(root, { recursive: true })
  try {
    await mkdir(join(root, id))
  } catch {
    // An Agent by this id is here, and it stays as it is.
    return false
  }
  for (const file of files) {
    const target = join(root, id, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.text, { encoding: 'utf8', flag: 'wx' })
  }
  return true
}
```

2. Add to `MachineSeatingFile` in `packages/server/src/agent-seating-file.ts`:

```ts
  /** The file as written, for a backup — every entry, broken ones included; null when there is none or it is not JSON. */
  async raw(): Promise<Record<string, unknown> | null> {
    try {
      return asRecord(JSON.parse(await readFile(this.path, 'utf8')))
    } catch {
      return null
    }
  }
```

3. In `packages/server/src/host.ts`, import `exportAgentFolders` and `importAgentFolder` from `./agent-files.js` and `parseSeating` from `./agent-seating-file.js`. In `#backupExport`, add after `transcripts`:

```ts
      agentFolders: await exportAgentFolders(join(this.#state.directory, 'agents')),
      seating: await this.#seating.raw(),
```

   and in `#backupImport`, before `this.#logger.info('backup restored', …)`, add:

```ts
    // This machine's Agents: a folder already here stays as it is.
    const agentFolders = { restored: 0, skipped: 0 }
    for (const copy of Array.isArray(file.agentFolders) ? file.agentFolders : []) {
      if (await importAgentFolder(join(this.#state.directory, 'agents'), copy)) agentFolders.restored += 1
      else agentFolders.skipped += 1
    }

    // Its seats: an entry this machine already has — or cannot read — stays as it is.
    const seating = { restored: 0, skipped: 0 }
    if (typeof file.seating === 'object' && file.seating !== null) {
      const saved = parseSeating(JSON.stringify(file.seating))
      const here = await this.#seating.read()
      const unreadable = here.problems.some((one) => one.id === null)
      for (const entry of saved.entries) {
        const taken = here.entries.some((one) => one.id === entry.id) || here.problems.some((one) => one.id === entry.id)
        if (unreadable || taken) {
          seating.skipped += 1
          continue
        }
        await this.#seating.set(entry.id, entry.seats)
        seating.restored += 1
      }
      seating.skipped += saved.problems.filter((one) => one.id !== null).length
    }
    if (agentFolders.restored > 0 || seating.restored > 0) {
      this.#push({ method: 'agent/changed', params: { project: null } })
    }
```

   and return and log them: change the `this.#logger.info` line to `this.#logger.info('backup restored', { agents, preferences, transcripts, agentFolders, seating })` and the return to `return { agents, preferences, transcripts, agentFolders, seating }`.

- [ ] **Step 5: Run the test to see it pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/backup.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/protocol/src/wire.ts packages/server/src/agent-files.ts packages/server/src/agent-seating-file.ts packages/server/src/host.ts packages/server/test/backup.test.ts
git commit -m "feat(agents): a backup carries this machine's Agents and their seats

A user Agent is in no repository, so a backup was its only possible copy and
did not take it; seating.json is the one file that says which model each Agent
runs on here. Both now travel, as new optional fields beside the runtimes', and
a restore adds them the way it adds everything else: what is here stays, and a
path that would climb out of its folder is not written.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

**Part A ends here.** Open its pull request from this branch before Part B starts; Part B is stacked on it. The PR body names the per-runtime table from Task 3, the deadline from Task 2, and the nine Agents from Task 7, and says the verbs pinned in `UNREACHED` get their callers in the stacked PR.

---

# Part B — the interface

Stacked on Part A. Every task here adds or changes a surface, so every task also adds or updates its fixture in the preview harness, and every task that gives a pinned verb its first `transport.request('…')` caller removes that verb's line from `UNREACHED` in `script/check-reachable.mjs` in the same commit.

---

### Task 11: Settings › Runtimes — the route split

Today's page id `agents` (`AgentsSection` in `packages/ui/src/components/SettingsAgents.tsx`) is the installed CLIs and their accounts. From this phase that page is **Runtimes**, and `agents` names the roster (Task 13). The id is reused, so `MOVED` in `Settings.tsx` cannot cover it: every caller that meant the installed CLIs moves to `runtimes` by hand, in this task, before the roster takes the id.

The callers, found with `grep -rn "'agents'\|openAgents\|onOpenAgents\|askSettings\|setSettingsOpen" packages/ui/src` — the ⋮ panel kind `'agents'` in `state/layout.ts`, `state/store.ts` and `panels/builtins.tsx` is a *view* of the conversation's sub-agents, not a Settings route, and stays:

| Where | Today | After |
| --- | --- | --- |
| `app/App.tsx` `run('settings')` — the app menu's *Settings…* and ⌘, | `setSettingsOpen('agents')` | `'runtimes'`: ⌘, keeps opening the page it always opened, where the one state that stops a first session lives |
| `app/App.tsx` `ShellProvider` `openAgents` | `setSettingsOpen('agents')` | renamed `openRuntimes`, `'runtimes'` |
| `app/App.tsx` `Sidebar onOpenSettings` default (the seat menu's *Settings ⌘,*) | `section ?? 'agents'` | `section ?? 'runtimes'` |
| `panels/views.tsx` `ShellActions.openAgents` | — | `openRuntimes` |
| `panels/builtins.tsx`, `Conversation.tsx`, `TeamRoomPane.tsx`, `SetupDesk.tsx` `onOpenAgents` | "Add an agent…", "Add another agent…" | `onOpenRuntimes`; "Add a runtime…", "Add another runtime…" |
| `Settings.tsx` Extensions redirect, `resolveSection` fallback, `Settings`'s default page | `'agents'` | `'runtimes'` |
| `CommandPalette.tsx` `SETTINGS_PAGE.agents`, its `⌘,` hint | *Settings › Agents* | *Settings › Runtimes* |
| `AddMember.tsx` failure sentence | "…in Settings › Agents." | "…in Settings › Runtimes." |
| `preview/main.tsx` `SETTINGS_SECTIONS`, `onOpenAgents` | | `runtimes`, `onOpenRuntimes` |
| `script/shots/shoot.mjs` `settings-agents` scene (expands an account row) | | `settings-runtimes` |

Until Task 13 there is no roster, so `MOVED` maps `agents` → `runtimes` for this task only; Task 13 removes that line when `agents` becomes a page again. The page's own words move with it: *Runtimes*, *Add a runtime*, and the custom-agent dialog becomes *Add a custom runtime* — what the ACP registry calls a custom agent (the roadmap's *Add a runtime*).

Two copy changes ride with it because they are about the same words: the Models › Presets save dialog stops suggesting *Careful reviewer* (it is an Agent's name now), and General › Backup counts runtimes and Agents apart (Task 10 made it carry both).

**Files:**
- Modify: `packages/ui/src/components/Settings.tsx`, `packages/ui/src/components/SettingsAgents.tsx`, `packages/ui/src/app/App.tsx`, `packages/ui/src/panels/views.tsx`, `packages/ui/src/panels/builtins.tsx`, `packages/ui/src/components/Conversation.tsx`, `packages/ui/src/components/TeamRoomPane.tsx`, `packages/ui/src/components/SetupDesk.tsx`, `packages/ui/src/components/AddMember.tsx`, `packages/ui/src/components/CommandPalette.tsx`, `packages/ui/src/preview/main.tsx`, `script/shots/shoot.mjs`
- Modify tests: `packages/ui/src/components/Settings.route.test.tsx`, `SettingsAgents.test.tsx`, `SettingsAgents.default.test.tsx`, `SetupDesk.test.tsx`, `Conversation.test.tsx`, `CommandPalette.highlight.test.tsx`
- Test: `packages/ui/src/app/settings-routes.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Section` gains `'runtimes'` (and loses `'agents'` until Task 13); `RuntimesSection` (renamed from `AgentsSection`); `ShellActions.openRuntimes: () => void`; `resolveSection(name, fallback = 'runtimes')`; the route-door allowlist `ROSTER_DOORS` in `settings-routes.test.ts` that Tasks 14 and 17 extend.

- [ ] **Step 1: Write the failing test**

Create `packages/ui/src/app/settings-routes.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { resolveSection } from '../components/Settings'

/**
 * The route id `agents` is reused.
 *
 * It named the page of installed CLIs and their accounts; from this phase it
 * names the roster of Agents, and that page is `runtimes`. `MOVED` cannot
 * carry an id that still exists, so every door that meant the CLIs — a
 * sign-in, an "add another", ⌘, — moved to `runtimes` by hand, and this is
 * the test that nothing was left behind asking the roster for a sign-in.
 *
 * It reads the renderer's source for literal routes, because a door is a
 * string handed to one of a few verbs, and the door nobody renders in a test
 * is exactly the one that rots.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url))

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })

/** Every way the renderer spells a route to the `agents` page. */
const DOORS: readonly RegExp[] = [
  /\b(?:setSettingsOpen|askSettings|openSettings|onOpenSettings|onSection)\(\s*'agents'/g,
  /\?\?\s*'agents'\s*\)/g,
  /\bsection\s*=\s*'agents'/g,
  /\bfallback:\s*Section\s*=\s*'agents'/g,
]

/**
 * The files allowed to open the roster, each for a reason that is about an
 * Agent rather than a runtime. Empty until the roster exists; each task that
 * adds a door to it adds the file here, with the door in its commit.
 */
const ROSTER_DOORS: readonly string[] = []

describe('the Settings route split', () => {
  it('opens on Runtimes by default, and an old route to agents lands there until the roster exists', () => {
    expect(resolveSection(null)).toBe('runtimes')
    expect(resolveSection('runtimes')).toBe('runtimes')
    expect(resolveSection('agents')).toBe('runtimes')
  })

  it('nothing opens the Agents page but a door that is about Agents', () => {
    const offenders = sources(SRC).flatMap((file) => {
      const where = relative(SRC, file)
      if (ROSTER_DOORS.includes(where)) return []
      const text = readFileSync(file, 'utf8')
      return DOORS.flatMap((door) => [...text.matchAll(door)].map((match) => `${where}: ${match[0]}`))
    })
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/app/settings-routes.test.ts`
Expected: FAIL — `expected 'agents' to be 'runtimes'`, and the offenders list names `app/App.tsx: setSettingsOpen('agents'`, `app/App.tsx: ?? 'agents')`, `components/Settings.tsx: onSection('agents'`, `components/Settings.tsx: section = 'agents'` and `components/Settings.tsx: fallback: Section = 'agents'`.

- [ ] **Step 3: Split the route in Settings**

In `packages/ui/src/components/Settings.tsx`:

1. In `export type Section`, replace `| 'agents'` with `| 'runtimes'`.
2. Replace `MOVED` and `SECTIONS` and `resolveSection` with:

```ts
const MOVED: Readonly<Record<string, Section>> = {
  account: 'general',
  preferences: 'general',
  presets: 'models',
  // Until the roster takes the id back (Task 13): a route to the installed
  // CLIs that was written as `agents` lands on the page they now live on.
  agents: 'runtimes',
}
const SECTIONS: readonly Section[] = [
  'profile', 'general', 'appearance', 'notifications', 'shortcuts', 'workspaces', 'archive',
  'runtimes', 'models', 'skills', 'extensions', 'library', 'plugins', 'permissions', 'browser',
]
export const resolveSection = (name: string | null | undefined, fallback: Section = 'runtimes'): Section =>
  name && (SECTIONS as readonly string[]).includes(name)
    ? (name as Section)
    : (name && MOVED[name]) || fallback
```

3. Change the `Settings` component's default `section = 'agents'` to `section = 'runtimes'`, and the Extensions redirect `onSection('agents')` to `onSection('runtimes')`. In the comment above `agentsState`, change "The Agents row carries" to "The Runtimes row carries".
4. Replace the nav entry `{ id: 'agents', label: 'Agents', … }` with:

```ts
        {
          id: 'runtimes',
          label: 'Runtimes',
          icon: <AgentIcon size={14} />,
          ...(accountCount > 0 ? { count: accountCount } : {}),
          ...(agentsState ? { state: agentsState } : {}),
          keywords: ['runtimes', 'installed', 'cli', 'accounts', 'sign in', 'sign out', 'add runtime', 'registry', 'nickname', 'ring', 'usage', 'plan', 'new sessions', 'defaults', 'update', 'remove'],
        },
```

5. In the page switch, replace `{section === 'agents' && <AgentsSection onSignIn={onSignIn} />}` with `{section === 'runtimes' && <RuntimesSection onSignIn={onSignIn} />}`, and in the import from `./SettingsAgents` replace `AgentsSection` with `RuntimesSection`.
6. In `SavePresetDialog`, replace `placeholder="Careful reviewer"` with `placeholder="High effort, asks first"` — a preset is one runtime's controls under a name, and *Careful reviewer* is an Agent's name now.
7. In `BackupRows`, replace the two `setOutcome(…)` sentences and the row's `desc` with:

```ts
      setOutcome(
        `Exported ${count(backup.agents.length, 'runtime')}, ${count(backup.agentFolders?.length ?? 0, 'Agent')} of yours and ${count(backup.transcripts.length, 'conversation')}.`,
      )
```

```ts
      const skipped = report.agents.skipped + report.transcripts.skipped + report.agentFolders.skipped
      setOutcome(
        `Restored ${count(report.agents.restored, 'runtime')}, ${count(report.agentFolders.restored, 'Agent')}, ${count(report.seating.restored, 'seat choice')}, ${count(report.preferences, 'preference')} and ${count(report.transcripts.restored, 'conversation')}.${skipped > 0 ? ` ${skipped} already here or newer, left alone.` : ''}`,
      )
```

   with, above `BackupRows`:

```ts
/** "1 runtime", "3 runtimes" — a count and its noun, the noun's plural by adding an s. */
const count = (n: number, noun: string): string => `${n} ${n === 1 ? noun : `${noun}s`}`
```

   and the row's description: `desc="Runtimes, your Agents and their seats on this Mac, preferences and transcripts in one file — sign in again after restoring."`

- [ ] **Step 4: Rename the page itself**

In `packages/ui/src/components/SettingsAgents.tsx`:

1. Rename `export const AgentsSection` to `export const RuntimesSection`, and change its docstring's first line ("Agents, and the accounts under them.") to "Runtimes — the agent programs HarnessDesk starts — and the accounts under them."
2. In its `PageHead`, replace `title="Agents"` and the blurb with:

```tsx
        title="Runtimes"
        blurb="What your Agents run on: the agent programs HarnessDesk can start, and the accounts each is signed in as."
```

   and both `Add agent` button labels on the page with `Add a runtime`.
3. Replace `placeholder="Search agents or accounts"` with `placeholder="Search runtimes or accounts"`, `'No agent is registered yet'` with `'No runtime is added yet'`, `'No agent matches'` with `'No runtime matches'`, and `'Add one to send it a session.'` with `'Add one to start a conversation on it.'`.
4. Replace all three `<BackLink to="Agents" onClick={onBack} />` with `<BackLink to="Runtimes" onClick={onBack} />`.
5. In `AddAgents`, replace the `PageHead`'s `title="Add an agent"` with `title="Add a runtime"` and its blurb's first words "An agent keeps" with "A runtime keeps".
6. In `CustomAgentDialog`, replace `title="Add a custom agent"` with `title="Add a custom runtime"` and the footer's `'Add agent'` with `'Add runtime'`.

- [ ] **Step 5: Move every door that meant the CLIs**

1. In `packages/ui/src/app/App.tsx`: in `run`, `case 'settings': setSettingsOpen('runtimes')`; in the `ShellProvider` actions, replace `openAgents: () => setSettingsOpen('agents'),` with `openRuntimes: () => setSettingsOpen('runtimes'),`; and `onOpenSettings={(section) => setSettingsOpen(section ?? 'runtimes')}`.
2. Rename the shell action and every prop that carries it, in one pass:

```bash
cd "$(git rev-parse --show-toplevel)"
sed -i '' 's/onOpenAgents/onOpenRuntimes/g; s/openAgents/openRuntimes/g' \
  packages/ui/src/panels/views.tsx packages/ui/src/panels/builtins.tsx \
  packages/ui/src/components/Conversation.tsx packages/ui/src/components/TeamRoomPane.tsx \
  packages/ui/src/components/SetupDesk.tsx packages/ui/src/preview/main.tsx \
  packages/ui/src/components/Conversation.test.tsx packages/ui/src/components/SetupDesk.test.tsx
grep -rn "openAgents\|onOpenAgents" packages/ui/src
```

   Expected: the grep prints nothing.
3. In `packages/ui/src/components/SetupDesk.tsx`, replace the foot with:

```tsx
      <p className={styles.foot}>
        Another agent program on this Mac?{' '}
        <Button variant="link" size="content" onClick={onOpenRuntimes}>
          Add a runtime…
        </Button>
      </p>
```

   and in `SetupDesk.test.tsx` replace `button('Add an agent…')` with `button('Add a runtime…')`.
4. In `packages/ui/src/components/Conversation.tsx`, in the empty state, replace the sentence with:

```tsx
          {words.name} is the only runtime here.{' '}
          <Button type="button" variant="link" size="content" onClick={onOpenRuntimes}>
            Add another runtime…
          </Button>
```

5. In `packages/ui/src/components/AddMember.tsx`, replace `'That agent would not start. Check it is signed in, in Settings › Agents.'` with `'That runtime would not start. Check it is signed in, in Settings › Runtimes.'`.
6. In `packages/ui/src/components/CommandPalette.tsx`, replace the `agents:` row of `SETTINGS_PAGE` with:

```tsx
  runtimes: { label: 'Runtimes', icon: <AgentIcon size={14} />, keywords: 'runtimes installed agents accounts sign in' },
```

   and `hint: entry.section === 'agents' ? '⌘,' : undefined` with `hint: entry.section === 'runtimes' ? '⌘,' : undefined`.
7. In `packages/ui/src/preview/main.tsx`, replace `'agents',` in `SETTINGS_SECTIONS` with `'runtimes',`, and the preset fixture's `name: 'Careful reviewer',` with `name: 'High effort, asks first',`.
8. In `script/shots/shoot.mjs`, in the settings-scene loop, replace `'agents'` in the section list with `'runtimes'`, and `if (section === 'agents') {` with `if (section === 'runtimes') {`.

- [ ] **Step 6: Move the tests that pinned the old words**

1. `packages/ui/src/components/Settings.route.test.tsx`, in `a route to Extensions still gives way when the agent has none`: `expect(page()).toBe('Runtimes')` (both places), `expect(held()).toBe('runtimes')`, and the comment "the redirect has the last word over the route: Runtimes, not a blank panel".
2. `packages/ui/src/components/SettingsAgents.test.tsx`: import `RuntimesSection` in place of `AgentsSection` and render it; `button('Add agent')` → `button('Add runtime')` (three places); `'[role="dialog"][aria-label="Add a custom agent"]'` → `'[role="dialog"][aria-label="Add a custom runtime"]'` (two places); `'input[aria-label="Search agents or accounts"]'` → `'input[aria-label="Search runtimes or accounts"]'` (two places); `'No agent matches'` → `'No runtime matches'`.
3. `packages/ui/src/components/SettingsAgents.default.test.tsx`: the back link is found by `node.textContent?.trim() === 'Runtimes'`.
4. `packages/ui/src/components/CommandPalette.highlight.test.tsx`, in `a reshuffle cannot move the highlight off the row the user saw`: typing *settings* now leads with the page that took the first row of `SETTINGS_PAGE`, so `'Settings › Agents'` → `'Settings › Runtimes'` (both places) and `toHaveBeenCalledWith('agents')` → `toHaveBeenCalledWith('runtimes')`. Task 13 puts the roster's row above it and turns these back.

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/app/settings-routes.test.ts src/components/Settings.route.test.tsx src/components/SettingsAgents.test.tsx src/components/SettingsAgents.default.test.tsx src/components/SetupDesk.test.tsx src/components/Conversation.test.tsx src/components/CommandPalette.pages.test.tsx src/components/CommandPalette.highlight.test.tsx`
Expected: PASS, 0 failures.

Run: `pnpm --filter @harnessdesk/ui run typecheck` — the UI package's own `tsc --noEmit`, the step `pnpm verify` runs as *ui typecheck*; not the root `typecheck` script.
Expected: exits 0 — a missed `openAgents` or `AgentsSection` fails here.

- [ ] **Step 8: Look at it**

Run `pnpm --filter @harnessdesk/ui run dev`, open `http://localhost:5273/preview.html`, set the *settings page* dial to `runtimes`: the page is titled *Runtimes* with *Add a runtime*; the nav rail's Agents group reads *Runtimes · Models · Skills*; General › Backup reads the new sentence.

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/ui/src script/shots/shoot.mjs
git commit -m "feat(settings): the installed CLIs are Runtimes

The page that listed the agent programs and their accounts is Settings ›
Runtimes now, with Add a runtime, because the Agents page is about to be the
roster of who does the work. The route id is reused, so every door that meant
the CLIs moved by hand — the app menu and ⌘,, the seat menu, Add another
runtime, the palette, a room's failure sentence — and a test reads the source
to prove nothing still opens the roster to ask for a sign-in. The preset
dialog stops suggesting an Agent's name, and a backup counts runtimes and
Agents apart.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 12: The roster in the renderer — state, words, and the project it is read for

Every surface from here on lists Agents, draws their seats and words their reasons, so this task gives the renderer one copy of each: the roster and one dry run of it in the snapshot, re-read when the host says the roster changed (`agent/changed`, Tasks 6 and 8), when a sign-in changes what can be seated, and when the workspace moves; and `lib/agents.ts`, the one place a ceiling, an origin, a reason and a fix are put into words. The first two verbs get their caller here and leave `UNREACHED`.

One host change is owed first. The renderer knows the folder it has open, not the top of its repository, and a project keeps its Agents at the top of its checkout. `projectOf` (`methods/agents.ts`) admitted the top of the repository an open folder sits in, but read Agents from whatever folder it was handed — so a person who opened `repo/pkg` got `repo/pkg/.harnessdesk/agents`, which is nothing. It now reads a folder as the checkout it is in: a subfolder as its repository's top, a linked worktree as its own top (the worktree's checkout is the branch's Agents, which is the point of a branch).

**Files:**
- Modify: `packages/server/src/methods/agents.ts` (`projectOf`), `packages/server/src/methods/context.ts` and `packages/server/src/host.ts` (`workspaces.topLevel`)
- Test: `packages/server/test/agent-methods.test.ts`
- Create: `packages/ui/src/lib/agents.ts`
- Modify: `packages/ui/src/state/snapshot.ts` (`agents`, `agentsProject`, `agentPlans`), `packages/ui/src/state/store.ts` (`loadAgents`, `loadAgentPlans`, the re-reads)
- Modify: `packages/ui/src/preview/main.tsx` (the roster fixture every later screen reads)
- Modify: `script/check-reachable.mjs` (unpin `agent/list`, `agent/seat/dry`)
- Test: `packages/ui/src/lib/agents.test.ts` (new), `packages/ui/src/state/store.agents.test.ts` (new)

**Interfaces:**
- Consumes: `AgentEntry`, `SeatPlan`, `SeatCandidate`, `SeatReason`, `SeatFix` (`@harnessdesk/protocol`); `shortPath` (`lib/paths.ts`).
- Produces:
  - `AppSnapshot.agents: readonly AgentEntry[] | null`, `AppSnapshot.agentsProject: string | null`, `AppSnapshot.agentPlans: ReadonlyMap<string, SeatPlan>`.
  - `AppStore.loadAgents(): Promise<void>`, `AppStore.loadAgentPlans(): Promise<void>`.
  - From `lib/agents.ts`: `ceilingWords(permission): string` ("Read · asked"), `ceilingMeaning(permission): string`, `originWords(origin, project): string`, `projectName(workspace): string | null`, `agentName(entry): string`, `inForce(entries): AgentEntry[]`, `anyBroken(entries): boolean`, `bySection(entries)`, `fileWords({ id, origin, path }, home): string`, `firstParagraph(brief): string`, `reasonWords(reason, runtimeName): string`, `fixWords(fix, runtimeName): string`, `firstReason(plan): string | null`, `seatTaken(plan): SeatCandidate | null`, `markFor(candidate, runtimes)`.
  - `HostContext['workspaces']['topLevel'](path: string): Promise<string | null>`.

- [ ] **Step 1: Write the failing host test**

Append to `packages/server/test/agent-methods.test.ts`:

```ts
/*
 * The renderer names the folder it has open; a project keeps its Agents at the
 * top of its checkout. So a folder is read as the checkout it is in: a
 * subfolder as its repository's top, a linked worktree as its own top — the
 * branch's Agents, which is what a branch is for.
 */
test('a folder inside a repository reads the Agents at the top of its checkout, and a worktree its own', async (t) => {
  const client = await connected(t)
  const repo = tempDir('hd-agent-methods-top-')
  const git = (...args: string[]) => run('git', ['-C', repo, '-c', 'user.email=dev@example.com', '-c', 'user.name=Jane Doe', ...args])
  await run('git', ['init', '-q', repo])
  await git('commit', '-q', '--allow-empty', '-m', 'root')
  await writeAgent(join(repo, '.harnessdesk', 'agents'), 'reviewer', 'Repository reviewer')
  await mkdir(join(repo, 'pkg'))
  await client.call('workspace/open', { path: join(repo, 'pkg') })
  assert.deepEqual(idsOf(await client.call('agent/list', { project: join(repo, 'pkg') })), [
    ['reviewer', 'project', 'Repository reviewer'],
  ])

  const tree = join(tempDir('hd-agent-methods-tree-'), 'tree')
  await git('worktree', 'add', '-q', '-b', 'side', tree)
  await writeAgent(join(tree, '.harnessdesk', 'agents'), 'scout', 'Branch scout')
  await client.call('workspace/open', { path: tree })
  // The worktree's checkout, not the main one: the reviewer is untracked there and so is not in this branch.
  assert.deepEqual(idsOf(await client.call('agent/list', { project: tree })), [['scout', 'project', 'Branch scout']])
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-methods.test.js`
Expected: FAIL — `a folder inside a repository reads the Agents at the top of its checkout…`: `expected [] to deeply equal [['reviewer', 'project', 'Repository reviewer']]`.

- [ ] **Step 3: Read a folder as the checkout it is in**

1. In `packages/server/src/methods/context.ts`, add to `workspaces`:

```ts
    /** The top of the checkout a folder is in — a linked worktree's own — or null outside git. */
    topLevel(path: string): Promise<string | null>
```

2. In `packages/server/src/host.ts`, in `#buildContext`'s `workspaces`, add `topLevel: (path) => gitOps.topLevel(path),`.
3. In `packages/server/src/methods/agents.ts`, replace `projectOf` with:

```ts
const projectOf = async (ctx: HostContext, project: string | undefined): Promise<string | undefined> => {
  if (project === undefined) return undefined
  if (!isAbsolute(project)) throw new Error(`${project} is not an absolute path.`)
  const confined = await ctx.workspaces.confineGitRoot(project)
  /* A project keeps its Agents at the top of its checkout, and a person often
     opens a folder inside it — so a folder is read as the checkout it is in: a
     subfolder as its repository's top, a linked worktree as its own. The top
     is held to the same rule the folder was, so this never reaches a
     repository nobody opened part of. */
  const top = await ctx.workspaces.topLevel(confined)
  return top === null || top === confined ? confined : ctx.workspaces.confineGitRoot(top)
}
```

   and add to its docstring: "A folder inside a checkout is read as that checkout's top (`topLevel`), because that is where a project keeps its Agents."

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-methods.test.js packages/server/dist/test/agent-seat.test.js`
Expected: PASS — `agent-methods.test.js` 12 tests; `agent-seat.test.js` unchanged (its context stub has no `topLevel`, and never names a project).

- [ ] **Step 4: Write the failing renderer tests**

Create `packages/ui/src/lib/agents.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { AgentEntry, RuntimeInfo, SeatPlan } from '@harnessdesk/protocol'

import {
  anyBroken,
  bySection,
  ceilingWords,
  fileWords,
  firstParagraph,
  firstReason,
  fixWords,
  markFor,
  originWords,
  projectName,
  reasonWords,
  seatTaken,
} from './agents'

/**
 * Agents in words: never a wire id, a seat spec or a digest, and every
 * ceiling asked rather than held until something holds it.
 */

const entry = (id: string, over: Partial<AgentEntry> = {}): AgentEntry => ({
  id,
  origin: 'builtin',
  path: `/Applications/HarnessDesk.app/agents/${id}/AGENT.md`,
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id,
    name: id,
    description: null,
    permission: 'read',
    answers: [],
    produces: [],
    skills: [],
    prefer: [{ runtime: 'claude-code' }],
    brief: 'First.\n\nSecond.',
  },
  ...over,
})

const plan = (over: Partial<SeatPlan> = {}): SeatPlan => ({
  id: 'code-reviewer',
  from: 'prefer',
  winner: 1,
  blocked: null,
  candidates: [
    {
      seat: { runtime: 'cursor' },
      label: 'Cursor',
      runtimeName: 'Cursor',
      state: 'passed',
      reason: { kind: 'signedOut' },
      fix: { kind: 'signIn', runtime: 'cursor' },
    },
    { seat: { runtime: 'claude-code' }, label: 'Claude', runtimeName: 'Claude', state: 'taken', reason: null, fix: null },
  ],
  ...over,
})

describe('agents in words', () => {
  it('says every ceiling is asked, because nothing holds one yet', () => {
    expect(ceilingWords('read')).toBe('Read · asked')
    expect(ceilingWords('publish')).toBe('Publish · asked')
    expect(ceilingWords('merge')).toBe('Merge · asked')
  })

  it('heads each section by where it was found, the project by its name', () => {
    expect(originWords('project', 'storefront')).toBe('In storefront')
    expect(originWords('user', 'storefront')).toBe('Yours')
    expect(originWords('builtin', null)).toBe('Built in')
    expect(projectName({ path: '/w/storefront/pkg', name: 'pkg', lastOpenedAt: 1, repo: { root: '/w/storefront', worktree: false } })).toBe('storefront')
    expect(projectName({ path: '/w/tree', name: 'tree', lastOpenedAt: 1, repo: { root: '/w/storefront', worktree: true } })).toBe('tree')
  })

  it('names a shipped Agent inside the app, and anything else by its path from home', () => {
    expect(fileWords({ id: 'judge', origin: 'builtin', path: '/Applications/HarnessDesk.app/x/judge/AGENT.md' }, '/Users/dev')).toBe(
      'HarnessDesk › agents/judge/AGENT.md',
    )
    expect(fileWords({ id: 'scout', origin: 'user', path: '/Users/dev/.harnessdesk/agents/scout/AGENT.md' }, '/Users/dev')).toBe(
      '~/.harnessdesk/agents/scout/AGENT.md',
    )
  })

  it('words a reason and its fix by the runtime’s name, never its id', () => {
    expect(reasonWords({ kind: 'signedOut' }, 'Cursor')).toBe('Cursor is signed out')
    expect(reasonWords({ kind: 'notInstalled', added: false }, 'Codex')).toBe('Codex is not added to HarnessDesk')
    expect(reasonWords({ kind: 'notInstalled', added: true }, 'Codex')).toBe('Codex is not installed on this Mac')
    expect(fixWords({ kind: 'signIn', runtime: 'cursor' }, 'Cursor')).toBe('Sign in to Cursor')
    expect(fixWords({ kind: 'add', runtime: 'codex' }, 'Codex')).toBe('Add Codex')
    expect(fixWords({ kind: 'seats' }, 'Claude')).toBe('Edit seats for this Mac')
  })

  it('reads a plan: the seat it takes, or the first thing wrong', () => {
    expect(seatTaken(plan())?.label).toBe('Claude')
    expect(firstReason(plan())).toBeNull()
    const refused = plan({ winner: null, candidates: [plan().candidates[0]!] })
    expect(seatTaken(refused)).toBeNull()
    expect(firstReason(refused)).toBe('Cursor is signed out')
    expect(firstReason(plan({ winner: null, candidates: [] }))).toBe('It names no seat to try')
    expect(firstReason(plan({ winner: null, candidates: [], blocked: 'its file will not parse' }))).toBe('its file will not parse')
  })

  it('splits the roster by where it was found, and knows when one will not parse', () => {
    const roster = [entry('a', { origin: 'project' }), entry('b', { origin: 'user' }), entry('c')]
    expect(Object.values(bySection(roster)).map((one) => one.map((item) => item.id))).toEqual([['a'], ['b'], ['c']])
    expect(anyBroken(roster)).toBe(false)
    expect(anyBroken([...roster, entry('d', { definition: null, problems: [{ level: 'error', at: 'brief', text: 'x' }] })])).toBe(true)
    // A warning is not a failure to parse.
    expect(anyBroken([entry('e', { problems: [{ level: 'warning', at: 'name', text: 'x' }] })])).toBe(false)
  })

  it('draws a runtime nobody added by the name the desk gave it', () => {
    const runtimes = [{ id: 'claude-code', presentation: { name: 'Claude' } }] as unknown as RuntimeInfo[]
    expect(markFor(plan().candidates[1]!, runtimes)).toBe(runtimes[0])
    expect(markFor(plan().candidates[0]!, runtimes)).toEqual({ id: 'cursor', presentation: { name: 'Cursor' } })
  })

  it('opens a brief on its first paragraph', () => {
    expect(firstParagraph('You review a change.\nSomebody else wrote it.\n\n## What to review')).toBe(
      'You review a change. Somebody else wrote it.',
    )
  })
})
```

Create `packages/ui/src/state/store.agents.test.ts`:

```ts
import { beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, type AgentEntry, type HostMethodName, type SeatPlan } from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * The roster, in the window: read for the folder that is open, a dry run of it
 * beside it, and read again when the host says it changed — but only by a
 * window that had read it, so a window that never shows an Agent reads no file.
 */

const ENTRY: AgentEntry = {
  id: 'code-reviewer',
  origin: 'builtin',
  path: '/app/agents/code-reviewer/AGENT.md',
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id: 'code-reviewer',
    name: 'Code reviewer',
    description: null,
    permission: 'read',
    answers: [],
    produces: [],
    skills: [],
    prefer: [{ runtime: 'claude-code' }],
    brief: 'Review.',
  },
}
const PLAN: SeatPlan = { id: 'code-reviewer', from: 'prefer', winner: null, blocked: null, candidates: [] }
const WORKSPACE = { path: '/work/storefront/pkg', name: 'pkg', lastOpenedAt: 1 }

let store: AppStore
let asked: { method: HostMethodName; params: unknown }[]

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  asked = []
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    asked.push({ method, params })
    if (method === 'agent/list') return [ENTRY]
    if (method === 'agent/seat/dry') return [PLAN]
    if (method === 'workspace/open') return WORKSPACE
    if (method === 'workspace/recent') return [WORKSPACE]
    return null
  }) as never)
})

const handlers = () =>
  (store.transport as unknown as {
    handlers: {
      onNotification(notification: unknown): void
      onEvent(runtime: unknown, event: unknown): void
    }
  }).handlers

it('reads the roster for the open folder, then which seat each Agent would take', async () => {
  await store.openWorkspace(WORKSPACE.path)
  asked.length = 0
  await store.loadAgents()
  // Only the roster's own verbs: opening a folder sets off other reads of its own.
  expect(asked.filter((one) => one.method.startsWith('agent/')).map((one) => [one.method, one.params])).toEqual([
    ['agent/list', { project: WORKSPACE.path }],
    ['agent/seat/dry', { project: WORKSPACE.path }],
  ])
  expect(store.getSnapshot().agents).toEqual([ENTRY])
  expect(store.getSnapshot().agentsProject).toBe(WORKSPACE.path)
  expect(store.getSnapshot().agentPlans.get('code-reviewer')).toEqual(PLAN)
})

it('reads again when the host says the roster changed — once this window has read it', async () => {
  handlers().onNotification({ method: 'agent/changed', params: { project: null } })
  await Promise.resolve()
  expect(asked.some((one) => one.method === 'agent/list')).toBe(false)

  await store.loadAgents()
  asked.length = 0
  handlers().onNotification({ method: 'agent/changed', params: { project: null } })
  await vi.waitFor(() =>
    expect(asked.filter((one) => one.method.startsWith('agent/')).map((one) => one.method)).toEqual([
      'agent/list',
      'agent/seat/dry',
    ]),
  )
})

it('weighs the seats again when a sign-in changes what can be seated', async () => {
  await store.loadAgents()
  asked.length = 0
  handlers().onEvent(runtimeId('cursor'), { type: 'account/changed', runtime: runtimeId('cursor') })
  await vi.waitFor(() => expect(asked.some((one) => one.method === 'agent/seat/dry')).toBe(true))
})
```

- [ ] **Step 5: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/agents.test.ts src/state/store.agents.test.ts`
Expected: FAIL — `Failed to resolve import "./agents"` and `store.loadAgents is not a function`.

- [ ] **Step 6: Write the words**

Create `packages/ui/src/lib/agents.ts`:

```ts
import type {
  AgentEntry,
  AgentOrigin,
  FlowPermission,
  RuntimeInfo,
  SeatCandidate,
  SeatFix,
  SeatPlan,
  SeatReason,
  WorkspaceEntry,
} from '@harnessdesk/protocol'

import { shortPath } from './paths'

/**
 * Agents, in words.
 *
 * Every surface that lists or starts an Agent says the same few things — its
 * ceiling, where it was found, why a seat was passed over and what fixes it —
 * and says them with no wire id, no seat spec and no digest. One place to say
 * each, so the roster, the refusal sheet, the name card and every menu cannot
 * drift apart. Pure: no store, no React.
 */

const PERMISSION_WORD: Readonly<Record<FlowPermission, string>> = { read: 'Read', publish: 'Publish', merge: 'Merge' }

/**
 * A ceiling as every surface says it in this phase: its word, and that it is
 * asked rather than held — the seat is told it, and nothing stops it yet.
 */
export const ceilingWords = (permission: FlowPermission): string => `${PERMISSION_WORD[permission]} · asked`

/** What a ceiling tells a seat, for a title: the rule, and that nothing holds it to the rule. */
export const ceilingMeaning = (permission: FlowPermission): string =>
  `${
    permission === 'read'
      ? 'Told it may edit and commit in its own checkout, and never push or merge.'
      : permission === 'publish'
        ? 'Told it may push its own branch and open a pull request, and never merge.'
        : 'Told it may merge what it is asked to merge.'
  } Asked, not held: nothing enforces it yet.`

/** Where an Agent was found, as its section is headed. */
export const originWords = (origin: AgentOrigin, project: string | null): string =>
  origin === 'project' ? `In ${project ?? 'this project'}` : origin === 'user' ? 'Yours' : 'Built in'

/** The name of the project a roster is read for: its repository's folder, or a worktree's own. */
export const projectName = (workspace: WorkspaceEntry | null): string | null => {
  if (!workspace) return null
  const root = workspace.repo && !workspace.repo.worktree ? workspace.repo.root : workspace.path
  return root.split('/').filter(Boolean).at(-1) ?? workspace.name
}

/** An Agent's name, or its folder's when its file names none or will not parse. */
export const agentName = (entry: AgentEntry): string => entry.definition?.name ?? entry.id

/** The Agents a surface can start: listed, and parsed. */
export const inForce = (entries: readonly AgentEntry[]): AgentEntry[] => entries.filter((one) => one.definition !== null)

/** Whether any listed Agent's file fails to parse — the only thing the nav row's dot is for. */
export const anyBroken = (entries: readonly AgentEntry[]): boolean =>
  entries.some((one) => one.problems.some((problem) => problem.level === 'error'))

/** The roster in its three sections, in the order precedence reads them. */
export const bySection = (entries: readonly AgentEntry[]): Readonly<Record<AgentOrigin, readonly AgentEntry[]>> => ({
  project: entries.filter((one) => one.origin === 'project'),
  user: entries.filter((one) => one.origin === 'user'),
  builtin: entries.filter((one) => one.origin === 'builtin'),
})

/**
 * Where an Agent's file is, as a person reads it. A shipped one is named inside
 * the app rather than by the folder the app is installed in, which differs on
 * every Mac and says nothing about the Agent.
 */
export const fileWords = (
  entry: { readonly id: string; readonly origin: AgentOrigin; readonly path: string },
  home: string,
): string => (entry.origin === 'builtin' ? `HarnessDesk › agents/${entry.id}/AGENT.md` : shortPath(entry.path, home))

/** A brief's opening paragraph, on one line: what a page shows before *Open in editor*. */
export const firstParagraph = (brief: string): string =>
  (brief.trim().split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ').trim()

/** Why a candidate was passed over, as a sentence, with the runtime named the way the desk names it. */
export const reasonWords = (reason: SeatReason, runtime: string): string => {
  switch (reason.kind) {
    case 'notInstalled':
      return reason.added ? `${runtime} is not installed on this Mac` : `${runtime} is not added to HarnessDesk`
    case 'unavailable':
      return `${runtime} is unavailable: ${reason.detail}`
    case 'noAnswer':
      return `${runtime} did not answer in time`
    case 'signedOut':
      return `${runtime} is signed out`
    case 'spent':
      return `${runtime}'s plan window is used up`
    case 'modelsUnread':
      return `${runtime}'s models could not be read`
    case 'noModel':
      return `${runtime} does not offer this model`
    case 'noEffort':
      return `${runtime} does not offer this effort`
    case 'couldNotOpen':
      return `${runtime} could not open a conversation: ${reason.detail}`
    case 'openedOtherwise':
      return `${runtime} opened it ${reason.detail}`
  }
}

/** The one thing that removes a reason, as the button that does it is labelled. */
export const fixWords = (fix: SeatFix, runtime: string): string => {
  switch (fix.kind) {
    case 'add':
      return `Add ${runtime}`
    case 'install':
      return `Install ${runtime}`
    case 'signIn':
      return `Sign in to ${runtime}`
    case 'usage':
      return 'See when it resets'
    case 'runtime':
      return `Open ${runtime} in Settings`
    case 'seats':
      return 'Edit seats for this Mac'
  }
}

/** The seat a plan would take here, or null when it would take none. */
export const seatTaken = (plan: SeatPlan | undefined): SeatCandidate | null =>
  plan && plan.winner !== null ? (plan.candidates[plan.winner] ?? null) : null

/** The first thing wrong with a plan that takes no seat, for a row with room for one reason. */
export const firstReason = (plan: SeatPlan): string | null => {
  if (plan.blocked) return plan.blocked
  if (plan.winner !== null) return null
  const first = plan.candidates.find((one) => one.reason !== null)
  if (first?.reason) return reasonWords(first.reason, first.runtimeName)
  return plan.candidates.length === 0 ? 'It names no seat to try' : null
}

/** What a runtime mark is drawn from: the runtime this desk has, or the name the host gave one it has not. */
export const markFor = (
  candidate: SeatCandidate,
  runtimes: readonly RuntimeInfo[],
): { readonly id: string; readonly presentation: { readonly name: string; readonly brand?: string } } =>
  runtimes.find((one) => one.id === candidate.seat.runtime) ?? {
    id: candidate.seat.runtime,
    presentation: { name: candidate.runtimeName },
  }
```

- [ ] **Step 7: Hold the roster in the snapshot**

1. In `packages/ui/src/state/snapshot.ts`, import `type AgentEntry` and `type SeatPlan` from `@harnessdesk/protocol`, and add to `AppSnapshot`, after `flowRuns`:

```ts
  /**
   * The Agent roster for `agentsProject`: that project's own Agents, then this
   * machine's, then the ones that ship, one per id, each carrying what it
   * shadowed and anything wrong with its file. Null until a surface that lists
   * Agents asks, so a window that never shows one never reads a file for it.
   */
  readonly agents: readonly AgentEntry[] | null
  /** The folder the roster above was read for — the open workspace — or null for none. */
  readonly agentsProject: string | null
  /** Which seat each listed Agent would take here, by Agent id: one dry run of the whole roster. */
  readonly agentPlans: ReadonlyMap<string, SeatPlan>
```

   and to `EMPTY`: `agents: null, agentsProject: null, agentPlans: new Map(),`; and to `emptySnapshot()`: `agentPlans: new Map(),`.

2. In `packages/ui/src/state/store.ts`, add, after `askSettings`:

```ts
  /**
   * Reads the Agent roster for the folder that is open, and then which seat
   * each would take here. Two reads, because the listing is a few files and
   * the dry run asks every runtime a question: the list draws first. The host
   * reads the folder as the checkout it is in, so an open subfolder still
   * lists its repository's Agents.
   */
  async loadAgents(): Promise<void> {
    const project = this.#snapshot.workspace?.path ?? null
    try {
      const agents = await this.transport.request('agent/list', project ? { project } : {})
      this.#patch({ agents, agentsProject: project })
    } catch (error) {
      this.notice('warning', describe(error))
      return
    }
    await this.loadAgentPlans()
  }

  /** Which seat each listed Agent would take here — a dry run, which opens nothing. */
  async loadAgentPlans(): Promise<void> {
    const project = this.#snapshot.workspace?.path ?? null
    try {
      const plans = await this.transport.request('agent/seat/dry', project ? { project } : {})
      this.#patch({ agentPlans: new Map(plans.map((plan) => [plan.id, plan])) })
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }
```

3. In the constructor's `onNotification`, after the `session/removed` block (Task 3), add:

```ts
        if (notification.method === 'agent/changed') {
          /* A file under the roster moved, or this machine's seats did. Read
             again only what this window has read: one that never showed an
             Agent has nothing drawn from the roster to go stale. */
          if (this.#snapshot.agents !== null) void this.loadAgents()
        }
```

   and at the end of the `runtime/added` and `runtime/removed` blocks: `if (this.#snapshot.agents !== null) void this.loadAgentPlans()`.
4. In `#onEvent`'s `account/changed` branch, after `void this.refreshRuntime()`, add `if (this.#snapshot.agents !== null) void this.loadAgentPlans()` — a sign-in is exactly what moves a candidate from passed over to taken.
5. In `openWorkspace`, after `this.#patch({ workspace })`, add `if (this.#snapshot.agents !== null) void this.loadAgents()` — another folder is another project's Agents.

- [ ] **Step 8: Give the preview a roster**

In `packages/ui/src/preview/main.tsx`:

1. Import `type AgentEntry` and `type SeatPlan` from `@harnessdesk/protocol`, and add, above `class PreviewStore`:

```ts
/**
 * The roster every Agent screen below is drawn from: a project Agent that
 * shadows a shipped one, one of yours, the shipped ones, and a file that will
 * not parse — the four shapes a roster row has — with a dry run in which one
 * Agent cannot be seated here.
 */
const agentEntry = (
  id: string,
  name: string,
  origin: AgentEntry['origin'],
  description: string,
  permission: 'read' | 'publish' = 'read',
  shadows: AgentEntry['shadows'] = [],
): AgentEntry => ({
  id,
  origin,
  path:
    origin === 'project'
      ? `${PREVIEW_ROOT}/.harnessdesk/agents/${id}/AGENT.md`
      : origin === 'user'
        ? `/home/u/.harnessdesk/agents/${id}/AGENT.md`
        : `/app/agents/${id}/AGENT.md`,
  digest: `digest-${id}`,
  shadows,
  problems: [],
  definition: {
    id,
    name,
    description,
    permission,
    answers: permission === 'read' ? ['approve', 'request-changes'] : [],
    produces: ['review'],
    skills: [],
    prefer: [{ runtime: 'claude' }, { runtime: 'codex' }, { runtime: 'cursor' }],
    brief: `You review a change somebody else wrote.\n\n## How to report\n\nEvery finding, then a verdict.\n\n## What you never do\n\nNever push.`,
  },
})

const PREVIEW_AGENTS: readonly AgentEntry[] = [
  agentEntry('code-reviewer', 'Code reviewer', 'project', 'The storefront team’s reviewer: reads the diff against our checkout rules.', 'read', [
    { origin: 'builtin', path: '/app/agents/code-reviewer/AGENT.md' },
  ]),
  agentEntry('release-checker', 'Release checker', 'user', 'Reads a release branch against the changelog before it is tagged.'),
  agentEntry('implementer', 'Implementer', 'builtin', 'Builds the change it is given on its own branch, proves it with the project’s checks, and hands it over.', 'publish'),
  agentEntry('security-reviewer', 'Security reviewer', 'builtin', 'Reads a change it did not write for the ways it could be abused, and says how to close each one.'),
  {
    id: 'draft',
    origin: 'user',
    path: '/home/u/.harnessdesk/agents/draft/AGENT.md',
    digest: 'digest-draft',
    shadows: [],
    problems: [{ level: 'error', at: 'permission', text: '"admin" is not a permission — it is read, publish or merge' }],
    definition: null,
  },
]

const takenOn = (id: string, runtime: string, label: string): SeatPlan => ({
  id,
  from: 'prefer',
  winner: 0,
  blocked: null,
  candidates: [{ seat: { runtime }, label, runtimeName: label.split(' · ')[0] ?? label, state: 'taken', reason: null, fix: null }],
})

const PREVIEW_PLANS: ReadonlyMap<string, SeatPlan> = new Map([
  ['code-reviewer', takenOn('code-reviewer', 'claude', 'Beta · Opus · High')],
  ['release-checker', takenOn('release-checker', 'codex', 'Alpha · GPT-5.6 Sol')],
  ['implementer', takenOn('implementer', 'claude', 'Beta')],
  [
    'security-reviewer',
    {
      id: 'security-reviewer',
      from: 'machine',
      winner: null,
      blocked: null,
      candidates: [
        { seat: { runtime: 'cursor' }, label: 'Gamma', runtimeName: 'Gamma', state: 'passed', reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'cursor' } },
        { seat: { runtime: 'shipper' }, label: 'Delta', runtimeName: 'Delta', state: 'passed', reason: { kind: 'notInstalled', added: false }, fix: { kind: 'add', runtime: 'shipper' } },
      ],
    },
  ],
  ['draft', { id: 'draft', from: 'prefer', winner: null, blocked: 'its file will not parse', candidates: [] }],
])
```

2. In the `PreviewStore` constructor's snapshot, add `agents: PREVIEW_AGENTS, agentsProject: PREVIEW_ROOT, agentPlans: PREVIEW_PLANS,`.

- [ ] **Step 9: Unpin the two verbs the store now calls**

In `script/check-reachable.mjs`, delete the `'agent/list'` and `'agent/seat/dry'` entries from `UNREACHED`.

- [ ] **Step 10: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/agents.test.ts src/state/store.agents.test.ts src/state/store.sessions.test.ts && node script/check-reachable.mjs`
Expected: PASS — `agents.test.ts` 8 tests, `store.agents.test.ts` 3 tests; `… 10 pinned as not.`

- [ ] **Step 11: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/server/src/methods packages/server/src/host.ts packages/server/test/agent-methods.test.ts packages/ui/src/lib/agents.ts packages/ui/src/lib/agents.test.ts packages/ui/src/state/snapshot.ts packages/ui/src/state/store.ts packages/ui/src/state/store.agents.test.ts packages/ui/src/preview/main.tsx script/check-reachable.mjs
git commit -m "feat(agents): the roster in the window, and one way to say it

The window holds the roster for the open folder and one dry run of it, and
reads both again when the host says the roster changed, when a sign-in moves
what can be seated, and when the folder moves. lib/agents says a ceiling
(asked, never held), an origin, a reason and its fix in one place, with no wire
id and no seat spec. The host reads a folder as the checkout it is in, so an
open subfolder lists its repository's Agents and a worktree its branch's.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 13: Settings › Agents — the roster

The roster page takes the `agents` id back. It is titled *Agents*, with the roadmap's blurb, in three sections — *In <project>*, *Yours*, *Built in* — each footnoted with the folder it reads. A row is the Agent's name and description, with its ceiling and the seat it would take here at the right, or *Can't seat here* and the first reason. A copy another tier shadows is listed in its own section, muted, saying what shadows it. A file that will not parse is a row whose line says why. The nav row counts the Agents in force and wears a dot only when one fails to parse.

Two decisions:

- **A shipped Agent's folder is named inside the app** (*Ships with HarnessDesk*; its file reads `HarnessDesk › agents/<id>/AGENT.md`), not by the path the app happens to be installed at. That path differs on every Mac, says nothing about the Agent, and in a checkout it is a personal path the screenshot audit refuses (`script/shots/audit.mjs`). *Reveal* (Task 15) still shows the real file.
- **This machine's folder is read from the host**, not guessed as `~/.harnessdesk`: `host/hello` gains `stateDir`, because `HARNESSDESK_HOME` moves it and the footnote must name the folder actually read.

Rows are not buttons yet; Task 15 opens an Agent's page from them.

**Files:**
- Create: `packages/ui/src/components/AgentRoster.tsx`, `packages/ui/src/components/AgentRoster.module.css`
- Modify: `packages/ui/src/components/Settings.tsx` (the `agents` section, its nav row, the roster read on open), `packages/ui/src/components/Icons.tsx` (`BriefIcon`), `packages/ui/src/components/CommandPalette.tsx` (`SETTINGS_PAGE.agents`)
- Modify: `packages/protocol/src/wire.ts`, `packages/server/src/methods/app.ts` (`host/hello` says `stateDir`), `packages/ui/src/state/snapshot.ts`, `packages/ui/src/state/store.ts` (`stateDir`)
- Modify: `packages/ui/src/preview/main.tsx` (`agents` in the dial; a frame of its own)
- Test: `packages/ui/src/components/AgentRoster.test.tsx` (new), `packages/ui/src/app/settings-routes.test.ts`, `packages/server/test/agent-methods.test.ts`
- Modify tests: `packages/ui/src/components/Settings.route.test.tsx`, `Settings.keys.test.tsx`, `AppWindow.escape.test.tsx` (their store stubs gain `loadAgents`, which the window now calls on opening), `CommandPalette.highlight.test.tsx` (the roster's row leads again)

**Interfaces:**
- Consumes: everything in Task 12's `lib/agents.ts`; `AppSnapshot.agents`, `agentPlans`, `workspace`, `home`, `runtimes`.
- Produces: `AgentsRosterSection` (props: none in this task; Task 15 adds `focus`); `AppSnapshot.stateDir: string`; `Section` gains `'agents'` again; `BriefIcon`.

- [ ] **Step 1: Write the failing tests**

1. Append to `packages/server/test/agent-methods.test.ts`:

```ts
test('the host says where this machine keeps its state, so the roster can name the folder it reads', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const hello = (await client.call('host/hello', { clientVersion: 'test' })) as { stateDir: string }
  assert.equal(hello.stateDir, harness.stateDir)
})
```

2. In `packages/ui/src/app/settings-routes.test.ts`, the first test becomes:

```ts
  it('opens on Runtimes by default, and the agents id is the roster again', () => {
    expect(resolveSection(null)).toBe('runtimes')
    expect(resolveSection('runtimes')).toBe('runtimes')
    expect(resolveSection('agents')).toBe('agents')
  })
```

3. Create `packages/ui/src/components/AgentRoster.test.tsx`:

```tsx
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, type AgentEntry, type RuntimeInfo, type SeatPlan } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AgentsRosterSection } from './AgentRoster'
import { Settings } from './Settings'

/**
 * Settings › Agents: who does the work, in the order precedence reads — this
 * project's own, yours, the ones that ship — each section saying which folder
 * it reads. Nothing is hidden: a shadowed copy is listed where it lives, and a
 * file that will not parse is a row that says why.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const agent = (
  id: string,
  name: string,
  origin: AgentEntry['origin'],
  over: Partial<AgentEntry> = {},
): AgentEntry => ({
  id,
  origin,
  path: origin === 'user' ? `/Users/dev/.harnessdesk/agents/${id}/AGENT.md` : `/w/storefront/.harnessdesk/agents/${id}/AGENT.md`,
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id,
    name,
    description: `${name} does the work.`,
    permission: 'read',
    answers: [],
    produces: [],
    skills: [],
    prefer: [{ runtime: 'claude-code' }],
    brief: 'Work.',
  },
  ...over,
})

const ROSTER: readonly AgentEntry[] = [
  agent('code-reviewer', 'Storefront reviewer', 'project', {
    shadows: [{ origin: 'builtin', path: '/app/agents/code-reviewer/AGENT.md' }],
  }),
  agent('scout', 'Scout', 'user'),
  agent('judge', 'Judge', 'builtin'),
  agent('security-reviewer', 'Security reviewer', 'builtin'),
  agent('draft', 'Draft', 'user', {
    definition: null,
    problems: [{ level: 'error', at: 'permission', text: '"admin" is not a permission — it is read, publish or merge' }],
  }),
]

const taken = (id: string, label: string): SeatPlan => ({
  id,
  from: 'prefer',
  winner: 0,
  blocked: null,
  candidates: [{ seat: { runtime: 'claude-code' }, label, runtimeName: 'Claude', state: 'taken', reason: null, fix: null }],
})

const PLANS = new Map<string, SeatPlan>([
  ['code-reviewer', taken('code-reviewer', 'Claude · Opus 5 · High')],
  ['scout', taken('scout', 'Claude')],
  ['judge', taken('judge', 'Claude')],
  [
    'security-reviewer',
    {
      id: 'security-reviewer',
      from: 'prefer',
      winner: null,
      blocked: null,
      candidates: [
        {
          seat: { runtime: 'cursor' },
          label: 'Cursor',
          runtimeName: 'Cursor',
          state: 'passed',
          reason: { kind: 'signedOut' },
          fix: { kind: 'signIn', runtime: 'cursor' },
        },
      ],
    },
  ],
])

const mount = (content: React.ReactNode) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    home: '/Users/dev',
    stateDir: '/Users/dev/.harnessdesk',
    workspace: { path: '/w/storefront', name: 'storefront', lastOpenedAt: 1 },
    runtimes: [{ id: runtimeId('claude-code'), capabilities: {}, presentation: { name: 'Claude' } } as unknown as RuntimeInfo],
    agents: ROSTER,
    agentsProject: '/w/storefront',
    agentPlans: PLANS,
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAgents: vi.fn(async () => {}),
    loadAccounts: vi.fn(async () => {}),
    agentCatalog: vi.fn(async () => []),
    acpRegistry: vi.fn(async () => ({ agents: [], fetchedAt: 1 })),
    transport: { request: vi.fn(async () => null) },
  } as unknown as AppStore
  act(() => {
    root.render(<StoreProvider store={store}>{content}</StoreProvider>)
  })
  return store
}

const sectionText = (label: string): string =>
  container.querySelector(`section[aria-label="${label}"]`)?.textContent ?? ''

it('reads the roster when it opens, and heads it as the roadmap says', () => {
  const store = mount(<AgentsRosterSection />)
  expect(store.loadAgents).toHaveBeenCalled()
  expect(container.querySelector('[data-slot="page-title"]')?.textContent).toBe('Agents')
  expect(container.textContent).toContain('Who does the work: a brief, the most it may do, and the seats it prefers.')
})

it('lists three sections in precedence order, each naming the folder it reads', () => {
  mount(<AgentsRosterSection />)
  const headings = [...container.querySelectorAll('section[aria-label]')].map((one) => one.getAttribute('aria-label'))
  expect(headings).toEqual(['In storefront', 'Yours', 'Built in'])
  expect(sectionText('In storefront')).toContain('/w/storefront/.harnessdesk/agents')
  expect(sectionText('Yours')).toContain('~/.harnessdesk/agents')
  expect(sectionText('Built in')).toContain('Ships with HarnessDesk')
})

it('shows each Agent with what it is for, its ceiling as asked, and the seat it would take here', () => {
  mount(<AgentsRosterSection />)
  const project = sectionText('In storefront')
  expect(project).toContain('Storefront reviewer')
  expect(project).toContain('Storefront reviewer does the work.')
  expect(project).toContain('Read · asked')
  expect(project).toContain('Claude · Opus 5 · High')
  // No wire: never the spec, never the digest.
  expect(container.textContent).not.toContain('claude-code')
  expect(container.textContent).not.toContain('=opus')
})

it('keeps an Agent that cannot be seated here, with the first reason on screen', () => {
  mount(<AgentsRosterSection />)
  expect(sectionText('Built in')).toContain("Can't seat here · Cursor is signed out")
})

it('lists a shadowed copy where it lives, muted, saying what shadows it', () => {
  mount(<AgentsRosterSection />)
  expect(sectionText('Built in')).toContain('Shadowed by the one in storefront')
})

it('lists a file that will not parse, with why', () => {
  mount(<AgentsRosterSection />)
  expect(sectionText('Yours')).toContain('permission — "admin" is not a permission')
  expect(sectionText('Yours')).toContain('Will not parse')
})

it('the nav row counts the Agents in force, and wears a dot only when a file will not parse', () => {
  mount(<Settings section="agents" onSection={() => {}} onClose={() => {}} onSignIn={() => {}} />)
  const row = [...container.querySelectorAll('button')].find((one) => one.textContent?.startsWith('Agents'))
  expect(row?.textContent).toContain('4')
  expect(row?.querySelector('[data-state="broken"]')).not.toBeNull()
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/AgentRoster.test.tsx src/app/settings-routes.test.ts`
Expected: FAIL — `Failed to resolve import "./AgentRoster"`, and `expected 'runtimes' to be 'agents'`.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-methods.test.js`
Expected: FAIL — `the host says where this machine keeps its state…`: `expected undefined to equal '/…/harnessdesk-test-…'`.

- [ ] **Step 3: Say where the state is**

1. In `packages/protocol/src/wire.ts`, in `host/hello`'s result, after `home`:

```ts
      /**
       * Where this desk keeps its state: `~/.harnessdesk` unless
       * `HARNESSDESK_HOME` put it elsewhere. The roster footnotes this
       * machine's Agents as `agents` in it, and an Agent's page footnotes
       * `seating.json` there — the folder actually read, never a guess.
       */
      readonly stateDir: string
```

2. In `packages/server/src/methods/app.ts`, add `stateDir: ctx.state.directory,` after `home: homedir(),`.
3. In `packages/ui/src/state/snapshot.ts`, add after `home`: `/** Where this desk keeps its state — see \`host/hello\`. Empty until the handshake. */ readonly stateDir: string`, and `stateDir: '',` to `EMPTY`.
4. In `packages/ui/src/state/store.ts`'s `connect`, add `stateDir: hello.stateDir,` beside `home: hello.home,`.

- [ ] **Step 4: Add the icon, and the section**

1. In `packages/ui/src/components/Icons.tsx`, add `ContactRound,` to the `lucide-react` import (alphabetically, after `Code`), and after `EveryoneIcon`:

```ts
/** An Agent — who does the work: a brief, a ceiling and the seats it prefers. Not a runtime, which is `AgentIcon`. */
export const BriefIcon = icon(ContactRound, 'BriefIcon')
```

2. In `packages/ui/src/components/Settings.tsx`:
   - `Section` gains `| 'agents'` (before `'runtimes'`); `SECTIONS` becomes `…'archive', 'agents', 'runtimes', 'models', …`; remove the `agents: 'runtimes'` line (and its comment) from `MOVED`.
   - Import `BriefIcon` from `./Icons`, `AgentsRosterSection` from `./AgentRoster`, and `anyBroken`, `inForce` from `../lib/agents`.
   - In `Settings`, after `useEffect(dismissOverlays, [])`, add:

```ts
  // The Agents row counts the roster and marks a file that will not parse, so
  // the roster is read when the window opens, whichever page it opens on.
  const store = useStore()
  useEffect(() => {
    if (store.getSnapshot().agents === null) void store.loadAgents()
  }, [store])
  const roster = snapshot.agents ?? []
```

   - In the `Agents` nav group, before the `runtimes` entry:

```ts
        {
          id: 'agents',
          label: 'Agents',
          icon: <BriefIcon size={14} />,
          ...(inForce(roster).length > 0 ? { count: inForce(roster).length } : {}),
          // A dot only for a file that will not parse: that is the one fact on this page that is wrong.
          ...(anyBroken(roster) ? { state: 'broken' as const } : {}),
          keywords: ['agents', 'who', 'brief', 'reviewer', 'implementer', 'judge', 'researcher', 'roster', 'seats', 'ceiling', 'shadowed', 'built in'],
        },
```

   - In the page switch, before the `runtimes` line: `{section === 'agents' && <AgentsRosterSection />}`.
3. In `packages/ui/src/components/CommandPalette.tsx`, import `BriefIcon`, and add to `SETTINGS_PAGE`, above the `runtimes` row — the palette lists the pages in the nav's order:

```tsx
  agents: { label: 'Agents', icon: <BriefIcon size={14} />, keywords: 'agents who briefs reviewer implementer judge researcher roster seats ceiling' },
```

   Typing *settings* leads with this row again, so in `CommandPalette.highlight.test.tsx` put back what Task 11 changed: `'Settings › Runtimes'` → `'Settings › Agents'` (both places) and `toHaveBeenCalledWith('runtimes')` → `toHaveBeenCalledWith('agents')`.
4. The window now reads the roster on opening, so every test that mounts `Settings` gives its store stub the verb — in `Settings.route.test.tsx`, `Settings.keys.test.tsx` and `AppWindow.escape.test.tsx`:

```bash
cd "$(git rev-parse --show-toplevel)"
for file in Settings.route Settings.keys AppWindow.escape; do
  perl -0pi -e 's/(\n(\s*)loadAccounts: vi\.fn\(async \(\) => \{\}\),)/$1\n$2loadAgents: vi.fn(async () => {}),/' "packages/ui/src/components/$file.test.tsx"
done
grep -c "loadAgents" packages/ui/src/components/Settings.route.test.tsx packages/ui/src/components/Settings.keys.test.tsx packages/ui/src/components/AppWindow.escape.test.tsx
```

   Expected: `1` for each.

- [ ] **Step 5: Write the page**

Create `packages/ui/src/components/AgentRoster.module.css`:

```css
/* The two facts at the right of a roster row: what it may do, and where it would sit here. */
.facts {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--hd-space-1);
  font-size: var(--hd-text-sm);
  line-height: var(--hd-line-sm);
  color: var(--hd-secondary-foreground);
  text-align: right;
}

.seat {
  display: inline-flex;
  align-items: center;
  gap: var(--hd-space-1);
  color: var(--hd-foreground);
}

/* Refused, and staying: the reason is on screen, in the tone of a doubt rather than a failure. */
.refused {
  color: var(--hd-warning-ink);
}

/* A copy another tier shadows: there, and quieter than what shadows it. */
.shadowed {
  color: var(--hd-muted-foreground);
}
```

Create `packages/ui/src/components/AgentRoster.tsx`:

```tsx
import { useEffect } from 'react'

import type { AgentEntry, AgentOrigin } from '@harnessdesk/protocol'

import {
  agentName,
  bySection,
  ceilingMeaning,
  ceilingWords,
  firstReason,
  markFor,
  originWords,
  projectName,
  seatTaken,
} from '../lib/agents'
import { shortPath } from '../lib/paths'
import type { AppSnapshot } from '../state/store'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { Chip, Note, PageHead, Row, Rows, SectionHead } from '../design'
import styles from './AgentRoster.module.css'

/**
 * Settings › Agents: who does the work.
 *
 * Three sections, in the order precedence reads them — this project's own,
 * yours, and the ones that ship — each footnoted with the folder it is read
 * from, because the file is the truth and the page says which file. A row is
 * an Agent's name and what it is for, with its ceiling and the seat it would
 * take here at the right. One that cannot be seated here stays, with *Can't
 * seat here* and the first reason. A copy another tier shadows is listed
 * where it lives, muted, saying what shadows it — the plugin roster's rule —
 * and a file that will not parse is a row whose line says why.
 */

const ORDER: readonly AgentOrigin[] = ['project', 'user', 'builtin']

const EMPTY: Readonly<Record<AgentOrigin, string>> = {
  project: 'No Agents in this project',
  user: 'None of your own yet',
  builtin: 'None ship with this build',
}

/** The folder a project's Agents are read from: the top of its checkout, where the host reads them. */
const projectFolder = (snapshot: AppSnapshot): string | null => {
  const first = (snapshot.agents ?? []).find((one) => one.origin === 'project')
  if (first) return first.path.split('/').slice(0, -2).join('/')
  const workspace = snapshot.workspace
  if (!workspace) return null
  const root = workspace.repo && !workspace.repo.worktree ? workspace.repo.root : workspace.path
  return `${root}/.harnessdesk/agents`
}

const footnote = (origin: AgentOrigin, snapshot: AppSnapshot): string => {
  if (origin === 'builtin') return 'Ships with HarnessDesk, and changes only when HarnessDesk does.'
  if (origin === 'user') {
    const folder = snapshot.stateDir ? shortPath(`${snapshot.stateDir}/agents`, snapshot.home) : 'agents in HarnessDesk’s folder'
    return `Read from ${folder} — yours, on this Mac only.`
  }
  const folder = projectFolder(snapshot)
  return `Read from ${folder ? shortPath(folder, snapshot.home) : 'the project'}, and committed with the code: everyone who clones it has these.`
}

export const AgentsRosterSection = () => {
  const store = useStore()
  const snapshot = useSnapshot()

  useEffect(() => {
    void store.loadAgents()
  }, [store])

  const agents = snapshot.agents ?? []
  const project = projectName(snapshot.workspace)
  const sections = bySection(agents)

  return (
    <>
      <PageHead title="Agents" blurb="Who does the work: a brief, the most it may do, and the seats it prefers." />
      {ORDER.filter((origin) => origin !== 'project' || snapshot.workspace !== null).map((origin) => {
        const heading = originWords(origin, project)
        const rows = sections[origin]
        /* Every copy a winner shadows, in the section of the tier it lives in:
           listed and marked, never hidden. */
        const shadowed = agents.flatMap((winner) =>
          winner.shadows.filter((one) => one.origin === origin).map((one) => ({ winner, path: one.path })),
        )
        return (
          <section key={origin} aria-label={heading}>
            <SectionHead name={heading} />
            <Rows>
              {rows.length === 0 && shadowed.length === 0 && <Row title={EMPTY[origin]} />}
              {rows.map((entry) => (
                <AgentRow key={entry.id} entry={entry} />
              ))}
              {shadowed.map(({ winner, path }) => (
                <Row
                  key={path}
                  title={<span className={styles.shadowed}>{agentName(winner)}</span>}
                  desc={`Shadowed by ${winner.origin === 'user' ? 'yours' : `the one in ${project ?? 'this project'}`}`}
                />
              ))}
            </Rows>
            <Note>{footnote(origin, snapshot)}</Note>
          </section>
        )
      })}
    </>
  )
}

/** One Agent in force, or one whose file will not parse. */
const AgentRow = ({ entry }: { readonly entry: AgentEntry }) => {
  const snapshot = useSnapshot()
  const definition = entry.definition
  if (!definition) {
    const problem = entry.problems.find((one) => one.level === 'error')
    return (
      <Row
        title={entry.id}
        desc={problem ? `${problem.at} — ${problem.text}` : 'Its file could not be read.'}
        control={<Chip state="broken" label="Will not parse" />}
      />
    )
  }
  const plan = snapshot.agentPlans.get(entry.id)
  const seat = seatTaken(plan)
  const reason = plan ? firstReason(plan) : null
  return (
    <Row
      title={definition.name}
      {...(definition.description ? { desc: definition.description } : {})}
      control={
        <span className={styles.facts}>
          <span title={ceilingMeaning(definition.permission)}>{ceilingWords(definition.permission)}</span>
          {seat ? (
            <span className={styles.seat}>
              <RuntimeMark runtime={markFor(seat, snapshot.runtimes)} size={12} />
              {seat.label}
            </span>
          ) : plan ? (
            <span className={styles.refused}>Can't seat here{reason ? ` · ${reason}` : ''}</span>
          ) : (
            <span>Checking seats…</span>
          )}
        </span>
      }
    />
  )
}
```

- [ ] **Step 6: Give the preview the page**

In `packages/ui/src/preview/main.tsx`: add `'agents',` to `SETTINGS_SECTIONS` before `'runtimes'`; add `stateDir: '/home/u/.harnessdesk', home: '/home/u',` to the `PreviewStore` snapshot; import `AgentsRosterSection` from `../components/AgentRoster`; and in the column that holds *Settings › Library*, add before it:

```tsx
          <Frame title="Settings › Agents — the roster">
            <div className="max-h-[640px] overflow-y-auto p-4">
              <AgentsRosterSection />
            </div>
          </Frame>
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/AgentRoster.test.tsx src/app/settings-routes.test.ts src/components/Settings.route.test.tsx src/components/Settings.keys.test.tsx src/components/AppWindow.escape.test.tsx src/components/CommandPalette.pages.test.tsx src/components/CommandPalette.highlight.test.tsx`
Expected: PASS — `AgentRoster.test.tsx` 7 tests.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-methods.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 8: Look at it**

`pnpm --filter @harnessdesk/ui run dev`, then `http://localhost:5273/preview.html`: the *Settings › Agents — the roster* frame shows *In <project>* with *Code reviewer* and its seat, *Yours* with *Release checker* and the *draft* row that will not parse, and *Built in* with the muted *Code reviewer* shadowed by the project's and *Security reviewer* reading *Can't seat here · Gamma is signed out*. Set the *settings page* dial to `agents`: the nav row reads *Agents 4* with a red dot. Both themes, via the *theme* dial.

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/protocol/src/wire.ts packages/server/src/methods/app.ts packages/server/test/agent-methods.test.ts packages/ui/src script/check-reachable.mjs
git commit -m "feat(settings): Settings › Agents is the roster of who

This project's Agents, yours and the ones that ship, each section naming the
folder it reads. A row is the Agent and what it is for, its ceiling as asked,
and the seat it would take here — or Can't seat here and the first reason,
never withdrawn. A shadowed copy is listed where it lives and says what
shadows it; a file that will not parse is a row that says why, and the only
thing that puts a dot on the nav row.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 14: Starting as an Agent — the new-session dialog, ⌘K, and the refusal sheet

The roadmap's *Starting as an Agent* and *The refusal sheet*, as one deliverable, because the sheet is where every start that cannot seat lands:

- **`store.startAsAgent(id)`** asks the dry run again for that one Agent (a sign-in since the menu was drawn changes the answer). A plan that takes no seat raises the sheet **without asking the host to open anything**. Otherwise it calls `agent/seat`; a `seatRefused` answer (Task 5) — every candidate failed, some only once open — raises the same sheet from the host's own list.
- **The refusal sheet** is store state (`seatRefusal`), mounted once in `App`, the way `newWorktreeFor` already is, because every door that starts an Agent can raise it and the door is usually gone by the time it is read. It lists every candidate with its reason and its fix, says *Nothing was opened*, and offers *Edit seats for this Mac* beneath.
- **A fix is a destination**: sign in to that runtime, its usage, its page in Settings › Runtimes, the Runtimes *Add* page, or — only for a seat the Agent asks for — the Agent's own page. `app/seat-fixes.ts` is the one place that decides, and the only door to the roster in it is the one about an Agent (the route test allows exactly that file and the palette). A fix button anywhere asks the store (`askSeatFix`), the way a deep settings link does (`askSettings`), and one effect in `App` — which holds the sign-in, the usage window and Settings — takes it there.
- **The new-session dialog lists Agents above the runtime's own door**, each with the mark of the runtime it would sit on here. One that cannot be seated stays, greyed, with its first reason on screen, and pressing it raises the sheet — greyed, never withdrawn, and never a dead end.
- **⌘K gains *Start as <Agent>* and *Open <Agent> in Settings***; the runtimes' own *Start with …* rows move to a *Runtimes* group. ⌘N is unchanged.
- **Settings opens on a thing inside a page**: `askSettings(section, focus)` and a one-shot `focus` prop, which the Runtimes page reads here (a runtime's page, or *Add a runtime*) and the Agents page reads in Task 15.

**Files:**
- Create: `packages/ui/src/components/SeatSheet.tsx`, `packages/ui/src/app/seat-fixes.ts`
- Modify: `packages/ui/src/lib/agents.ts` (`refusalOf`, `leftWords`, `tildeIn`), `packages/ui/src/state/snapshot.ts` (`SeatRefusal`, `seatRefusal`, `settingsFocus`), `packages/ui/src/state/store.ts` (`startAsAgent`, `dismissSeatRefusal`, `askSettings(section, focus)`)
- Modify: `packages/ui/src/app/App.tsx` (the sheet, the focus, the palette's `openSettings`), `packages/ui/src/components/Settings.tsx` and `SettingsAgents.tsx` (`focus`)
- Modify: `packages/ui/src/components/NewSessionChoice.tsx` (+ `.module.css`), `packages/ui/src/components/CommandPalette.tsx`
- Modify: `packages/ui/src/preview/main.tsx` (the dialog dial gains *new session* and *seat sheet*)
- Modify: `script/check-reachable.mjs` (unpin `agent/seat`)
- Test: `packages/ui/src/components/SeatSheet.test.tsx` (new), `packages/ui/src/app/seat-fixes.test.ts` (new), `packages/ui/src/state/store.agents.test.ts`, `packages/ui/src/components/NewSessionChoice.test.tsx`, `packages/ui/src/components/CommandPalette.agents.test.tsx`, `packages/ui/src/app/settings-routes.test.ts`; the other four `CommandPalette.*.test.tsx` stubs

**Interfaces:**
- Consumes: Task 12's words and state; Task 5's `seatRefused` error with `data.candidates`.
- Produces:
  - `interface SeatRefusal { agent: string; name: string; candidates: readonly SeatCandidate[]; blocked: string | null }` (exported from `state/snapshot.ts` and re-exported by `state/store.ts`); `AppSnapshot.seatRefusal: SeatRefusal | null`; `AppSnapshot.settingsFocus: string | null`; `AppSnapshot.seatFix: { fix: SeatFix; agent: string } | null`.
  - `AppStore.startAsAgent(id: string, options?: { cwd?: string; reveal?: boolean }): Promise<SessionKey | null>`; `AppStore.dismissSeatRefusal(): void`; `AppStore.askSettings(section: string | null, focus?: string | null): void`; `AppStore.askSeatFix(fix: SeatFix | null, agent?: string): void` — any surface's fix button, taken where it is fixed by one effect in `App`.
  - `refusalOf(error: unknown): readonly SeatCandidate[] | null`, `leftWords(left: SeatLeft, runtime: string): string`, `tildeIn(text: string, home: string): string` (`lib/agents.ts`).
  - `routeFor(fix: SeatFix, agent: string): SeatFixRoute` (`app/seat-fixes.ts`).
  - `SeatSheet({ refusal, onClose, onFix })`.
  - `PaletteHost.openSettings(section: Section, focus?: string): void`; `Settings` and `RuntimesSection` take `focus?: string | null`.

- [ ] **Step 1: Write the failing tests**

1. Create `packages/ui/src/app/seat-fixes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { SeatFix } from '@harnessdesk/protocol'

import { routeFor } from './seat-fixes'

/**
 * A fix on the refusal sheet is a destination. A runtime's trouble is fixed
 * where runtimes live — its page, its sign-in, its usage — and only a seat the
 * Agent asks for is fixed on the Agent's page. Nothing about a runtime opens
 * the roster.
 */
describe('where a fix goes', () => {
  it('sends every runtime’s trouble to the runtime, never to the roster', () => {
    const fixes: SeatFix[] = [
      { kind: 'signIn', runtime: 'cursor' },
      { kind: 'usage', runtime: 'cursor' },
      { kind: 'add', runtime: 'codex' },
      { kind: 'install', runtime: 'codex' },
      { kind: 'runtime', runtime: 'claude-code' },
    ]
    expect(fixes.map((fix) => routeFor(fix, 'code-reviewer'))).toEqual([
      { kind: 'signIn', runtime: 'cursor' },
      { kind: 'usage', runtime: 'cursor' },
      { kind: 'settings', section: 'runtimes', focus: 'add' },
      { kind: 'settings', section: 'runtimes', focus: 'codex' },
      { kind: 'settings', section: 'runtimes', focus: 'claude-code' },
    ])
  })

  it('sends a seat the Agent asks for to the Agent’s own page', () => {
    expect(routeFor({ kind: 'seats' }, 'code-reviewer')).toEqual({ kind: 'settings', section: 'agents', focus: 'code-reviewer' })
  })
})
```

2. Create `packages/ui/src/components/SeatSheet.test.tsx`:

```tsx
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore, type SeatRefusal } from '../state/store'
import { SeatSheet } from './SeatSheet'

/**
 * The refusal sheet: a list with a fix on every line, and nothing opened.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const REFUSAL: SeatRefusal = {
  agent: 'code-reviewer',
  name: 'Code reviewer',
  blocked: null,
  candidates: [
    {
      seat: { runtime: 'cursor', model: 'gemini-3.8-flash' },
      label: 'Cursor · Gemini 3.8 Flash',
      runtimeName: 'Cursor',
      state: 'passed',
      reason: { kind: 'signedOut' },
      fix: { kind: 'signIn', runtime: 'cursor' },
    },
    {
      seat: { runtime: 'codex' },
      label: 'Codex',
      runtimeName: 'Codex',
      state: 'passed',
      reason: { kind: 'notInstalled', added: false },
      fix: { kind: 'add', runtime: 'codex' },
    },
  ],
}

// One object, so every read of the store is the same snapshot.
const SNAPSHOT = { ...emptySnapshot(), status: 'open', home: '/home/u' } as unknown as AppSnapshot

const mount = (refusal: SeatRefusal) => {
  const onFix = vi.fn()
  const onClose = vi.fn()
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => SNAPSHOT,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SeatSheet refusal={refusal} onClose={onClose} onFix={onFix} />
      </StoreProvider>,
    )
  })
  return { onFix, onClose }
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)

it('says nothing was opened, and lists every candidate with its reason and its fix', () => {
  mount(REFUSAL)
  const text = document.body.textContent ?? ''
  expect(text).toContain('Code reviewer can’t be seated here')
  expect(text).toContain('Nothing was opened.')
  expect(text).toContain('Cursor · Gemini 3.8 Flash')
  expect(text).toContain('Cursor is signed out')
  expect(text).toContain('Codex is not added to HarnessDesk')
  expect(button('Sign in to Cursor')).toBeDefined()
  expect(button('Add Codex')).toBeDefined()
  // Words, never wire.
  expect(text).not.toContain('cursor=')
  expect(text).not.toContain('gemini-3.8-flash')
})

it('each fix, and Edit seats for this Mac beneath, says where to go', () => {
  const { onFix } = mount(REFUSAL)
  act(() => button('Sign in to Cursor')?.click())
  expect(onFix).toHaveBeenLastCalledWith({ kind: 'signIn', runtime: 'cursor' })
  act(() => button('Edit seats for this Mac')?.click())
  expect(onFix).toHaveBeenLastCalledWith({ kind: 'seats' })
})

it('says what a passed-over seat may have left behind', () => {
  mount({
    ...REFUSAL,
    candidates: [
      {
        seat: { runtime: 'gemini' },
        label: 'Gemini CLI',
        runtimeName: 'Gemini CLI',
        state: 'passed',
        reason: { kind: 'openedOtherwise', detail: 'at low effort, not high' },
        fix: { kind: 'seats' },
        left: { kind: 'kept' },
      },
    ],
  })
  expect(document.body.textContent).toContain('Gemini CLI may keep the empty conversation it opened')
})

it('an Agent that could not be weighed at all says why, with its file named from home', () => {
  mount({
    ...REFUSAL,
    candidates: [],
    blocked: `this Mac's seats for it in /home/u/.harnessdesk/seating.json cannot be read at [1]: "+fast" is not a switch a seat takes — the only one is +thinking`,
  })
  const text = document.body.textContent ?? ''
  expect(text).toContain('It could not be weighed at all')
  expect(text).toContain('~/.harnessdesk/seating.json cannot be read at [1]')
  expect(text).not.toContain('/home/u/')
})
```

3. Append to `packages/ui/src/state/store.agents.test.ts` (add `sessionId`, `sessionKey` and `type Session` to its protocol import):

```ts
const SEATED: Session = {
  id: sessionId('s1'),
  runtime: runtimeId('claude-code'),
  cwd: WORKSPACE.path,
  title: 'Code reviewer',
  status: { type: 'idle' },
  createdAt: 0,
  updatedAt: 0,
  turns: [],
  itemsLoaded: true,
}

const plan = (winner: number | null): SeatPlan => ({
  id: 'code-reviewer',
  from: 'prefer',
  winner,
  blocked: null,
  candidates: [
    {
      seat: { runtime: 'cursor' },
      label: 'Cursor',
      runtimeName: 'Cursor',
      state: winner === null ? 'passed' : 'taken',
      reason: winner === null ? { kind: 'signedOut' } : null,
      fix: winner === null ? { kind: 'signIn', runtime: 'cursor' } : null,
    },
  ],
})

const answering = (answers: Partial<Record<HostMethodName, (params: unknown) => unknown>>) =>
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    asked.push({ method, params })
    if (method === 'workspace/open') return WORKSPACE
    if (method === 'workspace/recent') return [WORKSPACE]
    const answer = answers[method]
    return answer ? answer(params) : null
  }) as never)

it('a start the plan already refuses opens nothing, and raises the sheet with every candidate', async () => {
  answering({ 'agent/seat/dry': () => [plan(null)] })
  await store.openWorkspace(WORKSPACE.path)
  expect(await store.startAsAgent('code-reviewer')).toBeNull()
  expect(asked.some((one) => one.method === 'agent/seat')).toBe(false)
  expect(store.getSnapshot().seatRefusal?.candidates.map((one) => one.reason)).toEqual([{ kind: 'signedOut' }])
  store.dismissSeatRefusal()
  expect(store.getSnapshot().seatRefusal).toBeNull()
})

it('a start the plan allows is seated in the open folder, and shown', async () => {
  answering({ 'agent/seat/dry': () => [plan(0)], 'agent/seat': () => SEATED })
  await store.openWorkspace(WORKSPACE.path)
  const key = await store.startAsAgent('code-reviewer')
  expect(key).toBe(sessionKey(runtimeId('claude-code'), SEATED.id))
  expect(asked.find((one) => one.method === 'agent/seat')?.params).toEqual({
    id: 'code-reviewer',
    cwd: WORKSPACE.path,
    project: WORKSPACE.path,
  })
  expect(store.getSnapshot().sessions.has(key!)).toBe(true)
  expect(store.getSnapshot().seatRefusal).toBeNull()
})

it('a fix asked for from deep inside is held until the shell takes it where it is fixed', () => {
  store.askSeatFix({ kind: 'signIn', runtime: 'cursor' }, 'code-reviewer')
  expect(store.getSnapshot().seatFix).toEqual({ fix: { kind: 'signIn', runtime: 'cursor' }, agent: 'code-reviewer' })
  store.askSeatFix(null)
  expect(store.getSnapshot().seatFix).toBeNull()
})

it('a refusal only an open seat could find raises the same sheet, from the host’s own list', async () => {
  answering({
    'agent/seat/dry': () => [plan(0)],
    'agent/seat': () => {
      throw Object.assign(new Error('No seat could be opened for this Agent'), {
        code: 'seatRefused',
        data: { candidates: [{ ...plan(null).candidates[0], reason: { kind: 'openedOtherwise', detail: 'at low effort, not high' }, fix: { kind: 'seats' } }] },
      })
    },
  })
  await store.openWorkspace(WORKSPACE.path)
  expect(await store.startAsAgent('code-reviewer')).toBeNull()
  expect(store.getSnapshot().seatRefusal?.candidates[0]?.reason).toEqual({ kind: 'openedOtherwise', detail: 'at low effort, not high' })
})
```

4. In `packages/ui/src/components/NewSessionChoice.test.tsx`, give `rig` a roster — add to its parameters `agents: readonly AgentEntry[] = []` and `plans: ReadonlyMap<string, SeatPlan> = new Map()` (import both types from `@harnessdesk/protocol`), put `agents, agentPlans: plans` on the snapshot, and add to the store stub `loadAgents: vi.fn(async () => {}), startAsAgent: vi.fn(async () => null),`. Then append:

```tsx
const reviewer = (id: string, name: string): AgentEntry => ({
  id,
  origin: 'builtin',
  path: `/app/agents/${id}/AGENT.md`,
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id,
    name,
    description: `${name}.`,
    permission: 'read',
    answers: [],
    produces: [],
    skills: [],
    prefer: [{ runtime: 'claude-code' }],
    brief: 'Review.',
  },
})

const PLANS = new Map<string, SeatPlan>([
  [
    'code-reviewer',
    {
      id: 'code-reviewer',
      from: 'prefer',
      winner: 0,
      blocked: null,
      candidates: [{ seat: { runtime: 'claude-code' }, label: 'Claude', runtimeName: 'Claude', state: 'taken', reason: null, fix: null }],
    },
  ],
  [
    'judge',
    {
      id: 'judge',
      from: 'prefer',
      winner: null,
      blocked: null,
      candidates: [
        { seat: { runtime: 'cursor' }, label: 'Cursor', runtimeName: 'Cursor', state: 'passed', reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'cursor' } },
      ],
    },
  ],
])

it('lists Agents above the session door, and starting one starts a conversation as it', () => {
  const { store } = rig([], {}, [reviewer('code-reviewer', 'Code reviewer'), reviewer('judge', 'Judge')], PLANS)
  const onClose = render(store)
  const labels = [...document.querySelectorAll('button')].map((one) => one.textContent ?? '')
  expect(labels.findIndex((one) => one.startsWith('Code reviewer'))).toBeLessThan(labels.findIndex((one) => one.startsWith('A session')))
  act(() => choice('Code reviewer').click())
  expect(store.startAsAgent).toHaveBeenCalledWith('code-reviewer')
  expect(onClose).toHaveBeenCalled()
})

it('an Agent that cannot be seated here stays, greyed with its reason — and pressing it asks why', () => {
  const { store } = rig([], {}, [reviewer('judge', 'Judge')], PLANS)
  render(store)
  const judge = choice('Judge')
  expect(judge.hasAttribute('data-refused')).toBe(true)
  expect(judge.textContent).toContain('Cursor is signed out')
  expect(judge.disabled).toBe(false)
  act(() => judge.click())
  expect(store.startAsAgent).toHaveBeenCalledWith('judge')
})
```

   (`rig`'s signature becomes `rig(history = [], over = {}, agents = [], plans = new Map())`.)

5. In `packages/ui/src/components/CommandPalette.agents.test.tsx`, add `agents` and `agentPlans` to the snapshot (the same `reviewer('code-reviewer', 'Code reviewer')` entry and a one-entry plans map with `winner: 0` on label `'Claude'`, declared in the file as in step 4), `loadAgents: vi.fn(async () => {})` and `startAsAgent: vi.fn(async () => null)` to the store, and make `host.openSettings` a `vi.fn()` returned from `mount`. Append:

```tsx
it('Start as <Agent> starts a conversation as it, and says where it would sit', async () => {
  const { store } = await mount()
  type('start as code')
  const start = row('Start as Code reviewer')
  expect(start.textContent).toContain('Claude')
  act(() => start.click())
  expect(store.startAsAgent).toHaveBeenCalledWith('code-reviewer')
})

it('Open <Agent> in Settings opens its page', async () => {
  const { openSettings } = await mount()
  type('open code reviewer')
  act(() => row('Open Code reviewer in Settings').click())
  expect(openSettings).toHaveBeenCalledWith('agents', 'code-reviewer')
})
```

   (`mount` returns `{ selectRuntime, newDraft, store, openSettings }`.)

6. In the other four palette tests — `CommandPalette.pages.test.tsx`, `.highlight.test.tsx`, `.search.test.tsx`, `.groups.test.tsx` — the palette now reads the roster when it opens, so each stub gains the verb:

```bash
cd "$(git rev-parse --show-toplevel)"
for file in pages highlight search groups; do
  perl -0pi -e 's/(\n(\s*)getSnapshot: \(\) => snapshot,)/$1\n$2loadAgents: async () => {},/' "packages/ui/src/components/CommandPalette.$file.test.tsx"
done
grep -c "loadAgents" packages/ui/src/components/CommandPalette.*.test.tsx
```

   Expected: `1` for each of the four, and at least `1` for `agents`.

7. In `packages/ui/src/app/settings-routes.test.ts`, add the object-literal door to `DOORS` and allow the two files whose doors are about an Agent:

```ts
  /\bsection:\s*'agents'/g,
```

```ts
const ROSTER_DOORS: readonly string[] = [
  // "Open <Agent> in Settings".
  'components/CommandPalette.tsx',
  // The refusal sheet's "Edit seats for this Mac", the one fix that is about the Agent.
  'app/seat-fixes.ts',
]
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/app/seat-fixes.test.ts src/components/SeatSheet.test.tsx src/state/store.agents.test.ts src/components/NewSessionChoice.test.tsx src/components/CommandPalette.agents.test.tsx`
Expected: FAIL — `Failed to resolve import "./seat-fixes"`, `Failed to resolve import "./SeatSheet"`, `store.startAsAgent is not a function`, `no choice named Code reviewer`, `no row reading “Start as Code reviewer”`.

- [ ] **Step 3: Words for a refusal**

Append to `packages/ui/src/lib/agents.ts` (add `SeatLeft` to its protocol import):

```ts
/** The candidates a host refusal carried, when the failure is a seating's refusal; null for any other. */
export const refusalOf = (error: unknown): readonly SeatCandidate[] | null => {
  const failure = error as { code?: unknown; data?: { candidates?: unknown } } | null
  return failure?.code === 'seatRefused' && Array.isArray(failure.data?.candidates)
    ? (failure.data.candidates as SeatCandidate[])
    : null
}

/** What a passed-over seat may have left behind, in a sentence. */
export const leftWords = (left: SeatLeft, runtime: string): string =>
  left.kind === 'kept'
    ? `${runtime} may keep the empty conversation it opened — it is archived here`
    : `The conversation it opened could not be deleted: ${left.detail}`

/**
 * A sentence the host wrote, with this Mac's home folder written `~` the way
 * every path on screen is — a refusal names the file it could not read.
 */
export const tildeIn = (text: string, home: string): string => {
  const root = home.endsWith('/') ? home.slice(0, -1) : home
  return root === '' ? text : text.split(`${root}/`).join('~/')
}
```

- [ ] **Step 4: State for the sheet and for a page's focus**

1. In `packages/ui/src/state/snapshot.ts`, import `type SeatCandidate` and `type SeatFix`, and add above `AppSnapshot`:

```ts
/**
 * An Agent that could not be seated, and why each seat it would take could
 * not be — what the refusal sheet draws. Store state, like `newWorktreeFor`,
 * because every door that starts an Agent can raise it and the door is usually
 * gone by the time it is read.
 */
export interface SeatRefusal {
  /** The Agent's id — where *Edit seats for this Mac* goes. */
  readonly agent: string
  readonly name: string
  readonly candidates: readonly SeatCandidate[]
  /** Why it could not be weighed at all, when that is the answer. */
  readonly blocked: string | null
}
```

   add to `AppSnapshot`, after `settingsFor`:

```ts
  /** The thing inside that page to open — an Agent's id, a runtime's, `add` — until the shell opens it. */
  readonly settingsFocus: string | null
  /** The refusal sheet, while it is up. */
  readonly seatRefusal: SeatRefusal | null
  /**
   * A fix for a seat, asked for from somewhere deep — the refusal sheet, an
   * Agent's page, a name card — until the shell, which holds the sign-in, the
   * usage window and Settings, takes it where it is fixed.
   */
  readonly seatFix: { readonly fix: SeatFix; readonly agent: string } | null
```

   and `settingsFocus: null, seatRefusal: null, seatFix: null,` to `EMPTY`. Re-export `SeatRefusal` from `state/store.ts` beside the other snapshot types.

2. In `packages/ui/src/state/store.ts`:
   - Replace `askSettings` with:

```ts
  /** Asks the shell to open a settings page — and a thing inside it — or clears the request once it has. */
  askSettings(section: string | null, focus: string | null = null): void {
    this.#patch({ settingsFor: section, settingsFocus: section ? focus : null })
  }

  /** Asks the shell to take a seat's fix where it is fixed (`app/seat-fixes.ts`), or clears the request once it has. */
  askSeatFix(fix: SeatFix | null, agent = ''): void {
    this.#patch({ seatFix: fix ? { fix, agent } : null })
  }
```

   - Import `refusalOf` from `../lib/agents` and `type SeatFix`, `type SeatPlan` from `@harnessdesk/protocol`, and add after `loadAgentPlans`:

```ts
  /**
   * Opens a conversation as an Agent in the open folder — or in `cwd`, a
   * room's — and shows it; or, when nothing can seat it there, opens nothing
   * and raises the refusal sheet with every candidate, its reason and its fix.
   *
   * The plan is asked again first, for this one Agent: a sign-in since the
   * menu was drawn changes the answer, and a plan that already takes no seat
   * refuses without asking the host to open anything. A refusal the host finds
   * only once a seat is open arrives as `seatRefused`, with its own list. The
   * folder is also the project the Agent is read for, because that is whose
   * Agents a conversation there should get.
   */
  async startAsAgent(
    id: string,
    options: { readonly cwd?: string; readonly reveal?: boolean } = {},
  ): Promise<SessionKey | null> {
    const cwd = options.cwd ?? this.#snapshot.workspace?.path
    // As `newSession`: a folder this app has proof is gone is never where a conversation starts.
    if (!cwd || this.#snapshot.foldersGone.has(cwd)) {
      this.notice('warning', 'Choose a project folder before starting a conversation.')
      return null
    }
    const name = this.#snapshot.agents?.find((one) => one.id === id)?.definition?.name ?? id
    let plan: SeatPlan | undefined
    try {
      ;[plan] = await this.transport.request('agent/seat/dry', { ids: [id], project: cwd })
    } catch (error) {
      this.notice('error', describe(error))
      return null
    }
    // The fresher answer replaces the one the menus drew — for the roster this window holds, not another folder's.
    if (plan && cwd === this.#snapshot.agentsProject) {
      this.#patch({ agentPlans: new Map(this.#snapshot.agentPlans).set(id, plan) })
    }
    if (!plan || plan.winner === null) {
      this.#patch({
        seatRefusal: { agent: id, name, candidates: plan?.candidates ?? [], blocked: plan?.blocked ?? null },
      })
      return null
    }
    try {
      const session = await this.transport.request('agent/seat', { id, cwd, project: cwd })
      this.#setSession(session)
      const key = sessionKey(session.runtime, session.id)
      if (options.reveal !== false) this.#showInPane(key)
      void this.loadHistory({ reset: true })
      return key
    } catch (error) {
      const candidates = refusalOf(error)
      if (candidates) {
        this.#patch({ seatRefusal: { agent: id, name, candidates, blocked: null } })
        return null
      }
      this.notice('error', describe(error))
      return null
    }
  }

  /** Puts the refusal sheet away. */
  dismissSeatRefusal(): void {
    this.#patch({ seatRefusal: null })
  }
```

- [ ] **Step 5: Where a fix goes**

Create `packages/ui/src/app/seat-fixes.ts`:

```ts
import type { RuntimeId, SeatFix } from '@harnessdesk/protocol'

import type { Section } from '../components/Settings'

/** Where a fix on the refusal sheet takes a person. */
export type SeatFixRoute =
  | { readonly kind: 'signIn'; readonly runtime: RuntimeId }
  | { readonly kind: 'usage'; readonly runtime: RuntimeId }
  | { readonly kind: 'settings'; readonly section: Section; readonly focus: string }

/**
 * The one place a fix becomes a destination. A runtime's trouble is fixed
 * where runtimes live — signing in, its usage, its page in Settings ›
 * Runtimes, or adding it there — and only a seat the Agent itself asks for is
 * fixed on the Agent's own page. So the one door to the roster here is the one
 * about an Agent; a sign-in never lands on it.
 */
export const routeFor = (fix: SeatFix, agent: string): SeatFixRoute => {
  switch (fix.kind) {
    case 'signIn':
      return { kind: 'signIn', runtime: fix.runtime as RuntimeId }
    case 'usage':
      return { kind: 'usage', runtime: fix.runtime as RuntimeId }
    case 'add':
      return { kind: 'settings', section: 'runtimes', focus: 'add' }
    case 'install':
    case 'runtime':
      return { kind: 'settings', section: 'runtimes', focus: fix.runtime }
    case 'seats':
      return { kind: 'settings', section: 'agents', focus: agent }
  }
}
```

- [ ] **Step 6: The sheet**

Create `packages/ui/src/components/SeatSheet.tsx`:

```tsx
import type { SeatFix } from '@harnessdesk/protocol'

import { fixWords, leftWords, markFor, reasonWords, tildeIn } from '../lib/agents'
import { useSnapshot } from '../state/context'
import type { SeatRefusal } from '../state/store'
import { RuntimeMark } from './BrandIcons'
import { BriefIcon } from './Icons'
import { Button, Dialog, Note, Row, Rows } from '../design'

/**
 * The refusal sheet: an Agent that could not be seated here, and nothing
 * opened.
 *
 * A list with a fix on every line — every candidate in the order the Agent
 * asked for them, the reason each was passed over, and the one thing that
 * removes it — because a refusal a person cannot act on is a dead end with
 * better manners. Beneath it, this Mac's seats for the Agent, which is the fix
 * when every candidate is wrong for this machine.
 */
export const SeatSheet = ({
  refusal,
  onClose,
  onFix,
}: {
  readonly refusal: SeatRefusal
  readonly onClose: () => void
  readonly onFix: (fix: SeatFix) => void
}) => {
  const snapshot = useSnapshot()
  return (
    <Dialog
      title={`${refusal.name} can’t be seated here`}
      icon={<BriefIcon size={15} />}
      size="md"
      onClose={onClose}
      footer={
        /* The proceeding action first; the footer paints it rightmost. */
        <>
          <Button variant="default" onClick={() => onFix({ kind: 'seats' })}>
            Edit seats for this Mac
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <Note>
        Nothing was opened.{' '}
        {refusal.blocked
          ? 'It could not be weighed at all:'
          : 'Each seat it would take, in its order, and what stands in the way:'}
      </Note>
      <Rows>
        {refusal.blocked && <Row title={tildeIn(refusal.blocked, snapshot.home)} />}
        {!refusal.blocked && refusal.candidates.length === 0 && (
          <Row title="It names no seat to try" desc="Add a seat for this Mac, or name one in its file." />
        )}
        {refusal.candidates.map((candidate, index) => {
          const why = [
            candidate.reason ? reasonWords(candidate.reason, candidate.runtimeName) : 'Not reached',
            candidate.left ? leftWords(candidate.left, candidate.runtimeName) : null,
          ]
            .filter((part): part is string => part !== null)
            .join('. ')
          const fix = candidate.fix
          return (
            <Row
              key={`${index}-${candidate.label}`}
              mark={<RuntimeMark runtime={markFor(candidate, snapshot.runtimes)} size={16} />}
              title={candidate.label}
              desc={why}
              {...(fix
                ? {
                    control: (
                      <Button size="sm" variant="outline" onClick={() => onFix(fix)}>
                        {fixWords(fix, candidate.runtimeName)}
                      </Button>
                    ),
                  }
                : {})}
            />
          )
        })}
      </Rows>
    </Dialog>
  )
}
```

- [ ] **Step 7: Mount the sheet, and let Settings open on a thing inside a page**

1. In `packages/ui/src/app/App.tsx`:
   - Import `SeatSheet` from `../components/SeatSheet` and `routeFor` from `./seat-fixes`.
   - Beside `libraryImport`, add a one-shot focus and one way to open Settings at it:

```tsx
  // One-shot, like `libraryImport`: the page reads it on the render it is
  // handed, and clearing it on the next commit leaves what it opened open.
  const [settingsFocus, setSettingsFocus] = useState<string | null>(null)
  useEffect(() => {
    if (settingsFocus !== null) setSettingsFocus(null)
  }, [settingsFocus])
  const openSettingsAt = useCallback((section: Section, focus: string | null) => {
    setSettingsOpen(section)
    setSettingsFocus(focus)
  }, [])
```

   - Replace the `askSettings` effect with:

```tsx
  useEffect(() => {
    if (!snapshot.settingsFor) return
    openSettingsAt(resolveSection(snapshot.settingsFor), snapshot.settingsFocus)
    store.askSettings(null)
  }, [snapshot.settingsFor, snapshot.settingsFocus, store, openSettingsAt])
```

   - Below it, take a seat's fix where it is fixed, from wherever it was asked for:

```tsx
  // A fix asked for from anywhere — the refusal sheet, an Agent's page, a
  // name card — goes where it is fixed, from here, where the sign-in, the
  // usage window and Settings live.
  useEffect(() => {
    const asked = snapshot.seatFix
    if (!asked) return
    store.askSeatFix(null)
    const route = routeFor(asked.fix, asked.agent)
    if (route.kind === 'signIn') setSignInOpen(route.runtime)
    else if (route.kind === 'usage') setUsageOpen(route.runtime)
    else openSettingsAt(route.section, route.focus)
  }, [snapshot.seatFix, store, openSettingsAt])
```

   - Pass `focus={settingsFocus}` to `<Settings …>`.
   - In the palette's `host`, replace `openSettings: (section) => setSettingsOpen(section),` with `openSettings: (section, focus) => openSettingsAt(section, focus ?? null),`.
   - After the `NewWorktree` mount, add:

```tsx
      {/* One mount for the sheet every door that starts an Agent can raise. */}
      {snapshot.seatRefusal && (
        <SeatSheet
          refusal={snapshot.seatRefusal}
          onClose={() => store.dismissSeatRefusal()}
          onFix={(fix) => {
            const agent = snapshot.seatRefusal?.agent ?? ''
            store.dismissSeatRefusal()
            store.askSeatFix(fix, agent)
          }}
        />
      )}
```

2. In `packages/ui/src/components/Settings.tsx`, add to the `Settings` props `focus = null,` with the type `/** The thing inside the page to open — handed down once, as it arrives. */ focus?: string | null`, and pass it on: `{section === 'runtimes' && <RuntimesSection onSignIn={onSignIn} focus={focus} />}`.
3. In `packages/ui/src/components/SettingsAgents.tsx`, give `RuntimesSection` a `focus` prop — change its signature to `({ onSignIn, focus = null }: { onSignIn: (runtime: RuntimeId) => void; focus?: string | null })` — and add, after the `useEffect` that loads accounts:

```tsx
  // Opened on a thing inside the page — the refusal sheet's "Add Codex", its
  // "Open Cursor in Settings" — rather than on the list.
  useEffect(() => {
    if (focus === 'add') setView({ kind: 'add' })
    else if (focus && snapshot.runtimes.some((entry) => entry.id === focus)) {
      setView({ kind: 'agent', runtime: focus as RuntimeId })
    }
  }, [focus, snapshot.runtimes])
```

- [ ] **Step 8: Agents above the session door**

1. Append to `packages/ui/src/components/NewSessionChoice.module.css`:

```css
/* The Agents, above the runtime's own door: who, before which program. */
.group {
  display: flex;
  flex-direction: column;
  gap: var(--hd-space-1);
}

.groupLabel {
  font-size: var(--hd-text-xs);
  line-height: var(--hd-line-xs);
  color: var(--hd-muted-foreground);
}

.mark[data-tone='agent'] {
  background: var(--hd-tint-teal-fill);
  color: var(--hd-tint-teal-ink);
}

/* Cannot be seated here: greyed, never withdrawn, and its reason on screen. */
.choice[data-refused] .mark {
  background: var(--hd-muted);
  color: var(--hd-muted-foreground);
}

.choice[data-refused] .name {
  color: var(--hd-muted-foreground);
}

.choice[data-refused] .note {
  color: var(--hd-warning-ink);
}
```

2. In `packages/ui/src/components/NewSessionChoice.tsx`:
   - Change the React import to `import { useEffect, useMemo, useState } from 'react'`, import `type AgentEntry` from `@harnessdesk/protocol`, `firstReason`, `inForce`, `markFor`, `seatTaken` from `../lib/agents`, `RuntimeMark` from `./BrandIcons`, and `BriefIcon` beside `AgentIcon, TeamIcon`.
   - In `NewSessionChoice`, after `const root = …`, add:

```tsx
  // Fresh every time the dialog opens: whether each Agent can be seated here
  // is what the list is for, and a sign-in since last time changes it.
  useEffect(() => {
    void store.loadAgents()
  }, [store])
  const agents = inForce(snapshot.agents ?? [])
```

   - In the final `return`, as the first child of `<div className={styles.choices}>`:

```tsx
        {agents.length > 0 && (
          <div className={styles.group} role="group" aria-label="As an Agent">
            <span className={styles.groupLabel}>As an Agent</span>
            {agents.map((entry) => (
              <AgentChoice key={entry.id} entry={entry} onClose={onClose} />
            ))}
          </div>
        )}
```

   - Add, below the component:

```tsx
/**
 * One Agent, as a door: its name, and the mark of the runtime it would sit on
 * here. One that cannot be seated here stays, greyed, with its first reason on
 * screen — and pressing it asks, which raises the refusal sheet with every
 * candidate and its fix rather than a button that does nothing.
 */
const AgentChoice = ({ entry, onClose }: { readonly entry: AgentEntry; readonly onClose: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const plan = snapshot.agentPlans.get(entry.id)
  const seat = seatTaken(plan)
  const refused = plan !== undefined && seat === null
  const reason = refused ? firstReason(plan) : null
  const name = entry.definition?.name ?? entry.id
  return (
    <Button
      type="button"
      variant="choice" size="row" className={styles.choice}
      data-refused={refused ? '' : undefined}
      title={
        seat
          ? `${entry.definition?.description ?? name} It would sit on ${seat.label}.`
          : 'Can’t be seated here — press to see every seat it would take, and what stands in the way.'
      }
      onClick={() => {
        onClose()
        void store.startAsAgent(entry.id)
      }}
    >
      <span className={styles.mark} data-tone="agent">
        {seat ? <RuntimeMark runtime={markFor(seat, snapshot.runtimes)} size={16} /> : <BriefIcon size={16} />}
      </span>
      <span className={styles.text}>
        <span className={styles.name}>{name}</span>
        {reason && <span className={styles.note}>{reason}</span>}
      </span>
    </Button>
  )
}
```

- [ ] **Step 9: ⌘K**

In `packages/ui/src/components/CommandPalette.tsx`:

1. Import `BriefIcon` and `inForce`, `markFor`, `seatTaken` from `../lib/agents`; widen `Entry['group']` to `'Actions' | 'Agents' | 'Runtimes' | 'Sessions' | 'Files' | 'Commands'`; and change `PaletteHost.openSettings` to `readonly openSettings: (section: Section, focus?: string) => void`.
2. After the `const input = useRef…` line, add:

```tsx
  // The roster, for "Start as" — read once if nothing has read it yet.
  useEffect(() => {
    if (store.getSnapshot().agents === null) void store.loadAgents()
  }, [store])
```

3. Change the runtimes' `group: 'Agents'` (the `Start with …` rows) to `group: 'Runtimes'`, and add, after that `agents` array:

```tsx
    /* Who, before which program: an Agent to start as, and its page. One that
       cannot be seated here is listed all the same — starting it is how the
       refusal sheet, and its fixes, are reached. */
    const roster: Entry[] = inForce(snapshot.agents ?? []).flatMap((entry) => {
      const definition = entry.definition
      if (!definition) return []
      const plan = snapshot.agentPlans.get(entry.id)
      const seat = seatTaken(plan)
      return [
        {
          id: `start-as-${entry.id}`,
          group: 'Agents' as const,
          label: `Start as ${definition.name}`,
          hint: seat ? seat.label : plan ? 'Can’t seat here' : undefined,
          icon: seat ? <RuntimeMark runtime={markFor(seat, snapshot.runtimes)} /> : <BriefIcon size={14} />,
          keywords: `agent new conversation ${definition.description ?? ''}`,
          run: () => {
            close()
            void store.startAsAgent(entry.id)
          },
        },
        {
          id: `open-agent-${entry.id}`,
          group: 'Agents' as const,
          label: `Open ${definition.name} in Settings`,
          icon: <BriefIcon size={14} />,
          keywords: 'agent settings brief seats ceiling this mac',
          run: () => {
            close()
            host.openSettings('agents', entry.id)
          },
        },
      ]
    })
```

   and return `[...actions, ...roster, ...agents, ...sessions, ...fileEntries, ...commands]`.
4. In `shown`, the no-query list becomes:

```tsx
      return [
        ...entries.filter((entry) => entry.group === 'Actions'),
        // Starting as an Agent up front; its page is found by typing.
        ...entries.filter((entry) => entry.group === 'Agents' && entry.id.startsWith('start-as-')),
        ...entries.filter((entry) => entry.group === 'Runtimes'),
        ...entries.filter((entry) => entry.group === 'Sessions').slice(0, 6),
      ]
```

- [ ] **Step 10: The preview, and the verb**

1. In `packages/ui/src/preview/main.tsx`, import `NewSessionChoice` and `SeatSheet`; widen the `dialog` state and dial to `'off' | 'remove' | 'bring back' | 'sign in' | 'new session' | 'seat sheet'`; narrow the worktree mount's condition from `dialog !== 'off' && dialog !== 'sign in'` to `(dialog === 'remove' || dialog === 'bring back')`, since two more values now exist that are not its; and beside the sign-in mount add:

```tsx
      {dialog === 'new session' && <NewSessionChoice onClose={() => setDialog('off')} />}
      {dialog === 'seat sheet' && (
        <SeatSheet
          refusal={{
            agent: 'security-reviewer',
            name: 'Security reviewer',
            blocked: null,
            candidates: PREVIEW_PLANS.get('security-reviewer')?.candidates ?? [],
          }}
          onClose={() => setDialog('off')}
          onFix={() => setDialog('off')}
        />
      )}
```

2. In `script/check-reachable.mjs`, delete the `'agent/seat'` entry from `UNREACHED` — `startAsAgent` calls it.

- [ ] **Step 11: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/app src/components/SeatSheet.test.tsx src/state/store.agents.test.ts src/components/NewSessionChoice.test.tsx src/components/CommandPalette.agents.test.tsx src/components/CommandPalette.pages.test.tsx src/components/CommandPalette.groups.test.tsx src/components/CommandPalette.search.test.tsx src/components/CommandPalette.highlight.test.tsx src/components/SettingsAgents.test.tsx && node script/check-reachable.mjs`
Expected: PASS; `… 9 pinned as not.`

- [ ] **Step 12: Look at it**

In the preview, set the *dialog* dial to *new session*: the Agents lead, each with its runtime's mark, and *Security reviewer* is greyed with *Gamma is signed out*. Set it to *seat sheet*: two candidates, each with its reason and fix, *Nothing was opened.*, and *Edit seats for this Mac*. Both themes.

- [ ] **Step 13: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/ui/src script/check-reachable.mjs
git commit -m "feat(agents): start a conversation as an Agent, or see why not

The new-session dialog lists Agents above the runtime's own door, each with
the mark of the runtime it would sit on here; one that cannot be seated stays,
greyed with its reason, and pressing it raises the refusal sheet. The sheet
opens nothing: every candidate, why it was passed over and the one fix that
removes it, and Edit seats for this Mac beneath — including a refusal only an
open seat could find. ⌘K gains Start as and Open in Settings, and Settings can
open on a thing inside a page.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 15: An Agent's page

A drill, not a dialog: pressing a roster row opens the Agent's page, and so does Settings opened on it (`focus`, Task 14 — *Open <Agent> in Settings*, the refusal sheet's *Edit seats for this Mac*). The page, top to bottom:

- **The head**: its name, where it was found, what it is for; *Start a conversation as <name>*, *Customize…* on a built-in or user Agent, *Remove…* on a project or user Agent.
- **File**: the file it comes from, with *Open file* and *Reveal*, and what it shadows.
- **Why it will not parse** / **Warnings**, when its file has problems — the only sections a broken Agent's page has besides its file.
- **Ceiling**: *Read · asked*, and what the ceiling tells a seat.
- **Seats**: its own `prefer`, each candidate with its state on this Mac and the fix for one that fails. When this Mac's seats replace the list here, it is still listed — muted, and saying so — because it is what the Agent carries to every other machine.
- **Answers**, **Produces** and **Skills**, read-only; Skills opens the Library.
- **Brief**: its first paragraph, and *Open in editor*.

*On this Mac* — the override, edited here — is Task 16.

Two things the page needs that Part A does not give:

- **The Agent's own list, weighed, when this Mac's replaces it.** The dry run weighs the list in force; a page that must show `prefer` with states beside this Mac's seats needs `prefer` weighed too, against the same readings. The dry run now adds it as `own` whenever this Mac's entry is the list in force — or would be, and cannot be read — and only then, so nothing is weighed twice.
- **Somewhere to go.** *Open file*, *Open in editor* and a started conversation all land behind the Settings window, so each leaves it (`onLeave`, which is Settings' own close).

**Files:**
- Modify: `packages/protocol/src/agent.ts` (`SeatPlan.own`), `packages/server/src/methods/agents.ts` (the dry run weighs `prefer` beside this Mac's seats)
- Test: `packages/server/test/agent-seat.test.ts`
- Create: `packages/ui/src/components/AgentPage.tsx`, `packages/ui/src/components/AgentPage.module.css`
- Modify: `packages/ui/src/lib/agents.ts` (`stateWords`, `wordList`, `shadowWords`, `copyTargets`), `packages/ui/src/components/AgentRoster.tsx` (rows drill; `focus`, `onLeave`), `packages/ui/src/components/Settings.tsx` (hands the roster `focus` and `onLeave`), `packages/ui/src/state/store.ts` (`revealAgent`, `customizeAgent`, `trashAgent`)
- Modify: `packages/ui/src/preview/main.tsx` (a frame for the page), `script/check-reachable.mjs` (unpin `agent/copy`, `agent/remove`, `agent/reveal`)
- Test: `packages/ui/src/components/AgentPage.test.tsx` (new), `packages/ui/src/lib/agents.test.ts`, `packages/ui/src/state/store.agents.test.ts`

**Interfaces:**
- Consumes: `agent/copy`, `agent/remove`, `agent/reveal` (Task 9); `startAsAgent`, `askSeatFix`, `askSettings` (Task 14); Task 12's words.
- Produces:
  - `SeatPlan.own?: readonly SeatCandidate[]` — the Agent's own `prefer`, weighed, present exactly when `from === 'machine'`.
  - `stateWords(candidate: SeatCandidate): string`, `wordList(words: readonly string[]): string`, `shadowWords(entry: AgentEntry): string | null`, `copyTargets(origin: AgentOrigin, project: boolean): readonly ('user' | 'project')[]` (`lib/agents.ts`).
  - `AppStore.revealAgent(id: string, origin?: AgentOrigin): Promise<void>` (a failure is a notice), `AppStore.customizeAgent(id: string, from: AgentOrigin, to: 'user' | 'project'): Promise<AgentEntry>` and `AppStore.trashAgent(id: string, origin: 'user' | 'project'): Promise<void>` (both throw, for the dialog that asked to say why).
  - `AgentsRosterSection({ focus?: string | null; onLeave?: () => void })`; `AgentPage({ entry, onBack, onLeave })`.

- [ ] **Step 1: Write the failing host tests**

In `packages/server/test/agent-seat.test.ts`:

1. In `an entry this machine cannot read refuses the seating — never the prefer it replaced — and blocks the plan` (Task 6), replace the last line with:

```ts
  const { own, ...rest } = plan!
  assert.deepEqual(rest, { id: 'reviewer', from: 'machine', candidates: [], winner: null, blocked: why })
  // The list it replaced here is still weighed, for the Agent's page.
  assert.deepEqual(own?.map((one) => one.label), ['claude · opus-5'])
```

2. Append:

```ts
/*
 * An Agent's page shows its own list beside this Mac's, so the dry run weighs
 * `prefer` too whenever this Mac's seats replace it — against the same
 * readings, opening nothing — and only then.
 */

test("an Agent this Mac seats otherwise still has its own list weighed, for its page", async () => {
  const seen = await rig(
    'claude=opus-5',
    {
      claude: { name: 'Claude', models: ['opus-5'] },
      cursor: { name: 'Cursor', models: ['gemini-3.8-flash'], signedOut: true },
    },
    { machine: JSON.stringify({ reviewer: ['cursor=gemini-3.8-flash'] }) },
  )
  const [plan] = await agentMethods['agent/seat/dry'](seen.ctx, { ids: ['reviewer'] })
  assert.equal(plan?.from, 'machine')
  assert.deepEqual(
    plan?.candidates.map((one) => [one.label, one.state]),
    [['Cursor · gemini-3.8-flash', 'passed']],
  )
  assert.deepEqual(plan?.own?.map((one) => [one.label, one.state]), [['Claude · opus-5', 'taken']])
  untouched(seen)
})

test('an Agent whose own list is the one in force is weighed once', async () => {
  const seen = await rig('claude=opus-5', { claude: { name: 'Claude', models: ['opus-5'] } })
  const [plan] = await agentMethods['agent/seat/dry'](seen.ctx, { ids: ['reviewer'] })
  assert.equal(plan?.from, 'prefer')
  assert.equal(plan !== undefined && 'own' in plan, false)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-seat.test.js`
Expected: FAIL — `build:node` reports `Property 'own' does not exist on type 'SeatPlan'`.

- [ ] **Step 3: Weigh the Agent's own list beside this Mac's**

1. In `packages/protocol/src/agent.ts`, add to `SeatPlan`, after `blocked`:

```ts
  /**
   * The Agent's own `prefer`, weighed against the same readings, when this
   * machine's seats replace it here (`from: 'machine'`) — what its page lists
   * under *Seats*, muted, beside the list in force. Absent otherwise: when
   * `prefer` is the list in force, `candidates` already is it.
   */
  readonly own?: readonly SeatCandidate[]
```

2. In `packages/server/src/methods/agents.ts`, replace the `'agent/seat/dry'` handler (Task 6's) with:

```ts
  'agent/seat/dry': async (ctx, params) => {
    const roster = await ctx.agents.list(await projectOf(ctx, params.project))
    const machine = await ctx.seating.read()
    const ids = params.ids ?? roster.map((one) => one.id)
    const weighed = ids.map((id) => {
      const entry = roster.find((one) => one.id === id)
      if (!entry) return { plan: blockedPlan(id, `No Agent called “${id}”.`) }
      if (!entry.definition || entry.digest === null) return { plan: blockedPlan(id, unusable(entry)) }
      return { id, list: candidatesFor(entry.definition, machine), prefer: entry.definition.prefer }
    })
    // Every runtime either list names, read once: the Agent's own list is only weighed beside this Mac's.
    const desk = await readDesk(
      ctx,
      weighed.flatMap((one) => ('list' in one ? [...('seats' in one.list ? one.list.seats : []), ...one.prefer] : [])),
    )
    const words = wordsFor(ctx, desk.catalogues)
    return weighed.map((one): SeatPlan => {
      if ('plan' in one) return one.plan
      const own = () => planSeats(one.id, one.prefer, desk.offers, words, 'prefer').candidates
      if ('refused' in one.list) return { ...blockedPlan(one.id, one.list.refused, 'machine'), own: own() }
      if (one.list.from === 'machine') {
        return { ...planSeats(one.id, one.list.seats, desk.offers, words, 'machine'), own: own() }
      }
      return planSeats(one.id, one.list.seats, desk.offers, words, 'prefer')
    })
  },
```

   and add `type SeatPlan` to its `@harnessdesk/protocol` import if it is not there.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-seat.test.js`
Expected: PASS — 58 tests (56 + 2).

- [ ] **Step 5: Write the failing renderer tests**

1. Append to `packages/ui/src/lib/agents.test.ts` (add `copyTargets`, `shadowWords`, `stateWords` and `wordList` to its import):

```ts
describe('an Agent’s page in words', () => {
  it('says each candidate’s state on this Mac', () => {
    const [passed, taken] = plan().candidates
    expect(stateWords(taken!)).toBe('The seat it takes here')
    expect(stateWords(passed!)).toBe('Cursor is signed out')
    expect(stateWords({ ...taken!, state: 'untried' })).toBe('Not reached: a seat before it is free')
  })

  it('reads an Agent’s own words as words', () => {
    expect(wordList(['approve', 'request-changes'])).toBe('Approve · Request changes')
    expect(wordList([])).toBe('None')
  })

  it('says what a copy in force comes first over', () => {
    expect(shadowWords(entry('a'))).toBeNull()
    expect(
      shadowWords(entry('a', { origin: 'project', shadows: [{ origin: 'user', path: '/u' }, { origin: 'builtin', path: '/b' }] })),
    ).toBe('Comes first over yours and the one that ships')
  })

  it('copies only to somewhere that comes first', () => {
    expect(copyTargets('builtin', true)).toEqual(['project', 'user'])
    expect(copyTargets('builtin', false)).toEqual(['user'])
    expect(copyTargets('user', true)).toEqual(['project'])
    expect(copyTargets('user', false)).toEqual([])
    expect(copyTargets('project', true)).toEqual([])
  })
})
```

2. Append to `packages/ui/src/state/store.agents.test.ts`:

```ts
it('customizing and removing read the roster again, and say why when the host refuses', async () => {
  const copy = { ...ENTRY, origin: 'user' as const, path: '/u/.harnessdesk/agents/code-reviewer/AGENT.md' }
  answering({
    'agent/list': () => [copy],
    'agent/copy': () => copy,
    'agent/remove': () => {
      throw new Error('Moving an Agent to the Trash needs the desktop app.')
    },
  })
  await store.openWorkspace(WORKSPACE.path)
  await store.loadAgents()
  asked.length = 0
  expect(await store.customizeAgent('code-reviewer', 'builtin', 'user')).toEqual(copy)
  expect(asked.find((one) => one.method === 'agent/copy')?.params).toEqual({
    id: 'code-reviewer',
    from: 'builtin',
    to: 'user',
    project: WORKSPACE.path,
  })
  await vi.waitFor(() => expect(asked.some((one) => one.method === 'agent/list')).toBe(true))
  await expect(store.trashAgent('code-reviewer', 'user')).rejects.toThrow('needs the desktop app')
})
```

3. Create `packages/ui/src/components/AgentPage.test.tsx`:

```tsx
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  runtimeId,
  sessionKey,
  type AgentEntry,
  type RuntimeInfo,
  type SeatCandidate,
  type SeatPlan,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AgentsRosterSection } from './AgentRoster'

/**
 * An Agent's page: where it comes from, what it may do, the seats it asks for
 * and their state on this Mac, what it hands back, and its brief — with
 * starting it, customizing it and removing it.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const agent = (id: string, name: string, origin: AgentEntry['origin'], over: Partial<AgentEntry> = {}): AgentEntry => ({
  id,
  origin,
  path:
    origin === 'user'
      ? `/Users/dev/.harnessdesk/agents/${id}/AGENT.md`
      : origin === 'project'
        ? `/w/storefront/.harnessdesk/agents/${id}/AGENT.md`
        : `/app/agents/${id}/AGENT.md`,
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id,
    name,
    description: `${name} does the work.`,
    permission: 'read',
    answers: ['approve', 'request-changes'],
    produces: ['review'],
    skills: ['checkout-rules'],
    prefer: [{ runtime: 'claude-code' }],
    brief: 'You review a change.\nSomebody else wrote it.\n\n## How to report\n\nFindings first.',
  },
  ...over,
})

const ROSTER: readonly AgentEntry[] = [
  agent('code-reviewer', 'Code reviewer', 'project', {
    shadows: [{ origin: 'builtin', path: '/app/agents/code-reviewer/AGENT.md' }],
  }),
  agent('scout', 'Scout', 'user'),
  agent('judge', 'Judge', 'builtin'),
  agent('draft', 'draft', 'user', {
    definition: null,
    problems: [{ level: 'error', at: 'permission', text: '"admin" is not a permission — it is read, publish or merge' }],
  }),
]

const candidate = (
  runtime: string,
  label: string,
  state: SeatCandidate['state'],
  over: Partial<SeatCandidate> = {},
): SeatCandidate => ({ seat: { runtime }, label, runtimeName: label.split(' · ')[0]!, state, reason: null, fix: null, ...over })

const PLANS = new Map<string, SeatPlan>([
  [
    'judge',
    {
      id: 'judge',
      from: 'prefer',
      winner: 1,
      blocked: null,
      candidates: [
        candidate('cursor', 'Cursor', 'passed', { reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'cursor' } }),
        candidate('claude-code', 'Claude · Opus 5 · High', 'taken'),
      ],
    },
  ],
  [
    'code-reviewer',
    {
      id: 'code-reviewer',
      from: 'machine',
      winner: 0,
      blocked: null,
      candidates: [candidate('codex', 'Codex · GPT-5.6 Sol', 'taken')],
      own: [candidate('claude-code', 'Claude', 'taken')],
    },
  ],
  ['scout', { id: 'scout', from: 'prefer', winner: 0, blocked: null, candidates: [candidate('claude-code', 'Claude', 'taken')] }],
])

const COPY: AgentEntry = { ...ROSTER[2]!, origin: 'user', path: '/Users/dev/.harnessdesk/agents/judge/AGENT.md' }

const mount = (props: { readonly focus?: string } = {}) => {
  const onLeave = vi.fn()
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    home: '/Users/dev',
    stateDir: '/Users/dev/.harnessdesk',
    workspace: { path: '/w/storefront', name: 'storefront', lastOpenedAt: 1 },
    runtimes: [{ id: runtimeId('claude-code'), capabilities: {}, presentation: { name: 'Claude' } } as unknown as RuntimeInfo],
    agents: ROSTER,
    agentsProject: '/w/storefront',
    agentPlans: PLANS,
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAgents: vi.fn(async () => {}),
    openFile: vi.fn(),
    revealAgent: vi.fn(async () => {}),
    customizeAgent: vi.fn(async () => COPY),
    trashAgent: vi.fn(async () => {}),
    startAsAgent: vi.fn(async () => sessionKey(runtimeId('claude-code'), 's1')),
    askSeatFix: vi.fn(),
    askSettings: vi.fn(),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <AgentsRosterSection {...props} onLeave={onLeave} />
      </StoreProvider>,
    )
  })
  return { store, onLeave }
}

const button = (label: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no button reading “${label}”`)
  return found
}
const hasButton = (label: string): boolean =>
  [...document.body.querySelectorAll('button')].some((one) => one.textContent?.trim() === label)
const rowFor = (name: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((one) => one.textContent?.startsWith(name))
  if (!found) throw new Error(`no roster row for ${name}`)
  return found
}
const settle = () => act(async () => {})

it('opens from its roster row, names its file, and opens or reveals it', () => {
  const { store, onLeave } = mount()
  act(() => rowFor('Judge').click())
  expect(container.querySelector('[data-slot="page-title"]')).toBeNull()
  expect(hasButton('Agents')).toBe(true)
  const text = container.textContent ?? ''
  expect(text).toContain('Judge does the work.')
  expect(text).toContain('HarnessDesk › agents/judge/AGENT.md')
  act(() => button('Reveal').click())
  expect(store.revealAgent).toHaveBeenCalledWith('judge', 'builtin')
  act(() => button('Open file').click())
  expect(store.openFile).toHaveBeenCalledWith('/app/agents/judge/AGENT.md')
  expect(onLeave).toHaveBeenCalled()
})

it('opens on the Agent Settings was asked for, and goes back to the roster', () => {
  mount({ focus: 'scout' })
  expect(container.textContent).toContain('Scout does the work.')
  act(() => button('Agents').click())
  expect(container.querySelector('[data-slot="page-title"]')?.textContent).toBe('Agents')
})

it('says its ceiling is asked, and lists each seat with its state here and the fix for one that fails', () => {
  const { store } = mount({ focus: 'judge' })
  const text = container.textContent ?? ''
  expect(text).toContain('Read · asked')
  expect(text).toContain('Cursor is signed out')
  expect(text).toContain('The seat it takes here')
  act(() => button('Sign in to Cursor').click())
  expect(store.askSeatFix).toHaveBeenCalledWith({ kind: 'signIn', runtime: 'cursor' }, 'judge')
})

it('lists its own seats, muted, where this Mac’s replace them', () => {
  mount({ focus: 'code-reviewer' })
  const text = container.textContent ?? ''
  expect(text).toContain('Not used on this Mac')
  expect(text).toContain('Free here')
  expect(text).toContain('Comes first over the one that ships')
})

it('shows what it answers, produces and uses, and a skill opens the Library', () => {
  const { store } = mount({ focus: 'judge' })
  const text = container.textContent ?? ''
  expect(text).toContain('Approve · Request changes')
  expect(text).toContain('Review')
  act(() => button('checkout-rules').click())
  expect(store.askSettings).toHaveBeenCalledWith('library')
})

it('opens on the brief’s first paragraph, and opens the rest in the editor', () => {
  const { store, onLeave } = mount({ focus: 'judge' })
  expect(container.textContent).toContain('You review a change. Somebody else wrote it.')
  expect(container.textContent).not.toContain('Findings first.')
  act(() => button('Open in editor').click())
  expect(store.openFile).toHaveBeenCalledWith('/app/agents/judge/AGENT.md')
  expect(onLeave).toHaveBeenCalled()
})

it('starts a conversation as it, and leaves Settings once one is open', async () => {
  const { store, onLeave } = mount({ focus: 'judge' })
  act(() => button('Start a conversation as Judge').click())
  await settle()
  expect(store.startAsAgent).toHaveBeenCalledWith('judge')
  expect(onLeave).toHaveBeenCalled()
})

it('customizes a built-in into yours or the project’s, then opens the copy', async () => {
  const { store, onLeave } = mount({ focus: 'judge' })
  expect(hasButton('Remove…')).toBe(false)
  act(() => button('Customize…').click())
  const choices = [...document.body.querySelectorAll('[role="radio"]')].map((one) => one.textContent ?? '')
  expect(choices[0]).toContain('For storefront')
  expect(choices[1]).toContain('For you')
  act(() => (document.body.querySelectorAll('[role="radio"]')[1] as HTMLButtonElement).click())
  act(() => button('Copy and open').click())
  await settle()
  expect(store.customizeAgent).toHaveBeenCalledWith('judge', 'builtin', 'user')
  expect(store.openFile).toHaveBeenCalledWith(COPY.path)
  expect(onLeave).toHaveBeenCalled()
})

it('removes one of yours to the Trash, after asking, and goes back to the roster', async () => {
  const { store } = mount({ focus: 'scout' })
  act(() => button('Remove…').click())
  act(() => button('Move to Trash').click())
  await settle()
  expect(store.trashAgent).toHaveBeenCalledWith('scout', 'user')
  expect(container.querySelector('[data-slot="page-title"]')?.textContent).toBe('Agents')
})

it('opens a file that will not parse on why, with nothing to start', () => {
  mount({ focus: 'draft' })
  const text = container.textContent ?? ''
  expect(text).toContain('Why it will not parse')
  expect(text).toContain('"admin" is not a permission')
  expect(hasButton('Start a conversation as draft')).toBe(false)
  expect(hasButton('Remove…')).toBe(true)
})
```

- [ ] **Step 6: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/agents.test.ts src/state/store.agents.test.ts src/components/AgentPage.test.tsx`
Expected: FAIL — `copyTargets is not a function` (and its three siblings), `store.customizeAgent is not a function`, and `no roster row for Judge` — the rows are not buttons yet.

- [ ] **Step 7: The words**

Append to `packages/ui/src/lib/agents.ts`:

```ts
/** A candidate's state on this Mac, as its row on an Agent's page says it. */
export const stateWords = (candidate: SeatCandidate): string => {
  if (candidate.state === 'taken') return 'The seat it takes here'
  if (candidate.state === 'untried') return 'Not reached: a seat before it is free'
  return candidate.reason ? reasonWords(candidate.reason, candidate.runtimeName) : 'Passed over'
}

/** Words an Agent's file lists — its verdicts, what it produces — as a person reads them. */
export const wordList = (words: readonly string[]): string =>
  words.length === 0
    ? 'None'
    : words
        .map((one) => {
          const spaced = one.replace(/[-_]+/g, ' ')
          return spaced.charAt(0).toUpperCase() + spaced.slice(1)
        })
        .join(' · ')

/** What an Agent in force comes first over, in a sentence; null when it hides nothing. */
export const shadowWords = (entry: AgentEntry): string | null =>
  entry.shadows.length === 0
    ? null
    : `Comes first over ${entry.shadows.map((one) => (one.origin === 'builtin' ? 'the one that ships' : 'yours')).join(' and ')}`

/**
 * Where *Customize…* may copy an Agent: only somewhere that comes before it,
 * the project first — a copy anywhere else would be shadowed by what it copies.
 */
export const copyTargets = (origin: AgentOrigin, project: boolean): readonly ('user' | 'project')[] =>
  origin === 'builtin' ? (project ? ['project', 'user'] : ['user']) : origin === 'user' && project ? ['project'] : []
```

- [ ] **Step 8: The store's three file verbs**

In `packages/ui/src/state/store.ts`, import `type AgentOrigin` from `@harnessdesk/protocol`, and add after `dismissSeatRefusal`:

```ts
  /** Shows the file an Agent comes from in the file browser — the copy at `origin`, or the one in force. */
  async revealAgent(id: string, origin?: AgentOrigin): Promise<void> {
    const project = this.#snapshot.agentsProject
    try {
      await this.transport.request('agent/reveal', { id, ...(origin ? { origin } : {}), ...(project ? { project } : {}) })
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  /**
   * *Customize…*: copies an Agent to you or to the project, where the copy
   * comes first, and answers the copy. Throws the host's refusal, for the
   * dialog that asked to say.
   */
  async customizeAgent(id: string, from: AgentOrigin, to: 'user' | 'project'): Promise<AgentEntry> {
    const project = this.#snapshot.agentsProject
    const copy = await this.transport.request('agent/copy', { id, from, to, ...(project ? { project } : {}) })
    void this.loadAgents()
    return copy
  }

  /** *Remove…*: moves a user or project Agent's folder to the Trash. Throws the host's refusal. */
  async trashAgent(id: string, origin: 'user' | 'project'): Promise<void> {
    const project = this.#snapshot.agentsProject
    await this.transport.request('agent/remove', { id, origin, ...(project ? { project } : {}) })
    void this.loadAgents()
  }
```

- [ ] **Step 9: The page**

1. Create `packages/ui/src/components/AgentPage.module.css`:

```css
/* A list this Mac does not use: listed, and quieter than the one it does. */
.unused {
  color: var(--hd-muted-foreground);
}

/* The buttons at the right of a row that has more than one. */
.actions {
  display: flex;
  gap: var(--hd-space-1);
}
```

2. Create `packages/ui/src/components/AgentPage.tsx`:

```tsx
import { useState } from 'react'

import type { AgentEntry, SeatCandidate, SeatFix } from '@harnessdesk/protocol'

import {
  agentName,
  ceilingMeaning,
  ceilingWords,
  copyTargets,
  fileWords,
  firstParagraph,
  fixWords,
  markFor,
  originWords,
  projectName,
  shadowWords,
  stateWords,
  wordList,
} from '../lib/agents'
import { shortPath } from '../lib/paths'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { BriefIcon } from './Icons'
import {
  BackLink,
  Button,
  CodeText,
  ConfirmDialog,
  DetailHead,
  DetailMark,
  Dialog,
  Note,
  Row,
  RowChoice,
  RowValue,
  Rows,
  SectionHead,
} from '../design'
import styles from './AgentPage.module.css'

/**
 * An Agent's page — a drill from the roster, not a dialog.
 *
 * Everything the roster row summarises, in full: the file it comes from, its
 * ceiling, the seats it asks for and their state on this Mac, what it answers
 * and produces, and the opening of its brief — with the three things a person
 * does to an Agent: start a conversation as it, copy it somewhere it comes
 * first, and move it to the Trash. Nothing here is edited in place; the file
 * is the truth, and *Open in editor* is where it changes.
 */
export const AgentPage = ({
  entry,
  onBack,
  onLeave,
}: {
  readonly entry: AgentEntry
  readonly onBack: () => void
  /** Closes Settings: what is opened from here — the file, a conversation — is behind it. */
  readonly onLeave: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [customizing, setCustomizing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const definition = entry.definition
  const name = agentName(entry)
  const project = projectName(snapshot.workspace)
  const targets = definition ? copyTargets(entry.origin, snapshot.workspace !== null) : []
  const errors = entry.problems.filter((one) => one.level === 'error')
  const warnings = entry.problems.filter((one) => one.level === 'warning')
  const shadows = shadowWords(entry)

  const openFile = (): void => {
    store.openFile(entry.path)
    onLeave()
  }

  return (
    <>
      <BackLink to="Agents" onClick={onBack} />
      <DetailHead
        mark={
          <DetailMark>
            <BriefIcon size={22} />
          </DetailMark>
        }
        name={name}
        owner={originWords(entry.origin, project)}
        {...(definition?.description ? { blurb: definition.description } : {})}
        actions={
          <>
            {definition && (
              <Button
                variant="default"
                onClick={() => {
                  // Never disabled: one that cannot be seated here raises the refusal sheet, with its fixes.
                  void store.startAsAgent(entry.id).then((key) => {
                    if (key) onLeave()
                  })
                }}
              >
                Start a conversation as {definition.name}
              </Button>
            )}
            {targets.length > 0 && (
              <Button variant="outline" onClick={() => setCustomizing(true)}>
                Customize…
              </Button>
            )}
            {entry.origin !== 'builtin' && (
              <Button variant="secondary" onClick={() => setRemoving(true)}>
                Remove…
              </Button>
            )}
          </>
        }
      />

      <SectionHead name="File" />
      <Rows>
        <Row
          title={<CodeText>{fileWords(entry, snapshot.home)}</CodeText>}
          {...(shadows ? { desc: shadows } : {})}
          control={
            <span className={styles.actions}>
              <Button size="sm" variant="outline" onClick={openFile}>
                Open file
              </Button>
              <Button size="sm" variant="outline" onClick={() => void store.revealAgent(entry.id, entry.origin)}>
                Reveal
              </Button>
            </span>
          }
        />
      </Rows>

      {errors.length > 0 && (
        <>
          <SectionHead name="Why it will not parse" />
          <Rows>
            {errors.map((one) => (
              <Row key={`${one.at}-${one.text}`} title={one.text} {...(one.at ? { desc: `At ${one.at}` } : {})} />
            ))}
          </Rows>
        </>
      )}
      {warnings.length > 0 && (
        <>
          <SectionHead name="Warnings" />
          <Rows>
            {warnings.map((one) => (
              <Row key={`${one.at}-${one.text}`} title={one.text} {...(one.at ? { desc: `At ${one.at}` } : {})} />
            ))}
          </Rows>
        </>
      )}

      {definition && (
        <>
          <SectionHead name="Ceiling" />
          <Rows>
            <Row title={ceilingWords(definition.permission)} desc={ceilingMeaning(definition.permission)} />
          </Rows>

          <OwnSeats entry={entry} />

          <SectionHead name="What it hands back" />
          <Rows>
            <Row title="Answers" control={<RowValue>{wordList(definition.answers)}</RowValue>} />
            <Row title="Produces" control={<RowValue>{wordList(definition.produces)}</RowValue>} />
            <Row
              title="Skills"
              control={
                definition.skills.length === 0 ? (
                  <RowValue>None</RowValue>
                ) : (
                  <span className={styles.actions}>
                    {definition.skills.map((skill) => (
                      <Button key={skill} size="sm" variant="link" title="Open the Library" onClick={() => store.askSettings('library')}>
                        {skill}
                      </Button>
                    ))}
                  </span>
                )
              }
            />
          </Rows>

          <SectionHead name="Brief" />
          <Rows>
            <Row
              title={firstParagraph(definition.brief) || 'It has no brief yet.'}
              control={
                <Button size="sm" variant="outline" onClick={openFile}>
                  Open in editor
                </Button>
              }
            />
          </Rows>
        </>
      )}

      {customizing && definition && (
        <CustomizeDialog
          entry={entry}
          targets={targets}
          onClose={() => setCustomizing(false)}
          onCopied={(copy) => {
            store.openFile(copy.path)
            onLeave()
          }}
        />
      )}

      {removing && entry.origin !== 'builtin' && (
        <ConfirmDialog
          title={`Remove ${name}?`}
          confirmLabel="Move to Trash"
          onCancel={() => {
            setRemoving(false)
            setProblem(null)
          }}
          onConfirm={() => {
            const origin = entry.origin as 'user' | 'project'
            void store.trashAgent(entry.id, origin).then(onBack, (error: unknown) => {
              setProblem(error instanceof Error ? error.message : 'The host did not remove it.')
            })
          }}
        >
          Its folder goes to the Trash, where it can be put back.
          {entry.shadows.length > 0 ? ' The one it came first over takes its place.' : ''}
          {entry.origin === 'project' ? ' The project’s checkout changes; commit it for everyone else.' : ''}
          {problem && <Note tone="bad">{problem}</Note>}
        </ConfirmDialog>
      )}
    </>
  )
}

/**
 * The seats the Agent asks for — its own `prefer` — each with its state on
 * this Mac. Where this Mac's seats replace the list here, it is still listed,
 * muted and saying so: it is what the Agent carries to every other machine.
 */
const OwnSeats = ({
  entry,
  onEditSeats,
}: {
  readonly entry: AgentEntry
  /** Where a seat the Agent asks for that this Mac cannot give is fixed — this Mac's own seats. */
  readonly onEditSeats?: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const plan = snapshot.agentPlans.get(entry.id)
  const replaced = plan?.from === 'machine'
  const seats = replaced ? (plan.own ?? []) : (plan?.candidates ?? [])
  return (
    <section aria-label="Seats">
      <SectionHead name="Seats" />
      <Note>
        {replaced
          ? 'Not used on this Mac: its seats here replace this list. Every other machine seats it in this order.'
          : 'In the order it asks for them. The first this Mac can offer is the one it takes.'}
      </Note>
      <Rows className={replaced ? styles.unused : undefined}>
        {!plan && <Row title="Checking seats…" />}
        {plan && !replaced && plan.blocked && <Row title={plan.blocked} />}
        {plan && seats.length === 0 && !plan.blocked && <Row title="It names no seat" />}
        {seats.map((candidate, index) => (
          <SeatRow
            key={`${index}-${candidate.label}`}
            candidate={candidate}
            words={replaced && candidate.state === 'taken' ? 'Free here' : stateWords(candidate)}
            editsSeats={onEditSeats !== undefined}
            onFix={(fix) => (fix.kind === 'seats' ? onEditSeats?.() : store.askSeatFix(fix, entry.id))}
          />
        ))}
      </Rows>
    </section>
  )
}

/** One seat, its state here, and the one fix that removes what stands in its way. */
export const SeatRow = ({
  candidate,
  words,
  editsSeats = false,
  onFix,
}: {
  readonly candidate: SeatCandidate
  readonly words: string
  /** Whether this surface can take *Edit seats for this Mac* itself; a button that goes nowhere is not drawn. */
  readonly editsSeats?: boolean
  readonly onFix: (fix: SeatFix) => void
}) => {
  const snapshot = useSnapshot()
  const fix = candidate.fix
  return (
    <Row
      mark={<RuntimeMark runtime={markFor(candidate, snapshot.runtimes)} size={16} />}
      title={candidate.label}
      desc={words}
      {...(fix && (fix.kind !== 'seats' || editsSeats)
        ? {
            control: (
              <Button size="sm" variant="outline" onClick={() => onFix(fix)}>
                {fixWords(fix, candidate.runtimeName)}
              </Button>
            ),
          }
        : {})}
    />
  )
}

/** *Customize…*: where the copy goes, and only places it would come first. */
const CustomizeDialog = ({
  entry,
  targets,
  onClose,
  onCopied,
}: {
  readonly entry: AgentEntry
  readonly targets: readonly ('user' | 'project')[]
  readonly onClose: () => void
  readonly onCopied: (copy: AgentEntry) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [to, setTo] = useState(targets[0] ?? 'user')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const project = projectName(snapshot.workspace)
  const yours = snapshot.stateDir ? shortPath(`${snapshot.stateDir}/agents`, snapshot.home) : 'your Agents'
  const copy = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      onCopied(await store.customizeAgent(entry.id, entry.origin, to))
    } catch (error) {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'The host did not copy it.')
    }
  }
  return (
    <Dialog
      title={`Customize ${agentName(entry)}`}
      icon={<BriefIcon size={15} />}
      onClose={onClose}
      footer={
        <>
          <Button variant="default" disabled={busy} onClick={() => void copy()}>
            {busy ? 'Copying…' : 'Copy and open'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <Note>
        A copy to edit, which comes first wherever it is put. The one it copies stays as it is, shadowed.
      </Note>
      <Rows role="radiogroup" aria-label="Where the copy goes">
        {targets.map((target) => (
          <RowChoice
            key={target}
            title={target === 'project' ? `For ${project ?? 'this project'}` : 'For you'}
            desc={
              target === 'project'
                ? 'In the project’s .harnessdesk/agents, committed with the code for everyone who clones it'
                : `In ${yours}, on this Mac only`
            }
            selected={to === target}
            onClick={() => setTo(target)}
          />
        ))}
      </Rows>
      {problem && <Note tone="bad">{problem}</Note>}
    </Dialog>
  )
}
```

3. In `packages/ui/src/components/AgentRoster.tsx`:
   - Change the React import to `import { useEffect, useState } from 'react'`, import `AgentPage` from `./AgentPage`, and add `RowButton` to the design import.
   - Replace the head of `AgentsRosterSection` with:

```tsx
export const AgentsRosterSection = ({
  focus = null,
  onLeave = () => {},
}: {
  /** An Agent to open on — *Open <Agent> in Settings*, the refusal sheet's *Edit seats for this Mac*. */
  readonly focus?: string | null
  /** Closes Settings, for what an Agent's page opens behind it. */
  readonly onLeave?: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [open, setOpen] = useState<string | null>(focus)
  useEffect(() => {
    if (focus) setOpen(focus)
  }, [focus])

  useEffect(() => {
    void store.loadAgents()
  }, [store])

  const agents = snapshot.agents ?? []
  const project = projectName(snapshot.workspace)
  const sections = bySection(agents)
  const opened = open ? agents.find((one) => one.id === open) : undefined
  if (opened) return <AgentPage key={opened.id} entry={opened} onBack={() => setOpen(null)} onLeave={onLeave} />
```

   - Render each row as `<AgentRow key={entry.id} entry={entry} onOpen={() => setOpen(entry.id)} />`, and replace `AgentRow` with:

```tsx
/** One Agent in force, or one whose file will not parse — each a way into its page. */
export const AgentRow = ({ entry, onOpen }: { readonly entry: AgentEntry; readonly onOpen: () => void }) => {
  const snapshot = useSnapshot()
  const definition = entry.definition
  if (!definition) {
    const problem = entry.problems.find((one) => one.level === 'error')
    return (
      <RowButton
        title={entry.id}
        desc={problem ? `${problem.at} — ${problem.text}` : 'Its file could not be read.'}
        control={<Chip state="broken" label="Will not parse" />}
        onClick={onOpen}
      />
    )
  }
  const plan = snapshot.agentPlans.get(entry.id)
  const seat = seatTaken(plan)
  const reason = plan ? firstReason(plan) : null
  return (
    <RowButton
      title={definition.name}
      {...(definition.description ? { desc: definition.description } : {})}
      control={
        <span className={styles.facts}>
          <span title={ceilingMeaning(definition.permission)}>{ceilingWords(definition.permission)}</span>
          {seat ? (
            <span className={styles.seat}>
              <RuntimeMark runtime={markFor(seat, snapshot.runtimes)} size={12} />
              {seat.label}
            </span>
          ) : plan ? (
            <span className={styles.refused}>Can't seat here{reason ? ` · ${reason}` : ''}</span>
          ) : (
            <span>Checking seats…</span>
          )}
        </span>
      }
      onClick={onOpen}
    />
  )
}
```

   - Remove `Row` from the design import only if nothing else in the file still uses it (the empty-section row and the shadowed rows do; keep it).
4. In `packages/ui/src/components/Settings.tsx`, render the roster as `{section === 'agents' && <AgentsRosterSection focus={focus} onLeave={onClose} />}`.

- [ ] **Step 10: The preview, and the verbs**

1. In `packages/ui/src/preview/main.tsx`, give *Code reviewer* this Mac's seats, so its page shows both lists — replace its `PREVIEW_PLANS` entry with:

```ts
  [
    'code-reviewer',
    {
      id: 'code-reviewer',
      from: 'machine',
      winner: 0,
      blocked: null,
      candidates: [
        { seat: { runtime: 'claude', model: 'opus', effort: 'high' }, label: 'Beta · Opus · High', runtimeName: 'Beta', state: 'taken', reason: null, fix: null },
      ],
      own: [
        { seat: { runtime: 'claude' }, label: 'Beta', runtimeName: 'Beta', state: 'taken', reason: null, fix: null },
        { seat: { runtime: 'codex' }, label: 'Alpha', runtimeName: 'Alpha', state: 'untried', reason: null, fix: null },
        { seat: { runtime: 'cursor' }, label: 'Gamma', runtimeName: 'Gamma', state: 'untried', reason: null, fix: null },
      ],
    },
  ],
```

   and, below the roster's frame:

```tsx
          <Frame title="Settings › Agents — an Agent's page">
            <div className="max-h-[720px] overflow-y-auto p-4">
              <AgentsRosterSection focus="code-reviewer" />
            </div>
          </Frame>
```

2. In `script/check-reachable.mjs`, delete the `'agent/copy'`, `'agent/remove'` and `'agent/reveal'` entries from `UNREACHED` — the store calls all three.

- [ ] **Step 11: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/agents.test.ts src/state/store.agents.test.ts src/components/AgentPage.test.tsx src/components/AgentRoster.test.tsx src/app/settings-routes.test.ts && node script/check-reachable.mjs`
Expected: PASS — `AgentPage.test.tsx` 10 tests; `… 6 pinned as not.`

- [ ] **Step 12: Look at it**

In the preview, the *Settings › Agents — an Agent's page* frame: *Code reviewer*, *In storefront*, its file with *Open file* and *Reveal* and *Comes first over the one that ships*; *Read · asked*; *Seats* muted under *Not used on this Mac*, Beta *Free here* and the two after it *Not reached*; *Approve · Request changes*; the brief's opening line and *Open in editor*. Both themes.

- [ ] **Step 13: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/protocol/src/agent.ts packages/server/src/methods/agents.ts packages/server/test/agent-seat.test.ts packages/ui/src script/check-reachable.mjs
git commit -m "feat(agents): an Agent's page

A roster row opens the Agent: the file it comes from, with Open file and
Reveal and what it comes first over; its ceiling, asked; the seats it asks
for, each with its state on this Mac and the fix for one that fails; what it
answers and produces, and its skills, which open the Library; and the opening
of its brief. Start a conversation as it, Customize… to copy it somewhere it
comes first, or Remove… it to the Trash. Where this Mac's seats replace its
own, the dry run weighs its own list too, and the page lists it muted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 16: On this Mac — an Agent's seats here, edited on its page

The roadmap's **On this Mac**: this machine's seats for the Agent (`seating.json`, Task 6), which replace its own list here and are never committed — added to, reordered or cleared on its page, and footnoted with the file they live in.

- **Each seat is listed in words and with its state**, from the dry run of that very list (`from: 'machine'`). A list the dry run has not caught up with yet — the moment after a reorder — reads *Checking…* rather than lend one seat's words to another.
- **A seat is chosen in words**: a runtime this desk has added, one of its models or *Its default*, one of that model's efforts or *Its default*, and thinking where the model has the switch — never a spec typed into a field. It is appended; the order is changed with *Move up* and *Move down*; the last seat removed, or *Clear*, gives the Agent its own list back.
- **An entry that does not read is shown where it is**, with where and why; seating it here is refused until it reads (Task 6). A file that is not JSON cannot be edited from here at all, because the verb never writes over it — *Add a seat…* is greyed with that reason.
- **The fix for a seat its runtime cannot give** — a model or effort that runtime does not offer (`seats`, Task 1) — is *Edit seats for this Mac*, and on this page it opens the same dialog, rather than a link back to where the person already is.

**Files:**
- Modify: `packages/ui/src/components/AgentPage.tsx` (`MachineSeats`, `AddSeatDialog`; the seats fix), `packages/ui/src/state/snapshot.ts` (`seating`), `packages/ui/src/state/store.ts` (`loadSeating`, `setSeating`, the re-read on `agent/changed`), `packages/ui/src/lib/agents.ts` (`sameSeat`)
- Modify: `packages/ui/src/preview/main.tsx` (this Mac's seats), `script/check-reachable.mjs` (unpin `agent/seating/read`, `agent/seating/set`)
- Test: `packages/ui/src/components/AgentPage.test.tsx`, `packages/ui/src/state/store.agents.test.ts`, `packages/ui/src/lib/agents.test.ts`

**Interfaces:**
- Consumes: `agent/seating/read`, `agent/seating/set` and `MachineSeating` (Task 6); `SEAT_PREFERENCE_LIMIT`; `store.modelsFor(runtime)`.
- Produces: `AppSnapshot.seating: MachineSeating | null`; `AppStore.loadSeating(): Promise<void>`; `AppStore.setSeating(id: string, seats: readonly FlowSeat[] | null): Promise<void>` (throws the host's refusal); `sameSeat(a: FlowSeat, b: FlowSeat): boolean` (`lib/agents.ts`).

- [ ] **Step 1: Write the failing tests**

1. Append to `packages/ui/src/lib/agents.test.ts` (add `sameSeat` to its import):

```ts
it('knows one seat from another by everything it asks for', () => {
  expect(sameSeat({ runtime: 'codex' }, { runtime: 'codex', model: null })).toBe(true)
  expect(sameSeat({ runtime: 'codex', effort: 'high' }, { runtime: 'codex' })).toBe(false)
  expect(sameSeat({ runtime: 'cursor', thinking: true }, { runtime: 'cursor', thinking: false })).toBe(false)
})
```

2. Append to `packages/ui/src/state/store.agents.test.ts`:

```ts
it("reads this Mac's seats when asked, keeps what setting them answers, and reads them again when they change", async () => {
  const seating = { path: '/u/.harnessdesk/seating.json', entries: [{ id: 'code-reviewer', seats: [{ runtime: 'codex' }] }], problems: [] }
  answering({ 'agent/seating/read': () => seating, 'agent/seating/set': () => ({ ...seating, entries: [] }) })
  expect(store.getSnapshot().seating).toBeNull()
  await store.loadSeating()
  expect(store.getSnapshot().seating).toEqual(seating)
  await store.setSeating('code-reviewer', null)
  expect(asked.find((one) => one.method === 'agent/seating/set')?.params).toEqual({ id: 'code-reviewer', seats: null })
  expect(store.getSnapshot().seating?.entries).toEqual([])
  asked.length = 0
  handlers().onNotification({ method: 'agent/changed', params: { project: null } })
  await vi.waitFor(() => expect(asked.some((one) => one.method === 'agent/seating/read')).toBe(true))
})
```

3. In `packages/ui/src/components/AgentPage.test.tsx`:
   - Import `type MachineSeating` and `type ModelInfo` from `@harnessdesk/protocol`.
   - Give *Code reviewer* two seats on this Mac, weighed — replace the `code-reviewer` plan's `candidates` with `[candidate('codex', 'Codex · GPT-5.6 Sol', 'taken'), candidate('claude-code', 'Claude', 'untried')]` — and give *Scout* a seat its runtime cannot give, before the one it takes — replace the `scout` plan with:

```ts
  [
    'scout',
    {
      id: 'scout',
      from: 'prefer',
      winner: 1,
      blocked: null,
      candidates: [
        candidate('claude-code', 'Claude · Opus 9', 'passed', { reason: { kind: 'noModel', model: 'opus-9' }, fix: { kind: 'seats' } }),
        candidate('claude-code', 'Claude', 'taken'),
      ],
    },
  ],
```

   - Add, after `COPY`:

```ts
const SEATING: MachineSeating = {
  path: '/Users/dev/.harnessdesk/seating.json',
  entries: [{ id: 'code-reviewer', seats: [{ runtime: 'codex' }, { runtime: 'claude-code' }] }],
  problems: [],
}

const MODELS: readonly ModelInfo[] = [
  { id: 'opus-5', displayName: 'Opus 5', reasoningLevels: [{ id: 'high', label: 'High' }], supportsImages: false },
]
```

   - Change `mount`'s parameter to `({ seating = SEATING, ...props }: { readonly focus?: string; readonly seating?: MachineSeating } = {})`, add `seating,` to its snapshot, and add to its store `loadSeating: vi.fn(async () => {}),`, `setSeating: vi.fn(async () => {}),` and `modelsFor: vi.fn(async () => MODELS),`.
   - Append:

```tsx
const section = (label: string): string => container.querySelector(`section[aria-label="${label}"]`)?.textContent ?? ''
const labelled = (label: string): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`),
]
const choose = (label: string, value: string): void => {
  const tag = [...document.body.querySelectorAll('label')].find((one) => one.textContent === label)
  const select = tag ? document.getElementById(tag.htmlFor) : null
  if (!(select instanceof HTMLSelectElement)) throw new Error(`no field labelled ${label}`)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('lists this Mac’s seats in order, each with its state here, and names the file they live in', () => {
  const { store } = mount({ focus: 'code-reviewer' })
  expect(store.loadSeating).toHaveBeenCalled()
  const here = section('On this Mac')
  expect(here.indexOf('Codex · GPT-5.6 Sol')).toBeLessThan(here.indexOf('Claude'))
  expect(here).toContain('The seat it takes here')
  expect(here).toContain('Not reached: a seat before it is free')
  expect(here).toContain('~/.harnessdesk/seating.json')
})

it('a seat moves, or goes, and Clear gives the Agent its own list back', () => {
  const { store } = mount({ focus: 'code-reviewer' })
  act(() => labelled('Move down')[0]!.click())
  expect(store.setSeating).toHaveBeenLastCalledWith('code-reviewer', [{ runtime: 'claude-code' }, { runtime: 'codex' }])
  act(() => labelled('Remove this seat')[1]!.click())
  expect(store.setSeating).toHaveBeenLastCalledWith('code-reviewer', [{ runtime: 'codex' }])
  act(() => button('Clear').click())
  expect(store.setSeating).toHaveBeenLastCalledWith('code-reviewer', null)
})

it('the last seat removed gives the Agent its own list back too', () => {
  const { store } = mount({
    focus: 'code-reviewer',
    seating: { ...SEATING, entries: [{ id: 'code-reviewer', seats: [{ runtime: 'codex' }] }] },
  })
  act(() => labelled('Remove this seat')[0]!.click())
  expect(store.setSeating).toHaveBeenLastCalledWith('code-reviewer', null)
})

it('adds a seat chosen in words to the end of this Mac’s list', async () => {
  const { store } = mount({ focus: 'judge' })
  expect(section('On this Mac')).toContain('Its own seats apply here')
  act(() => button('Add a seat…').click())
  await settle()
  expect(store.modelsFor).toHaveBeenCalledWith('claude-code')
  choose('Model', 'opus-5')
  choose('Effort', 'high')
  act(() => button('Add seat').click())
  await settle()
  expect(store.setSeating).toHaveBeenCalledWith('judge', [{ runtime: 'claude-code', model: 'opus-5', effort: 'high' }])
})

it('an entry this Mac cannot read says where and why; a file that will not read is not written over from here', () => {
  mount({
    focus: 'judge',
    seating: {
      ...SEATING,
      entries: [],
      problems: [{ id: 'judge', at: '[1]', text: '"+fast" is not a switch a seat takes — the only one is +thinking' }],
    },
  })
  expect(section('On this Mac')).toContain('"+fast" is not a switch a seat takes')
  expect(section('On this Mac')).toContain('At [1] in its entry')
  expect(button('Add a seat…').disabled).toBe(false)

  mount({ focus: 'judge', seating: { ...SEATING, entries: [], problems: [{ id: null, at: '', text: 'it is not JSON' }] } })
  expect(section('On this Mac')).toContain('it is not JSON')
  expect(button('Add a seat…').disabled).toBe(true)
})

it('a seat its runtime cannot give is fixed on this page, by a seat for this Mac', async () => {
  mount({ focus: 'scout' })
  expect(section('Seats')).toContain('Claude does not offer this model')
  act(() => button('Edit seats for this Mac').click())
  await settle()
  expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('A seat for Scout on this Mac')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/agents.test.ts src/state/store.agents.test.ts src/components/AgentPage.test.tsx`
Expected: FAIL — `sameSeat is not a function`, `store.loadSeating is not a function`, and the six new page tests: `expected '' to contain 'Codex · GPT-5.6 Sol'`, `no button reading “Add a seat…”`, `no button reading “Edit seats for this Mac”`.

- [ ] **Step 3: Hold this Mac's seats in the store**

1. In `packages/ui/src/state/snapshot.ts`, import `type MachineSeating`, add after `agentPlans`:

```ts
  /** This machine's seats for its Agents, as the host read `seating.json` — null until a page asks. */
  readonly seating: MachineSeating | null
```

   and `seating: null,` to `EMPTY`.
2. In `packages/ui/src/state/store.ts`, import `type FlowSeat`, and add after `trashAgent`:

```ts
  /** This machine's seats for its Agents — `seating.json` — as the host reads it. */
  async loadSeating(): Promise<void> {
    try {
      this.#patch({ seating: await this.transport.request('agent/seating/read', {}) })
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  /**
   * Sets one Agent's seats on this machine, or clears them (`null`) so its own
   * list applies again. Throws the host's refusal — a file that cannot be read
   * is never written over — for the surface that asked to say why.
   */
  async setSeating(id: string, seats: readonly FlowSeat[] | null): Promise<void> {
    this.#patch({ seating: await this.transport.request('agent/seating/set', { id, seats }) })
  }
```

3. In the `agent/changed` block (Task 12), after the roster's re-read, add:

```ts
          // This Mac's seats may be what changed; read them again only where a page has read them.
          if (this.#snapshot.seating !== null) void this.loadSeating()
```

4. Append to `packages/ui/src/lib/agents.ts` (add `FlowSeat` to its protocol import):

```ts
/** Whether two seats ask for the same thing: runtime, model, effort and thinking, an absent one the same as none. */
export const sameSeat = (a: FlowSeat, b: FlowSeat): boolean =>
  a.runtime === b.runtime &&
  (a.model ?? null) === (b.model ?? null) &&
  (a.effort ?? null) === (b.effort ?? null) &&
  Boolean(a.thinking) === Boolean(b.thinking)
```

- [ ] **Step 4: The section and its dialog**

In `packages/ui/src/components/AgentPage.tsx`:

1. Change the React import to `import { useEffect, useState } from 'react'`; import `SEAT_PREFERENCE_LIMIT`, `type FlowSeat`, `type ModelInfo` and `type RuntimeId` from `@harnessdesk/protocol` (keeping the type-only ones as `type`); add `sameSeat` to the `../lib/agents` import; add `CrossIcon`, `MoveDownIcon`, `MoveUpIcon` and `PlusIcon` beside `BriefIcon`; and add `Field`, `FormStack`, `NativeSelect` and `Switch` to the design import.
2. In `AgentPage`, add `const [adding, setAdding] = useState(false)` beside the other state, replace `<OwnSeats entry={entry} />` with:

```tsx
          <OwnSeats entry={entry} onEditSeats={() => setAdding(true)} />
          <MachineSeats entry={entry} onAdd={() => setAdding(true)} />
```

   and, beside the customize dialog:

```tsx
      {adding && definition && (
        <AddSeatDialog
          entry={entry}
          current={snapshot.seating?.entries.find((one) => one.id === entry.id)?.seats ?? []}
          onClose={() => setAdding(false)}
        />
      )}
```

3. Add, after `SeatRow`:

```tsx
/**
 * On this Mac: the seats this machine gives the Agent, which replace its own
 * list here and are never committed. Added to, reordered or cleared here, and
 * footnoted with the file they live in. An entry this Mac cannot read is shown
 * where it is, with why — never dropped, and never quietly replaced by the
 * list it replaced.
 */
const MachineSeats = ({ entry, onAdd }: { readonly entry: AgentEntry; readonly onAdd: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    void store.loadSeating()
  }, [store])

  const seating = snapshot.seating
  const mine = seating?.entries.find((one) => one.id === entry.id)
  const troubles = seating?.problems.filter((one) => one.id === entry.id || one.id === null) ?? []
  const unreadable = troubles.some((one) => one.id === null)
  const full = (mine?.seats.length ?? 0) >= SEAT_PREFERENCE_LIMIT
  const plan = snapshot.agentPlans.get(entry.id)
  /* The words and the states are the dry run's of this very list. Until it
     has caught up — the moment after a reorder — a row reads "Checking…"
     rather than borrow the words of the seat that used to be there. */
  const weighed =
    plan?.from === 'machine' &&
    mine &&
    plan.candidates.length === mine.seats.length &&
    plan.candidates.every((one, index) => sameSeat(one.seat, mine.seats[index]!))
      ? plan.candidates
      : null

  const set = (seats: readonly FlowSeat[] | null): void => {
    setProblem(null)
    store.setSeating(entry.id, seats).catch((error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'This Mac’s seats were not saved.')
    })
  }
  const move = (from: number, to: number): void => {
    if (!mine) return
    const next = [...mine.seats]
    const [seat] = next.splice(from, 1)
    if (seat) next.splice(to, 0, seat)
    set(next)
  }
  const remove = (index: number): void => {
    if (!mine) return
    const next = mine.seats.filter((_, at) => at !== index)
    // The last seat gone is no list at all: its own applies again, rather than an empty one refusing every seating.
    set(next.length > 0 ? next : null)
  }

  return (
    <section aria-label="On this Mac">
      <SectionHead
        name="On this Mac"
        action={
          <span className={styles.actions}>
            {mine && (
              <Button size="sm" variant="ghost" disabled={unreadable} onClick={() => set(null)}>
                Clear
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={unreadable || full}
              title={
                unreadable
                  ? 'The file cannot be read, so nothing here writes to it — fix it by hand first.'
                  : full
                    ? `An Agent names at most ${SEAT_PREFERENCE_LIMIT} seats.`
                    : undefined
              }
              onClick={onAdd}
            >
              <PlusIcon size={14} />
              Add a seat…
            </Button>
          </span>
        }
      />
      <Rows>
        {troubles.map((one) => (
          <Row
            key={`${one.id ?? 'file'}-${one.at}`}
            title={one.text}
            desc={
              one.id === null
                ? 'The whole file cannot be read: fix it by hand. Nothing here writes over it.'
                : `${one.at ? `At ${one.at} in its entry` : 'Its entry'}: seating it here is refused until it reads.`
            }
          />
        ))}
        {!mine && troubles.length === 0 && (
          <Row
            title="Its own seats apply here"
            desc="Seats added here replace its own list on this Mac. They are not added to it."
          />
        )}
        {mine?.seats.map((seat, index) => {
          const candidate = weighed?.[index]
          return (
            <Row
              key={`${index}-${seat.runtime}-${seat.model ?? ''}-${seat.effort ?? ''}`}
              {...(candidate ? { mark: <RuntimeMark runtime={markFor(candidate, snapshot.runtimes)} size={16} /> } : {})}
              title={candidate?.label ?? 'Checking…'}
              {...(candidate ? { desc: stateWords(candidate) } : {})}
              control={
                <span className={styles.actions}>
                  <Button size="icon-sm" variant="ghost" aria-label="Move up" title="Move up" disabled={index === 0} onClick={() => move(index, index - 1)}>
                    <MoveUpIcon size={14} />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Move down"
                    title="Move down"
                    disabled={index === mine.seats.length - 1}
                    onClick={() => move(index, index + 1)}
                  >
                    <MoveDownIcon size={14} />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label="Remove this seat" title="Remove this seat" onClick={() => remove(index)}>
                    <CrossIcon size={13} />
                  </Button>
                </span>
              }
            />
          )
        })}
      </Rows>
      <Note>
        {`Kept in ${seating ? shortPath(seating.path, snapshot.home) : 'seating.json'}, on this Mac only — never committed.`}
      </Note>
      {problem && <Note tone="bad">{problem}</Note>}
    </section>
  )
}

/**
 * One seat for this Mac, chosen in words: a runtime this desk has added, one
 * of its models or its default, one of that model's efforts or its default,
 * and thinking where the model has the switch. Appended to the list.
 */
const AddSeatDialog = ({
  entry,
  current,
  onClose,
}: {
  readonly entry: AgentEntry
  readonly current: readonly FlowSeat[]
  readonly onClose: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [runtime, setRuntime] = useState<string>(snapshot.runtimes[0]?.id ?? '')
  const [models, setModels] = useState<readonly ModelInfo[] | null>(null)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [thinking, setThinking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (!runtime) return
    let live = true
    setModels(null)
    setModel('')
    setEffort('')
    setThinking(false)
    void store.modelsFor(runtime as RuntimeId).then((list) => {
      if (live) setModels(list.filter((one) => !one.hidden))
    })
    return () => {
      live = false
    }
  }, [runtime, store])

  // Its efforts and its switch are the chosen model's — or, for its default, the model it defaults to.
  const shape = models?.find((one) => (model ? one.id === model : one.isDefault)) ?? null

  const add = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    const seat: FlowSeat = {
      runtime,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(thinking ? { thinking: true } : {}),
    }
    try {
      await store.setSeating(entry.id, [...current, seat])
      onClose()
    } catch (error) {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'The seat was not saved.')
    }
  }

  return (
    <Dialog
      title={`A seat for ${agentName(entry)} on this Mac`}
      icon={<BriefIcon size={15} />}
      onClose={onClose}
      footer={
        <>
          <Button variant="default" disabled={busy || !runtime || models === null} onClick={() => void add()}>
            {busy ? 'Adding…' : 'Add seat'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <FormStack>
        {current.length === 0 && <Note>Seats here replace its own list on this Mac. They are not added to it.</Note>}
        <Field label="Runtime">
          {(control) => (
            <NativeSelect {...control} value={runtime} onChange={(event) => setRuntime(event.target.value)}>
              {snapshot.runtimes.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.presentation.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Model" {...(models === null ? { hint: 'Asking the runtime…' } : {})}>
          {(control) => (
            <NativeSelect
              {...control}
              value={model}
              disabled={models === null}
              onChange={(event) => {
                setModel(event.target.value)
                setEffort('')
                setThinking(false)
              }}
            >
              <option value="">Its default</option>
              {(models ?? []).map((one) => (
                <option key={one.id} value={one.id}>
                  {one.displayName}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        {shape && shape.reasoningLevels.length > 0 && (
          <Field label="Effort">
            {(control) => (
              <NativeSelect {...control} value={effort} onChange={(event) => setEffort(event.target.value)}>
                <option value="">Its default</option>
                {shape.reasoningLevels.map((level) => (
                  <option key={level.id} value={level.id}>
                    {level.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        )}
        {shape?.thinking === 'optional' && (
          <Field label="Thinking">{(control) => <Switch {...control} checked={thinking} onCheckedChange={setThinking} />}</Field>
        )}
        {problem && <Note tone="bad">{problem}</Note>}
      </FormStack>
    </Dialog>
  )
}
```

- [ ] **Step 5: The preview, and the verbs**

1. In `packages/ui/src/preview/main.tsx`, import `type MachineSeating`, and add to the `PreviewStore` snapshot:

```ts
      seating: {
        path: '/home/u/.harnessdesk/seating.json',
        entries: [{ id: 'code-reviewer', seats: [{ runtime: 'claude', model: 'opus', effort: 'high' }] }],
        problems: [],
      } satisfies MachineSeating,
```

   — the entry Task 15's *Code reviewer* plan already weighs, so its page's *On this Mac* reads *Beta · Opus · High* — and, beside `agentCatalog`, a model list for the dialog to offer (import `type ModelInfo`):

```ts
  modelsFor = async (): Promise<readonly ModelInfo[]> => [
    { id: 'opus', displayName: 'Opus', reasoningLevels: [{ id: 'high', label: 'High' }], supportsImages: false },
  ]
```

2. In `script/check-reachable.mjs`, delete the `'agent/seating/read'` and `'agent/seating/set'` entries from `UNREACHED`.

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/agents.test.ts src/state/store.agents.test.ts src/components/AgentPage.test.tsx && node script/check-reachable.mjs`
Expected: PASS — `AgentPage.test.tsx` 16 tests (10 + 6); `… 4 pinned as not.`

- [ ] **Step 7: Look at it**

In the preview's *an Agent's page* frame: *On this Mac* lists *Beta · Opus · High* with *The seat it takes here*, *Move up* greyed, and the footnote *Kept in ~/.harnessdesk/seating.json…*; *Add a seat…* opens the dialog on the first runtime, and *Clear* sits beside it. Both themes.

- [ ] **Step 8: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/ui/src script/check-reachable.mjs
git commit -m "feat(agents): an Agent's seats on this Mac, edited on its page

On this Mac lists the seats this machine gives an Agent — which replace its
own list here and are never committed — each in words with its state, from the
dry run of that very list. A seat is chosen by runtime, model, effort and
thinking, never typed as a spec; it moves up or down or goes, and Clear gives
the Agent its own list back. An entry that does not read is shown with where
and why, and a file that is not JSON is never written over from here. A seat
its runtime cannot give is fixed on the same page, by a seat for this Mac.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 17: Workspaces › a project

A page per project, for what belongs to the project rather than to this Mac or to the app. It starts with the project's own Agents — the ones in its checkout, committed with its code; later phases add its checks, flows, triggers and provenance. Two doors open it: each folder row on Settings › Workspaces, and a new *Project settings* item in the sidebar's project menu (`WorkspaceMenu.tsx`), which asks Settings to open on that project (`askSettings('workspaces', root)`).

Decisions:

- **Every folder row drills**, repository or not: a folder that is not a repository can still hold `.harnessdesk/agents`, and the host reads it the same way. A row that is a button cannot hold buttons, so *Open* and *Forget* move from the row onto the project's page, and the row keeps only the *Current* chip.
- **A project is read for itself** (`store.agentsIn(root)`), whether or not the window has it open — the host reads a project's Agents from the top of its checkout either way (Task 12). Only the open project's Agents are ways into their pages, because Settings › Agents is the open project's roster; another project's page says so, and offers *Open*.
- **Paths from home**, like every other path on screen (`shortPath`), which the Workspaces list now does too.

**Files:**
- Create: `packages/ui/src/components/ProjectPage.tsx`
- Modify: `packages/ui/src/components/Settings.tsx` (`WorkspacesSection` exported, its rows drill, `focus`), `packages/ui/src/components/WorkspaceMenu.tsx` (*Project settings*), `packages/ui/src/state/store.ts` (`agentsIn`)
- Modify: `packages/ui/src/preview/main.tsx` (`agentsIn`; a frame for the page)
- Test: `packages/ui/src/components/ProjectPage.test.tsx` (new), `packages/ui/src/app/settings-routes.test.ts` (the page is a door to the roster)

**Interfaces:**
- Consumes: `agent/list` (for a project other than the roster's), `askSettings(section, focus)` (Task 14), `ceilingWords`, `projectName`, `agentName` (Task 12).
- Produces: `AppStore.agentsIn(project: string): Promise<readonly AgentEntry[]>` (throws); `ProjectPage({ root, onBack })`; `WorkspacesSection({ focus?: string | null })`, exported.

- [ ] **Step 1: Write the failing tests**

1. Create `packages/ui/src/components/ProjectPage.test.tsx`:

```tsx
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, WorkspaceEntry } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { WorkspacesSection } from './Settings'
import { WorkspaceMenu } from './WorkspaceMenu'

/**
 * Workspaces › a project: the project's own Agents, reached from its folder
 * row and from the sidebar's project menu.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const STOREFRONT: WorkspaceEntry = {
  path: '/Users/dev/work/storefront',
  name: 'storefront',
  lastOpenedAt: 3,
  repo: { root: '/Users/dev/work/storefront', worktree: false },
}
const DOCS: WorkspaceEntry = { path: '/Users/dev/work/docs', name: 'docs', lastOpenedAt: 2 }
const SCRATCH: WorkspaceEntry = { path: '/Users/dev/work/scratch', name: 'scratch', lastOpenedAt: 1 }

const agent = (id: string, name: string, origin: AgentEntry['origin'], folder: string): AgentEntry => ({
  id,
  origin,
  path: `${folder}/${id}/AGENT.md`,
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id,
    name,
    description: `${name} does the work.`,
    permission: 'read',
    answers: [],
    produces: [],
    skills: [],
    prefer: [{ runtime: 'claude-code' }],
    brief: 'Work.',
  },
})

const JUDGE = agent('judge', 'Judge', 'builtin', '/app/agents')
const AGENTS: Readonly<Record<string, readonly AgentEntry[]>> = {
  [STOREFRONT.path]: [agent('code-reviewer', 'Code reviewer', 'project', `${STOREFRONT.path}/.harnessdesk/agents`), JUDGE],
  [DOCS.path]: [agent('editor', 'Docs editor', 'project', `${DOCS.path}/.harnessdesk/agents`), JUDGE],
  [SCRATCH.path]: [JUDGE],
}

const mount = (node: React.ReactNode) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    home: '/Users/dev',
    workspace: STOREFRONT,
    workspaces: [STOREFRONT, DOCS, SCRATCH],
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadWorktrees: vi.fn(async () => {}),
    agentsIn: vi.fn(async (path: string) => AGENTS[path] ?? []),
    openWorkspace: vi.fn(async () => {}),
    forgetWorkspace: vi.fn(async () => {}),
    askSettings: vi.fn(),
    startSessionIn: vi.fn(async () => {}),
  } as unknown as AppStore
  act(() => {
    root.render(<StoreProvider store={store}>{node}</StoreProvider>)
  })
  return store
}

const settle = () => act(async () => {})
const button = (label: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no button reading “${label}”`)
  return found
}
const rowFor = (name: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((one) => one.textContent?.startsWith(name))
  if (!found) throw new Error(`no row for ${name}`)
  return found
}
const agentsText = (): string => container.querySelector('section[aria-label="Agents"]')?.textContent ?? ''

it('each folder opens its project’s page, which lists the project’s own Agents and the folder they are read from', async () => {
  const store = mount(<WorkspacesSection />)
  expect(container.textContent).toContain('~/work/docs')
  act(() => rowFor('storefront').click())
  await settle()
  expect(store.agentsIn).toHaveBeenCalledWith(STOREFRONT.path)
  expect(button('Workspaces')).toBeDefined()
  const text = agentsText()
  expect(text).toContain('Code reviewer')
  expect(text).toContain('Read · asked')
  expect(text).toContain('~/work/storefront/.harnessdesk/agents')
  // Only its own: what ships and what is yours are not the project's.
  expect(text).not.toContain('Judge')
})

it('the open project’s Agents open their pages', async () => {
  const store = mount(<WorkspacesSection focus={STOREFRONT.path} />)
  await settle()
  act(() => rowFor('Code reviewer').click())
  expect(store.askSettings).toHaveBeenCalledWith('agents', 'code-reviewer')
})

it('a project not open says how to reach its Agents, and is opened or forgotten from its page', async () => {
  const store = mount(<WorkspacesSection focus={DOCS.path} />)
  await settle()
  expect(agentsText()).toContain('Docs editor')
  expect(container.querySelectorAll('section[aria-label="Agents"] button')).toHaveLength(0)
  expect(container.textContent).toContain('Open this project to start its Agents')
  act(() => button('Open').click())
  expect(store.openWorkspace).toHaveBeenCalledWith(DOCS.path)
  act(() => button('Forget').click())
  expect(store.forgetWorkspace).toHaveBeenCalledWith(DOCS.path)
})

it('a project with no Agents of its own says how to give it one', async () => {
  mount(<WorkspacesSection focus={SCRATCH.path} />)
  await settle()
  expect(agentsText()).toContain('No Agents of its own')
})

it('the sidebar’s project menu opens the project’s page', () => {
  const store = mount(
    <WorkspaceMenu
      group={{ root: STOREFRONT.path, name: 'storefront', sessions: [], updatedAt: 0 }}
      at={{ x: 10, y: 10 }}
      onClose={() => {}}
      onNewWorktree={() => {}}
    />,
  )
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (one) => one.textContent?.startsWith('Project settings'),
  )
  if (!item) throw new Error('no Project settings item')
  act(() => item.click())
  expect(store.askSettings).toHaveBeenCalledWith('workspaces', STOREFRONT.path)
})
```

2. In `packages/ui/src/app/settings-routes.test.ts`, add to `ROSTER_DOORS`:

```ts
  // A project's page: its own Agents, each a way into its page on the roster.
  'components/ProjectPage.tsx',
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/ProjectPage.test.tsx`
Expected: FAIL — `WorkspacesSection` is not exported (`is not a function` when rendered), and `no Project settings item`.

- [ ] **Step 3: Read one project's Agents**

In `packages/ui/src/state/store.ts`, add after `loadAgentPlans`:

```ts
  /**
   * One project's roster, read for that project rather than the open one —
   * its own Agents, then this machine's and the shipped ones — for its page
   * on Workspaces. Leaves the snapshot's roster alone. Throws the host's
   * refusal, for the page to say.
   */
  async agentsIn(project: string): Promise<readonly AgentEntry[]> {
    return this.transport.request('agent/list', { project })
  }
```

- [ ] **Step 4: The page**

Create `packages/ui/src/components/ProjectPage.tsx`:

```tsx
import { useEffect, useState } from 'react'

import type { AgentEntry } from '@harnessdesk/protocol'

import { agentName, ceilingWords, projectName } from '../lib/agents'
import { shortPath } from '../lib/paths'
import { useSnapshot, useStore } from '../state/context'
import { FolderIcon } from './Icons'
import {
  BackLink,
  Button,
  Chip,
  DetailHead,
  DetailMark,
  Note,
  Row,
  RowButton,
  RowValue,
  Rows,
  SectionHead,
} from '../design'

/**
 * Workspaces › a project: what belongs to one project rather than to this
 * Mac or to the app.
 *
 * It starts with the project's own Agents — the ones in its checkout,
 * committed with its code, which come first in this project over yours and
 * the ones that ship — and is where the project's checks, flows, triggers and
 * provenance will live as they arrive. It is read for the project it is
 * about, open or not; only the open project's Agents are ways into their
 * pages, because Settings › Agents is the open project's roster.
 */
export const ProjectPage = ({ root, onBack }: { readonly root: string; readonly onBack: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [agents, setAgents] = useState<readonly AgentEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const listed = snapshot.workspaces.find((one) => one.path === root) ?? null
  const current = snapshot.workspace?.path === root
  const name = listed ? (projectName(listed) ?? listed.name) : (root.split('/').filter(Boolean).at(-1) ?? root)

  useEffect(() => {
    let live = true
    setProblem(null)
    store.agentsIn(root).then(
      (list) => {
        if (live) setAgents(list.filter((one) => one.origin === 'project'))
      },
      (error: unknown) => {
        if (live) setProblem(error instanceof Error ? error.message : 'Its Agents could not be read.')
      },
    )
    return () => {
      live = false
    }
    // The roster moving under any of its roots (`agent/changed`) is a reason to read again.
  }, [store, root, snapshot.agents])

  // Where the host reads them: the top of the checkout, which the first one found names exactly.
  const folder = agents?.[0]
    ? agents[0].path.split('/').slice(0, -2).join('/')
    : `${listed?.repo && !listed.repo.worktree ? listed.repo.root : root}/.harnessdesk/agents`

  return (
    <>
      <BackLink to="Workspaces" onClick={onBack} />
      <DetailHead
        mark={
          <DetailMark>
            <FolderIcon size={22} />
          </DetailMark>
        }
        name={name}
        owner={shortPath(root, snapshot.home)}
        actions={
          current ? (
            <Chip state="ready" label="Current" />
          ) : (
            <>
              <Button variant="outline" onClick={() => void store.openWorkspace(root)}>
                Open
              </Button>
              {listed && (
                <Button
                  variant="ghost"
                  title="Drop it from the list. The folder is untouched."
                  onClick={() => {
                    void store.forgetWorkspace(root)
                    onBack()
                  }}
                >
                  Forget
                </Button>
              )}
            </>
          )
        }
      />

      <section aria-label="Agents">
        <SectionHead name="Agents" />
        <Note>
          {`Its own, read from ${shortPath(folder, snapshot.home)} and committed with its code. In this project they come first, over yours and the ones that ship.`}
        </Note>
        <Rows>
          {problem && <Row title={problem} />}
          {!problem && agents === null && <Row title="Reading…" />}
          {agents?.length === 0 && (
            <Row
              title="No Agents of its own"
              desc="Save one from a conversation with Save as an Agent…, or copy one here with Customize… on its page."
            />
          )}
          {agents?.map((entry) => {
            const broken = entry.problems.find((one) => one.level === 'error')
            const words = {
              title: agentName(entry),
              ...(entry.definition?.description
                ? { desc: entry.definition.description }
                : broken
                  ? { desc: `${broken.at} — ${broken.text}` }
                  : {}),
              control: entry.definition ? (
                <RowValue>{ceilingWords(entry.definition.permission)}</RowValue>
              ) : (
                <Chip state="broken" label="Will not parse" />
              ),
            }
            return current ? (
              <RowButton key={entry.id} {...words} onClick={() => store.askSettings('agents', entry.id)} />
            ) : (
              <Row key={entry.id} {...words} />
            )
          })}
        </Rows>
        {!current && agents && agents.length > 0 && (
          <Note>Open this project to start its Agents, or to see each one’s page.</Note>
        )}
      </section>
    </>
  )
}
```

- [ ] **Step 5: Its two doors**

1. In `packages/ui/src/components/Settings.tsx`, import `ProjectPage` from `./ProjectPage` and `shortPath` from `../lib/paths`, and replace `WorkspacesSection` with:

```tsx
/**
 * Every folder HarnessDesk has opened, each a way into its project's page —
 * and Settings opened on a project (`focus`, from the sidebar's project menu)
 * goes straight there. Open and Forget are on the page: a row that opens
 * something cannot also hold buttons.
 */
export const WorkspacesSection = ({ focus = null }: { readonly focus?: string | null }) => {
  const snapshot = useSnapshot()
  const [open, setOpen] = useState<string | null>(focus)
  useEffect(() => {
    if (focus) setOpen(focus)
  }, [focus])

  if (open) return <ProjectPage key={open} root={open} onBack={() => setOpen(null)} />

  return (
    <>
      <PageHead
        title="Workspaces"
        blurb="Every folder HarnessDesk has opened, and each project’s own page. Forgetting one touches nothing on disk."
      />

      <SectionHead name={withCount('Folders', snapshot.workspaces.length)} />
      <Rows>
        {snapshot.workspaces.length === 0 && (
          <Row title="No folders opened yet" desc="Open one from File › Open Folder, or ⌘O." />
        )}
        {snapshot.workspaces.map((workspace) => (
          <RowButton
            key={workspace.path}
            mark={<FolderIcon size={15} />}
            title={workspace.name}
            desc={shortPath(workspace.path, snapshot.home)}
            {...(workspace.path === snapshot.workspace?.path
              ? { control: <Chip state="ready" label="Current" /> }
              : {})}
            onClick={() => setOpen(workspace.path)}
          />
        ))}
      </Rows>
      <WorktreeRows />
    </>
  )
}
```

   and render it as `{section === 'workspaces' && <WorkspacesSection focus={focus} />}`.
2. In `packages/ui/src/components/WorkspaceMenu.tsx`, import `SettingsIcon` beside the other icons, and add after the *Copy path* item:

```tsx
      <MenuItem
        icon={<SettingsIcon size={14} />}
        label="Project settings"
        title="Its own Agents, on a page of its own."
        onSelect={() => store.askSettings('workspaces', group.root)}
      />
```

- [ ] **Step 6: The preview**

In `packages/ui/src/preview/main.tsx`, import `WorkspacesSection` from `../components/Settings`; add to `PreviewStore`, beside `agentCatalog`:

```ts
  agentsIn = async (): Promise<readonly AgentEntry[]> => PREVIEW_AGENTS
```

   and, below the Agent's page frame:

```tsx
          <Frame title="Settings › Workspaces — a project">
            <div className="max-h-[560px] overflow-y-auto p-4">
              <WorkspacesSection focus={PREVIEW_ROOT} />
            </div>
          </Frame>
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/ProjectPage.test.tsx src/app/settings-routes.test.ts src/components/Settings.route.test.tsx`
Expected: PASS — `ProjectPage.test.tsx` 5 tests.

- [ ] **Step 8: Look at it**

In the preview's *Settings › Workspaces — a project* frame: the project's name, its path from home, *Current*; *Agents* lists *Code reviewer* with *Read · asked* — the preview's one project Agent — under the note naming `.harnessdesk/agents`. Both themes.

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/ui/src
git commit -m "feat(settings): a page per project, starting with its own Agents

Each folder on Settings › Workspaces opens its project's page, and so does
Project settings in the sidebar's project menu. The page lists the project's
own Agents — the ones committed with its code, which come first there — with
the folder they are read from; the open project's are ways into their pages,
and another project's page says to open it. Open and Forget move onto the
page, because a row that opens something cannot hold buttons.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 18: A conversation seated as an Agent

The roadmap's *A conversation seated as an Agent*:

- **Its pane header and its sidebar row lead with the Agent's name.** Seating names the conversation for its Agent (phase 1), so the lead is said once when the title is still that name, and as *Code reviewer · Checkout review* once the conversation has been renamed.
- **The composer shows the seat actually taken, as read back** (`seatLabel`, Task 5): the Agent's name on the runtime's mark, *As Code reviewer, on Claude · Opus 5 · High* in its menu — and it shows even on a desk with one runtime, where the control used to hide.
- **Its name card** gains an *Agent* band: the Agent, its ceiling (*Read · asked*), what it is for, where it came from, the seat it took and every seat passed over with why. Beside it, as a caution, *The brief has changed since this started* once the file's digest has moved on from the one handed over (`briefDigest`), or *Its Agent is not in this project any more*.

The Agent is read for the folder the conversation works in (`agent/read`, which gets its caller here), once per folder and id, and again on `agent/changed`. Until it is read nothing leads — a guess at the name would flash and then change. The record that a conversation was seated at all is the host's, in memory, so none of this survives a restart of the app until phase 4 makes that record durable.

**Files:**
- Create: `packages/ui/src/state/seat-agent.ts` (`useSeatAgent`)
- Modify: `packages/ui/src/lib/agents.ts` (`wordOf`, `ledBy`, `seatAgentKey`, `projectOfAgent`, `seatCautions`, `passedWords`), `packages/ui/src/state/snapshot.ts` (`seatAgents`), `packages/ui/src/state/store.ts` (`readSeatAgent`, the re-read on `agent/changed`)
- Modify: `packages/ui/src/design/patterns/AgentCard.tsx` (the *Agent* band), `packages/ui/src/components/AgentCards.tsx` (both conversation cards fill it), `packages/ui/src/components/Conversation.tsx` (the header), `packages/ui/src/components/SessionTree.tsx` (the row), `packages/ui/src/components/ComposerControls.tsx` (`AgentControl`)
- Modify: `docs/design-system.md` (regenerated), `packages/ui/src/preview/main.tsx` (the preview's conversation is seated as an Agent), `script/check-reachable.mjs` (unpin `agent/read`)
- Test: `packages/ui/src/lib/agents.test.ts`, `packages/ui/src/state/store.agents.test.ts`, `packages/ui/src/design/patterns/AgentCard.test.tsx`, `packages/ui/src/components/AgentCards.test.tsx`, `packages/ui/src/components/Conversation.test.tsx`, `packages/ui/src/components/SessionTree.test.tsx`, `packages/ui/src/components/ComposerControls.agent.test.tsx`

**Interfaces:**
- Consumes: `SessionSettings.agent`, `briefDigest`, `permission` (phase 1), `seatLabel`, `passedOver` (Task 5); `agent/read`.
- Produces:
  - `wordOf(word: string): string`, `ledBy(agent: string | null, title: string): string`, `seatAgentKey(cwd: string, id: string): string`, `projectOfAgent(entry: AgentEntry): string | null`, `seatCautions(entry: AgentEntry | null | undefined, briefDigest: string | undefined): readonly string[]`, `passedWords(candidate: SeatCandidate): string` (`lib/agents.ts`).
  - `AppSnapshot.seatAgents: ReadonlyMap<string, AgentEntry | null>`; `AppStore.readSeatAgent(cwd: string, id: string): void`.
  - `useSeatAgent(session: Session | null | undefined): SeatAgent | null` with `interface SeatAgent { id: string; entry: AgentEntry | null | undefined; name: string | null }` (`state/seat-agent.ts`).
  - `AgentCardSubject.agent?: { name: string; ceiling: string; description?: string | null; origin?: string | null; seat?: string | null; passedOver?: readonly string[] } | null`.

- [ ] **Step 1: Write the failing tests**

1. Append to `packages/ui/src/lib/agents.test.ts` (add `ledBy`, `passedWords`, `projectOfAgent`, `seatCautions` and `wordOf` to its import):

```ts
describe('a conversation seated as an Agent, in words', () => {
  it('leads a title with the Agent, once', () => {
    expect(ledBy('Code reviewer', 'Code reviewer')).toBe('Code reviewer')
    expect(ledBy('Code reviewer', 'Checkout review')).toBe('Code reviewer · Checkout review')
    expect(ledBy(null, 'Checkout review')).toBe('Checkout review')
    expect(wordOf('code-reviewer')).toBe('Code reviewer')
  })

  it('names the project a project Agent lives in, and no other', () => {
    expect(projectOfAgent(entry('a', { origin: 'project', path: '/w/storefront/.harnessdesk/agents/a/AGENT.md' }))).toBe('storefront')
    expect(projectOfAgent(entry('a'))).toBeNull()
  })

  it('warns when the brief has moved on, or the Agent is gone — and says nothing while it is being read', () => {
    expect(seatCautions(undefined, 'd')).toEqual([])
    expect(seatCautions(entry('a'), 'd')).toEqual([])
    expect(seatCautions(entry('a', { digest: 'e' }), 'd')).toEqual(['The brief has changed since this started.'])
    expect(seatCautions(null, 'd')).toEqual(['Its Agent is not in this project any more.'])
  })

  it('says each seat passed over with why', () => {
    expect(passedWords(plan().candidates[0]!)).toBe('Cursor — Cursor is signed out')
  })
})
```

2. Append to `packages/ui/src/state/store.agents.test.ts` (import `seatAgentKey` from `../lib/agents`):

```ts
it('reads the Agent a seated conversation was seated as once, for its folder, and again when the roster moves', async () => {
  answering({ 'agent/read': () => ENTRY })
  store.readSeatAgent('/w/storefront', 'code-reviewer')
  store.readSeatAgent('/w/storefront', 'code-reviewer')
  await vi.waitFor(() =>
    expect(store.getSnapshot().seatAgents.get(seatAgentKey('/w/storefront', 'code-reviewer'))).toEqual(ENTRY),
  )
  expect(asked.filter((one) => one.method === 'agent/read').map((one) => one.params)).toEqual([
    { id: 'code-reviewer', project: '/w/storefront' },
  ])
  handlers().onNotification({ method: 'agent/changed', params: { project: null } })
  await vi.waitFor(() => expect(asked.filter((one) => one.method === 'agent/read')).toHaveLength(2))
})
```

3. Append to `packages/ui/src/design/patterns/AgentCard.test.tsx`:

```tsx
it('draws an Agent band only for a conversation seated as one', () => {
  render({ kind: 'session', name: 'Checkout review', tint: 'blue', mark: <svg /> })
  expect(bands()).toBe(0)
  render({
    kind: 'session',
    name: 'Checkout review',
    tint: 'blue',
    mark: <svg />,
    agent: {
      name: 'Code reviewer',
      ceiling: 'Read · asked',
      description: 'Reviews a change it did not write.',
      origin: 'Built in',
      seat: 'Claude · Opus 5 · High',
      passedOver: ['Cursor — Cursor is signed out'],
    },
  })
  expect(bands()).toBe(1)
  const text = container.textContent ?? ''
  for (const words of ['Code reviewer', 'Read · asked', 'Reviews a change it did not write.', 'Built in', 'Seated on Claude · Opus 5 · High', 'Passed over Cursor — Cursor is signed out']) {
    expect(text).toContain(words)
  }
})
```

4. Append to `packages/ui/src/components/AgentCards.test.tsx` (add `type AgentEntry` and `type Session` to its protocol import, and `import { seatAgentKey } from '../lib/agents'`):

```tsx
it('a conversation seated as an Agent is carded as it, and says when its brief has moved on', () => {
  vi.useFakeTimers()
  const key = sessionKey('claude-code', 'sess-1' as SessionSummary['id'])
  const live = {
    ...SESSION,
    turns: [],
    itemsLoaded: true,
    settings: {
      cwd: '/repo',
      agent: 'code-reviewer',
      briefDigest: 'handed-over',
      permission: 'read',
      seatLabel: 'Claude · Opus 5 · High',
      passedOver: [
        {
          seat: { runtime: 'cursor' },
          label: 'Cursor',
          runtimeName: 'Cursor',
          state: 'passed',
          reason: { kind: 'signedOut' },
          fix: { kind: 'signIn', runtime: 'cursor' },
        },
      ],
    },
  } as unknown as Session
  const entry = {
    id: 'code-reviewer',
    origin: 'builtin',
    path: '/app/agents/code-reviewer/AGENT.md',
    digest: 'edited-since',
    shadows: [],
    problems: [],
    definition: {
      id: 'code-reviewer',
      name: 'Code reviewer',
      description: 'Reviews a change it did not write.',
      permission: 'read',
      answers: [],
      produces: [],
      skills: [],
      prefer: [{ runtime: 'claude-code' }],
      brief: 'Review.',
    },
  } as AgentEntry
  const snapshot = {
    ...emptySnapshot(),
    runtimes: [{ id: 'claude-code', presentation: { name: 'Claude Code' }, capabilities: {} }] as unknown as RuntimeInfo[],
    sessions: new Map([[key, live]]),
    seatAgents: new Map([[seatAgentKey('/repo', 'code-reviewer'), entry]]),
  } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readSeatAgent: vi.fn() } as unknown as AppStore

  act(() =>
    root.render(
      <StoreProvider store={store}>
        <SessionHoverCard session={SESSION}>
          <span>glyph</span>
        </SessionHoverCard>
      </StoreProvider>,
    ),
  )
  rest(trigger())
  const text = openCard()?.textContent ?? ''
  expect(text).toContain('Reviews a change it did not write.')
  expect(text).toContain('Read · asked')
  expect(text).toContain('Built in')
  expect(text).toContain('Seated on Claude · Opus 5 · High')
  expect(text).toContain('Passed over Cursor — Cursor is signed out')
  expect(text).toContain('The brief has changed since this started.')
  expect(store.readSeatAgent).not.toHaveBeenCalled()
  vi.useRealTimers()
})
```

5. In `packages/ui/src/components/Conversation.test.tsx`, give `rig` a third parameter `over: Partial<AppSnapshot> = {}` spread last into its snapshot, add `readSeatAgent: vi.fn(),` to its store, import `seatAgentKey` from `../lib/agents` and `type AgentEntry` from `@harnessdesk/protocol`, and append:

```tsx
it('a conversation seated as an Agent is headed by it — once, while its title is the Agent’s name', () => {
  const settings = { cwd: '/repo', model: 'gpt-5.6-sol', agent: 'code-reviewer', briefDigest: 'd', permission: 'read' as const, seatLabel: 'Codex', passedOver: [] }
  const entry = { id: 'code-reviewer', origin: 'builtin', path: '/app/agents/code-reviewer/AGENT.md', digest: 'd', shadows: [], problems: [], definition: { id: 'code-reviewer', name: 'Code reviewer', permission: 'read', answers: [], produces: [], skills: [], prefer: [], brief: '' } } as AgentEntry
  const over = { seatAgents: new Map([[seatAgentKey('/repo', 'code-reviewer'), entry]]) }
  const header = (): string => container.querySelector('header')?.textContent ?? ''

  render(rig(session({ title: 'Checkout review', settings }), new Map(), over).store)
  expect(header()).toContain('Code reviewer · Checkout review')

  render(rig(session({ title: 'Code reviewer', settings }), new Map(), over).store)
  expect(header()).toContain('Code reviewer')
  expect(header()).not.toContain('Code reviewer · Code reviewer')
})
```

6. Append to `packages/ui/src/components/SessionTree.test.tsx` (import `seatAgentKey` from `../lib/agents` and `type AgentEntry` from `@harnessdesk/protocol`):

```tsx
it('a row seated as an Agent leads with it', () => {
  const runtime = { id: 'agent', name: 'Agent', capabilities: {}, presentation: { name: 'Agent' } } as unknown as RuntimeInfo
  const summary = {
    id: 'session-1',
    runtime: runtime.id,
    title: 'Checkout review',
    preview: null,
    cwd: '/repo',
    status: { type: 'notLoaded' },
    createdAt: 1,
    updatedAt: 2,
  } as unknown as SessionSummary
  const live = {
    ...summary,
    status: { type: 'idle' },
    turns: [],
    itemsLoaded: true,
    settings: { cwd: '/repo', agent: 'code-reviewer', briefDigest: 'd', permission: 'read', seatLabel: 'Agent', passedOver: [] },
  } as unknown as Session
  const entry = { id: 'code-reviewer', origin: 'builtin', path: '/app/agents/code-reviewer/AGENT.md', digest: 'd', shadows: [], problems: [], definition: { id: 'code-reviewer', name: 'Code reviewer', permission: 'read', answers: [], produces: [], skills: [], prefer: [], brief: '' } } as AgentEntry
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
    history: [summary],
    sessions: new Map([[sessionKey(runtime.id, summary.id), live]]),
    seatAgents: new Map([[seatAgentKey('/repo', 'code-reviewer'), entry]]),
  } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readSeatAgent: vi.fn() } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} />
      </StoreProvider>,
    )
  })
  expect([...container.querySelectorAll('button')].some((one) => one.textContent === 'Code reviewer · Checkout review')).toBe(true)
})
```

7. Append to `packages/ui/src/components/ComposerControls.agent.test.tsx` (add `sessionKey`, `type AgentEntry` and `type Session` to its protocol import; import `seatAgentKey` from `../lib/agents`):

```tsx
it('a conversation seated as an Agent shows the Agent and the seat it took — even with one runtime', () => {
  const only = runtime('claude-code', 'Claude Code', 'An agent.')
  const key = sessionKey('claude-code', 's1')
  const live = {
    id: 's1',
    runtime: 'claude-code',
    cwd: '/repo',
    status: { type: 'idle' },
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    itemsLoaded: true,
    settings: { cwd: '/repo', agent: 'code-reviewer', briefDigest: 'd', permission: 'read', seatLabel: 'Claude · Opus 5 · High', passedOver: [] },
  } as unknown as Session
  const entry = { id: 'code-reviewer', origin: 'builtin', path: '/app/agents/code-reviewer/AGENT.md', digest: 'd', shadows: [], problems: [], definition: { id: 'code-reviewer', name: 'Code reviewer', permission: 'read', answers: [], produces: [], skills: [], prefer: [], brief: '' } } as AgentEntry
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [only],
    activeRuntime: only.id,
    sessions: new Map([[key, live]]),
    activeSessionKey: key,
    seatAgents: new Map([[seatAgentKey('/repo', 'code-reviewer'), entry]]),
  }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readSeatAgent: vi.fn() } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <AgentControl />
      </StoreProvider>,
    )
  })
  const trigger = document.querySelector<HTMLButtonElement>('button[title="Seated as Code reviewer on Claude · Opus 5 · High"]')
  expect(trigger?.textContent).toContain('Code reviewer')
  click(trigger!)
  expect(document.body.textContent).toContain('As Code reviewer, on Claude · Opus 5 · High')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/agents.test.ts src/state/store.agents.test.ts src/design/patterns/AgentCard.test.tsx src/components/AgentCards.test.tsx src/components/Conversation.test.tsx src/components/SessionTree.test.tsx src/components/ComposerControls.agent.test.tsx`
Expected: FAIL — `ledBy is not a function` (and its siblings), `store.readSeatAgent is not a function`, `expected 0 to be 1` bands, `expected '…' to contain 'Reviews a change it did not write.'`, `expected '…Checkout review…' to contain 'Code reviewer · Checkout review'`, and a null trigger for the one-runtime composer.

- [ ] **Step 3: The words**

Append to `packages/ui/src/lib/agents.ts`:

```ts
/** A word from an Agent's file — its id, a verdict — as a person reads it: `request-changes` → "Request changes". */
export const wordOf = (word: string): string => {
  const spaced = word.replace(/[-_]+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** A conversation's title led by the Agent it was seated as — said once, where the title already is its name. */
export const ledBy = (agent: string | null, title: string): string =>
  agent === null || title === agent ? title : `${agent} · ${title}`

/** Where the renderer keeps the Agent a seated conversation was seated as: the folder it works in, and the Agent's id. */
export const seatAgentKey = (cwd: string, id: string): string => JSON.stringify([cwd, id])

/** The folder a project Agent lives in, by name — "storefront" — or null for one of yours or one that ships. */
export const projectOfAgent = (entry: AgentEntry): string | null =>
  entry.origin === 'project' ? (entry.path.split('/').slice(0, -4).at(-1) ?? null) : null

/**
 * What a seated conversation's card warns about its Agent: a brief that has
 * moved on since it was handed over, or an Agent no longer there. Nothing
 * while it is still being read.
 */
export const seatCautions = (entry: AgentEntry | null | undefined, briefDigest: string | undefined): readonly string[] => {
  if (entry === undefined) return []
  if (entry === null) return ['Its Agent is not in this project any more.']
  return briefDigest && entry.digest !== null && entry.digest !== briefDigest
    ? ['The brief has changed since this started.']
    : []
}

/** A seat passed over on the way to the one taken, with why. */
export const passedWords = (candidate: SeatCandidate): string =>
  `${candidate.label} — ${candidate.reason ? reasonWords(candidate.reason, candidate.runtimeName) : 'passed over'}`
```

   and replace `wordList`'s body (Task 15) with `words.length === 0 ? 'None' : words.map(wordOf).join(' · ')`, moving it below `wordOf`.

- [ ] **Step 4: Read the Agent a conversation was seated as**

1. In `packages/ui/src/state/snapshot.ts`, add after `seating`:

```ts
  /**
   * The Agent each seated conversation was seated as, read for the folder it
   * works in, by `seatAgentKey(cwd, id)` — what its header, its row and its
   * name card say about it. Null when no Agent by that id is there any more.
   */
  readonly seatAgents: ReadonlyMap<string, AgentEntry | null>
```

   and `seatAgents: new Map(),` to `EMPTY` and to `emptySnapshot()`.
2. In `packages/ui/src/state/store.ts`, import `seatAgentKey` from `../lib/agents`; add a field beside the others: `/** Agent reads in flight, by \`seatAgentKey\`, so one conversation drawn in three places asks once. */ readonly #seatAgentReads = new Set<string>()`; and add after `agentsIn`:

```ts
  /**
   * Reads the Agent a seated conversation was seated as, for the folder it
   * works in — once per folder and id, and again when the roster moves — so
   * its header, its row and its name card can say who it is and whether its
   * brief has moved on. A read that fails leaves nothing: the conversation is
   * drawn as a conversation rather than as a guess.
   */
  readSeatAgent(cwd: string, id: string): void {
    const key = seatAgentKey(cwd, id)
    if (this.#seatAgentReads.has(key)) return
    this.#seatAgentReads.add(key)
    this.transport
      .request('agent/read', { id, project: cwd })
      .then(
        (entry) => this.#patch({ seatAgents: new Map(this.#snapshot.seatAgents).set(key, entry) }),
        () => undefined,
      )
      .finally(() => this.#seatAgentReads.delete(key))
  }
```

3. In the `agent/changed` block, after the seating re-read, add:

```ts
          // Every Agent a conversation was seated as, read again: a brief that moved on says so on its card.
          for (const key of this.#snapshot.seatAgents.keys()) {
            const [cwd, id] = JSON.parse(key) as [string, string]
            this.readSeatAgent(cwd, id)
          }
```

4. Create `packages/ui/src/state/seat-agent.ts`:

```ts
import { useEffect } from 'react'

import type { AgentEntry, Session } from '@harnessdesk/protocol'

import { seatAgentKey, wordOf } from '../lib/agents'
import { useSnapshot, useStore } from './context'

/** The Agent a conversation was seated as. */
export interface SeatAgent {
  /** Its id, as the host recorded it at seating. */
  readonly id: string
  /** Its entry, read for the conversation's folder: undefined while being read, null when no Agent by that id is there now. */
  readonly entry: AgentEntry | null | undefined
  /** What to call it — null while it is being read, so nothing flashes a guess and then changes. */
  readonly name: string | null
}

/**
 * The Agent a conversation was seated as, or null for one that was not —
 * which, until phase 4 makes the host's record durable, is also every
 * conversation after the app restarts.
 */
export const useSeatAgent = (session: Session | null | undefined): SeatAgent | null => {
  const store = useStore()
  const snapshot = useSnapshot()
  const id = session?.settings?.agent ?? null
  const cwd = session?.cwd ?? null
  const key = id && cwd ? seatAgentKey(cwd, id) : null
  const known = key !== null && snapshot.seatAgents.has(key)
  useEffect(() => {
    if (id && cwd && !known) store.readSeatAgent(cwd, id)
  }, [store, id, cwd, known])
  if (!id || !key) return null
  const entry = snapshot.seatAgents.get(key)
  return { id, entry, name: entry === undefined ? null : (entry?.definition?.name ?? wordOf(id)) }
}
```

- [ ] **Step 5: The name card's Agent band**

1. In `packages/ui/src/design/patterns/AgentCard.tsx`:
   - In the lead comment's band list, after *Crest*, add:

```
 *   Agent    who a conversation was seated as, when it was: the Agent and the
 *            most it may do — asked, not held, until something holds it —
 *            what it is for, where it came from, the seat it took and every
 *            seat passed over on the way, each with why.
```

   - Add to `AgentCardSubject`, after `mark`:

```ts
  /**
   * The Agent a conversation was seated as, when it was. Absent for one that
   * is only a runtime, and then the band is not drawn.
   */
  readonly agent?: {
    readonly name: string
    /** "Read · asked": the ceiling the seat was told, and that nothing holds it to it yet. */
    readonly ceiling: string
    readonly description?: string | null
    /** "In storefront", "Yours", "Built in". */
    readonly origin?: string | null
    /** The seat it took, as read back when it opened: "Claude · Opus 5 · High". */
    readonly seat?: string | null
    /** Every seat passed over before it, with why: "Cursor — Cursor is signed out". */
    readonly passedOver?: readonly string[]
  } | null
```

   - In `AgentCard`, add `agent = null` to the destructured fields, and after the crest's closing `</div>`:

```tsx
      {agent && (
        <Band label="Agent">
          <div className="flex items-baseline gap-1.5">
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{agent.name}</span>
            <span className="flex-none text-xs text-(--hd-muted-foreground)">{agent.ceiling}</span>
          </div>
          {agent.description && <div className="mt-0.5 text-xs">{agent.description}</div>}
          {agent.origin && <div className="mt-0.5 text-xs text-(--hd-muted-foreground)">{agent.origin}</div>}
          {agent.seat && <div className="mt-0.5 text-xs text-(--hd-muted-foreground)">Seated on {agent.seat}</div>}
          {(agent.passedOver ?? []).map((line) => (
            <div key={line} className="mt-0.5 text-xs text-(--hd-muted-foreground)">
              Passed over {line}
            </div>
          ))}
        </Band>
      )}
```

2. Regenerate the design system's documentation, which is written from these comments:

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm design:doc && node script/design-doc.mjs --check && git diff --stat docs/design-system.md
```

   Expected: `docs/design-system.md` changes by the *Agent* band's lines, and `--check` exits 0.

3. In `packages/ui/src/components/AgentCards.tsx`, import `useSeatAgent`, `type SeatAgent` from `../state/seat-agent`, and `ceilingWords`, `originWords`, `passedWords`, `projectOfAgent`, `seatCautions` from `../lib/agents`; add below `busyNow`:

```ts
/** The Agent band for a conversation seated as one, and what its card should warn about it. */
const seatedOf = (
  live: Session | undefined,
  seated: SeatAgent | null,
): { readonly agent: AgentCardSubject['agent']; readonly cautions: readonly AgentCardCaution[] } => {
  if (!live || !seated || seated.name === null) return { agent: null, cautions: [] }
  const settings = live.settings
  const definition = seated.entry?.definition ?? null
  return {
    agent: {
      name: seated.name,
      ceiling: ceilingWords(settings?.permission ?? definition?.permission ?? 'read'),
      description: definition?.description ?? null,
      origin: seated.entry ? originWords(seated.entry.origin, projectOfAgent(seated.entry)) : null,
      seat: settings?.seatLabel ?? null,
      passedOver: (settings?.passedOver ?? []).map(passedWords),
    },
    cautions: seatCautions(seated.entry, settings?.briefDigest).map((text) => ({ tone: 'warning' as const, text })),
  }
}
```

   (add `type AgentCardCaution` to its design import if it is not there). In `MemberCardBody` and in `SessionCardBody`, call `const seated = useSeatAgent(snapshot.sessions.get(member.key))` — `…get(sessionKey(session.runtime, session.id))` in the session card — beside `useTick()`, add `seated` to each `useMemo`'s dependencies, and inside each memo:

```ts
    const { agent, cautions: agentCautions } = seatedOf(live, seated)
```

   then give the subject `agent,` after `mark`, and append `...agentCautions` to its `cautions`.

- [ ] **Step 6: The header, the row and the composer**

1. In `packages/ui/src/components/Conversation.tsx`, import `useSeatAgent` and `ledBy`; replace `<span className={styles.title}>{titleOf(session)}</span>` with `<HeaderTitle session={session} />`, and add after `titleOf`:

```tsx
/** The header's title: the conversation's own, led by the Agent it was seated as. */
const HeaderTitle = ({ session }: { readonly session: Session | null }) => {
  const seated = useSeatAgent(session)
  return <span className={styles.title}>{ledBy(seated?.name ?? null, titleOf(session))}</span>
}
```

2. In `packages/ui/src/components/SessionTree.tsx`, in `SessionRow`, import `useSeatAgent` and `ledBy`, add `const seated = useSeatAgent(live)` after `const live = …`, and replace the `label` line with:

```ts
  const label = ledBy(seated?.name ?? null, sessionLabel(live?.title ?? summary.title, summary.preview))
```

3. In `packages/ui/src/components/ComposerControls.tsx`, in `AgentControl`, import `useSeatAgent`; add `const seated = useSeatAgent(session)` after `const session = useActiveSession()`; replace the early return with:

```tsx
  /* A conversation seated as an Agent says who it is and the seat it took even
     on a desk with one runtime, where there is otherwise nothing to choose. */
  if (!owner || (snapshot.runtimes.length < 2 && !seated)) return null
  const seat = session?.settings?.seatLabel ?? owner.presentation.name
```

   the Popover's `title` with:

```tsx
        title={
          seated
            ? `Seated as ${seated.name ?? 'an Agent'} on ${seat}`
            : session
              ? `This conversation is with ${owner.presentation.name}`
              : 'Which agent starts this conversation'
        }
```

   the label's name with `{!narrow && <PopoverStrong>{seated?.name ?? brandOf(owner.presentation.name)}</PopoverStrong>}`, and the first item of the `session` branch with:

```tsx
                <MenuItem
                  icon={<RuntimeMark runtime={owner} />}
                  selected
                  label={seated ? `As ${seated.name ?? 'an Agent'}, on ${seat}` : `Reply here with ${owner.presentation.name}`}
                  title={
                    seated
                      ? 'The seat it took, as read back when it opened. Replies continue it.'
                      : 'This conversation belongs to it; replies continue it.'
                  }
                  onSelect={() => undefined}
                />
```

   and wrap the *Hand off* label, note and items in `{others.length > 0 && (<>…</>)}` — one runtime has nowhere to hand off to.

- [ ] **Step 7: The preview, and the verb**

1. In `packages/ui/src/preview/main.tsx`, import `seatAgentKey` from `../lib/agents`; seat the preview's conversation as *Code reviewer* — replace `previewSession,` in the `sessions` map with:

```ts
          {
            ...previewSession,
            settings: {
              ...previewSession.settings,
              cwd: previewSession.cwd,
              model: 'gpt-5.6-sol',
              agent: 'code-reviewer',
              // Not the roster's digest: the file has moved on since this was handed over.
              briefDigest: 'digest-when-it-started',
              permission: 'read',
              seatLabel: 'Alpha · GPT-5.6 Sol',
              passedOver: [
                { seat: { runtime: 'cursor' }, label: 'Gamma', runtimeName: 'Gamma', state: 'passed', reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'cursor' } },
              ],
            },
          } as unknown as Session,
```

   and add to the snapshot `seatAgents: new Map([[seatAgentKey(previewSession.cwd, 'code-reviewer'), PREVIEW_AGENTS[0] ?? null]]),`.
2. In `script/check-reachable.mjs`, delete the `'agent/read'` entry from `UNREACHED`.

- [ ] **Step 8: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/agents.test.ts src/state/store.agents.test.ts src/design/patterns/AgentCard.test.tsx src/components/AgentCards.test.tsx src/components/Conversation.test.tsx src/components/SessionTree.test.tsx src/components/ComposerControls.agent.test.tsx src/components/AgentPage.test.tsx && node script/check-reachable.mjs && node script/design-doc.mjs --check`
Expected: PASS; `… 3 pinned as not.`; the design doc is current.

- [ ] **Step 9: Look at it**

In the preview's *Conversation* frame: the header reads *Code reviewer · Worktree Management*; the composer's first control reads *Code reviewer* on Alpha's mark, and its menu *As Code reviewer, on Alpha · GPT-5.6 Sol*. Rest on the conversation's row in the sidebar frame: the card's *Agent* band reads *Code reviewer*, *Read · asked*, *In HarnessDesk*, *Seated on Alpha · GPT-5.6 Sol*, *Passed over Gamma — Gamma is signed out*, and a warning *The brief has changed since this started.* Both themes.

- [ ] **Step 10: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/ui/src docs/design-system.md script/check-reachable.mjs
git commit -m "feat(agents): a conversation seated as an Agent says so

Its pane header and sidebar row lead with the Agent's name — once, while the
title is still that name — and the composer shows the Agent and the seat it
took, as read back, even on a desk with one runtime. Its name card gains an
Agent band: the Agent, its ceiling (asked), what it is for, where it came
from, the seat and every seat passed over with why, and a warning once the
brief has changed since the conversation started.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 19: Save as an Agent…

A conversation's ⋯ menu offers *Save as an Agent…*: a name, what it is for and a ceiling, with the seat the conversation is on as the Agent's first seat. It writes to you or to the open project (`agent/create`, Task 9), then opens the new brief — a skeleton to be written — in the editor.

- **The seat is read the way seating reads one back**: the conversation's `model`, `effort` and `thinking` controls (`runningOf` in `agent-seating.ts` reads the same three ids), its runtime, and the model from its settings where it has no model control. The dialog says it in words — *Claude · Opus 5 · High* — never as a spec.
- **Saved to the project, the committed file names the runtime alone**, and this Mac keeps the exact seat in `seating.json` (Task 9's rule: a committed model name breaks the Agent on every other machine). The dialog says so on that choice, so nobody is surprised to find a runtime and no model in the file.
- **The project is the open one** — the project Settings › Agents lists as *In <project>* — not the folder the conversation happens to work in, which may be one of its worktrees; with no folder open, *For you* is the only choice.
- **A ceiling is chosen from three, each *asked***, with what it tells a seat; the default is *Read*.

**Files:**
- Create: `packages/ui/src/components/SaveAsAgent.tsx`
- Modify: `packages/ui/src/lib/agents.ts` (`seatOf`, `seatWordsOf`), `packages/ui/src/state/store.ts` (`saveAsAgent`), `packages/ui/src/components/Conversation.tsx` (the menu item and the dialog)
- Modify: `packages/ui/src/preview/main.tsx` (the dialog dial gains *save as agent*), `script/check-reachable.mjs` (unpin `agent/create`)
- Test: `packages/ui/src/components/SaveAsAgent.test.tsx` (new), `packages/ui/src/lib/agents.test.ts`, `packages/ui/src/components/Conversation.test.tsx`

**Interfaces:**
- Consumes: `agent/create` (Task 9); `ceilingWords`, `ceilingMeaning`, `projectName` (Task 12).
- Produces: `seatOf(session: Session): FlowSeat`, `seatWordsOf(session: Session, runtimes: readonly RuntimeInfo[]): string` (`lib/agents.ts`); `AppStore.saveAsAgent(agent: { name: string; description: string; permission: FlowPermission; seat: FlowSeat; to: 'user' | 'project' }): Promise<AgentEntry>` (throws); `SaveAsAgentDialog({ session, onClose })`.

- [ ] **Step 1: Write the failing tests**

1. Append to `packages/ui/src/lib/agents.test.ts` (add `seatOf`, `seatWordsOf` to its import, and `type Session` to its protocol import):

```ts
describe('the seat a conversation is on', () => {
  const on = (options: unknown[], model = 'fallback-model'): Session =>
    ({ id: 's', runtime: 'claude-code', cwd: '/w', settings: { cwd: '/w', model }, options }) as unknown as Session
  const select = (id: string, value: string, label: string) => ({
    id,
    label: id,
    type: 'select',
    currentValue: value,
    choices: [{ value, label }],
  })

  it('is read from its model, effort and thinking controls, as seating reads one back', () => {
    const session = on([select('model', 'opus-5', 'Opus 5'), select('effort', 'high', 'High'), { id: 'thinking', label: 'Thinking', type: 'boolean', currentValue: true }])
    expect(seatOf(session)).toEqual({ runtime: 'claude-code', model: 'opus-5', effort: 'high', thinking: true })
    const runtimes = [{ id: 'claude-code', presentation: { name: 'Claude' } }] as unknown as RuntimeInfo[]
    expect(seatWordsOf(session, runtimes)).toBe('Claude · Opus 5 · High · thinking')
  })

  it('takes the model from the settings where there is no model control, and names nothing it was not told', () => {
    expect(seatOf(on([]))).toEqual({ runtime: 'claude-code', model: 'fallback-model' })
    expect(seatOf(on([], ''))).toEqual({ runtime: 'claude-code' })
  })
})
```

2. Create `packages/ui/src/components/SaveAsAgent.test.tsx`:

```tsx
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, RuntimeInfo, Session } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { SaveAsAgentDialog } from './SaveAsAgent'

/**
 * Save as an Agent: a conversation's seat, kept under a name with a brief and
 * a ceiling, written to you or the project — and then the brief, to write.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const LIVE = {
  id: 's1',
  runtime: 'claude-code',
  cwd: '/Users/dev/work/storefront',
  status: { type: 'idle' },
  createdAt: 1,
  updatedAt: 1,
  turns: [],
  itemsLoaded: true,
  settings: { cwd: '/Users/dev/work/storefront', model: 'opus-5' },
  options: [
    { id: 'model', label: 'Model', type: 'select', currentValue: 'opus-5', choices: [{ value: 'opus-5', label: 'Opus 5' }] },
    { id: 'effort', label: 'Effort', type: 'select', currentValue: 'high', choices: [{ value: 'high', label: 'High' }] },
  ],
} as unknown as Session

const SAVED = {
  id: 'checkout-reviewer',
  origin: 'user',
  path: '/Users/dev/.harnessdesk/agents/checkout-reviewer/AGENT.md',
} as unknown as AgentEntry

const mount = (saveAsAgent = vi.fn(async () => SAVED)) => {
  const onClose = vi.fn()
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    home: '/Users/dev',
    stateDir: '/Users/dev/.harnessdesk',
    workspace: { path: '/Users/dev/work/storefront', name: 'storefront', lastOpenedAt: 1 },
    runtimes: [{ id: 'claude-code', capabilities: {}, presentation: { name: 'Claude' } } as unknown as RuntimeInfo],
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    saveAsAgent,
    openFile: vi.fn(),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SaveAsAgentDialog session={LIVE} onClose={onClose} />
      </StoreProvider>,
    )
  })
  return { store, onClose, saveAsAgent }
}

const type = (label: string, value: string): void => {
  const tag = [...document.body.querySelectorAll('label')].find((one) => one.textContent === label)
  const field = tag ? document.getElementById(tag.htmlFor) : null
  if (!(field instanceof HTMLInputElement)) throw new Error(`no field labelled ${label}`)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const choice = (words: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((one) =>
    one.textContent?.includes(words),
  )
  if (!found) throw new Error(`no choice reading ${words}`)
  return found
}
const button = (label: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no button reading “${label}”`)
  return found
}

it('says the seat in words, each ceiling asked, and what saving to the project keeps on this Mac', () => {
  mount()
  const text = document.body.textContent ?? ''
  expect(text).toContain('Claude · Opus 5 · High')
  expect(text).toContain('Read · asked')
  expect(text).toContain('Publish · asked')
  expect(text).toContain('Merge · asked')
  expect(choice('For storefront').textContent).toContain('seating.json')
  // Never the spec.
  expect(text).not.toContain('opus-5')
  expect(button('Save and open the brief').disabled).toBe(true)
})

it('saves the conversation’s seat under a name, with a description and a ceiling, where it was asked — then opens the brief', async () => {
  const { store, onClose, saveAsAgent } = mount()
  type('Name', 'Checkout reviewer')
  type('What it is for', 'Reads checkout changes against our rules.')
  act(() => choice('Publish · asked').click())
  act(() => choice('For you').click())
  act(() => button('Save and open the brief').click())
  await act(async () => {})
  expect(saveAsAgent).toHaveBeenCalledWith({
    name: 'Checkout reviewer',
    description: 'Reads checkout changes against our rules.',
    permission: 'publish',
    seat: { runtime: 'claude-code', model: 'opus-5', effort: 'high' },
    to: 'user',
  })
  expect(store.openFile).toHaveBeenCalledWith(SAVED.path)
  expect(onClose).toHaveBeenCalled()
})

it('says why the host refused, and stays open', async () => {
  const { onClose } = mount(
    vi.fn(async () => {
      throw new Error('An Agent called “checkout-reviewer” is already there — pick another name.')
    }),
  )
  type('Name', 'Checkout reviewer')
  act(() => button('Save and open the brief').click())
  await act(async () => {})
  expect(document.body.textContent).toContain('is already there — pick another name.')
  expect(onClose).not.toHaveBeenCalled()
})
```

3. Append to `packages/ui/src/components/Conversation.test.tsx`:

```tsx
it('the conversation’s menu offers Save as an Agent…', () => {
  render(rig(session()).store)
  act(() => container.querySelector<HTMLButtonElement>('header button[aria-label="Conversation"]')?.click())
  const item = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((one) =>
    one.textContent?.startsWith('Save as an Agent…'),
  )
  if (!item) throw new Error('no Save as an Agent… in the menu')
  act(() => item.click())
  expect(document.body.querySelector('[role="dialog"][aria-label="Save as an Agent"]')).not.toBeNull()
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/agents.test.ts src/components/SaveAsAgent.test.tsx src/components/Conversation.test.tsx`
Expected: FAIL — `seatOf is not a function`, `Failed to resolve import "./SaveAsAgent"`, `no Save as an Agent… in the menu`.

- [ ] **Step 3: The seat, in data and in words**

Append to `packages/ui/src/lib/agents.ts` (add `Session` to its protocol import):

```ts
/**
 * The seat a conversation is on, read the way seating reads one back
 * (`runningOf`, `agent-seating.ts`): its `model`, `effort` and `thinking`
 * controls, and the model from its settings where it has no model control.
 * Nothing it was not told is named.
 */
export const seatOf = (session: Session): FlowSeat => {
  const control = (id: string) => session.options?.find((one) => one.id === id)
  const model = control('model')
  const effort = control('effort')
  const thinking = control('thinking')
  const modelId = model ? String(model.currentValue) : session.settings?.model || null
  return {
    runtime: String(session.runtime),
    ...(modelId ? { model: modelId } : {}),
    ...(effort ? { effort: String(effort.currentValue) } : {}),
    ...(thinking?.currentValue === true ? { thinking: true } : {}),
  }
}

/** The same seat as a person reads it: the runtime's name, then the labels its controls show. */
export const seatWordsOf = (session: Session, runtimes: readonly RuntimeInfo[]): string => {
  const shown = (id: string): string | null => {
    const control = session.options?.find((one) => one.id === id)
    if (control?.type !== 'select') return null
    return control.choices.find((choice) => choice.value === control.currentValue)?.label ?? null
  }
  const thinking = session.options?.find((one) => one.id === 'thinking')
  return [
    runtimes.find((one) => one.id === session.runtime)?.presentation.name ?? String(session.runtime),
    shown('model') ?? (session.options?.some((one) => one.id === 'model') ? null : session.settings?.model || null),
    shown('effort'),
    thinking?.currentValue === true ? 'thinking' : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
}
```

- [ ] **Step 4: The verb, and the dialog**

1. In `packages/ui/src/state/store.ts`, import `type FlowPermission`, and add after `trashAgent`:

```ts
  /**
   * *Save as an Agent…*: writes a new Agent — to you, or to the open project —
   * whose first seat is the one given, and reads the roster again. Answers the
   * new entry, for its brief to be opened; throws the host's refusal for the
   * dialog to say.
   */
  async saveAsAgent(agent: {
    readonly name: string
    readonly description: string
    readonly permission: FlowPermission
    readonly seat: FlowSeat
    readonly to: 'user' | 'project'
  }): Promise<AgentEntry> {
    const project = this.#snapshot.workspace?.path ?? null
    const entry = await this.transport.request('agent/create', {
      name: agent.name,
      ...(agent.description ? { description: agent.description } : {}),
      permission: agent.permission,
      seat: agent.seat,
      to: agent.to,
      ...(project ? { project } : {}),
    })
    void this.loadAgents()
    return entry
  }
```

2. Create `packages/ui/src/components/SaveAsAgent.tsx`:

```tsx
import { useState } from 'react'

import type { FlowPermission, Session } from '@harnessdesk/protocol'

import { ceilingMeaning, ceilingWords, projectName, seatOf, seatWordsOf } from '../lib/agents'
import { shortPath } from '../lib/paths'
import { useSnapshot, useStore } from '../state/context'
import { BriefIcon } from './Icons'
import { Button, Dialog, Field, FormStack, Input, Note, RowChoice, Rows, SectionHead } from '../design'

const CEILINGS: readonly FlowPermission[] = ['read', 'publish', 'merge']

/**
 * *Save as an Agent…*: this conversation's seat, kept under a name, with what
 * it is for and the most it may do, written to you or to the open project —
 * and then its brief, a skeleton, opened in the editor to be written.
 *
 * Saved to the project, the file names the runtime alone and this Mac keeps
 * the exact seat in `seating.json`, because a committed model name breaks the
 * Agent on every other machine. The choice says so.
 */
export const SaveAsAgentDialog = ({ session, onClose }: { readonly session: Session; readonly onClose: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [permission, setPermission] = useState<FlowPermission>('read')
  const [to, setTo] = useState<'user' | 'project'>(snapshot.workspace ? 'project' : 'user')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const words = seatWordsOf(session, snapshot.runtimes)
  const runtime = snapshot.runtimes.find((one) => one.id === session.runtime)?.presentation.name ?? String(session.runtime)
  const project = projectName(snapshot.workspace)
  const yours = snapshot.stateDir ? shortPath(`${snapshot.stateDir}/agents`, snapshot.home) : 'your Agents'

  const save = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const entry = await store.saveAsAgent({
        name: name.trim(),
        description: description.trim(),
        permission,
        seat: seatOf(session),
        to,
      })
      store.openFile(entry.path)
      onClose()
    } catch (error) {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'The Agent was not saved.')
    }
  }

  return (
    <Dialog
      title="Save as an Agent"
      icon={<BriefIcon size={15} />}
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button variant="default" disabled={busy || name.trim() === ''} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save and open the brief'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <FormStack>
        <Note>{`Its first seat is the one this conversation is on: ${words}.`}</Note>
        <Field label="Name">
          {(control) => (
            <Input {...control} autoFocus value={name} placeholder="Checkout reviewer" onChange={(event) => setName(event.target.value)} />
          )}
        </Field>
        <Field label="What it is for" hint="One line. The roster shows it under the name.">
          {(control) => (
            <Input {...control} value={description} maxLength={120} onChange={(event) => setDescription(event.target.value)} />
          )}
        </Field>
        <SectionHead name="The most it may do" />
        <Rows role="radiogroup" aria-label="The most it may do">
          {CEILINGS.map((one) => (
            <RowChoice
              key={one}
              title={ceilingWords(one)}
              desc={ceilingMeaning(one)}
              selected={permission === one}
              onClick={() => setPermission(one)}
            />
          ))}
        </Rows>
        <SectionHead name="Where it is kept" />
        <Rows role="radiogroup" aria-label="Where it is kept">
          {snapshot.workspace && (
            <RowChoice
              title={`For ${project ?? 'this project'}`}
              desc={`Committed with the code, naming ${runtime} alone; this Mac keeps ${words} in seating.json.`}
              selected={to === 'project'}
              onClick={() => setTo('project')}
            />
          )}
          <RowChoice
            title="For you"
            desc={`In ${yours}, on this Mac only.`}
            selected={to === 'user'}
            onClick={() => setTo('user')}
          />
        </Rows>
        {problem && <Note tone="bad">{problem}</Note>}
      </FormStack>
    </Dialog>
  )
}
```

3. In `packages/ui/src/components/Conversation.tsx`, import `SaveAsAgentDialog` from `./SaveAsAgent` and `BriefIcon` beside the other icons. In `ConversationMenu`, add `const [saving, setSaving] = useState(false)` beside `confirmUndo`; wrap the returned `<Popover …>` in a fragment followed by:

```tsx
      {/* Outside the menu: the menu closes as the dialog opens. */}
      {saving && <SaveAsAgentDialog session={session} onClose={() => setSaving(false)} />}
```

   and add, as the menu's last item before the *View* group label:

```tsx
          <PopoverOption
            onClick={() => {
              setSaving(true)
              close()
            }}
          >
            <PopoverOptionMark>
              <BriefIcon size={13} />
            </PopoverOptionMark>
            <PopoverOptionBody>
              <PopoverOptionLabel>Save as an Agent…</PopoverOptionLabel>
              <PopoverOptionHint>This seat, a brief and a ceiling, under a name to start again.</PopoverOptionHint>
            </PopoverOptionBody>
          </PopoverOption>
```

- [ ] **Step 5: The preview, and the verb**

1. In `packages/ui/src/preview/main.tsx`, import `SaveAsAgentDialog`; widen the `dialog` dial with `'save as agent'`; and beside the other dialog mounts add:

```tsx
      {dialog === 'save as agent' && (
        <SaveAsAgentDialog
          session={store.getSnapshot().sessions.get(PREVIEW_SESSION_KEY)!}
          onClose={() => setDialog('off')}
        />
      )}
```

2. In `script/check-reachable.mjs`, delete the `'agent/create'` entry from `UNREACHED`.

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/agents.test.ts src/components/SaveAsAgent.test.tsx src/components/Conversation.test.tsx && node script/check-reachable.mjs`
Expected: PASS — `SaveAsAgent.test.tsx` 3 tests; `… 2 pinned as not.`

- [ ] **Step 7: Look at it**

In the preview, set the *dialog* dial to *save as agent*: *Its first seat is the one this conversation is on: Alpha · gpt-5.6-sol* — the preview's conversation has no model control, so its model is named the way the host names one without a label, by its id; *Read · asked* chosen; *For HarnessDesk* chosen, its line naming `seating.json`; *Save and open the brief* greyed until a name is typed. Both themes.

- [ ] **Step 8: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/ui/src script/check-reachable.mjs
git commit -m "feat(agents): save a conversation as an Agent

A conversation's menu offers Save as an Agent…: a name, what it is for and a
ceiling, with the seat the conversation is on — read the way seating reads a
seat back, and said in words — as its first. It is written to you or to the
open project, where the file names the runtime alone and this Mac keeps the
exact seat, and the new brief opens in the editor to be written.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 20: Agents in a room

The roster's **+** (`AddMember.tsx`) seats an Agent first and a bare runtime second, and a member seated as an Agent goes by its name on the rail and on its cards.

- **The dialog opens on the project's Agents**, each with the mark and words of the seat it would take here — read for the room's own folder (`agentsIn`, Task 17, and `plansIn`, here), which need not be the open one. One that cannot be seated here is offered all the same, greyed with its first reason; choosing it raises the refusal sheet (Task 14) and adds nothing. *A runtime* and *One already running* stay, second and third; a project with no Agents opens on *A runtime*, as the dialog did before. The runtime picker's own label says *Runtime*, since *Agent* now means something else on the same screen.
- **A member's name in a room is the one it is addressed by** — `@Code reviewer` in the channel, the rail, the card's crest — so an Agent's name has to *be* its nickname, not a label drawn over another. The room mints a member's name from what it runs (`#nameOn` in `team.ts`: the model's short name, else the runtime's). A member seated as an Agent is named for the Agent instead, numbered the same way when two share it — *Code reviewer*, *Code reviewer 2*. That needs the Agent's name where the room mints names, so the host's record of a seat keeps the name it was seated under (`SeatedAs.name`, not laid over the conversation's settings), and the peers the host hands the room carry it (`TeamPeer.seatedAs`).

**Files:**
- Modify: `packages/server/src/registry.ts` (`SeatedAs.name`), `packages/server/src/methods/agents.ts` (records it), `packages/server/src/team.ts` (`TeamPeer.seatedAs`; `#nameOn`), `packages/server/src/host.ts` (`#teamPeers` passes it)
- Test: `packages/server/test/agent-seat.test.ts`
- Modify: `packages/ui/src/components/AddMember.tsx` (+ `.module.css`), `packages/ui/src/state/store.ts` (`plansIn`), `packages/ui/src/preview/main.tsx` (`plansIn`)
- Test: `packages/ui/src/components/AddMember.test.tsx`

**Interfaces:**
- Consumes: `startAsAgent(id, { cwd, reveal: false })` (Task 14), `joinRoom`; `agentsIn` (Task 17); Task 12's words.
- Produces: `SeatedAs.name: string`; `TeamPeer.seatedAs?: string | null`; `AppStore.plansIn(project: string): Promise<readonly SeatPlan[]>` (throws).

- [ ] **Step 1: Write the failing host test**

In `packages/server/test/agent-seat.test.ts`:

1. The record now keeps the name the Agent was seated under: in the two assertions Task 5 wrote on `seen.recorded`, add `name: 'Reviewer',` after `agent: 'reviewer',`.
2. Import `type TeamPeerInfo` from `@harnessdesk/protocol`, and append:

```ts
test('through the host: a member seated as an Agent goes by its name in a room, numbered like any other name', async (t) => {
  const { harness, client, work } = await desk(t)
  await writeReviewer(harness.stateDir, 'seatfake=big/high')
  const room = (await client.call('team/room/create', { root: work, name: 'Review' })) as TeamState
  for (let n = 0; n < 2; n += 1) {
    const seated = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
    await client.call('team/room/join', { room: room.id, runtime: 'seatfake', sessionId: String(seated.id) })
  }
  const peers = (await client.call('team/peers', { room: room.id })) as TeamPeerInfo[]
  assert.deepEqual(peers.map((one) => one.nickname).sort(), ['Reviewer', 'Reviewer 2'])
})
```

   (import `type TeamState` beside it if the file does not have it.)

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-seat.test.js`
Expected: FAIL — the two record assertions (`name` missing from the actual record), and `a member seated as an Agent…`: `expected [ 'Seat Fake', 'Seat Fake 2' ] to deeply equal [ 'Reviewer', 'Reviewer 2' ]` — with no model family to name them for, the room named them for the runtime.

- [ ] **Step 3: Keep the name, and let the room use it**

1. In `packages/server/src/registry.ts`, add to `SeatedAs`, after `agent`:

```ts
  /**
   * The Agent's name when it was seated — what a room calls the member. Not
   * laid over the conversation's settings: a renderer reads the Agent itself
   * (`agent/read`) for what it is called now.
   */
  readonly name: string
```

2. In `packages/server/src/methods/agents.ts`, in `'agent/seat'`'s `recordAgent` call, add `name: definition.name,` after `agent: definition.id,`.
3. In `packages/server/src/team.ts`, add to `TeamPeer`, after `model`:

```ts
  /**
   * The Agent this conversation was seated as, by name. A room calls such a
   * member that — the name it is addressed by, in the channel and on the rail
   * — rather than after the model it runs.
   */
  readonly seatedAs?: string | null
```

   and in `#nameOn`, replace `const base = shortModelName(peer.model) ?? peer.agent` with:

```ts
    const base = peer.seatedAs ?? shortModelName(peer.model) ?? peer.agent
```

4. In `packages/server/src/host.ts`, in `#teamPeers()`, add after `model: sessionModel(record.session),`:

```ts
        /* A conversation seated as an Agent is called that in a room. */
        ...(record.seatedAs ? { seatedAs: record.seatedAs.name } : {}),
```

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-seat.test.js packages/server/dist/test/team.test.js`
Expected: PASS — `agent-seat.test.js` 59 tests (58 + 1); `team.test.js` unchanged, since no peer it builds carries `seatedAs`.

- [ ] **Step 4: Write the failing dialog tests**

In `packages/ui/src/components/AddMember.test.tsx`:

1. Import `type AgentEntry` and `type SeatPlan` from `@harnessdesk/protocol`. Give `rig`'s `world` two more fields, `agents?: readonly AgentEntry[]` and `plans?: readonly SeatPlan[]`, and its store three more verbs:

```ts
    agentsIn: vi.fn().mockResolvedValue(world.agents ?? []),
    plansIn: vi.fn().mockResolvedValue(world.plans ?? []),
    startAsAgent: vi.fn().mockResolvedValue(sessionKey('claude-code', 's2')),
```

2. In `offers the agents, and the options that agent declares`, the runtime picker is labelled for what it picks: `select('Agent')` → `select('Runtime')`.
3. Append:

```tsx
const agent = (id: string, name: string): AgentEntry => ({
  id,
  origin: 'builtin',
  path: `/app/agents/${id}/AGENT.md`,
  digest: 'd',
  shadows: [],
  problems: [],
  definition: { id, name, description: null, permission: 'read', answers: [], produces: [], skills: [], prefer: [{ runtime: 'claude-code' }], brief: 'Work.' },
})

const PLANS: readonly SeatPlan[] = [
  {
    id: 'code-reviewer',
    from: 'prefer',
    winner: 0,
    blocked: null,
    candidates: [{ seat: { runtime: 'claude-code' }, label: 'Claude Code · Opus 5 · High', runtimeName: 'Claude Code', state: 'taken', reason: null, fix: null }],
  },
  {
    id: 'judge',
    from: 'prefer',
    winner: null,
    blocked: null,
    candidates: [{ seat: { runtime: 'cursor' }, label: 'Cursor', runtimeName: 'Cursor', state: 'passed', reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'cursor' } }],
  },
]

const WITH_AGENTS = { agents: [agent('code-reviewer', 'Code reviewer'), agent('judge', 'Judge')], plans: PLANS }

it('opens on the project’s Agents, each with the seat it would take here, and seats one in the room', async () => {
  const { store } = rig([MODELS], WITH_AGENTS)
  const onClose = await render(store)
  expect(store.agentsIn).toHaveBeenCalledWith('/repo')
  const text = document.body.textContent ?? ''
  expect(text).toContain('Claude Code · Opus 5 · High')
  expect(text).toContain("Can't seat here · Cursor is signed out")

  press('Add to room')
  await act(async () => {
    await Promise.resolve()
  })
  // Seated in the room's folder without taking the screen, then put in the room.
  expect(store.startAsAgent).toHaveBeenCalledWith('code-reviewer', { cwd: '/repo', reveal: false })
  expect(store.joinRoom).toHaveBeenCalledWith('room-1', 'claude-code', 's2')
  expect(store.newSession).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})

it('offers an Agent that cannot be seated here all the same — trying it opens nothing and adds nothing', async () => {
  const { store } = rig([MODELS], WITH_AGENTS)
  ;(store.startAsAgent as ReturnType<typeof vi.fn>).mockResolvedValue(null)
  const onClose = await render(store)
  act(() => document.querySelector<HTMLElement>('[aria-label="Judge"]')?.click())
  press('Add to room')
  await act(async () => {
    await Promise.resolve()
  })
  expect(store.startAsAgent).toHaveBeenCalledWith('judge', { cwd: '/repo', reveal: false })
  expect(store.joinRoom).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
})

it('a project with no Agents opens on a runtime, as before, and says why the Agent door is shut', async () => {
  const { store } = rig()
  await render(store)
  const door = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((one) => one.textContent?.includes('An Agent'))
  expect(door?.disabled).toBe(true)
  expect(door?.title).toBe('This project has no Agents to seat yet.')
  expect(select('Runtime')).not.toBeNull()
})
```

- [ ] **Step 5: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/AddMember.test.tsx`
Expected: FAIL — `no select labelled Runtime`, `expected "spy" to be called with arguments: [ '/repo' ]`, and no *An Agent* door.

- [ ] **Step 6: The dialog**

1. In `packages/ui/src/state/store.ts`, add after `agentsIn`:

```ts
  /** Which seat each of one project's Agents would take here — a dry run for that project, opening nothing. Throws. */
  async plansIn(project: string): Promise<readonly SeatPlan[]> {
    return this.transport.request('agent/seat/dry', { project })
  }
```

2. Append to `packages/ui/src/components/AddMember.module.css`:

```css
/* An Agent that cannot be seated here: offered, and its reason in the tone of a doubt. */
.candidate[data-refused] .candidateAgent {
  color: var(--hd-warning-ink);
}
```

3. In `packages/ui/src/components/AddMember.tsx`:
   - Import `type AgentEntry` and `type SeatPlan` from `@harnessdesk/protocol`, `agentName`, `firstReason`, `inForce`, `markFor` and `seatTaken` from `../lib/agents`, and `BriefIcon` from `./Icons`. The dialog keeps its title, which the rail's **+** shares.
   - After the `loose` memo, add:

```tsx
  /* The room's project's own roster, and which seat each would take there —
     read for the room's folder, which need not be the one the window has
     open. Null while it is read. */
  const [roster, setRoster] = useState<readonly AgentEntry[] | null>(null)
  const [plans, setPlans] = useState<ReadonlyMap<string, SeatPlan>>(new Map())
  const [agentId, setAgentId] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    store.agentsIn(root).then(
      (list) => {
        if (live) setRoster(inForce(list))
      },
      () => {
        if (live) setRoster([])
      },
    )
    store.plansIn(root).then(
      (list) => {
        if (live) setPlans(new Map(list.map((plan) => [plan.id, plan])))
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [store, root])
  /* The one chosen, or the first that can be seated here, or the first. */
  const agentChoice =
    (agentId && roster?.some((one) => one.id === agentId) ? agentId : null) ??
    roster?.find((one) => seatTaken(plans.get(one.id)) !== null)?.id ??
    roster?.[0]?.id ??
    null
```

   - Replace `const [mode, setMode] = useState<'new' | 'running'>('new')` with:

```tsx
  /* An Agent first, a runtime second — and until somebody picks, the Agents
     whenever the project has any, which is not known until they are read. */
  const [chosenMode, setMode] = useState<'agent' | 'new' | 'running' | null>(null)
  const mode = chosenMode ?? (roster === null || roster.length > 0 ? 'agent' : 'new')
```

   - Add, beside `add`:

```tsx
  /** Seats an Agent in the room's folder and puts it in the room — or, refused, leaves the sheet to say why. */
  const addAgent = async (): Promise<void> => {
    if (!agentChoice) return
    setBusy(true)
    setProblem(null)
    // `reveal: false`, as for a runtime: main is a slot, and this room is in it.
    const key = await store.startAsAgent(agentChoice, { cwd: root, reveal: false })
    if (!key) {
      // Nothing was opened: the refusal sheet lists every seat and its fix, or a notice says what failed.
      setBusy(false)
      return
    }
    const { runtime: started, id } = splitSessionKey(key)
    try {
      await store.joinRoom(room, started, id)
    } catch (error) {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'It was seated, but the room would not take it.')
      return
    }
    onClose()
  }
```

   - The footer's button becomes:

```tsx
          <Button
            variant="default"
            disabled={busy || (mode === 'agent' ? !agentChoice : mode === 'new' ? !runtime : !choice)}
            onClick={() => void (mode === 'agent' ? addAgent() : mode === 'new' ? add() : join())}
          >
            {busy ? (mode === 'running' ? 'Adding…' : mode === 'agent' ? 'Seating…' : 'Starting…') : 'Add to room'}
          </Button>
```

   - In the `Which agent` field, rename its label and radiogroup to `Who joins`, and put before the *Start a new one* door (whose label becomes `A runtime`):

```tsx
            <Button
              type="button"
              role="radio"
              aria-checked={mode === 'agent'}
              variant="choice" size="row" className={styles.mode}
              disabled={roster !== null && roster.length === 0}
              title={roster !== null && roster.length === 0 ? 'This project has no Agents to seat yet.' : undefined}
              onClick={() => setMode('agent')}
            >
              An Agent
              {roster && roster.length > 0 && <span className={styles.count}>{roster.length}</span>}
            </Button>
```

   - Make the body's switch three-way — `{mode === 'agent' ? (…) : mode === 'running' ? (…the running picker…) : (…the runtime form…)}` — with the Agents' branch:

```tsx
          <div className={styles.field}>
            <span className={styles.label}>Its Agents, and the seat each would take here</span>
            {roster === null ? (
              <p className={styles.note}>Reading this project’s Agents…</p>
            ) : (
              <RadioGroup
                className={styles.picker}
                value={agentChoice ?? ''}
                onValueChange={(value) => setAgentId(String(value))}
              >
                {roster.map((entry) => {
                  const plan = plans.get(entry.id)
                  const seat = seatTaken(plan)
                  const reason = plan && !seat ? firstReason(plan) : null
                  const name = agentName(entry)
                  return (
                    <label key={entry.id} className={styles.candidate} {...(reason ? { 'data-refused': '' } : {})}>
                      <RadioGroupItem value={entry.id} aria-label={name} />
                      {seat ? <RuntimeMark runtime={markFor(seat, snapshot.runtimes)} size={14} /> : <BriefIcon size={14} />}
                      <span className={styles.candidateName}>{name}</span>
                      <span className={styles.candidateAgent}>
                        {seat ? seat.label : reason ? `Can't seat here · ${reason}` : 'Checking…'}
                      </span>
                    </label>
                  )
                })}
              </RadioGroup>
            )}
            <p className={styles.note}>It is seated in this room’s folder, joins as soon as it is, and goes by the Agent’s name.</p>
          </div>
```

   - In the runtime form, label the picker for what it picks: `<span className={styles.label}>Runtime</span>` and `aria-label="Runtime"`.
4. In `packages/ui/src/preview/main.tsx`, add to `PreviewStore`, beside `agentsIn`:

```ts
  plansIn = async (): Promise<readonly SeatPlan[]> => [...PREVIEW_PLANS.values()]
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/AddMember.test.tsx`
Expected: PASS — every earlier test unchanged but the one label, and the three new ones.

- [ ] **Step 8: Look at it**

Run the preview and press the **+** on the roster in its *Team room — the roster, and the channel* frame: *Who joins* reads *An Agent* (with its count), *A runtime*, *One already running*; the Agents list *Code reviewer* on *Beta · Opus · High* and *Security reviewer* greyed with *Can't seat here · Gamma is signed out*. Both themes.

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/server/src/registry.ts packages/server/src/methods/agents.ts packages/server/src/team.ts packages/server/src/host.ts packages/server/test/agent-seat.test.ts packages/ui/src
git commit -m "feat(rooms): seat an Agent in a room, and call it by its name

A room's + opens on the project's Agents — each with the seat it would take
there, one that cannot be seated greyed with its reason — before a bare
runtime and a conversation already running. The Agent is seated in the room's
folder and joins it; refused, the refusal sheet says why and nothing joins. A
member seated as an Agent is named for it, numbered like any other name, so
the name it is addressed by in the channel is the name on the rail and on its
card.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 21: The documentation

`docs/` describes what ships, so every page that names the old page or the old noun changes in the phase that changes them. The roadmap's table for phase 2 names four pages; two more say *Settings › Agents* for what is now *Settings › Runtimes* — `docs/getting-started.md` (five places) and `docs/design.md` (one row) — and a page that describes the previous noun model is worse than no page, so they change too.

**Files:**
- Create: `docs/agents.md`
- Modify: `docs/README.md`, `docs/interface.md`, `docs/runtimes.md`, `docs/multi-agent.md`, `docs/getting-started.md`, `docs/design.md`

**Interfaces:**
- Consumes: everything Tasks 1–20 shipped, as Task 22 photographs it. Produces: prose only.

- [ ] **Step 1: Write the page the Agent needs**

Create `docs/agents.md`:

````markdown
# Agents

An **Agent** is *who* does the work: a brief, the most it may do, and the
seats it prefers. A **runtime** is what it runs on — an agent program the desk
has added, such as Codex or Claude Code ([runtimes.md](runtimes.md)). One Agent
can sit on any runtime that can offer it a seat, and one runtime can hold any
number of Agents at once.

## An Agent is a folder

A folder named for the Agent — its id — holding one file, `AGENT.md`: front
matter, then the brief.

```markdown
---
name: Code reviewer
description: Reads a change it did not write and reports every problem it finds, blocking or not.
permission: read
answers: [approve, request-changes]
produces: [review]
prefer: [claude-code, codex, cursor]
---

You review a change somebody else wrote. …
```

| Key | What it says |
| --- | --- |
| `name` | What every surface calls it. |
| `description` | One line; the roster shows it under the name. |
| `permission` | The most it may do — `read`, `publish` or `merge`. A ceiling, never a grant: see *Asked, not held* below. |
| `answers` | The verdicts it may give. |
| `produces` | What it leaves behind. |
| `skills` | The skills it expects, by name. Read-only for now. |
| `prefer` | The seats it asks for, in order — at most eight. |
| the body | The brief, handed to the seat once as its standing order. |

A file that will not parse is still listed, with where and why — the parser
(`packages/server/src/agent-def.ts`) names every problem it finds, and a
listing never drops an Agent it could not read.

## Three places, one roster

| Where | Whose |
| --- | --- |
| `.harnessdesk/agents/<id>/AGENT.md`, at the top of a project's checkout | The project's, committed with its code: everyone who clones it has them |
| `~/.harnessdesk/agents/<id>/AGENT.md` | Yours, on this Mac |
| Inside the app | Built in; they change only when HarnessDesk does |

The project's come first, then yours, then the built-in ones: an Agent with the
same id in a place that comes first **shadows** the one below. A shadowed copy
is listed where it lives and says what shadows it — never hidden. A folder
opened inside a repository reads its repository's Agents, and a linked worktree
its own branch's, because a project keeps its Agents at the top of its
checkout. The roster is read again whenever a file under any of the three
places changes (`packages/server/src/agent-watch.ts`).

## The nine that ship

| Agent | What it is for | `permission` |
| --- | --- | --- |
| Code reviewer | Reads a change it did not write and reports every problem it finds, blocking or not | `read` |
| Security reviewer | Reads a change for the ways it could be abused, and how to close each | `read` |
| Performance reviewer | Reads a change for what it costs in time, memory and I/O, and when that cost shows | `read` |
| API reviewer | Reads a change for what it does to the interfaces other code and other people rely on | `read` |
| Test reviewer | Judges whether a change's tests would catch it being wrong | `read` |
| Implementer | Builds the change it is given on its own branch, proves it with the project's checks, and hands it over | `publish` |
| Judge | Compares attempts at the same task, picks one or none, and says why | `read` |
| Researcher | Answers a question from the code and its sources, and writes the answer down with its evidence | `read` |
| Requirements analyst | Turns a need into requirements that can be built and tested, and later judges whether a change meets them | `read` |

Each names runtimes, not models — `prefer: [claude-code, codex, cursor]` —
because a model name in a file that travels breaks the Agent on every machine
that does not have that model; each machine says which model in its own
seats (below). Their files are in `packages/server/agents/`, starting with
`packages/server/agents/code-reviewer/AGENT.md`, and a test holds each one to
parsing with no problems and seating on the desk's fake runtimes. To change
one, *Customize…* on its page copies it somewhere that comes first.

## Where an Agent sits

A seating tries seats in order and takes the first this machine can offer. The
list is, highest first:

1. a seating's own seats, when it names any;
2. this Mac's seats for the Agent, in `~/.harnessdesk/seating.json`;
3. the Agent's own `prefer`.

Each **replaces** the next rather than merging with it: two ordered lists
merged have an order nobody chose.

`seating.json` maps an Agent's id to its seats on this machine, and is never
committed:

```json
{ "code-reviewer": ["claude-code=opus-5/high", "codex/high"] }
```

A seat is written `runtime`, `=model`, `/effort` and `+thinking`, each part but
the runtime optional — or, for a model whose name the short form cannot carry,
as an object with those four keys. The file is edited on the Agent's page,
under *On this Mac*, and validated on the way in: an entry that does not read
**refuses** its Agent's seating, with where and why, rather than quietly
seating it on the list it replaced; and a file that is not JSON is never
written over (`packages/server/src/agent-seating-file.ts`).

**Refuse, never substitute.** A candidate is passed over when its runtime is
not added or not installed, cannot start, is signed out, has used up its plan
window, does not offer the model or effort asked for, does not answer within
ten seconds, or opens the conversation on something other than what was asked.
When every candidate is passed over, nothing is opened, and the refusal lists
every one with its reason and the one thing that fixes it — *Sign in to
Cursor*, *Add Codex*, *Edit seats for this Mac*.

**A seat passed over leaves nothing behind where its runtime allows it.** Codex
deletes the thread; the Claude Code and Cursor bridges delete what their agents
wrote, which for a conversation nobody spoke in is usually nothing. A runtime
with no way to delete one may keep an empty conversation in its own history;
the desk archives it, forgets it, and the refusal says so for that candidate.

Which seat each Agent would take here is a dry run that opens nothing and
asks each runtime once (`agent/seat/dry` in
`packages/server/src/methods/agents.ts`). Every menu that lists Agents is drawn
from it.

## Starting as an Agent

- **New session** in the sidebar lists Agents above the runtime's own door,
  each with the mark of the runtime it would sit on here. One that cannot be
  seated here stays — greyed, with its reason — and pressing it shows every
  seat it would take and what stands in the way.
- **⌘K** offers *Start as <Agent>* and *Open <Agent> in Settings*.
- **An Agent's page** offers *Start a conversation as <name>*.
- **A room's +** offers the project's Agents first; one seated there joins
  under the Agent's name.

A conversation seated as an Agent leads its header and its sidebar row with
the Agent's name; its composer names the seat it took, as read back from the
runtime; and its name card carries the Agent — what it is for, its ceiling,
where it came from, the seat, every seat passed over and why — with *The brief
has changed since this started* once the file has moved on from the one it was
handed. That a conversation was seated as an Agent is remembered until the
desk quits.

**Asked, not held.** A seat is told the narrower of its Agent's `permission`
and what its seating grants, and nothing started from the app grants more than
`read`. `read` lets a seat edit and commit in its own checkout and never push,
merge, reset or force. The seat is *told* this in its standing order, and
nothing at the tool surface stops one that ignores it yet — so every surface
labels a ceiling *asked*: *Read · asked*.

## Making your own

- **Save as an Agent…** in a conversation's ⋯ menu: a name, what it is for and
  a ceiling, with the seat the conversation is on as its first. Saved for you,
  it is written under `~/.harnessdesk/agents`; saved to the project, the
  committed file names the runtime alone and this Mac keeps the exact seat in
  `seating.json`. The new brief — a skeleton — opens in the editor.
- **Customize…** on a built-in Agent or one of yours copies it to the project
  or to you, where the copy comes first and shadows the original.
- **Remove…** on a project's Agent or one of yours moves its folder to the
  Trash; the copy it shadowed, if any, is in force again.
- Or write the folder by hand. The roster notices.

## Where to find them

**Settings › Agents** is the roster, in three sections — *In <project>*,
*Yours*, *Built in* — each naming the folder it reads. A row is an Agent's name
and what it is for, with its ceiling and the seat it would take here, or *Can't
seat here* and the first reason; a shadowed copy is muted and says what
shadows it; a file that will not parse says why. Each row opens the Agent's
page: its file, with *Open file* and *Reveal*; its ceiling; its own seats and
their state here; *On this Mac*, this machine's seats, added to, reordered or
cleared; what it answers and produces, and its skills; and its brief's first
paragraph, with *Open in editor*.

**Settings › Workspaces** opens a page per project — so does *Project
settings* in the sidebar's project menu — listing the project's own Agents and
the folder they are read from.
````

- [ ] **Step 2: Point the front door at it**

In `docs/README.md`, in *Use it*, add after the `interface.md` row:

```markdown
| [agents.md](agents.md) | Who does the work: an Agent's brief, the most it may do and the seats it prefers; the nine that ship; starting as one, and saving your own |
```

- [ ] **Step 3: The interface**

In `docs/interface.md`:

1. Replace the paragraph that begins `**⌘K** is the way through the app` with:

```markdown
**⌘K** is the way through the app without more chrome: actions, Agents to
start as, runtimes, sessions, files (through the runtime's own search), and
slash commands, grouped in a fixed order and scored within each group.
```

2. Replace the *New session* bullet's first sentence with:

```markdown
- **New session**: clicking the button opens a choice between a solo session and
  a collaborative room for several agents. The solo choice lists Agents first,
  each with the mark of the runtime it would sit on here — one that cannot be
  seated here stays, greyed with its reason — and then the runtime's own
  session; ⌘N goes straight to a session.
```

   keeping the bullet's sentences about the branch button as they are.
3. After the ⋮ bullet in *The conversation*, add:

```markdown
- **Save as an Agent…** is in ⋮ too: a name, what it is for and a ceiling,
  with the seat this conversation is on as the Agent's first; it is written to
  you or to the project and its brief opens in the editor
  ([agents.md](agents.md)).

**A conversation seated as an Agent is headed by it.** The header and the
sidebar row lead with the Agent's name — once, while the conversation's title
is still that name — the composer's agent chip names the Agent and the seat it
took, and the name card adds an *Agent* band: what it is for, its ceiling
(*Read · asked*), where it came from, the seat and every seat passed over, and
*The brief has changed since this started* once its file has moved on.
```

4. In the agent-chip bullet of *The composer*, add as its last sentence: `A conversation seated as an Agent names the Agent here, and the seat it took, even on a desk with one runtime.`
5. Replace the Settings table's *Agents* row with:

```markdown
| **Agents** | Agents · Runtimes · Models · Skills · Extensions |
```

   and in the paragraph under the table, `a custom agent` with `a custom runtime`.
6. Replace the paragraph that begins `**Agents** is a roster: every registered agent` with:

```markdown
**Agents** is the roster of who does the work — the open project's own
Agents, yours, and the ones that ship — each section naming the folder it
reads, each row an Agent's name and what it is for with its ceiling and the
seat it would take here, or *Can't seat here* and why. A row opens the Agent's
page, and *On this Mac* on that page is where this machine's seats for it are
chosen. The nav row counts the Agents in force and wears a dot only when a
file will not parse. See [agents.md](agents.md).

**Runtimes** is every registered runtime with its accounts beneath it, and a
page per runtime (health, update, the runtime's own options) or per account;
*Add a runtime* is where a registry entry or a custom one is added.
Extensions appears only for a runtime with a store or MCP servers to show,
which today means Codex alone. A runtime whose sign-in the desk cannot ask
about — an ACP agent with no status command and no stored key — is described
by what its own answers showed: "Signed in" once a conversation has opened,
its declared sign-in methods in its own words when it refused one for want of
authentication, and nothing at all before either has happened. It is never
"Needs sign-in" on the strength of an empty list. ⌘, opens this page.

**Workspaces** lists every folder opened, each a way into its project's page —
*Project settings* in the sidebar's project menu opens the same page — which
lists the project's own Agents and the folder they are read from, with *Open*
and *Forget* for a project that is not the one open.
```

- [ ] **Step 4: Runtimes, rooms, and the two pages that named the old page**

1. `docs/runtimes.md`: replace `Navigate to **Settings › Agents › [Agent]** to view its **Install** section:` with `Navigate to **Settings › Runtimes › [runtime]** to view its **Install** section:`; replace `- **Add agent dialog:**` with `- **Add a runtime page:**`; and add, at the end of *What the interface shows*:

```markdown
The page was called Agents until Agents — who does the work, a brief with the
seats it prefers — got a page of their own; a runtime is what an Agent sits on
([agents.md](agents.md)).
```

2. `docs/multi-agent.md`, in *Roster management and nicknames*: add to the *Nicknames* bullet the sentence `A member seated as an Agent is named for the Agent instead — Code reviewer, Code reviewer 2 — since that is the name it is addressed by.`, and replace the *Adding members* bullet with:

```markdown
- **Adding members**: clicking the roster's **+** opens a dialog that offers
  the project's Agents first, each with the seat it would take there — one
  that cannot be seated offered greyed, with its reason, and choosing it shows
  every seat and its fix rather than adding anything — then a bare runtime
  with its declared controls (model, mode, effort, approvals, sandbox), then
  the project's loose conversations to adopt. A new member starts in the
  background without replacing the room on screen, and joins at once.
```

3. `docs/getting-started.md`: `Settings › Agents › **Add agent**` → `Settings › Runtimes › **Add a runtime**`; and each of the four other `Settings › Agents` → `Settings › Runtimes`.
4. `docs/design.md`, in the second-line ledger: `Agent tagline (Settings › Agents card)` → `Runtime tagline (Settings › Runtimes card)`, and `still shown in full in Add agent, first run and sign-in` → `still shown in full in Add a runtime, first run and sign-in`.

- [ ] **Step 5: Check the paths, the pins, and that nothing still sends a reader to the old page**

Run:

```bash
cd "$(git rev-parse --show-toplevel)"
node script/check-doc-paths.mjs && node script/check-reachable.mjs
grep -rn "Settings › Agents" docs/*.md
```

Expected: the doc-path check passes; `… 2 pinned as not.` with `UNREACHED` holding only `team/state` and `team/rooms`; and the grep prints only `docs/agents.md`'s line about the roster — never one about accounts, sign-in or installing.

- [ ] **Step 6: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add docs/agents.md docs/README.md docs/interface.md docs/runtimes.md docs/multi-agent.md docs/getting-started.md docs/design.md
git commit -m "docs: Agents, reintroduced now that a person can reach one

docs/agents.md is the Agent: the folder, the three places and what shadows
what, the nine that ship, where an Agent sits and this Mac's own seats,
refusing rather than substituting, starting as one, and saving your own.
interface.md gains Settings › Agents, Runtimes and a project's page, the
Agent-led conversation and Save as an Agent…; runtimes.md, multi-agent.md,
getting-started.md and design.md stop sending readers to Settings › Agents
for what is now Settings › Runtimes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 22: Verified in the real app, and one picture per surface

The owner's rule: the app itself is launched, and every new or changed surface is photographed for the pull request. The repository's screenshot rig already does the hard part — `script/shots/seed.mjs` stages an invented desk under `~/.harnessdesk-shots` and `~/work`, `script/shots/shoot.mjs` drives the real Electron app over CDP (`script/lib/desk.mjs`) and photographs named scenes in both themes, `script/shots/accounts.mjs` answers every runtime's account from the rig, and `script/shots/audit.mjs` refuses any frame carrying a real identity, an unvouched account, a home path or an agent worktree path — so this task extends the rig rather than writing a driver, and never loosens the audit.

**The staged desk gains Agents** (`seed.mjs`):

- **In `storefront`**, `.harnessdesk/agents/code-reviewer/AGENT.md`: the project's own *Code reviewer*, which shadows the one that ships.
- **Yours**, `release-checker` under the staged home: an Agent nothing on the desk can seat — its seats are a runtime that is signed out and one that is not added — so the roster, its page, the new-session dialog and the refusal sheet all have one to show.
- **This Mac's seats** (`seating.json`) for *Code reviewer*: the signed-out runtime first, then Claude on Opus — so its seat is passed over on the way and the name card has one to name.
- **One runtime signed out**: Windsurf, which no existing scene seats. Its registry entry gains an account status command that answers `{"loggedIn":false}` — the host's own sign-in read — and `accounts.mjs` answers the renderer the same way, so no surface says it is signed in while the refusal says it is not.
- Every seat names the rig's runtimes (`rigRuntimeId`) except the one meant to be missing, so nothing reads through to a vendor CLI on this machine; and `agents` and `seating.json` join the residue each take removes, so every take starts from the same desk.

**One scene per surface** (`shoot.mjs`), each with the words that prove it is on screen and, where the roadmap's *Done when* says something stronger, a check that fails the take:

| Scene | Surface | Proves |
| --- | --- | --- |
| `settings-agents` | Settings › Agents | the shipped Agents, and the project's *Code reviewer* shadowing the one that ships |
| `agent-page` | An Agent's page | its file, *Read · asked*, its own seats muted, *On this Mac* filled |
| `settings-runtimes` | Settings › Runtimes | (Task 11's scene) the installed runtimes under their new name |
| `project-page` | Workspaces › a project | the project's own Agents and their folder |
| `new-session-agents` | The new-session dialog | Agents first; *Release checker* greyed with its reason |
| `palette-agents` | ⌘K | *Start as Code reviewer* |
| `conversation-agent-card` | A conversation seated as an Agent | *Start as* opened a conversation headed *Code reviewer*; its card names the seat, the one passed over, and that the brief has changed since |
| `refusal-sheet` | The refusal sheet | every candidate with its reason and fix, *Sign in to Windsurf* among them — and nothing opened |
| `save-as-agent` | *Save as an Agent…* | the dialog, from a conversation's ⋯ |
| `add-member-agents` | A room's **+** | *Who joins*: Agents first, each with the seat it would take |

**Files:**
- Modify: `script/shots/seed.mjs`, `script/shots/accounts.mjs`, `script/shots/shoot.mjs`
- Test: `script/shots-isolation.test.mjs`

**Interfaces:**
- Consumes: every surface of Tasks 11–20; `Agents` (`packages/server/dist/src/agents.js`) and `parseSeating` (`packages/server/dist/src/agent-seating-file.js`) in the gate test.
- Produces: ten scenes and their PNGs in a scratch folder — never committed.

- [ ] **Step 1: Write the failing gate test**

In `script/shots-isolation.test.mjs`, import `Agents` from `'../packages/server/dist/src/agents.js'` and `parseSeating` from `'../packages/server/dist/src/agent-seating-file.js'`, and append:

```js
test('the staged desk has Agents: a project one shadowing one that ships, one of yours, and this Mac’s seats', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-agents-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const work = join(directory, 'work')
  execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
    env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '0' },
    stdio: 'pipe',
  })
  const roster = new Agents({ user: join(home, 'agents'), builtin: join(root, 'packages/server/agents') })
  const listed = await roster.list(join(work, 'storefront'))
  const byId = new Map(listed.map(one => [one.id, one]))
  assert.equal(byId.get('code-reviewer')?.origin, 'project')
  assert.deepEqual(byId.get('code-reviewer')?.shadows.map(one => one.origin), ['builtin'])
  assert.equal(byId.get('release-checker')?.origin, 'user')
  assert.equal(byId.get('judge')?.origin, 'builtin')
  assert.deepEqual(listed.flatMap(one => one.problems), [], 'every staged Agent parses')

  const seating = parseSeating(readFileSync(join(home, 'seating.json'), 'utf8'))
  assert.deepEqual(seating.problems, [])
  assert.deepEqual(seating.entries.map(one => one.id), ['code-reviewer'])
  // This Mac's seats are the rig's own runtimes: nothing reads through to a CLI installed here.
  const configs = new AgentRegistryStore(join(home, 'agents.json')).configs()
  const ids = new Set(configs.map(one => one.id))
  for (const seat of seating.entries.flatMap(one => one.seats)) assert.ok(ids.has(seat.runtime), seat.runtime)
  // One runtime is signed out where the host asks, and the renderer is told the same.
  assert.ok(configs.find(one => one.id === 'shots-windsurf')?.account?.status, 'Windsurf answers its own sign-in')
  assert.deepEqual(RUNTIME_ACCOUNTS['shots-windsurf']?.accounts, [])
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm run build:node && node --test --test-reporter=spec script/shots-isolation.test.mjs`
Expected: FAIL — `the staged desk has Agents…`: `expected undefined to equal 'project'` — the seed writes no Agent.

- [ ] **Step 3: Stage the Agents**

1. In `script/shots/seed.mjs`:
   - Add `'agents'` and `'seating.json'` to `RESIDUE`.
   - Above the `agents.json` write, add:

```js
/**
 * Windsurf's own sign-in answer: signed out.
 *
 * The host reads whether a seat is signed in from the runtime itself, not
 * from the renderer's account rows the rig answers — so the one runtime the
 * Agent scenes need signed out has to say so where the host asks. Windsurf,
 * because no other scene seats it.
 */
const SIGNED_OUT = { command: 'node', args: ['-e', 'process.stdout.write(JSON.stringify({ loggedIn: false }))'] }
```

   - In the `agents.json` entries, after `env: { … },`, add `...(agent.id === 'windsurf' ? { account: { status: SIGNED_OUT } } : {}),`.
   - After the `state.json` write, add:

```js
// ------------------------------------------------------------------ the Agents
/**
 * Agents, in all three places the roster reads: the storefront's own Code
 * reviewer, which shadows the one that ships; one of yours that nothing here
 * can seat; and this Mac's seats for the project's reviewer, the first of
 * them passed over on the way. Seats name the rig's runtimes, except the one
 * meant to be missing, so no Agent reads through to a CLI on this machine.
 */
const agentFile = ({ name, description, prefer, brief }) =>
  `---\nname: ${name}\ndescription: ${description}\npermission: read\nanswers: [approve, request-changes]\nproduces: [review]\nprefer: [${prefer.join(', ')}]\n---\n\n${brief}\n`

const writeAgent = (dir, source) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'AGENT.md'), source)
}

writeAgent(
  join(roots.storefront, '.harnessdesk', 'agents', 'code-reviewer'),
  agentFile({
    name: 'Code reviewer',
    description: 'The storefront’s reviewer: reads a change against the checkout rules before anyone merges it.',
    prefer: ['codex'],
    brief:
      'You review a change to the storefront that somebody else wrote. Read the whole diff before you report, and hold every change to the checkout rules: money in minor units, retries capped, nothing charged twice.\n\n## How to report\n\nEvery finding with its file and line, blocking ones first, then a verdict: approve, or request changes.',
  }),
)

writeAgent(
  join(HOME, 'agents', 'release-checker'),
  agentFile({
    name: 'Release checker',
    description: 'Reads a release branch against its changelog before it is tagged.',
    // Signed out, then not added here at all: two reasons, two fixes, and no seat.
    prefer: [rigRuntimeId('windsurf'), 'claude-code'],
    brief:
      'You check a release branch before it is tagged: every change in the changelog is in the branch, and every change in the branch is in the changelog.\n\n## How to report\n\nWhat is missing from each side, then a verdict.',
  }),
)

writeFileSync(
  join(HOME, 'seating.json'),
  `${JSON.stringify({ 'code-reviewer': [rigRuntimeId('windsurf'), `${rigRuntimeId('claude-code')}=opus`] }, null, 2)}\n`,
)
say('agents: storefront’s Code reviewer (shadows the one that ships), Release checker (yours), seats for this Mac')
```

2. In `script/shots/accounts.mjs`, add to `ACCOUNTS`, after `copilot`:

```js
  // Signed out — the state a refusal names — on the one seat no other scene uses.
  windsurf: status(),
```

- [ ] **Step 4: One scene per surface**

In `script/shots/shoot.mjs`, just before the line that reads `--scene` arguments (`const named = argv.flatMap(…)`), add:

```js
  /* ------------------------------------------------------------ Agents */

  const PROJECT_AGENT = join(REPO, '.harnessdesk', 'agents', 'code-reviewer', 'AGENT.md')

  /** What an earlier Agent scene may have left up: the refusal sheet, a dialog, the palette. */
  const clearAgentScenes = async () => {
    await cdp.eval(`${STORE}.dismissSeatRefusal(); true`)
    for (let n = 0; n < 2; n += 1) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await sleep(150)
    }
  }

  /** The storefront open, and its roster and seats read, before a surface draws them. */
  const openStorefront = async () => {
    await clearAgentScenes()
    await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
    await cdp.eval(`${STORE}.loadAgents()`, 120_000)
    await sleep(900)
  }

  /** Types into an input found by its label, the way the flow scene fills its dialog. */
  const fill = (label, value) => cdp.eval(`(() => {
    const tag = [...document.querySelectorAll('label')].find((one) => one.textContent.trim() === ${q(label)})
    const input = tag && document.getElementById(tag.getAttribute('for'))
    if (!input) return false
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, ${q(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

  Object.assign(SCENES, {
    /** Settings › Agents: three sections, and the project's reviewer shadowing the one that ships. */
    'settings-agents': { leaveOverlay: true, expect: 'Shadowed by the one in storefront', run: async () => {
      await openStorefront()
      await cdp.eval(`${STORE}.askSettings('agents'); true`)
      await sleep(1400)
    } },

    /** An Agent's page: its file, its ceiling, its own seats muted, and this Mac's. */
    'agent-page': { leaveOverlay: true, expect: 'On this Mac', run: async () => {
      await openStorefront()
      await cdp.eval(`${STORE}.askSettings('agents', 'code-reviewer'); true`)
      await sleep(1400)
    } },

    /** Workspaces › a project: its own Agents, and the folder they are read from. */
    'project-page': { leaveOverlay: true, expect: 'Its own, read from', run: async () => {
      await openStorefront()
      await cdp.eval(`${STORE}.askSettings('workspaces', ${q(REPO)}); true`)
      await sleep(1400)
    } },

    /** The new-session dialog: Agents first, and the one that cannot be seated greyed with why. */
    'new-session-agents': { leaveOverlay: true, expect: 'Windsurf is signed out', run: async () => {
      await openStorefront()
      if (!(await click('New'))) throw new Error('no New button in the title bar')
      await sleep(1200)
      if (!(await cdp.eval(`document.body.innerText.includes('As an Agent')`))) throw new Error('the dialog lists no Agents')
    } },

    /** ⌘K, through the sidebar's magnifier: an Agent to start as. */
    'palette-agents': { leaveOverlay: true, expect: 'Start as Code reviewer', run: async () => {
      await openStorefront()
      if (!(await click('Search everything'))) throw new Error('no search in the sidebar')
      await sleep(600)
      await cdp.eval(`(() => {
        const input = document.querySelector('[role="dialog"] input')
        if (!input) return false
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Start as')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await sleep(900)
    } },

    /** Start as Code reviewer: headed by it, and its name card, open, naming the seat and the one passed over. */
    'conversation-agent-card': {
      leaveOverlay: true,
      expect: 'Seated on Claude · Opus',
      hover: 'button[data-active] [class*="statusTarget"]',
      run: async () => {
        await openStorefront()
        const key = await cdp.eval(`${STORE}.startAsAgent('code-reviewer')`, 180_000)
        if (!key) throw new Error('Code reviewer was not seated: ' + await cdp.eval(`JSON.stringify(${STORE}.getSnapshot().seatRefusal)`))
        // Long enough for the brief's turn to finish.
        await sleep(6500)
        const headed = await cdp.eval(`[...document.querySelectorAll('header [class*="title"]')].some((one) => (one.textContent ?? '').startsWith('Code reviewer'))`)
        if (!headed) throw new Error('the conversation is not headed Code reviewer')
        // The file moves on after the conversation started, which is what the card's caution is for.
        writeFileSync(PROJECT_AGENT, `${readFileSync(PROJECT_AGENT, 'utf8')}\nRead docs/checkout.md before the diff.\n`)
        await sleep(2500)
      },
      verify: async () => {
        await waitForSnapshot(
          () => cdp.eval(`document.querySelector('[data-slot="agent-card"]')?.textContent ?? ''`),
          (text) => text.includes('Passed over Windsurf') && text.includes('The brief has changed since this started.'),
        )
      },
    },

    /** The refusal sheet: every seat, its reason and its fix — and nothing opened. */
    'refusal-sheet': { leaveOverlay: true, expect: 'Nothing was opened.', run: async () => {
      await openStorefront()
      const before = await cdp.eval(`${STORE}.getSnapshot().sessions.size`)
      const key = await cdp.eval(`${STORE}.startAsAgent('release-checker')`, 180_000)
      await sleep(1200)
      const after = await cdp.eval(`${STORE}.getSnapshot().sessions.size`)
      if (key !== null || after !== before) throw new Error(`a refused seating opened something (${before} → ${after})`)
      const listed = await cdp.eval(`${STORE}.getSnapshot().seatRefusal?.candidates.length ?? 0`)
      if (listed !== 2) throw new Error(`the sheet lists ${listed} candidates, not both`)
      if (!(await cdp.eval(`document.body.innerText.includes('Sign in to Windsurf')`))) {
        throw new Error('the signed-out candidate offers no Sign in')
      }
    } },

    /** Save as an Agent…, from a conversation's ⋯, with its name typed. */
    'save-as-agent': { leaveOverlay: true, expect: 'Save and open the brief', run: async () => {
      await openStorefront()
      await seat(cdp, { work: REPO, runtime: 'codex', picks: {} })
      await sleep(1500)
      if (!(await click('Conversation'))) throw new Error('no ⋯ on the conversation')
      if (!(await click('Save as an Agent…'))) throw new Error('no Save as an Agent… in its menu')
      if (!(await fill('Name', 'Checkout reviewer'))) throw new Error('no Name field')
      await fill('What it is for', 'Reads checkout changes against the storefront’s rules.')
      await sleep(700)
    } },

    /** A room's +: the project's Agents first, each with the seat it would take there. */
    'add-member-agents': { leaveOverlay: true, expect: 'Who joins', run: async () => {
      await clearAgentScenes()
      await stageRoom()
      await cdp.eval(`${STORE}.openTeamRoom(${q(roomId)}); true`)
      await sleep(1500)
      if (!(await click('Add an agent to the room'))) throw new Error('no + on the room’s roster')
      await sleep(1800)
    } },
  })
```

   (`seat`, `waitForSnapshot`, `readFileSync` and `writeFileSync` are imported already.)

- [ ] **Step 5: Run the gate tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec script/shots-isolation.test.mjs script/shots-audit.test.mjs`
Expected: PASS — the new test, and every audit test unchanged: the rig's own desk is still publishable with a seat signed out.

- [ ] **Step 6: Launch the app and take the pictures**

The frames come from the built bundle, so build first — a stale `packages/ui/dist` photographs the previous commit. Quit any desk already open on `~/.harnessdesk-shots`. Then:

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm run build:node && pnpm --filter @harnessdesk/ui run build
node script/shots/seed.mjs --clean
SHOTS="$(mktemp -d /tmp/hd-phase2-shots.XXXX)"
node script/shots/shoot.mjs --out "$SHOTS" \
  --scene settings-agents --scene agent-page --scene settings-runtimes --scene project-page \
  --scene new-session-agents --scene palette-agents --scene conversation-agent-card \
  --scene refusal-sheet --scene save-as-agent --scene add-member-agents
ls "$SHOTS"
```

Expected: one `✓ <scene>-light.png` and one `✓ <scene>-dark.png` line per scene — twenty frames — and no `is not publishable` refusal from the audit. A refusal names what it found; fix the cause — a surface that printed an absolute path, an account the rig did not author — and take again. The audit is never loosened to let a frame through.

- [ ] **Step 7: Look at every frame**

Open each PNG (`Read` it; do not trust the file list). For each, confirm against the scene's *Proves* column, in both themes, and that nothing in it names a person other than the demo persona or shows a path outside `~/work` and `~/.harnessdesk-shots`:

- `settings-agents`: *In storefront* with *Code reviewer* on *Claude · Opus*; *Yours* with *Release checker* reading *Can't seat here · Windsurf is signed out*; *Built in* with the nine, each on *Codex*, and the muted *Code reviewer* reading *Shadowed by the one in storefront*; every ceiling *· asked*; the nav row *Agents* with its count.
- `agent-page`: *Code reviewer*, *In storefront*, its file from `~`, *Comes first over the one that ships*; *Seats* muted under *Not used on this Mac*; *On this Mac*: *Windsurf* passed over, *Claude · Opus* taken, the footnote naming `seating.json`.
- `settings-runtimes`: titled *Runtimes*, *Add a runtime*, Windsurf wanting a sign-in.
- `project-page`: *storefront*, *Current*, *Code reviewer* under *Agents*.
- `new-session-agents`: *As an Agent* above *A session*; *Release checker* greyed with *Windsurf is signed out*.
- `palette-agents`: *Start as Code reviewer* with its seat, and the other Agents below it.
- `conversation-agent-card`: the header *Code reviewer*; the card's *Agent* band — *Seated on Claude · Opus*, *Passed over Windsurf — Windsurf is signed out* — and the warning *The brief has changed since this started.*
- `refusal-sheet`: *Release checker can’t be seated here*, *Nothing was opened.*, Windsurf with *Sign in to Windsurf*, Claude Code with *Add Claude Code*, *Edit seats for this Mac*.
- `save-as-agent`: the name and line typed, *Read · asked* chosen, *For storefront* naming `seating.json`, the seat in words.
- `add-member-agents`: *Who joins* with *An Agent* chosen, the Agents each with a seat, *Release checker* greyed with its reason.

- [ ] **Step 8: Commit the rig — never the pictures**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add script/shots/seed.mjs script/shots/accounts.mjs script/shots/shoot.mjs script/shots-isolation.test.mjs
git status --short docs/images
git commit -m "test(shots): the staged desk has Agents, and a scene per Agent surface

The rig's desk gains the storefront's own Code reviewer, which shadows the
one that ships, an Agent of yours that nothing there can seat, this Mac's seats
for the reviewer and a runtime that is signed out where the host asks. Ten
scenes photograph the roster, an Agent's page, Runtimes, a project's page, the
new-session dialog, ⌘K, a conversation seated as an Agent with its card, the
refusal sheet, Save as an Agent and a room's +, and the takes that the
roadmap's Done when rests on fail when it does not hold.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0`; `git status --short docs/images` prints nothing — the frames are in `$SHOTS`, outside the repository.

- [ ] **Step 9: Open Part B's pull request with the pictures**

Push the branch and open the pull request against Part A's branch. Its body lists each surface with its light frame from `$SHOTS` attached, and says the dark ones were looked at too; it names the decisions this plan took that the roadmap did not settle (the self-review below lists them), and ends with the attribution line the repository's pull requests carry. The owner's landing rule for HarnessDesk pull requests governs everything after that — review, fixes, merge — and nothing is merged on this plan's say-so.

---

## Self-review against the roadmap

| Phase 2 asks for | Where |
| --- | --- |
| A passed-over candidate leaves no conversation behind, said honestly per runtime | Task 3 (the per-runtime table; `#discardSeat`; `session/removed`) |
| The reads before choosing have a deadline; a runtime that never answers is passed over with that reason | Task 2 |
| A dry run of `agent/seat` that opens nothing; every menu drawn from it | Task 4; the Agent's own list beside this Mac's, Task 15 |
| `~/.harnessdesk/seating.json` replacing `prefer`; precedence *seats → this Mac → prefer*; validated on the way in, never dropped silently; a verb to write it | Task 6; edited on the Agent's page, Task 16 |
| Nine shipped Agents naming runtimes, not models; ceilings in today's words under `permission:`; full briefs; each tested to parse and to seat on fakes; shipped in the package | Task 7 |
| The roster re-reads when a file under any root changes | Task 8 (host), Task 12 (renderer) |
| Refuse, never substitute: the refusal is every candidate with its reason and fix | Tasks 1, 5, 14 |
| Settings › Runtimes, every door that meant the CLIs moved, and a test that nothing opens the roster to ask for a sign-in | Task 11, with each later door to the roster allowed by name (Tasks 14, 17) |
| Settings › Agents: three sections footnoted with their folders, shadowed rows muted, broken files with why, a counted nav row with a dot only for a broken file | Tasks 12–13 |
| An Agent's page: file with *Open file* and *Reveal*, Ceiling, Seats with state and fix, On this Mac, Answers/Produces/Skills, Brief, *Start*, *Customize…*, *Remove…* | Tasks 9, 15, 16 |
| Workspaces › a project, from Workspaces and from the sidebar's project menu | Task 17 |
| Models › Presets: only the example changes | Task 11 |
| New-session dialog lists Agents above runtimes, with the mark they would sit on; greyed, never withdrawn | Task 14 |
| ⌘K *Start as <Agent>* and *Open <Agent> in Settings*; ⌘N unchanged | Task 14 |
| Pane header and sidebar row lead with the Agent; the composer shows the seat taken, as read back | Task 18 |
| Name card: description, ceiling, origin, seat, candidates passed over, *The brief has changed since this started* | Task 18 |
| The refusal sheet, *Edit seats for this Mac* beneath | Task 14 |
| *Save as an Agent…*: name, description, ceiling, the conversation's seat first; to you or the project; the brief opened | Tasks 9, 19 |
| A room's **+** seats an Agent first; a member seated as an Agent goes by its name on the rail and cards | Task 20 (and the card's band, Task 18) |
| Every ceiling reads *asked* | `ceilingWords` (Task 12), on every surface that shows one (Tasks 13, 15, 17, 18, 19) |
| No wire names, seat specs or digests on screen | `lib/agents.ts` (Tasks 12, 14–16, 18, 19); asserted in Tasks 13, 14 and 19 |
| Documentation: `docs/agents.md`, `interface.md`, `runtimes.md`, `multi-agent.md`; `agent/*` unpinned; doc paths that resolve | Task 21 (unpinning across Tasks 12, 14, 15, 16, 18, 19) |
| *Done when* | Task 22's `settings-agents`, `conversation-agent-card` and `refusal-sheet` fail the take unless it holds |
| Verified in the launched app, one picture per surface, audit untouched | Task 22 |

**Placeholders.** None: every step carries its code, its command and what it prints. An ellipsis in a step is a locator in existing code (*after `const root = …`*) or a label the interface prints, never an elision of what to write.

**Names across tasks.** Checked end to end: the protocol's `SeatReason`, `SeatFix`, `SeatLeft`, `SeatCandidate` (with `left?`), `SeatPlan` (with `from`, `blocked` and, from Task 15, `own?`), `MachineSeating`, `SeatingProblem`; the store's `loadAgents`, `loadAgentPlans`, `agentsIn`, `plansIn`, `startAsAgent`, `dismissSeatRefusal`, `askSettings(section, focus)`, `askSeatFix`, `revealAgent`, `customizeAgent`, `trashAgent`, `loadSeating`, `setSeating`, `readSeatAgent`, `saveAsAgent`; the snapshot's `agents`, `agentsProject`, `agentPlans`, `stateDir`, `settingsFocus`, `seatRefusal`, `seatFix`, `seating`, `seatAgents` — each defined in the task that first uses it, with the same signature everywhere after. The preview store answers the three whose result a screen reads (`agentsIn`, `plansIn`, `modelsFor`); every other new verb falls through to its no-op, which each caller survives.

**Pinned verbs.** 5 before phase 2; 6, 8 and 12 through Part A (Tasks 4, 6, 9); 10, 9, 6, 4, 3 and 2 through Part B (Tasks 12, 14, 15, 16, 18, 19) — the two that were there before phase 1.

## Decisions this plan took that the roadmap did not settle

For the pull requests' bodies — each is argued where it is made:

- **Runtime ids in `prefer`** are the registry's: `claude-code`, not `claude` (Global Constraints).
- **Nothing started from the app grants more than `read`**; a ceiling is a ceiling (Global Constraints, Task 14).
- **A seating override that cannot be read refuses** its Agent's seating rather than fall back to `prefer`; a file that is not JSON is never written over (Task 6).
- **The pre-choice deadline is ten seconds**, and usage that misses it falls back to the last reading, with a log line (Task 2).
- **A runtime that cannot delete a conversation** has the passed-over one archived and forgotten, and the refusal says so for that candidate (Task 3); `#openSeat`'s own failure path discards the same way, which flows get too.
- **`session/removed` and `agent/changed`** follow the plane's `…/changed` and `runtime/removed` naming; `agent/seat/dry` follows `flow/dry` and takes a batch of ids (Tasks 3, 4, 6).
- **The refusal travels as a typed error with data** (`WireError.data`), the first such (Task 5).
- **Saved to a project, an Agent names its runtime alone**, and this Mac keeps the exact seat in `seating.json` (Tasks 9, 19); **saved to "the project"** means the open one, not a conversation's worktree (Task 19).
- **A backup carries your Agents and this Mac's seats** under `agentFolders` and `seating` — `agents` already means runtimes in a backup (Task 10).
- **⌘, keeps opening Runtimes**, where the one state that stops a first session lives (Task 11).
- **A shipped Agent's file is named inside the app** (*HarnessDesk › agents/<id>/AGENT.md*), and this Mac's folder comes from `host/hello`'s `stateDir` (Task 13).
- **A folder is read as the checkout it is in**: an open subfolder lists its repository's Agents, a worktree its own branch's (Task 12).
- **The refusal sheet and a seat's fixes are store requests**, like `askSettings`, taken by one effect in `App` (Task 14).
- **An Agent's page lists its own `prefer` with states even where this Mac's seats replace it** — muted — so the dry run weighs both (Task 15).
- **Every folder on Workspaces drills**, and *Open*/*Forget* move onto the project's page (Task 17).
- **The Agent's name leads the header only once it is read** (`agent/read`, cached per folder and id); nothing leads after a restart until phase 4 makes the seat record durable (Task 18).
- **A member seated as an Agent is named for it in the room** — its nickname, the name it is addressed by — which needs the Agent's name kept on the host's seat record (Task 20).
- **Two more pages change than the roadmap's table names**: `docs/getting-started.md` and `docs/design.md` send readers to *Settings › Agents* for what is now *Settings › Runtimes* (Task 21).
- **The rig signs one runtime out** (Windsurf, which no other scene seats) where both the host and the renderer ask, and photographs ⌘K as well as the nine surfaces listed for it (Task 22).

## Deliberately not in this phase

- **`ceiling:`, the four-word ladder, *held*, and enforcement at the tool surface** — phase 3. Every surface says *asked*; nothing here parses or writes `ceiling:`.
- **A durable seat record** — phase 4. `SessionRecord.seatedAs` stays in memory; a restarted desk shows a seated conversation as a plain one.
- **Goals, lanes, flows seating Agents (`uses`), triggers** — phases 5, 6 and 8. A flow's `seats` still name runtimes.
- **Editing an Agent's skills or notes, and per-Agent servers** — phase 12. *Skills* is read-only and links to the Library.
- **Removing or editing what ships.** *Customize…* copies it somewhere that comes first; the built-in folder is read-only to the editor.
