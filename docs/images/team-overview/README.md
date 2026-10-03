# Team Overview preview evidence

All 26 frames below were rendered from the production components in the preview harness with synthetic identities, then inspected by eye. The catalogue mounts the same ten Overview cases at `design.html?view=team-overview`; the preview is `preview.html?team-overview`.

PR title: **Team Overview: keep every Flow Seat visible**

What changed: Overview shows Run status, attention and recorded usage, shares conversation-keyed Seats with the rail and sidebar, and folds finished Seats while retaining their rows. The synthetic Host rig returned one board member and open Goal Seat during writing, then two of each during review and after settling, with both `closed` fields null; regressions also cover an empty older roster, and Run start time remains absent until its projection lands. How to test: run the focused UI tests, UI typecheck, named browser specs, strict design audit and the unpiped full verification gate; actions, wrapped receipts and host process lifecycle remain in their planned PRs.

Closes #1278

```sh
pnpm --filter @harnessdesk/ui exec vitest run src/lib/team-seats.test.ts src/lib/team-overview.test.ts src/components/TeamOverview.test.tsx src/components/TeamRoomPane.test.tsx src/components/SessionTree.test.tsx
pnpm --filter @harnessdesk/ui run typecheck
pnpm exec playwright test -c playwright.ui-system.config.ts e2e/ui-system/team-overview.spec.ts e2e/ui-system/sidebar-edges.spec.ts e2e/ui-system/sidebar-hover.spec.ts e2e/ui-system/faces.spec.ts e2e/ui-system/side-by-side.spec.ts
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
