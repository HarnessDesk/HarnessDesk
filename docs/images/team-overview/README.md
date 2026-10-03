# Team Overview round 4 evidence

Repair source: `14fa41c68892b8ceb1608370f934a9e1b82561e8`. Review source: `6252f14f84da4505f3c1daf87b613d6a65caf322`, which merges main's `ccc4e99a5c0e403ce1b14fe87f727f9be5ee11d1`. The merge adds Seat-rest host behavior; the rendered Overview components are unchanged from the repair source.

All 34 frames use the preview harness and synthetic identities. Each image was opened individually and inspected in both themes. The six `live-*` frames mount the production TeamRoomPane and show its shared live status line in the Run strip. The other frames cover the standalone Overview model, folded and expanded completed Seats, nested sidebar conversations, and narrow geometry.

The repair restores stall reasons, stopped-on-question guidance, the kept-answer action and refusal, and pending-release text through the existing RoomLiveLine. The front-door revision pin already passed and remains visible. TableCell now owns the first-line lead alignment: faces align with names, and role text shares the name's left edge. The census retains every prior ceiling except the five improved trailing-glyph signatures, reducing that count from 15 to 10.

| Scene inspected | Light | Dark | Observation in both frames |
| --- | --- | --- | --- |
| Production running | [light](live-running-light.png) | [dark](live-running-dark.png) | Run says Alpha is working; face marks centre on the first name line. |
| Production needs you | [light](live-needs-you-light.png) | [dark](live-needs-you-dark.png) | Run says Beta is waiting for your approval; the attention sentence arrives whole. |
| Production stalled | [light](live-stalled-light.png) | [dark](live-stalled-dark.png) | Run says Choose the target before this Run can continue; rows retain aligned faces. |
| Running | [light](running-light.png) | [dark](running-dark.png) | Attention, unread, working and idle precedence stays visible. |
| Needs you | [light](needs-you-light.png) | [dark](needs-you-dark.png) | Approval sentence wraps without clipping. |
| Unread | [light](unread-light.png) | [dark](unread-dark.png) | Unread state remains distinct from quiet resting text. |
| Idle | [light](idle-light.png) | [dark](idle-dark.png) | Resting ink stays quiet, and faces align with names. |
| Stalled model | [light](stalled-light.png) | [dark](stalled-dark.png) | Recorded stall reason and the Needs-you state remain visible. |
| No Run | [light](no-run-light.png) | [dark](no-run-dark.png) | The Seat list remains visible without a Run card. |
| No Seats | [light](no-seats-light.png) | [dark](no-seats-dark.png) | The Team empty state remains legible. |
| Three done, folded | [light](done-light.png) | [dark](done-dark.png) | Disclosure keeps the completed count. |
| Three done, expanded | [light](done-open-light.png) | [dark](done-open-dark.png) | All three finished rows remain available, with aligned faces. |
| Narrow | [light](narrow-light.png) | [dark](narrow-dark.png) | Four Seats stay within the pane; the attention sentence wraps whole. |
| Team, folded | [light](team-light.png) | [dark](team-dark.png) | Agents 2 and the 2 done disclosure remain present. |
| Team, expanded | [light](team-open-light.png) | [dark](team-open-dark.png) | Both finished Seats, their role text and Done state remain legible. |
| Nested conversations | [light](sidebar-light.png) | [dark](sidebar-dark.png) | Working uses quiet text; nested conversations have no bullets. |
| Catalogue narrow | [light](catalog-narrow-light.png) | [dark](catalog-narrow-dark.png) | Same narrow component geometry, with no horizontal overflow. |

Validation on the review source:

- The whole unsharded `pnpm test:ui-system` run exited 0: 410 passed, one investigation-only vertical-centering audit skipped (the repository's default).
- The added Overview assertions failed before the repair; the component suite then passed all 131 tests.
- `pnpm design:alignment` passed and lowered only the five improved signatures.
- `pnpm test:ui-system:native` exited 0: `native UI system smoke: 38 app frames plus About, relaunch persistence verified`.
- Unpiped `TMPDIR=/tmp/hdv pnpm verify` exited 0: `All checks passed.`

The first full browser run reported 408 passed, one skipped and two failures: the trajectory assertion read the original fixture instead of the staged ledger, and an overlapping diagnostic removed an active trace file. Trajectory passed alone, the contrast case passed three isolated runs, and both passed in the clean full run above. No assertion, retry setting or check was weakened.

```sh
pnpm --filter @harnessdesk/ui exec vitest run src/components/TeamRoomPane.test.tsx src/components/TeamOverview.test.tsx
pnpm design:alignment
pnpm test:ui-system
pnpm test:ui-system:native
TMPDIR=/tmp/hdv pnpm verify
```

Closes #1278
