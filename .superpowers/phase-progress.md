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
