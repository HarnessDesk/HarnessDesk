# Team Overview round 5 evidence

Repair source: `4b7fa281b8dc07acc9a9285889347138b9396a49`, the delta since `6252f14f84da4505f3c1daf87b613d6a65caf322`.

The repair is `c7ae212ef28ed20df4f26042ddcb99be6af7729d`; the review source includes an ordinary merge of main at `9012ec5377c91fed28d72654497cdb458f6fac8e`. Its one selector conflict keeps both the shared in-flight-item helper and finished-Seat attribution.

The Overview keeps the Run's own reason whenever its shared live line has not already shown it. A running Run with idle Seats now says what evidence it waits for; an unrouted settled Run keeps the outcome and why no rule continues. Stop and stall reasons remain on the live line once.

Ten production TeamRoomPane frames were recaptured from the preview harness and individually opened for this repair: running, approval, stalled, waiting on evidence and unrouted ending, in light and dark. Only synthetic identities appear. The new reasons are readable in the Run strip, the stalled reason appears once, and the working and approval guidance and aligned faces remain intact.

The other 28 images retain the [round 4 baseline evidence](https://github.com/HarnessDesk/HarnessDesk/blob/774bf57e42117e2ffe42c4d500640cde92bb08e5/docs/images/team-overview/README.md). This branch now has 38 frames.

| Scene inspected | Light | Dark | Observation in both frames |
| --- | --- | --- | --- |
| Production waiting on evidence | [light](live-waiting-evidence-light.png) | [dark](live-waiting-evidence-dark.png) | Running Run, both Seats idle; the Rule after-review evidence wait appears once. |
| Production unrouted ending | [light](live-unrouted-light.png) | [dark](live-unrouted-dark.png) | Settled Run keeps the revise outcome and why no rule continues, once, above the folded finished Seats. |
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

- Both new production Overview assertions failed before the repair: the running idle Run's evidence reason and the settled unrouted Run's reason were absent.
- `pnpm --filter @harnessdesk/ui exec vitest run src/components/TeamRoomPane.test.tsx src/components/TeamOverview.test.tsx src/lib/team-overview.test.ts` exited 0: 195 tests passed across three files after merging main.
- `pnpm --filter @harnessdesk/ui run typecheck` exited 0.
- `node script/design-audit.mjs --strict` exited 0; every enforced category remains at zero.
- `pnpm test:ui-system` exited 0: 412 passed, one investigation-only vertical-centering audit skipped under the repository's default configuration (whole unsharded run).
- Unpiped `TMPDIR=/tmp/hdv pnpm verify` exited 0: `All checks passed.`
- Documentation paths and recorded claims passed after the evidence update.

The first full browser run reported 410 passed, one investigation-only audit skipped and two failures. Preview coverage lost its evaluation context during a Vite full reload; trajectory read the original fixture instead of the staged ledger. Both traces were retained locally. Preview coverage, trajectory and all eight Team Overview cases passed in the clean full rerun above.

The first verification run reported one failure in the unrelated GoalFindings round-budget refresh test. That file passed all three tests alone; the full UI suite also passed all 4856 tests on an isolated snapshot of main at `ccc4e99a`. The final merged-source verification above passed. No assertion, timeout, retry setting or check was changed for these reruns.
