# Team Overview preview evidence

All 26 preview frames and both catalogue frames below were rendered from the production components in the preview harness with synthetic identities, then inspected by eye. The catalogue mounts the same ten Overview cases at `design.html?view=team-overview`; the preview is `preview.html?team-overview`.

PR title: **Team Overview: keep every Flow Seat visible**

Review round 3 repair source: `23eb1fd4fb69c7d92b2606ecfb76342e4e190e0f` on `team-overview-pr2`, merging `60677c931dea1828124d92b1b103b98c8757de53` from `origin/main`. Every one of the 28 frames was recaptured after that merge, opened individually, and inspected in both themes.

The bullets were a capture-harness defect: the standalone SessionTree omitted the production Sidebar's RailSection wrapper, so its outer lists missed the scoped reset and retained `list-style: disc` and 40px browser padding. The production Sidebar computed `list-style: none`. The preview now uses the same RailSection; its browser regression failed on the two outer lists before this fix and passed afterward. The Team row continues to use SidebarMenuState, inheriting main's quiet Chip variant. Both sidebar frames show coloured Working text on the inset rail, with no pill or bullets.

Inspection: running and needs-you retain attention order and whole attention sentences; unread and idle retain quiet resting ink; stalled and no-run show their recorded state; no-seats retains the Team empty state; done and done-open retain the fold and all three finished Seats. Narrow and catalogue-narrow keep all four Seats within the pane. Team and team-open keep Agents 2, Done labels and both finished Seats. All images contain only the synthetic preview identities.

Validation for this source: 305 focused UI tests passed; UI typecheck, strict design audit and catalogue coverage passed. The eight named browser suites passed 60 of 61 tests (exit 1): Overview, sidebar rail geometry, hover, quiet roles, seat menus, faces and side-by-side passed. The additional `sidebar-keyboard.spec.ts:39` assertion failed because it infers a project parent from the previous expanded row, while the first conversation is now a nested Team member and ArrowLeft correctly focuses that Team. The identical failure reproduced on the already-approved round-2 head `4f5d856a939be2fdad3a920b87dae78a3e628fc3`; the test passes on main at `60677c931dea1828124d92b1b103b98c8757de53`. This round leaves that earlier test assumption unchanged under its repair-only scope. The unpiped `TMPDIR=/tmp/hdv pnpm verify` run printed `All checks passed.` (exit 0).

What changed: Overview shows Run status, attention and recorded usage, shares conversation-keyed Seats with the rail and sidebar, and folds finished Seats while retaining their rows. The synthetic Host rig returned one board member and open Goal Seat during writing, then two of each during review and after settling, with both `closed` fields null; regressions also cover an empty older roster. How to test: run the focused UI tests, UI typecheck, named browser specs, strict design audit and the unpiped full verification gate; actions, wrapped receipts and host process lifecycle remain in their planned PRs.

Closes #1278

```sh
pnpm --filter @harnessdesk/ui exec vitest run src/lib/team-seats.test.ts src/lib/team-overview.test.ts src/components/TeamOverview.test.tsx src/components/TeamRoomPane.test.tsx src/components/SessionTree.test.tsx src/design/patterns/SidebarMenuState.test.tsx src/design/patterns/Settings.chip.test.tsx src/design/ui/sidebar.test.tsx
pnpm --filter @harnessdesk/ui run typecheck
pnpm exec playwright test -c playwright.ui-system.config.ts e2e/ui-system/team-overview.spec.ts e2e/ui-system/sidebar-edges.spec.ts e2e/ui-system/sidebar-hover.spec.ts e2e/ui-system/sidebar-roles.spec.ts e2e/ui-system/sidebar-keyboard.spec.ts e2e/ui-system/sidebar-seat-menu.spec.ts e2e/ui-system/faces.spec.ts e2e/ui-system/side-by-side.spec.ts
node script/design-audit.mjs --strict
node script/ui-catalog.mjs
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify
```

| State | Light | Dark |
| --- | --- | --- |
| Running | [running-light.png](running-light.png) | [running-dark.png](running-dark.png) |
| Needs you | [needs-you-light.png](needs-you-light.png) | [needs-you-dark.png](needs-you-dark.png) |
| Unread | [unread-light.png](unread-light.png) | [unread-dark.png](unread-dark.png) |
| Idle | [idle-light.png](idle-light.png) | [idle-dark.png](idle-dark.png) |
| Stalled Run | [stalled-light.png](stalled-light.png) | [stalled-dark.png](stalled-dark.png) |
| No Run | [no-run-light.png](no-run-light.png) | [no-run-dark.png](no-run-dark.png) |
| No Seats | [no-seats-light.png](no-seats-light.png) | [no-seats-dark.png](no-seats-dark.png) |
| Three done, folded | [done-light.png](done-light.png) | [done-dark.png](done-dark.png) |
| Three done, open | [done-open-light.png](done-open-light.png) | [done-open-dark.png](done-open-dark.png) |
| Narrow | [narrow-light.png](narrow-light.png) | [narrow-dark.png](narrow-dark.png) |
| Team with two done, folded | [team-light.png](team-light.png) | [team-dark.png](team-dark.png) |
| Team with two done, open | [team-open-light.png](team-open-light.png) | [team-open-dark.png](team-open-dark.png) |
| Nested conversations | [sidebar-light.png](sidebar-light.png) | [sidebar-dark.png](sidebar-dark.png) |
| Catalogue narrow | [catalog-narrow-light.png](catalog-narrow-light.png) | [catalog-narrow-dark.png](catalog-narrow-dark.png) |
