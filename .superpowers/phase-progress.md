# Phase 5 progress

Branch: `codex/agents-phase-5`
Base: `732bd8c0`

## Plan corrections

- Task 1 references phase-4 renderer modules `packages/ui/src/lib/board-facts.ts` and `packages/ui/src/lib/evidence.ts`. They are not present in the landed base. Current main is authoritative, so Task 1 shares the host/protocol rules now and leaves renderer integration to the later Goal board UI work rather than creating an unused duplicate surface.
- Coordinator confirmed Phase 4B is actively implementing those renderer prerequisites. Deliberate reordering: complete Task 1 protocol/host proof and other independent host work now; integrate Task 1 renderer re-exports and Task 2 `SeatRecordBlock` unknown-state copy only after Phase 4B lands, before dependent UI work or landing.
- Commit trailers use the brief's required `Co-authored-by: HarnessDesk Agent <agent@harnessdesk.app>` instead of the plan writer's stale trailer.
- UI-system coordination: before adding any API under `packages/ui/src/design/`, inspect the committed `claude/ui-roles` file via Git only, never its checkout/working tree. If an API may overlap its Chip/Card/Popover/SectionHead/Text/KeyValue/Alert/ListRow work, stop that design edit and report the desired path/API while continuing independent work. If either side lands a design-file PR first, rebase onto landed main before this branch's next commit to that same file; never force-push without separate authorization.

## Evidence

### Task 1 — Goal contract

- Red: `pnpm run build:node` exited 2 after dependencies were installed. TypeScript reported missing `Goal`, `GoalBoard`, `GoalReceipt`, `GoalSeatRequest`, `WrapPreview`, `activityOf`, `checkedDependencies`, `factsOfGoal`, and `membersOf` exports. The earlier setup-only failure (`tsc: command not found`) was not counted.
- Green: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/goal-model.test.js packages/protocol/dist/test/goal.test.js` exited 0; 11/11 tests passed.
- Mutation, restored-history membership guard: removed `&& !seat.restored`; the same production build plus `goal-model.test.js` exited 1 with 1 failed / 8 passed. `membership includes only open kept Seats on this Goal` received `['s1', 'restored']` instead of `['s1']`. Restored the guard and reran both suites: 11/11 passed, exit 0.
- Full `mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify`: exit 0, `All checks passed.` Lockfile install, build, Node/gate/UI/desktop tests, layering, half-applied fixes, tracked secrets, reachable methods, notices, design tokens/drift/UI system/docs, interface drift, recorded claims, doc paths, CI parity, Codex protocol drift and documented-step checks all passed.

### Task 2 — Goal persistence and migration kernel

- Deliberate sequencing: host startup activation and the non-mutating Goal-backed Team projection land with Task 3, which introduces the authoritative `GoalPlane`/Team adapter. Wiring the legacy mutation-heavy `Team.load()` now would create the partial-migration behavior the plan forbids. The Task 2 store, converter, lease, and SeatBook changes are independently durable and tested; Task 3 is not complete until it consumes them in startup.
- Phase 4B dependency: `SeatRecordBlock` and its renderer test are not present in this base. The `StandingOrder` protocol/reader change is complete; the “Not recorded” renderer copy remains deferred until Phase 4B lands.
- Plan correction: legacy IDs longer than a filesystem filename use `h-<sha256>.json`, retain the complete ID inside the document/index, and resolve by that stored ID. Added a 4,096-character round-trip test.
- Red: `pnpm run build:node` exited 1 with missing `goals/migration.js`, `goals/store.js`, `goals/writer-lease.js`, missing `SeatBook.importOpening/all/closeId`, and the absent `unknown` standing-order arm.
- Green: production build plus Goal migration/store/writer/SeatBook and protocol evidence suites exited 0; 25/25 focused tests passed. The expanded run including existing Team, room restart, and room worktree suites exited 0; 190/190 tests passed.
- Mutation, historical identity: changed conversion to prefix every ID with `new-`. `goal-migration.test.js` exited 1 with 4 failed / 4 passed: historical shape lookup, durable readback, reserved filename, and 4,096-character identity all failed. Restored the exact ID and reran the expanded suite green (190/190).
- Full `mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify`: exit 0, `All checks passed.`

### Task 3 — Seat-derived membership and assignment

- Red: `pnpm run build:node` exited 2 with missing `goals/assignments.js`, `goals/members.js`, `goals/plane.js`, missing journal replay exports, and missing Goal wire/handler context.
- Green, focused: production build plus assignment/membership/journal/GoalPlane/flow-compatibility/Host/wire suites exited 0; 29/29 tests passed.
- Green, retained integration boundaries: `team.test.js`, `flows.test.js`, `host-flow.test.js`, `agent-seat.test.js`, `room-restart.test.js`, and `room-worktree.test.js` exited 0; 352/352 tests passed. Existing runtime readback, brief-once, cleanup, linked-worktree, restart, messaging-guard, flow/rearm and board assertions stayed at their original layers.
- Added real Host proof: a live compatibility join writes a durable Goal Seat; Goal create, board mutation, assignment, Release, and restart all route through the real socket/Host and read back durable state.
- Mutation, shared serial: bypassed `this.#tail.then(fn)` with a direct call. `goal-assignment.test.js` exited 1 with 2 failed / 7 passed; both concurrent cases kept two Seats instead of one. Restored the shared queue.
- Mutation, post-await authorization: removed the second `allowed()` check from `dispatchAfter`. `goal-assignment.test.js` exited 1 with 1 failed / 8 passed; the prepared effect dispatched after membership changed. Restored the recheck.
- Existing test edits: `wire.test.ts` adds the required relative-cwd request for `goal/create`; `agent-seat` production behavior now writes the durable Seat before the first brief while retaining all original assertions; Team wire mutators await their durable Goal-backed flush; legacy FlowPort test adapters remain temporarily accepted while every production Host flow uses awaited `openLegacySeat` and no asynchronous `recorded` callback.
- Task 2 startup integration is now consumed here: writer lease precedes state changes, Evidence/Seat load precedes migration, fixed-ID imports precede activation, queued mail is refused on recovery, Goal operations replay before traffic, and the Goal-backed Team projection restores members from Seats and historical display data from migration metadata.
- Full-gate attempt 1: failed in the Node phase with seven leaf failures (eight including the parent suite). Exact causes were a hand-built method context without `Team.flush`, migration errors bypassing the existing startup logger, an unpinned empty-root validator sentence for `goal/create`, and the pre-lane compatibility path no longer cutting isolated flow worktrees. Fixed those exact seams; focused reruns passed 17/17 plus the nine-case room/flow confinement group.
- Verification scheduling: every subsequent full `pnpm verify` is serialized across phase writers by an owned atomic `/tmp/hd-agents-goals-verify.lock`; the lock records shell PID/worktree, waits for a live owner, recovers only a proven-dead owner, and is released only by its owner in a trap. Focused tests do not hold it.
- Locked full `TMPDIR=/tmp/hdv pnpm verify`: exit 0, `All checks passed.` The cross-phase lock was acquired atomically, recorded PID/worktree, and released by its owner trap. Complete Node, gate, UI, desktop, layering, reachability, design, interface, docs, CI-parity and protocol-drift checks passed.

