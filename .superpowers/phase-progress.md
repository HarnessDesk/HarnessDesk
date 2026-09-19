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
