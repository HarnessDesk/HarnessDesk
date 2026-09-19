# Goal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. One implementer owns the whole phase; there are no per-task agent reviews. The controller reviews one pull request after the phase is complete.

**Goal:** Replace the room and its nested Plans with one finishable Goal, derive its members from durable Seats, isolate requested Seats in lanes, preserve every existing room on upgrade, and wrap the work into an immutable receipt.

**Architecture:** Keep `Team` as the board-and-channel engine and move container ownership into `GoalPlane`. A versioned store in the desk's state directory holds Goal documents and their board/channel payloads; phase 4's append-only evidence store remains the sole source of Seat membership and observed facts. A lane allocator supplies one checkout, a disjoint port interval and a scoped browser to each isolated Seat. Wrapping is a journaled operation: preview, validate again, freeze mutations, close the Goal's Seats, then commit its receipt.

**Tech Stack:** TypeScript ESM, existing pnpm workspaces, `node:test` and `node:assert/strict` for production host tests, React and Vitest for UI tests, Electron webview partitions, existing git worktree and adapter services. No new dependency.

**Scope:** Phase 5 of 12; dependencies are phases 2 and 4. Phase 3 is optional at this boundary: preserve whichever `StandingOrder` and `SeatCeiling` were actually recorded. Flow topology, flow-file conversion, intake execution, findings production, provenance, spend collection and shared memory policy belong to later phases.

## Read before implementation

Read the architecture, interface and decisions documents, the roadmap's complete **5. Goal**, its common surface/driving/messaging rules, and the design spec's Goal, Evidence, interaction, replacement and receipt sections. Read phase 4's **The seam with phase 3**, Tasks 1–6, 10, 12–14 and 20; its revised plan is `docs/superpowers/plans/2026-09-18-agents-evidence-ledger.md` in the phase-4 planning worktree. This phase consumes the declarations there, not the shorter illustrative types in the design spec.

This checkout contains phase 2 Part A at the phase brief's base (`0a6cc108`). The Part B checkout was inspected read-only at `88c87237` and rechecked at `82ef26a8`: its Agent page is present, while `AddMember.tsx` still contains the old new/running-conversation join paths. Implement on phase 2's completed Part B and phase 4, preserving their Agent display names, dry-run refusals, recorded picks and evidence surfaces. There was no phase-3 ceilings plan in its plans directory when this plan was written; no unpublished phase-3 names are assumed below.

### Current code, and the boundary each task changes

| Current source | What is actually there | This phase |
| --- | --- | --- |
| `packages/protocol/src/team.ts` | `Plan` is `{id: number, goal, state: running|wrapped, createdAt, wrappedAt?}`; `Intent.plan` associates cards. `TeamState.members` is a session-key array. | Goal replaces the container plus its live Plan; old Plans and card associations remain migration history. |
| `packages/protocol/src/plan.ts` | Normalization of runtime todo entries and `PlanStatus`. | **Leave it alone.** It is unrelated to the room's `Plan`. |
| `packages/server/src/team.ts` | Private `Board`, `StoredBoard.version: 1`, one JSON file per room in `team/`, independent `inbound.json`, explicit members/roles/roster, serialized/coalesced writes. `load()` also understands the old path-keyed board format and repairs roots. | Seat-derived projection, Goal store persistence, same board/channel guard paths. |
| `packages/server/src/methods/team.ts` | `team/room/join` proves live/stored runtime existence and project ownership; `team/plan` and `team/wrap` only operate on headings. | Remove membership and Plan creation wire verbs; preserve their existence/project checks in assignment. |
| `packages/server/src/flows.ts` | `FlowPort.join`, `isolate`, `seat`, `recorded?` (phase 4); persisted runs name `room`. Isolated roles currently get only a worktree. | Route existing flow seats through Goal Seat/lane services without changing the legacy flow-file grammar. |
| `packages/server/src/host.ts` | Owns Team, Flows, worktrees, runtime session creation and event fan-out. | Own GoalPlane and LaneAllocator, wire events and browser invocation scope here. |
| `packages/server/src/state.ts` | Desk-wide machine preferences in `state.json`. | `preferences.lanes`, defaults `{start: 30000, width: 20, browserProfile: true}`. |
| `packages/adapter-codex/src/runtime.ts`, `packages/adapter-acp/src/runtime.ts` | Shared runtime process environment; `SessionOptions` has no session environment. ACP's options ride an explicit metadata extension. | Add a negotiated session-environment capability; never change `process.env` to seat a lane. |
| `packages/cordis-host/src/browser.ts` | Module-level browser state, one driven browser per plugin host. | Per-authorized-invocation profile state. |
| `packages/desktop/electron/browser-engine.mjs`, `BrowserPane.tsx` | One driven guest; ordinary partitions are `persist:harnessdesk-browser` and `harnessdesk-browser-once`. | A driven guest per lane profile, retaining today's ordinary partitions. |
| `TeamRoomPane.tsx`, `TeamBoardPane.tsx`, `SessionTree.tsx`, `NewSessionChoice.tsx`, `AddMember.tsx` | Room header/rail, nested Plan chips, stored-room members, direct loose-session adoption. | Goal header/rail and wrapped group; card assignment opens a Seat; Release closes it. |

## Decisions this plan takes

1. **Lifecycle is `open | wrapping | wrapped`.** `working | needs-you | ready-to-wrap` is a computed activity for an unwrapped Goal, not another mutable lifecycle. Empty Goals are open, not automatically ready. Waiting dependencies are listed separately; pending human requests take precedence over busy work.
2. **A Goal belongs to one project.** `dependsOn` can name existing Goals in that project, with at most 128 unique edges, no self-edge and no cycles. It gates work being dispatched and wrapping, not whether a person can write cards or read history. A missing dependency is unfinished. It never grants access to another channel.
3. **Preserve legacy room IDs exactly, including IDs that are paths.** New IDs use `goal-<uuid>`. File names always use `encodeURIComponent`; never interpolate an ID as a path segment without it.
4. **Every migrated room opens as an open Goal.** A wrapped Plan did not close its room, and therefore proves no container completion. Choose the newest running Plan's sentence; otherwise the newest Plan's sentence; otherwise the room name/folder name. Ties use Plan ID. Keep every Plan and every `Intent.plan` association as read-only history. Do not split a room into several Goals or mint a receipt for work nobody wrapped.
5. **Migration is staged and retryable.** Keep `team/` and `inbound.json` byte-for-byte. Validate the entire desk, stage Goal documents, idempotently import missing Seat openings, then activate with one directory rename. A failure exposes the original rooms through a read-only compatibility projection and an actionable banner; it neither starts an empty desk nor runs flows against a partial migration. No mutation or agent traffic starts before activation and recovery finish.
6. **Legacy metadata is not invented evidence.** A new legacy Seat has `agent: null`, `briefDigest: null`, `ceiling: null`; runtime/session come from the actual member key. Its known cwd comes from the roster, otherwise the room cwd/root is explicitly recorded as an inferred location in migration metadata. Unreadable revisions have `branch: null, head: null`. The original inbound policy remains authoritative. An existing kept phase-4 Seat with this board and session is reused, preserving its truthful Agent/brief/ceiling rather than copying it or falsifying it as anonymous.
7. **Phase 4 needs one explicit durable vocabulary extension:** add `{kind: 'unknown'}` to `StandingOrder` for an imported room member with no recorded standing order. It displays “Not recorded”. Never manufacture `permission: read`, since its historical meaning permits editing. No existing `SeatRecord` field is renamed or removed. This requires named updates to phase 4's reader, type tests and Seat-record words; it is a deliberate seam change, not a hidden fallback.
8. **One active Goal Seat per conversation, one active card per Seat.** An ordinary standalone Agent Seat with `board: null` is history, not membership. Assigning its conversation closes that standalone opening as `assigned` and writes a new immutable Goal Seat preserving its Agent/brief/standing/ceiling. Release closes only the requested Goal Seat as `released`, releases its unfinished claim, and leaves the conversation and transcript available at project level.
9. **No general join verb.** `goal/seat` opens a new assigned Agent Seat (optionally with its first card). `goal/assign` gives a specified card to an existing idle loose conversation and creates its Seat. Neither silently steals a conversation from another Goal. Bare runtime seats remain an internal legacy-flow compatibility path; the new Goal staffing surface names Agents.
10. **Port allocation is machine-wide, across projects and Goals.** Valid start: 1024–65535; width: 1–1000, wholly below 65536. Default 30000/20. Scan complete blocks in ascending order, honoring all existing absolute intervals even after preferences change. Exhaustion refuses before a Seat or checkout opens and names Release a retained lane or Workspaces › Lanes as the fixes. A finite availability scan may skip externally occupied blocks; a probe cannot reserve against unrelated applications forever.
11. **Exactly six environment variables:** `HARNESSDESK_GOAL_ID`, `HARNESSDESK_LANE_ID`, `HARNESSDESK_PORT_START`, `HARNESSDESK_PORT_END` (inclusive), `HARNESSDESK_PORT_COUNT`, and `PORT` (the first port). The runtime's child process receives them; the brief also names the allocation. No `.env` or configuration file is written to the repository. Applications that ignore `PORT` must be started with their own explicit port argument from the block.
12. **Profile isolation defaults on and is recorded per allocation.** When the machine preference is off, show that browser state is shared before seating. The lane still receives its own checkout and ports. Changing the preference affects new lanes only. A lane profile uses an opaque host-minted key and an Electron partition, or a separate host-controlled Chrome profile; it never selects a user's ordinary browser profile.
13. **Wrap retains lanes, clean or dirty.** Dirty, untracked or unreadable status is listed in the receipt. No wrap runs reset, stash, merge, worktree removal or branch deletion. Retained lanes keep their port leases and profiles. `lane/release` is an explicit person action: refuse if its Seat is active or any port still listens, release the port lease only, and keep checkout/branch/profile for the ordinary workspace cleanup UI. Unknown process state after restart never causes PID-based killing or automatic reuse.
14. **Environment support is a capability, not a prompt promise.** Codex receives per-thread shell-environment overrides; bundled ACP bridges negotiate `sessionEnvironment` and feed per-session child options. Other ACP peers that cannot acknowledge it refuse an isolated Seat, listing the candidate and fix. Plain conversations still use their normal shared runtime. No per-lane runtime ID or cloned account/home is introduced.
15. **Preserve all messaging guards in Team.** Names and membership sources change; rate/size/repeat/pending guards, denial holds, inbound policy, user-queue precedence, audit attribution, escaped envelopes, mirror-only answers, detached-runtime handling and queued restart reconciliation do not. Migration copies stored states first; normal recovery then marks an undeliverable `queued` row refused with the existing restart reason. It never replays it.
16. **`await_member` captures the current turn.** It is event-driven, sends nothing and starts no turn. Default and maximum block: 50,000 ms, minimum 1,000 ms, matching the existing default that fits measured tool deadlines. `cycle` is a nonnegative safe integer below `Number.MAX_SAFE_INTEGER`; answers end `; cycle: N`. A restarted next turn cannot extend an already-completed wait. Self-wait refuses; a member outside this Goal answers `gone` without naming another Goal.
17. **Receipts freeze facts and preserve uncertainty.** Include all Goal Seats, including released/deleted ones, card resolutions, evidence IDs, answers with session+turn pointers and partial/stop flags, lane disposition, citations, observation revisions and explicit missing-data gaps. A host-observed answer is preserved as an answer, never turned into check/review/spend evidence. Spend unknown is not zero. Findings and spend producers stay with phases 7 and 11.
18. **Preview is not permission to race.** Bind the preview to Goal revision, cards, dependency states, evidence IDs, observed heads/dirty state, answers and the person's choices. Commit re-reads, refuses a changed preview, then journals `wrapping` before closing Seats. Recovery finishes that operation idempotently; it never “reopens” immutable Seat records. A wrapped Goal is permanently read-only; another effort creates another Goal.
19. **Existing flows remain runnable.** Replace their membership/isolation/persistence plumbing now; preserve stored run IDs, `room` keys and flow grammar until phase 6. Do not run phase 4's asynchronous `FlowPort.recorded` path in addition to the new awaited Seat opening. A flow that cannot durably record a Seat fails and retires that new conversation.
20. **Runtime/inbound/legacy names remain compatibility details.** The visible container is Goal. `TeamState`, `CardRef.board`, `SeatRecord.board`, `BoardEvidence.room`, `evidence/board {room}`, stored `FlowRun.room`, and the room panel's persisted navigation discriminant remain readable. Do not rewrite evidence or old navigation just to improve a private name.
21. **Backup remains history-safe.** Back up Goal documents, receipts, migration metadata and lane descriptors, but not browser cookies, worktree contents, machine lane preferences or live port ownership. Phase 4 still marks imported Seats/facts `restored`. Restored open Goals appear as read-only history with an explicit gap; they acquire no active membership and never reserve ports or restart flows. New work starts a new Goal.
22. **One writer is enforced before any state changes.** Acquire an exclusive desk writer lease before StateStore migration, Goal migration and flow startup. An already-held lease refuses a second host with a sentence. A live or unidentifiable owner is never killed. A demonstrably dead owner can be recovered under an exclusive create/compare operation. Do not claim concurrent compatibility with an older binary that does not implement this lease.

23. **Goal activity uses phase 4’s existing evidence judgment.** Move its pure `placeCard`/`flowRoleOf` and `isCurrent`/`checkPassed`/`ciVerdict` rules to the protocol with renderer re-exports, without changing their signatures or verdicts. A card in Needs you makes the Goal need a person; pending review/check/CI keeps it working. An agent marking cards done cannot by itself make the Goal ready to wrap. A person can still review and explicitly wrap uncertain work with the gaps recorded. This is an explicit phase-4 ownership change.

## Global Constraints

- **A proof counts only if it was run.** This document distinguishes planning kernel tests, production integration tests and rendered acceptance. Never present one as another.
- **Never move a test below the thing it tests.** Wire validation is tested with `parseClientMessage`; host routing is tested with `Host.call`; a socket test remains a socket test.
- **Name every edit to a test you did not write.** Shared helper changes are named in the task and the final implementation report.
- **Run tests in the foreground.** Do not leave a child process or test loop running when handing work back.
- **A commit's trailer names who wrote it.** The controller runs the full gate and commits when the implementer's sandbox cannot write `.git` or bind listeners. This planning task makes no commit.
- **No reference-app or competitor names in anything public.** Runtime names are permitted only at their existing integration boundaries; the renderer reads presentation names from runtime data.
- **No real accounts or home paths in anything public; frames come from the shots rig.** Synthetic paths are `/work/repo`, identities are `Jane Doe`/`dev@example.com` or the project's public demo persona. Inspect every frame and added line before publication.
- **No hard-coded use cases.** A Goal, lane, receipt and wait work for any Agent and card.
- **The plain path stays plain.** Command-N still starts the ordinary default conversation immediately; no Goal heading without Goals, no Goal chip on a loose plain conversation, no new repository files on opening a surface.
- **Membership is derived from Seats, never stored beside them.** `TeamState.members`, roles and member names are projections; neither new Goal documents nor their mutable board payloads contain a member list. Historical migration metadata is never a membership source after activation.
- **Goals are desk state. Nothing is committed to the repository.** State paths below are relative to the host's state directory, respecting `HARNESSDESK_HOME`.
- **A message is information, never authority, and never evidence.** Messages stay within a Goal; only `dependsOn` crosses Goals, and it carries no automatic messages.
- **Refuse, never substitute.** An unavailable Agent or unsupported lane remains visible with a reason and fix. Do not fall back to the default runtime, a shared checkout, shared ports or shared browser without the person's explicit isolation choice.
- **Permission is a ceiling, never a grant.** Preserve phase 3's provenance and effective ceiling when present. Do not add new grants or weaken asked/held labeling.
- **Sentences, not wire.** Goal IDs, digest strings, method names and seat specs are not product labels. A receipt may name a file the person opens, and a revision in its existing short-SHA idiom.
- **Compose design-system components. Stylesheets are layout-only.** Import from `packages/ui/src/design`, use `Chip` tones `neutral|brand|success|warning|danger|info`, and use `stateTone` for states it already knows. `Ready to wrap` is brand, not a green evidence verdict. Do not add Goal values to the evidence state map by cast.
- **Use the one navigation row from #813:** `Button variant="navigation" size="navigation"`, selection by `data-selected` or `data-current`, no row height/padding/weight declaration. Search fields use `Search`.
- **Before editing `Sidebar.module.css`, `SessionTree` or a `design/ui` primitive, the implementer must message the UI session.** The phase consumes that session's row/state primitives; it does not invent a second implementation. This plan edits no primitive and adds no screen appearance stylesheet.
- **Every UI surface has empty, loading, failed and refused preview states**, keyboard access, visible focus and restored focus on dismissal. Rebuild before screenshots; inspect light, dark and a width below 720px. A fixture is not evidence that a frame was inspected.
- **A wire method is three edits in a fixed order:** declare in `packages/protocol/src/wire.ts`, validate in `packages/protocol/src/wire-validators.ts`, answer in `packages/server/src/methods/<domain>.ts`, through `HostContext`. Removed methods leave all three together. Add/remove `UNREACHED` pins with their first UI caller.
- **Codex types never escape `packages/adapter-codex`, and Cordis never escapes `packages/cordis-host`.** The new environment and browser scope types are backend-neutral.
- **Agent output is untrusted.** Answers, channel content, receipt summaries and legacy titles use the existing sanitized rendering path; no raw HTML is introduced.
- **Production server tests use `node:test` and `node:assert/strict`.** Build with `pnpm run build:node`, then run the named compiled test file. UI tests use per-file foreground Vitest. The temporary planning probes below use Vitest only as a scratch runner; they add no dependency or permanent alternate test framework to the server.
- **Before the implementation is committed, run `pnpm verify` unpiped** and read its exit status. This plan writer did not run it: the brief forbids its listener-dependent full gate in this sandbox. The controller owns that final gate, not an inferred green result.

## Proof needs and routing

| Task | Deliverable | Proof needs: | Implementer suited to that proof |
| --- | --- | --- | --- |
| 1 | Goal vocabulary, states and dependency graph | neither | Codex |
| 2 | Durable store, writer lease and complete desk upgrade | neither | Codex |
| 3 | Seat-derived membership, assignment/release and legacy flow bridge | neither | Codex |
| 4 | Lane allocation and machine preferences | a listener | Sonnet |
| 5 | Per-session environment through runtime adapters | neither | Codex |
| 6 | Scoped browser tools and pane profiles | the rendered UI | Sonnet |
| 7 | Goal channel names, guard preservation and member wait | neither | Codex |
| 8 | Receipt preview, wrap transaction and recovery | neither | Codex |
| 9 | Goal navigation, creation, pane, staffing and settings | the rendered UI | Sonnet |
| 10 | Wrap/receipt UI, notifications, backup, docs and acceptance | the rendered UI and a listener | Sonnet |

This is routing information for one owner, not permission to run ten independent implementers. The same writer must hold the migration, membership, flow and wrap contracts together.

## File map

| Files | Responsibility / task |
| --- | --- |
| `packages/protocol/src/goal.ts` (new), `index.ts` | Goal, activity, receipt, citation, lane types and pure derivations (1, 4, 8) |
| `packages/protocol/src/board-facts.ts`, `evidence-status.ts` (new); `packages/ui/src/lib/board-facts.ts`, `evidence.ts` | Share phase 4’s unchanged pure placement/verdict rules between host and renderer (1, 3) |
| `packages/protocol/src/evidence.ts` | Add only the explicit unknown standing-order arm (2) |
| `packages/server/src/goals/store.ts`, `migration.ts`, `writer-lease.ts`, `operations.ts` (new) | Durable documents, upgrade, one writer, journal replay (2, 3, 8) |
| `packages/server/src/goals/plane.ts`, `assignments.ts`, `members.ts` (new) | Goal lifecycle and authoritative Seat-derived membership (3) |
| `packages/server/src/evidence/seats.ts`, `records.ts`, `plane.ts`, `observe.ts`, `check-runs.ts` | Exact phase-4 seams: enumerable Seats, idempotent import, close by ID, unknown reader, wrap barrier/gate (2, 3, 8) |
| `packages/server/src/goals/lanes.ts`, `lane-environment.ts` (new) | Lane reservations, preferences, environment (4, 5) |
| `packages/server/src/goals/member-waits.ts`, `wrap.ts` (new) | Event wait and receipt transaction (7, 8) |
| `packages/server/src/team.ts`, `flows.ts`, `host.ts`, `state.ts` | Existing engine integration, startup, preferences, event fan-out (2–8) |
| `packages/protocol/src/wire.ts`, `wire-validators.ts`; `packages/server/src/methods/goals.ts`, `lanes.ts` (new), `team.ts`, `agents.ts`, `context.ts`, `index.ts`; `script/check-reachable.mjs` | Wire contracts and validation (1–4, 8–10) |
| `packages/protocol/src/session.ts`, `runtime.ts`; `packages/adapter-codex/src/runtime.ts`; `packages/adapter-acp/src/runtime.ts`; `packages/claude-acp/src/bridge.ts`; `packages/cursor-acp/src/bridge.ts` | Negotiated environment propagation on create/resume/fork/re-arm (5) |
| `packages/cordis-host/src/browser.ts`, `browser-scopes.ts` (new), `kernel.ts`, `team.ts`, `context.ts`, `index.ts`; `packages/plugins/src/team.ts` | Browser capability scope, `awaitMember`/`await_member` (6, 7) |
| `packages/extension-protocol/src/index.ts`; `packages/extension-host/src/child.ts`, `supervisor.ts` | Browser invocation attribution across the child boundary (6) |
| `packages/desktop/electron/browser-engine.mjs`, `main.mjs`, `preload.cjs`; `packages/ui/src/lib/desktop.ts`, `components/BrowserPane.tsx`, `state/store.ts`, `state/snapshot.ts` | Scope browser IPC, tab state and webview partitions (6) |
| `packages/ui/src/lib/goals.ts`, `components/GoalCreate.tsx`, `GoalHeader.tsx`, `GoalWrap.tsx`, `GoalReceipt.tsx`, `GoalAssign.tsx`, `LaneSettings.tsx` (new) | Goal UI composed from canonical roles (9, 10) |
| `packages/ui/src/components/SessionTree.tsx`, `TeamRoomPane.tsx`, `TeamBoardPane.tsx`, `NewSessionChoice.tsx`, `AddMember.tsx`, `FlowStart.tsx`, `Settings.tsx`, `ProjectPage.tsx`; `app/App.tsx` | Existing navigation and screen integration (9, 10) |
| `packages/ui/src/lib/system-notifications.ts`; `packages/desktop/electron/notifications.mjs` | Transition notifications (10) |
| `packages/ui/src/preview/goal-fixture.ts` (new), `harness.tsx`, `main.tsx`; `script/shots/seed.mjs`, `shoot.mjs` | All new states and isolated acceptance scenes (9, 10) |
| `packages/server/test/goal-*.test.ts`, `lane-*.test.ts`; `packages/protocol/test/goal.test.ts`; adapter/bridge named tests below; `packages/ui/src/components/Goal*.test.tsx`, `LaneSettings.test.tsx` | Focused tests named per task |
| `docs/architecture.md`, `interface.md`, `multi-agent.md`, `data-boundaries.md`, `decisions.md`, `CHANGELOG.md` | Explain the behavior that actually ships (10) |

## Interfaces for later phases

This is the stable handoff. Types are defined in Task 1's `packages/protocol/src/goal.ts` and exported from `@harnessdesk/protocol`. `SeatRecord`, `SeatId`, `SessionPointer`, `EvidenceRecord`, `Sha`, `FlowSeat`, `StandingOrder` and `SeatCeiling` remain phase 4/2's types and paths.

| Consumer | Exact interface | Contract |
| --- | --- | --- |
| 6, 8, 11, 12 | `Goal`, `GoalId = string`, `GoalState = 'open' | 'wrapping' | 'wrapped'`, `GoalActivity = 'working' | 'needs-you' | 'ready-to-wrap'` | Task 1 supplies the complete shape. `board === Goal.id`; membership does not live in Goal. Wrapped is terminal. |
| 6, 8 | `GoalPlane.create(input: GoalCreateInput): Promise<GoalView>` in `packages/server/src/goals/plane.ts` | Host-confined project/cwd, nonblank sentence, durable before answer; no implicit seating. |
| 6, 8 | `GoalCreateInput = { root: string; cwd?: string; sentence: string; checkout?: 'shared' | 'isolated'; dependsOn?: readonly GoalId[]; origin?: GoalOrigin }` | Public wire cannot set `origin`; host-owned flow/intake callers may. `GoalOrigin` has person/legacy/flow/trigger arms, never a trigger execution engine. |
| 6, 8 | `GoalPlane.seat(input: GoalSeatRequest): Promise<SeatRecord>`; `GoalSeatRequest = { goal: GoalId; agent: string; seats?: readonly FlowSeat[]; grant?: SeatGrant; card?: number; isolate?: boolean }` | `SeatGrant = {kind: 'permission'; permission: FlowPermission} | {kind: 'ceiling'; level: CeilingLevel}` preserves both generations. An unsupported ceiling grant refuses until phase 3 is installed; it is never converted to a legacy permission. Omitted grant means read in the Agent's own generation. The durable return always has `standing` and `ceiling` in phase 4's exact shape. Goal defaults govern isolation when omitted. |
| 6 | `GoalPlane.openLegacySeat(input: {goal: GoalId; spec: FlowSeat; permission: FlowPermission; role: string; isolate: boolean; title: string}): Promise<SeatRecord>` | Internal bridge for old flow files; never a general UI join verb. Opens, records and projects before the flow sends its standing order. |
| 6, 8 | `GoalPlane.assign(goal: GoalId, card: number, session: SessionPointer): Promise<SeatRecord>` | Existing loose conversation, same project, idle, existing claim checks, no other Goal Seat. New opening makes membership. |
| 6, 8 | `GoalPlane.release(goal: GoalId, seat: SeatId): Promise<void>` | Close requested kept Seat once as released; release unfinished card; keep conversation/transcript/checkout. |
| 6, 8 | `GoalPlane.dependenciesReady(goal: GoalId): boolean`; `GoalPlane.update(goal: GoalId, revision: number, patch: {sentence?: string; dependsOn?: readonly GoalId[]}): Promise<GoalView>` | Same-project acyclic graph, compare-and-swap revision. Dispatch waits on unwrapped/missing dependencies. No automatic channel access. |
| 6, 8 | `LaneAllocator.allocate(goal: GoalId, id: string, prefs: LanePreferences): Promise<Lane>`; `laneEnvironment(lane: Lane): Readonly<Record<string,string>>` in `goals/lanes.ts` | Explicit new lane ID, serialized global reservation, existing preferences, six exact variables in Decision 11. `Lane.seat` is bound once after the durable Seat is kept. |
| 6, 8 | `GoalPlane.laneFor(seat: SeatId): Lane | null`; `GoalPlane.canDispatch(goal: GoalId): {ok: true} | {ok: false; reason: string}` | Refuse restored history, wrapping/wrapped, unresolved migration, unfinished dependencies and any failed required resource allocation before dispatch. |
| 6, 8 | `Team.awaitMember(scope: TeamCallScope, options: {member: string; cycle?: number; blockMs?: number}): Promise<string>` | Plugin spelling `await_member(member, cycle?, block_ms?)`; event wait only within caller's Goal, one-line idle/stopped/still working/gone answer with next cycle. |
| 6, 8, 11 | `GoalPlane.preview(goal: GoalId, choices: WrapChoices): Promise<WrapPreview>`; `GoalPlane.wrap(goal: GoalId, stamp: string, choices: WrapChoices): Promise<GoalReceipt>` | Preview then compare/stage/close/finish. Person wrap is distinct from card answer or a flow reporting completion. `WrapPreview = {stamp: string; receipt: Omit<GoalReceipt,'id'|'wrappedAt'>}`. |
| 11, 12 | `GoalPlane.receipt(goal: GoalId): Promise<GoalReceipt | null>` | Immutable receipt; evidence IDs and Seat IDs join phase-4 store. Answer text has session+turn pointers, partial flag and stop reason. Gaps remain explicit. |
| 11 | `SeatBook.all(): readonly SeatRecord[]`; `factsOfGoal(goal: string, seats: readonly SeatRecord[], facts: readonly EvidenceRecord[]): EvidenceRecord[]` | Includes closed historical Goal Seats; selects facts by `card.board` or Goal Seat ID. No even allocation of unattributed cost. Phase 11 writes its own spend facts, not phase 5. |
| 12 | `GoalCitation = {goal: GoalId; receipt: string; project: string; path: string; at: Sha}`; `GoalPlane.cite(goal: GoalId, citation: GoalCitation): Promise<void>` | Target Goal must be open; source receipt exists; project is the same; path is relative without traversal; SHA is full 40/64 hex and names a committed blob at that path. Store a reference, never copy text. Source Goal is added to `dependsOn` atomically if absent. |
| 8, 11 | `{ method: 'goal/changed'; params: { view: GoalView } }`, `{method: 'goal/activity'; params: {goal: GoalId; previous: GoalActivity; activity: GoalActivity; sentence: string}}` | Changed replays state; activity is a real transition only, no startup flood. Intake can make held work visibly need a person; insight may attribute message-caused turns using phase 3's turn provenance, which this phase preserves. |

`GoalView = {goal: Goal; activity: GoalActivity | null; waitingOn: readonly {id: GoalId; sentence: string}[]; members: readonly SeatRecord[]; board: TeamState; receipt: GoalReceipt | null; problem: string | null}`. `members` and `board.members/roles/nicknames` are freshly derived; `receipt.seats` is historical attribution, never live membership. Goal documents persist `{version: 1, goal, board: GoalBoard, legacy?, citations, receipt, operation?}` where `GoalBoard` is `{nextIntent: number, messaging: boolean, intents: readonly Intent[], channel: readonly TeamEntry[]}`. The imported historical Plans live only in `legacy`, not a new mutable Plan API.

Wire calls, declared before handlers, all in `methods/goals.ts satisfies MethodsUnder<'goal/'>`:

```ts
'goal/list': { params: {root?: string}; result: readonly GoalView[] }
'goal/read': { params: {goal: GoalId}; result: GoalView }
'goal/create': { params: Omit<GoalCreateInput, 'origin'>; result: GoalView }
'goal/update': { params: {goal: GoalId; revision: number; sentence?: string; dependsOn?: readonly GoalId[]}; result: GoalView }
'goal/seat': { params: GoalSeatRequest; result: SeatRecord }
'goal/assign': { params: {goal: GoalId; card: number; session: SessionPointer}; result: SeatRecord }
'goal/release': { params: {goal: GoalId; seat: SeatId}; result: null }
'goal/wrap/preview': { params: {goal: GoalId; choices: WrapChoices}; result: WrapPreview }
'goal/wrap': { params: {goal: GoalId; stamp: string; choices: WrapChoices}; result: GoalReceipt }
'goal/receipt': { params: {goal: GoalId}; result: GoalReceipt | null }
'goal/cite': { params: {goal: GoalId; citation: GoalCitation}; result: null }
'goal/migration/ack': { params: Record<string, never>; result: null }
'lane/preferences': { params: Record<string, never>; result: LanePreferences }
'lane/preferences/set': { params: LanePreferences; result: LanePreferences }
'lane/release': { params: {lane: string}; result: Lane }
```

The three lane methods are in `methods/lanes.ts satisfies MethodsUnder<'lane/'>`. The only public origin for `goal/create` is the person. Phase 8 gets an internal `create` port with a trigger origin and owns its event-deduplication transaction; phase 5's create is deliberately not an intake cursor or retry policy.

Validation limits: identifiers 1–200 characters (legacy Goal IDs may be absolute paths up to 4096); sentence 1–2000 after trim; summary 1–16000; reasons 1–4000; card ID positive safe integer; revision nonnegative safe integer; SHA 40 or 64 lowercase hex; `dependsOn` at most 128; choices at most 2000 (the existing board ceiling); candidates use phase 2's existing seat validator/limit. Reject unexpected `origin`, `members`, `env`, `partition`, `ceiling` and receipt fields on public create/seat/update. Host-derived facts and effective ceilings are never accepted as client data. Receipt data can exceed one evidence line: it is a separate versioned document bounded to 8 MiB, never passed to `EvidenceStore.append` as a 64-KiB evidence line. Answer snippets are at most 16,000 characters per Seat with an explicit truncation gap and transcript pointer; refuse an oversize receipt before staging rather than dropping records.


### Task 1: Define the Goal contract and the dependency rule

The Goal document owns an effort, never its membership. Share the evidence rules unchanged so the host and renderer answer the same question about readiness.

**Files:**
- Create: `packages/protocol/src/goal.ts`, `packages/protocol/src/board-facts.ts`, `packages/protocol/src/evidence-status.ts`.
- Create tests: `packages/server/test/goal-model.test.ts`, `packages/server/test/fixtures/goals.ts`, `packages/protocol/test/goal.test.ts`.
- Modify: `packages/protocol/src/index.ts`, `packages/ui/src/lib/board-facts.ts`, `packages/ui/src/lib/evidence.ts`.
- Existing tests retained without assertion changes: `packages/ui/src/lib/board-facts.test.ts`, `packages/ui/src/lib/evidence.test.ts`.

**Proof needs:** neither. **Routing:** Codex.

**Interfaces:** Consumes phase 4's `SeatRecord`, `EvidenceRecord`, `SeatId`, `Sha`, `StandingOrder`, `SeatCeiling`, `CardEvidence`, `EvidenceView` and `Freshness`. Produces `Goal`, `GoalBoard`, `GoalView`, `GoalCreateInput`, `GoalSeatRequest`, `SeatGrant`, `GoalReceipt`, `GoalCitation`, `GoalState`, `GoalActivity`, `WrapChoices`, `WrapPreview`, `membersOf`, `checkedDependencies`, `activityOf` and `factsOfGoal`. `Goal.id` remains the existing board key. Task 4 adds the already-promised lane declarations to this file. The shared placement and verdict exports retain phase 4's names, signatures and results.

- [ ] **Step 1: Check the consumed phase-4 declarations**

Run: `rg -n 'interface SeatRecord|type StandingOrder|interface CardEvidence|type Freshness|class SeatBook' packages/protocol/src/evidence.ts packages/server/src/evidence/seats.ts`

Expected: Each declaration exists in the phase-4 prerequisite. Its absence blocks the production build; do not replace it with a second schema. The isolated planning proof supplies the exact declarations from the phase-4 plan.

- [ ] **Step 2: Write the fixtures and both failing test files**

Create `packages/server/test/fixtures/goals.ts` with these complete contents:

```ts
import type { Goal, Intent, SeatRecord } from '@harnessdesk/protocol'

export const goal = (id = 'g1', over: Partial<Goal> = {}): Goal => ({
  id,
  root: '/work/repo',
  cwd: '/work/repo',
  sentence: 'Finish the change',
  state: 'open',
  revision: 0,
  checkout: 'shared',
  dependsOn: [],
  origin: { kind: 'person' },
  createdAt: 1,
  updatedAt: 1,
  receipt: null,
  ...over,
})

export const seat = (id = 's1', over: Partial<SeatRecord> = {}): SeatRecord => ({
  id,
  agent: null,
  briefDigest: null,
  seat: { runtime: 'fake' },
  seatLabel: 'Fake Runtime',
  passedOver: [],
  standing: { kind: 'permission', permission: 'read' },
  ceiling: null,
  checkout: { cwd: '/work/repo', project: '/work/repo', branch: null, head: null },
  session: { runtime: 'fake', sessionId: id },
  board: 'g1',
  role: null,
  openedAt: 1,
  closed: null,
  ...over,
})

export const intent = (id = 1, over: Partial<Intent> = {}): Intent => ({
  id,
  title: 'Finish the change',
  state: 'open',
  files: [],
  dependsOn: [],
  claim: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})
```

Create `packages/server/test/goal-model.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { activityOf, checkedDependencies, factsOfGoal, membersOf } from '@harnessdesk/protocol'
import type { EvidenceRecord } from '@harnessdesk/protocol'

import { goal, seat } from './fixtures/goals.js'

test('membership includes only open kept Seats on this Goal', () => {
  const records = [
    seat(),
    seat('closed', { closed: { at: 2, why: 'released' } }),
    seat('restored', { restored: { at: 3 } }),
    seat('other', { board: 'g2' }),
    seat('loose', { board: null }),
  ]
  assert.deepEqual(membersOf(goal(), records).map((one) => one.id), ['s1'])
  assert.deepEqual(membersOf(goal('g1', { state: 'wrapping' }), records).map((one) => one.id), ['s1'])
  assert.deepEqual(membersOf(goal('g1', { state: 'wrapped' }), records), [])
  assert.equal(records.length, 5)
})

test('dependency edits reject direct, transitive and already-corrupt cycles', () => {
  const one = goal()
  const two = goal('g2', { dependsOn: ['g1'] })
  const three = goal('g3', { dependsOn: ['g2'] })
  const circular = /These Goals would wait on each other/
  assert.throws(() => checkedDependencies(one, ['g1'], [one]), circular)
  assert.throws(() => checkedDependencies(one, ['g3'], [one, two, three]), circular)
  assert.throws(() => checkedDependencies(one, ['g2'], [
    goal('g2', { dependsOn: ['g3'] }),
    goal('g3', { dependsOn: ['g2'] }),
  ]), circular)
})

test('every reachable dependency must exist in this project', () => {
  const one = goal()
  const invalid = /Choose an existing Goal in this project/
  assert.throws(() => checkedDependencies(one, ['missing'], []), invalid)
  assert.throws(() => checkedDependencies(one, ['g2'], [goal('g2', { root: '/work/other' })]), invalid)
  assert.throws(() => checkedDependencies(one, ['g2'], [goal('g2', { dependsOn: ['gone'] })]), invalid)
  assert.throws(() => checkedDependencies(one, ['g2'], [
    goal('g2', { dependsOn: ['g3'] }), goal('g3', { root: '/work/other' }),
  ]), invalid)
})

test('dependency limits count unique edges and preserve order without sharing an array', () => {
  const all = Array.from({ length: 129 }, (_, index) => goal(`d${index}`))
  const ids = all.slice(0, 128).map((one) => one.id)
  const checked = checkedDependencies(goal(), ids, all)
  assert.deepEqual(checked, ids)
  assert.notEqual(checked, ids)
  assert.throws(() => checkedDependencies(goal(), all.map((one) => one.id), all), /up to 128 Goals/)
  assert.throws(() => checkedDependencies(goal(), ['d0', 'd0'], all), /Choose each dependency once/)
})

test('a diamond dependency graph is valid', () => {
  const all = [goal('b', { dependsOn: ['d'] }), goal('c', { dependsOn: ['d'] }), goal('d')]
  assert.deepEqual(checkedDependencies(goal(), ['c', 'b'], all), ['c', 'b'])
})

const activity = {
  needsYou: false,
  busy: false,
  liveFlow: false,
  cards: [{ state: 'done' }],
  dependencies: [],
}

test('needs-you precedes busy, while wrapped Goals have no live activity', () => {
  assert.equal(activityOf(goal(), { ...activity, needsYou: true, busy: true }), 'needs-you')
  assert.equal(activityOf(goal('g1', { state: 'wrapped' }), { ...activity, needsYou: true }), null)
  assert.equal(activityOf(goal('g1', { state: 'wrapping' }), activity), 'working')
})

test('empty Goals, live flows, busy work and unfinished cards cannot be ready', () => {
  assert.equal(activityOf(goal(), { ...activity, cards: [] }), 'working')
  assert.equal(activityOf(goal(), { ...activity, busy: true }), 'working')
  assert.equal(activityOf(goal(), { ...activity, liveFlow: true }), 'working')
  for (const state of ['open', 'claimed', 'blocked']) {
    assert.equal(activityOf(goal(), { ...activity, cards: [{ state }] }), 'working')
  }
  assert.equal(activityOf(goal(), activity), 'ready-to-wrap')
  assert.equal(activityOf(goal(), { ...activity, cards: [{ state: 'abandoned' }] }), 'ready-to-wrap')
})

test('missing, open and wrapping dependencies wait; every wrapped dependency releases the wait', () => {
  const waiting = goal('g1', { dependsOn: ['g2'] })
  assert.equal(activityOf(waiting, activity), 'working')
  for (const state of ['open', 'wrapping'] as const) {
    assert.equal(activityOf(waiting, { ...activity, dependencies: [goal('g2', { state })] }), 'working')
  }
  assert.equal(activityOf(waiting, {
    ...activity, dependencies: [goal('g2', { state: 'wrapped', receipt: 'receipt-2' })],
  }), 'ready-to-wrap')
})

test('receipt attribution includes released Seats and card facts, once, but no unscoped spend', () => {
  const fact = { kind: 'spend', usd: 1, turns: 1, exact: false } as const
  const facts: EvidenceRecord[] = [
    { id: 'ours', fact, seat: 's1', observedAt: 1 },
    { id: 'card', fact, card: { board: 'g1', id: 1 }, observedAt: 1 },
    { id: 'both', fact, seat: 's1', card: { board: 'g1', id: 1 }, observedAt: 1 },
    { id: 'other', fact, seat: 's2', observedAt: 1 },
    { id: 'unknown', fact, observedAt: 1 },
  ]
  assert.deepEqual(factsOfGoal('g1', [seat('s1', { closed: { at: 2, why: 'released' } })], facts)
    .map((one) => one.id), ['ours', 'card', 'both'])
  assert.equal(facts.length, 5)
})
```

Create `packages/protocol/test/goal.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Goal, GoalBoard, GoalReceipt, GoalSeatRequest, SeatRecord, WrapPreview } from '../src/index.js'

test('Goal and its mutable board have no authored membership or live Plans', () => {
  const goalMembers: 'members' extends keyof Goal ? true : false = false
  const boardMembers: 'members' extends keyof GoalBoard ? true : false = false
  const boardPlans: 'plans' extends keyof GoalBoard ? true : false = false
  const id: Goal['id'] = 'room-retained'
  const board: SeatRecord['board'] = id
  assert.deepEqual([goalMembers, boardMembers, boardPlans], [false, false, false])
  assert.equal(board, id)
})

test('both grant generations and the receipt preview retain their exact shapes', () => {
  const permission: GoalSeatRequest['grant'] = { kind: 'permission', permission: 'read' }
  const ceiling: GoalSeatRequest['grant'] = { kind: 'ceiling', level: 'edit' }
  const previewHasId: 'id' extends keyof WrapPreview['receipt'] ? true : false = false
  const receiptHasId: 'id' extends keyof GoalReceipt ? true : false = true
  assert.equal(permission.kind, 'permission')
  assert.equal(ceiling.kind, 'ceiling')
  assert.deepEqual([previewHasId, receiptHasId], [false, true])
})
```

- [ ] **Step 3: Observe the missing contract before adding it**

Run: `pnpm run build:node`

Expected: FAIL with `Module '"@harnessdesk/protocol"' has no exported member 'Goal'` and missing exports for the four pure helpers. This command is for the implementation checkout after phase 4, not evidence that this planning checkout contains phase 4.

- [ ] **Step 4: Write the complete Goal vocabulary and pure derivations**

Create `packages/protocol/src/goal.ts` with these complete contents:

```ts
import type { CeilingLevel, EvidenceRecord, SeatId, SeatRecord, Sha } from './evidence.js'
import type { FlowPermission, FlowSeat } from './flow.js'
import type { Intent, TeamEntry, TeamState } from './team.js'

export type GoalId = string
export type GoalState = 'open' | 'wrapping' | 'wrapped'
export type GoalActivity = 'working' | 'needs-you' | 'ready-to-wrap'

export type GoalOrigin =
  | { kind: 'person' }
  | { kind: 'legacy'; source: string }
  | { kind: 'flow'; run: string }
  | { kind: 'trigger'; trigger: string; event: string }

/** A finishable effort. Its Seats, rather than this document, say who belongs. */
export interface Goal {
  readonly id: GoalId
  readonly root: string
  readonly cwd: string
  readonly sentence: string
  readonly state: GoalState
  readonly revision: number
  readonly checkout: 'shared' | 'isolated'
  readonly dependsOn: readonly GoalId[]
  readonly origin: GoalOrigin
  readonly createdAt: number
  readonly updatedAt: number
  readonly receipt: string | null
}

export interface GoalCitation {
  readonly goal: GoalId
  readonly receipt: string
  readonly project: string
  readonly path: string
  readonly at: Sha
}

export interface GoalReceipt {
  readonly version: 1
  readonly id: string
  readonly goal: GoalId
  readonly sentence: string
  readonly wrappedAt: number
  readonly summary: string
  readonly cards: readonly {
    id: number
    resolution: 'finished' | 'dropped'
    reason: string | null
  }[]
  readonly seats: readonly SeatId[]
  readonly evidence: readonly string[]
  readonly answers: readonly {
    seat: SeatId
    session: SeatRecord['session']
    turn: string | null
    text: string
    partial: boolean
    stopReason: string | null
  }[]
  readonly lanes: readonly {
    lane: string
    cwd: string
    dirty: boolean | null
    retained: true
  }[]
  readonly revisions: readonly {
    cwd: string
    head: Sha | null
    dirty: boolean | null
  }[]
  readonly citations: readonly GoalCitation[]
  readonly gaps: readonly string[]
}

/** The mutable board payload contains neither members nor a second Plan API. */
export interface GoalBoard {
  readonly nextIntent: number
  readonly messaging: boolean
  readonly intents: readonly Intent[]
  readonly channel: readonly TeamEntry[]
}

export interface GoalView {
  readonly goal: Goal
  readonly activity: GoalActivity | null
  readonly waitingOn: readonly { id: GoalId; sentence: string }[]
  readonly members: readonly SeatRecord[]
  readonly board: TeamState
  readonly receipt: GoalReceipt | null
  readonly problem: string | null
}

export interface GoalCreateInput {
  root: string
  cwd?: string
  sentence: string
  checkout?: 'shared' | 'isolated'
  dependsOn?: readonly GoalId[]
  origin?: GoalOrigin
}

export type SeatGrant =
  | { kind: 'permission'; permission: FlowPermission }
  | { kind: 'ceiling'; level: CeilingLevel }

export interface GoalSeatRequest {
  goal: GoalId
  agent: string
  seats?: readonly FlowSeat[]
  grant?: SeatGrant
  card?: number
  isolate?: boolean
}

export interface WrapChoices {
  summary: string
  cards: GoalReceipt['cards']
}

export interface WrapPreview {
  stamp: string
  receipt: Omit<GoalReceipt, 'id' | 'wrappedAt'>
}

export const membersOf = (goal: Goal, seats: readonly SeatRecord[]): SeatRecord[] =>
  goal.state === 'wrapped'
    ? []
    : seats.filter((seat) => seat.board === goal.id && seat.closed === null && !seat.restored)

/** Validate the proposed graph without changing the caller's array or any Goal. */
export function checkedDependencies(
  goal: Pick<Goal, 'id' | 'root'>,
  ids: readonly string[],
  all: readonly Goal[],
): string[] {
  if (new Set(ids).size !== ids.length || ids.length > 128) {
    throw new Error('Choose each dependency once, up to 128 Goals.')
  }
  const byId = new Map(all.map((one) => [one.id, one]))
  const visited = new Set<string>()
  const visiting = new Set<string>([goal.id])
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new Error('These Goals would wait on each other. Remove the circular dependency.')
    }
    if (visited.has(id)) return
    const target = byId.get(id)
    if (!target || target.root !== goal.root) {
      throw new Error('Choose an existing Goal in this project.')
    }
    visiting.add(id)
    target.dependsOn.forEach(visit)
    visiting.delete(id)
    visited.add(id)
  }
  ids.forEach(visit)
  return [...ids]
}

/** Evidence placement supplies needsYou and busy; a done note supplies neither. */
export function activityOf(
  goal: Goal,
  input: {
    needsYou: boolean
    busy: boolean
    liveFlow: boolean
    cards: readonly { state: string }[]
    dependencies: readonly Goal[]
  },
): GoalActivity | null {
  if (goal.state === 'wrapped') return null
  if (input.needsYou) return 'needs-you'
  const waiting = goal.dependsOn.some(
    (id) => input.dependencies.find((one) => one.id === id)?.state !== 'wrapped',
  )
  const settled = input.cards.length > 0 && input.cards.every(
    (card) => card.state === 'done' || card.state === 'abandoned',
  )
  return goal.state === 'open' && !input.busy && !input.liveFlow && !waiting && settled
    ? 'ready-to-wrap'
    : 'working'
}

/** Attribution includes closed Seats. It never spreads an unscoped fact across Goals. */
export function factsOfGoal(
  goal: string,
  seats: readonly SeatRecord[],
  facts: readonly EvidenceRecord[],
): EvidenceRecord[] {
  const ids = new Set(seats.filter((seat) => seat.board === goal).map((seat) => seat.id))
  return facts.filter((fact) => fact.card?.board === goal || (fact.seat != null && ids.has(fact.seat)))
}
```

`activityOf` receives evidence-derived `needsYou` and `busy`; it is not itself an evidence reader. Task 3 supplies those flags from `placeCard`, approvals, held mail, live turns and running checks. A missing dependency stays unfinished. A diamond is valid; any cycle reachable from a proposed edge refuses.

- [ ] **Step 5: Share the unchanged placement rules**

Create `packages/protocol/src/board-facts.ts` with these complete contents:

```ts
import type { CardEvidence, EvidenceView } from './evidence.js'
import type { FlowRole, FlowRun } from './flow.js'
import type { Intent } from './team.js'

import { checkPassed, ciVerdict, isCurrent } from './evidence-status.js'

/**
 * Where a card belongs, from the facts.
 *
 * The board's columns are not places a card is put; they are what is known
 * about it. *To do* is work nobody has started. *Working* is work its holder is
 * on. *Needs you* is work that cannot move without a person: stopped, stranded,
 * waiting on an answer, failed, cancelled, out of date, unknown, or finished
 * with nothing checked. *In review* is finished work whose evidence is still
 * arriving — a check running, CI running, a pull request open. *Ready* is
 * finished work a **current** fact says is good: a fresh passing check, fresh
 * passing CI, or a merged pull request that is fresh — or final, when its
 * branch is gone and nothing can land on it any more. *Set aside* is work a
 * person dropped: settled, never good news, and drawn only while it holds
 * something.
 *
 * A column moves on a check, a diff, a pull request or CI — never on anybody
 * saying the work is done. Nothing here reads a message, and a card's own
 * words — its note, its outcome, its hand-off — are what an agent said, so
 * they move nothing either. A card finished with a note that the tests pass,
 * and nothing observed, waits in *Needs you*, and says so.
 */

export type FactColumn = 'todo' | 'working' | 'needs' | 'review' | 'ready' | 'aside'

/** The columns, in the order work moves through them; *Set aside* last, and only drawn while it holds a card. */
export const FACT_COLUMNS: readonly { readonly id: FactColumn; readonly title: string }[] = [
  { id: 'todo', title: 'To do' },
  { id: 'working', title: 'Working' },
  { id: 'needs', title: 'Needs you' },
  { id: 'review', title: 'In review' },
  { id: 'ready', title: 'Ready' },
  { id: 'aside', title: 'Set aside' },
]

export interface Placement {
  readonly column: FactColumn
  /**
   * Why the card is where it is, when the column cannot say it alone — which
   * fact put it in *Needs you*, or what it waits for — short enough for the
   * chip a card wears. Null when the column says everything.
   */
  readonly why: string | null
}

export interface PlaceInput {
  readonly intent: Intent
  /** What the desk observed on it; undefined when nothing. */
  readonly evidence: CardEvidence | undefined
  /** Its claim has lapsed and its holder has gone (`strandedFor`): someone has to take it over. */
  readonly stranded: boolean
  /** Its holder is waiting on a person: an approval it asked for. */
  readonly holderWaits: boolean
  /** The running flow addressed it to the person: a step of that run only they can answer (`flowRoleOf`). */
  readonly forPerson: boolean
}

/**
 * The role the running flow holds a card to, or null. Only a card one of the
 * run's own rounds opened is that run's: a card left open by an earlier run
 * that was stopped keeps its role's name, and a new run that happens to reuse
 * the name has not addressed it to anyone.
 */
export const flowRoleOf = (intent: Intent, run: FlowRun | undefined): FlowRole | null => {
  if (!intent.role || !run) return null
  if (!run.rounds.some((round) => round.intents.includes(intent.id))) return null
  return run.flow.roles.find((one) => one.id === intent.role) ?? null
}

/** What a fact that can make a card Ready is called on its chip. */
const subjectOf = (view: EvidenceView): string | null => {
  const fact = view.record.fact
  switch (fact.kind) {
    case 'check':
      return fact.name
    case 'ci':
      return 'CI'
    case 'pr':
      return `PR #${fact.number}`
    default:
      return null
  }
}

/** Why a fact that could decide the card does not: it is out of date, or nobody can say. Null when it is current, or decides nothing. */
const notCurrent = (view: EvidenceView): string | null => {
  const subject = subjectOf(view)
  if (subject === null || isCurrent(view.freshness)) return null
  return view.freshness.state === 'unknown' ? `${subject} unknown` : `${subject} out of date`
}

/** Where finished work stands: on its current facts alone. */
const settled = (evidence: CardEvidence | undefined): Placement => {
  const facts = evidence?.facts ?? []
  const current = facts.filter((view) => isCurrent(view.freshness))
  // A current failure is the news, whatever else passed. Cancelled CI is not a pass, and says so.
  for (const view of current) {
    const fact = view.record.fact
    if (fact.kind === 'check' && !checkPassed(fact)) return { column: 'needs', why: `${fact.name} failed` }
    if (fact.kind === 'ci' && ciVerdict(fact.checks) === 'failed') return { column: 'needs', why: 'CI failed' }
    if (fact.kind === 'ci' && ciVerdict(fact.checks) === 'cancelled') return { column: 'needs', why: 'CI cancelled' }
    if (fact.kind === 'pr' && fact.state === 'closed') return { column: 'needs', why: `PR #${fact.number} closed` }
  }
  // Ready needs a current fact that says the work is good.
  for (const view of current) {
    const fact = view.record.fact
    if (fact.kind === 'pr' && fact.state === 'merged') return { column: 'ready', why: null }
    if (fact.kind === 'check' && checkPassed(fact)) return { column: 'ready', why: null }
    if (fact.kind === 'ci' && ciVerdict(fact.checks) === 'passed') return { column: 'ready', why: null }
  }
  // Evidence still arriving.
  const running = evidence?.running[0]
  if (running) return { column: 'review', why: `${running.name} running` }
  for (const view of current) {
    const fact = view.record.fact
    if (fact.kind === 'ci' && ciVerdict(fact.checks) === 'running') return { column: 'review', why: 'CI running' }
    if (fact.kind === 'pr' && fact.state === 'open') return { column: 'review', why: `PR #${fact.number} open` }
  }
  // A fact that is not current is no verdict: the card waits for someone to look again, and says which fact, and how.
  for (const view of facts) {
    const why = notCurrent(view)
    if (why !== null) return { column: 'needs', why }
  }
  return { column: 'needs', why: 'nothing checked' }
}

export const placeCard = ({ intent, evidence, stranded, holderWaits, forPerson }: PlaceInput): Placement => {
  switch (intent.state) {
    case 'abandoned':
      // Dropped, not finished: never Ready, whatever was observed on it.
      return { column: 'aside', why: null }
    case 'blocked':
      return intent.blockedBy === 'hand' ? { column: 'needs', why: 'stopped' } : { column: 'todo', why: null }
    case 'open':
      return forPerson ? { column: 'needs', why: 'needs your answer' } : { column: 'todo', why: null }
    case 'claimed':
      // A stranded card says how long on its own chip.
      if (stranded) return { column: 'needs', why: null }
      if (holderWaits) return { column: 'needs', why: 'waiting on you' }
      return { column: 'working', why: null }
    case 'done':
      return settled(evidence)
  }
}
```

Create `packages/protocol/src/evidence-status.ts` with these complete contents:

```ts
import type { CheckRun, Evidence, Freshness } from './evidence.js'

type CheckFact = Extract<Evidence, { kind: 'check' }>

export const isCurrent = (freshness: Freshness): boolean => freshness.state === 'fresh' || freshness.state === 'final'

export const checkPassed = (fact: CheckFact): boolean => fact.exit === 0 && !fact.timedOut

export type CiVerdict = 'passed' | 'failed' | 'cancelled' | 'running' | 'skipped'

/**
 * What the forge's checks on one head say together: any failure is a failure;
 * then any cancelled check — which never said whether the work is good, and
 * is not a pass however the rest went; then any still running; then passed
 * when one passed; else every one was skipped.
 */
export const ciVerdict = (checks: readonly CheckRun[]): CiVerdict => {
  if (checks.some((one) => one.state === 'failed')) return 'failed'
  if (checks.some((one) => one.state === 'cancelled')) return 'cancelled'
  if (checks.some((one) => one.state === 'pending')) return 'running'
  return checks.some((one) => one.state === 'passed') ? 'passed' : 'skipped'
}
```

Replace the whole phase-4 `packages/ui/src/lib/board-facts.ts` module (the implementation just quoted, with its existing public-protocol and `./evidence` imports) with:

```ts
export { FACT_COLUMNS, flowRoleOf, placeCard } from '@harnessdesk/protocol'
export type { FactColumn, Placement, PlaceInput } from '@harnessdesk/protocol'
```

Replace the whole phase-4 `packages/ui/src/lib/evidence.ts` module, anchored by its first import and final `cardChips` export, with the following complete replacement. Only the three pure functions and `CiVerdict` move; the presentation helpers remain here.

```ts
import type { CardEvidence, Evidence, EvidenceView, Freshness, Sha } from '@harnessdesk/protocol'
import { checkPassed, ciVerdict, isCurrent, type CiVerdict } from '@harnessdesk/protocol'
export { checkPassed, ciVerdict, isCurrent, type CiVerdict } from '@harnessdesk/protocol'

/**
 * What the desk observed, in words: a card's chips, and the lines of the
 * dialog a chip opens.
 *
 * Every word here is about a fact the host recorded from something it did — a
 * command it ran, a pull request it read, a diff it computed — and none is
 * about what an agent said: nothing here reads a message, a note or an
 * outcome. Only a current fact is ever drawn as a verdict. A stale one says how
 * far behind it is and is never green; an unknown one is drawn neutral, and
 * the dialog says why, because unknown is not zero.
 *
 * The tones are the design system's, not this file's: a chip names the
 * outcome in `stateTone`'s own states (`FactOutcome`), and `EvidenceChips`
 * asks `stateTone` for its tone. An outcome that map has no state for — CI
 * that was cancelled, a check that never started — is said in words, and
 * drawn neutral; no state is invented for it.
 */

/** A commit, as a person reads it: its first seven characters. */
export const shortSha = (sha: Sha): string => sha.slice(0, 7)

const plural = (n: number, noun: string): string => `${n} ${n === 1 ? noun : `${noun}s`}`

/** Behind, rewritten or run on uncommitted changes: drawn struck through, never green. */
export const isStale = (freshness: Freshness): boolean =>
  freshness.state === 'behind' || freshness.state === 'moved' || freshness.state === 'uncommitted'

/** How a stale fact stands against its branch, short, for its chip; null for any fact that is not stale. */
export const sinceWords = (freshness: Freshness): string | null => {
  switch (freshness.state) {
    case 'behind':
      return `${plural(freshness.commits, 'commit')} since`
    case 'moved':
      return 'rewritten since'
    case 'uncommitted':
      return 'uncommitted'
    case 'fresh':
    case 'final':
    case 'unknown':
      return null
  }
}

/** The same, whole, for the dialog. Unknown says why. */
export const standingWords = (freshness: Freshness): string => {
  switch (freshness.state) {
    case 'fresh':
      return 'Fresh: nothing has landed on its branch since.'
    case 'final':
      return 'Final: the pull request was merged and its branch is gone, so nothing can land on it now.'
    case 'behind':
      return `Stale: ${plural(freshness.commits, 'commit')} landed on its branch since.`
    case 'moved':
      return 'Stale: its branch was rewritten since, and this commit is no longer on it.'
    case 'uncommitted':
      return 'Stale: it ran on changes that were never committed.'
    case 'unknown':
      return `Unknown: ${freshness.why}.`
  }
}

type CheckFact = Extract<Evidence, { kind: 'check' }>

/** What a check did, in a sentence. */
export const checkWords = (fact: CheckFact): string =>
  fact.timedOut
    ? 'It ran past its time and was stopped.'
    : fact.exit === null
      ? 'It did not start.'
      : `It exited ${fact.exit}.`

/** The revision a fact is bound to; null for one bound to none. */
export const revisionOfFact = (fact: Evidence): Sha | null => {
  switch (fact.kind) {
    case 'check':
    case 'ci':
    case 'review':
    case 'finding':
      return fact.at
    case 'pr':
      return fact.head
    case 'diff':
      return fact.to
    case 'spend':
      return null
  }
}

/** Who produced a fact, in words. */
export const byWords = (view: EvidenceView): string =>
  view.by === null ? 'The desk' : view.by.agent === null ? view.by.seat : `${view.by.agent} on ${view.by.seat}`

/**
 * An outcome in the design system's own states — each one `stateTone` has a
 * word and a tone for. Written out rather than imported so this file stays
 * free of the renderer; `EvidenceChips` holds it to `StateToneState`, so a
 * state the system does not have cannot be written here.
 */
export type FactOutcome = 'open' | 'merged' | 'closed' | 'passed' | 'failed' | 'running' | 'skipped' | 'timed out'

export interface FactChip {
  /** One chip per kind on a card, and one per named check. */
  readonly key: string
  readonly label: string
  /** The outcome it reports, in `stateTone`'s states; null when it reports none the system can judge in a word. */
  readonly outcome: FactOutcome | null
  /** It no longer holds: struck through, and never green. */
  readonly stale: boolean
  /** Nobody can say whether it holds: drawn neutral, and the dialog says why. */
  readonly unknown: boolean
}

/** What a chip says to a screen reader: its words, and what its look says without them. */
export const spokenChip = (chip: FactChip): string =>
  `${chip.label}${chip.stale ? ' (stale)' : ''}${chip.unknown ? ' (unknown)' : ''}`

/**
 * A check's words: *verify ✓ @a1b2c3d*. The mark is a word of the label, read
 * with it, so it is written inside the sentence rather than standing alone
 * as an icon would.
 */
const checkLabel = (fact: CheckFact): string => {
  const at = `@${shortSha(fact.at)}`
  if (fact.timedOut) return `${fact.name} timed out ${at}`
  if (fact.exit === null) return `${fact.name} did not start ${at}`
  return fact.exit === 0 ? `${fact.name} ✓ ${at}` : `${fact.name} ✗ ${at}`
}

/** A check's outcome: passed, failed or timed out — and none for one that never started, which is said in words. */
const checkOutcome = (fact: CheckFact): FactOutcome | null =>
  fact.timedOut ? 'timed out' : fact.exit === null ? null : fact.exit === 0 ? 'passed' : 'failed'

/** What the forge's checks say together, in the chip's words. */
const ciLabel = (verdict: CiVerdict): string =>
  verdict === 'passed' ? 'CI ✓' : verdict === 'failed' ? 'CI ✗' : `CI ${verdict}`

/**
 * What one fact says on its card: *verify ✓ @a1b2c3d*, *CI ✓*, *PR #12 open*,
 * *+120 −30 in 6 files*. A stale fact adds how far behind it is — *verify ✓
 * @a1b2c3d — 2 commits since* — and is drawn struck through; an unknown one is
 * drawn neutral. Both are the design system `Chip`'s own `stale` and
 * `unknown`, never a colour chosen here.
 */
export const chipOf = (view: EvidenceView): FactChip => {
  const fact = view.record.fact
  const since = sinceWords(view.freshness)
  const said = (base: string): string => (since ? `${base} — ${since}` : base)
  const stale = isStale(view.freshness)
  const unknown = view.freshness.state === 'unknown'
  const chip = (key: string, label: string, outcome: FactOutcome | null): FactChip => ({ key, label: said(label), outcome, stale, unknown })
  switch (fact.kind) {
    case 'check':
      return chip(`check:${fact.name}`, checkLabel(fact), checkOutcome(fact))
    case 'ci': {
      const verdict = ciVerdict(fact.checks)
      return chip('ci', ciLabel(verdict), verdict === 'cancelled' ? null : verdict)
    }
    case 'pr':
      return chip('pr', `PR #${fact.number} ${fact.state}`, fact.state)
    case 'diff':
      return chip('diff', `+${fact.added} −${fact.removed} in ${plural(fact.files, 'file')}`, null)
    case 'review':
      return chip(`review:${fact.by}`, `review: ${fact.verdict}`, null)
    case 'finding':
      return chip(`finding:${fact.id}`, `finding ${fact.state}`, null)
    case 'spend':
      return { key: 'spend', label: `$${fact.usd.toFixed(2)} in ${plural(fact.turns, 'turn')}`, outcome: null, stale: false, unknown: false }
  }
}

/**
 * A card's chips: a check running now in place of that check's last fact,
 * then every other fact in the order the host lists them. Empty for a card
 * the desk has observed nothing about.
 */
export const cardChips = (card: CardEvidence | undefined): readonly FactChip[] => {
  if (!card) return []
  const running = new Set(card.running.map((one) => one.name))
  return [
    ...card.running.map((one): FactChip => ({
      key: `check:${one.name}`,
      label: `${one.name} running`,
      outcome: 'running',
      stale: false,
      unknown: false,
    })),
    ...card.facts
      .filter((view) => !(view.record.fact.kind === 'check' && running.has(view.record.fact.name)))
      .map(chipOf),
  ]
}
```

- [ ] **Step 6: Expose all three modules through the protocol entrypoint**

In `packages/protocol/src/index.ts`, replace this exact anchor:

```ts
export * from './team.js'
```

with:

```ts
export * from './team.js'
export * from './goal.js'
export * from './board-facts.js'
export * from './evidence-status.js'
```

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/goal-model.test.js packages/protocol/dist/test/goal.test.js`

Expected: PASS — 9 model tests and 2 declaration tests, 11 total.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/board-facts.test.ts`

Expected: PASS — the 14 phase-4 placement tests with unchanged assertions.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/evidence.test.ts`

Expected: PASS — 8 existing evidence presentation tests, with no changed expected verdicts. This renderer command is required at implementation time; the depth pass did not run the unavailable phase-4 renderer.

- [ ] **Step 7: Prove restored history cannot become membership**

Temporarily remove `&& !seat.restored` from `membersOf`.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/goal-model.test.js`

Expected: FAIL — 1 failed, 8 passed. `membership includes only open kept Seats on this Goal` gets `['s1', 'restored']`, expected `['s1']`.

Restore the guard exactly as Step 4.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/goal-model.test.js`

Expected: PASS — 9 tests.

- [ ] **Step 8: Commit the contract and the unchanged evidence rules**

The implementation owner runs the complete gate before committing; the depth-pass writer does not execute this step.

Run: `pnpm verify`

Expected: Exit 0. A sandbox refusal is not a passing gate; the controller runs this on the real surface.

```bash
git add packages/protocol/src/goal.ts packages/protocol/src/board-facts.ts packages/protocol/src/evidence-status.ts packages/protocol/src/index.ts packages/protocol/test/goal.test.ts packages/server/test/goal-model.test.ts packages/server/test/fixtures/goals.ts packages/ui/src/lib/board-facts.ts packages/ui/src/lib/evidence.ts
git commit -m "feat(goals): define Goals and share evidence placement rules" -m "Co-Authored-By: Codex <agent@harnessdesk.app>"
```

### Task 2: Persist Goals and migrate an entire desk without losing rooms

Activation is the boundary. Conversion validates every source before anything is imported; a failed activation leaves the old files readable and retries the same Seat ids. A Goal write answers only after its file is durable. An uncertain write blocks further writes until reload, so memory cannot overwrite a rename that may already have landed.

**Files:**
- Create: `packages/server/src/goals/store.ts`, `packages/server/src/goals/migration.ts`, `packages/server/src/goals/writer-lease.ts`, `packages/server/src/goals/operations.ts`.
- Create tests: `packages/server/test/goal-migration.test.ts`, `packages/server/test/goal-store.test.ts`, `packages/server/test/goal-writer-lease.test.ts`, `packages/server/test/goal-seatbook.test.ts`.
- Modify: `packages/server/src/evidence/seats.ts`, `packages/server/src/evidence/records.ts`, `packages/protocol/src/evidence.ts`, `packages/ui/src/components/SeatRecordBlock.tsx`, `packages/ui/src/components/SeatRecordBlock.test.tsx`, `packages/server/src/host.ts`, `packages/server/src/team.ts`.
- Existing regression suites that must remain at their original layer: `packages/server/test/team.test.ts`, `packages/server/test/room-restart.test.ts`, `packages/server/test/room-worktree.test.ts`, `packages/protocol/test/evidence.test.ts`.

**Proof needs:** neither. **Routing:** Codex.

**Interfaces:** `GoalStore.load(): Promise<void>`, `list(): readonly GoalDocument[]`, `read(id: GoalId): GoalDocument`, `save(document: GoalDocument, expectedRevision: number | null): Promise<void>`, `flush(): Promise<void>`; `migrateDesk(home, importSeats, beforeActivate?)`; `acquireDeskWriter(home): Promise<{release(): Promise<void>}>`; `GoalDocument` and `GoalOperation` below. Adds `SeatBook.all()` and `importOpening(project, opening)` while preserving `opened`, `closed`, `of`, `latestOf`, `latestKeptOf` and `byId`. Task 3 uses `closeId` for individual membership transactions. Imports use phase 4's real line validator, queue and folding code.

- [ ] **Step 1: Write migration, persistence, lease and import tests before their implementations**

Create `packages/server/test/goal-migration.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { convertRoom, importMigrationSeats, migrateDesk, migrationOpening, type LegacyRoom } from '../src/goals/migration.js'
import { GoalStore } from '../src/goals/store.js'
import { intent, seat } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

const plain = (): LegacyRoom => ({ version: 1, nextIntent: 1, messaging: true, intents: [], channel: [] })
const member = 'fake\u0000one'

const rooms = (): Record<string, LegacyRoom> => ({
  '%2Fwork%2Flegacy.json': { ...plain(), nicknames: { [member]: 'Old name' } },
  'empty.json': { ...plain(), id: 'empty', root: '/work/repo', name: 'An empty room', members: [] },
  'standing.json': { ...plain(), id: 'standing', root: '/work/repo', members: ['fake\u0000two'] },
  'wrapped.json': {
    ...plain(), id: 'wrapped', root: '/work/repo',
    plans: [{ id: 1, goal: 'Past work', state: 'wrapped', createdAt: 1, wrappedAt: 3 }],
  },
  'many.json': {
    ...plain(), id: 'many', root: '/work/repo', nextIntent: 3,
    plans: [
      { id: 1, goal: 'First', state: 'running', createdAt: 2 },
      { id: 2, goal: 'Second', state: 'running', createdAt: 2 },
      { id: 3, goal: 'Later but finished', state: 'wrapped', createdAt: 4, wrappedAt: 5 },
    ],
    intents: [intent(2, { plan: 1 })],
  },
  'board.json': {
    ...plain(), id: 'board', root: '/work/repo', messaging: false,
    channel: (['delivered', 'queued', 'held', 'refused', 'shown'] as const).map((state, at) => ({
      id: `m-${at}`, kind: 'message', from: { kind: 'user' }, at, state, text: state, envelope: `kept ${state}`,
    })),
  },
  'flow.json': {
    ...plain(), id: 'flow', root: '/work/repo', cwd: '/work/repo/sub', members: ['fake\u0000flow'],
    roles: { ['fake\u0000flow']: 'reviewer' },
    roster: { ['fake\u0000flow']: { cwd: '/work/lanes/one', title: 'Reviewer', agent: 'Fake Runtime', model: 'small', at: 4 } },
  },
  '%2Fwork%2Flinked.json': { ...plain(), root: '/work/repo', name: 'Root was corrected' },
})

test('all eight historical shapes preserve ids, cards, delivery states and Plan history', () => {
  const converted = Object.entries(rooms()).map(([file, raw]) => convertRoom(file, raw))
  assert.equal(converted.length, 8)
  assert.equal(converted.every((room) => room.goal.state === 'open' && room.goal.receipt === null), true)
  assert.equal(converted.find((room) => room.goal.id === 'many')?.goal.sentence, 'Second')
  assert.equal(converted.find((room) => room.goal.id === 'wrapped')?.goal.sentence, 'Past work')
  assert.equal(converted.find((room) => room.goal.id === 'empty')?.goal.sentence, 'An empty room')
  assert.equal(converted.find((room) => room.goal.id === '/work/legacy')?.seats[0]?.sessionId, 'one')
  assert.equal(converted.find((room) => room.goal.id === '/work/linked')?.goal.root, '/work/repo')
  assert.deepEqual(converted.find((room) => room.goal.id === 'many')?.legacy.plans, rooms()['many.json']!.plans)
  assert.deepEqual(converted.find((room) => room.goal.id === 'many')?.board.intents, rooms()['many.json']!.intents)
  assert.deepEqual(converted.find((room) => room.goal.id === 'board')?.board.channel, rooms()['board.json']!.channel)
  assert.equal(converted.every((room) => !('members' in room.goal) && !('members' in room.board)), true)
})

test('migration records remembered and inferred locations without fabricating authority or revisions', () => {
  const remembered = convertRoom('flow.json', rooms()['flow.json']).seats[0]!
  const inferredRoom = convertRoom('%2Fwork%2Flegacy.json', rooms()['%2Fwork%2Flegacy.json'])
  const inferred = inferredRoom.seats[0]!
  assert.equal(remembered.cwd, '/work/lanes/one')
  assert.equal(remembered.role, 'reviewer')
  assert.equal(remembered.seatLabel, 'Fake Runtime · small')
  assert.equal(inferredRoom.legacy.seatLocations[inferred.id], 'inferred')
  const opening = migrationOpening(inferred)
  assert.deepEqual(opening.standing, { kind: 'unknown' })
  assert.deepEqual(opening.checkout, { cwd: '/work/legacy', project: '/work/legacy', branch: null, head: null })
  assert.deepEqual([opening.agent, opening.briefDigest, opening.ceiling], [null, null, null])
})

test('an activation failure keeps all original bytes and retry imports fixed Seat ids only once', async () => {
  const home = tempDir('hd-goal-migration-')
  await mkdir(join(home, 'team'))
  const sources = new Map(Object.entries(rooms()).map(([file, raw]) => [file, JSON.stringify(raw, null, 2) + '\n']))
  sources.set('inbound.json', '{ "fake\\u0000one": "hold" }\n')
  for (const [file, text] of sources) await writeFile(join(home, 'team', file), text)
  const imported = new Map<string, unknown>()
  const importing = async (seats: { id: string }[]): Promise<void> => {
    for (const record of seats) imported.set(record.id, record)
  }
  await assert.rejects(migrateDesk(home, importing, async () => { throw new Error('power cut') }), /power cut/)
  assert.deepEqual(await readdir(home), ['team'])
  const count = imported.size
  assert.equal(count, 3)
  assert.equal(await migrateDesk(home, importing), 'migrated')
  assert.equal(imported.size, count)
  assert.equal(await migrateDesk(home, importing), 'existing')
  for (const [file, text] of sources) assert.equal(await readFile(join(home, 'team', file), 'utf8'), text)
  const store = new GoalStore(home)
  await store.load()
  assert.equal(store.list().length, 8)
  assert.equal(store.noticeSeen, false)
  const original = sources.get('many.json')!
  assert.equal(store.read('many').legacy?.sourceSha256, createHash('sha256').update(original).digest('hex'))
  await store.acknowledgeMigration()
  const reopened = new GoalStore(home)
  await reopened.load()
  assert.equal(reopened.noticeSeen, true)
})

test('a reused phase-4 Seat keeps its Agent, brief and ceiling; duplicate kept matches refuse', async () => {
  const wanted = convertRoom('flow.json', rooms()['flow.json']).seats[0]!
  const existing = seat('kept-before-upgrade', {
    board: wanted.board, session: { runtime: wanted.runtime, sessionId: wanted.sessionId },
    agent: { id: 'reviewer', name: 'Reviewer', origin: 'user' }, briefDigest: 'a'.repeat(64),
    standing: { kind: 'ceiling', level: 'read' }, ceiling: { level: 'read', hold: 'held' },
  })
  let writes = 0
  const book = {
    all: () => [existing],
    importOpening: async () => { writes++; return existing },
  }
  await importMigrationSeats([wanted], book)
  assert.equal(writes, 0)
  assert.equal(existing.agent?.name, 'Reviewer')
  await assert.rejects(importMigrationSeats([wanted], { ...book, all: () => [existing, { ...existing, id: 'duplicate' }] }), /Two kept Seats/)
  assert.equal(writes, 0)
})

test('duplicate ids and conversations name both source files before imports begin', async () => {
  for (const duplicate of ['id', 'conversation']) {
    const home = tempDir('hd-goal-duplicate-')
    await mkdir(join(home, 'team'))
    await writeFile(join(home, 'team', 'one.json'), JSON.stringify({ ...plain(), id: 'one', root: '/work/repo', members: [member] }))
    await writeFile(join(home, 'team', 'two.json'), JSON.stringify({
      ...plain(), id: duplicate === 'id' ? 'one' : 'two', root: '/work/repo',
      members: duplicate === 'conversation' ? [member] : [],
    }))
    let calls = 0
    await assert.rejects(migrateDesk(home, async () => { calls++ }), /one.json and two.json/)
    assert.equal(calls, 0)
    assert.deepEqual(await readdir(home), ['team'])
  }
})

test('malformed arrays, members, newer versions and reserved filenames are never staged', () => {
  const base = { ...plain(), id: 'room', root: '/work/repo' }
  for (const over of [
    { version: 2 }, { members: ['broken'] }, { members: [42] }, { members: 'bad' },
    { plans: {} }, { intents: [{ id: 1 }] }, { channel: [{ kind: 'message' }] },
    { roster: [] }, { root: 'relative' },
  ]) assert.throws(() => convertRoom('bad.json', { ...base, ...over }))
  assert.throws(() => convertRoom('index.json', { ...base, id: 'index' }), /file naming rule/)
})

test('a fresh desk shows no upgrade notice; a partial or newer active store refuses', async () => {
  const fresh = tempDir('hd-goal-fresh-')
  await migrateDesk(fresh, async (seats) => { assert.deepEqual(seats, []) })
  const store = new GoalStore(fresh)
  await store.load()
  assert.equal(store.noticeSeen, true)
  assert.deepEqual(store.list(), [])
  const partial = tempDir('hd-goal-partial-')
  await mkdir(join(partial, 'goals'))
  await assert.rejects(migrateDesk(partial, async () => {}), /ENOENT/)
  await writeFile(join(partial, 'goals', 'index.json'), JSON.stringify({ version: 2, ids: [], noticeSeen: true }))
  await assert.rejects(migrateDesk(partial, async () => {}), /Goal index cannot be read/)
})
```

Create `packages/server/test/goal-store.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { migrateDesk } from '../src/goals/migration.js'
import { atomicJson, GoalStore, type GoalDocument } from '../src/goals/store.js'
import { goal } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

const document = (id = 'g1'): GoalDocument => ({
  version: 1, goal: goal(id),
  board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
  citations: [], receipt: null, operation: null,
})

const empty = async (): Promise<string> => {
  const home = tempDir('hd-goal-store-')
  await migrateDesk(home, async () => {})
  return home
}

test('create and update are durable, advance once, and do not expose mutable cache objects', async () => {
  const home = await empty()
  const store = new GoalStore(home)
  await store.load()
  await store.save(document('/work/old-room'), null)
  const before = store.read('/work/old-room')
  await store.save({ ...before, goal: { ...before.goal, revision: 1, sentence: 'A new sentence' } }, 0)
  const copy = store.read('/work/old-room')
  ;(copy.goal as { sentence: string }).sentence = 'mutated'
  assert.equal(store.read('/work/old-room').goal.sentence, 'A new sentence')
  const reopened = new GoalStore(home)
  await reopened.load()
  assert.equal(reopened.read('/work/old-room').goal.revision, 1)
  assert.equal(reopened.read('/work/old-room').goal.sentence, 'A new sentence')
  assert.equal((await readdir(join(home, 'goals'))).includes('%2Fwork%2Fold-room.json'), true)
})

test('two revision-zero updates serialize and only one wins', async () => {
  const home = await empty()
  const store = new GoalStore(home)
  await store.load()
  const original = document()
  await store.save(original, null)
  const results = await Promise.allSettled(['one', 'two'].map((sentence) => store.save({
    ...original, goal: { ...original.goal, revision: 1, sentence },
  }, 0)))
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(store.read('g1').goal.revision, 1)
})

test('a failed write exposes no unpersisted snapshot and flush repeats the failure', async () => {
  const home = await empty()
  const store = new GoalStore(home, async () => { throw new Error('disk refused') })
  await store.load()
  await assert.rejects(store.save(document(), null), /disk refused/)
  assert.deepEqual(store.list(), [])
  assert.equal(store.problem, 'disk refused')
  await assert.rejects(store.flush(), /disk refused/)
  assert.deepEqual(await readdir(join(home, 'goals')), ['index.json'])
})

test('a create interrupted after its document rename repairs the index on restart', async () => {
  const home = await empty()
  const store = new GoalStore(home, async (file, value) => {
    if (file.endsWith('/index.json')) throw new Error('index sync failed')
    await atomicJson(file, value)
  })
  await store.load()
  await assert.rejects(store.save(document(), null), /index sync failed/)
  assert.deepEqual(store.list(), [])
  const reopened = new GoalStore(home)
  await reopened.load()
  assert.equal(reopened.read('g1').goal.id, 'g1')
  assert.deepEqual(JSON.parse(await readFile(join(home, 'goals', 'index.json'), 'utf8')).ids, ['g1'])
})

test('an indexed missing document and a future document version refuse startup without rewriting', async () => {
  const home = await empty()
  const index = JSON.stringify({ version: 1, ids: ['missing'], noticeSeen: true })
  await writeFile(join(home, 'goals', 'index.json'), index)
  await assert.rejects(new GoalStore(home).load(), /indexed Goal missing is missing/)
  assert.equal(await readFile(join(home, 'goals', 'index.json'), 'utf8'), index)
  await writeFile(join(home, 'goals', 'missing.json'), JSON.stringify({ ...document('missing'), version: 2 }))
  await assert.rejects(new GoalStore(home).load(), /Goal document cannot be read/)
})

test('the 8 MiB limit refuses before making a temporary file', async () => {
  const home = await empty()
  await assert.rejects(atomicJson(join(home, 'goals', 'huge.json'), { text: 'x'.repeat(8 * 1024 * 1024) }), /larger than 8 MiB/)
  assert.deepEqual(await readdir(join(home, 'goals')), ['index.json'])
})
```

Create `packages/server/test/goal-writer-lease.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { acquireDeskWriter } from '../src/goals/writer-lease.js'
import { tempDir } from './scratch.js'

test('a second writer refuses and an ordinary release admits the next one', async () => {
  const home = tempDir('hd-goal-writer-')
  const first = await acquireDeskWriter(home)
  await assert.rejects(acquireDeskWriter(home), /Another desk holds this state directory/)
  await first.release()
  const second = await acquireDeskWriter(home)
  await second.release()
})

test('release never removes a lock whose token changed', async () => {
  const home = tempDir('hd-goal-writer-token-')
  const first = await acquireDeskWriter(home)
  const file = join(home, 'desk-writer.lock')
  const owner = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...owner, token: 'replacement' }))
  await first.release()
  assert.equal(JSON.parse(await readFile(file, 'utf8')).token, 'replacement')
})

test('a demonstrably dead owner is recovered under the recovery directory', async () => {
  const home = tempDir('hd-goal-writer-dead-')
  await writeFile(join(home, 'desk-writer.lock'), JSON.stringify({ version: 1, pid: 2147483647, token: 'dead', startedAt: 1 }))
  const lease = await acquireDeskWriter(home)
  assert.equal(JSON.parse(await readFile(join(home, 'desk-writer.lock'), 'utf8')).pid, process.pid)
  await lease.release()
})

test('malformed ownership and an existing recovery directory are never removed on age', async () => {
  const home = tempDir('hd-goal-writer-bad-')
  const file = join(home, 'desk-writer.lock')
  await writeFile(file, '{ broken')
  await assert.rejects(acquireDeskWriter(home))
  assert.equal(await readFile(file, 'utf8'), '{ broken')
  const stale = JSON.stringify({ version: 1, pid: 2147483647, token: 'dead', startedAt: 1 })
  await writeFile(file, stale)
  await mkdir(join(home, 'desk-writer-recovery'))
  await assert.rejects(acquireDeskWriter(home), /Repair desk-writer-recovery/)
  assert.equal(await readFile(file, 'utf8'), stale)
})


test('a failed initial write removes only the lock this acquisition created', async () => {
  const home = tempDir('hd-goal-writer-write-')
  await assert.rejects(acquireDeskWriter(home, async () => { throw new Error('lock write failed') }), /lock write failed/)
  assert.deepEqual(await readdir(home), [])
  const retry = await acquireDeskWriter(home)
  await retry.release()
})
```

Create `packages/server/test/goal-seatbook.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { foldSeats, lineOf, type SeatOpening } from '../src/evidence/records.js'
import { SeatBook } from '../src/evidence/seats.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { seat } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

const opening = (id: string): SeatOpening => {
  const { closed: _closed, ...record } = seat(id, { standing: { kind: 'unknown' } })
  return record
}

test('unknown is recorded as unknown and arbitrary standing-order tags are refused', () => {
  const record = opening('legacy-one')
  const where = { file: 'seats', project: '/work/repo' } as const
  assert.deepEqual(lineOf({ v: 1, type: 'seat', record }, where), { type: 'seat', record })
  assert.equal(lineOf({ v: 1, type: 'seat', record: { ...record, standing: { kind: 'invented' } } }, where), null)
})

test('an identical import is idempotent and a different opening under the same id refuses', async () => {
  const store = new EvidenceStore(tempDir('hd-goal-evidence-'))
  const book = new SeatBook(store, () => 10)
  await book.importOpening('/work/repo', opening('one'))
  await book.importOpening('/work/repo', { ...opening('one'), standing: { kind: 'unknown' } })
  assert.equal(book.all().length, 1)
  assert.equal((await store.read('/work/repo', 'seats')).lines.length, 1)
  await assert.rejects(book.importOpening('/work/repo', { ...opening('one'), role: 'another-role' }), /different Seat/)
})

test('close by id keeps another Seat on the same conversation and preserves the first closing', async () => {
  const store = new EvidenceStore(tempDir('hd-goal-evidence-'))
  const book = new SeatBook(store, () => 10)
  const first = opening('one')
  const second = { ...opening('two'), session: first.session, board: null }
  await book.importOpening('/work/repo', first)
  await book.importOpening('/work/repo', second)
  const closed = await book.closeId('one', 'released')
  assert.deepEqual(closed.closed, { at: 10, why: 'released' })
  assert.equal(book.byId('two')?.closed, null)
  await book.closeId('one', 'deleted')
  const { lines } = await store.read('/work/repo', 'seats')
  assert.equal(lines.filter((line) => line.type === 'seat-closed').length, 1)
  assert.deepEqual(foldSeats(lines).find((one) => one.id === 'one')?.closed, { at: 10, why: 'released' })
})

test('a restored Seat cannot be closed by a Goal release', async () => {
  const store = new EvidenceStore(tempDir('hd-goal-evidence-'))
  const book = new SeatBook(store, () => 10)
  await book.importOpening('/work/repo', { ...opening('restored'), restored: { at: 2 } })
  await assert.rejects(book.closeId('restored', 'released'), /history and cannot be closed/)
  assert.equal((await store.read('/work/repo', 'seats')).lines.length, 1)
})
```

- [ ] **Step 2: Run the missing-module red**

Run: `pnpm run build:node`

Expected: FAIL — `Cannot find module '../src/goals/migration.js'`, `Cannot find module '../src/goals/store.js'`, and `Property 'importOpening' does not exist on type 'SeatBook'`. Do not alter the tests to remove these seams.

- [ ] **Step 3: Define durable documents and write them atomically**

Create `packages/server/src/goals/store.ts` with these complete contents:

```ts
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Goal, GoalBoard, GoalCitation, GoalId, GoalReceipt, Plan, SeatId } from '@harnessdesk/protocol'

import type { RememberedMember } from './migration.js'
import type { GoalOperation } from './operations.js'

export interface GoalDocument {
  readonly version: 1
  readonly restored?: { readonly at: number }
  readonly goal: Goal
  readonly board: GoalBoard
  readonly legacy?: {
    readonly source: string
    readonly plans: readonly Plan[]
    readonly nicknames: Readonly<Record<string, string>>
    readonly roster: Readonly<Record<string, RememberedMember>>
    readonly sourceSha256: string
    readonly seatLocations: Readonly<Record<SeatId, 'remembered' | 'inferred'>>
  }
  readonly citations: readonly GoalCitation[]
  readonly receipt: GoalReceipt | null
  readonly operation: GoalOperation | null
}

export const GOAL_DOCUMENT_LIMIT = 8 * 1024 * 1024

export const goalFile = (id: string): string => {
  const file = `${encodeURIComponent(id)}.json`
  if (!id || file === 'index.json' || Buffer.byteLength(file) > 255) {
    throw new Error('This Goal id cannot be stored under the current file naming rule. The original file was kept.')
  }
  return file
}

export async function syncDirectory(folder: string): Promise<void> {
  const handle = await open(folder, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** A rename may already have landed when its directory sync fails. The caller must stop writing. */
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > GOAL_DOCUMENT_LIMIT) {
    throw new Error('This Goal document is larger than 8 MiB. Nothing was written.')
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    await syncDirectory(dirname(file))
  } finally {
    await rm(temporary, { force: true })
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((one) => typeof one === 'string')

/** Refuse a partial or newer document; do not repair it by dropping fields. */
export function documentOf(value: unknown): GoalDocument {
  const bad = (): never => { throw new Error('A Goal document cannot be read. Its original bytes were kept.') }
  if (!object(value) || value.version !== 1 || !object(value.goal) || !object(value.board)) return bad()
  const goal = value.goal
  const board = value.board
  if (
    typeof goal.id !== 'string' || typeof goal.root !== 'string' || typeof goal.cwd !== 'string' ||
    typeof goal.sentence !== 'string' || !goal.sentence.trim() ||
    !['open', 'wrapping', 'wrapped'].includes(String(goal.state)) ||
    !Number.isSafeInteger(goal.revision) || Number(goal.revision) < 0 ||
    !['shared', 'isolated'].includes(String(goal.checkout)) || !strings(goal.dependsOn) ||
    !Number.isFinite(goal.createdAt) || !Number.isFinite(goal.updatedAt) ||
    !object(goal.origin) || !['person', 'legacy', 'flow', 'trigger'].includes(String(goal.origin.kind)) ||
    !(goal.receipt === null || typeof goal.receipt === 'string') ||
    'members' in goal || 'members' in board || 'roles' in board || 'plans' in board ||
    !Number.isSafeInteger(board.nextIntent) || Number(board.nextIntent) < 1 ||
    typeof board.messaging !== 'boolean' || !Array.isArray(board.intents) || !Array.isArray(board.channel) ||
    !Array.isArray(value.citations) || !('receipt' in value) || !('operation' in value)
  ) return bad()
  for (const card of board.intents) {
    if (!object(card) || !Number.isSafeInteger(card.id) || Number(card.id) < 1 ||
      typeof card.title !== 'string' || !['open', 'claimed', 'blocked', 'done', 'abandoned'].includes(String(card.state)) ||
      !strings(card.files) || !Array.isArray(card.dependsOn) ||
      !card.dependsOn.every((id) => Number.isSafeInteger(id) && id > 0) ||
      !Number.isFinite(card.createdAt) || !Number.isFinite(card.updatedAt)) return bad()
  }
  for (const entry of board.channel) {
    if (!object(entry) || typeof entry.id !== 'string' || !Number.isFinite(entry.at) ||
      !['message', 'signal', 'notice'].includes(String(entry.kind))) return bad()
    if (entry.kind === 'message' && (typeof entry.text !== 'string' || !object(entry.from) ||
      !['delivered', 'queued', 'held', 'refused', 'shown'].includes(String(entry.state)))) return bad()
  }
  if (value.receipt !== null && (!object(value.receipt) || value.receipt.version !== 1 ||
    value.receipt.goal !== goal.id || value.receipt.id !== goal.receipt)) return bad()
  if (value.operation !== null && (!object(value.operation) || value.operation.goal !== goal.id ||
    typeof value.operation.id !== 'string' || !['assignment', 'release', 'wrap'].includes(String(value.operation.kind)))) return bad()
  if (goal.state === 'wrapped' && value.receipt === null) return bad()
  if (value.restored !== undefined && (!object(value.restored) || !Number.isFinite(value.restored.at))) return bad()
  goalFile(goal.id)
  return value as unknown as GoalDocument
}

export interface GoalIndex {
  readonly version: 1
  readonly noticeSeen: boolean
  readonly ids: readonly string[]
}

export function indexOf(value: unknown): GoalIndex {
  if (!object(value) || value.version !== 1 || typeof value.noticeSeen !== 'boolean' ||
    !strings(value.ids) || new Set(value.ids).size !== value.ids.length) {
    throw new Error('The Goal index cannot be read. Its original bytes were kept.')
  }
  value.ids.forEach(goalFile)
  return value as unknown as GoalIndex
}

/** One queue for file writes. The Goal transaction queue never calls itself recursively. */
export class GoalStore {
  readonly #directory: string
  readonly #write: typeof atomicJson
  #documents = new Map<string, GoalDocument>()
  #index: GoalIndex = { version: 1, noticeSeen: true, ids: [] }
  #tail: Promise<void> = Promise.resolve()
  #problem: Error | null = null

  constructor(home: string, write: typeof atomicJson = atomicJson) {
    this.#directory = join(home, 'goals')
    this.#write = write
  }

  get problem(): string | null { return this.#problem?.message ?? null }
  get noticeSeen(): boolean { return this.#index.noticeSeen }

  async load(): Promise<void> {
    const files = await readdir(this.#directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (files === null) {
      throw new Error('The Goal store is not activated. Finish the room upgrade first.')
    }
    const index = indexOf(JSON.parse(await readFile(join(this.#directory, 'index.json'), 'utf8')))
    const documents = new Map<string, GoalDocument>()
    for (const file of files.filter((one) => one.endsWith('.json') && one !== 'index.json').sort()) {
      const path = join(this.#directory, file)
      if ((await stat(path)).size > GOAL_DOCUMENT_LIMIT) throw new Error(`Goal file ${file} is larger than 8 MiB.`)
      const document = documentOf(JSON.parse(await readFile(path, 'utf8')))
      if (goalFile(document.goal.id) !== file || documents.has(document.goal.id)) {
        throw new Error(`Goal file ${file} does not match its id. Its original bytes were kept.`)
      }
      documents.set(document.goal.id, document)
    }
    for (const id of index.ids) {
      if (!documents.has(id)) throw new Error(`The indexed Goal ${id} is missing. The desk was not opened empty.`)
    }
    // A create writes the document first. Recover its index after a crash at that boundary.
    const recovered: GoalIndex = { ...index, ids: [...documents.keys()].sort() }
    if (JSON.stringify(recovered.ids) !== JSON.stringify([...index.ids].sort())) {
      await this.#persist(join(this.#directory, 'index.json'), recovered)
    }
    this.#documents = documents
    this.#index = recovered
    this.#problem = null
  }

  list(): readonly GoalDocument[] { return [...this.#documents.values()].map((one) => structuredClone(one)) }

  read(id: GoalId): GoalDocument {
    const document = this.#documents.get(id)
    if (!document) throw new Error('That Goal is not on this desk.')
    return structuredClone(document)
  }

  save(document: GoalDocument, expectedRevision: number | null): Promise<void> {
    const copy = structuredClone(document)
    return this.#enqueue(async () => {
      documentOf(copy)
      const current = this.#documents.get(copy.goal.id)
      if (expectedRevision === null ? current !== undefined : current?.goal.revision !== expectedRevision) {
        throw new Error('This Goal changed. Read it again before saving.')
      }
      if (current && (current.goal.id !== copy.goal.id || current.goal.root !== copy.goal.root)) {
        throw new Error('A Goal cannot change its identity or project.')
      }
      if (copy.goal.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) {
        throw new Error('Every Goal change must advance its revision exactly once.')
      }
      if (current?.goal.state === 'wrapped') throw new Error('A wrapped Goal is read-only. Start another Goal for new work.')
      await this.#persist(join(this.#directory, goalFile(copy.goal.id)), copy)
      if (!current) {
        const index: GoalIndex = { ...this.#index, ids: [...this.#index.ids, copy.goal.id].sort() }
        await this.#persist(join(this.#directory, 'index.json'), index)
        this.#index = index
      }
      this.#documents.set(copy.goal.id, copy)
    })
  }

  acknowledgeMigration(): Promise<void> {
    return this.#enqueue(async () => {
      const index: GoalIndex = { ...this.#index, noticeSeen: true }
      await this.#persist(join(this.#directory, 'index.json'), index)
      this.#index = index
    })
  }

  #enqueue(write: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(async () => {
      if (this.#problem) throw this.#problem
      await write()
    })
    this.#tail = result.catch(() => {})
    return result
  }

  async #persist(file: string, value: unknown): Promise<void> {
    try {
      await this.#write(file, value)
    } catch (error) {
      this.#problem = error instanceof Error ? error : new Error(String(error))
      throw this.#problem
    }
  }

  async flush(): Promise<void> {
    await this.#tail
    if (this.#problem) throw this.#problem
  }
}
```

The private file queue is separate from the desk transaction queue. Validation and revision refusals do not poison it; an I/O failure does. Creation writes the document before adding it to the index, and load repairs that one recoverable boundary. An index naming a missing document, a wrong filename, an unknown version or malformed JSON refuses startup. A caller receives clones, so it cannot mutate cached authority.

- [ ] **Step 4: Declare the operation journal before any code writes one**

Create `packages/server/src/goals/operations.ts` with:

```ts
import type { GoalReceipt, SeatId } from '@harnessdesk/protocol'

import type { SeatOpening } from '../evidence/records.js'

/** Written before any cross-store mutation. A retry keeps these ids. */
export type GoalOperation =
  | {
      kind: 'assignment'
      id: string
      goal: string
      card: number | null
      opening: SeatOpening
      close: readonly SeatId[]
    }
  | { kind: 'release'; id: string; goal: string; seat: SeatId; reason: 'released' }
  | { kind: 'wrap'; id: string; goal: string; stamp: string; receipt: GoalReceipt }
```

- [ ] **Step 5: Convert all rooms and activate with one directory rename**

Create `packages/server/src/goals/migration.ts` with these complete contents:

```ts
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

import type { Goal, Intent, Plan, SeatId, SeatRecord, TeamEntry } from '@harnessdesk/protocol'

import type { SeatOpening } from '../evidence/records.js'
import { atomicJson, documentOf, goalFile, GoalStore, syncDirectory, type GoalDocument } from './store.js'

/** Archival display data. This never establishes membership after activation. */
export interface RememberedMember {
  readonly title: string | null
  readonly agent: string
  readonly cwd: string
  readonly model?: string | null
  readonly at: number
}

export interface LegacyRoom {
  readonly version: 1
  readonly id?: string
  readonly root?: string
  readonly cwd?: string
  readonly name?: string
  readonly updatedAt?: number
  readonly members?: readonly string[]
  readonly nicknames?: Readonly<Record<string, string>>
  readonly roles?: Readonly<Record<string, string>>
  readonly roster?: Readonly<Record<string, RememberedMember>>
  readonly plans?: readonly Plan[]
  readonly nextPlan?: number
  readonly nextIntent: number
  readonly messaging: boolean
  readonly intents: readonly Intent[]
  readonly channel: readonly TeamEntry[]
}

export interface MigrationSeat {
  id: string
  board: string
  runtime: string
  sessionId: string
  cwd: string
  project: string
  role: string | null
  openedAt: number
  name: string
  cwdKnown: boolean
  seatLabel: string
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const failure = (file: string, what: string): never => {
  throw new Error(`Cannot read ${what} in ${file}; the old file was kept.`)
}

/** Validate the whole input before returning a value eligible for activation. */
export function convertRoom(file: string, value: unknown, source?: string): {
  goal: Goal
  seats: MigrationSeat[]
  board: GoalDocument['board']
  legacy: NonNullable<GoalDocument['legacy']>
} {
  if (!file.endsWith('.json') || !object(value) || value.version !== 1 ||
    !Array.isArray(value.channel) || !Array.isArray(value.intents) ||
    !Number.isSafeInteger(value.nextIntent) || Number(value.nextIntent) < 1 ||
    typeof value.messaging !== 'boolean') return failure(file, 'the room')
  const raw = value as unknown as LegacyRoom
  const encoded = decodeURIComponent(file.slice(0, -5))
  const id = raw.id ?? encoded
  const root = raw.root ?? encoded
  const cwd = raw.cwd ?? root
  if (typeof id !== 'string' || typeof root !== 'string' || typeof cwd !== 'string' ||
    !isAbsolute(root) || !isAbsolute(cwd)) return failure(file, 'the location')
  goalFile(id)
  for (const field of ['nicknames', 'roles', 'roster'] as const) {
    if (raw[field] !== undefined && !object(raw[field])) return failure(file, field)
  }
  for (const words of [raw.nicknames ?? {}, raw.roles ?? {}]) {
    if (Object.values(words).some((word) => typeof word !== 'string')) return failure(file, 'member words')
  }
  for (const remembered of Object.values(raw.roster ?? {})) {
    if (!object(remembered) || typeof remembered.cwd !== 'string' || !isAbsolute(remembered.cwd) ||
      typeof remembered.agent !== 'string' || !Number.isFinite(remembered.at) ||
      !(remembered.title === null || typeof remembered.title === 'string')) return failure(file, 'the roster')
  }
  const plans = raw.plans ?? []
  if (!Array.isArray(plans) || plans.some((plan) => !object(plan) || !Number.isSafeInteger(plan.id) ||
    typeof plan.goal !== 'string' || !['running', 'wrapped'].includes(String(plan.state)) ||
    !Number.isFinite(plan.createdAt) ||
    !(plan.wrappedAt == null || Number.isFinite(plan.wrappedAt)))) return failure(file, 'Plans')
  const order = (a: Plan, b: Plan): number => b.createdAt - a.createdAt || b.id - a.id
  const selected = plans.filter((plan) => plan.state === 'running').sort(order)[0] ?? [...plans].sort(order)[0]
  if (raw.name !== undefined && typeof raw.name !== 'string') return failure(file, 'the name')
  const sentence = selected?.goal.trim() || raw.name?.trim() || basename(root) || 'Imported work'
  const stamps = [0, ...raw.channel.map((entry) => entry.at),
    ...raw.intents.flatMap((card) => [card.createdAt, card.updatedAt]),
    ...plans.flatMap((plan) => [plan.createdAt, plan.wrappedAt ?? 0])]
  if (stamps.some((at) => !Number.isFinite(at))) return failure(file, 'timestamps')
  const updatedAt = raw.updatedAt ?? Math.max(...stamps)
  if (!Number.isFinite(updatedAt)) return failure(file, 'activity')
  const goal: Goal = {
    id, root, cwd, sentence, state: 'open', revision: 0, checkout: 'shared', dependsOn: [],
    origin: { kind: 'legacy', source: file },
    createdAt: Math.min(updatedAt, ...plans.map((plan) => plan.createdAt)),
    updatedAt, receipt: null,
  }
  const memberKeys = raw.members ?? Object.keys(raw.nicknames ?? {})
  if (!Array.isArray(memberKeys) || memberKeys.some((key) => typeof key !== 'string')) {
    return failure(file, 'members')
  }
  const seats = [...new Set(memberKeys)].map((key): MigrationSeat => {
    const parts = key.split('\u0000')
    if (parts.length !== 2 || !parts[0] || !parts[1]) return failure(file, 'a member')
    const remembered = raw.roster?.[key]
    return {
      id: `legacy-${createHash('sha256').update(JSON.stringify([id, key])).digest('hex')}`,
      board: id,
      runtime: parts[0],
      sessionId: parts[1],
      cwd: remembered?.cwd ?? cwd,
      project: root,
      role: raw.roles?.[key] ?? null,
      openedAt: remembered?.at ?? updatedAt,
      name: raw.nicknames?.[key] ?? remembered?.title ?? remembered?.agent ?? 'Conversation',
      cwdKnown: remembered !== undefined,
      seatLabel: remembered ? [remembered.agent, remembered.model].filter(Boolean).join(' · ') : parts[0],
    }
  })
  const board = {
    nextIntent: raw.nextIntent,
    messaging: raw.messaging,
    intents: raw.intents.map((card) => ({ ...card, files: card.files ?? [], dependsOn: card.dependsOn ?? [] })),
    channel: raw.channel,
  }
  const legacy: NonNullable<GoalDocument['legacy']> = {
    source: file,
    plans,
    nicknames: raw.nicknames ?? {},
    roster: raw.roster ?? {},
    sourceSha256: createHash('sha256').update(source ?? JSON.stringify(value)).digest('hex'),
    seatLocations: Object.fromEntries(seats.map((seat) => [seat.id, seat.cwdKnown ? 'remembered' : 'inferred'])),
  }
  documentOf({ version: 1, goal, board, legacy, citations: [], receipt: null, operation: null })
  return { goal, board, seats, legacy }
}

export function migrationOpening(seat: MigrationSeat): SeatOpening {
  return {
    id: seat.id,
    agent: null,
    briefDigest: null,
    seat: { runtime: seat.runtime },
    seatLabel: seat.seatLabel,
    passedOver: [],
    standing: { kind: 'unknown' },
    ceiling: null,
    checkout: { cwd: seat.cwd, project: seat.project, branch: null, head: null },
    session: { runtime: seat.runtime, sessionId: seat.sessionId },
    board: seat.board,
    role: seat.role,
    openedAt: seat.openedAt,
  }
}

export async function importMigrationSeats(
  seats: readonly MigrationSeat[],
  book: {
    all(): readonly SeatRecord[]
    importOpening(project: string, opening: SeatOpening): Promise<SeatRecord>
  },
): Promise<void> {
  for (const wanted of seats) {
    const matches = book.all().filter((one) => !one.closed && !one.restored &&
      one.board === wanted.board && one.session.runtime === wanted.runtime && one.session.sessionId === wanted.sessionId)
    if (matches.length > 1) throw new Error(`Two kept Seats name one member of ${wanted.board}. Repair the evidence before upgrading.`)
    if (matches.length === 1) continue
    await book.importOpening(wanted.project, migrationOpening(wanted))
  }
}

export async function migrateDesk(
  home: string,
  importSeats: (seats: MigrationSeat[]) => Promise<void>,
  beforeActivate: () => Promise<void> = async () => {},
): Promise<'migrated' | 'existing'> {
  const target = join(home, 'goals')
  const existing = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) {
    const store = new GoalStore(home)
    await store.load()
    return 'existing'
  }
  const source = join(home, 'team')
  const names = await readdir(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const converted: ReturnType<typeof convertRoom>[] = []
  const ids = new Map<string, string>()
  const owners = new Map<string, string>()
  for (const name of names.filter((one) => one.endsWith('.json') && one !== 'inbound.json').sort()) {
    const text = await readFile(join(source, name), 'utf8')
    const room = convertRoom(name, JSON.parse(text), text)
    const duplicate = ids.get(room.goal.id)
    if (duplicate) throw new Error(`Rooms ${duplicate} and ${name} have one id. Both files were kept.`)
    ids.set(room.goal.id, name)
    for (const seat of room.seats) {
      const key = JSON.stringify([seat.runtime, seat.sessionId])
      const owner = owners.get(key)
      if (owner) throw new Error(`Rooms ${owner} and ${name} hold one conversation. Both files were kept.`)
      owners.set(key, name)
    }
    converted.push(room)
  }
  const staging = join(home, `goals.pending-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  try {
    for (const room of converted) {
      const document: GoalDocument = {
        version: 1, goal: room.goal, board: room.board, legacy: room.legacy,
        citations: [], receipt: null, operation: null,
      }
      await atomicJson(join(staging, goalFile(room.goal.id)), document)
    }
    await atomicJson(join(staging, 'index.json'), {
      version: 1, noticeSeen: converted.length === 0, ids: [...ids.keys()].sort(),
    })
    await importSeats(converted.flatMap((room) => room.seats))
    await beforeActivate()
    await syncDirectory(staging)
    await rename(staging, target)
    await syncDirectory(home)
    return 'migrated'
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
```

`sourceSha256` hashes the original bytes when reading disk. `inbound.json` is never staged, renamed or rewritten by migration. A formerly wrapped Plan creates an open Goal with no receipt. The `index` filename and overlong encoded names currently refuse rather than overwrite another file; the fixed filename contract requires a controller decision for those legacy ids (reported after this batch).

- [ ] **Step 6: Acquire the desk writer before startup writes**

Create `packages/server/src/goals/writer-lease.ts` with these complete contents:

```ts
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

import { syncDirectory } from './store.js'

interface Writer {
  version: 1
  pid: number
  token: string
  startedAt: number
}

const ownerOf = (text: string): Writer => {
  try {
    const value = JSON.parse(text) as Partial<Writer> | null
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 ||
      typeof value.token !== 'string' || !value.token || !Number.isFinite(value.startedAt)) {
      throw new Error('invalid owner')
    }
    return value as Writer
  } catch {
    throw new Error('The desk writer lock is unreadable. Repair desk-writer.lock before opening this desk.')
  }
}

const dead = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export async function acquireDeskWriter(
  home: string,
  write: (handle: FileHandle, text: string) => Promise<void> = async (handle, text) => {
    await handle.writeFile(text)
    await handle.sync()
  },
): Promise<{ release(): Promise<void> }> {
  await mkdir(home, { recursive: true })
  const file = join(home, 'desk-writer.lock')
  const recovery = join(home, 'desk-writer-recovery')
  const mine: Writer = { version: 1, pid: process.pid, token: randomUUID(), startedAt: Date.now() }
  const create = async (): Promise<void> => {
    const handle = await open(file, 'wx', 0o600)
    try {
      await write(handle, JSON.stringify(mine))
    } catch (error) {
      await handle.close()
      // This process created the file exclusively and has not exposed a lease.
      await rm(file, { force: true })
      throw error
    }
    await handle.close()
    await syncDirectory(home)
  }
  try {
    await create()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const observed = ownerOf(await readFile(file, 'utf8'))
    if (!dead(observed.pid)) {
      throw new Error('Another desk holds this state directory. Close it before opening this desk.')
    }
    try {
      await mkdir(recovery)
    } catch {
      throw new Error('Desk writer recovery is already held. Repair desk-writer-recovery before retrying.')
    }
    try {
      const current = ownerOf(await readFile(file, 'utf8'))
      if (current.token !== observed.token || !dead(current.pid)) {
        throw new Error('The desk writer changed during recovery. Close the other desk and retry.')
      }
      await rm(file)
      await create()
    } finally {
      await rm(recovery, { recursive: true })
    }
  }
  return {
    async release(): Promise<void> {
      let current: Writer
      try {
        current = ownerOf(await readFile(file, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (current.token !== mine.token) return
      await rm(file)
      await syncDirectory(home)
    },
  }
}
```

The optional write function is solely a deterministic failure seam in the lease test. Production calls `acquireDeskWriter(home)` with the durable default. Unknown ownership, `EPERM`, and a held recovery directory refuse. Nothing sends a terminating signal.

- [ ] **Step 7: Extend the durable standing-order vocabulary and SeatBook**

In `packages/protocol/src/evidence.ts`, replace this exact anchor:

```ts
export type StandingOrder =
  | { readonly kind: 'permission'; readonly permission: FlowPermission }
  | { readonly kind: 'ceiling'; readonly level: CeilingLevel }
```

with:

```ts
export type StandingOrder =
  | { readonly kind: 'permission'; readonly permission: FlowPermission }
  | { readonly kind: 'ceiling'; readonly level: CeilingLevel }
  | { readonly kind: 'unknown' }
```

In `packages/server/src/evidence/records.ts`, replace this exact anchor:

```ts
const isStanding = (value: unknown): value is StandingOrder =>
  isRecord(value) &&
  ((value['kind'] === 'permission' && PERMISSIONS.has(value['permission'] as string)) ||
    (value['kind'] === 'ceiling' && LEVELS.has(value['level'] as string)))
```

with:

```ts
const isStanding = (value: unknown): value is StandingOrder =>
  isRecord(value) &&
  (value['kind'] === 'unknown' ||
    (value['kind'] === 'permission' && PERMISSIONS.has(value['permission'] as string)) ||
    (value['kind'] === 'ceiling' && LEVELS.has(value['level'] as string)))
```

In `packages/server/src/evidence/seats.ts`, insert these complete methods immediately before the exact anchor `  #index(seat: SeatRecord, project: string): void {`. The existing `#index` method stays after them.

```ts
  all(): readonly SeatRecord[] {
    return [...this.#byId.values()]
  }

  async importOpening(project: string, opening: SeatOpening): Promise<SeatRecord> {
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
      if (value !== null && typeof value === 'object') {
        return `{${Object.entries(value).filter(([, field]) => field !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(',')}}`
      }
      return JSON.stringify(value) ?? 'null'
    }
    await this.#store.merge(project, 'seats', [{ type: 'seat', record: opening }], (line, here, added) => {
      const previous = [...here, ...added].find((one) => one.type === 'seat' && one.record.id === opening.id)
      if (!previous) return 'add'
      if (previous.type !== 'seat' || line.type !== 'seat' || canonical(previous.record) !== canonical(line.record)) {
        throw new Error('A different Seat already has this id. The existing evidence was kept.')
      }
      return 'duplicate'
    })
    const { lines } = await this.#store.read(project, 'seats')
    const record = foldSeats(lines).find((one) => one.id === opening.id)
    if (!record) throw new Error('The imported Seat could not be read back. Repair the evidence store and retry.')
    this.#index(record, project)
    this.#byId.set(record.id, record)
    return record
  }

  async closeId(id: SeatId, why: string): Promise<SeatRecord> {
    const seat = this.#byId.get(id)
    if (!seat) throw new Error('That Seat is not recorded on this desk.')
    if (seat.restored) throw new Error('A restored Seat is history and cannot be closed here.')
    const project = this.#projects.get(id) ?? seat.checkout.project
    await this.#store.merge(project, 'seats', [
      { type: 'seat-closed', closing: { seat: id, at: this.#now(), why } },
    ], (_line, here, added) =>
      [...here, ...added].some((line) => line.type === 'seat-closed' && line.closing.seat === id)
        ? 'duplicate'
        : 'add',
    )
    const { lines } = await this.#store.read(project, 'seats')
    const closed = foldSeats(lines).find((record) => record.id === id)
    if (!closed) throw new Error('The Seat closing could not be read back. Retry after fixing the evidence store.')
    this.#byId.set(id, closed)
    return closed
  }
```

In `packages/server/src/evidence/seats.ts`, replace this exact anchor:

```ts
  /** Closes every Seat this desk kept for a conversation that is still open, and answers what it closed. */
  async closed(runtime: string, sessionId: string, why: string): Promise<SeatRecord[]> {
    const open = this.of(runtime, sessionId).filter((seat) => seat.closed === null && !seat.restored)
    const at = this.#now()
    const out: SeatRecord[] = []
    for (const seat of open) {
      const project = this.#projects.get(seat.id) ?? seat.checkout.project
      await this.#store.append(project, 'seats', [{ type: 'seat-closed', closing: { seat: seat.id, at, why } }])
      const closed: SeatRecord = { ...seat, closed: { at, why } }
      this.#byId.set(seat.id, closed)
      out.push(closed)
    }
    return out
  }
```

with:

```ts
  /** Closes this desk's open records for a deleted conversation, once each. */
  async closed(runtime: string, sessionId: string, why: string): Promise<SeatRecord[]> {
    const open = this.of(runtime, sessionId).filter((seat) => seat.closed === null && !seat.restored)
    const out: SeatRecord[] = []
    for (const seat of open) out.push(await this.closeId(seat.id, why))
    return out
  }
```

In `packages/ui/src/components/SeatRecordBlock.tsx`, replace this exact anchor:

```ts
export const orderWords = (standing: SeatRecord['standing']): string =>
  standing.kind === 'permission' ? ceilingWords(standing.permission) : `${LEVEL_WORDS[standing.level]} · its ceiling`
```

with:

```ts
export const orderWords = (standing: SeatRecord['standing']): string => {
  if (standing.kind === 'unknown') return 'Not recorded'
  return standing.kind === 'permission'
    ? ceilingWords(standing.permission)
    : `${LEVEL_WORDS[standing.level]} · its ceiling`
}
```

Named test edit: append this case to `SeatRecordBlock.test.tsx`, whose phase-4 import already includes `orderWords`; retain all held/asked/restored assertions.

```ts
it('says when an imported standing order was never recorded', () => {
  expect(orderWords({ kind: 'unknown' })).toBe('Not recorded')
})
```

Named type-test edit: phase 4’s two-arm `StandingOrder` exhaustiveness assertion must include the new unknown arm; `goal-seatbook.test.ts` above owns its reader round trip and refusal test. No existing record is rewritten.

- [ ] **Step 8: Wire startup, compatibility reads and root repair without exposing half a migration**

Acquire writer → load machine state → load EvidencePlane/SeatBook → migrate or load Goal store → replay pending Goal operations → rebuild Team from Goal boards and Seat projections → perform the existing bounded root re-resolution → load Flows → attach message delivery and replay to UI. Keep root migration's 4000-ms deadline, concurrent resolution, no-parent promotion rule and late-result guard. If a root changes, record its corrected canonical project mapping before resolving new membership, with no change to Goal ID or existing evidence paths. Migration failure loads the original rooms through a non-mutating reader, shows “Your rooms are still here. The upgrade could not finish: … Close the other desk or fix the named file, then retry.” and disables mutations/flow startup. `inbound.json` continues to be read by Team with its current fail-closed behavior.

On activation, mark queued deliveries refused with the existing restart reason through normal Team recovery; never send them. Keep held entries and their exact envelopes. `goal/migration/ack` writes `noticeSeen:true` only after the person dismisses the once-only notice. No notice on a fresh empty desk; set `noticeSeen:true` at empty initialization.

**Integration boundary still requiring exact edits:** this depth pass does not claim that the Host startup/Team compatibility wiring in this step is executable code. `Team.load()` currently mutates legacy files and combines root repair with board installation; invoking it as a read-only fallback violates the migration decision. The controller must supply the non-mutating Team reader and the authorized root-remapping transaction before this task is implementation-ready. Do not run the old loader on a failed migration. The tested converter/store/import code above does not prove this host boundary.

- [ ] **Step 9: Run the focused persistence and evidence tests**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/goal-migration.test.js packages/server/dist/test/goal-store.test.js packages/server/dist/test/goal-writer-lease.test.js packages/server/dist/test/goal-seatbook.test.js`

Expected: PASS — 7 migration, 6 store, 5 lease and 4 SeatBook tests, 22 total.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/SeatRecordBlock.test.tsx`

Expected: PASS — the existing suite plus the one new unknown-order case. Required at implementation time; not claimed as run in this phase-2 checkout.

- [ ] **Step 10: Prove the historical id assertions fail when conversion rekeys rooms**

Temporarily change `const id = raw.id ?? encoded` to `const id = 'new-' + (raw.id ?? encoded)`.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/goal-migration.test.js`

Expected: FAIL — 3 failed, 4 passed. The eight-shape test receives `undefined` instead of `'Second'`; readback raises `That Goal is not on this desk.`; the reserved-filename test raises `Missing expected exception.`

Restore the original id expression.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/goal-migration.test.js`

Expected: PASS — 7 tests.

- [ ] **Step 11: Commit only after the startup boundary and original regressions are complete**

The implementation owner runs the complete gate before committing; the depth-pass writer does not execute this step.

Run: `pnpm verify`

Expected: Exit 0. A sandbox refusal is not a passing gate; the controller runs this on the real surface.

```bash
git add packages/server/src/goals/store.ts packages/server/src/goals/migration.ts packages/server/src/goals/writer-lease.ts packages/server/src/goals/operations.ts packages/server/src/evidence/seats.ts packages/server/src/evidence/records.ts packages/protocol/src/evidence.ts packages/ui/src/components/SeatRecordBlock.tsx packages/ui/src/components/SeatRecordBlock.test.tsx packages/server/src/host.ts packages/server/src/team.ts packages/server/test/goal-migration.test.ts packages/server/test/goal-store.test.ts packages/server/test/goal-writer-lease.test.ts packages/server/test/goal-seatbook.test.ts
git commit -m "feat(goals): persist Goals and stage room migration" -m "Co-Authored-By: Codex <agent@harnessdesk.app>"
```

### Task 3: Derive membership from Seats and bridge existing flows

One desk queue covers membership changes. Assignment proves that the runtime still owns an idle conversation in the Goal's project, stages a fixed opening, and only then changes the evidence store or card. Release closes exactly that opening. Recovery replays the same ids, not a new attempt.

**Files:**
- Create: `packages/server/src/goals/assignments.ts`, `packages/server/src/goals/members.ts`, `packages/server/src/goals/plane.ts`, `packages/server/src/methods/goals.ts`.
- Extend: `packages/server/src/goals/operations.ts`, `packages/server/src/evidence/seats.ts`.
- Modify: `packages/server/src/team.ts`, `packages/server/src/flows.ts`, `packages/server/src/host.ts`, `packages/server/src/methods/agents.ts`, `packages/server/src/methods/team.ts`, `packages/server/src/methods/context.ts`, `packages/server/src/methods/index.ts`, `packages/protocol/src/wire.ts`, `packages/protocol/src/wire-validators.ts`.
- Create tests: `packages/server/test/goal-assignment.test.ts`, `packages/server/test/goal-membership.test.ts`, `packages/server/test/goal-operations.test.ts`, `packages/server/test/goal-plane.test.ts`, `packages/server/test/goal-flow-compat.test.ts`, `packages/protocol/test/goal-wire.test.ts`.
- Named existing test helpers requiring integration edits: `team.test.ts` (`rig`, `joinAll`), `flows.test.ts` (`rig`, `asking`), `host-flow.test.ts`, `agent-seat.test.ts` (`rig`), `room-restart.test.ts`, `room-worktree.test.ts`.

**Proof needs:** neither. **Routing:** Codex.

**Interfaces:** `Assignments.assign(goal: string, card: number, session: SessionPointer): Promise<SeatRecord>`; one shared `Serial.run<T>(fn: () => Promise<T>): Promise<T>`; `goalMembers`, `goalOfSession` and `memberProjection` read the durable records; `recoverOperation` replays `GoalOperation` through idempotent effects. `GoalPlane` below implements the create/read/list/update/seat/assign/release/dependency services in the header. Task 4 attaches lanes and Task 8 adds wrap/citation methods; this task does not invent fallback implementations of those methods. `SeatBook.all`, `importOpening` and `closeId` are implemented in Task 2. Existing SeatBook method signatures are unchanged.

- [ ] **Step 1: Write the complete assignment, projection and journal tests**

Create `packages/server/test/goal-assignment.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SeatRecord } from '@harnessdesk/protocol'

import { Assignments, Serial, type AssignmentPort } from '../src/goals/assignments.js'
import { goal, seat } from './fixtures/goals.js'

const session = { runtime: 'fake', sessionId: 'one' }

const rig = (over: Partial<AssignmentPort> = {}) => {
  const kept: SeatRecord[] = []
  const writes: string[] = []
  const port: AssignmentPort = {
    goal: (id) => goal(id),
    seats: () => kept,
    known: async () => ({ project: '/work/repo', busy: false }),
    claimable: () => true,
    commit: async (id, card, pointer) => {
      await Promise.resolve()
      const record = seat(`kept-${kept.length}`, { board: id, session: pointer })
      kept.push(record)
      writes.push(`${id}:${card}`)
      return record
    },
    ...over,
  }
  return { kept, writes, port, service: new Assignments(port) }
}

test('concurrent assignments of one conversation keep exactly one Goal Seat', async () => {
  const { kept, writes, service } = rig()
  const results = await Promise.allSettled(['g1', 'g2'].map((id) => service.assign(id, 1, session)))
  assert.equal(results.filter((one) => one.status === 'fulfilled').length, 1)
  assert.equal(kept.length, 1)
  assert.deepEqual(writes, ['g1:1'])
  const failure = results.find((one) => one.status === 'rejected')
  assert.ok(failure?.status === 'rejected')
  assert.match(String(failure.reason), /already holds a Seat/)
})

test('separate service instances share the desk queue', async () => {
  const { port, kept } = rig()
  const serial = new Serial()
  const left = new Assignments(port, serial)
  const right = new Assignments(port, serial)
  const results = await Promise.allSettled([left.assign('g1', 1, session), right.assign('g2', 1, session)])
  assert.equal(results.filter((one) => one.status === 'fulfilled').length, 1)
  assert.equal(kept.length, 1)
})

test('wrapped and wrapping Goals refuse before looking up or writing a conversation', async () => {
  for (const state of ['wrapped', 'wrapping'] as const) {
    let reads = 0
    const { service, writes } = rig({
      goal: () => goal('g1', { state }),
      known: async () => { reads++; return { project: '/work/repo', busy: false } },
    })
    await assert.rejects(service.assign('g1', 1, session), /closing or wrapped/)
    assert.equal(reads, 0)
    assert.deepEqual(writes, [])
  }
})

test('missing runtime history and a foreign project refuse before a Seat is written', async () => {
  for (const known of [null, { project: '/work/elsewhere', busy: false }]) {
    const { service, writes } = rig({ known: async () => known })
    await assert.rejects(service.assign('g1', 1, session), /runtime can still open/)
    assert.deepEqual(writes, [])
  }
})

test('a busy conversation and a role, dependency or file conflict refuse before commit', async () => {
  const busy = rig({ known: async () => ({ project: '/work/repo', busy: true }) })
  await assert.rejects(busy.service.assign('g1', 1, session), /finish its turn/)
  assert.deepEqual(busy.writes, [])
  const conflicted = rig({ claimable: () => false })
  await assert.rejects(conflicted.service.assign('g1', 1, session), /dependency, role or file conflict/)
  assert.deepEqual(conflicted.writes, [])
})

test('restored, closed and standalone Seats are history, not competing Goal membership', async () => {
  const { service, kept } = rig()
  kept.push(seat('restored', { session, restored: { at: 2 } }))
  kept.push(seat('closed', { session, closed: { at: 2, why: 'released' } }))
  kept.push(seat('standalone', { session, board: null }))
  const result = await service.assign('g2', 2, session)
  assert.equal(result.board, 'g2')
  assert.equal(kept.filter((one) => one.board === 'g2').length, 1)
})

test('an invalid card refuses and a failed operation does not poison the serial queue', async () => {
  const { service, writes } = rig()
  await assert.rejects(service.assign('g1', 0, session), /existing card/)
  assert.deepEqual(writes, [])
  const record = await service.assign('g1', 1, session)
  assert.equal(record.board, 'g1')
})
```

Create `packages/server/test/goal-membership.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { goalMembers, goalOfSession, memberProjection } from '../src/goals/members.js'
import type { GoalDocument } from '../src/goals/store.js'
import { goal, seat } from './fixtures/goals.js'

const document = (): GoalDocument => ({
  version: 1, goal: goal(), board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
  citations: [], receipt: null, operation: null,
})

test('membership survives a detached runtime and projects roles from Seat records', () => {
  const records = [seat('one', { role: 'reviewer' }), seat('two'), seat('gone', { closed: { at: 2, why: 'deleted' } })]
  const view = memberProjection(document(), records)
  assert.deepEqual(view.members, ['fake\u0000one', 'fake\u0000two'])
  assert.deepEqual(view.roles, { ['fake\u0000one']: 'reviewer' })
  assert.equal(goalOfSession([document()], records, { runtime: 'fake', sessionId: 'one' }), 'g1')
  assert.equal(goalOfSession([document()], records, { runtime: 'fake', sessionId: 'gone' }), null)
})

test('restored documents and staged openings acquire no live membership', () => {
  const record = seat()
  const { closed: _closed, ...opening } = record
  const pending: GoalDocument = {
    ...document(), operation: { kind: 'assignment', id: 'op', goal: 'g1', card: 1, opening, close: [] },
  }
  assert.deepEqual(goalMembers(pending, [record]), [])
  assert.deepEqual(goalMembers({ ...document(), restored: { at: 2 } }, [record]), [])
  assert.deepEqual(goalMembers(document(), [record]), [record])
})

test('two kept Goal Seats for a conversation are a repair error, never an arbitrary winner', () => {
  const pointer = { runtime: 'fake', sessionId: 'one' }
  const records = [seat('one', { session: pointer }), seat('two', { board: 'g2', session: pointer })]
  assert.throws(() => goalOfSession([document(), { ...document(), goal: goal('g2') }], records, pointer), /two Goals/)
})
```

Create `packages/server/test/goal-operations.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { recoverOperation, type GoalOperation, type GoalOperationPort } from '../src/goals/operations.js'
import { seat } from './fixtures/goals.js'

const opening = () => {
  const { closed: _closed, ...record } = seat('fixed-opening')
  return record
}

const assignment = (): GoalOperation => ({
  kind: 'assignment', id: 'fixed-operation', goal: 'g1', card: 1, opening: opening(), close: ['standalone'],
})

const rig = (failAt: string | null) => {
  const calls: string[] = []
  const openings = new Set<string>()
  const closings = new Set<string>()
  let failed = false
  let finished = false
  const step = (name: string) => {
    calls.push(name)
    if (name === failAt && !failed) { failed = true; throw new Error(`cut at ${name}`) }
  }
  const port: GoalOperationPort = {
    importOpening: async (_project, record) => { step('import'); openings.add(record.id) },
    closeId: async (id) => { step('close'); closings.add(id) },
    claim: async () => { step('claim') },
    releaseClaim: async () => { step('release') },
    refuseMail: async () => { step('mail') },
    finish: async () => { step('finish'); finished = true },
    wake: () => { step('wake') },
    finishWrap: async () => { throw new Error('wrap is not part of this operation') },
  }
  return { port, calls, openings, closings, finished: () => finished }
}

test('assignment closes only named standalone records, imports once, claims, then clears its journal', async () => {
  const proof = rig(null)
  await recoverOperation(assignment(), proof.port)
  assert.deepEqual(proof.calls, ['close', 'import', 'claim', 'finish', 'wake'])
  assert.deepEqual([...proof.closings], ['standalone'])
  assert.deepEqual([...proof.openings], ['fixed-opening'])
  assert.equal(proof.finished(), true)
})

test('assignment recovery after every awaited boundary retains the original opening id', async () => {
  for (const boundary of ['close', 'import', 'claim', 'finish']) {
    const proof = rig(boundary)
    await assert.rejects(recoverOperation(assignment(), proof.port), new RegExp(`cut at ${boundary}`))
    assert.equal(proof.finished(), false)
    await recoverOperation(assignment(), proof.port)
    assert.equal(proof.finished(), true)
    assert.deepEqual([...proof.openings], ['fixed-opening'])
    assert.deepEqual([...proof.closings], ['standalone'])
  }
})

test('release closes the requested Seat, releases its claim and mail, then wakes waiters', async () => {
  const proof = rig(null)
  const release: GoalOperation = { kind: 'release', id: 'release-1', goal: 'g1', seat: 'only-this-seat', reason: 'released' }
  await recoverOperation(release, proof.port)
  assert.deepEqual(proof.calls, ['close', 'release', 'mail', 'finish', 'wake'])
  assert.deepEqual([...proof.closings], ['only-this-seat'])
  assert.deepEqual([...proof.openings], [])
})

test('release recovery remains repeatable after each awaited boundary', async () => {
  const release: GoalOperation = { kind: 'release', id: 'release-1', goal: 'g1', seat: 'only-this-seat', reason: 'released' }
  for (const boundary of ['close', 'release', 'mail', 'finish']) {
    const proof = rig(boundary)
    await assert.rejects(recoverOperation(release, proof.port), new RegExp(`cut at ${boundary}`))
    await recoverOperation(release, proof.port)
    assert.equal(proof.finished(), true)
    assert.deepEqual([...proof.closings], ['only-this-seat'])
  }
})
```

Create `packages/server/test/goal-plane.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BoardEvidence, SeatRecord } from '@harnessdesk/protocol'

import { GoalPlane, type GoalPlanePort } from '../src/goals/plane.js'
import { migrateDesk } from '../src/goals/migration.js'
import { GoalStore } from '../src/goals/store.js'
import { goal, intent, seat } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

const rig = async () => {
  const home = tempDir('hd-goal-plane-')
  await migrateDesk(home, async () => {})
  const store = new GoalStore(home)
  await store.load()
  await store.save({
    version: 1, goal: goal(),
    board: { nextIntent: 2, messaging: true, intents: [intent(1, { state: 'done' })], channel: [] },
    citations: [], receipt: null, operation: null,
  }, null)
  let facts: BoardEvidence = { room: 'g1', stamp: 1, checks: [], refused: [], unreadable: null, cards: [] }
  let readError = false
  const seats: SeatRecord[] = []
  const transitions: string[] = []
  const forbidden = async (): Promise<never> => { throw new Error('This test must not seat or close a conversation') }
  const port: GoalPlanePort = {
    seats: { all: () => seats, byId: (id) => seats.find((one) => one.id === id) ?? null },
    confine: async (input) => ({ root: input.root, cwd: input.cwd ?? input.root }),
    known: async () => ({ project: '/work/repo', busy: false }),
    claimable: () => true,
    opening: forbidden,
    board: (id) => {
      const document = store.read(id)
      return { ...document.board, id, name: document.goal.sentence, root: document.goal.root,
        updatedAt: document.goal.updatedAt, members: [] }
    },
    evidence: async () => { if (readError) throw new Error('evidence unavailable'); return facts },
    flow: () => undefined,
    busy: () => false,
    waits: () => false,
    stranded: () => false,
    held: () => false,
    changed: () => {},
    activity: (_id, previous, next) => { transitions.push(`${previous}:${next}`) },
    ready: () => ({ ok: true }),
    seatAgent: forbidden,
    openLegacySeat: forbidden,
    importOpening: forbidden,
    closeId: forbidden,
    claim: forbidden,
    releaseClaim: forbidden,
    refuseMail: forbidden,
    finish: forbidden,
    finishWrap: forbidden,
    wake: () => {},
  }
  return {
    store, seats, port, transitions,
    plane: new GoalPlane(store, port),
    facts: (next: BoardEvidence) => { facts = next },
    failRead: () => { readError = true },
  }
}

test('a done card without observed evidence needs a person; a current passing check makes it ready', async () => {
  const proof = await rig()
  assert.equal((await proof.plane.view('g1')).activity, 'needs-you')
  await proof.plane.refresh('g1')
  assert.deepEqual(proof.transitions, [])
  proof.facts({
    room: 'g1', stamp: 2, checks: ['verify'], refused: [], unreadable: null,
    cards: [{ card: 1, running: [], facts: [{
      record: { id: 'fact', card: { board: 'g1', id: 1 }, observedAt: 2,
        fact: { kind: 'check', name: 'verify', run: 'node --test', exit: 0, timedOut: false,
          at: 'a'.repeat(40), dirty: false, tail: '' } },
      freshness: { state: 'fresh' }, by: null,
    }] }],
  })
  await proof.plane.refresh('g1')
  assert.equal((await proof.plane.view('g1')).activity, 'ready-to-wrap')
  assert.deepEqual(proof.transitions, ['needs-you:ready-to-wrap'])
})

test('an evidence read failure is visible and never makes settled work ready', async () => {
  const proof = await rig()
  proof.failRead()
  const view = await proof.plane.view('g1')
  assert.equal(view.problem, 'evidence unavailable')
  assert.notEqual(view.activity, 'ready-to-wrap')
})

test('creation persists an empty Goal without seating; dependency waits still allow a sentence edit', async () => {
  const proof = await rig()
  const created = await proof.plane.create({ root: '/work/repo', sentence: '  A separate effort  ', dependsOn: ['g1'] })
  assert.equal(created.goal.sentence, 'A separate effort')
  assert.deepEqual(created.members, [])
  assert.deepEqual(created.board.intents, [])
  assert.equal(proof.plane.canDispatch(created.goal.id).ok, false)
  const changed = await proof.plane.update(created.goal.id, 0, { sentence: 'A clearer sentence' })
  assert.equal(changed.goal.revision, 1)
  assert.equal(changed.goal.sentence, 'A clearer sentence')
  await assert.rejects(proof.plane.update(created.goal.id, 0, { sentence: 'stale edit' }), /Goal changed/)
})

test('restored Goal history has no members and cannot dispatch or accept edits', async () => {
  const proof = await rig()
  const document = proof.store.read('g1')
  await proof.store.save({ ...document, restored: { at: 2 }, goal: { ...document.goal, revision: 1 } }, 0)
  proof.seats.push(seat())
  const view = await proof.plane.view('g1')
  assert.deepEqual(view.members, [])
  assert.equal(view.activity, null)
  assert.match(view.problem!, /came from a backup/)
  assert.equal(proof.plane.canDispatch('g1').ok, false)
  await assert.rejects(proof.plane.update('g1', 1, { sentence: 'continue' }), /read-only/)
})
```

Create `packages/server/test/goal-flow-compat.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { Intent, SeatRecord, TeamState } from '@harnessdesk/protocol'

import { Flows, type FlowPort } from '../src/flows.js'
import type { Team } from '../src/team.js'
import { intent, seat } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

const source = `
name: Work and review
roles:
  worker:
    kind: agent
    seat: fake
    count: 2
    permission: read
    outcomes: [done]
    order: Finish the assigned card.
seed:
  role: worker
  title: Finish the change
rules: []
`

const rig = (t: TestContext) => {
  const directory = tempDir('hd-goal-flow-')
  const events: string[] = []
  const records: SeatRecord[] = []
  const cards: Intent[] = []
  let failOpening = false
  let failOrder = false
  const state = (): TeamState => ({
    id: 'legacy-room', root: '/work/repo', name: 'Finish', updatedAt: 1,
    members: [], intents: cards, channel: [], messaging: true,
  })
  const team = {
    hasRoom: (id: string) => id === 'legacy-room',
    stateFor: state,
    peersFor: async () => [],
    addIntentForFlow: (_goal: string, input: Partial<Intent>) => {
      const card = intent(cards.length + 1, input)
      cards.push(card)
      return card
    },
  } as unknown as Team
  const port: FlowPort = {
    openLegacySeat: async (input) => {
      if (failOpening && records.length === 1) throw new Error('durable opening refused')
      const record = seat(`seat-${records.length + 1}`, {
        board: input.goal, role: input.role, seat: input.spec,
        standing: { kind: 'permission', permission: input.permission },
      })
      records.push(record)
      events.push(`record:${record.id}`)
      return record
    },
    releaseGoalSeat: async (goal, id) => {
      assert.equal(goal, 'legacy-room')
      events.push(`release:${id}`)
    },
    order: async (_runtime, id) => {
      assert.equal(records.length, 2, 'every opening is durable before any order')
      events.push(`order:${id}`)
      if (failOrder) throw new Error('order refused')
    },
    retire: async (_runtime, id) => { events.push(`retire:${id}`) },
    reseat: async () => 'Fake Runtime',
    confine: async () => {},
    run: async () => ({ status: 0 }),
    changed: () => {},
    log: () => {},
  }
  const flows = new Flows(join(directory, 'flows'), team, port)
  t.after(async () => { await flows.flush() })
  return {
    flows, events, records,
    failOpening: () => { failOpening = true },
    failOrder: () => { failOrder = true },
  }
}

test('legacy flow openings are all durable before their orders and retain the room key', async (t) => {
  const proof = rig(t)
  const run = await proof.flows.start({ room: 'legacy-room', source })
  assert.deepEqual(proof.events, ['record:seat-1', 'record:seat-2', 'order:seat-1', 'order:seat-2'])
  assert.equal(proof.records.every((record) => record.board === 'legacy-room'), true)
  assert.equal(run.seats.length, 2)
  assert.equal(run.seats[0]?.permission, 'read')
  assert.equal(run.seats[0]?.spec?.runtime, 'fake')
})

test('a later failed opening retires and releases only the already-opened Seat, sending no order', async (t) => {
  const proof = rig(t)
  proof.failOpening()
  await assert.rejects(proof.flows.start({ room: 'legacy-room', source }), /durable opening refused/)
  assert.deepEqual(proof.events, ['record:seat-1', 'retire:seat-1', 'release:seat-1'])
})

test('a failed order stops every opened conversation before releasing its exact Goal Seat', async (t) => {
  const proof = rig(t)
  proof.failOrder()
  await assert.rejects(proof.flows.start({ room: 'legacy-room', source }), /order refused/)
  assert.deepEqual(proof.events, [
    'record:seat-1', 'record:seat-2', 'order:seat-1',
    'retire:seat-1', 'release:seat-1', 'retire:seat-2', 'release:seat-2',
  ])
})
```

Create `packages/protocol/test/goal-wire.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage, ValidationError } from '../src/index.js'

const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })

test('Goal public writes reject host-owned data and unknown keys', () => {
  for (const field of ['origin', 'members', 'env', 'partition', 'ceiling', 'receipt']) {
    assert.throws(() => request('goal/create', { root: '/work/repo', sentence: 'Finish', [field]: {} }), ValidationError)
    assert.throws(() => request('goal/seat', { goal: 'g1', agent: 'reviewer', [field]: {} }), ValidationError)
    assert.throws(() => request('goal/update', { goal: 'g1', revision: 0, [field]: {} }), ValidationError)
  }
})

test('assignment and update accept only safe bounded ids and numbers', () => {
  const session = { runtime: 'fake', sessionId: 'one' }
  for (const card of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => request('goal/assign', { goal: 'g1', card, session }), ValidationError)
  }
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => request('goal/update', { goal: 'g1', revision }), ValidationError)
  }
  assert.throws(() => request('goal/assign', { goal: '', card: 1, session }), ValidationError)
  assert.throws(() => request('goal/assign', { goal: 'g1', card: 1, session: { ...session, sessionId: 'x'.repeat(201) } }), ValidationError)
  assert.doesNotThrow(() => request('goal/assign', { goal: '/work/legacy', card: 1, session }))
})

test('both grant generations validate without accepting an effective ceiling from a client', () => {
  assert.doesNotThrow(() => request('goal/seat', { goal: 'g1', agent: 'reviewer', grant: { kind: 'permission', permission: 'read' } }))
  assert.doesNotThrow(() => request('goal/seat', { goal: 'g1', agent: 'reviewer', grant: { kind: 'ceiling', level: 'edit' } }))
  assert.throws(() => request('goal/seat', { goal: 'g1', agent: 'reviewer', grant: { kind: 'permission', permission: 'edit' } }), ValidationError)
  assert.throws(() => request('goal/seat', { goal: 'g1', agent: 'reviewer', grant: { kind: 'ceiling', level: 'edit', hold: 'held' } }), ValidationError)
})

test('sentences and dependency lists obey their public limits', () => {
  assert.throws(() => request('goal/create', { root: '/work/repo', sentence: '   ' }), ValidationError)
  assert.throws(() => request('goal/create', { root: '/work/repo', sentence: 'x'.repeat(2001) }), ValidationError)
  assert.throws(() => request('goal/create', { root: '/work/repo', sentence: 'Finish', dependsOn: Array(129).fill('g1') }), ValidationError)
  assert.doesNotThrow(() => request('goal/create', { root: '/work/repo', sentence: 'Finish', dependsOn: [] }))
})
```

The flow test exercises the actual `Flows.start` loop through a small Team port. It proves record-before-order and exact cleanup; it does not replace the existing real-Team flow tests. Likewise the assignment port test does not prove Host runtime ownership; the restart/worktree host suites retain that boundary.

- [ ] **Step 2: Observe the missing Goal services**

Run: `pnpm run build:node`

Expected: FAIL — `Cannot find module '../src/goals/assignments.js'`, `Cannot find module '../src/goals/members.js'`, and missing Goal methods. Do not move the existing Host.call or parseClientMessage tests down to a fake port.

- [ ] **Step 3: Serialize and validate assignment before its first durable effect**

Create `packages/server/src/goals/assignments.ts` with these complete contents:

```ts
import type { Goal, SeatRecord, SessionPointer } from '@harnessdesk/protocol'

/** Shared by assignment, release, seating and wrap. Acquire it once per operation. */
export class Serial {
  #tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn)
    this.#tail = result.catch(() => {})
    return result
  }
}

export interface AssignmentPort {
  goal(id: string): Goal
  seats(): readonly SeatRecord[]
  known(runtime: string, session: string): Promise<{ project: string; busy: boolean } | null>
  claimable(goal: string, card: number, session: SessionPointer): boolean
  commit(goal: string, card: number, session: SessionPointer): Promise<SeatRecord>
}

export class Assignments {
  constructor(private readonly port: AssignmentPort, private readonly serial = new Serial()) {}

  assign(id: string, card: number, session: SessionPointer): Promise<SeatRecord> {
    return this.serial.run(async () => {
      const goal = this.port.goal(id)
      if (goal.state !== 'open') {
        throw new Error('This Goal is closing or wrapped. Start another Goal for new work.')
      }
      if (!Number.isSafeInteger(card) || card < 1) throw new Error('Choose an existing card.')
      const known = await this.port.known(session.runtime, session.sessionId)
      if (!known || known.project !== goal.root) {
        throw new Error('Choose a conversation from this project that its runtime can still open.')
      }
      if (known.busy) {
        throw new Error('Wait for this conversation to finish its turn before giving it a card.')
      }
      const active = this.port.seats().find((seat) =>
        !seat.closed && !seat.restored && seat.board !== null &&
        seat.session.runtime === session.runtime && seat.session.sessionId === session.sessionId,
      )
      if (active) {
        throw new Error('This conversation already holds a Seat. Release it before assigning it elsewhere.')
      }
      if (!this.port.claimable(id, card, session)) {
        throw new Error('This card cannot be assigned now. Resolve its dependency, role or file conflict first.')
      }
      return this.port.commit(id, card, session)
    })
  }
}
```

- [ ] **Step 4: Project membership and replay fixed journal entries**

Create `packages/server/src/goals/members.ts` with these complete contents:

```ts
import { membersOf, type SeatRecord, type SessionPointer, type TeamState } from '@harnessdesk/protocol'

import type { GoalDocument } from './store.js'

/** An imported document is history. A staged opening is hidden until its board commit. */
export function goalMembers(document: GoalDocument, seats: readonly SeatRecord[]): SeatRecord[] {
  if (document.restored) return []
  const pending = document.operation?.kind === 'assignment' ? document.operation.opening.id : null
  return membersOf(document.goal, seats).filter((seat) => seat.id !== pending)
}

export function goalOfSession(
  documents: readonly GoalDocument[],
  seats: readonly SeatRecord[],
  session: SessionPointer,
): string | null {
  const matches = documents.filter((document) => goalMembers(document, seats).some((seat) =>
    seat.session.runtime === session.runtime && seat.session.sessionId === session.sessionId,
  ))
  if (matches.length > 1) throw new Error('One conversation holds Seats in two Goals. Repair the membership before dispatching work.')
  return matches[0]?.goal.id ?? null
}

/** Team still owns nicknames and inbound policy; only Seats supply membership and roles. */
export function memberProjection(document: GoalDocument, seats: readonly SeatRecord[]): Pick<TeamState, 'members' | 'roles'> {
  const members = goalMembers(document, seats)
  const key = (seat: SeatRecord): TeamState['members'][number] =>
    `${seat.session.runtime}\u0000${seat.session.sessionId}` as TeamState['members'][number]
  return {
    members: members.map(key),
    roles: Object.fromEntries(members.flatMap((seat) => seat.role === null ? [] : [[key(seat), seat.role]])),
  }
}
```

Append the following after the complete `GoalOperation` declaration from Task 2 in `packages/server/src/goals/operations.ts`:

```ts
export interface GoalOperationPort {
  importOpening(project: string, opening: SeatOpening): Promise<void>
  closeId(seat: SeatId, reason: string): Promise<void>
  claim(goal: string, card: number, seat: SeatOpening): Promise<void>
  releaseClaim(goal: string, seat: SeatId): Promise<void>
  refuseMail(goal: string, seat: SeatId): Promise<void>
  wake(goal: string): void
  finish(goal: string, operation: string): Promise<void>
  finishWrap(operation: Extract<GoalOperation, { kind: 'wrap' }>): Promise<void>
}

/** All effects are idempotent. The operation stays in the document until the last write. */
export async function recoverOperation(operation: GoalOperation, port: GoalOperationPort): Promise<void> {
  switch (operation.kind) {
    case 'assignment':
      for (const id of operation.close) await port.closeId(id, 'assigned')
      await port.importOpening(operation.opening.checkout.project, operation.opening)
      if (operation.card !== null) await port.claim(operation.goal, operation.card, operation.opening)
      await port.finish(operation.goal, operation.id)
      port.wake(operation.goal)
      return
    case 'release':
      await port.closeId(operation.seat, operation.reason)
      await port.releaseClaim(operation.goal, operation.seat)
      await port.refuseMail(operation.goal, operation.seat)
      await port.finish(operation.goal, operation.id)
      port.wake(operation.goal)
      return
    case 'wrap':
      await port.finishWrap(operation)
  }
}
```

`GoalOperationPort.finish` is the durable compare-and-clear operation: read the document, require that its current operation id equals the argument, save `operation:null` at `revision + 1`, and only then announce the new board. A retry seeing no operation is already complete. It must not acquire the desk `Serial` again: its caller holds that queue. `claim`, `releaseClaim` and `refuseMail` are Team effects on that same queue, and must be idempotent before recovery is connected.

- [ ] **Step 5: Implement the Goal coordinator and evidence-derived activity**

Create `packages/server/src/goals/plane.ts` with these complete contents:

```ts
import { randomUUID } from 'node:crypto'

import {
  activityOf, checkedDependencies, flowRoleOf, placeCard,
  type BoardEvidence, type FlowPermission, type FlowRun, type FlowSeat,
  type Goal, type GoalCreateInput, type GoalSeatRequest, type GoalView,
  type SeatId, type SeatRecord, type SessionPointer, type TeamState,
} from '@harnessdesk/protocol'

import type { SeatOpening } from '../evidence/records.js'
import { Assignments, Serial } from './assignments.js'
import { goalMembers, memberProjection } from './members.js'
import { recoverOperation, type GoalOperationPort } from './operations.js'
import { GoalStore, type GoalDocument } from './store.js'

export interface GoalPlanePort extends GoalOperationPort {
  seats: {
    all(): readonly SeatRecord[]
    byId(id: SeatId): SeatRecord | null
  }
  confine(input: GoalCreateInput): Promise<{ root: string; cwd: string }>
  known(runtime: string, session: string): Promise<{ project: string; busy: boolean } | null>
  claimable(goal: string, card: number, session: SessionPointer): boolean
  opening(goal: string, session: SessionPointer, id: SeatId): Promise<SeatOpening>
  board(goal: string): TeamState
  evidence(goal: string): Promise<BoardEvidence>
  flow(goal: string): FlowRun | undefined
  busy(session: SessionPointer): boolean
  waits(session: SessionPointer): boolean
  stranded(goal: string, card: number): boolean
  held(goal: string): boolean
  changed(view: GoalView): void
  activity(goal: string, previous: NonNullable<GoalView['activity']>, activity: NonNullable<GoalView['activity']>, sentence: string): void
  ready(): { ok: true } | { ok: false; reason: string }
  seatAgent(input: GoalSeatRequest, goal: Goal): Promise<SeatRecord>
  openLegacySeat(input: {
    goal: string
    spec: FlowSeat
    permission: FlowPermission
    role: string
    isolate: boolean
    title: string
  }, goal: Goal): Promise<SeatRecord>
}

/** Goals coordinate transactions; Team owns card and channel rules. */
export class GoalPlane {
  readonly #assignments: Assignments
  readonly #activity = new Map<string, NonNullable<GoalView['activity']>>()
  readonly #evidenceProblems = new Map<string, string>()

  constructor(
    readonly store: GoalStore,
    private readonly port: GoalPlanePort,
    readonly serial = new Serial(),
    private readonly now: () => number = Date.now,
  ) {
    this.#assignments = new Assignments({
      goal: (id) => { this.#dispatch(id); return this.store.read(id).goal },
      seats: () => port.seats.all(),
      known: (runtime, session) => port.known(runtime, session),
      claimable: (goal, card, session) => port.claimable(goal, card, session),
      commit: (goal, card, session) => this.#assign(goal, card, session),
    }, serial)
  }

  async list(root?: string): Promise<readonly GoalView[]> {
    return Promise.all(this.store.list().filter((one) => root === undefined || one.goal.root === root)
      .map((one) => this.view(one.goal.id)))
  }

  async view(id: string): Promise<GoalView> {
    const document = this.store.read(id)
    const members = goalMembers(document, this.port.seats.all())
    const board = { ...this.port.board(id), ...memberProjection(document, this.port.seats.all()) }
    let evidence: BoardEvidence | null = null
    let problem = this.store.problem
    try {
      evidence = await this.port.evidence(id)
      this.#evidenceProblems.delete(id)
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
      this.#evidenceProblems.set(id, problem)
    }
    const run = this.port.flow(id)
    const placements = board.intents.map((intent) => placeCard({
      intent,
      evidence: evidence?.cards.find((card) => card.card === intent.id),
      stranded: this.port.stranded(id, intent.id),
      holderWaits: intent.claim ? this.port.waits(intent.claim) : false,
      forPerson: flowRoleOf(intent, run)?.kind === 'person',
    }))
    const dependencies = this.store.list().map((one) => one.goal)
    const activity = document.restored ? null : activityOf(document.goal, {
      needsYou: this.port.held(id) || members.some((seat) => this.port.waits(seat.session)) ||
        placements.some((one) => one.column === 'needs'),
      busy: problem !== null || members.some((seat) => this.port.busy(seat.session)) ||
        placements.some((one) => one.column === 'review') ||
        (evidence?.cards.some((card) => card.running.length > 0) ?? false),
      liveFlow: run?.state === 'running' || run?.state === 'stalled',
      cards: board.intents,
      dependencies,
    })
    return {
      goal: document.goal,
      activity,
      waitingOn: document.goal.dependsOn.flatMap((dependency) => {
        const found = dependencies.find((one) => one.id === dependency)
        return found?.state === 'wrapped' ? [] : [{ id: dependency, sentence: found?.sentence ?? 'A missing Goal' }]
      }),
      members, board, receipt: document.receipt,
      problem: document.restored ? 'This Goal came from a backup. Start a new Goal to continue its work.' : problem,
    }
  }

  async refresh(id: string): Promise<void> {
    const view = await this.view(id)
    const previous = this.#activity.get(id)
    if (view.activity === null) this.#activity.delete(id)
    else this.#activity.set(id, view.activity)
    this.port.changed(view)
    if (previous !== undefined && view.activity !== null && previous !== view.activity) {
      this.port.activity(id, previous, view.activity, view.goal.sentence)
    }
  }

  async create(input: GoalCreateInput): Promise<GoalView> {
    return this.serial.run(async () => {
      const ready = this.port.ready()
      if (!ready.ok) throw new Error(ready.reason)
      const sentence = input.sentence.trim()
      if (!sentence || sentence.length > 2000) throw new Error('Write a Goal in 1 to 2000 characters.')
      const { root, cwd } = await this.port.confine(input)
      const at = this.now()
      const goal: Goal = {
        id: `goal-${randomUUID()}`, root, cwd, sentence,
        state: 'open', revision: 0, checkout: input.checkout ?? 'shared',
        dependsOn: [], origin: input.origin ?? { kind: 'person' },
        createdAt: at, updatedAt: at, receipt: null,
      }
      const dependsOn = checkedDependencies(goal, input.dependsOn ?? [], this.store.list().map((one) => one.goal))
      await this.store.save({
        version: 1, goal: { ...goal, dependsOn },
        board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
        citations: [], receipt: null, operation: null,
      }, null)
      return this.view(goal.id)
    })
  }

  update(id: string, revision: number, patch: { sentence?: string; dependsOn?: readonly string[] }): Promise<GoalView> {
    return this.serial.run(async () => {
      const document = this.store.read(id)
      this.#editable(document)
      if (document.goal.revision !== revision) throw new Error('This Goal changed. Read it again before saving.')
      if (patch.dependsOn !== undefined && goalMembers(document, this.port.seats.all()).some((seat) => this.port.busy(seat.session))) {
        throw new Error('Wait for this Goal’s turns to finish before changing its dependencies.')
      }
      const sentence = patch.sentence?.trim() ?? document.goal.sentence
      if (!sentence || sentence.length > 2000) throw new Error('Write a Goal in 1 to 2000 characters.')
      const dependsOn = checkedDependencies(document.goal, patch.dependsOn ?? document.goal.dependsOn,
        this.store.list().map((one) => one.goal))
      await this.store.save({ ...document, goal: {
        ...document.goal, sentence, dependsOn, revision: revision + 1, updatedAt: this.now(),
      } }, revision)
      return this.view(id)
    })
  }

  dependenciesReady(id: string): boolean {
    const documents = this.store.list()
    return this.store.read(id).goal.dependsOn.every((dependency) =>
      documents.find((one) => one.goal.id === dependency)?.goal.state === 'wrapped',
    )
  }

  canDispatch(id: string): { ok: true } | { ok: false; reason: string } {
    const ready = this.port.ready()
    if (!ready.ok) return ready
    if (this.store.problem) return { ok: false, reason: this.store.problem }
    const document = this.store.read(id)
    if (document.restored) return { ok: false, reason: 'This Goal came from a backup. Start a new Goal to continue its work.' }
    if (document.goal.state !== 'open') return { ok: false, reason: 'This Goal is closing or wrapped. Start another Goal for new work.' }
    if (document.operation) return { ok: false, reason: 'This Goal has an unfinished operation. Finish recovery before starting work.' }
    if (!this.dependenciesReady(id)) return { ok: false, reason: 'This Goal is waiting for its dependencies to wrap.' }
    return { ok: true }
  }

  assign(goal: string, card: number, session: SessionPointer): Promise<SeatRecord> {
    return this.#assignments.assign(goal, card, session)
  }

  async #assign(goal: string, card: number, session: SessionPointer): Promise<SeatRecord> {
    const document = this.store.read(goal)
    const opening = await this.port.opening(goal, session, randomUUID())
    const close = this.port.seats.all().filter((seat) => !seat.closed && !seat.restored && seat.board === null &&
      seat.session.runtime === session.runtime && seat.session.sessionId === session.sessionId).map((seat) => seat.id)
    const operation = { kind: 'assignment', id: randomUUID(), goal, card, opening, close } as const
    await this.#stage(document, operation)
    await recoverOperation(operation, this.port)
    const kept = this.port.seats.byId(opening.id)
    if (!kept) throw new Error('The assigned Seat could not be read back. Finish recovery before starting work.')
    return kept
  }

  release(goal: string, id: SeatId): Promise<void> {
    return this.serial.run(async () => {
      const document = this.store.read(goal)
      this.#editable(document)
      const record = this.port.seats.byId(id)
      if (!record || record.board !== goal || record.restored) throw new Error('That Seat is not kept on this Goal.')
      if (record.closed) return
      if (this.port.busy(record.session)) throw new Error("Stop this Seat's current turn before releasing it")
      const operation = { kind: 'release', id: randomUUID(), goal, seat: id, reason: 'released' } as const
      await this.#stage(document, operation)
      await recoverOperation(operation, this.port)
    })
  }

  seat(input: GoalSeatRequest): Promise<SeatRecord> {
    return this.serial.run(async () => {
      this.#dispatch(input.goal)
      return this.port.seatAgent(input, this.store.read(input.goal).goal)
    })
  }

  openLegacySeat(input: Parameters<GoalPlanePort['openLegacySeat']>[0]): Promise<SeatRecord> {
    return this.serial.run(async () => {
      this.#dispatch(input.goal)
      return this.port.openLegacySeat(input, this.store.read(input.goal).goal)
    })
  }

  async recover(): Promise<void> {
    await this.serial.run(async () => {
      for (const document of this.store.list()) {
        if (!document.restored && document.operation) await recoverOperation(document.operation, this.port)
      }
    })
  }

  async #stage(document: GoalDocument, operation: NonNullable<GoalDocument['operation']>): Promise<void> {
    await this.store.save({ ...document, operation, goal: {
      ...document.goal, revision: document.goal.revision + 1, updatedAt: this.now(),
    } }, document.goal.revision)
  }

  #editable(document: GoalDocument): void {
    const ready = this.port.ready()
    if (!ready.ok) throw new Error(ready.reason)
    if (document.restored || document.goal.state !== 'open' || document.operation) {
      throw new Error('This Goal is read-only or is finishing an operation. Start another Goal for new work.')
    }
  }

  #dispatch(id: string): void {
    const ready = this.canDispatch(id)
    if (!ready.ok) throw new Error(ready.reason)
  }
}
```

The `GoalPlanePort` is a Host-owned adapter, not an alternative membership store. Its `opening` reads the latest kept standalone Seat and copies its Agent, brief, actual standing order and effective ceiling into a new opening; an anonymous legacy conversation uses the explicit unknown arm. The opening must name the Goal before any standing-order turn. A source Seat is closed only after the Goal document durably names the operation that replaces it.

On failed evidence reads, `GoalView.problem` is set and ready-to-wrap is impossible. Task 8 must use a fresh successful read for preview; a cached prior view is not proof. The first refresh seeds the transition map without an activity toast; later transitions alone emit `goal/activity`. Runtime, evidence, card, flow and channel events call refresh rather than a timer.

- [ ] **Step 6: Declare and validate the public Goal calls before adding handlers**

In `packages/protocol/src/wire.ts`, add `import type { GoalCreateInput, GoalId, GoalSeatRequest, GoalView } from './goal.js'` beside the existing domain imports. Phase 4 already imports `SeatRecord` from `./evidence.js`; extend that import with `SeatId` and `SessionPointer`. Immediately after the exact anchor `export interface HostMethods {`, insert:

```ts
  'goal/list': { params: { root?: string }; result: readonly GoalView[] }
  'goal/read': { params: { goal: GoalId }; result: GoalView }
  'goal/create': { params: Omit<GoalCreateInput, 'origin'>; result: GoalView }
  'goal/update': {
    params: { goal: GoalId; revision: number; sentence?: string; dependsOn?: readonly GoalId[] }
    result: GoalView
  }
  'goal/seat': { params: GoalSeatRequest; result: SeatRecord }
  'goal/assign': { params: { goal: GoalId; card: number; session: SessionPointer }; result: SeatRecord }
  'goal/release': { params: { goal: GoalId; seat: SeatId }; result: null }
  'goal/migration/ack': { params: Record<string, never>; result: null }
```

Immediately after the exact anchor `export type WireNotification =`, insert these union arms:

```ts
  | { method: 'goal/changed'; params: { view: GoalView } }
  | { method: 'goal/activity'; params: { goal: GoalId; previous: import('./goal.js').GoalActivity; activity: import('./goal.js').GoalActivity; sentence: string } }
```

In `packages/protocol/src/wire-validators.ts`, insert this complete block immediately before `const paramsValidators: Record<HostMethodName, Validator<unknown>> = {`. The existing `flowSeatValidator`, `seatListValidator`, `grantValidator`, `atMost` and `isFilled` remain the source of their existing limits.

```ts
/** Goal writes never accept host observations or authority through an extra key. */
const goalShape = <T extends Record<string, unknown>>(
  fields: { [K in keyof T]: Validator<T[K]> },
): Validator<T> => {
  const read = shape(fields)
  return (value: unknown, path = '') => {
    const object = isObject(value, path)
    for (const key of Object.keys(object)) {
      if (!Object.hasOwn(fields, key)) throw new ValidationError(`${path}.${key}`, 'unexpected field')
    }
    return read(value, path)
  }
}

const goalId = atMost(4096, isFilled)
const goalIdentifier = atMost(200, isFilled)
const goalSentence: Validator<string> = (value, path = '') => atMost(2000, isFilled)(isString(value, path).trim(), path)
const goalInteger = (minimum: number): Validator<number> => (value, path = '') => {
  const number = isNumber(value, path)
  if (!Number.isSafeInteger(number) || number < minimum) throw new ValidationError(path, `expected a safe integer at least ${minimum}`)
  return number
}
const goalDependencies: Validator<string[]> = (value, path = '') => {
  const ids = arrayOf(goalId)(value, path)
  if (ids.length > 128) throw new ValidationError(path, 'expected at most 128 dependencies')
  return ids
}
const goalGrant = taggedUnion<import('./goal.js').SeatGrant, 'kind'>('kind', {
  permission: goalShape({ kind: literalUnion('permission'), permission: grantValidator }),
  ceiling: goalShape({ kind: literalUnion('ceiling'), level: literalUnion('read', 'edit', 'publish', 'merge') }),
})

const goalValidators = {
  'goal/list': goalShape({ root: optional(atMost(4096, isFilled)) }),
  'goal/read': goalShape({ goal: goalId }),
  'goal/create': goalShape({
    root: atMost(4096, isFilled), cwd: optional(atMost(4096, isFilled)), sentence: goalSentence,
    checkout: optional(literalUnion('shared', 'isolated')), dependsOn: optional(goalDependencies),
  }),
  'goal/update': goalShape({
    goal: goalId, revision: goalInteger(0), sentence: optional(goalSentence), dependsOn: optional(goalDependencies),
  }),
  'goal/seat': goalShape({
    goal: goalId, agent: goalIdentifier, seats: optional(seatListValidator),
    grant: optional(goalGrant), card: optional(goalInteger(1)), isolate: optional(isBoolean),
  }),
  'goal/assign': goalShape({
    goal: goalId, card: goalInteger(1),
    session: goalShape({ runtime: goalIdentifier, sessionId: goalIdentifier }),
  }),
  'goal/release': goalShape({ goal: goalId, seat: goalIdentifier }),
  'goal/migration/ack': goalShape({}),
}
```

In `packages/protocol/src/wire-validators.ts`, replace this exact anchor:

```ts
const paramsValidators: Record<HostMethodName, Validator<unknown>> = {
```

with:

```ts
const paramsValidators: Record<HostMethodName, Validator<unknown>> = {
  ...goalValidators,
```

- [ ] **Step 7: Expose Goal operations through HostContext**

In `packages/server/src/methods/context.ts`, replace this exact anchor:

```ts
import type { Flows } from '../flows.js'
```

with:

```ts
import type { Flows } from '../flows.js'
import type { GoalPlane } from '../goals/plane.js'
```

In `packages/server/src/methods/context.ts`, replace this exact anchor:

```ts
  readonly flows: Flows
```

with:

```ts
  readonly flows: Flows
  readonly goals: GoalPlane
```

Create `packages/server/src/methods/goals.ts` with these complete contents:

```ts
import type { MethodsUnder } from './context.js'

export const goalMethods = {
  'goal/list': (ctx, params) => ctx.goals.list(params.root),
  'goal/read': (ctx, params) => ctx.goals.view(params.goal),
  'goal/create': (ctx, params) => ctx.goals.create(params),
  'goal/update': (ctx, params) => ctx.goals.update(params.goal, params.revision, {
    ...(params.sentence === undefined ? {} : { sentence: params.sentence }),
    ...(params.dependsOn === undefined ? {} : { dependsOn: params.dependsOn }),
  }),
  'goal/seat': (ctx, params) => ctx.goals.seat(params),
  'goal/assign': (ctx, params) => ctx.goals.assign(params.goal, params.card, params.session),
  'goal/release': async (ctx, params) => {
    await ctx.goals.release(params.goal, params.seat)
    return null
  },
  'goal/migration/ack': async (ctx) => {
    await ctx.goals.store.acknowledgeMigration()
    return null
  },
} satisfies MethodsUnder<'goal/'>
```

In `packages/server/src/methods/index.ts`, replace this exact anchor:

```ts
import { flowMethods } from './flows.js'
```

with:

```ts
import { flowMethods } from './flows.js'
import { goalMethods } from './goals.js'
```

In `packages/server/src/methods/index.ts`, replace this exact anchor:

```ts
  ...flowMethods,
```

with:

```ts
  ...flowMethods,
  ...goalMethods,
```

In `packages/server/src/methods/index.ts`, replace this exact anchor:

```ts
  flowMethods,
```

with:

```ts
  flowMethods,
  goalMethods,
```

Run: `pnpm run build:node && node --test --test-reporter=spec packages/protocol/dist/test/goal-wire.test.js`

Expected: PASS — 4 tests through parseClientMessage, including extra-field refusals and both grant generations.

- [ ] **Step 8: Replace the legacy flow membership path with awaited Seat openings**

In `packages/server/src/flows.ts`, replace this exact anchor:

```ts
  /**
   * Opens a conversation on an agent, in a folder, with the model and effort
   * the seat asked for — and reports what it is *actually* running.
   *
   * Reported rather than assumed because a runtime drops a pick it declines
   * rather than failing, and a seat that believes it is running at an effort
   * it is not is a seat with an unchecked claim on it.
   */
  seat(
    seat: FlowSeat,
    where: { readonly cwd: string; readonly title: string },
  ): Promise<{ readonly runtime: string; readonly sessionId: string; readonly label: string }>
```

with:

```ts
  /** Opens and durably records a legacy role before its first standing-order turn. */
  openLegacySeat(input: {
    goal: string
    spec: FlowSeat
    permission: FlowPermission
    role: string
    isolate: boolean
    title: string
  }): Promise<SeatRecord>
  /** Closes only the Goal Seat this failed flow opened, after its turn has stopped. */
  releaseGoalSeat(goal: string, seat: SeatId): Promise<void>
```

In `packages/server/src/flows.ts`, replace this exact anchor:

```ts
  Flow,
```

with:

```ts
  Flow,
  FlowPermission,
  SeatId,
  SeatRecord,
```

Remove these exact obsolete declarations from `FlowPort`:

```ts
  /** Puts a conversation in a room. */
  join(room: string, runtime: string, sessionId: string): Promise<void>
```

```ts
  /** A worktree of its own, on a branch of its own, for a role that isolates. */
  isolate(root: string, name: string): Promise<string>
```

In `packages/server/src/flows.ts`, replace this exact anchor:

```ts
    const undo = async (why: string): Promise<void> => {
      for (const seat of opened) {
        this.#team.setRole(request.room, seat.runtime, seat.sessionId, null)
        try {
          this.#team.leaveRoom(request.room, seat.runtime as never, seat.sessionId)
        } catch {
          // A room that is already gone needs no leaving.
        }
        await this.#port.retire(seat.runtime, seat.sessionId).catch(() => {})
      }
      this.#port.log('a flow could not seat every role, so the ones it opened were closed', {
        room: request.room,
        opened: opened.length,
        why,
      })
    }
```

with:

```ts
    const openedIds = new Map<string, SeatId>()
    const undo = async (why: string): Promise<void> => {
      const failures: string[] = []
      for (const seat of opened) {
        try {
          await this.#port.retire(seat.runtime, seat.sessionId)
          const id = openedIds.get(`${seat.runtime}\u0000${seat.sessionId}`)
          if (id) await this.#port.releaseGoalSeat(request.room, id)
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }
      this.#port.log('a flow could not seat every role, so its opened Seats were released', {
        room: request.room, opened: opened.length, why, failures,
      })
      if (failures.length > 0) {
        throw new Error(`${why} Cleanup also failed: ${failures.join('; ')}. The partial conversations were kept.`)
      }
    }
```

In `packages/server/src/flows.ts`, replace this exact anchor:

```ts
    try {
    for (const role of flow.roles) {
      if (role.kind !== 'agent') continue
      for (let index = 0; index < role.count; index += 1) {
        const spec = seatAt(role, index)
        const cwd = role.isolate
          ? await this.#port.isolate(folder, `${role.id}-${index + 1}-${id.slice(-4)}`)
          : folder
        const title = `${role.id}${role.count > 1 ? ` ${index + 1}` : ''} · ${board.name} · ${flow.name}`
        const live = await this.#port.seat(spec, { cwd, title })
        const held: FlowSeatRecord = {
          /* Escaped, not the raw byte: a NUL in the source makes the whole
             file binary to grep, and the string is identical either way. */
          key: `${live.runtime}\u0000${live.sessionId}`,
          role: role.id,
          runtime: live.runtime,
          sessionId: live.sessionId,
          seat: live.label,
          spec,
          permission: role.permission,
          cwd,
        }
        seats.push(held)
        opened.push(held)
        await this.#port.join(request.room, live.runtime, live.sessionId)
        this.#team.setRole(request.room, live.runtime, live.sessionId, role.id)
        record.push({
          at: now(),
          kind: 'seated',
          role: role.id,
          seat: live.label,
          text: cwd === board.root ? null : cwd,
        })
      }
    }
```

with:

```ts
    try {
      for (const role of flow.roles) {
        if (role.kind !== 'agent') continue
        for (let index = 0; index < role.count; index += 1) {
          const spec = seatAt(role, index)
          const title = `${role.id}${role.count > 1 ? ` ${index + 1}` : ''} · ${board.name} · ${flow.name}`
          const durable = await this.#port.openLegacySeat({
            goal: request.room,
            spec,
            permission: role.permission,
            role: role.id,
            isolate: role.isolate,
            title,
          })
          openedIds.set(`${durable.session.runtime}\u0000${durable.session.sessionId}`, durable.id)
          const held: FlowSeatRecord = {
            key: `${durable.session.runtime}\u0000${durable.session.sessionId}`,
            role: role.id,
            runtime: durable.session.runtime,
            sessionId: durable.session.sessionId,
            seat: durable.seatLabel,
            spec,
            permission: role.permission,
            cwd: durable.checkout.cwd,
          }
          seats.push(held)
          opened.push(held)
          record.push({
            at: now(), kind: 'seated', role: role.id, seat: durable.seatLabel,
            text: durable.checkout.cwd === board.root ? null : durable.checkout.cwd,
          })
        }
      }
```

The following existing order loop stays after the replacement. The run still persists its `room` key and grammar unchanged. Phase 4’s `FlowPort.recorded?` callback and its call are removed from this seating path, while the check-step evidence callback stays. Do not invoke both recording paths. Failed durable opening remains the Goal adapter’s responsibility: retire the newly created runtime conversation before rejecting. The undo above handles only openings this loop received.

- [ ] **Step 9: Complete the existing-engine and Agent-seating adapter boundaries**

Replace mutable `Board.members`/`Board.roles` with reads through `TeamPort.members(board:string):readonly SeatRecord[]`; the host supplies `membersOf(goal,seats.all())`. `#roomOf` looks up the single open kept Goal Seat. `#stateOf` builds `members = seats.map(s => sessionKey(s.session.runtime,s.session.sessionId))` and roles from `SeatRecord.role`; Team never writes them. `#nameOn` calls Task 7's names. The remembered roster remains only display fallback for existing Seat pointers; rebuilding it cannot add or delete a Seat. A closed pane/runtime detach is presence only. Confirmed missing-runtime history calls GoalPlane release/close with `deleted` and keeps today's `gone` notice; a transient error does not close membership.

Instantiate `Assignments(port, goalSerial)` and `Wraps(port, goalSerial)` with the same desk-wide `Serial`; their default constructor queue is only for isolated tests. An operation acquires that queue once. GoalStore’s private `saveLocked` and Team’s private `applyLocked` helpers never enqueue recursively; public entrypoints acquire it and call those helpers. External runtime event callbacks wait for the queue instead of mutating a board directly.

`Team` retains ownership of claims, file conflict rules, role checks, channel state and inbound settings. Add `TeamPort.mutate(board, transform):Promise<void>` backed by GoalStore's serialized write. Every mutating public method awaits it before answering. `TeamState` remains the phase-4 evidence/flow projection, including computed members; new documents never serialize that projection wholesale. The board activity timestamp still ignores pure roster refreshes. Clamp/trim channel and intent history with the current `roomCap` values, but capture the receipt's historical card data before any terminal trimming.

`GoalPlane.view` reads phase 4’s `BoardEvidence` and calls the shared `placeCard` for every current Intent, preserving its exact `PlaceInput` fields: evidence by card ID, `stranded`, `holderWaits`, and `forPerson` derived with `flowRoleOf`. Pass `needsYou:true` to `activityOf` if any placement is `needs`, any Seat needs approval, or held mail needs a person. Pass `busy:true` while any turn/check runs or a placement is `review`; `liveFlow` comes from Flows. Completed cards with missing/stale/failed evidence therefore cannot yield ready-to-wrap. Recompute on card, Seat, runtime, flow, message, check and evidence-change events, not on a timer. An evidence read failure sets GoalView.problem, prevents ready-to-wrap, and blocks wrap preview until repaired. `GoalPlane.create` confines the root/cwd with `ctx.workspaces.confineRoom`, runs `checkedDependencies`, persists one empty GoalBoard and then returns its view. `update` refuses wrapped/wrapping state and performs revision compare-and-swap. `canDispatch` also refuses `GoalDocument.restored` history and is checked by every Seat opening, claim, flow handoff, held-message delivery, queued drain and check run; it refuses unresolved dependencies before a runtime turn starts. Card editing and reading remain available while waiting. Existing live turns are not silently interrupted when a dependency is added; the update refuses such an edit until busy Seats are idle.

Factor the body of `agent/seat` into an internal `seatAgent(input, context)` operation used by ordinary `agent/seat` and `GoalPlane.seat`; preserve phase 2's deadlines, passed-over cleanup, readback, sandbox and brief-once rules. Its context is `{board:string|null, role:string|null, environment?:Readonly<Record<string,string>>, openingId?:SeatId, grant?:SeatGrant}`; these are internal, never extra public agent parameters. For a Goal opening, the durable Seat receives `board:goal.id` before the first brief/order turn. Do not seat an Agent standalone and edit its immutable record later.

`SeatGrant` is the tagged union in Interfaces. Ordinary phase-2 `permission` becomes its permission arm; when phase 3 is absent, the ceiling arm refuses explicitly. When phase 3 is present, call its effective-ceiling path with that arm and record its actual `standing/ceiling`; never map `edit` to legacy `read`. Public Goal UI omits grants and uses read in the Agent's standing-order generation. The result is a phase-4 `SeatRecord`, never an invented settings-only Seat.

The same desk-wide Serial covers all Goal writes and Seat membership transactions, not one lock per `Assignments` instance. Assignment obtains the actual live handle or `runtime.readSession`; a cached host transcript alone is insufficient. Resolve project through `boardRootOf`, never a cwd prefix. Apply existing role/dependency/path ownership checks and enforce one claimed card per Seat. Stage a `GoalOperation.assignment` with a fixed opening ID before closing any standalone Seat or writing the Goal opening; import/close idempotently, persist the card's claim and clear the operation. Startup finishes a staged operation before traffic is enabled. Failed preparation opens nothing; a runtime opened before a durable write failure is retired, with partial transcript retained and the failure named.

Release stages a `GoalOperation.release`, refuses a busy Seat with “Stop this Seat's current turn before releasing it”, closes only that Seat as `released`, returns its nonterminal card to open/blocked according to the existing dependency rule, refuses its pending/held mail with a recorded reason, wakes waits, then clears the operation. The conversation returns to project level and its last Agent identity remains visible from history. No runtime close/delete is part of ordinary Release.

In protocol, validators, `methods/team.ts` and renderer callers together remove `team/plan`, `team/wrap`, `team/room/create`, `/rename`, `/delete`, `/join`, `/leave`. Keep `team/state`, `team/rooms` as read compatibility projections until all internal callers move; keep `team/add/intent/post/handout/messaging/deliver/inbound/peers` with their `room` argument as the unchanged board key. Do not delete the runtime todo module `protocol/src/plan.ts`. Remove nested live Plan strip/add selectors from Task 9; old `Intent.plan` is inert historical metadata.

**Host integration contract for this step (completes the Task 5 prerequisite).** The following is part of Step 9 only; coordinator code and all other Task 3 steps stay as written. These adapter contracts replace the former unsupplied-integration warning. A production proof still requires the named Host/Team tests below.

Files already owned by this task: `packages/server/src/host.ts`, `team.ts`, `flows.ts`, `methods/agents.ts`, `methods/context.ts`, `goals/assignments.ts`, `goals/operations.ts`. Also extend `packages/server/test/fixtures/goals.ts` for shared ownership and the six existing test files named in Step 10. No new public joining API or runtime-specific branch is permitted.

The internal seating context is the one fixed above; declare it by name in `methods/agents.ts`. Use protocol `HostMethods` for the existing wire request/result and keep the wire's Session result intact:

```ts
export interface AgentSeatContext {
  board: string | null
  role: string | null
  environment?: Readonly<Record<string, string>>
  openingId?: SeatId
  grant?: SeatGrant
}
export declare function seatAgent(
  ctx: HostContext,
  input: HostMethods['agent/seat']['params'],
  context: AgentSeatContext,
): Promise<{ session: HostMethods['agent/seat']['result']; record: SeatRecord }>
// TeamPort additions, with the original port members retained.
interface TeamPort {
members(board: string): readonly SeatRecord[]
mutate(board: string, transform: (board: GoalBoard) => GoalBoard): Promise<void>
canDispatch(board: string): { ok: true } | { ok: false; reason: string }
}
```

`GoalPlanePort` remains Step 5's exact interface. Construct it in Host with `satisfies GoalPlanePort`, supplying every property as follows; deferred closures solve construction ordering, not an `as` cast or a temporary permissive port:

| Port members | Host source and mandatory behavior |
| --- | --- |
| `seats.all`, `seats.byId`, `importOpening`, `closeId` | The single phase-4 SeatBook owned by EvidencePlane. Import and close resolve only after durable append. No parallel Goal member cache. |
| `confine` | `ctx.workspaces.confineRoom` and canonical root from `#boardRootOf`; preserve linked-worktree handling. Public absolute cwd validation remains. |
| `known` | Existing registry live handle, otherwise the named runtime's `readSession`; a transcript-only cached record proves no live conversation. Return canonical project and actual busy state; a transient read error refuses assignment without closing a Seat. |
| `claimable`, `claim`, `releaseClaim`, `refuseMail` | Team's existing dependency/role/path-conflict checks and idempotent locked effects. `claimable` also rejects a second active card for this Seat. Released mail records refusal in the original Goal; no later drain can reach a new member. |
| `opening` | Latest kept standalone record's Agent/brief/standing/ceiling, with requested opening ID and Goal board; anonymous history uses unknown. Read actual checkout revision through the phase-4 revision reader; retain null/unknown on unreadable metadata. |
| `board`, `flow`, `busy`, `waits`, `stranded`, `held` | `Team.stateFor`, active Flows run, actual registry running turns/approvals and Team pending state. Never derive busy from a stale roster or count held mail as empty. |
| `evidence` | `EvidencePlane.board`; preserve errors for GoalView.problem/readiness refusal. |
| `changed`, `activity` | `#push` with the exact goal/changed and goal/activity messages. Only announce after durable state, and initialize transition baseline silently. |
| `ready` | Writer lease held, StateStore/Goal migration activated, Seat/evidence loaded and all non-restored operations recovered. Failure returns its actionable sentence, never `{ok:true}` to permit boot. |
| `seatAgent` | Call the factored operation with Agent id, canonical project, **the supplied Goal cwd**, requested candidates/grant and board=Goal ID. Return its durable record; if `card` is supplied, journal/claim it before order. Never call public `goal/seat` recursively. |
| `openLegacySeat` | `#openSeat` with supplied cwd/spec/title, actual readback, anonymous legacy FlowSeat opening, board/role/permission recorded durably. Return before Flows' existing order loop. Remove old join/isolate/recorded callbacks from this path; Task 5 alone allocates the lane. |
| `finish`, `wake`, `finishWrap` | Compare-and-clear the operation with `saveLocked`, wake Team waiters after durability, and Task 8's wrap replay. Until Task 8 exists, a wrap journal refuses startup readiness rather than being cleared. |

Host construction/startup order: create one `goalSerial`; construct GoalStore and the evidence services; construct Team using closures over store/SeatBook; construct GoalPlane with that port and queue, then Flows and HostContext. Do not evaluate closures needing `#context` in a constructor. `HostContext.goals` is the same instance, not a wire-local plane. After writer-lease acquisition and migration, load Goal documents, Seats and persisted flows **without dispatch**, replay operations, then enable flow recovery/runtime traffic and publish views. Restored documents never execute a journal. Startup failure leaves compatibility projection/read-only problem, not live traffic.

Team mutation ownership: public `mutate` acquires the shared queue once, re-reads the Goal document, refuses restored/wrapping/wrapped or unresolved operation, applies a pure transform to `GoalBoard`, saves at revision+1, updates the in-memory board and only then announces/answers. `applyLocked`/`saveLocked` are private caller-held-lock operations used by Goal assignment/release/recovery; they must not call public `mutate`. Awaiting an eventual flush is not persistence. A save failure leaves visible state unchanged. Keep inbound policy in its existing independent store; setting it cannot deliver a message past a Goal gate. Do not await event callbacks that themselves need the held queue; publish them after commit.

**Seating-before-order:** factor candidate selection and `openAsAsked` without changing phase-2 deadlines, availability/refusal ordering, pick readback or passed-over cleanup. Ordinary `agent/seat` calls `seatAgent` with null board/role and returns `.session`. For a Goal, first validate goal/card/claimability and tagged grant under the caller-held queue; use the supplied cwd directly. After a candidate opens/readback succeeds, build the complete phase-4 opening with fixed `openingId`, actual Agent/brief/standing/ceiling and Goal board/role, stage its assignment journal, import it durably, apply an optional claim, and clear the operation before the first `ctx.seats.order`. Project membership to Team before handing over the brief. No standalone opening is created and later edited.

Task 5's environment gate remains in `#openSeat`, taking the lane by its allocated cwd; this adapter does not create another checkout or change `process.env`. Forward `context.environment` through the session options when present. Append the six exact lane allocation values and the explicit-port advice to the first brief when a lane is found for that cwd, including during the reserved/pre-bind stage. Preserve the original brief digest as the Agent file's digest, not a digest of the appended lane instructions. `GoalPlane.#withLane` binds only after the durable Seat return.

A durable opening failure retires the newly opened runtime and rejects before any order; retain transcript/error and let the staged operation recover rather than invent a successful opening. If an order fails after recording, retire that new runtime, close the record once as deleted, release its unfinished claim/refuse mail through locked journal effects, then report `BriefNotHandedOverError`; no orphan active Goal Seat. A cleanup failure leaves the operation/problem visible and blocks dispatch until recovery. Legacy flow opening obeys the same durable-before-order rule, while Flows still owns its existing subsequent order loop and cleanup for openings it received. No asynchronous phase-4 `recorded` callback runs as well.

**Proven hard part — recheck after asynchronous runtime preparation.** Export this function from `goals/assignments.ts`. It is an ordering guard, not a replacement for Team's authorization or the shared queue. `allowed` rechecks the captured Goal and original Seat identities; it never follows a conversation into another Goal. `dispatch` begins the effect synchronously before its first await; if it must await again before send/spawn, that final boundary uses this guard too.

```ts
export async function dispatchAfter<T>(
  allowed: () => { ok: true } | { ok: false; reason: string },
  prepare: () => Promise<T>,
  dispatch: (ready: T) => Promise<void>,
): Promise<void> {
  const before = allowed()
  if (!before.ok) throw new Error(before.reason)
  const ready = await prepare()
  const after = allowed()
  if (!after.ok) throw new Error(after.reason)
  await dispatch(ready)
}
```

Named guarded callers (all consume the same `GoalPlane.canDispatch`; no permissive default):
- `Team.claim`, `claimNext`, `handout` check dispatch/dependencies before claiming; card add/edit/read still work while dependencies wait. `Team.post`, `send`, `deliverHeld` and queued drain inside `onTurnEnded` capture original board/Seat IDs and recheck after each await before delivery.
- Host TeamPort `send`/`steer` wrap `#teamLive` with `dispatchAfter`; validate original sender/receiver membership in Team, and receiver plus original board again in Host. `#orderSeat` and FlowPort `order` recheck after resume before the initial/rearmed order. Direct ordinary conversation dispatch stays independent unless it is dispatching Goal-owned work.
- `Flows.start`, handoff/completion-triggered next round, rearm and retry check before any seat/order/command; keep run `room` IDs and flow grammar. A new unresolved dependency prevents the next round rather than interrupting a running turn.
- Phase-4 `EvidencePlane`/`check-runs.ts` gate at request and immediately before spawn, including after approvals; Task 8 supplies `canMutateBoard` for wrap. Before that extension, route through `GoalPlane.canDispatch` rather than adding an unconditional stub to production.
- Runtime/evidence/flow event handlers enqueue board mutation; `turn/completed` resolves captured waits first, then drains permitted traffic. Restore/recovery never dispatches before ready. Use the current `canDispatch` refusal sentence consistently instead of leaking a wire method name.

Shared fixture edits (retain assertion meaning and original test boundary):
- `test/fixtures/goals.ts`: add the rig factory used by Team tests, owning one temporary GoalStore, one real SeatBook and one Serial; create Goal documents and import explicit kept Seats before projecting peers. Its helpers return `{team, goals, seats, store, serial, close}`; `close` flushes owned stores before scratch cleanup. No `joinRoom` shim and no test-owned membership array.
- `team.test.ts`: migrate its room/join setup to that rig; await now-durable board mutators. Preserve numeric guards, inbound policy, rename-free historical names, conflict, delivery, audit and persisted restart assertions. Replace only removed live Plan-authoring assertions with legacy-Plan read-only coverage.
- `flows.test.ts`: replace port seat/join/isolate/recorded fixtures with awaited `openLegacySeat`; return truthful Goal Seat records. Keep role/outcome/dependency/rearm checks, assert order sees the already-kept opening, and count one record per session.
- `host-flow.test.ts`: run through actual Host with fake runtime/evidence files, assert same cwd reaches open, durable record and order, and opening failure retires before order. Do not substitute a Flows-only fixture.
- `agent-seat.test.ts`: existing public tests keep Session result and all deadline/passed-over/readback/brief-once assertions; add Goal context cases proving opening-before-order, supplied cwd, optional card claim, unsupported ceiling refusal, write failure and post-record order failure cleanup.
- `room-restart.test.ts` and `room-worktree.test.ts`: retain `Host.call`, fake runtime and real scratch-git setup; migrate Goal/Seat setup only, preserving runtime-existence refusal, linked-worktree canonical-project checks and history retention after detach.

New cases in `goal-plane.test.ts` / `goal-flow-compat.test.ts`: pause `#teamLive`/candidate opening, change dependency/membership, resume and assert no send/spawn; two concurrent assignment/Team mutations produce one winner and no deadlock; injected GoalStore save failure yields neither success reply nor changed broadcast. The missing adapter would fail these tests, so keep them at Host/Team layers. Add the two proven `dispatchAfter` cases (post-await refusal and initial refusal/no preparation) to `goal-assignment.test.ts`; removing the second check must fail the first.

Run Step 10's exact production commands after these changes, plus `pnpm run build:node` to check every port with `satisfies`. Expected: all old assertions and new integration cases pass; the old fixed test totals in Step 10 are a baseline, and these added cases increase them. The scratch guard proof is 2/2 green after its deliberate mutation failed 1/2; it does not claim these future Host adapters have been built.


- [ ] **Step 10: Run the new focused suites and retain the original regression boundaries**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/goal-assignment.test.js packages/server/dist/test/goal-membership.test.js packages/server/dist/test/goal-operations.test.js packages/server/dist/test/goal-plane.test.js packages/server/dist/test/goal-flow-compat.test.js packages/protocol/dist/test/goal-wire.test.js`

Expected: PASS — 7 assignment, 3 membership, 4 journal, 4 GoalPlane, 3 flow-compatibility and 4 wire tests, 25 total.

Named existing tests retain their assertions: `team.test.ts` changes only its GoalStore/SeatBook fixture ownership, `flows.test.ts` and `host-flow.test.ts` use awaited `openLegacySeat`, `agent-seat.test.ts` gains the optional internal Goal context, and the two room restart/worktree files keep runtime-existence and canonical-project checks. None is replaced by a port test.

Run: `node --test --test-reporter=spec packages/server/dist/test/team.test.js packages/server/dist/test/flows.test.js packages/server/dist/test/host-flow.test.js packages/server/dist/test/agent-seat.test.js packages/server/dist/test/room-restart.test.js packages/server/dist/test/room-worktree.test.js`

Expected: PASS — all existing assertions after the exact adapter/helper edits in Step 9. These production integration suites were not run by the depth-pass writer; the missing prerequisite wiring must not be represented as green.

- [ ] **Step 11: Prove one-winner assignment depends on the shared serial queue**

Temporarily replace `const result = this.#tail.then(fn)` with `const result = fn()` in `Serial.run`.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/goal-assignment.test.js`

Expected: FAIL — 2 failed, 5 passed. Both concurrent-assignment tests report `2 !== 1`: two calls kept one conversation.

Restore the queue expression from Step 3.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/goal-assignment.test.js`

Expected: PASS — 7 tests.

- [ ] **Step 12: Commit only after the real Host and Team boundaries pass**

The implementation owner runs the complete gate before committing; the depth-pass writer does not execute this step.

Run: `pnpm verify`

Expected: Exit 0. A sandbox refusal is not a passing gate; the controller runs this on the real surface.

```bash
git add packages/server/src/goals/assignments.ts packages/server/src/goals/members.ts packages/server/src/goals/plane.ts packages/server/src/goals/operations.ts packages/server/src/evidence/seats.ts packages/server/src/team.ts packages/server/src/flows.ts packages/server/src/host.ts packages/server/src/methods/agents.ts packages/server/src/methods/team.ts packages/server/src/methods/goals.ts packages/server/src/methods/context.ts packages/server/src/methods/index.ts packages/protocol/src/wire.ts packages/protocol/src/wire-validators.ts packages/server/test/goal-assignment.test.ts packages/server/test/goal-membership.test.ts packages/server/test/goal-operations.test.ts packages/server/test/goal-plane.test.ts packages/server/test/goal-flow-compat.test.ts packages/protocol/test/goal-wire.test.ts
git commit -m "feat(goals): derive membership from Seats and journal assignments" -m "Co-Authored-By: Codex <agent@harnessdesk.app>"
```

### Task 4: Allocate complete lanes and expose machine preferences

Every nonreleased descriptor is a lease, including one whose checkout did not finish. Allocation is serialized across the desk, writes that reservation before creating a checkout, and never erases a resource to compensate for a failed opening. The socket scan measures availability; it cannot reserve against an unrelated application after its probes close.

**Files:**
- Extend: `packages/protocol/src/goal.ts`; modify `packages/protocol/src/wire.ts`, `wire-validators.ts`.
- Create: `packages/server/src/goals/lanes.ts`, `packages/server/src/methods/lanes.ts`.
- Modify: `packages/server/src/state.ts`, `host.ts`, `goals/plane.ts`, `methods/context.ts`, `methods/index.ts`, `script/check-reachable.mjs`.
- Create tests: `packages/server/test/lane-allocation.test.ts`, `lane-store.test.ts`, `lane-recovery.test.ts`, `lane-preferences.test.ts`, `lane-listeners.test.ts`.
- Existing tests retained: `state.test.ts`, `worktree.test.ts`, `methods.test.ts`; no assertion is removed or narrowed.

**Proof needs:** a listener. **Routing:** Sonnet. The arithmetic, registry and release guards can be proved without a listener; the final child-server acceptance cannot.

**Interfaces:** `LanePreferences`, `Lane`, `lanePreferences`, `DEFAULT_LANE_PREFERENCES` are protocol exports. `firstBlock`, `laneEnvironment`, `LaneStore.list/save/load`, `LaneAllocator.allocate(goal,id,prefs)`, `bind(id,seat)`, `retain(id)`, `release(id)`, `list()` and `forSeat(seat)` live in `goals/lanes.ts`. `GoalPlane.laneFor(seat)` reads this one registry. `availablePorts(ports,deadline)` probes both loopback families, closes every server, and refuses unknown errors. The allocator's queue is separate from the Goal queue: acquire Goal, then allocator, then store, never in reverse.

- [ ] **Step 1: Write the allocation tests before adding the allocator**

Create `packages/server/test/lane-allocation.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LaneAllocator, firstBlock, laneEnvironment } from '../src/goals/lanes.js'
import { lanePreferences, type Lane, type LanePreferences } from '@harnessdesk/protocol'

const prefs: LanePreferences = { start: 65500, width: 18, browserProfile: true }

const rig = () => {
  const saved = new Map<string, Lane>()
  const created: string[] = []
  let occupied = false
  let broken = false
  let active = false
  let busy = false
  const allocator = new LaneAllocator({
    list: () => [...saved.values()],
    save: async (lane) => { saved.set(lane.id, structuredClone(lane)) },
    available: async (ports) => !occupied || ports.start !== 65500,
    create: async (id) => {
      created.push(id)
      if (broken) throw new Error('checkout failed')
      return { cwd: `/work/${id}`, branch: `harnessdesk/lane-${id}` }
    },
    active: () => active,
    busy: () => busy,
  })
  return {
    allocator, saved, created,
    occupied: (value: boolean) => { occupied = value },
    broken: (value: boolean) => { broken = value },
    active: (value: boolean) => { active = value },
    busy: (value: boolean) => { busy = value },
  }
}

test('concurrent allocations across Goals reserve whole disjoint intervals', async () => {
  const proof = rig()
  const [a, b] = await Promise.all([
    proof.allocator.allocate('g1', 'a', prefs),
    proof.allocator.allocate('g2', 'b', prefs),
  ])
  assert.deepEqual(a.ports, { start: 65500, end: 65517 })
  assert.deepEqual(b.ports, { start: 65518, end: 65535 })
  assert.notEqual(a.browserProfile, b.browserProfile)
  assert.match(a.browserProfile!, /^lane-[a-f0-9-]{36}$/)
  await assert.rejects(proof.allocator.allocate('g3', 'c', prefs), /No lane port block is free/)
  assert.deepEqual(proof.created, ['a', 'b'])
})

test('retained reservations keep absolute intervals after preferences change', async () => {
  const proof = rig()
  const lane = await proof.allocator.allocate('g1', 'a', prefs)
  await proof.allocator.retain(lane.id)
  assert.deepEqual(firstBlock({ ...prefs, start: 65501 }, proof.allocator.list()), null)
  assert.deepEqual(firstBlock(prefs, [{ ...lane, state: 'released' }]), lane.ports)
})

test('occupied blocks are skipped before a checkout is made', async () => {
  const proof = rig()
  proof.occupied(true)
  const lane = await proof.allocator.allocate('g1', 'a', prefs)
  assert.equal(lane.ports.start, 65518)
  assert.deepEqual(proof.created, ['a'])
})

test('a failed checkout retains its reservation and retry cannot overwrite it', async () => {
  const proof = rig()
  proof.broken(true)
  await assert.rejects(proof.allocator.allocate('g1', 'a', prefs), /checkout failed/)
  assert.equal(proof.saved.get('a')?.state, 'retained')
  assert.equal(proof.saved.get('a')?.ports.start, 65500)
  await assert.rejects(proof.allocator.allocate('g1', 'a', prefs), /already recorded/)
  assert.deepEqual(proof.created, ['a'])
})

test('reservation persistence failure opens no checkout and does not poison the queue', async () => {
  let saves = 0
  let creates = 0
  const saved: Lane[] = []
  const allocator = new LaneAllocator({
    list: () => saved,
    save: async (lane) => {
      if (++saves === 1) throw new Error('disk full')
      saved.push(lane)
    },
    available: async () => true,
    create: async () => { creates++; return { cwd: '/work/a', branch: 'lane-a' } },
    active: () => false,
    busy: () => false,
  })
  await assert.rejects(allocator.allocate('g1', 'a', prefs), /disk full/)
  assert.equal(creates, 0)
  await allocator.allocate('g1', 'b', prefs)
  assert.equal(creates, 1)
})

test('binding is idempotent for its Seat and refuses replacement', async () => {
  const proof = rig()
  await proof.allocator.allocate('g1', 'a', prefs)
  await proof.allocator.bind('a', 's1')
  await proof.allocator.bind('a', 's1')
  await assert.rejects(proof.allocator.bind('a', 's2'), /another Seat/)
  assert.equal(proof.allocator.forSeat('s1')?.id, 'a')
})

test('release refuses active, busy and listening lanes and retains their resources', async () => {
  const proof = rig()
  const lane = await proof.allocator.allocate('g1', 'a', prefs)
  proof.active(true)
  await assert.rejects(proof.allocator.release('a'), /active Seat/)
  proof.active(false)
  proof.busy(true)
  await assert.rejects(proof.allocator.release('a'), /finish its turn/)
  proof.busy(false)
  proof.occupied(true)
  await assert.rejects(proof.allocator.release('a'), /still in use/)
  proof.occupied(false)
  const released = await proof.allocator.release('a')
  assert.deepEqual(released, { ...lane, state: 'released' })
  assert.deepEqual(await proof.allocator.release('a'), released)
  assert.deepEqual(proof.created, ['a'])
})

test('lane environment has exactly six values and refuses released leases', async () => {
  const proof = rig()
  const lane = await proof.allocator.allocate('g1', 'a', prefs)
  assert.deepEqual(laneEnvironment(lane), {
    HARNESSDESK_GOAL_ID: 'g1',
    HARNESSDESK_LANE_ID: 'a',
    HARNESSDESK_PORT_START: '65500',
    HARNESSDESK_PORT_END: '65517',
    HARNESSDESK_PORT_COUNT: '18',
    PORT: '65500',
  })
  assert.throws(() => laneEnvironment({ ...lane, state: 'released' }), /released/)
  assert.throws(() => laneEnvironment({ ...lane, state: 'reserved' }), /not ready/)
})

test('profile sharing is an explicit allocation choice, unaffected by later preferences', async () => {
  const proof = rig()
  const a = await proof.allocator.allocate('g1', 'a', { ...prefs, browserProfile: false })
  const b = await proof.allocator.allocate('g1', 'b', prefs)
  assert.equal(a.browserProfile, null)
  assert.notEqual(b.browserProfile, null)
  assert.equal(proof.saved.get('a')?.browserProfile, null)
})

test('preferences reject incomplete, noncanonical and out-of-range values', () => {
  for (const invalid of [
    null, [], {}, { ...prefs, start: 1023 }, { ...prefs, start: 65536 },
    { ...prefs, width: 0 }, { ...prefs, width: 1001 }, { ...prefs, width: 1.5 },
    { ...prefs, start: 65535, width: 2 }, { ...prefs, browserProfile: 'yes' },
    { ...prefs, extra: true },
  ]) assert.throws(() => lanePreferences(invalid), /starting port/)
  assert.deepEqual(lanePreferences({ start: 65535, width: 1, browserProfile: true }), {
    start: 65535, width: 1, browserProfile: true,
  })
})

test('a deadline aborts scanning without saving a guessed allocation', async () => {
  const saved: Lane[] = []
  let time = 0
  const allocator = new LaneAllocator({
    list: () => saved,
    save: async (lane) => { saved.push(lane) },
    available: async () => { time = 5001; return false },
    create: async () => { throw new Error('must not create') },
    active: () => false,
    busy: () => false,
  }, () => time)
  await assert.rejects(allocator.allocate('g1', 'a', prefs), /five seconds/)
  assert.deepEqual(saved, [])
})
```

- [ ] **Step 2: Observe the missing-module red**

Run: `pnpm run build:node`

Expected: FAIL — `Cannot find module '../src/goals/lanes.js'` and the missing protocol lane exports. The planning copy was also run before this module existed: Vitest refused `./lanes.js`.

- [ ] **Step 3: Add the lane contract and its single preference validator**

Append the following complete declarations after the final declaration in Task 1's `packages/protocol/src/goal.ts`. Its existing `export * from './goal.js'` exposes these through the public protocol; no second export list is needed.

```ts
export interface LanePreferences {
  readonly start: number
  readonly width: number
  readonly browserProfile: boolean
}

export interface Lane {
  readonly id: string
  readonly goal: string
  readonly seat: string | null
  readonly cwd: string
  readonly branch: string
  readonly ports: { readonly start: number; readonly end: number }
  readonly browserProfile: string | null
  readonly state: 'reserved' | 'active' | 'retained' | 'released'
  readonly createdAt: number
}

export const DEFAULT_LANE_PREFERENCES: LanePreferences = {
  start: 30000,
  width: 20,
  browserProfile: true,
}

/** One reading rule for the wire, preferences and allocation. No partial patches. */
export function lanePreferences(value: unknown): LanePreferences {
  const bad = (): never => {
    throw new Error('Use a starting port from 1024 to 65535 and a width from 1 to 1000 that fits below 65536.')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad()
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).length !== 3 ||
      typeof raw.start !== 'number' || !Number.isSafeInteger(raw.start) ||
      typeof raw.width !== 'number' || !Number.isSafeInteger(raw.width) ||
      raw.start < 1024 || raw.start > 65535 || raw.width < 1 || raw.width > 1000 ||
      raw.start + raw.width - 1 > 65535 || typeof raw.browserProfile !== 'boolean') return bad()
  return { start: raw.start, width: raw.width, browserProfile: raw.browserProfile }
}
```

- [ ] **Step 4: Implement durable reservations, release guards and bounded probes**

Create `packages/server/src/goals/lanes.ts` with these complete contents:

```ts
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { lanePreferences, type Lane, type LanePreferences } from '@harnessdesk/protocol'

import { Serial } from './assignments.js'
import { atomicJson } from './store.js'

export { lanePreferences }
export type { Lane, LanePreferences }

const NO_BLOCK = 'No lane port block is free. Release a retained lane or change Workspaces › Lanes; no Seat was opened.'
const DEADLINE = 'The lane port scan took five seconds. Release a retained lane or change Workspaces › Lanes; no Seat was opened.'

export function firstBlock(prefs: LanePreferences, leases: readonly Lane[]): Lane['ports'] | null {
  lanePreferences(prefs)
  for (let start = prefs.start; start + prefs.width - 1 <= 65535; start += prefs.width) {
    const end = start + prefs.width - 1
    if (!leases.some((lane) => lane.state !== 'released' && start <= lane.ports.end && lane.ports.start <= end)) {
      return { start, end }
    }
  }
  return null
}

export function laneEnvironment(lane: Lane): Readonly<Record<string, string>> {
  if (lane.state === 'released') {
    throw new Error('This lane’s ports were released. Allocate a new lane before reopening its conversation.')
  }
  if (lane.state === 'reserved' || !lane.cwd) throw new Error('This lane is not ready. Review its retained reservation first.')
  return {
    HARNESSDESK_GOAL_ID: lane.goal,
    HARNESSDESK_LANE_ID: lane.id,
    HARNESSDESK_PORT_START: String(lane.ports.start),
    HARNESSDESK_PORT_END: String(lane.ports.end),
    HARNESSDESK_PORT_COUNT: String(lane.ports.end - lane.ports.start + 1),
    PORT: String(lane.ports.start),
  }
}

export interface LanePort {
  list(): readonly Lane[]
  save(lane: Lane): Promise<void>
  available(ports: Lane['ports'], deadline: number): Promise<boolean>
  create(id: string, goal: string): Promise<{ cwd: string; branch: string }>
  locate?(lane: Lane): Promise<{ cwd: string; branch: string } | null>
  active(lane: Lane): boolean
  busy(lane: Lane): boolean
}

/** One instance per desk, across every project. Always acquire the Goal queue first. */
export class LaneAllocator {
  readonly #serial = new Serial()

  constructor(private readonly port: LanePort, private readonly now: () => number = Date.now) {}

  list(): readonly Lane[] {
    return this.port.list().map((lane) => structuredClone(lane))
  }

  forSeat(seat: string): Lane | null {
    return this.list().find((lane) => lane.seat === seat) ?? null
  }

  allocate(goal: string, id: string, prefs: LanePreferences): Promise<Lane> {
    return this.#serial.run(async () => {
      lanePreferences(prefs)
      if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new Error('The host did not name a lane.')
      if (!goal || goal.length > 4096) throw new Error('Choose an existing Goal.')
      if (this.port.list().some((lane) => lane.id === id)) throw new Error('This lane is already recorded. Review its retained allocation.')
      const deadline = this.now() + 5000
      const rejected: Lane[] = []
      for (;;) {
        if (this.now() >= deadline) throw new Error(DEADLINE)
        const ports = firstBlock(prefs, [...this.port.list(), ...rejected])
        if (!ports) throw new Error(NO_BLOCK)
        const reservation: Lane = {
          id, goal, seat: null, cwd: '', branch: '', ports,
          browserProfile: prefs.browserProfile ? `lane-${randomUUID()}` : null,
          state: 'reserved', createdAt: this.now(),
        }
        const available = await this.port.available(ports, deadline)
        if (this.now() >= deadline) throw new Error(DEADLINE)
        if (!available) {
          rejected.push(reservation)
          continue
        }
        await this.port.save(reservation)
        let result = reservation
        try {
          const checkout = await this.port.create(id, goal)
          result = { ...reservation, ...checkout, state: 'active' }
          await this.port.save(result)
          return structuredClone(result)
        } catch (error) {
          try {
            await this.port.save({ ...result, state: 'retained' })
          } catch (retention) {
            throw new AggregateError([error, retention],
              `Lane ${id} could not finish or record its retained state. Its reservation and any checkout were kept.`)
          }
          throw error
        }
      }
    })
  }

  bind(id: string, seat: string): Promise<void> {
    return this.#serial.run(async () => {
      const lane = this.#read(id)
      if (lane.seat === seat) return
      if (lane.seat !== null) throw new Error('This lane already belongs to another Seat.')
      if (lane.state !== 'active') throw new Error('Only a ready lane can be bound to a Seat.')
      if (this.port.list().some((one) => one.seat === seat)) throw new Error('This Seat already has a lane.')
      await this.port.save({ ...lane, seat })
    })
  }

  retain(id: string): Promise<void> {
    return this.#serial.run(async () => {
      const lane = this.#read(id)
      if (lane.state === 'retained' || lane.state === 'released') return
      await this.port.save({ ...lane, state: 'retained' })
    })
  }

  release(id: string): Promise<Lane> {
    return this.#serial.run(async () => {
      const lane = this.#read(id)
      if (lane.state === 'released') return structuredClone(lane)
      if (this.port.active(lane)) throw new Error('Release this lane’s active Seat before releasing its ports.')
      if (this.port.busy(lane)) throw new Error('Wait for this conversation to finish its turn before releasing its ports.')
      if (!await this.port.available(lane.ports, this.now() + 5000)) {
        throw new Error('A port in this lane is still in use. Stop its server before releasing the ports.')
      }
      const released: Lane = { ...lane, state: 'released' }
      await this.port.save(released)
      return structuredClone(released)
    })
  }

  recover(seats: readonly {
    id: string
    board: string | null
    closed: unknown
    restored?: unknown
    checkout: { cwd: string }
  }[]): Promise<void> {
    return this.#serial.run(async () => {
      for (const saved of this.port.list()) {
        if (saved.state === 'released') continue
        const found = saved.cwd ? null : await this.port.locate?.(saved)
        const lane = found ? { ...saved, ...found } : saved
        const matching = seats.filter((seat) => !seat.restored && !seat.closed &&
          seat.board === lane.goal && lane.cwd !== '' && seat.checkout.cwd === lane.cwd)
        if (matching.length > 1 || lane.seat !== null && matching.some((seat) => seat.id !== lane.seat)) {
          throw new Error('A lane has conflicting Seat ownership. Repair it before dispatching work.')
        }
        const seat = matching[0]?.id ?? lane.seat
        await this.port.save({ ...lane, seat, state: matching.length === 1 ? 'active' : 'retained' })
      }
    })
  }

  #read(id: string): Lane {
    const lane = this.port.list().find((one) => one.id === id)
    if (!lane) throw new Error('This lane was not found. Read the Goal again.')
    return lane
  }
}

/** Refuse damaged ownership rather than reusing ports whose owner is unknown. */
function readLane(value: unknown): Lane {
  const bad = (): never => { throw new Error('The lane registry cannot be read. Its bytes and port ownership were kept.') }
  if (typeof value !== 'object' || value === null) return bad()
  const lane = value as Lane
  if (typeof lane.id !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(lane.id) ||
      typeof lane.goal !== 'string' || !lane.goal || lane.goal.length > 4096 ||
      !(lane.seat === null || typeof lane.seat === 'string' && lane.seat.length > 0 && lane.seat.length <= 200) ||
      typeof lane.cwd !== 'string' || typeof lane.branch !== 'string' ||
      !['reserved', 'active', 'retained', 'released'].includes(lane.state) ||
      !Number.isSafeInteger(lane.createdAt) || lane.createdAt < 0 ||
      !(lane.browserProfile === null || typeof lane.browserProfile === 'string' && /^lane-[a-f0-9-]{36}$/.test(lane.browserProfile)) ||
      !lane.ports) return bad()
  try {
    lanePreferences({ start: lane.ports.start, width: lane.ports.end - lane.ports.start + 1, browserProfile: true })
  } catch {
    return bad()
  }
  if (lane.state === 'active' && (!lane.cwd || !lane.branch)) return bad()
  return structuredClone(lane)
}

export class LaneStore {
  readonly #file: string
  readonly #serial = new Serial()
  #lanes: Lane[] = []
  #loaded = false

  constructor(home: string, private readonly write: typeof atomicJson = atomicJson) {
    this.#file = join(home, 'lanes', 'index.json')
  }

  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.#file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.#loaded = true
      return
    }
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('The lane registry is larger than 8 MiB.')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null ||
        (parsed as { version?: unknown }).version !== 1 ||
        !Array.isArray((parsed as { lanes?: unknown }).lanes)) {
      throw new Error('The lane registry version cannot be read. Update the desk before allocating a lane.')
    }
    const lanes = (parsed as { lanes: unknown[] }).lanes.map(readLane)
    const ids = new Set<string>()
    const seats = new Set<string>()
    const intervals: Lane[] = []
    for (const lane of lanes) {
      if (ids.has(lane.id) || lane.seat !== null && seats.has(lane.seat)) {
        throw new Error('The lane registry names an owner twice. Repair it before allocating a lane.')
      }
      ids.add(lane.id)
      if (lane.seat !== null) seats.add(lane.seat)
      if (lane.state === 'released') continue
      if (intervals.some((one) => lane.ports.start <= one.ports.end && one.ports.start <= lane.ports.end)) {
        throw new Error('The lane registry has overlapping port leases. Repair it before allocating a lane.')
      }
      intervals.push(lane)
    }
    this.#lanes = lanes
    this.#loaded = true
  }

  list(): readonly Lane[] {
    if (!this.#loaded) throw new Error('Read the lane registry before allocating a lane.')
    return this.#lanes.map((lane) => structuredClone(lane))
  }

  save(lane: Lane): Promise<void> {
    return this.#serial.run(async () => {
      this.list()
      const next = [...this.#lanes.filter((one) => one.id !== lane.id), readLane(lane)]
      await mkdir(join(this.#file, '..'), { recursive: true })
      await this.write(this.#file, { version: 1, lanes: next })
      this.#lanes = next
    })
  }
}

/** Hold every successful probe until this block has been checked; always close it. */
export async function availablePorts(ports: Lane['ports'], deadline: number): Promise<boolean> {
  const held: ReturnType<typeof createServer>[] = []
  try {
    for (let port = ports.start; port <= ports.end; port++) {
      for (const host of ['127.0.0.1', '::1']) {
        if (Date.now() >= deadline) throw new Error(DEADLINE)
        const server = createServer()
        held.push(server)
        const free = await new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(() => {
            server.close()
            reject(new Error(DEADLINE))
          }, Math.max(1, deadline - Date.now()))
          server.once('error', (error: NodeJS.ErrnoException) => {
            clearTimeout(timer)
            if (error.code === 'EADDRINUSE') resolve(false)
            else if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code ?? '')) resolve(true)
            else reject(error)
          })
          server.listen({ host, port, exclusive: true, ipv6Only: host === '::1' }, () => {
            clearTimeout(timer)
            resolve(true)
          })
        })
        if (!free) return false
      }
    }
    return true
  } finally {
    await Promise.all(held.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  }
}
```

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/lane-allocation.test.js`

Expected: PASS — 11 tests. This production command also requires Tasks 1–3; the planning proof ran the same assertions through Vitest with only imports and the runner spelling adapted.

- [ ] **Step 5: Test registry restart, refusal and write-failure behavior**

Create `packages/server/test/lane-store.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Lane } from '@harnessdesk/protocol'
import { LaneStore } from '../src/goals/lanes.js'

const temporary = () => mkdtemp(join(tmpdir(), 'hd-lane-store-'))

const lane = (): Lane => ({
  id: 'a', goal: 'g1', seat: null, cwd: '', branch: '',
  ports: { start: 30000, end: 30019 }, browserProfile: null,
  state: 'reserved', createdAt: 1,
})

test('a restart preserves reserved ownership and readers cannot change the registry', async () => {
  const home = await temporary()
  try {
    const first = new LaneStore(home)
    await first.load()
    await first.save(lane())
    const next = new LaneStore(home)
    await next.load()
    assert.deepEqual(next.list(), [lane()])
    ;(next.list()[0]!.ports as { start: number }).start = 40000
    assert.equal(next.list()[0]!.ports.start, 30000)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a failed save neither updates memory nor rewrites the last durable registry', async () => {
  const home = await temporary()
  try {
    const first = new LaneStore(home)
    await first.load()
    await first.save(lane())
    const file = join(home, 'lanes', 'index.json')
    const before = await readFile(file, 'utf8')
    const next = new LaneStore(home, async () => { throw new Error('disk full') })
    await next.load()
    await assert.rejects(next.save({ ...lane(), state: 'retained' }), /disk full/)
    assert.equal(next.list()[0]!.state, 'reserved')
    assert.equal(await readFile(file, 'utf8'), before)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a damaged, future or overlapping registry is refused whole', async () => {
  const home = await temporary()
  try {
    await mkdir(join(home, 'lanes'))
    const file = join(home, 'lanes', 'index.json')
    for (const raw of [
      '{ broken',
      JSON.stringify({ version: 2, lanes: [] }),
      JSON.stringify({ version: 1, lanes: [{ ...lane(), ports: { start: 0, end: 20 } }] }),
      JSON.stringify({ version: 1, lanes: [lane(), { ...lane(), id: 'b' }] }),
    ]) {
      await writeFile(file, raw)
      const store = new LaneStore(home)
      await assert.rejects(store.load())
      assert.throws(() => store.list(), /Read the lane registry/)
      assert.equal(await readFile(file, 'utf8'), raw)
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a released interval may be reused without erasing its descriptor', async () => {
  const home = await temporary()
  try {
    const first = new LaneStore(home)
    await first.load()
    await first.save({ ...lane(), state: 'released' })
    await first.save({ ...lane(), id: 'b' })
    const next = new LaneStore(home)
    await next.load()
    assert.equal(next.list().length, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
```

Create `packages/server/test/lane-recovery.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LaneAllocator } from '../src/goals/lanes.js'
import type { Lane } from '@harnessdesk/protocol'

function rig(state: Lane['state'] = 'reserved') {
  let rows: Lane[] = [{ id: 'a', goal: 'g', seat: null, cwd: '', branch: '', ports: { start: 30000, end: 30019 },
    browserProfile: 'lane-a', state, createdAt: 1 }]
  const allocator = new LaneAllocator({
    list: () => structuredClone(rows),
    save: async lane => { rows = rows.map(row => row.id === lane.id ? structuredClone(lane) : row) },
    available: async () => true,
    create: async () => { throw new Error('recovery must not create') },
    locate: async () => ({ cwd: '/work/lane-a', branch: 'harnessdesk/lane-a' }),
    active: () => false, busy: () => false,
  })
  return { allocator, read: () => rows[0]! }
}
const seat = (id = 's', restored?: unknown) => ({ id, board: 'g', closed: null, checkout: { cwd: '/work/lane-a' }, ...(restored ? { restored } : {}) })
test('restart finds the actual checkout and binds the unique kept Seat without creating work', async () => {
  const { allocator, read } = rig()
  await allocator.recover([seat()])
  assert.equal(read().cwd, '/work/lane-a')
  assert.equal(read().seat, 's')
  assert.equal(read().state, 'active')
})
test('a restored opening cannot reactivate a reservation and released descriptors stay released', async () => {
  const { allocator, read } = rig()
  await allocator.recover([seat('history', { at: 1 })])
  assert.equal(read().seat, null)
  assert.equal(read().state, 'retained')
  const released = rig('released')
  await released.allocator.recover([seat()])
  assert.equal(released.read().state, 'released')
  assert.equal(released.read().cwd, '')
})
test('two matching kept Seats refuse dispatch instead of choosing a new owner', async () => {
  const { allocator, read } = rig()
  await assert.rejects(allocator.recover([seat('a'), seat('b')]), /conflicting Seat/)
  assert.equal(read().state, 'reserved')
  assert.equal(read().seat, null)
})
```

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/lane-store.test.js packages/server/dist/test/lane-recovery.test.js`

Expected: PASS — 7 tests, 4 registry and 3 recovery. A retained or reserved row survives a restart as ownership, and a failed write cannot change the in-memory result.

For the registry write-failure proof, temporarily move `this.#lanes = next` before the awaited `this.write` in `LaneStore.save`.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/lane-store.test.js`

Expected: FAIL — 1 failed, 3 passed. The failed-save test reads `retained` instead of the last durable `reserved` state. Restore the original ordering.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/lane-store.test.js`

Expected: PASS — 4 tests. This red/green pair was observed in the planning copy.

For recovery, temporarily remove `!seat.restored &&` from the matching-Seat filter in `LaneAllocator.recover`.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/lane-recovery.test.js`

Expected: FAIL — 1 failed, 2 passed. A restored opening is incorrectly bound as `history` where the test requires `null`. Restore the restored-history guard.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/lane-recovery.test.js`

Expected: PASS — 3 tests. This red/green pair was observed in the planning copy.

- [ ] **Step 6: Declare, validate, then handle the three lane verbs**

In `packages/protocol/src/wire.ts`, replace this exact anchor:

```ts
export interface HostMethods {
```

with:

```ts
export interface HostMethods {
  'lane/preferences': {
    params: Record<string, never>
    result: import('./goal.js').LanePreferences
  }
  'lane/preferences/set': {
    params: import('./goal.js').LanePreferences
    result: import('./goal.js').LanePreferences
  }
  'lane/release': {
    params: { lane: string }
    result: import('./goal.js').Lane
  }
```

In `packages/protocol/src/wire-validators.ts`, replace this exact anchor:

```ts
import type { ApprovalDecision } from './approval.js'
```

with:

```ts
import type { ApprovalDecision } from './approval.js'
import { lanePreferences } from './goal.js'
```

In `packages/protocol/src/wire-validators.ts`, replace this exact anchor:

```ts
const paramsValidators: Record<HostMethodName, Validator<unknown>> = {
```

with:

```ts
const paramsValidators: Record<HostMethodName, Validator<unknown>> = {
  'lane/preferences': goalShape({}),
  'lane/preferences/set': (value, path = '') => {
    try {
      return lanePreferences(value)
    } catch (error) {
      throw new ValidationError(path, error instanceof Error ? error.message : String(error))
    }
  },
  'lane/release': goalShape({ lane: goalIdentifier }),
```

The entries are written directly in `paramsValidators`, so `check-reachable.mjs` sees their actual method names. They precede Task 3’s existing `...goalValidators` spread.

In `packages/server/src/state.ts`, replace this exact anchor:

```ts
export interface AppState {
```

with:

```ts
import { lanePreferences } from '@harnessdesk/protocol'

export interface AppState {
```

In `packages/server/src/state.ts`, replace this exact anchor:

```ts
  async setPreferences(patch: Record<string, unknown>): Promise<void> {
    this.#state = { ...this.#state, preferences: { ...this.#state.preferences, ...patch } }
    await this.#persist()
  }
```

with:

```ts
  async setPreferences(patch: Record<string, unknown>): Promise<void> {
    const checked = Object.hasOwn(patch, 'lanes')
      ? { ...patch, lanes: lanePreferences(patch['lanes']) }
      : patch
    this.#state = { ...this.#state, preferences: { ...this.#state.preferences, ...checked } }
    await this.#persist()
  }
```

This gate covers both `lane/preferences/set` and `app/state/set`, including backup callers. Loading keeps a malformed stored value unchanged; reading the lane settings refuses it so Task 9 can show Reset to defaults.

In `packages/server/src/methods/context.ts`, replace this exact anchor:

```ts
  readonly flows: Flows
```

with:

```ts
  readonly flows: Flows
  readonly lanes: import('../goals/lanes.js').LaneAllocator
  readonly laneSettings: {
    read(): import('@harnessdesk/protocol').LanePreferences
    set(value: import('@harnessdesk/protocol').LanePreferences): Promise<import('@harnessdesk/protocol').LanePreferences>
  }
```

Create `packages/server/src/methods/lanes.ts` with these complete contents:

```ts
import type { MethodsUnder } from './context.js'

/** Person-only wire verbs. There is no plugin capability that calls these. */
export const laneMethods = {
  'lane/preferences': (ctx) => ctx.laneSettings.read(),
  'lane/preferences/set': (ctx, params) => ctx.laneSettings.set(params),
  'lane/release': (ctx, params) => ctx.goals.serial.run(() => ctx.lanes.release(params.lane)),
} satisfies MethodsUnder<'lane/'>
```

In `packages/server/src/methods/index.ts`, replace this exact anchor:

```ts
import { flowMethods } from './flows.js'
```

with:

```ts
import { flowMethods } from './flows.js'
import { laneMethods } from './lanes.js'
```

In `packages/server/src/methods/index.ts`, replace this exact anchor:

```ts
  ...flowMethods,
```

with:

```ts
  ...flowMethods,
  ...laneMethods,
```

In `packages/server/src/methods/index.ts`, replace this exact anchor:

```ts
  flowMethods,
```

with:

```ts
  flowMethods,
  laneMethods,
```

In `script/check-reachable.mjs`, replace this exact anchor:

```ts
const UNREACHED = {
```

with:

```ts
const UNREACHED = {
  'lane/preferences': 'Workspaces Lanes is connected by Goal Task 9',
  'lane/preferences/set': 'Workspaces Lanes is connected by Goal Task 9',
  'lane/release': 'the retained-lane action is connected by Goal Task 9',
```

- [ ] **Step 7: Connect one registry and allocator to Host and GoalPlane**

The callbacks below resolve the Task 3 `HostContext.goals` and phase 4 `HostContext.evidence` contracts at call time. They do not create another membership list. Task 3 must construct those contexts before `start`; its unfinished construction is a prerequisite defect, not an invitation to build a second GoalPlane here.

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
import { StateStore } from './state.js'
```

with:

```ts
import { StateStore } from './state.js'
import { DEFAULT_LANE_PREFERENCES, lanePreferences } from '@harnessdesk/protocol'
import { LaneAllocator, LaneStore, availablePorts } from './goals/lanes.js'
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
  readonly #worktrees: Worktrees
```

with:

```ts
  readonly #worktrees: Worktrees
  readonly #laneStore: LaneStore
  readonly #lanes: LaneAllocator
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
    this.#worktrees = new Worktrees(this.#state.directory)
```

with:

```ts
    this.#worktrees = new Worktrees(this.#state.directory)
    this.#laneStore = new LaneStore(this.#state.directory)
    this.#lanes = new LaneAllocator({
      list: () => this.#laneStore.list(),
      save: (lane) => this.#laneStore.save(lane),
      available: availablePorts,
      create: async (id, goal) => {
        const document = this.#context.goals.store.read(goal)
        const checkout = await this.#worktrees.create(document.goal.cwd, { name: `lane-${id}` })
        if (!checkout.branch) throw new Error('The lane checkout has no branch. Its reservation was kept.')
        return { cwd: checkout.path, branch: checkout.branch }
      },
      locate: async (lane) => {
        const document = this.#context.goals.store.read(lane.goal)
        const matches = (await this.#worktrees.list(document.goal.cwd))
          .filter((checkout) => checkout.branch === `harnessdesk/lane-${lane.id}`)
        if (matches.length !== 1 || !matches[0]?.branch) return null
        return { cwd: matches[0].path, branch: matches[0].branch }
      },
      active: (lane) => this.#context.evidence.seats.all().some((seat) =>
        !seat.closed && !seat.restored && (seat.id === lane.seat ||
          seat.board === lane.goal && lane.cwd !== '' && seat.checkout.cwd === lane.cwd)),
      busy: (lane) => this.registry.all().some((record) =>
        record.session.cwd === lane.cwd && this.#queueBusy(record)),
    })
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
    await this.#state.load()
```

with:

```ts
    await this.#state.load()
    await this.#laneStore.load()
    this.#context.goals.attachLanes(this.#lanes)
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
      worktrees: this.#worktrees,
```

with:

```ts
      worktrees: this.#worktrees,
      lanes: this.#lanes,
      laneSettings: {
        read: () => lanePreferences(this.#state.state.preferences['lanes'] ?? DEFAULT_LANE_PREFERENCES),
        set: async (value) => {
          const checked = lanePreferences(value)
          await this.#state.setPreferences({ lanes: checked })
          return checked
        },
      },
```

Do not default a present null preference: replace the read expression’s `??` with an explicit absence test as shown below. A corrupt present value needs the Reset action.

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
        read: () => lanePreferences(this.#state.state.preferences['lanes'] ?? DEFAULT_LANE_PREFERENCES),
```

with:

```ts
        read: () => lanePreferences(Object.hasOwn(this.#state.state.preferences, 'lanes')
          ? this.#state.state.preferences['lanes']
          : DEFAULT_LANE_PREFERENCES),
```

In `packages/server/src/goals/plane.ts`, replace this exact anchor:

```ts
import { Assignments, Serial } from './assignments.js'
```

with:

```ts
import { Assignments, Serial } from './assignments.js'
import type { LaneAllocator } from './lanes.js'
```

In `packages/server/src/goals/plane.ts`, replace this exact anchor:

```ts
  readonly #assignments: Assignments
```

with:

```ts
  readonly #assignments: Assignments
  #lanes: LaneAllocator | null = null

  attachLanes(lanes: LaneAllocator): void {
    if (this.#lanes && this.#lanes !== lanes) throw new Error('This Goal plane already has its lane allocator.')
    this.#lanes = lanes
  }

  laneFor(seat: SeatId): import('@harnessdesk/protocol').Lane | null {
    if (!this.#lanes) throw new Error('Read the lane registry before opening a Goal Seat.')
    return this.#lanes.forSeat(seat)
  }
```

In `packages/server/src/goals/plane.ts`, replace this exact anchor:

```ts
      for (const document of this.store.list()) {
        if (!document.restored && document.operation) await recoverOperation(document.operation, this.port)
      }
```

with:

```ts
      for (const document of this.store.list()) {
        if (!document.restored && document.operation) await recoverOperation(document.operation, this.port)
      }
      if (this.#lanes) await this.#lanes.recover(this.port.seats.all())
```

The immutable descriptor is the allocation journal: `id`, `goal`, `ports` and the host-derived requested worktree name `lane-${id}` are durable before `Worktrees.create`. A return records the actual path and branch. Recovery only accepts a unique exact branch match; an ambiguous or unreadable checkout remains a retained reservation with its ports held. No branch is removed, no PID is signalled, and a released descriptor is never reactivated. Task 5 uses the preselected opening id and binds after the durable Seat write; restart recovery fills a missing binding only from the unique kept Seat with the same Goal and actual checkout.

- [ ] **Step 8: Test preferences through parseClientMessage and Host.call**

Create `packages/server/test/lane-preferences.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { DEFAULT_LANE_PREFERENCES, parseClientMessage, ValidationError } from '@harnessdesk/protocol'

import { Host } from '../src/host.js'
import { Logger } from '../src/log.js'
import { StateStore } from '../src/state.js'
import { tempDir } from './scratch.js'

const rig = async () => {
  const state = new StateStore(join(tempDir('hd-lane-preferences-'), 'state.json'))
  await state.load()
  const host = new Host({ state, logger: new Logger('lane-test', { level: 'error', console: false }) })
  return { state, host }
}

test('both preference verbs route through the real Host context', async () => {
  const { host } = await rig()
  assert.deepEqual(await host.call('lane/preferences', {}), DEFAULT_LANE_PREFERENCES)
  const asked = { start: 31000, width: 30, browserProfile: false }
  assert.deepEqual(await host.call('lane/preferences/set', asked), asked)
  assert.deepEqual(await host.call('lane/preferences', {}), asked)
})

test('generic app preference writes cannot bypass lane validation', async () => {
  const { state, host } = await rig()
  await assert.rejects(host.call('app/state/set', { patch: { lanes: { start: 0 } } }), /starting port/)
  assert.equal(Object.hasOwn(state.state.preferences, 'lanes'), false)
  state.state.preferences['lanes'] = null
  await assert.rejects(host.call('lane/preferences', {}), /starting port/)
  await host.call('lane/preferences/set', DEFAULT_LANE_PREFERENCES)
  assert.deepEqual(await host.call('lane/preferences', {}), DEFAULT_LANE_PREFERENCES)
})

test('lane wire validation rejects unknown keys and malformed numbers before dispatch', () => {
  const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })
  for (const params of [null, {}, { ...DEFAULT_LANE_PREFERENCES, width: 0 },
    { ...DEFAULT_LANE_PREFERENCES, profileDir: '/work/other' }]) {
    assert.throws(() => request('lane/preferences/set', params), ValidationError)
  }
  assert.throws(() => request('lane/preferences', { root: '/work/repo' }), ValidationError)
  assert.throws(() => request('lane/release', { lane: 'a', force: true }), ValidationError)
  assert.doesNotThrow(() => request('lane/preferences/set', DEFAULT_LANE_PREFERENCES))
})
```

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/lane-preferences.test.js`

Expected: PASS — 3 tests. These exercise the real Host method table, not a hand-written replacement for it. The planning writer did not execute this production boundary because the preceding phase/Task 3 implementations are absent from this checkout.

- [ ] **Step 9: Prove separate servers and occupied-port skipping on the real socket boundary**

Create `packages/server/test/lane-listeners.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { Lane } from '@harnessdesk/protocol'

import { LaneAllocator, LaneStore, availablePorts, laneEnvironment } from '../src/goals/lanes.js'
import { Worktrees } from '../src/worktree.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

const fixture = String.raw`
import http from 'node:http'
const server = http.createServer((_request, response) => response.end(JSON.stringify({
  lane: process.env.HARNESSDESK_LANE_ID,
  port: process.env.PORT,
  cwd: process.cwd(),
})))
server.listen(Number(process.env.PORT), '127.0.0.1', () => process.stdout.write('ready\n'))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`

async function childFor(t: TestContext, path: string, lane: Lane): Promise<ChildProcess> {
  const child = spawn(process.execPath, [path], {
    cwd: lane.cwd,
    env: { ...process.env, ...laneEnvironment(lane) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    child.kill('SIGTERM')
    try { await exited } finally { clearTimeout(timer) }
  })
  await new Promise<void>((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error('The lane server did not become ready.')), 5000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Lane server exited: ${code}`)) })
    child.stdout!.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      if (text.includes('ready\n')) { clearTimeout(timer); resolve() }
    })
  })
  return child
}

test('two projects run the same server concurrently from distinct managed checkouts', async (t) => {
  const left = await makeRepo('hd-lane-left-')
  const right = await makeRepo('hd-lane-right-')
  const home = tempDir('hd-lane-desk-')
  const file = join(home, 'server.mjs')
  await writeFile(file, fixture)
  const store = new LaneStore(home)
  await store.load()
  const worktrees = new Worktrees(home)
  const allocator = new LaneAllocator({
    list: () => store.list(), save: (lane) => store.save(lane), available: availablePorts,
    create: async (id, goal) => {
      const made = await worktrees.create(goal === 'g1' ? left.dir : right.dir, { name: `lane-${id}` })
      assert.ok(made.branch)
      return { cwd: made.path, branch: made.branch }
    },
    active: () => false, busy: () => false,
  })
  const prefs = { start: 30000, width: 2, browserProfile: true }
  const [a, b] = await Promise.all([
    allocator.allocate('g1', 'a', prefs), allocator.allocate('g2', 'b', prefs),
  ])
  await Promise.all([childFor(t, file, a), childFor(t, file, b)])
  const replies = await Promise.all([a, b].map(async (lane) => {
    const response = await fetch(`http://127.0.0.1:${lane.ports.start}`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    return response.json()
  }))
  assert.deepEqual(replies, [
    { lane: 'a', port: String(a.ports.start), cwd: a.cwd },
    { lane: 'b', port: String(b.ports.start), cwd: b.cwd },
  ])
  assert.notEqual(a.cwd, b.cwd)
  assert.ok(a.ports.end < b.ports.start || b.ports.end < a.ports.start)
  assert.equal(await availablePorts(a.ports, Date.now() + 5000), false)
})

test('an unrelated listener makes its entire block unavailable, then leaves no probe handles', async (t) => {
  const occupied = createServer()
  occupied.listen(0, '127.0.0.1')
  await once(occupied, 'listening')
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())))
  const address = occupied.address()
  assert.ok(address && typeof address !== 'string')
  const leases: Lane[] = []
  const allocator = new LaneAllocator({
    list: () => leases,
    save: async (lane) => {
      const index = leases.findIndex((one) => one.id === lane.id)
      if (index === -1) leases.push(lane)
      else leases[index] = lane
    },
    available: availablePorts,
    create: async () => ({ cwd: '/work/lane', branch: 'harnessdesk/lane' }),
    active: () => false, busy: () => false,
  })
  const lane = await allocator.allocate('g1', 'a', { start: address.port, width: 1, browserProfile: true })
  assert.ok(lane.ports.start > address.port)
  assert.equal(await availablePorts(lane.ports, Date.now() + 5000), true)
})
```

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/lane-listeners.test.js`

Expected: PASS — 2 tests with two HTTP replies and a skipped externally occupied interval. A listener refusal by the sandbox is not green. This command was not run by the planning writer. The test proves the allocator-to-worktree-to-child boundary; Task 5 separately tests Goal Seat routing and actual runtime child inheritance.

- [ ] **Step 10: Prove retained ownership is necessary**

Temporarily replace `lane.state !== 'released' && start <= lane.ports.end` in `firstBlock` with `lane.state !== 'released' && lane.state !== 'retained' && start <= lane.ports.end`. This changes only durable retained ownership; temporary rejected blocks remain reserved so scanning still terminates.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/lane-allocation.test.js`

Expected: FAIL — 1 failed, 10 passed. `retained reservations keep absolute intervals after preferences change` receives `{start:65501,end:65518}` where it requires `null`.

Restore the expression from Step 4.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/lane-allocation.test.js`

Expected: PASS — 11 tests. The planning copy observed this exact red and green pair.

- [ ] **Step 11: Commit the verified implementation**

Run: `pnpm verify`

Expected: Exit 0, unpiped, before the implementation commit. The plan writer does not run this listener-dependent gate or make this commit.

```bash
git add packages/protocol/src/goal.ts packages/protocol/src/wire.ts packages/protocol/src/wire-validators.ts packages/server/src/goals/lanes.ts packages/server/src/goals/plane.ts packages/server/src/methods/lanes.ts packages/server/src/methods/context.ts packages/server/src/methods/index.ts packages/server/src/host.ts packages/server/src/state.ts packages/server/test/lane-allocation.test.ts packages/server/test/lane-store.test.ts packages/server/test/lane-recovery.test.ts packages/server/test/lane-preferences.test.ts packages/server/test/lane-listeners.test.ts script/check-reachable.mjs
git commit -m "feat(goals): allocate durable lanes and machine port preferences" -m "Co-Authored-By: Codex <agent@harnessdesk.app>"
```

### Task 5: Deliver the lane environment to each session's actual child process

The six values are an immutable per-session input. A bridge that acknowledges them must put them into the actual child options and preserve them on re-arm. A runtime without that capability refuses isolation before the brief is sent. Neither adapter sets `process.env` and neither writes a repository configuration file.

**Files:**
- Create: `packages/protocol/src/lane-environment.ts`, `packages/server/src/goals/lane-environment.ts` and `src/lane-environment.ts` in `adapter-codex`, `adapter-acp`, `claude-acp`, `cursor-acp`.
- Modify: protocol `index.ts`, `session.ts`, `runtime.ts`; server `host.ts`, `goals/plane.ts`, `methods/context.ts`, `methods/sessions.ts`; adapter `runtime.ts` files and native `session.ts`; both bridge `bridge.ts` files.
- Tests: `lane-environment.test.ts` in protocol, server and each adapter/bridge; `packages/adapter-testkit/src/index.ts`; the native and both bridge fake CLI fixtures; `packages/server/test/fixtures/fake-runtime.ts`.
- Transport acknowledgement: `packages/transport-acp/src/index.ts`.
- Dependency correction: `packages/claude-acp/package.json`, `pnpm-lock.yaml` — move its existing protocol workspace dependency from development to runtime because the bridge now executes the shared validator.
- Named existing test edits: the adapter-testkit capability key list gains the new key; bridge fake initializers advertise the capability only where their child path applies it. Existing model, instruction, ceiling and retirement assertions remain.

**Proof needs:** neither. **Routing:** Codex. The automated proof uses scripted protocols and local children. Enabling native support for a release additionally requires the recorded real-runtime probe in Step 12; a fake cannot establish a vendor config key's behavior.

**Interfaces:** `SessionOptions.environment?: Readonly<Record<string,string>>`; required `RuntimeCapabilities.sessionEnvironment`, false by default; `laneEnvironmentOf(value:unknown)`; ACP initialization `_meta.harnessdesk.sessionEnvironment === true`, request/acknowledgement `_meta.harnessdesk.environment`. The adapter-local helpers below never cross their package boundary. The host forwards only `laneEnvironment(lane)`, never arbitrary public environment data.

- [ ] **Step 1: Write the complete tests at their production owners**

Create `packages/protocol/test/lane-environment.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { laneEnvironmentOf } from '../src/index.js'

const env = (start: number) => ({
  HARNESSDESK_GOAL_ID: 'g1',
  HARNESSDESK_LANE_ID: `lane-${start}`,
  HARNESSDESK_PORT_START: String(start),
  HARNESSDESK_PORT_END: String(start + 19),
  HARNESSDESK_PORT_COUNT: '20',
  PORT: String(start),
})

test('validation returns an independent frozen map of exactly six values', () => {
  const input = env(30000)
  const read = laneEnvironmentOf(input)
  input.PORT = '40000'
  assert.equal(read.PORT, '30000')
  assert.equal(Object.isFrozen(read), true)
  assert.equal(Object.keys(read).length, 6)
  assert.equal(laneEnvironmentOf({ ...env(30000), HARNESSDESK_GOAL_ID: '/' + 'a'.repeat(300) }).HARNESSDESK_GOAL_ID?.length, 301)
})

test('unknown keys, control characters, missing values and invalid blocks refuse', () => {
  for (const value of [
    null, [], {}, { ...env(30000), HOME: '/work/wrong' },
    { ...env(30000), HARNESSDESK_LANE_ID: 'a\u0000b' },
    { ...env(30000), HARNESSDESK_GOAL_ID: '' },
    { ...env(30000), HARNESSDESK_PORT_START: '030000' },
    { ...env(30000), HARNESSDESK_PORT_END: '3e4' },
    { ...env(30000), HARNESSDESK_PORT_COUNT: '21' },
    { ...env(30000), PORT: '30001' },
    { ...env(65520) },
    { ...env(1024), HARNESSDESK_PORT_END: '2024', HARNESSDESK_PORT_COUNT: '1001' },
  ]) assert.throws(() => laneEnvironmentOf(value), /lane environment|lane port block/)
})
```

Create `packages/adapter-codex/test/lane-environment.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codexEnvironmentConfig } from '../src/lane-environment.js'

const env = (start: number) => ({
  HARNESSDESK_GOAL_ID: 'g1',
  HARNESSDESK_LANE_ID: `lane-${start}`,
  HARNESSDESK_PORT_START: String(start),
  HARNESSDESK_PORT_END: String(start + 19),
  HARNESSDESK_PORT_COUNT: '20',
  PORT: String(start),
})

test('native configuration preserves model-route and sandbox fields', () => {
  const config = { 'model_providers.test.name': 'Fixture', sandbox_mode: 'workspace-write' }
  const result = codexEnvironmentConfig(config, env(30000))
  assert.deepEqual(result, { ...config, 'shell_environment_policy.set': env(30000) })
  assert.deepEqual(config, { 'model_providers.test.name': 'Fixture', sandbox_mode: 'workspace-write' })
})
```

Create `packages/adapter-acp/test/lane-environment.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { environmentMeta, acknowledgeEnvironment } from '../src/lane-environment.js'

const env = (start: number) => ({
  HARNESSDESK_GOAL_ID: 'g1',
  HARNESSDESK_LANE_ID: `lane-${start}`,
  HARNESSDESK_PORT_START: String(start),
  HARNESSDESK_PORT_END: String(start + 19),
  HARNESSDESK_PORT_COUNT: '20',
  PORT: String(start),
})

test('ACP refuses unsupported environments and preserves instructions and initial options', () => {
  const meta = { harnessdesk: { instructions: 'Read carefully.', options: { mode: 'safe' } }, vendor: { flag: true } }
  assert.throws(() => environmentMeta(meta, env(30000), false), /cannot pass a lane environment/)
  assert.deepEqual(environmentMeta(meta, env(30000), true), {
    ...meta,
    harnessdesk: { ...meta.harnessdesk, environment: env(30000) },
  })
  assert.equal(Object.hasOwn(meta.harnessdesk, 'environment'), false)
})

test('an exact acknowledgement is required, independent of key order', () => {
  assert.throws(() => acknowledgeEnvironment({}, env(30000)), /did not acknowledge/)
  assert.throws(() => acknowledgeEnvironment({ harnessdesk: { environment: env(30020) } }, env(30000)), /did not acknowledge/)
  const shuffled = Object.fromEntries(Object.entries(env(30000)).reverse())
  assert.doesNotThrow(() => acknowledgeEnvironment({ harnessdesk: { environment: shuffled } }, env(30000)))
})
```

Create `packages/claude-acp/test/lane-environment.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { childEnvironment, environmentIn, environmentAck } from '../src/lane-environment.js'

const env = (start: number) => ({
  HARNESSDESK_GOAL_ID: 'g1',
  HARNESSDESK_LANE_ID: `lane-${start}`,
  HARNESSDESK_PORT_START: String(start),
  HARNESSDESK_PORT_END: String(start + 19),
  HARNESSDESK_PORT_COUNT: '20',
  PORT: String(start),
})

test('bridges parse only the negotiated slot and echo it without erasing other response metadata', () => {
  assert.equal(environmentIn({ environment: env(30000) }), undefined)
  assert.deepEqual(environmentIn({ harnessdesk: { environment: env(30000) } }), env(30000))
  assert.throws(() => environmentIn({ harnessdesk: { environment: { PORT: '30000' } } }), /incomplete/)
  assert.deepEqual(environmentAck({ _meta: { vendor: true, harnessdesk: { options: 'kept' } } }, env(30000)), {
    _meta: { vendor: true, harnessdesk: { options: 'kept', environment: env(30000) } },
  })
})

test('two real children inherit separate lane values without changing the parent', async () => {
  const before = { ...process.env }
  const run = promisify(execFile)
  const results = await Promise.all([30000, 30020].map(async (port) => {
    const { stdout } = await run(process.execPath, ['-e',
      'process.stdout.write(JSON.stringify([process.env.PORT, process.env.HARNESSDESK_PORT_END, process.env.KEPT]))',
    ], { env: childEnvironment({ ...process.env, KEPT: 'present' }, env(port)), timeout: 5000 })
    return JSON.parse(stdout)
  }))
  assert.deepEqual(results, [['30000', '30019', 'present'], ['30020', '30039', 'present']])
  assert.ok(Object.keys(process.env).length === Object.keys(before).length &&
    Object.entries(before).every(([key, value]) => process.env[key] === value),
  'the parent environment is unchanged')
})

test('plain sessions keep the base environment and gain no lane values', () => {
  const base = { PATH: '/work/bin', PORT: '9000' }
  assert.deepEqual(childEnvironment(base), base)
  assert.notEqual(childEnvironment(base), base)
  assert.deepEqual(environmentAck({ sessionId: 'plain' }, undefined), { sessionId: 'plain' })
})
```

Create `packages/cursor-acp/test/lane-environment.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { childEnvironment, environmentIn, environmentAck } from '../src/lane-environment.js'

const env = (start: number) => ({
  HARNESSDESK_GOAL_ID: 'g1',
  HARNESSDESK_LANE_ID: `lane-${start}`,
  HARNESSDESK_PORT_START: String(start),
  HARNESSDESK_PORT_END: String(start + 19),
  HARNESSDESK_PORT_COUNT: '20',
  PORT: String(start),
})

test('bridges parse only the negotiated slot and echo it without erasing other response metadata', () => {
  assert.equal(environmentIn({ environment: env(30000) }), undefined)
  assert.deepEqual(environmentIn({ harnessdesk: { environment: env(30000) } }), env(30000))
  assert.throws(() => environmentIn({ harnessdesk: { environment: { PORT: '30000' } } }), /incomplete/)
  assert.deepEqual(environmentAck({ _meta: { vendor: true, harnessdesk: { options: 'kept' } } }, env(30000)), {
    _meta: { vendor: true, harnessdesk: { options: 'kept', environment: env(30000) } },
  })
})

test('two real children inherit separate lane values without changing the parent', async () => {
  const before = { ...process.env }
  const run = promisify(execFile)
  const results = await Promise.all([30000, 30020].map(async (port) => {
    const { stdout } = await run(process.execPath, ['-e',
      'process.stdout.write(JSON.stringify([process.env.PORT, process.env.HARNESSDESK_PORT_END, process.env.KEPT]))',
    ], { env: childEnvironment({ ...process.env, KEPT: 'present' }, env(port)), timeout: 5000 })
    return JSON.parse(stdout)
  }))
  assert.deepEqual(results, [['30000', '30019', 'present'], ['30020', '30039', 'present']])
  assert.ok(Object.keys(process.env).length === Object.keys(before).length &&
    Object.entries(before).every(([key, value]) => process.env[key] === value),
  'the parent environment is unchanged')
})

test('plain sessions keep the base environment and gain no lane values', () => {
  const base = { PATH: '/work/bin', PORT: '9000' }
  assert.deepEqual(childEnvironment(base), base)
  assert.notEqual(childEnvironment(base), base)
  assert.deepEqual(environmentAck({ sessionId: 'plain' }, undefined), { sessionId: 'plain' })
})
```

The subprocess assertion compares the parent environment as a boolean, so a failed assertion cannot print unrelated environment values. Only the three synthetic child values are reported.

- [ ] **Step 2: Observe the absent helper red**

Run: `pnpm run build:node`

Expected: FAIL — `Cannot find module '../src/lane-environment.js'` and missing `laneEnvironmentOf`. In the planning copy, Vitest first failed with `Cannot find module './environment-protocol.js'`.

- [ ] **Step 3: Add the shared validation and capability contract**

Create `packages/protocol/src/lane-environment.ts` with these complete contents:

```ts
const KEYS = [
  'HARNESSDESK_GOAL_ID',
  'HARNESSDESK_LANE_ID',
  'HARNESSDESK_PORT_START',
  'HARNESSDESK_PORT_END',
  'HARNESSDESK_PORT_COUNT',
  'PORT',
] as const

/** Only host-minted lane variables cross this seam; it is not a general environment API. */
export function laneEnvironmentOf(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The lane environment is incomplete.')
  }
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== KEYS.length || KEYS.some((key) => {
    const text = input[key]
    return typeof text !== 'string' || text.length === 0 || /[\u0000-\u001f\u007f]/.test(text) ||
      text.length > (key === 'HARNESSDESK_GOAL_ID' ? 4096 : 200)
  })) throw new Error('The lane environment is incomplete.')
  const start = Number(input.HARNESSDESK_PORT_START)
  const end = Number(input.HARNESSDESK_PORT_END)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 1024 || end > 65535 || end < start || end - start + 1 > 1000 ||
      input.HARNESSDESK_PORT_START !== String(start) || input.HARNESSDESK_PORT_END !== String(end) ||
      input.HARNESSDESK_PORT_COUNT !== String(end - start + 1) || input.PORT !== String(start)) {
    throw new Error('The lane port block is invalid.')
  }
  return Object.freeze(Object.fromEntries(KEYS.map((key) => [key, input[key] as string])))
}
```

In `packages/protocol/src/index.ts`, replace this exact anchor:

```ts
export * from './session.js'
```

with:

```ts
export * from './session.js'
export * from './lane-environment.js'
```

In `packages/protocol/src/session.ts`, replace this exact anchor:

```ts
export type SessionOptions = Partial<SessionSettings> & {
  readonly cwd: string
```

with:

```ts
export type SessionOptions = Partial<SessionSettings> & {
  readonly cwd: string
  /** Host-minted lane variables, applied to this session's child process only. */
  readonly environment?: Readonly<Record<string, string>>
```

In `packages/protocol/src/runtime.ts`, replace this exact anchor:

```ts
export interface RuntimeCapabilities {
```

with:

```ts
export interface RuntimeCapabilities {
  /** Negotiated per-session child environment, acknowledged before seating. */
  readonly sessionEnvironment: boolean
```

In `packages/protocol/src/runtime.ts`, replace this exact anchor:

```ts
export const NO_CAPABILITIES: RuntimeCapabilities = {
```

with:

```ts
export const NO_CAPABILITIES: RuntimeCapabilities = {
  sessionEnvironment: false,
```

- [ ] **Step 4: Add each adapter's own mapper and each bridge's child helper**

Create `packages/adapter-codex/src/lane-environment.ts` with these complete contents:

```ts
import { laneEnvironmentOf } from '@harnessdesk/protocol'

import type { CodexProtocol } from '@harnessdesk/codex'

type Config = NonNullable<CodexProtocol.v2.ThreadStartParams['config']>

export function codexEnvironmentConfig(
  config: Config,
  environment: Readonly<Record<string, string>>,
): Config {
  return { ...config, 'shell_environment_policy.set': { ...laneEnvironmentOf(environment) } }
}
```

Create `packages/adapter-acp/src/lane-environment.ts` with these complete contents:

```ts
import { laneEnvironmentOf } from '@harnessdesk/protocol'

const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function environmentSupported(meta: unknown): boolean {
  return object(object(meta).harnessdesk).sessionEnvironment === true
}

export function environmentMeta(
  meta: Record<string, unknown>,
  environment: Readonly<Record<string, string>>,
  supported: boolean,
): Record<string, unknown> {
  if (!supported) {
    throw new Error('This runtime cannot pass a lane environment to a session. Choose a runtime with lane support, or turn isolation off.')
  }
  return { ...meta, harnessdesk: { ...object(meta.harnessdesk), environment: laneEnvironmentOf(environment) } }
}

export function acknowledgeEnvironment(meta: unknown, requested: Readonly<Record<string, string>>): void {
  let received: Readonly<Record<string, string>>
  try {
    received = laneEnvironmentOf(object(object(meta).harnessdesk).environment)
  } catch {
    throw new Error('This runtime did not acknowledge the lane environment. Choose a runtime with lane support, or turn isolation off.')
  }
  const expected = laneEnvironmentOf(requested)
  if (Object.keys(expected).some((key) => expected[key] !== received[key])) {
    throw new Error('This runtime did not acknowledge the lane environment. Choose a runtime with lane support, or turn isolation off.')
  }
}
```

Create `packages/claude-acp/src/lane-environment.ts` with these complete contents:

```ts
import { laneEnvironmentOf } from '@harnessdesk/protocol'

const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function environmentIn(meta: unknown): Readonly<Record<string, string>> | undefined {
  const ours = object(object(meta).harnessdesk)
  return Object.hasOwn(ours, 'environment') ? laneEnvironmentOf(ours.environment) : undefined
}

export function childEnvironment(
  base: NodeJS.ProcessEnv,
  environment?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return { ...base, ...(environment === undefined ? {} : laneEnvironmentOf(environment)) }
}

export function environmentAck<T extends object>(
  response: T,
  environment: Readonly<Record<string, string>> | undefined,
): T & { _meta?: Record<string, unknown> } {
  if (environment === undefined) return response
  const meta = object((response as { _meta?: unknown })._meta)
  return {
    ...response,
    _meta: { ...meta, harnessdesk: { ...object(meta.harnessdesk), environment: laneEnvironmentOf(environment) } },
  }
}
```

Create `packages/cursor-acp/src/lane-environment.ts` with these complete contents:

```ts
import { laneEnvironmentOf } from '@harnessdesk/protocol'

const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function environmentIn(meta: unknown): Readonly<Record<string, string>> | undefined {
  const ours = object(object(meta).harnessdesk)
  return Object.hasOwn(ours, 'environment') ? laneEnvironmentOf(ours.environment) : undefined
}

export function childEnvironment(
  base: NodeJS.ProcessEnv,
  environment?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return { ...base, ...(environment === undefined ? {} : laneEnvironmentOf(environment)) }
}

export function environmentAck<T extends object>(
  response: T,
  environment: Readonly<Record<string, string>> | undefined,
): T & { _meta?: Record<string, unknown> } {
  if (environment === undefined) return response
  const meta = object((response as { _meta?: unknown })._meta)
  return {
    ...response,
    _meta: { ...meta, harnessdesk: { ...object(meta.harnessdesk), environment: laneEnvironmentOf(environment) } },
  }
}
```

In `packages/claude-acp/package.json`, replace this exact anchor:

```ts
  "dependencies": {
```

with:

```ts
  "dependencies": {
    "@harnessdesk/protocol": "workspace:*",
```

In `packages/claude-acp/package.json`, replace this exact anchor:

```ts
    "@harnessdesk/adapter-testkit": "workspace:*",
    "@harnessdesk/protocol": "workspace:*"
```

with:

```ts
    "@harnessdesk/adapter-testkit": "workspace:*"
```

Run: `pnpm install --lockfile-only --offline`

Expected: Exit 0; the `packages/claude-acp` importer moves the already-present protocol link into `dependencies`, with no new external package. Review that generated lockfile diff before staging it.

- [ ] **Step 5: Apply native overrides on start, resume, fork and the review side thread**

The exact replacements below are adapter-local. The generated protocol remains untouched, and `Config` is its actual JSON-valued per-thread type. Route configuration is assembled first; the lane map is merged after it.

In `packages/adapter-codex/src/runtime.ts`, replace this exact block:

```ts
]

const CAPABILITIES = {
  resume: true,
  fork: true,
  steer: true,
```

with:

```ts
]

const CAPABILITIES = {
  sessionEnvironment: false,
  resume: true,
  fork: true,
  steer: true,
```

In `packages/adapter-codex/src/runtime.ts`, replace this exact block:

```ts
  /** The shell sessions a thread has left running; see `RuntimeTasks`. */
  readonly tasks: CodexTasks
  readonly #sessions = new Map<string, CodexSession>()
  /** Codex's inline reviews, made to open and close their turns; see `ReviewTurns`. */
  readonly #reviewTurns = new ReviewTurns()
  readonly #eventListeners = new Set<(event: AgentEvent) => void>()
```

with:

```ts
  /** The shell sessions a thread has left running; see `RuntimeTasks`. */
  readonly tasks: CodexTasks
  readonly #sessions = new Map<string, CodexSession>()
  readonly #environments = new Map<string, Readonly<Record<string, string>>>()
  /** Codex's inline reviews, made to open and close their turns; see `ReviewTurns`. */
  readonly #reviewTurns = new ReviewTurns()
  readonly #eventListeners = new Set<(event: AgentEvent) => void>()
```

In `packages/adapter-codex/src/runtime.ts`, replace this exact block:

```ts
    const session = await this.#register(response.thread, stateFromStartResponse(response), projection, {
      created: true,
      route: options.route ?? null,
    })
    return this.#applyAfterStart(session, after)
  }
```

with:

```ts
    const session = await this.#register(response.thread, stateFromStartResponse(response), projection, {
      created: true,
      route: options.route ?? null,
      environment: options.environment,
    })
    return this.#applyAfterStart(session, after)
  }
```

In `packages/adapter-codex/src/runtime.ts`, replace this exact block:

```ts
   * conversation's would.
   */
  async #startBeside(like: CodexSession): Promise<CodexSession> {
    const { start, route, sandbox, after } = like.startLike()
    const projection = new ToolProjection()
    const dynamicTools = this.#projectTools(projection, { workspaceRoot: start.cwd })
    const routed = route ? routeParams(route) : null
    const response = await this.#server.request('thread/start', {
      ...start,
      ...(routed ? { modelProvider: routed.modelProvider } : {}),
      ...(start.config || routed ? { config: { ...start.config, ...routed?.config } } : {}),
      ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
      ...this.#developerInstructions(),
    })
    const session = await this.#register(response.thread, stateFromStartResponse(response), projection, {
      created: true,
      route,
    })
    try {
      if (sandbox) await session.setSandbox(sandbox)
```

with:

```ts
   * conversation's would.
   */
  async #startBeside(like: CodexSession): Promise<CodexSession> {
    const { start, route, sandbox, after, environment } = like.startLike()
    const projection = new ToolProjection()
    const dynamicTools = this.#projectTools(projection, { workspaceRoot: start.cwd })
    const routed = route ? routeParams(route) : null
    const response = await this.#server.request('thread/start', {
      ...start,
      ...(routed ? { modelProvider: routed.modelProvider } : {}),
      ...(start.config || routed || environment ? { config: environment
        ? codexEnvironmentConfig({ ...start.config, ...routed?.config }, environment)
        : { ...start.config, ...routed?.config } } : {}),
      ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
      ...this.#developerInstructions(),
    })
    const session = await this.#register(response.thread, stateFromStartResponse(response), projection, {
      created: true,
      route,
      environment,
    })
    try {
      if (sandbox) await session.setSandbox(sandbox)
```

In `packages/adapter-codex/src/runtime.ts`, replace this exact block:

```ts
  }

  async resumeSession(id: SessionId, options: Partial<SessionOptions> = {}): Promise<AgentSession> {
    const existing = this.#sessions.get(id)
    if (existing) return existing
    const { start, after } = startParamsFor(options)
```

with:

```ts
  }

  async resumeSession(id: SessionId, options: Partial<SessionOptions> = {}): Promise<AgentSession> {
    const held = this.#environments.get(id)
    if (held && options.environment && JSON.stringify(held) !== JSON.stringify(laneEnvironmentOf(options.environment))) {
      throw new Error('A live session cannot change its lane environment.')
    }
    if (options.environment && this.#sessions.has(id) && !held) throw new Error('An already-open session cannot acquire a lane environment.')
    if (held && !options.environment) options = { ...options, environment: held }
    const existing = this.#sessions.get(id)
    if (existing) return existing
    const { start, after } = startParamsFor(options)
```

In `packages/adapter-codex/src/runtime.ts`, replace this exact block:

```ts
    // rather than pretending newly loaded plugins are available.
    const session = await this.#register(response.thread, stateFromStartResponse(response), new ToolProjection(), {
      route: options.route ?? null,
    })
    return this.#applyAfterStart(session, after)
  }
```

with:

```ts
    // rather than pretending newly loaded plugins are available.
    const session = await this.#register(response.thread, stateFromStartResponse(response), new ToolProjection(), {
      route: options.route ?? null,
      environment: options.environment,
    })
    return this.#applyAfterStart(session, after)
  }
```

In `packages/adapter-codex/src/runtime.ts`, replace this exact block:

```ts
   * are answered with a deprecationNotice.
   */
  async forkSession(id: SessionId, options: Partial<SessionOptions> = {}): Promise<AgentSession> {
    const { start, after } = startParamsFor(options)
    const response = await this.#server.request('thread/fork', {
      threadId: id,
```

with:

```ts
   * are answered with a deprecationNotice.
   */
  async forkSession(id: SessionId, options: Partial<SessionOptions> = {}): Promise<AgentSession> {
    const environment = options.environment ?? this.#environments.get(id)
    if (environment) options = { ...options, environment }
    const { start, after } = startParamsFor(options)
    const response = await this.#server.request('thread/fork', {
      threadId: id,
```

In `packages/adapter-codex/src/runtime.ts`, replace this exact block:

```ts
      { ...response.thread, turns: await this.#forkedHistory(response.thread) },
      stateFromStartResponse(response),
      new ToolProjection(),
      { route: options.route ?? null },
    )
    return this.#applyAfterStart(session, after)
  }
```

with:

```ts
      { ...response.thread, turns: await this.#forkedHistory(response.thread) },
      stateFromStartResponse(response),
      new ToolProjection(),
      { route: options.route ?? null, environment: options.environment },
    )
    return this.#applyAfterStart(session, after)
  }
```

In `packages/adapter-codex/src/runtime.ts`, replace this exact block:

```ts
      readonly created?: boolean
      /** The model route it was opened on, which a thread set up like it needs again. */
      readonly route?: ResolvedModelRoute | null
    } = {},
  ): Promise<CodexSession> {
    const created = opened.created ?? false
```

with:

```ts
      readonly created?: boolean
      /** The model route it was opened on, which a thread set up like it needs again. */
      readonly route?: ResolvedModelRoute | null
      readonly environment?: Readonly<Record<string, string>> | undefined
    } = {},
  ): Promise<CodexSession> {
    const created = opened.created ?? false
```

In `packages/adapter-codex/src/runtime.ts`, replace this exact block:

```ts
      projection,
      created,
      route: opened.route ?? null,
      startBeside: (like) => this.#startBeside(like),
      interruptible: (threadId, turnId) => this.#reviewTurns.interruptible(threadId, turnId),
      ...(this.#settleMs !== undefined ? { settleMs: this.#settleMs } : {}),
```

with:

```ts
      projection,
      created,
      route: opened.route ?? null,
      environment: opened.environment,
      startBeside: (like) => this.#startBeside(like),
      interruptible: (threadId, turnId) => this.#reviewTurns.interruptible(threadId, turnId),
      ...(this.#settleMs !== undefined ? { settleMs: this.#settleMs } : {}),
```

In `packages/adapter-codex/src/runtime.ts`, replace this exact block:

```ts
      },
      emit: (event) => this.#emit(event),
    })
    this.#sessions.set(thread.id, session)
    this.#emit({
      type: 'session/started',
```

with:

```ts
      },
      emit: (event) => this.#emit(event),
    })
    if (opened.environment) this.#environments.set(thread.id, laneEnvironmentOf(opened.environment))
    this.#sessions.set(thread.id, session)
    this.#emit({
      type: 'session/started',
```

In `packages/adapter-codex/src/runtime.ts`, replace this exact block:

```ts
): {
  start: StartOptionParams & {
    modelProvider?: string
    config?: Record<string, string | number>
  }
  after: readonly (readonly [string, OptionValue])[]
} => {
  const { start, after } = splitStartOptions(options.options ?? {})
  const route = options.route
  return {
    start: {
      ...(options.model ? { model: options.model } : {}),
      ...start,
      ...(route ? { ...routeParams(route), ...(route.model ? { model: route.model } : {}) } : {}),
    },
    after,
  }
```

with:

```ts
): {
  start: StartOptionParams & {
    modelProvider?: string
    config?: NonNullable<CodexProtocol.v2.ThreadStartParams['config']>
  }
  after: readonly (readonly [string, OptionValue])[]
} => {
  const { start, after } = splitStartOptions(options.options ?? {})
  const route = options.route
  const routed = route ? routeParams(route) : null
  const config = { ...routed?.config }
  return {
    start: {
      ...(options.model ? { model: options.model } : {}),
      ...start,
      ...(routed ? { ...routed, ...(route?.model ? { model: route.model } : {}) } : {}),
      ...(options.environment ? { config: codexEnvironmentConfig(config, options.environment) } : {}),
    },
    after,
  }
```

In `packages/adapter-codex/src/runtime.ts`, replace this exact block:

```ts
  },
})

export { makeSessionId }
```

with:

```ts
  },
})

import { laneEnvironmentOf } from '@harnessdesk/protocol'
import { codexEnvironmentConfig } from './lane-environment.js'

export { makeSessionId }
```

In `packages/adapter-codex/src/session.ts`, replace this exact block:

```ts
   * up like this one needs the route again, not just the provider's name.
   */
  readonly route?: ResolvedModelRoute | null
  /**
   * Starts a new thread set up like the one given and registers it with the
   * runtime, as `createSession` would — see `CodexRuntime.#startBeside`.
```

with:

```ts
   * up like this one needs the route again, not just the provider's name.
   */
  readonly route?: ResolvedModelRoute | null
  readonly environment?: Readonly<Record<string, string>> | undefined
  /**
   * Starts a new thread set up like the one given and registers it with the
   * runtime, as `createSession` would — see `CodexRuntime.#startBeside`.
```

In `packages/adapter-codex/src/session.ts`, replace this exact block:

```ts
  startLike(): {
    readonly start: LikeParams
    readonly route: ResolvedModelRoute | null
    readonly sandbox: CodexProtocol.v2.SandboxPolicy | null
    readonly after: readonly (readonly [string, OptionValue])[]
  } {
```

with:

```ts
  startLike(): {
    readonly start: LikeParams
    readonly route: ResolvedModelRoute | null
    readonly environment: Readonly<Record<string, string>> | undefined
    readonly sandbox: CodexProtocol.v2.SandboxPolicy | null
    readonly after: readonly (readonly [string, OptionValue])[]
  } {
```

In `packages/adapter-codex/src/session.ts`, replace this exact block:

```ts
    return {
      start: startParamsLike(this.#state),
      route: this.deps.route ?? null,
      sandbox: this.#state.sandbox,
      after: ['mode', 'effort'].flatMap((id) => {
        const value = findOption(options, id)?.currentValue
```

with:

```ts
    return {
      start: startParamsLike(this.#state),
      route: this.deps.route ?? null,
      environment: this.deps.environment,
      sandbox: this.#state.sandbox,
      after: ['mode', 'effort'].flatMap((id) => {
        const value = findOption(options, id)?.currentValue
```

The capability remains false in this commit because only the mapping has been proved. Step 12 supplies the exact release enablement change after the native process probe. False does not silently substitute shared execution: the host refuses this candidate for an isolated Seat.

- [ ] **Step 6: Negotiate and verify ACP environment acknowledgement**

The in-flight resume queue retains its existing replay behavior. The acknowledged environment is kept independently of the live handle so reattaching after a peer restart can send it again. A newly opened session with a bad acknowledgement follows the same close path as a bad initial model pick.

In `packages/adapter-acp/src/runtime.ts`, replace this exact block:

```ts
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
```

with:

```ts
import { laneEnvironmentOf } from '@harnessdesk/protocol'
import { environmentMeta, environmentSupported, acknowledgeEnvironment } from './lane-environment.js'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
```

In `packages/adapter-acp/src/runtime.ts`, replace this exact block:

```ts

  readonly #connection: AcpConnection
  readonly #sessions = new Map<SessionId, AcpSession>()
  readonly #resuming = new Map<SessionId, Promise<AgentSession>>()
  /**
   * The folder each conversation opened here was opened in, as the agent
```

with:

```ts

  readonly #connection: AcpConnection
  readonly #sessions = new Map<SessionId, AcpSession>()
  readonly #environments = new Map<SessionId, Readonly<Record<string, string>>>()
  readonly #resuming = new Map<SessionId, Promise<AgentSession>>()
  /**
   * The folder each conversation opened here was opened in, as the agent
```

In `packages/adapter-acp/src/runtime.ts`, replace this exact block:

```ts
    const shaken = this.#initialized !== null
    return {
      ...NO_CAPABILITIES,
      // ACP declares how to authenticate but never whether you already are
      // — so claiming an account from authMethods alone painted "not signed
      // in" over agents that were. The surface exists when the registry
```

with:

```ts
    const shaken = this.#initialized !== null
    return {
      ...NO_CAPABILITIES,
      sessionEnvironment: environmentSupported(this.#initialized?._meta),
      // ACP declares how to authenticate but never whether you already are
      // — so claiming an account from authMethods alone painted "not signed
      // in" over agents that were. The surface exists when the registry
```

In `packages/adapter-acp/src/runtime.ts`, replace this exact block:

```ts
      // that can only apply a control when it spawns the agent (Claude
      // Code's `--effort`) reads them here; every other agent ignores the
      // key, and the `setOption` calls below apply the values the usual way.
      ...(Object.keys(initial).length > 0 ? { _meta: { harnessdesk: { options: initial } } } : {}),
    })
    const session = new AcpSession(this, result, options.cwd)
    this.#sessions.set(session.id, session)
```

with:

```ts
      // that can only apply a control when it spawns the agent (Claude
      // Code's `--effort`) reads them here; every other agent ignores the
      // key, and the `setOption` calls below apply the values the usual way.
      ...(options.environment ? {
        _meta: environmentMeta({ harnessdesk: { options: initial } }, options.environment,
          this.info.capabilities.sessionEnvironment),
      } : Object.keys(initial).length > 0 ? { _meta: { harnessdesk: { options: initial } } } : {}),
    })
    const session = new AcpSession(this, result, options.cwd)
    this.#sessions.set(session.id, session)
```

In `packages/adapter-acp/src/runtime.ts`, replace this exact block:

```ts
    // and model first, because they decide which other options exist.
    const ordered = Object.entries(initial).sort(([a], [b]) => rankOptionId(a) - rankOptionId(b))
    try {
      for (const [id, value] of ordered) {
        /*
         * Inapplicable is not the same as wrong, and only one of them should
```

with:

```ts
    // and model first, because they decide which other options exist.
    const ordered = Object.entries(initial).sort(([a], [b]) => rankOptionId(a) - rankOptionId(b))
    try {
      if (options.environment) {
        acknowledgeEnvironment(result._meta, options.environment)
        this.#environments.set(session.id, laneEnvironmentOf(options.environment))
      }
      for (const [id, value] of ordered) {
        /*
         * Inapplicable is not the same as wrong, and only one of them should
```

In `packages/adapter-acp/src/runtime.ts`, replace this exact block:

```ts
      // "Untitled session" with no turns, for the life of the process — the
      // Codex adapter has always closed it; this one kept it.
      this.#sessions.delete(session.id)
      await session.close()
      throw error
    }
```

with:

```ts
      // "Untitled session" with no turns, for the life of the process — the
      // Codex adapter has always closed it; this one kept it.
      this.#sessions.delete(session.id)
      this.#environments.delete(session.id)
      await session.close()
      throw error
    }
```

In `packages/adapter-acp/src/runtime.ts`, replace this exact block:

```ts
    return session
  }

  async resumeSession(id: SessionId): Promise<AgentSession> {
    // The draft probe is a session the agent counts, and no conversation.
    // Handed out by its id it was held as one, and its folder opened with it;
    // a turn sent to it would vanish into a session that never speaks.
    if (id === this.#probeId) throw new SessionGoneError(`${this.#config.name} has no conversation ${id}.`)
    const live = this.#sessions.get(id)
    if (live) return live
    const inFlight = this.#resuming.get(id)
    if (inFlight) return inFlight

    const run = (async () => {
      const capabilities = this.#initialized?.agentCapabilities
```

with:

```ts
    return session
  }

  async resumeSession(id: SessionId, options: Partial<SessionOptions> = {}): Promise<AgentSession> {
    const saved = this.#environments.get(id)
    const environment = options.environment ? laneEnvironmentOf(options.environment) : saved
    if (saved && environment && JSON.stringify(saved) !== JSON.stringify(environment)) {
      throw new Error('A live session cannot change its lane environment.')
    }
    if (environment) environmentMeta({}, environment, this.info.capabilities.sessionEnvironment)
    // The draft probe is a session the agent counts, and no conversation.
    // Handed out by its id it was held as one, and its folder opened with it;
    // a turn sent to it would vanish into a session that never speaks.
    if (id === this.#probeId) throw new SessionGoneError(`${this.#config.name} has no conversation ${id}.`)
    const inFlight = this.#resuming.get(id)
    if (inFlight) {
      await inFlight
      return this.resumeSession(id, options)
    }
    const live = this.#sessions.get(id)
    if (live) {
      if (environment && !saved) throw new Error('An already-open session cannot acquire a lane environment.')
      return live
    }

    const run = (async () => {
      const capabilities = this.#initialized?.agentCapabilities
```

In `packages/adapter-acp/src/runtime.ts`, replace this exact block:

```ts
      const session = AcpSession.forReplay(this, id, cwd)
      this.#sessions.set(id, session)
      try {
        const loaded = await this.#openWithTools<AcpNewSessionResult>('session/load', { sessionId: id, cwd })
        session.finishReplay(loaded)
        return session
      } catch (error) {
        this.#sessions.delete(id)
        throw error
      }
    })()
```

with:

```ts
      const session = AcpSession.forReplay(this, id, cwd)
      this.#sessions.set(id, session)
      try {
        const loaded = await this.#openWithTools<AcpNewSessionResult>('session/load', {
          sessionId: id, cwd,
          ...(environment ? { _meta: environmentMeta({}, environment, this.info.capabilities.sessionEnvironment) } : {}),
        })
        if (environment) {
          acknowledgeEnvironment(loaded._meta, environment)
          this.#environments.set(id, environment)
        }
        session.finishReplay(loaded)
        return session
      } catch (error) {
        this.#sessions.delete(id)
        await session.close().catch(() => {})
        throw error
      }
    })()
```

In `packages/transport-acp/src/index.ts`, replace this exact anchor:

```ts
export interface AcpNewSessionResult {
```

with:

```ts
export interface AcpNewSessionResult {
  /** Acknowledgements for negotiated extensions, including the lane environment. */
  readonly _meta?: Readonly<Record<string, unknown>>
```

This is an additional required source file discovered by the depth pass: `AcpNewSessionResult` currently has no `_meta`, although the initialize response does. A cast in the adapter would hide the missing transport contract; the explicit field above keeps it visible.

- [ ] **Step 7: Put acknowledged values into the bundled bridge child options**

In `packages/claude-acp/src/bridge.ts`, replace this exact block:

```ts
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
```

with:

```ts
import { childEnvironment, environmentIn, environmentAck } from './lane-environment.js'
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
```

In `packages/claude-acp/src/bridge.ts`, replace this exact block:

```ts
export const withOptions = (meta: Meta, values: Record<string, string>, abort: AbortController): Record<string, unknown> => {
  const claudeCode = (meta?.['claudeCode'] ?? {}) as { options?: Record<string, unknown> }
  const options: Record<string, unknown> = { ...(claudeCode.options ?? {}), abortController: abort }
  if (values[EFFORT_OPTION_ID] && values[EFFORT_OPTION_ID] !== DEFAULT) options['effort'] = values[EFFORT_OPTION_ID]
  else delete options['effort']
  const extraArgs = { ...((options['extraArgs'] as Record<string, string | null> | undefined) ?? {}) }
```

with:

```ts
export const withOptions = (meta: Meta, values: Record<string, string>, abort: AbortController): Record<string, unknown> => {
  const claudeCode = (meta?.['claudeCode'] ?? {}) as { options?: Record<string, unknown> }
  const options: Record<string, unknown> = { ...(claudeCode.options ?? {}), abortController: abort }
  const environment = environmentIn(meta)
  if (environment) {
    options['env'] = childEnvironment({ ...process.env, ...(options['env'] as NodeJS.ProcessEnv | undefined) }, environment)
  }
  if (values[EFFORT_OPTION_ID] && values[EFFORT_OPTION_ID] !== DEFAULT) options['effort'] = values[EFFORT_OPTION_ID]
  else delete options['effort']
  const extraArgs = { ...((options['extraArgs'] as Record<string, string | null> | undefined) ?? {}) }
```

In `packages/claude-acp/src/bridge.ts`, replace this exact block:

```ts
  }
  override async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    const response = await super.initialize(request)
    return { ...response, agentInfo: { name: '@harnessdesk/claude-acp', title: 'Claude Code', version: VERSION }, _meta: { ...(response._meta ?? {}), harnessdesk: { [TASKS_CAPABILITY]: true, [SESSION_DELETE_CAPABILITY]: true, [DELEGATION_CAPABILITY]: true, [INSTRUCTIONS_CAPABILITY]: true } } }
  }
  override async newSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    const params = withInstructions(request)
```

with:

```ts
  }
  override async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    const response = await super.initialize(request)
    return {
      ...response,
      agentInfo: { name: '@harnessdesk/claude-acp', title: 'Claude Code', version: VERSION },
      _meta: {
        ...(response._meta ?? {}),
        harnessdesk: {
          [TASKS_CAPABILITY]: true,
          [SESSION_DELETE_CAPABILITY]: true,
          [DELEGATION_CAPABILITY]: true,
          [INSTRUCTIONS_CAPABILITY]: true,
          sessionEnvironment: true,
        },
      },
    }
  }
  override async newSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    const params = withInstructions(request)
```

In `packages/claude-acp/src/bridge.ts`, replace this exact block:

```ts
    this.#tasks.set(response.sessionId, new TaskRegistry())
    this.#delegations.set(response.sessionId, new DelegationRegistry())
    this.#writeControls(response.sessionId, stored.values)
    return { ...decorated, configOptions: [...(decorated.configOptions ?? []), ...customOptions(stored)] }
  }
  override async loadSession(request: LoadSessionRequest): Promise<LoadSessionResponse> {
    const remembered = this.#readControls(request.sessionId)
```

with:

```ts
    this.#tasks.set(response.sessionId, new TaskRegistry())
    this.#delegations.set(response.sessionId, new DelegationRegistry())
    this.#writeControls(response.sessionId, stored.values)
    return environmentAck({
      ...decorated,
      configOptions: [...(decorated.configOptions ?? []), ...customOptions(stored)],
    }, environmentIn(params._meta))
  }
  override async loadSession(request: LoadSessionRequest): Promise<LoadSessionResponse> {
    const remembered = this.#readControls(request.sessionId)
```

In `packages/claude-acp/src/bridge.ts`, replace this exact block:

```ts
    this.#tasks.set(request.sessionId, new TaskRegistry())
    this.#delegations.set(request.sessionId, new DelegationRegistry())
    await this.#replayStored(request.sessionId)
    return { ...decorated, configOptions: [...(decorated.configOptions ?? []), ...customOptions(stored)] }
  }
  override async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    if (!CONTROL_IDS.includes(params.configId as typeof CONTROL_IDS[number])) {
```

with:

```ts
    this.#tasks.set(request.sessionId, new TaskRegistry())
    this.#delegations.set(request.sessionId, new DelegationRegistry())
    await this.#replayStored(request.sessionId)
    return environmentAck({
      ...decorated,
      configOptions: [...(decorated.configOptions ?? []), ...customOptions(stored)],
    }, environmentIn(params._meta))
  }
  override async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    if (!CONTROL_IDS.includes(params.configId as typeof CONTROL_IDS[number])) {
```

The SDK options retain `abortController`, effort, user `env`, extra arguments and instructions. `StoredControlsWithRuntime.meta` already keeps the request's metadata and `#recreate` already feeds it through `withOptions`; those lines are retained, so changing a pick and re-arming a query re-applies the same environment. A restarted host resupplies the durable lane map on `session/load`. No environment is recovered from the user's ordinary SDK settings.

In `packages/cursor-acp/src/bridge.ts`, replace this exact block:

```ts
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
```

with:

```ts
import { laneEnvironmentOf } from '@harnessdesk/protocol'
import { childEnvironment, environmentIn, environmentAck } from './lane-environment.js'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
```

In `packages/cursor-acp/src/bridge.ts`, replace this exact block:

```ts
 * honest version of resume when the vendor keeps the history.
 */
interface StoredSession {
  sessionId: string
  cwd: string
  /**
```

with:

```ts
 * honest version of resume when the vendor keeps the history.
 */
interface StoredSession {
  environment?: Readonly<Record<string, string>>
  sessionId: string
  cwd: string
  /**
```

In `packages/cursor-acp/src/bridge.ts`, replace this exact block:

```ts
      cwd: row.cwd,
      preview: row.preview ?? row.title ?? null,
      updatedAt: row.updatedAt,
    }))
  } catch {
    return []
```

with:

```ts
      cwd: row.cwd,
      preview: row.preview ?? row.title ?? null,
      updatedAt: row.updatedAt,
      ...(row.environment ? { environment: row.environment } : {}),
    }))
  } catch {
    return []
```

In `packages/cursor-acp/src/bridge.ts`, replace this exact block:

```ts
}

interface Session {
  readonly chatId: string
  readonly cwd: string
  modeId: string
```

with:

```ts
}

interface Session {
  readonly environment: Readonly<Record<string, string>> | undefined
  readonly chatId: string
  readonly cwd: string
  modeId: string
```

In `packages/cursor-acp/src/bridge.ts`, replace this exact block:

```ts
          authMethods: [],
          // ACP can list a chat but not remove one. This bridge knows where
          // Cursor keeps them, so it serves the extension that can.
          _meta: { harnessdesk: { [SESSION_DELETE_CAPABILITY]: true, [INSTRUCTIONS_CAPABILITY]: true } },
        }
      case 'session/new':
        return this.#newSession(params)
```

with:

```ts
          authMethods: [],
          // ACP can list a chat but not remove one. This bridge knows where
          // Cursor keeps them, so it serves the extension that can.
          _meta: {
            harnessdesk: {
              [SESSION_DELETE_CAPABILITY]: true,
              [INSTRUCTIONS_CAPABILITY]: true,
              sessionEnvironment: true,
            },
          },
        }
      case 'session/new':
        return this.#newSession(params)
```

In `packages/cursor-acp/src/bridge.ts`, replace this exact block:

```ts
    modeId: string | null = null,
    pluginDir: string | null = null,
    briefing: string | null = null,
  ): Promise<unknown> {
    const families = await this.#families()
    const session: Session = {
      chatId,
      cwd,
      modeId: modeId ?? 'default',
```

with:

```ts
    modeId: string | null = null,
    pluginDir: string | null = null,
    briefing: string | null = null,
    environment?: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    const families = await this.#families()
    const session: Session = {
      environment,
      chatId,
      cwd,
      modeId: modeId ?? 'default',
```

In `packages/cursor-acp/src/bridge.ts`, replace this exact block:

```ts
    // After the reply, never before it: a client has no session to attach
    // the list to until it has read the id.
    queueMicrotask(() => this.#declareSkills(session))
    return {
      sessionId: chatId,
      modes: {
        currentModeId: session.modeId,
```

with:

```ts
    // After the reply, never before it: a client has no session to attach
    // the list to until it has read the id.
    queueMicrotask(() => this.#declareSkills(session))
    return environmentAck({
      sessionId: chatId,
      modes: {
        currentModeId: session.modeId,
```

In `packages/cursor-acp/src/bridge.ts`, replace this exact block:

```ts
          }
        : {}),
      configOptions: this.#optionsOf(session, families.find((entry) => entry.id === session.familyId)),
    }
  }

  /**
```

with:

```ts
          }
        : {}),
      configOptions: this.#optionsOf(session, families.find((entry) => entry.id === session.familyId)),
    }, environment)
  }

  /**
```

In `packages/cursor-acp/src/bridge.ts`, replace this exact block:

```ts
    // Not remembered yet: a chat becomes a conversation on its first prompt.
    // Options probes and abandoned drafts create chats too, and indexing
    // them filled the session list with untitled rows nobody had spoken to.
    return this.#openSession(chatId, cwd, null, servers ? writeToolPlugin(chatId, servers) : null, briefingOf(params))
  }

  /**
```

with:

```ts
    // Not remembered yet: a chat becomes a conversation on its first prompt.
    // Options probes and abandoned drafts create chats too, and indexing
    // them filled the session list with untitled rows nobody had spoken to.
    return this.#openSession(chatId, cwd, null,
      servers ? writeToolPlugin(chatId, servers) : null,
      briefingOf(params), environmentIn(params['_meta']))
  }

  /**
```

In `packages/cursor-acp/src/bridge.ts`, replace this exact block:

```ts
      readChatMode(sessionId, cwd, MODE_IDS),
      servers ? writeToolPlugin(sessionId, servers) : null,
      briefingOf(params),
    )
  }

```

with:

```ts
      readChatMode(sessionId, cwd, MODE_IDS),
      servers ? writeToolPlugin(sessionId, servers) : null,
      briefingOf(params),
      environmentIn(params['_meta']) ?? (() => {
        const saved = readIndex().find((row) => row.sessionId === sessionId)?.environment
        return saved === undefined ? undefined : laneEnvironmentOf(saved)
      })(),
    )
  }

```

In `packages/cursor-acp/src/bridge.ts`, replace this exact block:

```ts
      cwd,
      preview: preview ?? existing?.preview ?? null,
      updatedAt: new Date().toISOString(),
    })
    writeIndex(rows)
  }
```

with:

```ts
      cwd,
      preview: preview ?? existing?.preview ?? null,
      updatedAt: new Date().toISOString(),
      ...(this.#sessions.get(chatId)?.environment ? { environment: this.#sessions.get(chatId)!.environment! } : {}),
    })
    writeIndex(rows)
  }
```

In `packages/cursor-acp/src/bridge.ts`, replace this exact block:

```ts
    const child = spawn(this.#command, [...args], {
      cwd: session.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CURSOR_CONFIG_DIR: configHome },
    })
    session.child = child
```

with:

```ts
    const child = spawn(this.#command, [...args], {
      cwd: session.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnvironment({ ...process.env, CURSOR_CONFIG_DIR: configHome }, session.environment),
    })
    session.child = child
```

The environment is read and validated before the first turn. The Cursor index retains it for a bridge-only restart, and an incoming negotiated value is authoritative on load. Its ordinary metadata commands (`models`, `create-chat`) use their existing connection environment; the child that executes the conversation receives the session map through `#runTurn`.

- [ ] **Step 8: Resolve the host environment from the durable checkout, including released Seats**

Create `packages/server/src/goals/lane-environment.ts` with these complete contents:

```ts
import { laneEnvironmentOf, type Lane } from '@harnessdesk/protocol'

import { laneEnvironment } from './lanes.js'

/** A retained checkout keeps its allocation after its Seat is released. */
export function environmentForCheckout(cwd: string, lanes: readonly Lane[]): Readonly<Record<string, string>> | undefined {
  const matches = lanes.filter((lane) => lane.cwd !== '' && lane.cwd === cwd)
  if (matches.length > 1) throw new Error('This checkout has conflicting lane records. Repair them before reopening it.')
  return matches[0] ? laneEnvironmentOf(laneEnvironment(matches[0])) : undefined
}

export function requireLaneSupport(
  runtime: { capabilities: { sessionEnvironment: boolean }; presentation: { name: string } },
  environment: Readonly<Record<string, string>> | undefined,
): void {
  if (environment && !runtime.capabilities.sessionEnvironment) {
    throw new Error(`${runtime.presentation.name} cannot pass a lane environment to a session. Choose a runtime with lane support, or turn isolation off.`)
  }
}
```

Create `packages/server/test/lane-environment.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Lane } from '@harnessdesk/protocol'

import { environmentForCheckout, requireLaneSupport } from '../src/goals/lane-environment.js'

const lane = (state: Lane['state'] = 'active'): Lane => ({
  id: 'a', goal: 'g1', seat: 's1', cwd: '/work/lane-a', branch: 'harnessdesk/lane-a',
  ports: { start: 30000, end: 30019 }, browserProfile: null, state, createdAt: 1,
})

test('a released Seat keeps the retained checkout environment; released ports refuse resume', () => {
  assert.equal(environmentForCheckout('/work/lane-a', [lane('retained')])?.PORT, '30000')
  assert.throws(() => environmentForCheckout('/work/lane-a', [lane('released')]), /ports were released/)
  assert.equal(environmentForCheckout('/work/plain', [lane()]), undefined)
  assert.throws(() => environmentForCheckout('/work/lane-a', [lane(), { ...lane(), id: 'b' }]), /conflicting/)
})

test('unsupported isolated candidates refuse with the candidate name and a fix; plain seats stay plain', () => {
  const runtime = { capabilities: { sessionEnvironment: false }, presentation: { name: 'Fixture Runtime' } }
  const environment = environmentForCheckout('/work/lane-a', [lane()])
  assert.throws(() => requireLaneSupport(runtime, environment), /Fixture Runtime.*Choose a runtime with lane support, or turn isolation off/)
  assert.doesNotThrow(() => requireLaneSupport(runtime, undefined))
  assert.doesNotThrow(() => requireLaneSupport({ ...runtime, capabilities: { sessionEnvironment: true } }, environment))
})
```

In `packages/server/src/methods/context.ts`, replace this exact anchor:

```ts
  readonly seats: {
```

with:

```ts
  readonly laneEnvironment: {
    forCheckout(cwd: string): Readonly<Record<string, string>> | undefined
    forSession(runtime: string, sessionId: string): Promise<Readonly<Record<string, string>> | undefined>
  }
  readonly seats: {
```

In `packages/server/src/methods/context.ts`, replace this exact anchor:

```ts
where: { readonly cwd: string; readonly title: string }
```

with:

```ts
where: { readonly cwd: string; readonly title: string; readonly environment?: Readonly<Record<string, string>> }
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
import { StateStore } from './state.js'
```

with:

```ts
import { StateStore } from './state.js'
import { environmentForCheckout, requireLaneSupport } from './goals/lane-environment.js'
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
      worktrees: this.#worktrees,
```

with:

```ts
      worktrees: this.#worktrees,
      laneEnvironment: {
        forCheckout: (cwd) => environmentForCheckout(cwd, this.#lanes.list()),
        forSession: async (runtime, sessionId) => {
          const owner = this.#runtime({ runtime })
          const record = this.registry.get(owner.info.id, makeSessionId(sessionId))
          const session = record?.session ?? await this.#context.sessions.read(owner, makeSessionId(sessionId))
          const environment = environmentForCheckout(session.cwd, this.#lanes.list())
          requireLaneSupport(owner.info, environment)
          return environment
        },
      },
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
  async #openSeat(seat: FlowSeat, where: { readonly cwd: string; readonly title: string }): Promise<OpenedSeat> {
    const runtime = this.#runtime({ runtime: seat.runtime })
```

with:

```ts
  async #openSeat(seat: FlowSeat, where: {
    readonly cwd: string
    readonly title: string
    readonly environment?: Readonly<Record<string, string>>
  }): Promise<OpenedSeat> {
    const runtime = this.#runtime({ runtime: seat.runtime })
    const environment = where.environment ?? environmentForCheckout(where.cwd, this.#lanes.list())
    requireLaneSupport(runtime.info, environment)
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
      live = await runtime.createSession({
        cwd: where.cwd,
```

with:

```ts
      live = await runtime.createSession({
        cwd: where.cwd,
        ...(environment ? { environment } : {}),
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
      live = await runtime.resumeSession(id, {})
```

with:

```ts
      const environment = await this.#context.laneEnvironment.forSession(String(runtime.info.id), String(id))
      live = await runtime.resumeSession(id, environment ? { environment } : {})
```

In `packages/server/src/methods/sessions.ts`, replace this exact anchor:

```ts
      live = await runtime.resumeSession(makeSessionId(params.sessionId), options)
```

with:

```ts
      const environment = await ctx.laneEnvironment.forSession(String(runtime.info.id), params.sessionId)
      live = await runtime.resumeSession(makeSessionId(params.sessionId), { ...options, ...(environment ? { environment } : {}) })
```

In `packages/server/src/methods/sessions.ts`, replace this exact anchor:

```ts
    const live = await runtime.forkSession(makeSessionId(params.sessionId), options)
```

with:

```ts
    const environment = await ctx.laneEnvironment.forSession(String(runtime.info.id), params.sessionId)
    const live = await runtime.forkSession(makeSessionId(params.sessionId), { ...options, ...(environment ? { environment } : {}) })
```

In `packages/server/src/methods/sessions.ts`, replace this exact anchor:

```ts
    const live = await runtime.createSession(options)
```

with:

```ts
    const environment = ctx.laneEnvironment.forCheckout(options.cwd)
    if (environment && !runtime.info.capabilities.sessionEnvironment) throw new Error(`${runtime.info.presentation.name} cannot pass a lane environment to a session. Choose a runtime with lane support, or turn isolation off.`)
    const live = await runtime.createSession({ ...options, ...(environment ? { environment } : {}) })
```

The public session option validator is deliberately unchanged: it has an explicit field list and therefore never forwards `environment`. The host-derived map is applied after public options and a released lease refuses before a runtime resumes. Forks and side threads in the same lane checkout use the same descriptor, without opening another Seat or reserving another block.

In `packages/adapter-testkit/src/index.ts`, replace this exact block:

```ts
      await withRuntime(async (runtime) => {
        assert.ok(runtime.info.id.length > 0)
        assert.ok(runtime.info.presentation.name.trim().length > 0, 'presentation.name is what the shell calls it')
        for (const [key, value] of Object.entries(runtime.info.capabilities)) {
          assert.equal(typeof value, 'boolean', `capability ${key} must be a boolean verb`)
        }
```

with:

```ts
      await withRuntime(async (runtime) => {
        assert.ok(runtime.info.id.length > 0)
        assert.ok(runtime.info.presentation.name.trim().length > 0, 'presentation.name is what the shell calls it')
        assert.equal(typeof runtime.info.capabilities.sessionEnvironment, 'boolean')
        for (const [key, value] of Object.entries(runtime.info.capabilities)) {
          assert.equal(typeof value, 'boolean', `capability ${key} must be a boolean verb`)
        }
```

- [ ] **Step 9: Allocate at Goal seating and retain on any failed opening**

These are complete replacements against Task 3’s coordinator plus Task 4’s lane attachment. The Host-owned `seatAgent`/`openLegacySeat` adapters consume the passed Goal cwd; they must not make a second checkout. The `#openSeat` replacement above is the common environment gate for every candidate.

In `packages/server/src/goals/plane.ts`, replace this exact anchor:

```ts
  #lanes: LaneAllocator | null = null
```

with:

```ts
  #lanes: LaneAllocator | null = null
  #lanePreferences: (() => import('@harnessdesk/protocol').LanePreferences) | null = null
```

In `packages/server/src/goals/plane.ts`, replace this exact anchor:

```ts
  attachLanes(lanes: LaneAllocator): void {
    if (this.#lanes && this.#lanes !== lanes) throw new Error('This Goal plane already has its lane allocator.')
    this.#lanes = lanes
  }
```

with:

```ts
  attachLanes(lanes: LaneAllocator, preferences: () => import('@harnessdesk/protocol').LanePreferences): void {
    if (this.#lanes && this.#lanes !== lanes) throw new Error('This Goal plane already has its lane allocator.')
    this.#lanes = lanes
    this.#lanePreferences = preferences
  }
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
    this.#context.goals.attachLanes(this.#lanes)
```

with:

```ts
    this.#context.goals.attachLanes(this.#lanes, () => this.#context.laneSettings.read())
```

In `packages/server/src/goals/plane.ts`, replace this exact anchor:

```ts
  seat(input: GoalSeatRequest): Promise<SeatRecord> {
    return this.serial.run(async () => {
      this.#dispatch(input.goal)
      return this.port.seatAgent(input, this.store.read(input.goal).goal)
    })
  }
```

with:

```ts
  seat(input: GoalSeatRequest): Promise<SeatRecord> {
    return this.serial.run(async () => {
      this.#dispatch(input.goal)
      const goal = this.store.read(input.goal).goal
      return this.#withLane(goal, input.isolate ?? goal.checkout === 'isolated',
        (where) => this.port.seatAgent(input, where))
    })
  }
```

In `packages/server/src/goals/plane.ts`, replace this exact anchor:

```ts
  openLegacySeat(input: Parameters<GoalPlanePort['openLegacySeat']>[0]): Promise<SeatRecord> {
    return this.serial.run(async () => {
      this.#dispatch(input.goal)
      return this.port.openLegacySeat(input, this.store.read(input.goal).goal)
    })
  }
```

with:

```ts
  openLegacySeat(input: Parameters<GoalPlanePort['openLegacySeat']>[0]): Promise<SeatRecord> {
    return this.serial.run(async () => {
      this.#dispatch(input.goal)
      const goal = this.store.read(input.goal).goal
      return this.#withLane(goal, input.isolate, (where) => this.port.openLegacySeat(input, where))
    })
  }

  async #withLane(goal: Goal, isolate: boolean, open: (where: Goal) => Promise<SeatRecord>): Promise<SeatRecord> {
    if (!isolate) return open(goal)
    if (!this.#lanes || !this.#lanePreferences) throw new Error('Read the lane settings before seating this Goal.')
    const lane = await this.#lanes.allocate(goal.id, randomUUID(), this.#lanePreferences())
    try {
      const seat = await open({ ...goal, cwd: lane.cwd })
      if (seat.board !== goal.id || seat.checkout.cwd !== lane.cwd) {
        throw new Error('The recorded Seat did not use its allocated checkout. Finish recovery before dispatching work.')
      }
      await this.#lanes.bind(lane.id, seat.id)
      return seat
    } catch (error) {
      await this.#lanes.retain(lane.id)
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`${reason} Lane ${lane.id} was retained for review; its checkout and ports were kept.`)
    }
  }
```

The Task 3 prerequisite still lacks its exact Host-owned seating adapter. Its eventual implementation must pass this Goal cwd to `ctx.seats.open`, record the Goal Seat before the first brief, append the six allocation values to that brief, and retire a newly opened conversation if its durable opening fails. Those missing edits belong to Task 3 and are reported without changing it. The coordinator and adapter mappings here do not prove that unfinished integration.

- [ ] **Step 10: Test the actual bundled child processes, including a bridge restart**

Add this exact synthetic-only observer to both fake CLI fixtures. It records only the six lane variables; it never records the process's full environment.

In `packages/claude-acp/test/fixtures/fake-claude.mjs`, replace this exact anchor:

```ts
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
```

with:

```ts
if (process.env.FAKE_LANE_ENV_LOG && process.env.HARNESSDESK_LANE_ID) {
  const keys = [
    'HARNESSDESK_GOAL_ID', 'HARNESSDESK_LANE_ID', 'HARNESSDESK_PORT_START',
    'HARNESSDESK_PORT_END', 'HARNESSDESK_PORT_COUNT', 'PORT',
  ]
  appendFileSync(process.env.FAKE_LANE_ENV_LOG,
    `${JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key]])))}\n`)
}

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
```

In `packages/cursor-acp/test/fixtures/fake-cursor-agent.mjs`, replace this exact anchor:

```ts
const sessionId = valueOf('--resume') ?? 'fake-chat-unresumed'
```

with:

```ts
if (process.env.FAKE_LANE_ENV_LOG && process.env.HARNESSDESK_LANE_ID) {
  const keys = [
    'HARNESSDESK_GOAL_ID', 'HARNESSDESK_LANE_ID', 'HARNESSDESK_PORT_START',
    'HARNESSDESK_PORT_END', 'HARNESSDESK_PORT_COUNT', 'PORT',
  ]
  appendFileSync(process.env.FAKE_LANE_ENV_LOG,
    `${JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key]])))}\n`)
}

const sessionId = valueOf('--resume') ?? 'fake-chat-unresumed'
```

Append this complete block to `packages/claude-acp/test/lane-environment.test.ts` after Step 1’s tests. Its additional imports are part of the block:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import type { AgentEvent, AgentSession } from '@harnessdesk/protocol'

const BRIDGE = fileURLToPath(new URL('../src/main.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))

async function turn(runtime: AcpRuntime, session: AgentSession): Promise<void> {
  let off = () => {}
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('The fake turn did not finish.')) }, 5000)
    off = runtime.subscribe((event: AgentEvent) => {
      if (event.type === 'turn/completed' && event.sessionId === session.id) {
        clearTimeout(timer)
        off()
        resolve()
      }
    })
  })
  done.catch(() => {})
  try {
    await session.send([{ type: 'text', text: 'Read the fixture.' }])
    await done
  } finally {
    off()
  }
}

test('the actual bridge child gets both environments and re-applies one after restart', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hd-lane-bridge-'))
  const log = join(home, 'environment.ndjson')
  const make = () => new AcpRuntime({
    id: 'lane-fixture', name: 'Fixture Runtime', command: process.execPath, args: [BRIDGE],
    env: { CLAUDE_CODE_EXECUTABLE: FAKE, CLAUDE_CONFIG_DIR: join(home, 'config'), CLAUDE_ACP_STATE_DIR: join(home, 'state'), CLAUDECODE: '', FAKE_LANE_ENV_LOG: log },
  })
  const first = make()
  let second: AcpRuntime | null = null
  t.after(async () => {
    await first.dispose()
    await second?.dispose()
    await rm(home, { recursive: true, force: true })
  })
  await first.start()
  assert.equal(first.info.capabilities.sessionEnvironment, true)
  const a = await first.createSession({ cwd: home, environment: env(30000) })
  const b = await first.createSession({ cwd: home, environment: env(30020) })
  await Promise.all([turn(first, a), turn(first, b)])
  await first.dispose()
  second = make()
  await second.start()
  const resumed = await second.resumeSession(a.id, { environment: env(30000) })
  await turn(second, resumed)
  const lines = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(lines.some((line) => JSON.stringify(line) === JSON.stringify(env(30000))))
  assert.ok(lines.some((line) => JSON.stringify(line) === JSON.stringify(env(30020))))
  assert.ok(lines.filter((line) => line.HARNESSDESK_LANE_ID === 'lane-30000').length >= 2)
  assert.equal(lines.every((line) => Object.keys(line).length === 6), true)
})
```

Append this complete block to `packages/cursor-acp/test/lane-environment.test.ts` after Step 1’s tests. Its additional imports are part of the block:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import type { AgentEvent, AgentSession } from '@harnessdesk/protocol'

const BRIDGE = fileURLToPath(new URL('../src/main.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-cursor-agent.mjs', import.meta.url))

async function turn(runtime: AcpRuntime, session: AgentSession): Promise<void> {
  let off = () => {}
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('The fake turn did not finish.')) }, 5000)
    off = runtime.subscribe((event: AgentEvent) => {
      if (event.type === 'turn/completed' && event.sessionId === session.id) {
        clearTimeout(timer)
        off()
        resolve()
      }
    })
  })
  done.catch(() => {})
  try {
    await session.send([{ type: 'text', text: 'Read the fixture.' }])
    await done
  } finally {
    off()
  }
}

test('the actual bridge child gets both environments and re-applies one after restart', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hd-lane-bridge-'))
  const log = join(home, 'environment.ndjson')
  const make = () => new AcpRuntime({
    id: 'lane-fixture', name: 'Fixture Runtime', command: process.execPath, args: [BRIDGE],
    env: { CURSOR_ACP_COMMAND: FAKE, CURSOR_CONFIG_DIR: join(home, 'config'), CURSOR_ACP_STATE_DIR: join(home, 'state'), FAKE_LANE_ENV_LOG: log },
  })
  const first = make()
  let second: AcpRuntime | null = null
  t.after(async () => {
    await first.dispose()
    await second?.dispose()
    await rm(home, { recursive: true, force: true })
  })
  await first.start()
  assert.equal(first.info.capabilities.sessionEnvironment, true)
  const a = await first.createSession({ cwd: home, environment: env(30000) })
  const b = await first.createSession({ cwd: home, environment: env(30020) })
  await Promise.all([turn(first, a), turn(first, b)])
  await first.dispose()
  second = make()
  await second.start()
  const resumed = await second.resumeSession(a.id, { environment: env(30000) })
  await turn(second, resumed)
  const lines = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(lines.some((line) => JSON.stringify(line) === JSON.stringify(env(30000))))
  assert.ok(lines.some((line) => JSON.stringify(line) === JSON.stringify(env(30020))))
  assert.ok(lines.filter((line) => line.HARNESSDESK_LANE_ID === 'lane-30000').length >= 2)
  assert.equal(lines.every((line) => Object.keys(line).length === 6), true)
})
```

In `packages/server/test/fixtures/fake-runtime.ts`, replace this exact anchor:

```ts
    capabilities: {
      resume: true,
```

with:

```ts
    capabilities: {
      sessionEnvironment: false,
      resume: true,
```

Append this complete native adapter integration test after its Step 1 mapper test. It starts the actual fake app-server, opens two sessions, closes/resumes each and forks one. Only synthetic lane values and selected request fields enter its temporary log.

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexRuntime } from '../src/index.js'

test('start, resume and fork deliver each thread config to a real fixture child', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hd-native-lanes-'))
  const log = join(home, 'observed.jsonl')
  const runtime = new CodexRuntime({
    binaryPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)),
    clientName: 'harnessdesk-test', env: { FAKE_CODEX_LANE_ENV_LOG: log },
  })
  t.after(async () => { await runtime.dispose(); await rm(home, { recursive: true, force: true }) })
  await runtime.start()
  const a = await runtime.createSession({ cwd: home, environment: env(30000) })
  const b = await runtime.createSession({ cwd: home, environment: env(30020) })
  await a.close()
  await b.close()
  await runtime.resumeSession(a.id)
  await runtime.resumeSession(b.id)
  await runtime.forkSession(a.id)
  const rows = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
    method: string; environment: Record<string, string>; child: Record<string, string>
  })
  assert.deepEqual(rows.map(row => row.method), ['thread/start', 'thread/start', 'thread/resume', 'thread/resume', 'thread/fork'])
  assert.deepEqual(rows.map(row => row.environment), [env(30000), env(30020), env(30000), env(30020), env(30000)])
  assert.deepEqual(rows.map(row => row.child), rows.map(row => row.environment))
})
```

In `packages/adapter-codex/test/fixtures/fake-codex.mjs`, replace this exact anchor:

```ts
import { spawn } from 'node:child_process'
```

with:

```ts
import { spawn, spawnSync } from 'node:child_process'
```

In `packages/adapter-codex/test/fixtures/fake-codex.mjs`, replace this exact anchor:

```ts
  const { id, method, params } = message
```

with:

```ts
  const { id, method, params } = message
  const laneEnvironment = params?.config?.['shell_environment_policy.set']
  if (process.env.FAKE_CODEX_LANE_ENV_LOG && ['thread/start', 'thread/resume', 'thread/fork'].includes(method) && laneEnvironment) {
    const keys = ['HARNESSDESK_GOAL_ID', 'HARNESSDESK_LANE_ID', 'HARNESSDESK_PORT_START', 'HARNESSDESK_PORT_END', 'HARNESSDESK_PORT_COUNT', 'PORT']
    const source = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]]))))`
    const child = spawnSync(process.execPath, ['-e', source], { env: { ...process.env, ...laneEnvironment }, encoding: 'utf8' })
    if (child.status !== 0) throw new Error('The lane fixture child failed.')
    appendFileSync(process.env.FAKE_CODEX_LANE_ENV_LOG, JSON.stringify({ method, environment: laneEnvironment, child: JSON.parse(child.stdout) }) + '\n')
  }
```

The fake runtime’s default is false because that fixture has no child environment implementation. Tests that need a supporting runtime must use the real adapter with its scripted bridge, or explicitly override the capability and assert what its `createSession` receives; changing the default to true would claim an unimplemented path.

- [ ] **Step 11: Run focused tests and the dropped-environment mutation**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/protocol/dist/test/lane-environment.test.js packages/server/dist/test/lane-environment.test.js packages/adapter-codex/dist/test/lane-environment.test.js packages/adapter-acp/dist/test/lane-environment.test.js packages/claude-acp/dist/test/lane-environment.test.js packages/cursor-acp/dist/test/lane-environment.test.js`

Expected: PASS — 2 protocol, 2 server, 2 native adapter, 2 ACP mapper, 4 tests in each bridge; 16 total. The planning proof ran the 8 shared boundary assertions, including the two real local children. It did not run the production adapter/bridge suites or the real Goal seating path.

Temporarily replace `return { ...base, ...(environment === undefined ? {} : laneEnvironmentOf(environment)) }` in the bridge helper with `return { ...base }`.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/claude-acp/dist/test/lane-environment.test.js`

Expected: FAIL — the two-child assertion receives `[null,null,"present"]` instead of each requested port/end pair, and the actual bridge-child case finds no matching lane record. Restore the implementation from Step 4.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/claude-acp/dist/test/lane-environment.test.js`

Expected: PASS — 4 tests. In the isolated planning file, this mutation was observed as 1 failed / 7 passed, then 8 passed after restoration.

- [ ] **Step 12: Record native support before enabling its capability**

The native helper test proves request construction, not what a vendor shell executes. In an isolated runtime probe, open two native sessions directly with `environment: env(30000)` and `environment: env(30020)`, ask each to run `node -e 'process.stdout.write(JSON.stringify([process.env.HARNESSDESK_GOAL_ID,process.env.HARNESSDESK_LANE_ID,process.env.HARNESSDESK_PORT_START,process.env.HARNESSDESK_PORT_END,process.env.HARNESSDESK_PORT_COUNT,process.env.PORT]))'`, close and resume both with the same maps, and run it again. Record the supported binary version and four returned arrays. No real account names or home paths enter a public artifact. This live probe was not run by the plan writer.

Only after that observation, apply this exact capability replacement in `packages/adapter-codex/src/runtime.ts`:

In `packages/adapter-codex/src/runtime.ts`, replace this exact anchor:

```ts
const CAPABILITIES = {
  sessionEnvironment: false,
```

with:

```ts
const CAPABILITIES = {
  sessionEnvironment: true,
```

An unsupported version retains false and the candidate-specific refusal. No connection-wide environment, cloned account home, or prompt-only substitution is an alternative implementation.

- [ ] **Step 13: Commit the verified implementation**

Run: `pnpm verify`

Expected: Exit 0, unpiped, before the implementation commit. The plan writer does not run this listener-dependent gate or make this commit.

```bash
git add packages/adapter-codex/test/fixtures/fake-codex.mjs packages/protocol/src/lane-environment.ts packages/protocol/src/index.ts packages/protocol/src/session.ts packages/protocol/src/runtime.ts packages/transport-acp/src/index.ts packages/server/src/goals/lane-environment.ts packages/server/src/goals/plane.ts packages/server/src/host.ts packages/server/src/methods/context.ts packages/server/src/methods/sessions.ts packages/adapter-codex/src/runtime.ts packages/adapter-codex/src/session.ts packages/adapter-acp/src/runtime.ts packages/claude-acp/src/bridge.ts packages/cursor-acp/src/bridge.ts packages/claude-acp/package.json pnpm-lock.yaml packages/adapter-testkit/src/index.ts packages/server/test/fixtures/fake-runtime.ts packages/claude-acp/test/fixtures/fake-claude.mjs packages/cursor-acp/test/fixtures/fake-cursor-agent.mjs packages/adapter-codex/src/lane-environment.ts packages/adapter-acp/src/lane-environment.ts packages/claude-acp/src/lane-environment.ts packages/cursor-acp/src/lane-environment.ts packages/protocol/test/lane-environment.test.ts packages/server/test/lane-environment.test.ts packages/adapter-codex/test/lane-environment.test.ts packages/adapter-acp/test/lane-environment.test.ts packages/claude-acp/test/lane-environment.test.ts packages/cursor-acp/test/lane-environment.test.ts
git commit -m "feat(goals): carry each lane environment through its runtime session" -m "Co-Authored-By: Codex <agent@harnessdesk.app>"
```

### Task 6: Give browser calls and the visible pane the lane's profile

A host-selected identity follows one tool invocation through the built-in kernel or supervised child, then through the browser service and Electron engine. Each profile owns its CDP connection, events, tabs, driven tab and Chromium storage. A profile is an opaque key, never a model-supplied path. A normal conversation keeps the default browser; a lane explicitly created with browser isolation off shares that same default.

**Files:**
- Create: `packages/cordis-host/src/browser-scopes.ts`, `packages/cordis-host/test/browser-scopes.test.ts`.
- Modify: cordis-host `browser.ts`, `kernel.ts`, `context.ts`, `index.ts`; extension-protocol `index.ts`; extension-host `child.ts`, `supervisor.ts`; server `host.ts`.
- Create: `packages/desktop/electron/browser-scopes.mjs`, desktop `electron/browser-scopes.test.mjs`; modify desktop `browser-engine.mjs`, `main.mjs`, `preload.cjs`.
- Modify: UI `lib/desktop.ts`, `components/BrowserPane.tsx`, `state/store.ts`, `state/layout.ts`, `state/snapshot.ts`, `app/App.tsx`; create `components/BrowserPane.lanes.test.tsx`, `preview/browser-lanes.html`.
- Named existing test edits: `BrowserPane.test.tsx` now reports `{profile:null,webContentsId}`; existing IPC tests retain sender and guest-ownership checks. The workbench already keeps inactive dock views mounted; a separate BrowserView per profile reuses that behavior and its existing persistence.

**Proof needs:** the rendered UI. **Routing:** Sonnet. The planning proof covers the concurrent scope and desktop routing kernels. Actual Chromium cookies, guest visibility, light/dark and narrow layout require the Electron sitting in Step 11; no such sitting is claimed here.

**Interfaces:** `BrowserIdentity {invocation:string,profile:string}`, `withBrowserIdentity`, `BrowserScopes<T>`, `browserPartition`; `BrowserEngine.ensure(identity?:BrowserIdentity)` and `close(identity?:BrowserIdentity)`. The only profile carried in child-to-parent browser requests is the parent-issued invocation's lookup result. Requests carry `{invocation:string}` plus their method arguments. The host's resolver is installed on the extension host; plugin context exposes neither that resolver nor the authority map.

- [ ] **Step 1: Write the failing scope tests**

**`packages/cordis-host/test/browser-scopes.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrowserScopes, BrowserInvocations, withBrowserIdentity, browserPartition, runBrowserInvocation, currentBrowserIdentity } from '../src/browser-scopes.js'

test('concurrent calls retain distinct state across awaits and leave the default intact', async () => {
  const live = new BrowserInvocations()
  const scopes = new BrowserScopes(profile => ({ profile, events: [] as string[] }), identity => live.has(identity))
  const calls = ['lane-a', 'lane-b'].map(profile => live.begin(profile, 'browser'))
  const answers = await Promise.all(calls.map(identity => withBrowserIdentity(identity, async () => {
    scopes.current().events.push(identity.profile)
    await Promise.resolve()
    return scopes.current().events.slice()
  })))
  assert.deepEqual(answers, [['lane-a'], ['lane-b']])
  assert.deepEqual(scopes.current(), { profile: 'default', events: [] })
  assert.equal(scopes.entries().length, 3)
  calls.forEach(identity => live.end(identity.invocation))
})
test('forged, mismatched and expired identities fail without allocating a profile', () => {
  const live = new BrowserInvocations()
  const scopes = new BrowserScopes(profile => profile, identity => live.has(identity))
  const identity = live.begin('lane-a', 'browser')
  assert.throws(() => withBrowserIdentity({ ...identity, profile: 'lane-b' }, () => scopes.current()), /live invocation/)
  assert.throws(() => live.resolve(identity.invocation, 'other-plugin'), /live invocation/)
  live.end(identity.invocation)
  assert.throws(() => withBrowserIdentity(identity, () => scopes.current()), /live invocation/)
  assert.deepEqual(scopes.entries(), [])
})
test('invocation lifetime ends on resolve or reject, including inherited asynchronous work', async () => {
  let captured: ReturnType<typeof currentBrowserIdentity>
  await runBrowserInvocation({ invocation: 'call-a', profile: 'lane-a' }, async () => {
    captured = currentBrowserIdentity()
    assert.equal(captured?.profile, 'lane-a')
  })
  assert.throws(() => withBrowserIdentity(captured!, () => currentBrowserIdentity()), /live invocation/)
  await assert.rejects(runBrowserInvocation({ invocation: 'call-b', profile: 'lane-b' }, async () => { throw new Error('failed') }), /failed/)
  assert.throws(() => withBrowserIdentity({ invocation: 'call-b', profile: 'lane-b' }, () => currentBrowserIdentity()), /live invocation/)
})
test('partition names preserve default preference, isolate lanes and refuse arbitrary paths', () => {
  assert.equal(browserPartition(null, true), 'persist:harnessdesk-browser')
  assert.equal(browserPartition(null, false), 'harnessdesk-browser-once')
  assert.equal(browserPartition('lane-a', false), 'persist:hd-lane-a')
  assert.notEqual(browserPartition('lane-a', true), browserPartition('lane-b', true))
  for (const value of ['../personal', 'persist:personal', '', 'default', 'lane-a/b', 'lane-a\n']) {
    assert.throws(() => browserPartition(value, true), /host did not name/)
  }
})
test('an operation with no identity can demand an agent invocation', () => {
  assert.equal(currentBrowserIdentity(), undefined)
  assert.throws(() => currentBrowserIdentity(true), /live invocation/)
})
```

Run: `pnpm run build:node`

Expected: FAIL — the new browser-scopes import does not exist. The planning copy observed `Cannot find module './browser-scopes.js'` before adding it.

- [ ] **Step 2: Add the identity, lease and profile-state owners**

**`packages/cordis-host/src/browser-scopes.ts`**

```ts
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export interface BrowserIdentity { readonly invocation: string; readonly profile: string }
const scope = new AsyncLocalStorage<BrowserIdentity>()
const live = new Map<string, BrowserIdentity>()
const pending = new Set<Promise<void>>()
const refused = () => new Error('This browser call no longer belongs to a live invocation.')
const validProfile = (profile: string): void => { if (profile !== 'default') browserPartition(profile, true) }
export const withBrowserIdentity = <T>(identity: BrowserIdentity, run: () => T): T => scope.run(Object.freeze({ ...identity }), run)

export function currentBrowserIdentity(required = false): BrowserIdentity | undefined {
  const identity = scope.getStore()
  if (!identity) { if (required) throw refused(); return undefined }
  if (live.get(identity.invocation)?.profile !== identity.profile) throw refused()
  return identity
}

/** Called only by the host/kernel entry point, never exposed on plugin context. */
export async function runBrowserInvocation<T>(identity: BrowserIdentity, run: () => T | Promise<T>): Promise<T> {
  validProfile(identity.profile)
  if (!identity.invocation || live.has(identity.invocation)) throw refused()
  const frozen = Object.freeze({ ...identity })
  live.set(identity.invocation, frozen)
  let settled!: () => void
  const done = new Promise<void>(resolve => { settled = resolve })
  pending.add(done)
  try { return await withBrowserIdentity(frozen, run) }
  finally { live.delete(identity.invocation); pending.delete(done); settled() }
}

export async function drainBrowserInvocations(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending])
}

/** Parent-owned leases are removed in the same finally as the pending tool call. */
export class BrowserInvocations {
  private readonly live = new Map<string, { identity: BrowserIdentity; plugin: string }>()
  begin(profile: string, plugin: string): BrowserIdentity {
    validProfile(profile)
    if (!plugin) throw refused()
    const identity = Object.freeze({ invocation: randomUUID(), profile })
    this.live.set(identity.invocation, { identity, plugin })
    return identity
  }
  has(identity: BrowserIdentity): boolean { return this.live.get(identity.invocation)?.identity.profile === identity.profile }
  resolve(invocation: unknown, plugin?: string): BrowserIdentity {
    const lease = typeof invocation === 'string' ? this.live.get(invocation) : undefined
    if (!lease || (plugin !== undefined && plugin !== lease.plugin)) throw refused()
    return lease.identity
  }
  owner(invocation: unknown): string {
    this.resolve(invocation)
    return this.live.get(invocation as string)!.plugin
  }
  end(invocation: string): void { this.live.delete(invocation) }
}

export class BrowserScopes<T> {
  private readonly profiles = new Map<string, T>()
  constructor(private readonly create: (profile: string) => T, private readonly authorized: (identity: BrowserIdentity) => boolean) {}
  current(): T {
    const identity = scope.getStore()
    if (identity && !this.authorized(identity)) throw refused()
    return this.forProfile(identity?.profile ?? 'default')
  }
  /** Host lifecycle and settings only. Plugin code receives current(), not this map. */
  forProfile(profile: string): T {
    validProfile(profile)
    if (!this.profiles.has(profile)) this.profiles.set(profile, this.create(profile))
    return this.profiles.get(profile)!
  }
  entries(): readonly (readonly [string, T])[] { return [...this.profiles.entries()] }
}

export function browserPartition(profile: string | null, keep: boolean): string {
  if (profile === null) return keep ? 'persist:harnessdesk-browser' : 'harnessdesk-browser-once'
  if (!/^lane-[A-Za-z0-9-]{1,100}$/.test(profile) || profile.endsWith('\n')) throw new Error('The host did not name a lane browser profile.')
  return `persist:hd-${profile}`
}
```

In `packages/cordis-host/src/index.ts`, replace this exact anchor:

```ts
export { TeamService, setTeamEngine, type TeamEngine, type TeamScope } from './team.js'
```

with:

```ts
export { TeamService, setTeamEngine, type TeamEngine, type TeamScope } from './team.js'
export { BrowserInvocations, BrowserScopes, withBrowserIdentity, currentBrowserIdentity, runBrowserInvocation, browserPartition, type BrowserIdentity } from './browser-scopes.js'
```

Run: `pnpm run build:node && node --test --test-reporter=spec packages/cordis-host/dist/test/browser-scopes.test.js`

Expected: PASS — 5 tests, including expiry after resolve/reject and refusal before allocating any state. Human/default calls do not acquire a lane by ambient selection.

- [ ] **Step 3: Replace browser module state and capture each operation's owner**

Apply these exact replacements in order. The default exports remain testable, while every Chrome sender closes over a specific BrowserState. No timer, child-exit listener or socket callback consults a mutable current profile. DOM reference tables already live inside each target page; PDF output names are random per call, so neither needs a global selector. A lane ignores the default profile-directory environment override and cannot use the person's system browser handoff.

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Service, type Context } from '@deepseek-ai/cordis'
```

with:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BrowserScopes, currentBrowserIdentity, drainBrowserInvocations, type BrowserIdentity } from './browser-scopes.js'
import { currentActor } from './provenance.js'

import { Service, type Context } from '@deepseek-ai/cordis'
```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
export interface BrowserEngine {
  /** The page to drive, started or shown if need be, with `Page` and `Runtime` domains enabled. */
  ensure(): Promise<CdpSender>
  close(): Promise<void>
}

```

with:

```ts
export interface BrowserEngine {
  /** The page to drive, started or shown if need be, with `Page` and `Runtime` domains enabled. */
  ensure(identity?: BrowserIdentity): Promise<CdpSender>
  close(identity?: BrowserIdentity): Promise<void>
}

```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
 * runs per calling plugin.
 */
const state: {
  child: ChildProcess | null
  connection: CdpConnection | null
  profileDir: string | null
  /** The throwaway profile of a browser that keeps nothing; removed when it closes. */
  disposableDir: string | null
  engine: BrowserEngine | null
  settings: BrowserSettings
  /** Raw events, drained from the engine and kept for whoever reads next. */
  events: CdpEvent[]
} = {
  child: null,
  connection: null,
  profileDir: null,
  disposableDir: null,
  engine: null,
  settings: DEFAULT_SETTINGS,
  events: [],
}

/** Replaces the Chrome engine — the desktop shell does, with its own pane. */
export const setBrowserEngine = (engine: BrowserEngine | null): void => {
  state.engine = engine
  state.events = []
}

/**
 * The user's answer to "where should pages open". Changing it does not
 * disturb a browser already open: the next call lands wherever the setting
 * now says, and whatever was running is left for its own owner to close.
 */
export const setBrowserSettings = (settings: Partial<BrowserSettings>): void => {
  state.settings = { ...state.settings, ...settings }
}

export const browserSettings = (): BrowserSettings => state.settings

/** The engine the setting asks for, or the nearest thing this process has. */
const engine = (): BrowserEngine => {
  switch (state.settings.placement) {
    case 'window':
      return chromeEngine
    case 'system':
      return systemEngine
    default:
      // No pane in a headless host or the web build; a window is the
      // closest thing to "in HarnessDesk" that such a process can offer.
      return state.engine ?? chromeEngine
  }
}

```

with:

```ts
 * runs per calling plugin.
 */
interface BrowserState {
  readonly profile: string
  child: ChildProcess | null
  connection: CdpConnection | null
  profileDir: string | null
  disposableDir: string | null
  events: CdpEvent[]
  starting: Promise<void> | null
}
let installedEngine: BrowserEngine | null = null
let settings: BrowserSettings = DEFAULT_SETTINGS
const scopes = new BrowserScopes<BrowserState>(profile => ({
  profile, child: null, connection: null, profileDir: null,
  disposableDir: null, events: [], starting: null,
}), identity => currentBrowserIdentity()?.invocation === identity.invocation)

export const setBrowserEngine = (engine: BrowserEngine | null): void => {
  installedEngine = engine
  for (const [, state] of scopes.entries()) state.events = []
}
export const setBrowserSettings = (next: Partial<BrowserSettings>): void => { settings = { ...settings, ...next } }
export const browserSettings = (): BrowserSettings => settings

const settingsFor = (state: BrowserState): BrowserSettings => state.profile === 'default' ? settings : {
  ...settings,
  placement: settings.placement === 'system' ? 'window' : settings.placement,
  keepProfile: true,
  profileDir: join(dirname(settings.profileDir ?? join(homedir(), '.harnessdesk', 'browser-profile')), 'browser-profiles', state.profile),
}
const engine = (state = scopes.current()): BrowserEngine => {
  switch (settingsFor(state).placement) {
    case 'window': return chromeFor(state)
    case 'system': return systemEngine
    default: return installedEngine ?? chromeFor(state)
  }
}
const closeAllBrowsers = async (): Promise<void> => {
  await drainBrowserInvocations()
  await Promise.all(scopes.entries().map(async ([profile, state]) => {
    state.events = []
    if (state.starting) await state.starting.catch(() => {})
    await chromeFor(state).close()
    await installedEngine?.close({ invocation: 'host-shutdown', profile })
  }))
}

```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
       today, and the first one that yields would outlive the quit — #212
       again, latent (round 3 of #244). */
    ctx.effect(() => () => this.close().catch(() => {}), 'browser-shutdown')
    /* And the folders left by a desk that never got to run that disposer.
       Here rather than at kernel start because this is the service that makes
```

with:

```ts
       today, and the first one that yields would outlive the quit — #212
       again, latent (round 3 of #244). */
    ctx.effect(() => () => closeAllBrowsers(), 'browser-shutdown')
    /* And the folders left by a desk that never got to run that disposer.
       Here rather than at kernel start because this is the service that makes
```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
  /** The gate, then the page — the two lines every call below starts with. */
  private async reach(): Promise<CdpSender> {
    this.runtime.owner(this.ctx).gate.assertBrowser()
    const cdp = await engine().ensure()
    await pump(cdp)
    return cdp
  }

  /** Opens (starting the browser if needed) and waits for the load to settle. */
  async open(url: string): Promise<BrowserPage> {
    this.runtime.owner(this.ctx).gate.assertBrowser()
    // The system browser is a hand-off, not a session: there is nothing to
    // wait for and nothing to ask afterwards, so say so plainly.
    if (state.settings.placement === 'system') {
      await handToSystem(url)
      return { url, title: '', handedOff: true }
    }
    const cdp = await engine().ensure()
    // A fresh document is a fresh console and a fresh set of requests. Keeping
    // the previous page's would make "what did this page log" a question with
```

with:

```ts
  /** The gate, then the page — the two lines every call below starts with. */
  private async reach(): Promise<CdpSender> {
    this.runtime.for(this.ctx).gate.assertBrowser()
    const identity = currentBrowserIdentity(currentActor() === 'agent')
    const state = scopes.current()
    const sender = await engine(state).ensure(identity)
    const cdp: CdpSender = {
      send: (method, params) => {
        currentBrowserIdentity(currentActor() === 'agent')
        return sender.send(method, params)
      },
      ...(sender.drain ? { drain: () => {
        currentBrowserIdentity(currentActor() === 'agent')
        return sender.drain!()
      } } : {}),
    }
    await pump(cdp, state)
    return cdp
  }

  async open(url: string): Promise<BrowserPage> {
    this.runtime.owner(this.ctx).gate.assertBrowser()
    // The system browser is a hand-off, not a session: there is nothing to
    // wait for and nothing to ask afterwards, so say so plainly.
    currentBrowserIdentity(currentActor() === 'agent')
    const state = scopes.current()
    if (settingsFor(state).placement === 'system') {
      await handToSystem(url)
      return { url, title: '', handedOff: true }
    }
    const cdp = await this.reach()
    // A fresh document is a fresh console and a fresh set of requests. Keeping
    // the previous page's would make "what did this page log" a question with
```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
    const cdp = await this.reach()
    this.assertSubscribable(cdp, 'console messages')
    let entries = consoleFrom(state.events)
    if (options.onlyErrors) entries = entries.filter((entry) => entry.level === 'error' || entry.level === 'warning')
```

with:

```ts
    const cdp = await this.reach()
    this.assertSubscribable(cdp, 'console messages')
    const state = scopes.current()
    let entries = consoleFrom(state.events)
    if (options.onlyErrors) entries = entries.filter((entry) => entry.level === 'error' || entry.level === 'warning')
```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
      return { body: body.body ?? '', base64: body.base64Encoded === true }
    }
    let entries = networkFrom(state.events)
    if (options.urlPattern) {
```

with:

```ts
      return { body: body.body ?? '', base64: body.base64Encoded === true }
    }
    const state = scopes.current()
    let entries = networkFrom(state.events)
    if (options.urlPattern) {
```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
    const cdp = await this.reach()
    this.assertSubscribable(cdp, 'protocol events')
    let kept = state.events
    if (options.method) {
```

with:

```ts
    const cdp = await this.reach()
    this.assertSubscribable(cdp, 'protocol events')
    const state = scopes.current()
    let kept = state.events
    if (options.method) {
```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts

  async close(): Promise<void> {
    state.events = []
    await engine().close()
  }

```

with:

```ts

  async close(): Promise<void> {
    this.runtime.for(this.ctx).gate.assertBrowser()
    const identity = currentBrowserIdentity(currentActor() === 'agent')
    const state = scopes.current()
    state.events = []
    await chromeFor(state).close()
    await installedEngine?.close(identity)
  }

```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts

/** Drains whatever the engine has buffered into the service's own ring. */
async function pump(cdp: CdpSender): Promise<void> {
  if (!cdp.drain) return
  let fresh: readonly CdpEvent[] = []
```

with:

```ts

/** Drains whatever the engine has buffered into the service's own ring. */
async function pump(cdp: CdpSender, state = scopes.current()): Promise<void> {
  if (!cdp.drain) return
  let fresh: readonly CdpEvent[] = []
```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
 */
export const setChromeProcess = (child: ChildProcess | null, disposableDir: string | null): void => {
  state.child = child
  state.disposableDir = disposableDir
```

with:

```ts
 */
export const setChromeProcess = (child: ChildProcess | null, disposableDir: string | null): void => {
  const state = scopes.forProfile('default')
  state.child = child
  state.disposableDir = disposableDir
```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts

/** The user's own Chrome, headed, in a profile of its own — the headless host's engine. */
export const chromeEngine: BrowserEngine = {
  async ensure() {
    await ensureChrome()
    return {
      send: (method, params) => send(method, params ?? {}),
      drain: () => Promise.resolve(state.connection?.events.splice(0) ?? []),
    }
```

with:

```ts

/** The user's own Chrome, headed, in a profile of its own — the headless host's engine. */
const chromeFor = (state: BrowserState): BrowserEngine => ({
  async ensure() {
    state.starting ??= ensureChrome(state).finally(() => { state.starting = null })
    await state.starting
    return {
      send: (method, params) => send(state, method, params ?? {}),
      drain: () => Promise.resolve(state.connection?.events.splice(0) ?? []),
    }
```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
    if (disposable) rmSync(disposable, { recursive: true, force: true })
  },
}

async function ensureChrome(): Promise<void> {
    if (state.connection && state.connection.socket.readyState === WebSocket.OPEN) return
    state.connection = null
```

with:

```ts
    if (disposable) rmSync(disposable, { recursive: true, force: true })
  },
})
export const chromeEngine: BrowserEngine = {
  ensure: () => chromeFor(scopes.forProfile('default')).ensure(),
  close: () => chromeFor(scopes.forProfile('default')).close(),
}

async function ensureChrome(state: BrowserState): Promise<void> {
    const settings = settingsFor(state)
    if (state.connection && state.connection.socket.readyState === WebSocket.OPEN) return
    state.connection = null
```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
    // The messages name the rows as Settings › Browser draws them — "Which
    // browser", "Pages open" — because a person reads them to find the row.
    const chosen = process.env['HARNESSDESK_BROWSER_BINARY'] ?? state.settings.binary?.trim()
    if (chosen && !existsSync(chosen)) {
      throw new Error(
```

with:

```ts
    // The messages name the rows as Settings › Browser draws them — "Which
    // browser", "Pages open" — because a person reads them to find the row.
    const chosen = process.env['HARNESSDESK_BROWSER_BINARY'] ?? settings.binary?.trim()
    if (chosen && !existsSync(chosen)) {
      throw new Error(
```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
    // to be reused whenever a kept browser had run first in the same host.
    const profile = join(
      process.env['HARNESSDESK_BROWSER_PROFILE'] ??
        (state.settings.keepProfile === false
          ? (state.disposableDir ??= disposableProfile())
          : (state.settings.profileDir ?? join(homedir(), '.harnessdesk', 'browser-profile'))),
    )
    mkdirSync(profile, { recursive: true })
```

with:

```ts
    // to be reused whenever a kept browser had run first in the same host.
    const profile = join(
      (state.profile === 'default' ? process.env['HARNESSDESK_BROWSER_PROFILE'] : undefined) ??
        (settings.keepProfile === false
          ? (state.disposableDir ??= disposableProfile())
          : (settings.profileDir ?? join(homedir(), '.harnessdesk', 'browser-profile'))),
    )
    mkdirSync(profile, { recursive: true })
```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
        { stdio: ['ignore', 'ignore', 'ignore'], detached: false },
      )
      state.child.on('exit', () => {
        state.child = null
        state.connection = null
```

with:

```ts
        { stdio: ['ignore', 'ignore', 'ignore'], detached: false },
      )
      const child = state.child
      state.child.on('exit', () => {
        if (state.child !== child) return
        state.child = null
        state.connection = null
```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
    })
    state.connection = connection
    await send('Page.enable', {})
    await send('Runtime.enable', {})
    // Console and network are what makes this a debugger rather than a
    // remote control. A browser that refuses either still drives.
```

with:

```ts
    })
    state.connection = connection
    await send(state, 'Page.enable', {})
    await send(state, 'Runtime.enable', {})
    // Console and network are what makes this a debugger rather than a
    // remote control. A browser that refuses either still drives.
```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
  for (const method of methods) {
    try {
      await send(method, {})
    } catch {
      // An engine without this domain reports it at the read, by name.
```

with:

```ts
  for (const method of methods) {
    try {
      await send(state, method, {})
    } catch {
      // An engine without this domain reports it at the read, by name.
```

In `packages/cordis-host/src/browser.ts`, replace this exact block:

```ts
  }

function send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const connection = state.connection
    if (!connection) return Promise.reject(new Error('No browser is open.'))
```

with:

```ts
  }

function send(state: BrowserState, method: string, params: Record<string, unknown>): Promise<unknown> {
    const connection = state.connection
    if (!connection) return Promise.reject(new Error('No browser is open.'))
```

In `packages/cordis-host/src/context.ts`, replace this exact anchor:

```ts
  readonly browser: {
```

with:

```ts
  /** Browser ownership comes from the live host invocation, never a plugin argument. */
  readonly browser: {
```

- [ ] **Step 4: Mint identities at the trusted invocation entry and expire them with the call**

The host resolver returns `undefined` for an unscoped or unknown conversation. Such a tool can still use non-browser services; its browser call refuses. A child gets an optional parent-created identity, and never mints its own fallback identity. Parent leases exist only for a enabled plugin with a browser grant and an actual matching contribution. Timeout, crash, throw and success all leave through the lease's `finally`.

In `packages/cordis-host/src/kernel.ts`, replace this exact block:

```ts
import { FsService, HttpService, ShellService, WorkspaceService } from './capabilities.js'
import { BrowserService, setBrowserSettings, type BrowserSettings } from './browser.js'
import { EditorService } from './editor.js'
import { TeamService } from './team.js'
```

with:

```ts
import { FsService, HttpService, ShellService, WorkspaceService } from './capabilities.js'
import { BrowserService, setBrowserSettings, type BrowserSettings } from './browser.js'
import { randomUUID } from 'node:crypto'
import { runBrowserInvocation, type BrowserIdentity } from './browser-scopes.js'
import { EditorService } from './editor.js'
import { TeamService } from './team.js'
```

In `packages/cordis-host/src/kernel.ts`, replace this exact block:

```ts
  }

  readonly #invocations = new Map<string, number>()

```

with:

```ts
  }

  #browserResolver: (scope: ScopeQuery) => string | undefined = () => 'default'
  setBrowserResolver(resolve: (scope: ScopeQuery) => string | undefined): void { this.#browserResolver = resolve }
  readonly #invocations = new Map<string, number>()

```

In `packages/cordis-host/src/kernel.ts`, replace this exact block:

```ts
  }

  async invokeTool(id: ContributionId, args: unknown, scope: ScopeQuery): Promise<ToolResult> {
    const entry = this.#store.get(id)
    if (!entry?.executor) {
```

with:

```ts
  }

  async invokeTool(id: ContributionId, args: unknown, scope: ScopeQuery, inherited?: BrowserIdentity | null): Promise<ToolResult> {
    const entry = this.#store.get(id)
    if (!entry?.executor) {
```

In `packages/cordis-host/src/kernel.ts`, replace this exact block:

```ts
      // cause travels with the call and `ctx.editor` can refuse a write that
      // is really an agent's. See `provenance.ts` and the editor-plane decision.
      return await asActor('agent', () => entry.executor!(args, scope))
    } catch (error) {
      if (error instanceof PermissionDenied) {
```

with:

```ts
      // cause travels with the call and `ctx.editor` can refuse a write that
      // is really an agent's. See `provenance.ts` and the editor-plane decision.
      const profile = inherited === undefined ? this.#browserResolver(scope) : inherited?.profile
      const identity = inherited ?? (profile ? { invocation: randomUUID(), profile } : null)
      const execute = () => asActor('agent', () => entry.executor!(args, scope))
      return identity ? await runBrowserInvocation(identity, execute) : await execute()
    } catch (error) {
      if (error instanceof PermissionDenied) {
```

In `packages/extension-protocol/src/index.ts`, replace this exact block:

```ts
  }
  'tool/invoke': {
    params: { readonly id: string; readonly args: unknown; readonly scope: ScopeQuery }
    result: ToolResult
  }
```

with:

```ts
  }
  'tool/invoke': {
    params: { readonly id: string; readonly args: unknown; readonly scope: ScopeQuery; readonly browser?: { readonly invocation: string; readonly profile: string } }
    result: ToolResult
  }
```

In `packages/extension-protocol/src/index.ts`, replace this exact block:

```ts
 */
export interface ChildToHostMethods {
  'browser/ensure': { params: Record<string, never>; result: null }
  'browser/send': {
    params: { readonly method: string; readonly params?: Record<string, unknown> }
    result: unknown
  }
  /** Everything the page has said since the last drain; the reading empties it. */
  'browser/events': { params: Record<string, never>; result: readonly CdpEventWire[] }
  'browser/close': { params: Record<string, never>; result: null }

  /**
```

with:

```ts
 */
export interface ChildToHostMethods {
  'browser/ensure': { params: { readonly invocation: string }; result: null }
  'browser/send': {
    params: { readonly invocation: string; readonly method: string; readonly params?: Record<string, unknown> }
    result: unknown
  }
  /** Everything the page has said since the last drain; the reading empties it. */
  'browser/events': { params: { readonly invocation: string }; result: readonly CdpEventWire[] }
  'browser/close': { params: { readonly invocation: string }; result: null }

  /**
```

In `packages/extension-host/src/child.ts`, replace this exact block:

```ts
 */
const remoteBrowserEngine: BrowserEngine = {
  async ensure() {
    await askHost('browser/ensure', {})
    return {
      send: (method, params) => askHost('browser/send', { method, ...(params ? { params } : {}) }),
      // Console and network are events, and events are pulled across this
      // boundary rather than pushed — see `ChildToHostMethods`.
      drain: () => askHost('browser/events', {}),
    }
  },
  async close() {
    await askHost('browser/close', {})
  },
}
```

with:

```ts
 */
const remoteBrowserEngine: BrowserEngine = {
  async ensure(identity) {
    if (!identity) throw new Error('A browser request needs a live invocation.')
    const invocation = identity.invocation
    await askHost('browser/ensure', { invocation })
    return {
      send: (method, params) => askHost('browser/send', { invocation, method, ...(params ? { params } : {}) }),
      drain: () => askHost('browser/events', { invocation }),
    }
  },
  async close(identity) {
    if (identity?.invocation === 'host-shutdown') return
    if (!identity) throw new Error('A browser request needs a live invocation.')
    await askHost('browser/close', { invocation: identity.invocation })
  },
}
```

In `packages/extension-host/src/child.ts`, replace this exact block:

```ts
    handled: await kernel.runCommand(params.name, params.argument, params.scope),
  }),
  'tool/invoke': (params) => kernel.invokeTool(params.id as never, params.args, params.scope),
  'hooks/run': (params) => kernel.runHooks(params.invocation),
  'context/resolve': (params) => kernel.resolveContext(params.query),
```

with:

```ts
    handled: await kernel.runCommand(params.name, params.argument, params.scope),
  }),
  'tool/invoke': (params) => kernel.invokeTool(params.id as never, params.args, params.scope, params.browser ?? null),
  'hooks/run': (params) => kernel.runHooks(params.invocation),
  'context/resolve': (params) => kernel.resolveContext(params.query),
```

In `packages/extension-host/src/supervisor.ts`, replace this exact block:

```ts

import {
  setEditorEngine,
  setForgeEngine,
```

with:

```ts

import {
  BrowserInvocations,
  setEditorEngine,
  setForgeEngine,
```

In `packages/extension-host/src/supervisor.ts`, replace this exact block:

```ts
  #nextId = 0
  readonly #pending = new Map<number, Pending>()
  #plugins: readonly PluginInstance[] = []
  #contributions: readonly CapabilityContribution[] = []
```

with:

```ts
  #nextId = 0
  readonly #pending = new Map<number, Pending>()
  readonly #browserInvocations = new BrowserInvocations()
  #plugins: readonly PluginInstance[] = []
  #contributions: readonly CapabilityContribution[] = []
```

In `packages/extension-host/src/supervisor.ts`, replace this exact block:

```ts
      }

      const engine = this.#options.browserEngine
      if (!engine) {
```

with:

```ts
      }

      const invocation = (request.params as { invocation?: unknown })?.invocation
      const identity = this.#browserInvocations.resolve(invocation)
      const owner = this.#browserInvocations.owner(invocation)
      if (!this.#plugins.some(plugin => String(plugin.instanceId) === owner && plugin.enabled && plugin.permissions.browser)) throw new Error('This plugin no longer has a browser grant.')
      const engine = this.#options.browserEngine
      if (!engine) {
```

In `packages/extension-host/src/supervisor.ts`, replace this exact block:

```ts
      switch (request.method) {
        case 'browser/ensure':
          await engine.ensure()
          reply({ response: request.request, result: null })
          return
        case 'browser/send': {
          const { method, params } = request.params as { method: string; params?: Record<string, unknown> }
          const sender = await engine.ensure()
          reply({ response: request.request, result: (await sender.send(method, params)) ?? null })
          return
        }
        case 'browser/events': {
          const sender = await engine.ensure()
          reply({ response: request.request, result: (await sender.drain?.()) ?? [] })
          return
        }
        case 'browser/close':
          await engine.close()
          reply({ response: request.request, result: null })
          return
```

with:

```ts
      switch (request.method) {
        case 'browser/ensure':
          await engine.ensure(identity)
          reply({ response: request.request, result: null })
          return
        case 'browser/send': {
          const { method, params } = request.params as { method: string; params?: Record<string, unknown> }
          const sender = await engine.ensure(identity)
          reply({ response: request.request, result: (await sender.send(method, params)) ?? null })
          return
        }
        case 'browser/events': {
          const sender = await engine.ensure(identity)
          reply({ response: request.request, result: (await sender.drain?.()) ?? [] })
          return
        }
        case 'browser/close':
          await engine.close(identity)
          reply({ response: request.request, result: null })
          return
```

In `packages/extension-host/src/supervisor.ts`, replace this exact block:

```ts
    params: PluginHostMethods[M]['params'],
  ): Promise<PluginHostMethods[M]['result']> {
    const armKeys = this.#armedScopesFor(method, params)
    if (armKeys.length === 0) return this.#dispatch(method, params)
    for (const key of armKeys) this.#teamScopes.set(key, (this.#teamScopes.get(key) ?? 0) + 1)
    try {
      return await this.#dispatch(method, params)
    } finally {
      for (const key of armKeys) {
        const count = (this.#teamScopes.get(key) ?? 1) - 1
```

with:

```ts
    params: PluginHostMethods[M]['params'],
  ): Promise<PluginHostMethods[M]['result']> {
    await this.ensure()
    let browserInvocation: string | undefined
    if (method === 'tool/invoke') {
      const input = params as PluginHostMethods['tool/invoke']['params']
      const namespaced = childContributionId(input.id as ContributionId)
      const owner = this.#plugins.find(plugin => plugin.contributions.some(entry => entry.id === namespaced))
      if (input.browser && owner?.enabled && owner.permissions.browser && owner.contributions.some(entry => entry.id === namespaced && scopeApplies(entry.scope, input.scope))) {
        const identity = this.#browserInvocations.begin(input.browser.profile, String(owner.instanceId))
        browserInvocation = identity.invocation
        params = { ...input, browser: identity } as PluginHostMethods[M]['params']
      } else if (input.browser) {
        const { browser: _browser, ...plain } = input
        params = plain as PluginHostMethods[M]['params']
      }
    }
    const armKeys = this.#armedScopesFor(method, params)
    for (const key of armKeys) this.#teamScopes.set(key, (this.#teamScopes.get(key) ?? 0) + 1)
    try {
      return await this.#dispatch(method, params)
    } finally {
      if (browserInvocation) this.#browserInvocations.end(browserInvocation)
      for (const key of armKeys) {
        const count = (this.#teamScopes.get(key) ?? 1) - 1
```

In `packages/extension-host/src/supervisor.ts`, replace this exact block:

```ts
  }

  async invokeTool(id: ContributionId, args: unknown, scope: ScopeQuery): Promise<ToolResult> {
    if (this.#ownsInProcess(id)) return this.#kernel.invokeTool(id, args, scope)
```

with:

```ts
  }

  #browserResolver: (scope: ScopeQuery) => string | undefined = () => 'default'
  setBrowserResolver(resolve: (scope: ScopeQuery) => string | undefined): void {
    this.#browserResolver = resolve
    this.#kernel.setBrowserResolver(resolve)
  }

  async invokeTool(id: ContributionId, args: unknown, scope: ScopeQuery): Promise<ToolResult> {
    if (this.#ownsInProcess(id)) return this.#kernel.invokeTool(id, args, scope)
```

In `packages/extension-host/src/supervisor.ts`, replace this exact block:

```ts
    }
    try {
      return await this.#child.call('tool/invoke', { id: stripChildContributionId(id), args, scope })
    } catch (error) {
      // The failure is the answer: the turn goes on, told plainly why.
```

with:

```ts
    }
    try {
      const profile = this.#browserResolver(scope)
      return await this.#child.call('tool/invoke', {
        id: stripChildContributionId(id), args, scope,
        ...(profile ? { browser: { invocation: 'pending-parent-lease', profile } } : {}),
      })
    } catch (error) {
      // The failure is the answer: the turn goes on, told plainly why.
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
  setBrowserSettings(settings: BrowserSettings): void
```

with:

```ts
  setBrowserSettings(settings: BrowserSettings): void
  setBrowserResolver?(resolve: (scope: ScopeQuery) => string | undefined): void
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
    this.#extensions = options.extensions ?? null
```

with:

```ts
    this.#extensions = options.extensions ?? null
    this.#extensions?.setBrowserResolver?.(scope => {
      if (!scope.runtime || !scope.sessionId) return undefined
      const record = this.registry.get(scope.runtime, scope.sessionId)
      if (!record) return undefined
      const matches = this.#lanes.list().filter(lane => lane.cwd !== '' && lane.cwd === record.session.cwd)
      if (matches.length > 1) throw new Error('This checkout has conflicting browser lanes.')
      const lane = matches[0]
      if (lane?.state === 'released') throw new Error('This lane was released. Open a new isolated Seat.')
      return lane?.browserProfile ?? 'default'
    })
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
export class Host {
```

with:

```ts
export class Host {
  /** Desktop may restore only a persisted, unreleased lane's opaque profile. */
  browserProfileAllowed(profile: string): boolean {
    return this.#lanes.list().some(lane => lane.browserProfile === profile && lane.state !== 'released')
  }
```

The optional setter keeps other extension kernels source-compatible. An extension kernel that does not implement it cannot be used for Goal browser isolation: add this refusal to Task 5's `#openSeat`, immediately after its `requireLaneSupport(runtime.info, environment)` line:

```ts
    if (environment && !this.#extensions?.setBrowserResolver) {
      throw new Error('This extension host cannot isolate a lane browser. Choose a supported extension host or turn isolation off.')
    }
```

- [ ] **Step 5: Write the desktop engine tests before replacing its single guest**

**`packages/desktop/electron/browser-scopes.test.mjs`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createProfileBrowserEngine, browserPartition } from './browser-scopes.mjs'

function rig() {
  const ipc = new EventEmitter()
  const sessions = new Map()
  const sessionForPartition = key => { if (!sessions.has(key)) sessions.set(key, {}); return sessions.get(key) }
  const contents = new Map()
  const fronts = []
  let visible = null
  const window = { isDestroyed: () => false, webContents: { send(channel, payload) {
    if (channel === 'harnessdesk:browser-show') {
      const wc = makeGuest(payload.profile)
      ipc.emit('harnessdesk:browser-ready', { sender: window.webContents }, { profile: payload.profile, webContentsId: wc.id })
    }
    if (channel === 'harnessdesk:browser-focus') {
      visible = payload.profile; fronts.push(visible)
      ipc.emit('harnessdesk:browser-focused', { sender: window.webContents }, payload)
    }
  } } }
  function makeGuest(profile) {
    const wc = new EventEmitter()
    const debug = new EventEmitter()
    let attached = false
    Object.assign(debug, { isAttached: () => attached, attach: () => { attached = true }, detach: () => { attached = false },
      sendCommand: async method => {
        if (method === 'Runtime.evaluate') { assert.equal(visible, profile); return { result: { value: profile } } }
        if (method === 'Page.captureScreenshot') { assert.equal(visible, profile); return { data: Buffer.from(String(profile)).toString('base64') } }
        return {}
      } })
    Object.assign(wc, { id: contents.size + 1, session: sessionForPartition(browserPartition(profile, true)),
      hostWebContents: window.webContents, getType: () => 'webview', isDestroyed: () => false, debugger: debug, focus() {} })
    contents.set(wc.id, wc)
    return wc
  }
  const engine = createProfileBrowserEngine({ ipc, contents: { fromId: id => contents.get(id) }, sessionForPartition,
    window: () => window, show: async () => window, allowedProfile: profile => ['lane-a', 'lane-b'].includes(profile), readyTimeoutMs: 25 })
  return { engine, ipc, window, makeGuest, fronts, contents }
}
const identity = profile => ({ invocation: `call-${profile}`, profile })
test('concurrent senders stay bound to their own guest and wait for that profile to be fronted', async () => {
  const { engine, fronts } = rig()
  const [a, b] = await Promise.all([engine.ensure(identity('lane-a')), engine.ensure(identity('lane-b'))])
  const values = await Promise.all([a.send('Runtime.evaluate'), b.send('Runtime.evaluate')])
  assert.deepEqual(values.map(value => value.result.value), ['lane-a', 'lane-b'])
  assert.deepEqual(fronts, ['lane-a', 'lane-b'])
  const shots = await Promise.all([engine.capture(1), engine.capture(2)])
  assert.deepEqual(shots.map(value => value.toString()), ['lane-a', 'lane-b'])
})
test('foreign renderer, foreign host and wrong partition cannot announce a driven guest', async () => {
  const { engine, ipc, window, makeGuest } = rig()
  const a = makeGuest('lane-a')
  const announce = (sender, profile) => ipc.emit('harnessdesk:browser-ready', { sender }, { profile, webContentsId: a.id })
  announce({}, 'lane-a'); assert.equal(engine.knows(a.id), false)
  announce(window.webContents, 'lane-b'); assert.equal(engine.knows(a.id), false)
  a.hostWebContents = {}; announce(window.webContents, 'lane-a'); assert.equal(engine.knows(a.id), false)
  a.hostWebContents = window.webContents; announce(window.webContents, 'lane-a'); assert.equal(engine.knows(a.id), true)
  await assert.rejects(engine.ensure(identity('lane-unknown')), /not owned/)
})
test('closing B preserves A, and event drains do not cross profiles', async () => {
  const { engine, contents } = rig()
  const a = await engine.ensure(identity('lane-a'))
  const b = await engine.ensure(identity('lane-b'))
  contents.get(1).debugger.emit('message', {}, 'Log.entryAdded', { text: 'A' })
  contents.get(2).debugger.emit('message', {}, 'Log.entryAdded', { text: 'B' })
  assert.deepEqual(await a.drain(), [{ method: 'Log.entryAdded', params: { text: 'A' } }])
  assert.deepEqual(await b.drain(), [{ method: 'Log.entryAdded', params: { text: 'B' } }])
  await engine.close(identity('lane-b'))
  assert.equal((await a.send('Runtime.evaluate')).result.value, 'lane-a')
})
test('default browser remains available and unknown partition strings refuse', async () => {
  const { engine } = rig()
  const ordinary = await engine.ensure()
  assert.equal((await ordinary.send('Runtime.evaluate')).result.value, null)
  assert.throws(() => engine.partition('../personal'), /host did not name/)
})
```

Run: `node --test --test-reporter=spec packages/desktop/electron/browser-scopes.test.mjs`

Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `electron/browser-scopes.mjs` until Step 6 is applied.

- [ ] **Step 6: Keep Electron guest, event and readiness state per profile**

A queued CDP command waits for a profile-specific renderer focus acknowledgement before it sends. This prevents two concurrent screenshots from racing the visible tab. The bound WebContents remains the same for the whole sender. `browser-ready` checks sender, host window, guest kind, kept-lane authority and the actual Electron Session object; a matching string is insufficient. The profile-to-partition helper is repeated locally because the desktop shell must not import the Cordis kernel.

**`packages/desktop/electron/browser-scopes.mjs`**

```js
import { answered } from './deadline.mjs'
import { printOptions, printResult } from './pdf.mjs'

const profileKey = profile => profile ?? 'default'
export function browserPartition(profile, keep) {
  if (profile === null) return keep ? 'persist:harnessdesk-browser' : 'harnessdesk-browser-once'
  if (typeof profile !== 'string' || !/^lane-[A-Za-z0-9-]{1,100}$/.test(profile) || profile.endsWith('\n')) throw new Error('The host did not name a lane browser profile.')
  return `persist:hd-${profile}`
}

/** Dependency injection keeps the tests on the actual engine, without an Electron process. */
export function createProfileBrowserEngine({ ipc, contents, sessionForPartition, window: currentWindow, show,
  allowedProfile, keep = () => true, readyTimeoutMs = 10_000 }) {
  const guests = new Map()
  const known = new Map()
  const waiters = new Map()
  const focused = new Map()
  const banked = new WeakMap()
  const partitionProfiles = new Map()
  const attaching = new WeakMap()
  let nextRequest = 0
  let tail = Promise.resolve()
  const serial = body => { const work = tail.then(body, body); tail = work.catch(() => {}); return work }
  const deskSender = event => event.sender === currentWindow()?.webContents
  const partition = profile => {
    const value = browserPartition(profile, keep())
    if (profile !== null && !allowedProfile(profile)) throw new Error('This browser profile is not owned by a kept lane.')
    partitionProfiles.set(sessionForPartition(value), profile)
    return value
  }
  const pending = (map, key, message) => {
    let entry = map.get(key)
    if (entry) return entry.promise
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    const timer = setTimeout(() => { map.delete(key); reject(new Error(message)) }, readyTimeoutMs)
    entry = { promise, resolve: value => { clearTimeout(timer); map.delete(key); resolve(value) },
      reject: error => { clearTimeout(timer); map.delete(key); reject(error) } }
    map.set(key, entry)
    promise.catch(() => {})
    return promise
  }
  const assertGuest = (profile, wc) => {
    partition(profile)
    if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || wc.hostWebContents !== currentWindow()?.webContents ||
      !(profile === null
        ? ['persist:harnessdesk-browser', 'harnessdesk-browser-once'].some(key => wc.session === sessionForPartition(key))
        : wc.session === sessionForPartition(partition(profile)))) throw new Error('That page is not open in this browser profile.')
  }
  ipc.on('harnessdesk:browser-ready', (event, request) => {
    if (!deskSender(event)) return
    const profile = request?.profile
    try {
      const wc = Number.isInteger(request?.webContentsId) ? contents.fromId(request.webContentsId) : null
      assertGuest(profile, wc)
      const key = profileKey(profile)
      guests.set(key, wc)
      if (!known.has(wc.id)) {
        known.set(wc.id, profile)
        wc.once('destroyed', () => { known.delete(wc.id); if (guests.get(key) === wc) guests.delete(key) })
      } else if (known.get(wc.id) !== profile) return
      waiters.get(key)?.resolve(wc)
    } catch { /* Refuse malformed, foreign and unauthorized guest announcements. */ }
  })
  ipc.on('harnessdesk:browser-gone', (event, request) => {
    if (!deskSender(event)) return
    const key = profileKey(request?.profile)
    if (guests.get(key)?.id === request?.webContentsId) guests.delete(key)
  })
  ipc.on('harnessdesk:browser-focused', (event, request) => {
    if (!deskSender(event)) return
    focused.get(request?.request)?.resolve(null)
  })
  const front = async profile => {
    const window = currentWindow()
    if (!window || window.isDestroyed()) throw new Error('The browser window is closed.')
    const request = ++nextRequest
    const ready = pending(focused, request, 'The browser profile did not become visible in time.')
    try { window.webContents.send('harnessdesk:browser-focus', { profile, request }) }
    catch (error) { focused.get(request)?.reject(error) }
    await ready
  }
  const attach = async wc => {
    let work = attaching.get(wc)
    if (work) return work
    work = (async () => {
      if (wc.debugger.isAttached()) return
      wc.debugger.attach('1.3')
      const events = []
      banked.set(wc, events)
      wc.debugger.on('message', (_event, method, params) => {
        events.push({ method, params: params ?? {} })
        if (events.length > 3000) events.splice(0, events.length - 3000)
      })
      await answered('Page.enable', wc.debugger.sendCommand('Page.enable'))
      await answered('Runtime.enable', wc.debugger.sendCommand('Runtime.enable'))
      for (const domain of ['Log.enable', 'Network.enable']) {
        try { await answered(domain, wc.debugger.sendCommand(domain)) } catch { /* optional domain */ }
      }
    })()
    attaching.set(wc, work)
    try { await work } finally { attaching.delete(wc) }
  }
  const senderFor = async (profile, wc) => {
    assertGuest(profile, wc)
    await attach(wc)
    return {
      send: (method, params) => serial(async () => {
        assertGuest(profile, wc)
        await front(profile)
        assertGuest(profile, wc)
        if (method.startsWith('Input.')) wc.focus()
        if (method === 'Page.printToPDF') return printResult(await answered(method, wc.printToPDF(printOptions(params ?? {}))))
        return answered(method, wc.debugger.sendCommand(method, params ?? {}))
      }),
      drain: async () => { assertGuest(profile, wc); return (banked.get(wc) ?? []).splice(0) },
    }
  }
  return {
    partition,
    profileForPartition(value) {
      if (value === 'persist:harnessdesk-browser' || value === 'harnessdesk-browser-once') {
        partitionProfiles.set(sessionForPartition(value), null)
        return null
      }
      if (typeof value !== 'string' || !value.startsWith('persist:hd-')) return undefined
      const profile = value.slice('persist:hd-'.length)
      try { return partition(profile) === value ? profile : undefined } catch { return undefined }
    },
    profileOfSession(value) { return partitionProfiles.get(value) },
    profileOf(id) { return known.has(id) ? known.get(id) : undefined },
    knows(id) { return known.has(id) && !contents.fromId(id)?.isDestroyed() },
    async capture(id) {
      if (!known.has(id)) throw new Error('That page is no longer open.')
      const sender = await senderFor(known.get(id), contents.fromId(id))
      const shot = await sender.send('Page.captureScreenshot', { format: 'png' })
      return Buffer.from(shot.data, 'base64')
    },
    async ensure(identity) {
      const profile = identity && identity.profile !== 'default' ? identity.profile : null
      partition(profile)
      const key = profileKey(profile)
      let wc = guests.get(key)
      if (!wc || wc.isDestroyed()) {
        const window = (await show()) ?? currentWindow()
        if (!window) throw new Error('HarnessDesk has no window to show a browser in.')
        const ready = pending(waiters, key, 'The browser pane did not open in time.')
        try { window.webContents.send('harnessdesk:browser-show', { profile, url: 'about:blank' }) }
        catch (error) { waiters.get(key)?.reject(error) }
        wc = await ready
      }
      return senderFor(profile, wc)
    },
    async close(identity) {
      const profile = identity && identity.profile !== 'default' ? identity.profile : null
      partition(profile)
      const key = profileKey(profile)
      const wc = guests.get(key)
      if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
      guests.delete(key)
      waiters.get(key)?.reject(new Error('This browser profile was closed.'))
      currentWindow()?.webContents.send('harnessdesk:browser-close', { profile })
    },
  }
}
```

**`packages/desktop/electron/browser-engine.mjs`**

```js
import { ipcMain, webContents, session } from 'electron'
import { createProfileBrowserEngine } from './browser-scopes.mjs'

export const createInlineBrowserEngine = options => createProfileBrowserEngine({
  ...options,
  ipc: ipcMain,
  contents: webContents,
  sessionForPartition: partition => session.fromPartition(partition),
})
```

Run: `node --test --test-reporter=spec packages/desktop/electron/browser-scopes.test.mjs`

Expected: PASS — 4 tests. This exercises the engine with injected Electron-shaped guests and does not claim real cookie or rasterization evidence.

- [ ] **Step 7: Validate guest partitions in main and carry profile-aware desktop payloads**

`will-attach-webview` now refuses a profile before any guest is constructed. Node integration, sandbox, context isolation and preload restrictions are retained. Download listeners are already per Electron Session; their outcomes now name the profile. Popups return to their source profile. Capture, annotation and clear-data IPC also verify the desk sender.

In `packages/desktop/electron/main.mjs`, replace this exact block:

```js
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    if (!/^(https?|file|about):/i.test(params.src ?? '')) event.preventDefault()
  })

```

with:

```js
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    if (!/^(https?|file|about):/i.test(params.src ?? '') || browserEngine.profileForPartition(params.partition) === undefined) event.preventDefault()
  })

```

In `packages/desktop/electron/main.mjs`, replace this exact block:

```js
  // OS browser. The renderer keeps `linksInPane` and tells us on every change.
  window.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url: target }) => {
      if (!/^(https?|file):/i.test(target)) return { action: 'deny' }
      if (browserLinksInPane) window.webContents.send('harnessdesk:browser-open-tab', { url: target })
      else if (/^https?:/i.test(target)) void shell.openExternal(target)
      return { action: 'deny' }
    })
    watchDownloads(guest.session)
  })

```

with:

```js
  // OS browser. The renderer keeps `linksInPane` and tells us on every change.
  window.webContents.on('did-attach-webview', (_event, guest) => {
    const profile = browserEngine.profileOfSession(guest.session)
    if (profile === undefined) { guest.close(); return }
    guest.setWindowOpenHandler(({ url: target }) => {
      if (!/^(https?|file):/i.test(target)) return { action: 'deny' }
      if (browserLinksInPane) window.webContents.send('harnessdesk:browser-open-tab', { url: target, profile })
      else if (/^https?:/i.test(target)) void shell.openExternal(target)
      return { action: 'deny' }
    })
    watchDownloads(guest.session, profile)
  })

```

In `packages/desktop/electron/main.mjs`, replace this exact block:

```js
 */
const browserEngine = createInlineBrowserEngine({
  window: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  show: async () => {
```

with:

```js
 */
const browserEngine = createInlineBrowserEngine({
  allowedProfile: profile => host?.browserProfileAllowed(profile) === true,
  window: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  show: async () => {
```

In `packages/desktop/electron/main.mjs`, replace this exact block:

```js
})

/** The partition the browser pane's guests use when sessions are kept. */
const BROWSER_PARTITION = 'persist:harnessdesk-browser'

/** The renderer's `linksInPane` preference, mirrored here because the guest's
```

with:

```js
})


/** The renderer's `linksInPane` preference, mirrored here because the guest's
```

In `packages/desktop/electron/main.mjs`, replace this exact block:

```js
/** Destinations handed out but not yet written — two `report.csv` at once must not share one. */
const inFlightDownloads = new Set()
const watchDownloads = (guestSession) => {
  if (watchedSessions.has(guestSession)) return
  watchedSessions.add(guestSession)
```

with:

```js
/** Destinations handed out but not yet written — two `report.csv` at once must not share one. */
const inFlightDownloads = new Set()
const watchDownloads = (guestSession, profile) => {
  if (watchedSessions.has(guestSession)) return
  watchedSessions.add(guestSession)
```

In `packages/desktop/electron/main.mjs`, replace this exact block:

```js
      // macOS the app outlives its window, and the session outlives both.
      const target = mainWindow
      if (target && !target.isDestroyed()) target.webContents.send('harnessdesk:browser-download', outcome)
    })
  })
```

with:

```js
      // macOS the app outlives its window, and the session outlives both.
      const target = mainWindow
      if (target && !target.isDestroyed()) target.webContents.send('harnessdesk:browser-download', { ...outcome, profile })
    })
  })
```

In `packages/desktop/electron/main.mjs`, replace this exact block:

```js
 * path written, or null when the person cancelled the dialog.
 */
ipcMain.handle('harnessdesk:browser-save-screenshot', async (_event, request) => {
  const id = request?.id
  if (!Number.isInteger(id) || !browserEngine.knows(id)) throw new Error('That page is not open in the browser pane.')
```

with:

```js
 * path written, or null when the person cancelled the dialog.
 */
ipcMain.handle('harnessdesk:browser-save-screenshot', async (event, request) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Only the desk can capture its browser.')
  const id = request?.id
  if (!Number.isInteger(id) || !browserEngine.knows(id)) throw new Error('That page is not open in the browser pane.')
```

In `packages/desktop/electron/main.mjs`, replace this exact block:

```js
 * window, which only the browser pane creates.
 */
ipcMain.handle('harnessdesk:browser-annotate', async (_event, request) => {
  const id = request?.id
  const wc = Number.isInteger(id) ? webContents.fromId(id) : null
  if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || !mainWindow || wc.hostWebContents !== mainWindow.webContents) {
    throw new Error('That page is not open in the browser pane.')
  }
```

with:

```js
 * window, which only the browser pane creates.
 */
ipcMain.handle('harnessdesk:browser-annotate', async (event, request) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Only the desk can annotate its browser.')
  const id = request?.id
  const wc = Number.isInteger(id) ? webContents.fromId(id) : null
  if (!wc || !browserEngine.knows(id) || wc.isDestroyed() || wc.getType() !== 'webview' || !mainWindow || wc.hostWebContents !== mainWindow.webContents) {
    throw new Error('That page is not open in the browser pane.')
  }
```

In `packages/desktop/electron/main.mjs`, replace this exact block:

```js

/** Empties the pane's persistent partition — cookies, storage, caches. */
ipcMain.handle('harnessdesk:browser-clear-data', async () => {
  await session.fromPartition(BROWSER_PARTITION).clearStorageData()
})
```

with:

```js

/** Empties the pane's persistent partition — cookies, storage, caches. */
ipcMain.handle('harnessdesk:browser-clear-data', async (event, request) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Only the desk can clear a browser profile.')
  const partition = browserEngine.partition(request?.profile ?? null)
  await session.fromPartition(partition).clearStorageData()
})
```

In `packages/desktop/electron/preload.cjs`, replace this exact block:

```js
  // <webview> by id so main can drive it over the DevTools protocol; main
  // asks for the pane when an agent tool needs a page and none is open.
  browserReady: (id) => {
    if (Number.isInteger(id)) ipcRenderer.send('harnessdesk:browser-ready', id)
  },
  browserGone: () => ipcRenderer.send('harnessdesk:browser-gone'),
  onBrowserShow: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, request) => handler({ url: typeof request?.url === 'string' ? request.url : 'about:blank' })
    ipcRenderer.on('harnessdesk:browser-show', listener)
    return () => ipcRenderer.removeListener('harnessdesk:browser-show', listener)
```

with:

```js
  // <webview> by id so main can drive it over the DevTools protocol; main
  // asks for the pane when an agent tool needs a page and none is open.
  browserReady: (request) => {
    if (Number.isInteger(request?.webContentsId) && (request.profile === null || typeof request.profile === 'string')) {
      ipcRenderer.send('harnessdesk:browser-ready', { profile: request.profile, webContentsId: request.webContentsId })
    }
  },
  browserGone: (request) => ipcRenderer.send('harnessdesk:browser-gone', request),
  browserFocused: (request) => {
    if (Number.isInteger(request)) ipcRenderer.send('harnessdesk:browser-focused', { request })
  },
  onBrowserShow: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, request) => handler({ profile: request?.profile ?? null, url: typeof request?.url === 'string' ? request.url : 'about:blank' })
    ipcRenderer.on('harnessdesk:browser-show', listener)
    return () => ipcRenderer.removeListener('harnessdesk:browser-show', listener)
```

In `packages/desktop/electron/preload.cjs`, replace this exact block:

```js
  onBrowserClose: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = () => handler()
    ipcRenderer.on('harnessdesk:browser-close', listener)
    return () => ipcRenderer.removeListener('harnessdesk:browser-close', listener)
  },
  // Before the tools act, the driven tab has to be the tab on screen:
  // Chromium stops rasterising a <webview> nobody is looking at.
  onBrowserFocus: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = () => handler()
    ipcRenderer.on('harnessdesk:browser-focus', listener)
    return () => ipcRenderer.removeListener('harnessdesk:browser-focus', listener)
```

with:

```js
  onBrowserClose: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, request) => handler({ profile: request?.profile ?? null })
    ipcRenderer.on('harnessdesk:browser-close', listener)
    return () => ipcRenderer.removeListener('harnessdesk:browser-close', listener)
  },
  onBrowserFocus: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, request) => handler({ profile: request?.profile ?? null, request: request?.request })
    ipcRenderer.on('harnessdesk:browser-focus', listener)
    return () => ipcRenderer.removeListener('harnessdesk:browser-focus', listener)
```

In `packages/desktop/electron/preload.cjs`, replace this exact block:

```js
      name: typeof name === 'string' ? name.slice(0, 200) : '',
    }),
  clearBrowserData: () => ipcRenderer.invoke('harnessdesk:browser-clear-data'),
  /**
   * The annotation overlay's calls, executed in an isolated world of one of
```

with:

```js
      name: typeof name === 'string' ? name.slice(0, 200) : '',
    }),
  clearBrowserData: (profile = null) => ipcRenderer.invoke('harnessdesk:browser-clear-data', { profile }),
  /**
   * The annotation overlay's calls, executed in an isolated world of one of
```

In `packages/desktop/electron/preload.cjs`, replace this exact block:

```js
    const listener = (_event, outcome) => {
      if (outcome && typeof outcome.name === 'string' && typeof outcome.path === 'string') {
        handler({ name: outcome.name, path: outcome.path, ok: outcome.ok === true, message: String(outcome.message ?? '') })
      }
    }
```

with:

```js
    const listener = (_event, outcome) => {
      if (outcome && typeof outcome.name === 'string' && typeof outcome.path === 'string') {
        handler({ name: outcome.name, path: outcome.path, ok: outcome.ok === true, message: String(outcome.message ?? ''), profile: outcome.profile ?? null })
      }
    }
```

In `packages/desktop/electron/preload.cjs`, replace this exact block:

```js
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, request) => {
      if (typeof request?.url === 'string') handler(request.url)
    }
    ipcRenderer.on('harnessdesk:browser-open-tab', listener)
```

with:

```js
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, request) => {
      if (typeof request?.url === 'string') handler({ url: request.url, profile: request.profile ?? null })
    }
    ipcRenderer.on('harnessdesk:browser-open-tab', listener)
```

In `packages/ui/src/lib/desktop.ts`, replace this exact block:

```ts
   * needs it. Absent in the browser build, where tools drive Chrome instead.
   */
  browserReady?(webContentsId: number): void
  browserGone?(): void
  onBrowserShow?(handler: (request: { url: string }) => void): () => void
  onBrowserClose?(handler: () => void): () => void
  /**
   * The shell asking for the driven tab to be brought forward, which it does
```

with:

```ts
   * needs it. Absent in the browser build, where tools drive Chrome instead.
   */
  browserReady?(request: { profile: string | null; webContentsId: number }): void
  browserGone?(request: { profile: string | null; webContentsId: number | null }): void
  browserFocused?(request: number): void
  onBrowserShow?(handler: (request: { profile: string | null; url: string }) => void): () => void
  onBrowserClose?(handler: (request: { profile: string | null }) => void): () => void
  /**
   * The shell asking for the driven tab to be brought forward, which it does
```

In `packages/ui/src/lib/desktop.ts`, replace this exact block:

```ts
   * looking at, so a backgrounded tab screenshots stale.
   */
  onBrowserFocus?(handler: () => void): () => void
  /**
   * Photographs one of the pane's tabs — named by `webContents` id, which
```

with:

```ts
   * looking at, so a backgrounded tab screenshots stale.
   */
  onBrowserFocus?(handler: (request: { profile: string | null; request: number }) => void): () => void
  /**
   * Photographs one of the pane's tabs — named by `webContents` id, which
```

In `packages/ui/src/lib/desktop.ts`, replace this exact block:

```ts
  saveBrowserScreenshot?(webContentsId: number, name: string): Promise<string | null>
  /** Empties the browser pane's persistent partition. */
  clearBrowserData?(): Promise<void>
  /**
   * Runs the annotation overlay's code in an *isolated world* of one of the
```

with:

```ts
  saveBrowserScreenshot?(webContentsId: number, name: string): Promise<string | null>
  /** Empties the browser pane's persistent partition. */
  clearBrowserData?(profile?: string | null): Promise<void>
  /**
   * Runs the annotation overlay's code in an *isolated world* of one of the
```

In `packages/ui/src/lib/desktop.ts`, replace this exact block:

```ts
  setBrowserLinksInPane?(inPane: boolean): void
  /** A link a page tried to open in a window of its own, to be shown as a tab. */
  onBrowserOpenTab?(handler: (url: string) => void): () => void
  /**
   * A download a page in the pane started has ended. The shell put it in the
```

with:

```ts
  setBrowserLinksInPane?(inPane: boolean): void
  /** A link a page tried to open in a window of its own, to be shown as a tab. */
  onBrowserOpenTab?(handler: (request: { url: string; profile: string | null }) => void): () => void
  /**
   * A download a page in the pane started has ended. The shell put it in the
```

In `packages/ui/src/lib/desktop.ts`, replace this exact block:

```ts
   * finished, for a notice to say.
   */
  onBrowserDownload?(handler: (outcome: { name: string; path: string; ok: boolean; message: string }) => void): () => void
  /** Shows a downloaded file in the Finder; the shell reveals only files it saved itself. */
  revealDownload?(path: string): void
```

with:

```ts
   * finished, for a notice to say.
   */
  onBrowserDownload?(handler: (outcome: { name: string; path: string; ok: boolean; message: string; profile: string | null }) => void): () => void
  /** Shows a downloaded file in the Finder; the shell reveals only files it saved itself. */
  revealDownload?(path: string): void
```

Append this complete pure UI helper to `packages/ui/src/lib/desktop.ts`. It validates syntax for rendering; main independently checks the persisted host ownership before accepting a guest.

```ts
export function browserPartition(profile: string | null, keep: boolean): string {
  if (profile === null) return keep ? 'persist:harnessdesk-browser' : 'harnessdesk-browser-once'
  if (!/^lane-[A-Za-z0-9-]{1,100}$/.test(profile) || profile.endsWith('\n')) throw new Error('The host did not name a lane browser profile.')
  return `persist:hd-${profile}`
}
```

- [ ] **Step 8: Key the whole BrowserView by profile, preserving mounted guests and history**

Each mounted BrowserPane already owns all of its transient state and DOM refs. Giving each profile a separate view therefore keys errors, address drafts, device settings, active/driven tab, history and page state together. The right dock keeps inactive views mounted. A lane pane does not infer its driver or expose a Stop target from the globally selected conversation: the current UI snapshot has no profile-to-invocation owner. It uses the existing generic browser-tool mark until the host provides such attribution. Workbench persistence already writes and reads each BrowserView; `readBrowser` must retain its profile. The default profile remains backward-compatible with old saved layouts. A malformed saved profile restores a blank default view instead of exposing its old pages in a different profile.

In `packages/ui/src/state/layout.ts`, replace this exact block:

```ts

export interface BrowserView {
  readonly kind: 'browser'
  /** Never empty: closing the last tab closes the pane. */
```

with:

```ts

export interface BrowserView {
  readonly profile?: string | null
  readonly kind: 'browser'
  /** Never empty: closing the last tab closes the pane. */
```

In `packages/ui/src/state/layout.ts`, replace this exact block:

```ts
      return a.path === (b as typeof a).path && a.runtime === (b as typeof a).runtime
    case 'browser':
      // There is one browser; a second "open" goes to it wherever it is.
      return true
    case 'git':
      // Belongs to a repository, so a second open re-points the pane rather
```

with:

```ts
      return a.path === (b as typeof a).path && a.runtime === (b as typeof a).runtime
    case 'browser':
      return (a.profile ?? null) === ((b as typeof a).profile ?? null)
    case 'git':
      // Belongs to a repository, so a second open re-points the pane rather
```

In `packages/ui/src/state/layout.ts`, replace this exact block:

```ts

/** A browser showing one page — what `openBrowser` starts from. */
export const browserView = (url: string = BLANK): BrowserView => {
  const tab = newBrowserTab(url)
  return { kind: 'browser', tabs: [tab], active: tab.id, driven: tab.id }
}

```

with:

```ts

/** A browser showing one page — what `openBrowser` starts from. */
export const browserView = (url: string = BLANK, profile: string | null = null): BrowserView => {
  const tab = newBrowserTab(url)
  return { kind: 'browser', ...(profile ? { profile } : {}), tabs: [tab], active: tab.id, driven: tab.id }
}

```

In `packages/ui/src/state/layout.ts`, replace this exact block:

```ts
 */
const readBrowser = (record: Record<string, unknown>): BrowserView => {
  const raw = Array.isArray(record['tabs']) ? record['tabs'] : []
  const tabs = raw.flatMap((entry): BrowserTab[] => {
```

with:

```ts
 */
const readBrowser = (record: Record<string, unknown>): BrowserView => {
  const profile = record['profile'] ?? null
  if (profile !== null && (typeof profile !== 'string' || !/^lane-[A-Za-z0-9-]{1,100}$/.test(profile) || profile.endsWith('\n'))) return browserView(BLANK)
  const raw = Array.isArray(record['tabs']) ? record['tabs'] : []
  const tabs = raw.flatMap((entry): BrowserTab[] => {
```

In `packages/ui/src/state/layout.ts`, replace this exact block:

```ts
    ]
  })
  if (tabs.length === 0) return browserView(typeof record['url'] === 'string' ? record['url'] : BLANK)
  const has = (id: unknown): id is string => typeof id === 'string' && tabs.some((tab) => tab.id === id)
  return {
    kind: 'browser',
    tabs,
    active: has(record['active']) ? record['active'] : tabs[0]!.id,
```

with:

```ts
    ]
  })
  if (tabs.length === 0) return browserView(typeof record['url'] === 'string' ? record['url'] : BLANK, profile)
  const has = (id: unknown): id is string => typeof id === 'string' && tabs.some((tab) => tab.id === id)
  return {
    kind: 'browser',
    ...(profile ? { profile } : {}),
    tabs,
    active: has(record['active']) ? record['active'] : tabs[0]!.id,
```

In `packages/ui/src/state/store.ts`, replace this exact block:

```ts
    // the tabs are kept and the next open brings them back. Only a tab's own
    // × discards a page, which is the one gesture that says so.
    if (view.kind === 'browser') this.#closedBrowser = view
  }

  /** The tabs the browser had when its pane last closed; see `#release`. */
  #closedBrowser: BrowserView | null = null

  // -------------------------------------------------------------------- tools
```

with:

```ts
    // the tabs are kept and the next open brings them back. Only a tab's own
    // × discards a page, which is the one gesture that says so.
    if (view.kind === 'browser') this.#closedBrowsers.set(view.profile ?? 'default', view)
  }

  /** The tabs the browser had when its pane last closed; see `#release`. */
  readonly #closedBrowsers = new Map<string, BrowserView>()

  // -------------------------------------------------------------------- tools
```

In `packages/ui/src/state/store.ts`, replace this exact block:

```ts
   * edge, where a page being *referred to* belongs.
   */
  #browserPane(): { readonly id: string; readonly view: BrowserView } | null {
    const found = findViewIn(this.#snapshot.workbench, browserView(BLANK))
    if (!found) return null
    const id = found.area === 'main' ? found.pane : found.mounted.id
```

with:

```ts
   * edge, where a page being *referred to* belongs.
   */
  #browserPane(profile: string | null = null): { readonly id: string; readonly view: BrowserView } | null {
    const found = findViewIn(this.#snapshot.workbench, browserView(BLANK, profile))
    if (!found) return null
    const id = found.area === 'main' ? found.pane : found.mounted.id
```

In `packages/ui/src/state/store.ts`, replace this exact block:

```ts
   * hidden behind another would screenshot as a stale frame.
   */
  openBrowser(url?: string, options: { readonly split?: Split['direction'] | null } = {}): void {
    const existing = this.#browserPane()
    const sendDriven = (view: BrowserView): BrowserView => {
      if (!url) return view
```

with:

```ts
   * hidden behind another would screenshot as a stale frame.
   */
  openBrowser(url?: string, options: { readonly split?: Split['direction'] | null; readonly profile?: string | null } = {}): void {
    const profile = options.profile ?? null
    if (profile !== null && (!/^lane-[A-Za-z0-9-]{1,100}$/.test(profile) || profile.endsWith('\n'))) throw new Error('Invalid browser profile.')
    const existing = this.#browserPane(profile)
    const sendDriven = (view: BrowserView): BrowserView => {
      if (!url) return view
```

In `packages/ui/src/state/store.ts`, replace this exact block:

```ts
    // reopening it, which then navigates the driven tab as usual rather
    // than landing on top of whatever the person was reading.
    const restored = this.#closedBrowser
    this.#closedBrowser = null
    const view = sendDriven(restored ?? browserView(BLANK))
    // An explicit split is still a split — `/browser --split` and the pane
    // menu both mean the middle. Otherwise it goes where its definition says,
```

with:

```ts
    // reopening it, which then navigates the driven tab as usual rather
    // than landing on top of whatever the person was reading.
    const restored = this.#closedBrowsers.get(profile ?? 'default')
    this.#closedBrowsers.delete(profile ?? 'default')
    const view = sendDriven(restored ?? browserView(BLANK, profile))
    // An explicit split is still a split — `/browser --split` and the pane
    // menu both mean the middle. Otherwise it goes where its definition says,
```

In `packages/ui/src/state/store.ts`, replace this exact block:

```ts

  /** Brings the driven tab to the front, before the tools act on it. */
  focusDrivenBrowserTab(): void {
    const pane = this.#browserPane()
    if (!pane) return
    // A browser hidden behind another pane's expansion cannot paint, and a
    // frozen webview screenshots as a stale frame — the tools are about to
```

with:

```ts

  /** Brings the driven tab to the front, before the tools act on it. */
  focusDrivenBrowserTab(profile: string | null = null): void {
    const pane = this.#browserPane(profile)
    if (!pane) return
    this.revealView(pane.id)
    // A browser hidden behind another pane's expansion cannot paint, and a
    // frozen webview screenshots as a stale frame — the tools are about to
```

In `packages/ui/src/state/store.ts`, replace this exact block:

```ts
   * because this is an undo for a slip, not a second history.
   */
  #closedTabs: BrowserTab[] = []

  /** Puts back the last tab closed by its ×, on the page it was on. */
  reopenClosedBrowserTab(paneId: PaneId): void {
    const last = this.#closedTabs.pop()
    if (!last) return
    this.#patchBrowser(paneId, (view) => addBrowserTab(view, last.url))
```

with:

```ts
   * because this is an undo for a slip, not a second history.
   */
  readonly #closedTabs = new Map<string, BrowserTab[]>()

  /** Puts back the last tab closed by its ×, on the page it was on. */
  reopenClosedBrowserTab(paneId: PaneId): void {
    const view = viewAt(this.#snapshot.workbench, paneId)
    if (view?.kind !== 'browser') return
    const last = this.#closedTabs.get(view.profile ?? 'default')?.pop()
    if (!last) return
    this.#patchBrowser(paneId, (view) => addBrowserTab(view, last.url))
```

In `packages/ui/src/state/store.ts`, replace this exact block:

```ts

  get hasClosedBrowserTabs(): boolean {
    return this.#closedTabs.length > 0
  }

```

with:

```ts

  get hasClosedBrowserTabs(): boolean {
    return (this.#closedTabs.get('default')?.length ?? 0) > 0
  }

```

In `packages/ui/src/state/store.ts`, replace this exact block:

```ts
    if (closing?.kind === 'browser') {
      const tab = closing.tabs.find((entry) => entry.id === tabId)
      if (tab && tab.url !== BLANK) this.#closedTabs = [...this.#closedTabs.slice(-9), tab]
    }
    this.#patchBrowser(paneId, (view) => removeBrowserTab(view, tabId))
    // That last tab was closed on purpose, so unlike closing the panel there
    // is nothing to bring back — `#release` will have kept it otherwise.
    if (!this.#browserPane()) this.#closedBrowser = null
  }

```

with:

```ts
    if (closing?.kind === 'browser') {
      const tab = closing.tabs.find((entry) => entry.id === tabId)
      if (tab && tab.url !== BLANK) {
        const key = closing.profile ?? 'default'
        this.#closedTabs.set(key, [...(this.#closedTabs.get(key) ?? []).slice(-9), tab])
      }
    }
    this.#patchBrowser(paneId, (view) => removeBrowserTab(view, tabId))
    // That last tab was closed on purpose, so unlike closing the panel there
    // is nothing to bring back — `#release` will have kept it otherwise.
    if (closing?.kind === 'browser' && !this.#browserPane(closing.profile ?? null)) this.#closedBrowsers.delete(closing.profile ?? 'default')
  }

```

In `packages/ui/src/state/store.ts`, replace this exact block:

```ts
  }

  closeBrowser(): void {
    const existing = this.#browserPane()
    if (!existing) return
    // A pane in the middle or a view in a dock: `closePane` knows only the
```

with:

```ts
  }

  closeBrowser(profile: string | null = null): void {
    const existing = this.#browserPane(profile)
    if (!existing) return
    // A pane in the middle or a view in a dock: `closePane` knows only the
```

In `packages/ui/src/state/store.ts`, replace this exact block:

```ts
    // Pages belong to the project they were opened for: a browser closed in
    // one workspace must not reappear in the next one.
    this.#closedBrowser = null
    // The terminals of a document written before the bottom panel existed. The
    // processes are still running on the host, so they are re-docked rather
```

with:

```ts
    // Pages belong to the project they were opened for: a browser closed in
    // one workspace must not reappear in the next one.
    this.#closedBrowsers.clear()
    this.#closedTabs.clear()
    // The terminals of a document written before the bottom panel existed. The
    // processes are still running on the host, so they are re-docked rather
```

In `packages/ui/src/state/snapshot.ts`, replace this exact anchor:

```ts
    /** Guests use a persistent partition, so logins survive a restart. */
```

with:

```ts
    /** Default-profile guests use a persistent partition when enabled; lane profiles are independently retained. */
```

In `packages/ui/src/app/App.tsx`, replace this exact block:

```tsx
  useEffect(() => {
    const bridge = desktop()
    const offShow = bridge?.onBrowserShow?.(({ url }) => store.openBrowser(url === 'about:blank' ? undefined : url)) ?? (() => {})
    const offClose = bridge?.onBrowserClose?.(() => store.closeBrowser()) ?? (() => {})
    const offFocus = bridge?.onBrowserFocus?.(() => store.focusDrivenBrowserTab()) ?? (() => {})
    // A download a page started lands in the Downloads folder; the notice
    // says so, and offers the file. Listened for here rather than in the
```

with:

```tsx
  useEffect(() => {
    const bridge = desktop()
    const offShow = bridge?.onBrowserShow?.(({ url, profile }) => store.openBrowser(url === 'about:blank' ? undefined : url, { profile })) ?? (() => {})
    const offClose = bridge?.onBrowserClose?.(({ profile }) => store.closeBrowser(profile)) ?? (() => {})
    const offFocus = bridge?.onBrowserFocus?.(({ profile, request }) => {
      store.focusDrivenBrowserTab(profile)
      requestAnimationFrame(() => requestAnimationFrame(() => bridge.browserFocused?.(request)))
    }) ?? (() => {})
    // A download a page started lands in the Downloads folder; the notice
    // says so, and offers the file. Listened for here rather than in the
```

In `packages/ui/src/components/BrowserPane.tsx`, replace this exact block:

```tsx
import { handOverToComposer, type ComposeRequest } from '../lib/compose'
import { noteKey, wrapContext } from '../lib/context-envelope'
import { desktop, hasInlineBrowser, openExternal } from '../lib/desktop'
import { bareToolName, toolsOfPlugin, toolWords } from '../lib/tool-names'
import { useSnapshot, useStore } from '../state/context'
```

with:

```tsx
import { handOverToComposer, type ComposeRequest } from '../lib/compose'
import { noteKey, wrapContext } from '../lib/context-envelope'
import { browserPartition, desktop, hasInlineBrowser, openExternal } from '../lib/desktop'
import { bareToolName, toolsOfPlugin, toolWords } from '../lib/tool-names'
import { useSnapshot, useStore } from '../state/context'
```

In `packages/ui/src/components/BrowserPane.tsx`, replace this exact block:

```tsx
     which kind it is; that is what let the browser leave the middle. */
  const paneId = mount?.id ?? null
  const inline = hasInlineBrowser()
  const prefs = snapshot.browserPrefs
  const driving = useDriving()

  /** The runtime of the conversation beside this pane, for the driven mark. */
```

with:

```tsx
     which kind it is; that is what let the browser leave the middle. */
  const paneId = mount?.id ?? null
  const profile = view?.profile ?? null
  const inline = hasInlineBrowser()
  const prefs = snapshot.browserPrefs
  const observedDriving = useDriving()
  const driving = profile === null ? observedDriving : null

  /** The runtime of the conversation beside this pane, for the driven mark. */
```

In `packages/ui/src/components/BrowserPane.tsx`, replace this exact block:

```tsx
   * Claude Code that put "Codex" on a tab Codex has never touched.
   */
  const namedDriver = driving?.info ?? activeRuntime

  const tab = view ? activeBrowserTab(view) : null
```

with:

```tsx
   * Claude Code that put "Codex" on a tab Codex has never touched.
   */
  const namedDriver = profile === null ? driving?.info ?? activeRuntime : null

  const tab = view ? activeBrowserTab(view) : null
```

In `packages/ui/src/components/BrowserPane.tsx`, replace this exact block:

```tsx
  // Sessions are kept or not; either way the guests are the app's own, never
  // the person's Chrome profile.
  const partition = prefs.persistSession ? 'persist:harnessdesk-browser' : 'harnessdesk-browser-once'

  const register = useCallback((tabId: string, element: WebviewElement | null, ready: () => boolean) => {
```

with:

```tsx
  // Sessions are kept or not; either way the guests are the app's own, never
  // the person's Chrome profile.
  const partition = browserPartition(profile, prefs.persistSession)

  const register = useCallback((tabId: string, element: WebviewElement | null, ready: () => boolean) => {
```

In `packages/ui/src/components/BrowserPane.tsx`, replace this exact block:

```tsx
    if (id === undefined || id === reported.current) return
    reported.current = id
    desktop()?.browserReady?.(id)
  })

```

with:

```tsx
    if (id === undefined || id === reported.current) return
    reported.current = id
    desktop()?.browserReady?.({ profile, webContentsId: id })
  })

```

In `packages/ui/src/components/BrowserPane.tsx`, replace this exact block:

```tsx
    if (!inline) return
    const bridge = desktop()
    return () => bridge?.browserGone?.()
  }, [inline])

  // A page's `target=_blank` is handled in the shell, which either hands the
```

with:

```tsx
    if (!inline) return
    const bridge = desktop()
    return () => bridge?.browserGone?.({ profile, webContentsId: reported.current })
  }, [inline, profile])

  // A page's `target=_blank` is handled in the shell, which either hands the
```

In `packages/ui/src/components/BrowserPane.tsx`, replace this exact block:

```tsx
  useEffect(() => {
    if (!paneId) return
    return desktop()?.onBrowserOpenTab?.((url) => store.newBrowserTab(paneId, url))
  }, [paneId, store])

  // While the person is typing, the bar is theirs; otherwise it follows the
```

with:

```tsx
  useEffect(() => {
    if (!paneId) return
    return desktop()?.onBrowserOpenTab?.((request) => {
      if (request.profile === profile) store.newBrowserTab(paneId, request.url)
    })
  }, [paneId, profile, store])

  // While the person is typing, the bar is theirs; otherwise it follows the
```

In `packages/ui/src/components/BrowserPane.tsx`, replace this exact block:

```tsx
                onSelect={() => {
                  void desktop()
                    ?.clearBrowserData?.()
                    .then(() => store.notice('info', 'The browser pane’s cookies and storage were cleared.'))
                    .catch((error: unknown) =>
```

with:

```tsx
                onSelect={() => {
                  void desktop()
                    ?.clearBrowserData?.(profile)
                    .then(() => store.notice('info', 'The browser pane’s cookies and storage were cleared.'))
                    .catch((error: unknown) =>
```

In `packages/ui/src/components/BrowserPane.tsx`, replace this exact block:

```tsx
        {tabs.map((entry) => (
          <BrowserTabPage
            key={entry.id}
            tab={entry}
            active={entry.id === view.active}
```

with:

```tsx
        {tabs.map((entry) => (
          <BrowserTabPage
            key={`${profile ?? 'default'}:${entry.id}`}
            tab={entry}
            active={entry.id === view.active}
```

In `packages/ui/src/components/BrowserPane.test.tsx`, replace this exact block:

```tsx

  it('names the driven tab to the shell, not whichever tab is on screen', () => {
    const named: number[] = []
    ;(window as { harnessdesk?: Partial<DesktopBridge> }).harnessdesk = {
      platform: 'darwin',
      browserReady: (id: number) => named.push(id),
      browserGone: () => {},
      setBrowserLinksInPane: () => {},
```

with:

```tsx

  it('names the driven tab to the shell, not whichever tab is on screen', () => {
    const named: { profile: string | null; webContentsId: number }[] = []
    ;(window as { harnessdesk?: Partial<DesktopBridge> }).harnessdesk = {
      platform: 'darwin',
      browserReady: request => named.push(request),
      browserGone: () => {},
      setBrowserLinksInPane: () => {},
```

In `packages/ui/src/components/BrowserPane.test.tsx`, replace this exact block:

```tsx
      guests[0]!.dispatchEvent(new Event('dom-ready'))
    })
    expect(named).toEqual([11])
  })
```

with:

```tsx
      guests[0]!.dispatchEvent(new Event('dom-ready'))
    })
    expect(named).toEqual([{ profile: null, webContentsId: 11 }])
  })
```

- [ ] **Step 9: Test persisted views, UI guests and the real supervised browser gateway**

**`packages/ui/src/components/BrowserPane.lanes.test.tsx`**

```ts
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { AppStore, emptySnapshot } from '../state/store'
import { browserView, readView, sameView, type BrowserView } from '../state/layout'
import { findView, viewAt } from '../state/workbench'
import { MountProvider } from '../panels/mount'
import { browserPartition, type DesktopBridge } from '../lib/desktop'
import { BrowserPane } from './BrowserPane'
import '../panels/builtins'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function locate(store: AppStore, profile: string | null) {
  const workbench = store.getSnapshot().workbench
  const found = findView(workbench, browserView('about:blank', profile))
  if (!found) return null
  const id = found.area === 'main' ? found.pane : found.mounted.id
  return { id, view: viewAt(workbench, id) as BrowserView }
}

test('profile switching, close and reopen preserve independent tab sets and the default', () => {
  const store = new AppStore('ws://localhost:0/')
  store.openBrowser('https://example.com/plain')
  store.openBrowser('https://example.com/a', { profile: 'lane-a' })
  store.openBrowser('https://example.com/b', { profile: 'lane-b' })
  const a = locate(store, 'lane-a')!
  const b = locate(store, 'lane-b')!
  expect(a.id).not.toBe(b.id)
  store.newBrowserTab(a.id, 'https://example.com/a2')
  store.focusDrivenBrowserTab('lane-a')
  expect(locate(store, 'lane-a')!.view.active).toBe(a.view.driven)
  store.closeBrowser('lane-b')
  expect(locate(store, 'lane-b')).toBeNull()
  expect(locate(store, 'lane-a')!.view.tabs).toHaveLength(2)
  store.openBrowser(undefined, { profile: 'lane-b' })
  expect(locate(store, 'lane-b')!.view.tabs[0]!.url).toBe('https://example.com/b')
  expect(locate(store, null)!.view.tabs[0]!.url).toBe('https://example.com/plain')
  store.closeBrowserTab(a.id, locate(store, 'lane-a')!.view.tabs[1]!.id)
  store.reopenClosedBrowserTab(b.id)
  expect(locate(store, 'lane-b')!.view.tabs).toHaveLength(1)
})

test('saved views retain profile identity and malformed keys never restore old pages into default', () => {
  const a = browserView('https://example.com/a', 'lane-a')
  expect(readView(JSON.parse(JSON.stringify(a)))).toEqual(a)
  expect(sameView(a, browserView('https://example.com/a', 'lane-b'))).toBe(false)
  expect(sameView(browserView(), { kind: 'browser', tabs: [], active: '', driven: '' })).toBe(true)
  const invalid = readView({ ...a, profile: '../personal' }) as BrowserView
  expect(invalid.profile).toBeUndefined()
  expect(invalid.tabs[0]!.url).toBe('about:blank')
  expect(browserPartition('lane-a', false)).toBe('persist:hd-lane-a')
})

test('simultaneously mounted panes announce separate guest identities and partitions', () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const snapshot = emptySnapshot()
  const named: { profile: string | null; webContentsId: number }[] = []
  const original = window.harnessdesk
  window.harnessdesk = { platform: 'darwin', browserReady: request => named.push(request), browserGone: vi.fn(),
    setBrowserLinksInPane: vi.fn() } as unknown as DesktopBridge
  const store = { getSnapshot: () => snapshot, subscribe: () => () => {}, noteBrowserTitle: vi.fn(),
    noteBrowserUrl: vi.fn(), notice: vi.fn() } as unknown as AppStore
  try {
    act(() => root.render(<StoreProvider store={store}>{['lane-a', 'lane-b'].map(profile =>
      <MountProvider key={profile} scope={{ area: 'right', id: profile, view: browserView('https://example.com/', profile) }}>
        <BrowserPane />
      </MountProvider>)}</StoreProvider>))
    const guests = [...container.querySelectorAll<HTMLElement>('webview')]
    expect(guests.map(guest => guest.getAttribute('partition'))).toEqual(['persist:hd-lane-a', 'persist:hd-lane-b'])
    act(() => guests.forEach((guest, index) => {
      Object.assign(guest, { getWebContentsId: () => index + 1 })
      guest.dispatchEvent(new Event('dom-ready'))
    }))
    expect(named).toEqual([{ profile: 'lane-a', webContentsId: 1 }, { profile: 'lane-b', webContentsId: 2 }])
  } finally {
    act(() => root.unmount())
    container.remove()
    if (original) window.harnessdesk = original
    else delete window.harnessdesk
  }
})
```

Append this complete test to `packages/extension-host/test/isolation.test.ts`; its `assert`, `cp`, `mkdtemp`, `rm`, `join`, `tmpdir`, `FIXTURES`, `ExtensionKernel` and `SupervisedExtensionHost` imports/constants already exist. It uses the existing `plugin-browser` fixture and actual child IPC.

```ts
test('concurrent child browser invocations keep the host-resolved lane, refusing an unscoped call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-browser-lanes-'))
  const store = join(dir, 'plugins')
  await cp(join(FIXTURES, 'plugin-browser'), join(store, 'browserish'), { recursive: true })
  const profiles: string[] = []
  const host = new SupervisedExtensionHost(new ExtensionKernel(), {
    invokeTimeoutMs: 5000,
    env: { HARNESSDESK_PLUGINS: store },
    browserEngine: {
      async ensure(identity) {
        assert.ok(identity)
        const profile = identity.profile
        profiles.push(profile)
        await Promise.resolve()
        return {
          async send(method, params) {
            if (method === 'Page.captureScreenshot') return { data: Buffer.from(profile).toString('base64') }
            if (method === 'Runtime.evaluate') {
              const expression = String(params?.['expression'] ?? '')
              return { result: { value: expression.startsWith('JSON.stringify')
                ? JSON.stringify({ url: 'https://example.com/', title: profile }) : profile } }
            }
            return {}
          },
          drain: async () => [],
        }
      },
      async close(identity) { assert.ok(identity) },
    },
  })
  host.setBrowserResolver(scope => scope.sessionId === 'a' ? 'lane-a' : scope.sessionId === 'b' ? 'lane-b' : undefined)
  try {
    await host.loadInstalledPlugins()
    const tool = host.list('tool').find(entry => entry.name === 'look')!
    assert.ok(tool)
    const results = await Promise.all(['a', 'b'].map(sessionId => host.invokeTool(tool.id, { url: 'https://example.com/' }, { sessionId: sessionId as SessionId })))
    assert.ok(results.every(result => result.ok), JSON.stringify(results))
    assert.match(JSON.stringify(results[0]), /lane-a/)
    assert.doesNotMatch(JSON.stringify(results[0]), /lane-b/)
    assert.match(JSON.stringify(results[1]), /lane-b/)
    const before = profiles.length
    const refused = await host.invokeTool(tool.id, {}, {})
    assert.equal(refused.ok, false)
    assert.equal(profiles.length, before)
  } finally {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
```

In `packages/desktop/electron/ipc-channels.test.mjs`, replace this exact block:

```js
const read = (name) => readFileSync(join(here, name), 'utf8')

const main = [read('main.mjs'), read('browser-engine.mjs')].join('\n')
const preload = read('preload.cjs')

```

with:

```js
const read = (name) => readFileSync(join(here, name), 'utf8')

const main = [read('main.mjs'), read('browser-engine.mjs'), read('browser-scopes.mjs').replaceAll('ipc.on(', 'ipcMain.on(')].join('\n')
const preload = read('preload.cjs')

```

In `packages/desktop/electron/ipc-channels.test.mjs`, replace this exact block:

```js
  // Named rather than counted, so removing one is a failing test and not a
  // quietly smaller number.
  for (const channel of ['harnessdesk:browser-ready', 'harnessdesk:browser-gone', 'harnessdesk:browser-links']) {
    assert.ok(mainReceives.includes(channel), `${channel} is not handled in the shell`)
  }
```

with:

```js
  // Named rather than counted, so removing one is a failing test and not a
  // quietly smaller number.
  for (const channel of ['harnessdesk:browser-ready', 'harnessdesk:browser-gone', 'harnessdesk:browser-focused', 'harnessdesk:browser-links']) {
    assert.ok(mainReceives.includes(channel), `${channel} is not handled in the shell`)
  }
```

In `packages/desktop/electron/ipc-channels.test.mjs`, replace this exact block:

```js
})

test('the shell fronts the driven tab before it drives it', () => {
  // Chromium stops rasterising a <webview> nobody is looking at, so a driven
  // tab left behind another screenshots stale. `ensure` is the one place
  // every tool command passes through.
  const engine = read('browser-engine.mjs')
  const ensure = engine.slice(engine.indexOf('async ensure()'))
  assert.match(ensure.slice(0, 200), /front\(\)/, 'ensure() must front the driven tab')
})
```

with:

```js
})

test('the shell awaits a fronted profile before sending a command', () => {
  const engine = read('browser-scopes.mjs')
  const send = engine.slice(engine.indexOf('send: (method, params) => serial'))
  assert.match(send, /await front\(profile\)/)
  assert.ok(send.indexOf('await front(profile)') < send.indexOf('sendCommand(method'))
  assert.match(engine, /event.sender === currentWindow\(\)\?\.webContents/)
  assert.match(engine, /wc.hostWebContents !== currentWindow\(\)\?\.webContents/)
  assert.match(engine, /wc.session === sessionForPartition/)
})
```

Run: `pnpm run build:node && node --test --test-reporter=spec packages/cordis-host/dist/test/browser-scopes.test.js packages/extension-host/dist/test/isolation.test.js packages/desktop/electron/browser-scopes.test.mjs packages/desktop/electron/ipc-channels.test.mjs`

Expected: PASS — new scope/desktop/gateway tests and every pre-existing isolation/IPC assertion. Do not remove an old permission or sender assertion to make the new payload pass.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/BrowserPane.lanes.test.tsx src/components/BrowserPane.test.tsx src/state/store.browser.test.ts`

Expected: PASS — 3 new lane UI cases plus the existing browser suites. The planning copy executed neither the production gateway suite nor this UI suite; those require the preceding implementations and package installation.

- [ ] **Step 10: Prove a shared map and an unbound sender are detected**

In `BrowserScopes.current()`, temporarily replace `identity?.profile ?? 'default'` with `'default'`.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/cordis-host/dist/test/browser-scopes.test.js`

Expected: FAIL — the concurrent state assertion observes both lane names in the same array. Restore Step 2 and rerun the identical command: PASS — 5 tests.

In `createProfileBrowserEngine.ensure`, temporarily use the first guest in `guests.values()` instead of `guests.get(key)`.

Run: `node --test --test-reporter=spec packages/desktop/electron/browser-scopes.test.mjs`

Expected: FAIL — B is refused as a guest in the wrong profile before a CDP command can cross the boundary. Restore Step 6 and rerun the identical command: PASS — 4 tests. The production sender test also asserts profile fronting, so deleting the `await front(profile)` line must fail its visible-profile assertion.

- [ ] **Step 11: Observe real storage and profile lifetime in Electron**

**`packages/ui/src/preview/browser-lanes.html`**

```html
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lane storage probe</title>
<body>
<h1>Lane storage probe</h1>
<p>Profile: <output id="lane"></output></p>
<p>Local count: <output id="count"></output></p>
<p>Cookie count: <output id="cookie"></output></p>
<button id="increment" type="button">Increment this profile</button>
<script>
const lane = new URL(location.href).searchParams.get('lane') || 'default';
document.title = 'Lane ' + lane;
document.querySelector('#lane').textContent = lane;
function show() {
  document.querySelector('#count').textContent = localStorage.getItem('lane-count') || '0';
  document.querySelector('#cookie').textContent = document.cookie.split('; ').find(value => value.startsWith('lane-count='))?.split('=')[1] || '0';
}
document.querySelector('#increment').onclick = () => {
  const next = String(Number(localStorage.getItem('lane-count') || 0) + 1);
  localStorage.setItem('lane-count', next);
  document.cookie = 'lane-count=' + next + '; Path=/; SameSite=Lax';
  show();
};
show();
</script>
</body>
</html>
```

Use the isolated fake-agent rig with two synthetic Goal Seats from the same repository and default lane preferences. Serve `packages/ui/src/preview` on a loopback listener shared only by this test. In both Seats, invoke the registered browser tool through the host's actual gateway to open `/browser-lanes.html?lane=A` and `/browser-lanes.html?lane=B` on that same origin. Do not call Electron's engine directly for this sitting.

Record this evidence table with the exact head, commands, observed text and screenshot paths; these are acceptance assertions, not a claim they ran while writing this plan:

| Action | Required observation |
|---|---|
| Increment A once; read B | A has local/cookie `1/1`; B has `0/0` |
| Concurrent CDP title and screenshot requests from A and B | A returns `Lane A` and its own frame; B returns `Lane B` and its own frame; the fronted dock view follows each command |
| Open another tab in A, select it, then drive B | A retains both tabs and its driven mark; B's tab set and history remain independent |
| Close B with `browser_close`, then read A | A remains open with `1/1`; closing B cannot drain A's events or clear its profile |
| Restart the desk and resume the retained A/B Seats | A restores `1/1`; B restores `0/0`; neither inherits the default profile |
| Turn lane browser isolation off, create a new lane | The machine preference shows the shared-browser consequence; the new lane uses only the default partition; existing A/B descriptors are unchanged |
| Open a plain conversation and its browser | Its previous default tabs and the persistent/once preference behave as before |
| Switch Pages open to a separate window | Two lane Chrome processes use distinct `browser-profiles/<opaque key>` directories; `HARNESSDESK_BROWSER_PROFILE` cannot redirect them into default |
| Request an unknown key or forged `browser-ready` guest | Refused before CDP is attached or a lane cookie is read |

Inspect light, dark and 680px-wide frames using the synthetic rig. The browser uses existing dock chrome and controls; no alternate overlay or font scale is introduced. Check the dock strip, active/driven mark, error state and default-profile settings. Keep every real account out of public captures. These Electron frames were not captured by the plan writer.

- [ ] **Step 12: Commit the verified implementation**

Run: `pnpm verify`

Expected: Exit 0, unpiped, before the implementation commit. The plan writer does not run this listener-dependent gate or make this commit.

```bash
git add packages/cordis-host/src/browser-scopes.ts packages/cordis-host/test/browser-scopes.test.ts packages/cordis-host/src/browser.ts packages/cordis-host/src/kernel.ts packages/cordis-host/src/context.ts packages/cordis-host/src/index.ts packages/extension-protocol/src/index.ts packages/extension-host/src/child.ts packages/extension-host/src/supervisor.ts packages/extension-host/test/isolation.test.ts packages/server/src/host.ts packages/desktop/electron/browser-scopes.mjs packages/desktop/electron/browser-scopes.test.mjs packages/desktop/electron/browser-engine.mjs packages/desktop/electron/main.mjs packages/desktop/electron/preload.cjs packages/desktop/electron/ipc-channels.test.mjs packages/ui/src/lib/desktop.ts packages/ui/src/components/BrowserPane.tsx packages/ui/src/components/BrowserPane.test.tsx packages/ui/src/components/BrowserPane.lanes.test.tsx packages/ui/src/state/store.ts packages/ui/src/state/layout.ts packages/ui/src/state/snapshot.ts packages/ui/src/app/App.tsx packages/ui/src/preview/browser-lanes.html
git commit -m "feat(agents): isolate browser state by lane invocation" -m "Co-Authored-By: Codex <agent@harnessdesk.app>"
```

### Task 7: Move the guarded channel and add event-driven member waiting

**Goal:** Address members by recorded Agent/seat names inside their Goal and wait for a specific running turn without sending a message or starting another turn. Preserve every existing channel guard.

**Files:**
- Create `packages/server/src/goals/member-waits.ts` — captured-turn wait registry.
- Modify `packages/server/src/goals/members.ts` — export `memberNames`; names never create membership.
- Modify `packages/server/src/team.ts` — `#caller`, `#nameOn`, `send`, `deliverHeld`, `onTurnEnded`, and new `awaitMember`.
- Modify `packages/server/src/host.ts` — TeamEngine adapter, runtime completion/detach/caller cancellation and shutdown wiring.
- Modify `packages/cordis-host/src/team.ts`, `context.ts` — `TeamEngine`, `TeamService`, public `ctx.team` contract and existing permission gate.
- Modify `packages/plugins/src/team.ts` — register `await_member` beside `await_work`.
- Modify `packages/extension-host/src/child.ts`, `supervisor.ts` — `remoteTeamEngine` forwarding and authenticated `team/awaitMember` dispatch.
- Create `packages/server/test/goal-member-waits.test.ts`, `goal-team-guards.test.ts` — registry and actual Team behavior.
- Modify `packages/server/test/team.test.ts` — Task 3's Seat-backed fixture; preserve existing assertions.
- Modify `packages/cordis-host/test/permissions.test.ts`, `packages/plugins/test/plugins.test.ts`, `packages/extension-host/test/isolation.test.ts` — permission, registration and child-attribution coverage.

**Interfaces:** Consumes Task 3's `goalMembers`, `GoalPlane.canDispatch`, Seat-backed Team and shared dispatch guard. Public signatures remain as promised; the extension IPC method is internal, not a renderer wire method.

```ts
// Consumes (@harnessdesk/protocol and goals/members.ts).
declare function goalMembers(document: GoalDocument, seats: readonly SeatRecord[]): SeatRecord[]
// Produces (goals/members.ts).
declare function memberNames(
  seats: readonly SeatRecord[], legacy?: Readonly<Record<string, string>>,
): Map<string, string>
// Team; TeamEngine uses TeamScope in the corresponding position.
interface Team {
awaitMember(scope: TeamCallScope, options: {
  member: string; cycle?: number; blockMs?: number
}): Promise<string>
}
interface TeamEngine {
  awaitMember(scope: TeamScope, options: { member: string; cycle?: number; blockMs?: number }): Promise<string>
}
// TeamService and ctx.team; ScopeQuery is the existing invocation scope.
interface TeamService {
awaitMember(options: {
  member: string; cycle?: number; blockMs?: number
}, scope?: ScopeQuery): Promise<string>
}
// Registered tool arguments; no caller/Goal/turn selector is accepted.
type AwaitMemberArguments = { member: string; cycle?: number; block_ms?: number }
```

`MemberStatus` and the complete `MemberWaits` interface/implementation are below. `member`/`caller` inside the registry are Seat IDs, not labels. Use one registry per Goal; keep the captured turn and all cancellation state in memory only.

**Decisions and invariants:**
- Resolve `#caller(scope)` through host correlation first. Lookup names only among that caller's current kept Goal Seats. Missing/outside member returns `gone; cycle: N`; self-wait refuses “Choose another member; a turn cannot wait for itself.” Ambiguity lists only reachable names.
- Sort Seats by `openedAt`, then ID. Base label is recorded Agent name, otherwise the migrated nickname keyed by Seat ID, otherwise `seatLabel`. Duplicate base labels append ` · <seatLabel>`; number remaining collisions starting at 2, checking the entire already-used label set. Preserve historical channel labels/envelopes unchanged.
- Validate cycle as nonnegative safe integer strictly below `MAX_SAFE_INTEGER`; block range is 1000–50000 ms, default 50000. Reject invalid numbers rather than clamp silently. All replies are one line with `; cycle: N` and only idle/stopped/still working/gone prefixes.
- Register and snapshot synchronously. Read the actual `SessionRecord.running` turn ID once; multiple IDs refuse with “This member has more than one running turn; wait after one finishes.” An existing unopened idle Seat answers idle without resuming it.
- At most 128 pending waits per Goal and one per live host invocation; refuse excess with “This Goal already has 128 member waits” or “This invocation is already waiting for a member”. Enforce after immediate replies are considered, before a timer is created. Invocation identity comes from the host, never tool arguments.
- Terminal completion calls `ended` before queue/flow rearming; a transient retry is not terminal. Member or caller removal calls `gone`. Caller turn cancellation calls `cancel`; runtime detach ends the captured turn with its actual refusal. Wrapping/shutdown closes relevant registries. Pass its host-owned AbortSignal as the optional fifth `wait` argument; disposing one invocation aborts only its own wait, while `cancel(caller)` ends all waits for a caller turn. Disposing an invocation removes its pending registration; no timer outlives cancellation.
- Add the child proxy/supervisor case under the existing live-invocation/plugin grant checks. Forward `blockMs`, not a fresh timeout; a blocked child call remains attributed until settlement. Neither wait path calls send, steer, resumeSession, agent_message, claimNext or any polling loop.
- Keep `wrapContext`/`AGENT_MESSAGE_NOTICE`; the escaped source label names recorded Agent, actual seatLabel, standing/ceiling words and Goal sentence. Unknown legacy ceilings say “ceiling not recorded”; preserve phase-3 turn-cause provenance when present.
- Both queued drain and held delivery revalidate original Goal, sender/receiver kept Seat IDs and `canDispatch` after async preparation. Release refuses undelivered mail. Answers stay `shown`; no forwarding loop or conversion of message prose into evidence.
- Preserve size default 16000 (settings 200–200000), pair rate 4/60000 ms (settings 1–60), duplicate accepted text window 600000 ms, pending cap 8 per receiver. Refusals do not spend accepted-message budgets; held messages do.
- Retain all five delivery states, denied-in-turn holds, inbound accept/hold/refuse, board-only audit, user queue precedence, wake capability check, detached-runtime refusal and restart refusal of queued rows. Phase 3's sender-ceiling rule remains authoritative.

**Proven hard part — captured-turn ownership and idempotent timer cleanup** (`goals/member-waits.ts`). The registry cannot compare against the current turn at completion: a next turn may already exist. Validation and single-line replies apply equally to immediate and delayed answers.

```ts
export interface MemberStatus {
  exists: boolean
  turn: string | null
  stopped: string | null
}
type Wait = {
  caller: string
  member: string
  turn: string
  cycle: number
  resolve: (answer: string) => void
  timer: ReturnType<typeof setTimeout>
  cleanup: () => void
}
export class MemberWaits {
  private waits = new Set<Wait>()
  constructor(private read: (member: string) => MemberStatus) {}
  get size(): number { return this.waits.size }
  wait(caller: string, member: string, cycle = 0, blockMs = 50000, signal?: AbortSignal): Promise<string> {
    if (!Number.isSafeInteger(cycle) || cycle < 0 || cycle >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(new Error('Use a nonnegative safe cycle below the maximum safe integer.'))
    }
    if (!Number.isSafeInteger(blockMs) || blockMs < 1000 || blockMs > 50000) {
      return Promise.reject(new Error('Wait for between 1000 and 50000 milliseconds.'))
    }
    if (caller === member) return Promise.reject(new Error('Choose another member; a turn cannot wait for itself.'))
    if (signal?.aborted) return Promise.resolve(this.answer('stopped: the calling turn ended', cycle))
    const status = this.read(member)
    if (!status.exists) return Promise.resolve(this.answer('gone', cycle))
    const turn = status.turn
    if (turn === null) {
      return Promise.resolve(this.answer(status.stopped ? `stopped: ${status.stopped}` : 'idle', cycle))
    }
    if (this.waits.size >= 128) {
      return Promise.reject(new Error('This Goal already has 128 member waits'))
    }
    return new Promise(resolve => {
      const abort = () => this.finish(waiting, 'stopped: the calling turn ended')
      const waiting: Wait = {
        caller, member, turn, cycle, resolve,
        cleanup: () => signal?.removeEventListener('abort', abort),
        timer: setTimeout(() => this.finish(waiting, 'still working'), blockMs),
      }
      this.waits.add(waiting)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  ended(member: string, turn: string, reason: string | null): void {
    for (const waiting of [...this.waits]) {
      if (waiting.member === member && waiting.turn === turn) {
        this.finish(waiting, reason ? `stopped: ${reason}` : 'idle')
      }
    }
  }
  gone(member: string): void {
    for (const waiting of [...this.waits]) {
      if (waiting.member === member || waiting.caller === member) this.finish(waiting, 'gone')
    }
  }
  cancel(caller: string): void {
    for (const waiting of [...this.waits]) {
      if (waiting.caller === caller) this.finish(waiting, 'stopped: the calling turn ended')
    }
  }
  close(): void {
    for (const waiting of [...this.waits]) this.finish(waiting, 'stopped: the desk closed')
  }
  private answer(text: string, cycle: number): string {
    return `${text.replace(/[\r\n]+/g, ' ').slice(0, 2000)}; cycle: ${cycle + 1}`
  }
  private finish(waiting: Wait, answer: string): void {
    if (!this.waits.delete(waiting)) return
    clearTimeout(waiting.timer)
    waiting.cleanup()
    waiting.resolve(this.answer(answer, waiting.cycle))
  }
}
```

**Tests:** Cases 1–6 and 9–10 must fail before the new behavior exists. Existing guard cases 7–8 must remain green through the fixture migration.

1. `goal-member-waits.test.ts` — **names are stable and collision-free**: two Agent Seats with equal/different seat labels and one anonymous migrated Seat, including a literal numbered-name collision; unique deterministic names and unchanged historical message labels. Guards accidental live-name persistence.
2. `goal-member-waits.test.ts` — **wait ends for the captured turn**: capture t1, replace running with t2, complete t1; idle reply and size zero. Mutation: compare completion against `read(member).turn`; test must fail immediately.
3. `goal-member-waits.test.ts` — **one deadline without polling**: fake time at 999/1000 ms; one status read, no early result, then still working and no timer. Exercise default 50000 ms too.
4. `goal-member-waits.test.ts` — **all terminal paths settle once**: fail, receiver departure, caller cancellation, detach, wrap, shutdown and duplicate completion; correct prefix/cycle and registry zero. Immediate stopped reasons containing newlines also remain one line.
5. `goal-team-guards.test.ts` — **scope and limits precede effects**: real Team with two Goals, self, ambiguous name, missing member, unsafe cycle, invalid block, 129th waiter and repeated invocation; expected refusals, no send/steer/resume, no cross-Goal names leaked.
6. `goal-team-guards.test.ts` — **released sender cannot deliver later**: block resume, release sender, then resume held/queued delivery; recorded refusal and zero runtime sends. Mutation: omit post-await Seat recheck.
7. `goal-team-guards.test.ts` — **original numeric guards survive Seats**: 16001 chars, fifth pair send at 59999 ms, identical text at 599999 ms, ninth pending; refuse each; accept at 60000/600000 ms boundaries. Mutate pending limit 8→9; ninth-message case fails.
8. `goal-team-guards.test.ts` — **all states and policy survive restart**: produce delivered/shown/held/refused/queued, persist and restart; queued becomes refused for existing restart reason, held remains held, denied sender remains held, user queue wins, no answer echo. Keep existing `team.test.ts` config/envelope/audit tests.
9. `permissions.test.ts` and `plugins.test.ts` — **await_member uses team permission**: registered schema requires only member and maps block_ms to blockMs; missing team grant refuses before engine lookup; granted scope reaches the engine unchanged.
10. `isolation.test.ts` — **child wait is invocation-bound**: granted child tool waits, sibling/expired/forged scope refuses; cancellation drops pending host wait. Mutate the supervisor's armed check and require failure; do not replace this with direct Team calls.

**Run:** Run each command in the foreground; build first, then the original and new boundaries.

```bash
pnpm run build:node
node --test --test-reporter=spec packages/server/dist/test/goal-member-waits.test.js packages/server/dist/test/goal-team-guards.test.js packages/server/dist/test/team.test.js
node --test --test-reporter=spec packages/cordis-host/dist/test/permissions.test.js packages/plugins/dist/test/plugins.test.js packages/extension-host/dist/test/isolation.test.js
```

Expected: all pass. Run each named mutation separately, observe the named failure, restore, and rerun that suite. The planning proof executed six registry cases; actual Team/child integration is an implementation requirement.

**Done when:** No wait sends or polls, no delivery escapes its captured Goal, every exit clears the waiter, and the existing channel suite passes with Seat-derived membership. Report guard regressions separately from registry tests.

**Proof needs:** neither for registry/Team tests; a listener for the existing child/gateway integration suite. Route integration to an implementer with listener access; do not weaken that suite.

**Commit:** `feat(goals): preserve guarded messaging and wait for a member turn` (implementation only, after required verification; include the writer trailer).

### Task 8: Preview and commit a durable wrap receipt

**Goal:** Let a person review one truthful snapshot, then durably close the Goal with that same receipt. A crash can finish an approved wrap but cannot reopen Seats or silently approve changed facts.

**Files:**
- Create `packages/server/src/goals/wrap.ts` — preview validation, stamp, commit ordering and citation blob validation.
- Create `packages/server/test/goal-wrap.test.ts`, `goal-wrap-recovery.test.ts`, `goal-citation.test.ts` — races, real journal recovery and committed-path safety.
- Modify `packages/server/src/goals/plane.ts` — `preview`, `wrap`, `receipt`, `cite`, and private `#wrapInput` assembly.
- Modify `packages/server/src/goals/store.ts`, `operations.ts` — `GoalOperation.wrap` staging and idempotent `finishWrap`, using existing document write bounds.
- Modify `packages/server/src/evidence/plane.ts`, `observe.ts`, `check-runs.ts` — board settlement and pre-spawn mutation gate.
- Modify `packages/server/src/host.ts` — transcript answer/revision adapters, shared serial and startup replay.
- Modify `packages/protocol/src/wire.ts`, `wire-validators.ts`, `packages/server/src/methods/goals.ts` in that order — activate Task 1's preview/wrap/receipt/cite contracts.
- Modify `packages/server/test/evidence-seats.test.ts`, `evidence-board.test.ts`, `evidence-check-runs.test.ts` — extend phase-4 fixtures with mutation gate/settlement; retain existing approval/digest/staleness assertions.
- Modify `packages/protocol/test/goal-wire.test.ts` — forged receipt, invalid choices and citation validation at `parseClientMessage`.

**Interfaces:** Consumes `Goal`, `GoalReceipt`, `WrapChoices`, `WrapPreview`, `GoalCitation`, `factsOfGoal`, `GoalStore`, `GoalOperation.wrap`, `SeatBook.all/closeId/settled` and the desk-wide `Serial`. These protocol shapes stay exactly as Task 1 defined them. Server-only `WrapInput`, `WrapPort`, `wrapStamp`, `previewWrap` and `Wraps` are fully declared with their proven code below.

```ts
// Produces on GoalPlane; unchanged public wire signatures in Interfaces.
interface GoalPlane {
preview(goal: GoalId, choices: WrapChoices): Promise<WrapPreview>
wrap(goal: GoalId, stamp: string, choices: WrapChoices): Promise<GoalReceipt>
receipt(goal: GoalId): Promise<GoalReceipt | null>
cite(goal: GoalId, citation: GoalCitation): Promise<void>
}
// New phase-4 boundary, explicitly added here.
interface EvidencePlane {
settledFor(board: string): Promise<void>
}
interface CheckRunsPort {
canMutateBoard(board: string): boolean
}
```

**Decisions and invariants:**
- Settlement of Seat writes and board observation/check completion writes happens before acquiring `goalSerial`. `settledFor` drains tracked in-flight writes, never launches a check/poll. Failure makes preview unavailable, not evidence-empty. Recheck pending/running work under the queue; no new dispatch can slip between validation and staging.
- One shared queue covers fresh wrap input through final write. Capture evidence IDs, historical kept Seat IDs (closed/released/deleted included), actual transcript answers and turn pointers, partial/stop flags, citations, every observed head/dirty state and choices. Sort collections deterministically; keep meaningful card order. Snapshot data cannot share mutable arrays with callers.
- Every card gets exactly one finished/dropped choice. Dropped or not-yet-done cards require a reason. Missing dependencies, live flow/turn/check, waiting approvals, pending/held messages or unreadable evidence refuse. Pending mail is resolved/discarded separately; that action invalidates any preview.
- Answer snippets cap at 16000 characters with truncation gap and transcript pointer. Missing answer, missing findings, missing/unknown/floor-only spend remain explicit gaps; never infer spend or checks from prose. An agent's “checks passed” message produces no fact.
- Before staging, validate the whole document and its 8-MiB bound, not only the receipt. Evidence lines retain phase 4's 64-KiB limit; a receipt is never an evidence line. Re-read mutable external observations immediately before staging and compare the stamp again; changing git after that observation cannot be locked, so the receipt says when/at what revision it was observed.
- `stage` atomically writes `state:'wrapping'` and the full fixed receipt in `GoalOperation.wrap` before any Seat closes. Failed staging closes nothing. `closeSeats` closes only still-open kept Seats of this Goal, applies reviewed card dispositions with Team's locked helpers, ends waits and retains lanes. No checkout/branch/profile removal or port release.
- `finish` writes receipt, wrapped Goal, final board and `operation:null` in one durable Goal document; only then notify. Replay uses the staged receipt ID/time/facts, not current git or fresh answers. Notification failure after durable finish is not rollback. Write failure during replay leaves read-only “Wrapping could not finish: …” with retry.
- Wrapped/wrapping blocks every Goal/board mutation, flow start/rearm, check spawn, Seat opening, dependency edit and citation at the host. Ordinary later conversation turns remain transcript history; they cannot mutate the receipt.
- Citation checks source wrapped receipt, same canonical project, full commit SHA and a literal relative regular-file path. Reject symlinks, trees, gitlinks, traversal, drive/backslash/absolute paths and missing objects. Store only the tuple, never the document text. Under the same queue, revalidate source receipt/target open state, add source dependency with `checkedDependencies`, deduplicate exact tuples, and save once. An error changes neither edge nor citation.

**Proven hard part — bind approval to facts and journal before irreversible Seat closing** (`wrap.ts`). `WrapPort` implementations run inside the caller-held queue and never enqueue recursively. `read` and `stage` also enforce the host settlement/mutation gates above; this class alone is not a filesystem recovery proof.

```ts
import { createHash } from 'node:crypto'
import { Serial } from './assignments.js'
import type { Goal, GoalReceipt, WrapChoices, WrapPreview } from '@harnessdesk/protocol'

export interface WrapInput {
  goal: Goal
  cards: readonly { id: number; state: string }[]
  dependencies: readonly { id: string; state: string }[]
  busy: boolean
  flow: boolean
  pending: boolean
  seats: GoalReceipt['seats']
  evidence: GoalReceipt['evidence']
  answers: GoalReceipt['answers']
  lanes: GoalReceipt['lanes']
  citations: GoalReceipt['citations']
  gaps: GoalReceipt['gaps']
  revisions: GoalReceipt['revisions']
}
export type { WrapChoices } from '@harnessdesk/protocol'
export interface WrapPort {
  read(goal: string): Promise<WrapInput>
  stage(goal: string, receipt: GoalReceipt, stamp: string): Promise<void>
  closeSeats(goal: string, ids: readonly string[]): Promise<void>
  finish(goal: string, receipt: GoalReceipt): Promise<void>
}
export function wrapStamp(input: WrapInput, choices: WrapChoices): string {
  return createHash('sha256').update(JSON.stringify({ input, choices })).digest('hex')
}
export function previewWrap(input: WrapInput, choices: WrapChoices): WrapPreview {
  if (input.goal.state !== 'open') throw new Error('This Goal is already closing or wrapped.')
  if (input.busy || input.flow || input.pending) {
    throw new Error('Stop the running work and resolve waiting messages or approvals before wrapping.')
  }
  if (input.goal.dependsOn.some(id => input.dependencies.find(d => d.id === id)?.state !== 'wrapped')) {
    throw new Error('Wrap the Goals this one is waiting on first.')
  }
  if (!choices.summary.trim()) throw new Error('Say what finished before wrapping.')
  const resolutions = new Map(choices.cards.map(card => [card.id, card]))
  if (resolutions.size !== choices.cards.length || choices.cards.length !== input.cards.length ||
      input.cards.some(card => !resolutions.has(card.id))) {
    throw new Error('Review every card once before wrapping.')
  }
  for (const card of input.cards) {
    const resolution = resolutions.get(card.id)!
    if ((resolution.resolution === 'dropped' || card.state !== 'done') && !resolution.reason?.trim()) {
      throw new Error(`Say why card ${card.id} is ${resolution.resolution}.`)
    }
  }
  return {
    stamp: wrapStamp(input, choices),
    receipt: structuredClone({
      version: 1, goal: input.goal.id, sentence: input.goal.sentence,
      summary: choices.summary.trim(), cards: choices.cards, seats: input.seats,
      evidence: input.evidence, answers: input.answers, lanes: input.lanes,
      citations: input.citations, revisions: input.revisions, gaps: input.gaps,
    }),
  }
}
export class Wraps {
  constructor(private port: WrapPort, private serial = new Serial()) {}
  commit(goal: string, stamp: string, choices: WrapChoices, id: string, at: number): Promise<GoalReceipt> {
    const approved = structuredClone(choices)
    return this.serial.run(async () => {
      const input = await this.port.read(goal)
      if (wrapStamp(input, approved) !== stamp) {
        throw new Error('This Goal changed while you reviewed its receipt. Review it again.')
      }
      const ready = previewWrap(input, approved)
      const receipt: GoalReceipt = { ...ready.receipt, id, wrappedAt: at }
      if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > 8 * 1024 * 1024) {
        throw new Error('This receipt is too large to store. Shorten the summary or card reasons and review it again.')
      }
      await this.port.stage(goal, receipt, stamp)
      await this.port.closeSeats(goal, receipt.seats)
      await this.port.finish(goal, receipt)
      return receipt
    })
  }
}
```

**Proven hard part — committed path and link safety.** Append `citationBlob` to `wrap.ts`; merge its imports at the file top. `ls-tree`'s exact literal path and regular-file mode check matter: a symlink is also a git blob, so `cat-file -t` alone would accept it. Root is host-confined, never the citation's untrusted project string.

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const git = promisify(execFile)
export async function citationBlob(root: string, path: string, at: string): Promise<void> {
  const parts = path.split('/')
  if (!path || path.includes('\0') || path.includes('\\') || /^[A-Za-z]:/.test(path) ||
      parts.some(part => part === '' || part === '.' || part === '..') ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(at)) {
    throw new Error('Choose a relative document path and its full committed revision.')
  }
  try {
    await git('git', ['cat-file', '-e', `${at}^{commit}`], { cwd: root })
    const result = await git('git', ['ls-tree', '-z', at, '--', `:(literal)${path}`], { cwd: root })
    const records = result.stdout.split('\0').filter(Boolean)
    if (records.length !== 1) throw new Error('Missing document')
    const tab = records[0]!.indexOf('\t')
    const [mode, kind] = records[0]!.slice(0, tab).split(' ')
    if (tab < 0 || records[0]!.slice(tab + 1) !== path || kind !== 'blob' ||
        (mode !== '100644' && mode !== '100755')) throw new Error('Not a regular document')
  } catch {
    throw new Error('That document is not available at the recorded revision. Restore the commit or choose another citation.')
  }
}
```

**Tests:** New cases must fail before implementation. Existing evidence suites remain green with the explicitly named port additions.

1. `goal-wrap.test.ts` — **every disposition is explicit**: missing/duplicate/extra card, empty summary and unresolved/dropped card without reason; refuse with the code's sentences. Busy/flow/pending and missing/unwrapped dependency each refuse before writes.
2. `goal-wrap.test.ts` — **snapshot keeps uncertainty**: closed/released Seats, card-only evidence, partial interrupted answer, missing answer, 16001-character answer, dirty/unreadable lane, unknown spend; preserve pointers/IDs and explicit gaps, never success chips from prose. Mutating source arrays after preview cannot change receipt.
3. `goal-wrap.test.ts` — **changed preview has no effects**: independently change Goal revision, dependency, card, Seat, evidence ID, head, dirty state, answer and choices; old stamp refuses, with zero stage/close/finish calls. Mutation: remove stamp comparison; head case fails.
4. `goal-wrap.test.ts` — **one winner and stage-before-close**: concurrent wraps plus a paused stage; one commit, immutable choices while queued, fixed receipt ID, stage→close→finish. Failure during stage closes none; failure after a close calls no finish. Oversize receipt/document refuses before stage.
5. `goal-wrap-recovery.test.ts` — **disk truth survives each interruption**: real GoalStore/SeatBook, two Seats, failures at stage sync, first close, final rename and notification; reconstruct all services and replay twice. One receipt, each Seat closed once, same observation/answer bytes, retained lane lease and files; no wrapped success until durable final write.
6. `goal-wrap-recovery.test.ts` — **dispatch and observation cannot race freeze**: suspend a check completion/resume while wrapping; settle before queue, recheck before spawn/delivery, no deadlock or late board mutation. Try every mutating Goal/Team/flow/check handler with `Host.call` against wrapped state; refuse before side effects. No port-only substitute.
7. `goal-citation.test.ts` — **citation stays at its committed revision**: synthetic git repo with two commits, regular file with brackets, symlink, tree and gitlink; accept exact old file after HEAD moves, reject link/nonfile/traversal/missing/SHA aliases. Mutation: remove mode check; symlink case fails. No shell interpolation or copied contents.
8. `goal-citation.test.ts` — **citation plus dependency is atomic**: wrong receipt, other project, cycle, concurrently wrapped target and injected save failure; no partial edge/citation. Duplicate tuple is a no-op; valid call saves both together.
9. `evidence-check-runs.test.ts` — **wrapped refuses immediately before spawn**: shared fixture gets `canMutateBoard: () => true`; new case flips it while approval/preparation awaits, records zero command spawn. `evidence-board.test.ts` tests settlement failure instead of an empty success; `evidence-seats.test.ts` retains close-id idempotence.
10. `goal-wire.test.ts` — **wire accepts choices, never a receipt**: use `parseClientMessage` for forged receipt fields, summary/reason/count bounds, duplicate card IDs, malformed stamp/SHA/path and host-owned fields. Valid request reaches real methods/goals through `Host.call`.

**Run:**

```bash
pnpm run build:node
node --test --test-reporter=spec packages/server/dist/test/goal-wrap.test.js packages/server/dist/test/goal-wrap-recovery.test.js packages/server/dist/test/goal-citation.test.js
node --test --test-reporter=spec packages/server/dist/test/evidence-seats.test.js packages/server/dist/test/evidence-board.test.js packages/server/dist/test/evidence-check-runs.test.js packages/protocol/dist/test/goal-wire.test.js
```

Expected: all green; each named guard mutation first fails its case, then passes restored. Planning ran four transaction tests with fake effects plus one real-git citation test. Real GoalStore/SeatBook failure injection and Host routing remain required implementation proofs.

**Done when:** The same receipt survives every restart point, no stale preview closes a Seat, wrapped mutations refuse at the host, and citations stay revision-bound. Task 10 renders and inspects these facts before the phase can ship.

**Proof needs:** neither for transaction/persistence/git tests; a listener only if the retained Host fixture uses its socket transport. Routing: host implementer; preserve that original boundary.

**Commit:** `feat(goals): freeze reviewed receipts with recoverable wrapping` (implementation only, after required verification; include the writer trailer).

### Task 9: Show Goals, create them, and make staffing an assignment

**Goal:** A project shows finishable Goals with their Seats, while plain conversations keep today's start/navigation behavior. Creating or staffing a Goal uses the host's durable assignment rules and displays actionable refusals.

**Files:**
- Create `packages/ui/src/lib/goals.ts`, `goals.test.ts` — grouping, words, action availability and notification predicate.
- Create `packages/ui/src/components/GoalCreate.tsx`, `GoalHeader.tsx`, `GoalAssign.tsx`, `LaneSettings.tsx` and `GoalCreate.test.tsx`, `GoalHeader.test.tsx`, `GoalAssign.test.tsx`, `LaneSettings.test.tsx` — canonical composed surfaces.
- Create `packages/ui/src/state/store.goal.test.ts` — snapshot ordering, creation/retry and request contracts.
- Create `packages/ui/src/preview/goal-fixture.ts` — synthetic open/waiting/failed/refused/wrapped/restored states.
- Modify `packages/ui/src/state/snapshot.ts`, `store.ts` — Goal map, replay reducer, actions and derived Team projection.
- Modify `packages/ui/src/components/SessionTree.tsx`, `TeamRoomPane.tsx`, `TeamBoardPane.tsx` — Goal rows/header/members, retained Board/Chat, card assignment and wrapped history.
- Modify `packages/ui/src/components/NewSessionChoice.tsx`, `AddMember.tsx`, `FlowStart.tsx` — Goal creation, Agent seating and existing flow dry-run/start path.
- Modify `packages/ui/src/components/Settings.tsx`, `ProjectPage.tsx`, `packages/ui/src/app/App.tsx` — Lanes section and entrypoint wiring.
- Modify `packages/ui/src/preview/harness.tsx`, `main.tsx` — explicit fixtures/stubs for every new state/action.
- Modify `script/check-reachable.mjs` — remove only pins whose wire call now has a real renderer caller.
- Modify existing tests `packages/ui/src/components/NewSessionChoice.test.tsx`, `AddMember.test.tsx`, `SessionTree.test.tsx`, `SessionTree.projects.test.tsx`, `SessionTree.arrange.test.tsx`, `TeamRoomPane.test.tsx`,
  `TeamBoardPane.test.tsx`, and `packages/ui/src/state/store.team.test.ts` — exact changes listed in Tests.

**Interfaces:** Consumes Task 1's complete protocol shapes and Tasks 3–4's wire methods. Produces these snapshot fields/actions and pure helper signatures; import the existing protocol types rather than redefine them.

```ts
// AppSnapshot additions; AppStore uses these exact method signatures.
interface AppSnapshot {
goals: ReadonlyMap<GoalId, GoalView>
goalProblem: string | null
lanePreferences: LanePreferences | null
}
interface AppStore {
loadGoals(root?: string): Promise<void>
createGoal(input: Omit<GoalCreateInput, 'origin'>): Promise<GoalView>
updateGoal(goal: GoalId, revision: number, patch: {
  sentence?: string; dependsOn?: readonly GoalId[]
}): Promise<GoalView>
seatGoal(input: GoalSeatRequest): Promise<SeatRecord>
assignGoal(goal: GoalId, card: number, session: SessionPointer): Promise<SeatRecord>
releaseGoal(goal: GoalId, seat: SeatId): Promise<void>
loadLanePreferences(): Promise<void>
saveLanePreferences(prefs: LanePreferences): Promise<void>
ackGoalMigration(): Promise<void>
openGoal(goal: string): void
releaseLane(lane: string): Promise<Lane>
}
```

```ts
// lib/goals.ts exports; protocol Goal and GoalActivity are consumed unchanged.
export interface GoalRow { goal: Goal; activity: GoalActivity | null }
export declare function projectGoals(root: string, rows: readonly GoalRow[]): {
  open: GoalRow[]; wrapped: GoalRow[]
}
export declare function goalWords(row: GoalRow): {
  label: string; tone: 'neutral' | 'brand' | 'warning' | 'info'
}
export declare function goalActions(goal: Goal): { disabled: boolean; reason: string | null }
export declare function goalNotification(
  previous: GoalRow | null, next: GoalRow,
  prefs: Readonly<Record<string, boolean>>, focused: boolean,
): {
  kind: 'goalNeedsYou' | 'goalReadyToWrap'; goal: string; title: string; body: string
} | null
```

```ts
// Component props (AppStore remains supplied by the existing application context).
export interface GoalCreateProps { root: string; onClose: () => void }
export interface GoalHeaderProps { view: GoalView; onWrap: () => void }
export interface GoalAssignProps { view: GoalView; card: number; onClose: () => void }
export interface LaneSettingsProps { root?: string }
// LaneSettings.root filters displayed retained lanes only; preferences stay machine-wide.
```

No full component/reducer/test bodies belong in this contract. The difficult async behavior is specified by observable races and request counts below, using the already-proven host transactions.

**Decisions and invariants:**
- Use one reducer for initial `goal/list`, `goal/read` and `goal/changed`. Ignore lower Goal revisions; equal revisions may refresh evidence/activity/presence because those can change without a document write. Preserve the latest
  per-request generation for overlapping list/read requests; a stale response cannot overwrite a newer live event. Update `teams` from that same accepted GoalView.
- `loadGoals(root)` replaces only that root's loaded entries, preserving other projects. Failed loads retain known data plus `goalProblem`. Seat/release replies trigger `goal/read`; never splice a client-created member into the map.
- `projectGoals` filters exact root, sorts descending `updatedAt` then ascending ID, separates `wrapped` from open/wrapping. Empty project: no Goals heading. Wrapped entries go in one collapsed “Wrapped · N” group at the project's end.
- Rows use `Button variant="navigation" size="navigation"` and selection data attributes, sentence and a Chip. `goalWords`: Working/info, Needs you/warning, Ready to wrap/brand, Wrapping/info, Wrapped/neutral. Ready is not an evidence
  success verdict.
- `goalActions` disables non-open Goals with “This Goal is wrapped. Its receipt is kept here.” or “The desk is finishing this receipt.” Surfaces additionally disable restored/problem states; `goalActions(Goal)` cannot know those GoalView
  fields.
- `openGoal` delegates to `openDefaultView({kind:'room',room:goal})`; keep persisted room discriminants and IDs readable. Preserve navigation history, session/project filters, keyboard selection and watched-member columns. Coordinate
  SessionTree with the UI session before editing it.
- Goal rows expand to freshly derived Seats; loose conversations stay at project level. Restored open Goals are visibly read-only history with no active membership, even though their preserved lifecycle says open.
- NewSessionChoice changes only “A room” to “A Goal”. Command-N and ordinary Enter immediately start the default conversation. No Goal chip, heading, Agent roster read or repository file on the plain path.
- GoalCreate uses Dialog/FormStack/Field/Input; “What finishes this?” is its sole required input (trimmed, 1–2000). Optional FlowStart and Agent selectors; defaults: no staffing/flow, shared checkout. Show the shared-browser consequence
  before isolated seating when profile isolation is off.
- Creation is sequential: create once, store returned ID locally, seat chosen Agents one by one, then start the selected flow through its existing dry-run approval. Partial failure retains the Goal and the success/refusal list; retry only
  unfinished staffing/start operations. Never repeat goal/create because the second Seat failed.
- `startAsAgent` still starts a loose conversation; only Goal staffing uses `seatGoal`. Agent menu entries remain visible with candidate reason/fix and actual recorded readback; no default-runtime fallback. Public Goal staffing omits
  grants, preserving the Agent generation's read default.
- GoalHeader composes existing DetailHead/room-bar roles with sentence, state, Waiting on links and Wrap. Dependency editing uses revision CAS; host refusal preserves the draft and refreshes before retry. Running work is not silently
  interrupted.
- TeamRoomPane keeps Board/Chat/Members with GoalView ownership. Remove TeamBoardPane live Plan chips/selectors; preserve inert `Intent.plan` history and all phase-4 derived columns/evidence/check approval UI.
- Members Release passes the Seat ID, never deletes a conversation; busy reason is “Stop this Seat's current turn before releasing it.” After success it returns to project level; retained Agent identity/evidence remains visible.
- AddMember becomes Agent-only staffing. “Give this to…” on a card opens GoalAssign over unfiltered same-project history via `groupByProject`; exclude every active kept Goal Seat and busy/missing conversation. Host revalidates stale picks;
  show refusal, never steal/move it.
- Workspaces › Lanes composes Rows/Row/Field/Input/Switch. Start/width/browser isolation are machine-wide; say changes affect new lanes. Invalid preferences offer Reset to defaults. `releaseLane` calls `lane/release` with the descriptor ID
  and waits for its returned released descriptor; no optimistic lease release. Show retained lanes with Goal/Seat and checkout, Release ports and host refusal; never describe release as deleting files.
- Migration banner appears only for successful nonempty migration; acknowledgement updates every window and persists on restart. Compatibility/read failure is a different actionable banner, never dismissing a failure as successful
  migration.
- `goalNotification` returns null for startup, focused window, disabled master/kind, unchanged activity, a different Goal ID or non-open next state. On real transition use titles “A Goal needs you” / “A Goal is ready to wrap”, body sentence
  and Goal target; Task 10 wires delivery once.
- Use public design primitives, layout-only classes, existing `stateTone` for supported evidence states, sanitized transcript rendering, visible focus and focus return. No new screen appearance stylesheet or runtime-name strings.

**Tests:** New behavior cases must fail before implementation; retained plain-path, evidence, root/filter and navigation assertions are regression gates, never deleted to turn the suite green.

1. `store.goal.test.ts` — **replay cannot regress a Goal**: lower revision and an old list response arrive after a changed event; keep latest Goal and its Team projection. Equal-revision activity refresh remains visible. Root-scoped load
   leaves other roots intact; load failure keeps known rows with an error.
2. `store.goal.test.ts` — **all actions use declared requests**: record exact params for create/update/seat/assign/release/preferences/ack; no origin/env/member/ceiling injection. Seat response refreshes via read; failures produce no
   phantom row.
3. `GoalCreate.test.tsx` — **one create across partial staffing retry**: valid sentence, two Agents, second seat refuses once, optional flow dry-run; exactly one create, first Agent seated once, retry only second, flow starts only after
   approval. Failed initial create preserves sentence/picks and reports the host sentence.
4. `GoalCreate.test.tsx` — **minimal creation and dismissal**: whitespace/2001 chars refuse, empty valid Goal shows Add work/Seat an Agent, no repository write; keyboard submit, Escape and focus return work in loading/failure/refused
   states.
5. `GoalAssign.test.tsx` — **loose candidates come from unfiltered same-project history**: hide a valid conversation with sidebar filter; it remains offered. Other project, busy, missing and active Goal members excluded; stale host refusal
   leaves picker open and no membership change. Move former AddMember adoption safety assertions here.
6. `GoalHeader.test.tsx` — **state and dependencies tell the truth**: unresolved dependency links open the same Goal ID; wrapped/wrapping/restored/problem states disable mutations with sentences; rename/dependency CAS refusal retains draft.
   Evidence ready color remains separate.
7. `LaneSettings.test.tsx` — **global settings and retained release**: defaults 30000/20/true, malformed settings, bounds and exhaustion; reset/save/refusal visible; active/listening lane cannot release, successful release keeps checkout
   text, profile-off warning appears before seating.
8. `goals.test.ts` — **plain/open/wrapped grouping and words**: empty rows give empty groups, roots do not mix, stable recency ordering, wrapped excluded from open; exact labels/tones/action reasons. Mutation: include wrapped in open;
   assert failure. Notification startup/repeat/focus/master/kind/cross-ID suppressions and both titles are pinned.
9. `SessionTree.test.tsx`, `.projects.test.tsx`, `.arrange.test.tsx` — **Goal navigation preserves project behavior**: convert room fixtures to GoalViews, expand Seats and collapsed Wrapped group, retain all root/filter/order/back/keyboard
   assertions. No Sidebar CSS workaround.
10. `NewSessionChoice.test.tsx` — **plain Enter and Command-N stay plain**: change only container label/create callback assertions; retain default focus and immediate conversation tests with zero Goal/Agent requests.
11. `AddMember.test.tsx`, `TeamRoomPane.test.tsx`, `TeamBoardPane.test.tsx`, `store.team.test.ts` — **staffing owns no independent member list**: use GoalView mocks/seat/release, remove obsolete join/Plan calls; retain pane
   snapshot-loop/member-column and phase-4 evidence/placement tests. Card assignment now opens GoalAssign.
12. `store.goal.test.ts` — **migration acknowledgement reaches both windows**: nonempty successful migration notice, ack in one, broadcast to second, reload dismissed; failed migration keeps failure banner. Preview fixture stubs return
   explicit values for all new methods, including pending and refused ones.

**Run:** Execute each Vitest file separately in the foreground.

```bash
pnpm --filter @harnessdesk/ui exec vitest run src/state/store.goal.test.ts
pnpm --filter @harnessdesk/ui exec vitest run src/lib/goals.test.ts
pnpm --filter @harnessdesk/ui exec vitest run src/components/GoalCreate.test.tsx
pnpm --filter @harnessdesk/ui exec vitest run src/components/GoalHeader.test.tsx
pnpm --filter @harnessdesk/ui exec vitest run src/components/GoalAssign.test.tsx
pnpm --filter @harnessdesk/ui exec vitest run src/components/LaneSettings.test.tsx
pnpm --filter @harnessdesk/ui exec vitest run src/components/SessionTree.test.tsx
pnpm --filter @harnessdesk/ui exec vitest run src/components/SessionTree.projects.test.tsx
pnpm --filter @harnessdesk/ui exec vitest run src/components/SessionTree.arrange.test.tsx
pnpm --filter @harnessdesk/ui exec vitest run src/components/NewSessionChoice.test.tsx
pnpm --filter @harnessdesk/ui exec vitest run src/components/AddMember.test.tsx
pnpm --filter @harnessdesk/ui exec vitest run src/components/TeamRoomPane.test.tsx
pnpm --filter @harnessdesk/ui exec vitest run src/components/TeamBoardPane.test.tsx
pnpm --filter @harnessdesk/ui exec vitest run src/state/store.team.test.ts
pnpm --filter @harnessdesk/ui run typecheck
node script/check-reachable.mjs
node script/design-audit.mjs --strict
pnpm test:ui-system
pnpm --filter @harnessdesk/ui run build
```

Expected: all pass, strict design audit zero, no new unreachable pins without a named later consumer. Rebuild before inspection; register preview fixtures for empty/loading/failed/refused, dependency waiting, shared-profile warning and restored history.

**Done when:** In the isolated rig, inspect light/dark and 680px Goal rows, creation/retry, dependency header, assignment picker, Release and Lanes. Record actual focus restoration and absence of Goal UI on the plain path; link local inspected frames in the implementation report. A unit fixture does not count as a rendered proof.

**Proof needs:** the rendered UI. Route to the implementer with rendered-app access. No routine UI implementation code is included or claimed proven by this planning batch.

**Commit:** `feat(ui): show Goals and assign conversations through Seats` (implementation only, after required verification; include the writer trailer).

### Task 10: Show the wrap receipt, notify transitions, back up history, and verify the whole phase

**Goal:** Review and reopen immutable receipts, notify real Goal transitions, and restore Goal history without reviving work. Finish with reproducible evidence that migration, isolated lanes and wrapping work together in the launched app.

**Files:**
- Create `packages/ui/src/components/GoalWrap.tsx`, `GoalReceipt.tsx`, `GoalWrap.test.tsx`, `GoalReceipt.test.tsx` — two-stage wrap review and immutable history rendering.
- Modify `packages/ui/src/state/store.ts`, `store.goal.test.ts`, `components/TeamRoomPane.tsx` — preview/commit/read actions and wrapped pane entrypoint.
- Modify `packages/ui/src/preview/goal-fixture.ts`, `harness.tsx`, `main.tsx` — partial-answer, dirty-lane, unknown-spend, stale-preview and restored-receipt scenes.
- Modify `packages/ui/src/lib/system-notifications.ts`, `system-notifications.test.ts`, `packages/desktop/electron/notifications.mjs`, `notifications.test.mjs`, `main.mjs` — kinds, suppression and Goal click routing.
- Modify `packages/protocol/src/wire.ts`, `wire-validators.ts`, `packages/server/src/host.ts` — BackupFile payload and existing export/import handlers; no server type import in protocol.
- Modify `packages/server/src/goals/store.ts` — export the history-only restore transformations below and reuse document validation.
- Modify `packages/server/test/backup.test.ts` — preserve phase-4 evidence/Seat restore assertions; add Goal history cases.
- Modify `script/check-reachable.mjs` — preview/wrap/receipt calls are now reached; citation may retain its named phase-12 pin.
- Modify `script/shots/seed.mjs`, `shoot.mjs` — isolated synthetic acceptance desk and reproducible scenes.
- Modify `docs/architecture.md`, `interface.md`, `multi-agent.md`, `data-boundaries.md`, `decisions.md`, `CHANGELOG.md` — shipped behavior and boundaries only.

**Interfaces:** Consumes Task 8's exact receipt/wrap wire contract and Task 9's `GoalRow`, `goalActions`, `goalNotification` and Goal map. Produces:

```ts
// AppStore methods.
interface AppStore {
previewGoalWrap(goal: GoalId, choices: WrapChoices): Promise<WrapPreview>
wrapGoal(goal: GoalId, stamp: string, choices: WrapChoices): Promise<GoalReceipt>
readGoalReceipt(goal: GoalId): Promise<GoalReceipt | null>
}
// Components, using the existing store context.
export interface GoalWrapProps { view: GoalView; onClose: () => void }
export interface GoalReceiptProps {
  receipt: GoalReceipt | Omit<GoalReceipt, 'id' | 'wrappedAt'>
  root: string
}
type WrapDraft = {
  summary: string
  cards: ReadonlyMap<number, { resolution: 'finished' | 'dropped' | null; reason: string }>
}
declare function choicesOf(draft: WrapDraft): WrapChoices | null
// Notification settings, default true under the existing master switch.
type GoalNotificationKind = 'goalNeedsYou' | 'goalReadyToWrap'
// Protocol BackupFile.goals: untrusted serialized documents, validated in host.
interface BackupFile {
goals?: { version: 1; documents: readonly unknown[]; lanes: readonly Lane[] }
}
// The validated host payload has the fixed GoalDocument shape from Task 2.
type GoalBackup = { version: 1; documents: readonly GoalDocument[]; lanes: readonly Lane[] }
```

The wire boundary keeps documents untrusted until the existing GoalDocument validator accepts them; no opaque input is cast to trusted state. The payload still serializes the complete versioned Goal documents, legacy metadata and receipts, with no server dependency in protocol.

**Decisions and invariants:**
- GoalWrap uses Dialog/FormStack/Field/Textarea/NativeSelect/Rows/Row/Chip and the existing evidence inspector. Stage one requires “What finished” and one choice per card: only already-done cards preselect Finished; unresolved cards start
  blank. Dropped/unresolved choices require a reason; preserve drafts on every refusal.
- `choicesOf` returns null for missing summary or any null resolution. Local reason validation uses the card's actual state; host validation remains authoritative. Stage two renders the returned preview's exact receipt and a separate final
  Wrap button, never auto-commits after preview.
- Changing draft invalidates preview. A Goal/Seat/evidence/activity change invalidates it visibly; even changes invisible to the renderer must be caught by the host stamp. “This Goal changed while you reviewed its receipt. Review it again.”
  keeps the draft and returns to preview. Double-click while pending sends one request.
- Pending work/approvals/mail and dependency blockers link to their existing resolving surfaces. A discard action happens outside the receipt transaction and requires another preview. A failed commit never displays wrapped success; an
  uncertain response triggers read before another commit.
- GoalReceipt groups summary/dispositions, historical Seats and answers, evidence IDs, revisions, citations, retained lanes and gaps. Every answer uses `sanitize.ts` via existing transcript rendering and links session+turn;
  partial/stop/truncated/missing states are visible. No raw HTML or current-green claims for old evidence.
- Frozen chips say “As recorded when wrapped”. Today's freshness, if fetched, is separately labeled. Findings/spend references use existing fact IDs; absent producers display explicit gaps. Old answers never substitute for facts;
  unknown/floor/unattributed cost is never zero or evenly divided.
- Wrapped pane is read-only Board/Chat/Members history plus receipt. Reopening it issues `goal/receipt`, not wrap or a new flow. Restored GoalView.problem also disables actions; preserved historical state never grants authority.
- Host emits `goal/activity` only on changes from a previously loaded open Goal; list replay, receipt reopen and startup do not notify. UI/desktop delivery uses one path per environment, not duplicate native/web notifications.
- Add both kinds with titles “A Goal needs you” / “A Goal is ready to wrap”, default true. Existing master/kind/focus suppression remains. Native `relevant`/`decide` include Goal target; click opens `openGoal(id)` and selects its project,
  never inventing a session. Repeated same-state events do not notify.
- Export from a coherent desk snapshot after pending writes settle; include receipts, migration metadata and lane descriptors, exclude browser files/cookies, worktree bytes, machine lane preferences and live ownership. No real profile path
  is an import capability.
- Validate the entire Goal payload before effects with ordinary document/receipt limits, finite counts/total bytes enforced by existing backup bounds, valid references and safe IDs. Use existing backup permission boundary. A malformed or
  oversize document cannot partially activate an imported desk.
- Identical same-ID source documents are duplicates even when local copies have host-owned restored marks; compare canonical content excluding only restore provenance and discarded executable operations. Divergent local IDs are reported as
  conflicts and never overwritten. Same policy for lane IDs; never replace a live local lane.
- Restore stamps host-owned `restored:{at}`, clears executable journal, preserves lifecycle and receipt bytes, and imports lanes as released archives with no Seat/profile binding. Never replay a restored wrapping operation, migrate its
  source path, dispatch, reserve a port or restart a stored flow. Startup recovery must skip restored documents. Phase-4 restored Seats/facts remain history.
- If evidence/Seats restore only partially, retain the existing incomplete-export/import warning and Goal gaps. Imported archived lane descriptors must not enter allocator reservations or browser profile lookup, even if local IDs/paths
  coincide.
- Documentation: `multi-agent.md` §§4–6/tool reference covers Seat membership, card assignment, Release, historical Plans, Goal message scope/names, every numeric guard, six lane env variables and await_member replies.
  Architecture/interface/data-boundaries cover storage, scoped browsers, migration, receipt and backup exclusions; decisions records Decisions 4–23; CHANGELOG only after acceptance.
- Do not hand-edit generated design docs or mark roadmap completion before the sitting. Screenshots come from the fake-agent shots rig; inspect every frame in light/dark/680px before any approved publication.

**Proven hard part — restore cannot activate local authority.** Add these exports in `goals/store.ts` (use its own `GoalDocument`, import protocol `Lane` at top). Apply only after validation and conflict classification, under the existing import transaction. All nested data is detached from the untrusted input.

```ts
export function restoredGoal(document: GoalDocument, at: number): GoalDocument {
  return { ...structuredClone(document), restored: { at }, operation: null }
}
export function restoredLane(lane: Lane): Lane {
  return { ...structuredClone(lane), state: 'released', seat: null, browserProfile: null }
}
```

**Tests:** New cases must fail before implementation. Keep original notification/backup behavior assertions and extend their explicit kind/key lists.

1. `GoalWrap.test.tsx` — **preview is a separate decision**: unresolved and dropped cards require reasons, done cards preselect Finished, missing summary blocks; preview returns receipt but zero commits until final click.
   Keyboard/Escape/focus return, loading, refusal and error states all work.
2. `GoalWrap.test.tsx` — **changed preview preserves draft**: edit choices or receive changed facts during preview, then simulate stale-stamp refusal and uncertain network result; no old-stamp commit, draft retained, read before retry,
   double-click sends once. Mutation: retain stamp after edit; assertion fails.
3. `GoalReceipt.test.tsx` — **uncertainty remains visible and safe**: partial/stopped/truncated/missing answer with hostile markup, unknown spend, stale revision, missing evidence, dirty retained lane and citation; escaped rendering,
   transcript/fact links, explicit gaps and “As recorded when wrapped”. No mutable controls in wrapped/restored history.
4. `store.goal.test.ts` — **wrap callers preserve wire boundaries**: exact goal/choices/stamp params, receipt read after uncertain commit, no client receipt injection; accepted wrapped view updates the derived Team projection and group
   once.
5. `system-notifications.test.ts` and `notifications.test.mjs` — **real transitions target Goals**: both kinds enabled/disabled, master off, focused window, startup/list replay, repeated state and different Goal IDs; exact titles, one
   notification and click target Goal ID. Preserve turn/approval cases and pinned kind lists.
6. `backup.test.ts` — **export omits machine authority**: real export contains Goal/receipt/legacy data and lane descriptors; no cookies/profile directories/worktree contents/lane preferences. Existing evidence export/incomplete warning
   stays.
7. `backup.test.ts` — **restore is history after restart**: open/wrapping/wrapped source docs, queued operation, active/retained lanes and Seats; resulting documents have restored marks and no journal, lanes released/no binding, zero
   runtime/port/browser calls before and after restart. Mutation: preserve lane state/binding; case fails.
8. `backup.test.ts` — **duplicates and conflicts are stable**: import twice including restored timestamps, divergent existing Goal/receipt/lane and live local lane collision; stable counts, conflicts named, no overwrite. Invalid
   version/SHA/record size/total bytes/ID fails before any Goal effect; preserve phase-4 restored-fact/Seat assertions.
9. Launched fake-agent sitting — **upgrade, isolate, assign, wrap and restore**: execute the acceptance sequence below; record commands, exact tested head, observations and inspected frame paths. Unit/port tests cannot satisfy this case.

**Run:**

```bash
pnpm --filter @harnessdesk/ui exec vitest run src/components/GoalWrap.test.tsx
pnpm --filter @harnessdesk/ui exec vitest run src/components/GoalReceipt.test.tsx
pnpm --filter @harnessdesk/ui exec vitest run src/state/store.goal.test.ts
pnpm --filter @harnessdesk/ui exec vitest run src/lib/system-notifications.test.ts
pnpm run build:node
node --test --test-reporter=spec packages/server/dist/test/backup.test.js
node --test --test-reporter=spec packages/desktop/electron/notifications.test.mjs packages/desktop/electron/browser-scopes.test.mjs
pnpm --filter @harnessdesk/ui run typecheck
pnpm layering
node script/check-reachable.mjs
node script/design-audit.mjs --strict
pnpm test:ui-system
pnpm --filter @harnessdesk/ui run build
```

Expected: all pass. Run the changed-preview and restore-authority mutations separately; each must fail its named case before restoration. Controller runs `pnpm verify` unpiped, records exit status, and keeps CI, focused tests and rendered proof separate. The planning batch did not run this full gate.

Acceptance sequence (extend existing shots seed/shoot entrypoints; use their existing launch arguments, recording the exact invocation in the implementation report):

1. Isolated `HARNESSDESK_HOME`, fake runtimes, synthetic repository and Task 2's eight-room fixture. Open all eight original IDs exactly once; board/channel/Seat membership intact, all delivery states and held inbound policy retained.
   Acknowledge notice; restart and confirm dismissal.
2. Create two Goals and isolated Seats; run Task 4's identical server fixture concurrently on their allocated blocks. Through registered browser tools, use Task 6's same-origin cookie/localStorage probe; profiles and fronted panes remain
   independent after restart.
3. Assign a loose conversation a card; finish/release it; verify project-level conversation and closed Seat evidence after restart. Add dependsOn; dispatch waits but reads/card editing work; a message cannot cross that edge.
4. Wrap with explicit dropped reason, partial answer and dirty lane; inspect preview before final action. Checkout/branch still exist, ports remain retained, receipt unchanged after restart, every Goal mutation refuses. Reopen receipt from
   collapsed Wrapped group.
5. Backup and restore into another isolated home; no active members, port reservations, triggered work or cookies. Imported receipt matches original facts and states its restore gap. Plain start still immediately opens an ordinary
   conversation.
6. Inspect light/dark/680px frames for migrated Goal, waiting dependencies, Needs you, exhausted-lane refusal, two browser profiles, partial/dirty wrap preview and immutable receipt. Keep inspected local frames under
   `.superpowers/sdd/frames/task-10/`; public artifacts require the normal controller publication step and immutable paths.

**Done when:** Focused tests, full unpiped gate and the real sitting pass; docs describe only observed behavior, and the implementation report names every changed existing test and every remaining gap. One review of the complete phase PR follows; this planning work creates no PR or commit.

**Proof needs:** the rendered UI and a listener. Route to the implementer with launched-app/listener access; restore transformations alone do not prove backup transactions or native click routing.

**Commit:** `feat(goals): review receipts and preserve Goal history in backups` (implementation only, after required verification; include the writer trailer).

## Proof record for this plan

Tasks 1–6 retain their earlier detailed text and proof claims, except the explicitly commissioned Task 3 Step 9 addition. Those prior executions were not rerun by this batch. Tasks 7–10 are contracts: exact boundary types, invariants, named mutation tests and production commands, with full implementation code only for the hard parts below. All nine contract parts are present in each rewritten task.

This batch used `.plan-scratch/` only and left only this plan changed. It made no production edits, commit, push or branch/worktree change. Temporary synthetic git objects belonged to a newly created scratch fixture, not the checkout's git metadata. Scratch code, fixtures and logs were deleted after validation.

The planning proofs used Node v25.9.0's type transformation, not the future production build. Commands were run in the foreground, one test file per invocation, first with the named deliberate defect and then with the exact code restored:

```bash
node --experimental-transform-types --test --test-reporter=spec .plan-scratch/dispatch.test.mjs
node --experimental-transform-types --test --test-reporter=spec .plan-scratch/member-waits.test.mjs
node --experimental-transform-types --test --test-reporter=spec .plan-scratch/wrap.test.mjs
node --experimental-transform-types --test --test-reporter=spec .plan-scratch/citation.test.mjs
node --experimental-transform-types --test --test-reporter=spec .plan-scratch/history.test.mjs
```

| Hard part | Deliberate failure | Red result | Restored result |
| --- | --- | --- | --- |
| Task 3 `dispatchAfter` | Reuse the pre-await authorization result | 1 failed / 1 passed, missing rejection; exit 1 | 2 passed; exit 0 |
| Task 7 `MemberWaits` | Compare completion to the new current turn instead of captured turn | 1 failed / 5 passed, waiter size 1 instead of 0; exit 1 | 6 passed; exit 0 |
| Task 8 preview/stamp/`Wraps` | Omit stale-stamp rejection | 1 failed / 3 passed, missing rejection; exit 1 | 4 passed; exit 0 |
| Task 8 `citationBlob` | Accept any blob mode, including a symlink | 1 failed, missing rejection; exit 1 | 1 passed; exit 0 |
| Task 10 restore transforms | Keep imported live lane state/Seat/profile binding | 1 failed, active instead of released; exit 1 | 1 passed; exit 0 |

The 14 green tests cover actual event/timer behavior (including independent invocation abort), async dispatch recheck, receipt choice/snapshot cloning, one-winner serialization, write ordering, size refusal, literal committed-path checks against a real synthetic two-commit git repository, and detached history-only restore transformations. The wrap test used the exact Task 3 `Serial` text compiled into scratch with the already-installed TypeScript transpiler read-only; no package was installed and no other checkout was written.

These are runtime proofs of the included algorithms, not production typechecking, Host port construction, actual GoalStore/SeatBook replay, Team guard migration, child-plugin attribution, backup atomicity, adapter/vendor probes, real listeners, native notifications or rendered acceptance. The production tests/commands and observations for those boundaries are specified in Tasks 3 and 7–10 and remain required. Task 9 includes no routine UI implementation code and claims no new UI execution. The full unpiped `pnpm verify` was not run by the plan writer because its listener requirement belongs to the implementation/controller environment.

## Overlaps and compatibility decisions

| Adjacent surface | Contract retained |
| --- | --- |
| Phase 2 Part B | Build on completed Agent roster/name/readback/refusal UI; keep ordinary startAsAgent and plain start, replacing room adoption with card assignment only. Reconcile changed files against its merged head before implementation. |
| Phase 3 | Preserve both StandingOrder generations and effective held/asked ceiling; tagged grant never translates edit into legacy read. Keep message turn provenance and sender ceiling guards; environment options merge with sandbox options. |
| Phase 4 | Keep record IDs/paths and BoardEvidence; deliberate additions are unknown standing order, SeatBook enumeration/import/close, shared placement rules, awaited legacy opening and wrap settlement/mutation gates. Restore remains history. |
| Design system / #813 | Public primitives, one navigation row and existing state vocabulary; coordinate SessionTree, no screen appearance CSS or alternate overlay. |
| Existing flow files | Preserve grammar, run IDs and room keys; Task 3 constructs Host ports and records membership before orders, Task 5 supplies allocated cwd/environment. No duplicate asynchronous recorded callback. |
| Lanes and browser settings | Default per-lane profile stays true; explicit off applies only to new lanes. Wrapped retains files, lease and profile; restore descriptors confer no local authority. |
| Later phases 6/8/11/12 | Keep Goal create/seat/assign/release/canDispatch, event wait, immutable receipt/facts join, and same-project revision citation promises. No flow conversion, trigger engine, spend producer or memory retrieval policy is added here. |

## Requirement coverage and final self-review

| Requirement | Contract and required acceptance |
| --- | --- |
| Room/Plan merge and migration | Tasks 1–3; eight-room fixture retains IDs/board/channel, no invented completion. |
| Derived membership and durable staffing | Task 3 Step 9 plus Task 5; Host port map, supplied cwd, opening-before-order, shared fixtures and post-await dispatch checks. |
| Lane checkout/ports/environment/browser | Tasks 4–6; real two-server and same-origin profile sitting in Task 10. |
| Guarded channel and event wait | Task 7; original numeric guards/states, actual Team/child boundaries, captured-turn registry proof. |
| Receipt and citation | Task 8; exact snapshot/choices, journal-before-close, real recovery and git-path cases; Task 10 renders partial answers/gaps. |
| Goal navigation/staffing/settings | Task 9; root/revision ordering, create-once retry, unfiltered assignment, Release, conditional plain surface and three-size/theme inspection. |
| Receipt review/notifications/backup | Task 10; fresh explicit preview, transition-only Goal targets, history-only restore and restart. |
| Verification and handoff | Focused original-boundary tests, actual fake-agent sitting, unpiped full gate and one phase PR review; each kind of evidence reported separately. |

Out-of-batch defects found, deliberately not repaired in the fixed header or completed tasks:

- **Retained-lane enumeration is missing from the public seam.** The header offers preferences/set/release but no list/read returning Lane descriptors; GoalView and receipt lane summaries do not expose allocation/profile/state fields. Task 9 can implement preferences and release once given a Lane, but cannot truthfully list all retained or failed-unbound allocations from the declared wire alone. The controller must add an explicit authorized descriptor-read seam to the header/Task 4 before implementing that part; do not guess a new endpoint or read host files from UI.
- **Legacy ID promise exceeds the filename rule.** Decision 3/public validation preserve path IDs up to 4096 characters, while Task 2 `goalFile` refuses encoded names over 255 bytes. This safely refuses rather than loses data, but does not fulfill conversion of every such room. The controller must reconcile the storage/key contract and migration tests; this batch does not rekey records.
- **Task 2 still declares a missing migration integration boundary.** Its Step 8 warns that the non-mutating Team compatibility reader and authorized root-remapping transaction are not supplied. The Task 3 port contract must not be read as completing that separate migration work; the old Team loader can write legacy files during a supposedly read-only fallback.
- **Task 2's document reader only shallow-checks receipt/operation/citation content.** `documentOf` currently accepts nested data by cast after checking a few tags. Tasks 8/10 require full validation before wrap/import; the existing reader alone is not sufficient proof of their untrusted-input contract.
- **Task 5 Step 9's trailing paragraph is stale.** It still says the exact Host seating adapter is missing. Task 3 Step 9 now supplies its contract, ordering and required proof; Task 5 was explicitly frozen by this brief and was left unchanged.
- **Task 3 Step 10's fixed test counts predate its new Step 9 integration cases.** Its commands remain usable; the supplement explicitly says the new tests increase the old totals. No other Task 3 text was changed.
- **The header routing table understates Task 7's integration proof.** Registry/Team algorithms need neither listener nor UI; the retained child/gateway suite may need listener access. Task 7 now states both boundaries rather than lowering its tests to match the table.

The controller should resolve the missing lane-enumeration and migration contracts, the legacy-ID storage mismatch, and the nested validation gap before declaring the whole phase implementation-ready. No ordinary UI code/test bodies remain in Tasks 7–10; full code is confined to the proven hard parts. Check added text for private identities/paths before committing; inspect real frames before any publication. A required rendered/listener proof remains missing until it has actually run.

## Two decisions the last batch left open (settled by the coordinator)

1. **Task 9 needs to list lanes.** No public seam lists retained and failed-unbound lane descriptors. Task 4's lane module adds and exports `listLanes(): readonly LaneDescriptor[]`, returning every descriptor it holds (live, retained, failed-unbound) in allocation order. Task 9 reads it; nothing else writes through it. Task 4's tests gain one case: after one allocation, one retention and one failed binding, `listLanes()` returns all three, each with its state.
2. **Legacy room IDs can be longer than a filename.** A legacy ID may be up to 4,096 characters, but Task 2 refuses an encoded filename over 255 bytes, so migrating such a room would fail. Task 2 therefore:
   - names a Goal's file by its encoded ID when that fits in 255 bytes;
   - otherwise names it `h-<sha256 hex of the ID>`;
   - always stores the full ID inside the record, and resolves by the ID inside the record, never by the file name;
   - adds a migration test with a 4,096-character room ID that opens as a Goal and round-trips.