### Task 4 — durable lanes and machine preferences

- Red: `pnpm run build:node` exited 1 with missing `goals/lanes.js` and missing `Lane`, `LanePreferences`, and `lanePreferences` exports.
- Green: production build plus allocation/store/recovery/preferences/listener suites exited 0; 23/23 tests passed. The listener proof ran identical HTTP servers concurrently from distinct managed worktrees and disjoint port blocks, then proved an unrelated listener makes its whole candidate block unavailable and probe sockets close.
- Mutation, retained ownership: excluded retained leases from `firstBlock`; allocation suite exited 1 with 1 failed / 10 passed and reused `{start:65501,end:65518}` instead of returning no block. Restored.
- Mutation, write ordering: moved the in-memory registry update before the durable write; store suite exited 1 with 1 failed / 3 passed and exposed `retained` after a failed save instead of durable `reserved`. Restored.
- Mutation, restored authority: removed the restored-Seat filter during recovery; recovery suite exited 1 with 1 failed / 2 passed and bound `history` instead of leaving the lane unowned. Restored.
- Plan correction consumed: added `lane/list` as the authorized renderer seam for every retained/failed-unbound descriptor, backed by `LaneAllocator.listLanes`; pinned only until Task 9 connects Workspaces › Lanes.
- Existing flow isolation assertion now expects the durable opaque `harnessdesk/lane-<uuid>` branch instead of the retired role/run-derived worktree name.
- Full locked attempt 1: Node/UI/desktop/layering and every other gate passed; reachability alone failed because the three planned Task 9 lane callers (`lane/preferences`, `/set`, `/release`) lacked their temporary named pins. Added those exact pins beside `lane/list`; no implementation or test assertion was weakened.
- Full locked rerun: exit 0, `All checks passed.` The shared lock was acquired after a live owner finished and released by the matching owner trap.

### Task 5 — per-session lane environments

- Red: `pnpm run build:node` exited 2 with the absent `laneEnvironmentOf` contract and adapter/host environment seams. A later resume regression test exited 2 because `environmentForSession` was not exported; it was added before the production fix.
- Green: the final production build plus protocol, native adapter, shared ACP adapter, Claude bridge, Cursor bridge, and real Host suites exited 0; 19/19 focused tests passed. Two real child processes inherited different six-value environments without mutating their parent; native create/resume/fork and both bridge restart paths re-applied the same allocation.
- Real native probe: `/opt/homebrew/bin/codex` reported `codex-cli 0.155.0`; two real app-server sessions started and resumed with independent values for `HARNESSDESK_GOAL_ID`, `HARNESSDESK_LANE_ID`, `HARNESSDESK_PORT_START`, `HARNESSDESK_PORT_END`, `HARNESSDESK_PORT_COUNT`, and `PORT`. The probe removed exactly its two synthetic conversations and temporary cwd in `finally`, then the native capability was enabled.
- Real Host proof: Goal seating allocated an actual managed worktree, handed exactly six values to the runtime, persisted the Seat, and included every value plus explicit-port advice in the first standing-order turn. Resume now finds retained allocation through the durable Seat and lane registry without requiring the runtime to read an otherwise unknown plain conversation.
- Plan correction: the fake Claude CLI does not write Claude's transcript store. The restart test writes one minimal synthetic transcript row before constructing the second bridge, which lets the real discovery path recover its cwd without claiming fixture behavior the fake does not implement.
- Mutation, bridge child environment: removed Claude's environment merge; its suite exited 1 with 2 failed / 2 passed, including null child values and no expected bridge log. Restored.
- Mutation, native app-server configuration: removed the `shell_environment_policy.set` configuration; the native suite exited 1 with 2/2 failed. Restored.
- Mutation, central standing order: removed the environment from the single `#orderSeat` path; the server suite exited 1 with 1 failed / 3 passed because the real Goal Seat's first turn lacked the allocation. Restored.
- Mutation, unsupported-runtime guard: bypassed `requireLaneSupport`; the server suite exited 1 with 1 failed / 3 passed because the expected refusal was absent. Restored.
- Mutation, conflicting resume ownership: removed the multi-lane conflict guard; the named resume test exited 1 with 1/1 failed (`Missing expected exception`). Restored; the final focused matrix passed 19/19.
- Full locked attempt 1: exit 1. Ten Node failures exposed two contract snapshots (`sessionEnvironment` in the UI fallback and the Claude bridge's production protocol dependency), the fake runtime advertising no lane support in existing isolated-flow tests, and a resume lookup that read an unknown runtime conversation before checking durable Seats; one Codex history case also hit a transient SQLite lock. The exact deterministic seams were fixed without weakening assertions. Expanded reruns passed 63/63, the isolated-flow group passed 9/9, and UI typecheck passed.
- Full locked attempt 2: exit 1 with 2,853/2,854 Node tests passed; the existing filesystem-watch liveness probe alone exceeded its five-second deadline under full-suite load. Its complete suite immediately passed 32/32 in isolation.
- Full locked rerun: exit 0, `All checks passed.` Node, gate, UI, desktop, layering, security/reachability, notices, design, interface/docs, CI-parity and protocol-drift checks all passed; the matching owner released the shared verify lock.

### Task 6 — invocation-scoped browser profiles

- Red, scope owner: the first `pnpm run build:node` exited 2 because `browser-scopes.js` and its identity/profile APIs did not exist. After the host kernel compiled, the new renderer suite exited with 3/3 failures: lane A and B resolved to the same BrowserView, persisted lane identity collapsed, and both webviews used the default partition.
- Green, focused: production build plus Cordis scope, real supervised child IPC, desktop engine/channel, lane renderer, existing BrowserPane and store-browser suites passed. The Node/desktop command passed 30/30; the renderer command passed 70/70; the expanded integration command passed 131/131; UI typecheck passed.
- Real child boundary: two concurrent `plugin-browser` calls travelled through the actual child IPC and parent-issued leases, returned only their resolved `lane-a`/`lane-b` profile, and an unscoped call was refused without allocating an engine profile.
- Mutation, shared state: changed `BrowserScopes.current()` to always use `default`; `browser-scopes.test.js` failed 1/5 because each lane observed both values. Restored and reran 5/5 green.
- Mutation, wrong guest: changed desktop `ensure()` to reuse the first guest; `browser-scopes.test.mjs` failed 1/4 with “That page is not open in this browser profile.” Restored and reran 4/4 green.
- Mutation, hidden guest: removed `await front(profile)` before CDP send; `ipc-channels.test.mjs` failed 1/8 at `the shell awaits a fronted profile before sending a command`. Restored and reran 8/8 green.
- Full locked attempt 1: Node failed 1/2,860 at the existing kernel shutdown contract because the new profile map had no default entry on an idle desk, so the installed pane engine was not closed or awaited. Added default-state initialization before enumerating shutdown profiles; the named kernel suite passed 12/12. The first lock wrapper also used zsh's reserved `status` name after the gate; its dead PID/token/worktree lock was verified stable and recovered exactly, then the wrapper was corrected to preserve `verify_exit`.
- Plan corrections: an absent extension kernel has no browser tools to misroute and remains valid for headless/tests; only an installed extension host lacking `setBrowserResolver` refuses isolated seating. Task 6's stale reviewer/trailer directions now name the required Luna native-driving route and HarnessDesk Agent trailer.
- Native acceptance route: the shared `desk-app` is Luna's orchestration surface only. The actual Electron proof will build and launch this phase worktree through `script/shots` with its own isolated `HARNESSDESK_HOME`; it does not require updating or restarting the shared desk. No video or recording will be produced.
- Full locked rerun: exit 0, `All checks passed.` Complete Node, gate, UI, desktop, layering, security/reachability, notices, strict design/UI-system, interface/docs, CI-parity and Codex protocol drift checks passed; the owned lock was released.

### Task 7 — Goal-guarded messaging and event-driven member waits

- Red: the first production build exited 2 because the Goal member-wait registry and `memberNames` did not exist. The new source-label assertion was also run against a deliberate fallback to the old runtime-only source and failed on `Message from codex` instead of the recorded Agent/Seat/Goal context.
- Green: the final server registry/Goal-guard/legacy-Team/migration matrix passed 162/162; Cordis permission, built-in plugin and live extension-child integration passed 98/98. The retained Host duplicate-name case also passed with its intentional Goal naming contract.
- Captured-turn mutation: compared completion with the member's new live turn instead of the turn captured by the waiter; the named test failed with one waiter left instead of zero. Restored and passed.
- Post-prepare authorization mutation: removed the direct-send `allowed` callback; the released-sender test delivered into the former Goal instead of recording refusal. Restored and passed.
- Invocation mutation: disabled the supervisor's live armed-invocation check; the existing forged-scope test reached Team status. Restored and passed.
- Pending-cap mutation: changing the eight-message boundary to nine first exposed that the old full-queue assertion did not isolate the ninth message. Added the exact ninth-message regression; under the mutation it queued, then passed after restoring eight. This is a test correction, not a weakened production guard.
- Source-label mutation: forced `#messageSource` through the legacy runtime/title fallback; the new delivered-message test failed on `Message from codex`. Restored behavior identifies recorded Agent `Builder`, Seat label, standing permission, unknown ceiling and Goal sentence, and the test passed.
- Full locked attempt 1: exit 1 with 2,871/2,872 Node tests passing. The only failure was a retained Host test still expecting pre-Goal `Reviewer`, `Reviewer 2`; actual names followed the Task 7 contract, `Reviewer · Seat Fake · Big · High` and its numbered collision. Updated that retained expectation and test title; no production behavior changed for the correction.
- Full locked attempt 2: exit 1 with 2,872/2,873 Node tests passing. Only the existing filesystem-watch liveness probe exceeded its five-second deadline under full-suite load; the exact named probe immediately passed 1/1 in 2.7 seconds.
- Full locked rerun: exit 0, `All checks passed.` The run waited for the live Phase 4B owner, acquired the shared lock atomically, passed Node/gate/UI/desktop/layering/security/reachability/notices/strict design/interface/docs/CI-parity/protocol-drift checks, and released only its matching PID/token lock.
