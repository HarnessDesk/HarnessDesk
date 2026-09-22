# Phase 3 ceiling walkthrough

This report separates live product observations from deterministic test proof.
Synthetic runtimes establish host behavior and presentation, not native-runtime
sandbox enforcement. A blocked case blocks phase acceptance.

## Test identity

- Product source: `25f1a201019c5cfee768c2d3a76942afd341fc13`
- Product version: `0.2.4`
- Installed native runtime version: `0.155.0`
- Desktop runtime: Electron `42.11.2`
- During the sitting, the product source was committed. This report and its
  capability-guide link were the only tracked changes; the isolated rig and
  local PNGs were ignored under `.plan-scratch/ceilings-run/`.
- Implemented seam: ceiling ladder, Agent parsing and writing, runtime
  hold/read-back, desk-tool gate, delegated-root correlation, peer-action
  approval, durable evidence, UI chips, Agent update flow and Settings policy.

## Outcomes

| Case | Setup and action | Observed result | Local artifact | Outcome |
| --- | --- | --- | --- | --- |
| Native read hold | The installed native runtime needed a dedicated signed-in home before a real write attempt could be made. | No isolated signed-in runtime was available. No personal profile or credential was copied or reused, and no synthetic rejection was substituted. | None | **Blocked** |
| Desk merge refusal | A synthetic publish/asked seat invoked the desk's merge tool with a synthetic number and reviewed head in a disposable repository. | The live host returned `Merge refused: this seat may publish, not merge` before forge execution. The repository HEAD and status were unchanged. The acceptance runtime did not expose a delegated-child path; the deterministic Task 6 tests remain that path's proof. | Local transcript and audit log | **Pass** |
| Asked presentation | An unsupported synthetic-runtime seat was inspected in the header, name card, room rail, roster and a real claimed-card holder. | Each governed surface showed its effective ceiling as asked, in the warning treatment. The holder was canonically `claimed` by the governed seat and visibly showed `Read · asked`. | `ceiling-header-*`, `ceiling-name-card-*`, `ceiling-room-rail-*`, `ceiling-roster-*`, `ceiling-holder-*` | **Pass** |
| Flow compatibility | The rig opened a dry run containing a legacy `permission: read` role and a publish role. | The legacy role rendered `Edit · asked`, the publish role rendered `Publish · asked`, and the source remained on the legacy key. | `ceiling-flow-dry-*` | **Pass** |
| Legacy and missing-key Update | The visible Agent page exercised cancel, a successful legacy-key write, an external edit after preview, and a missing-key write after selecting Allow Edit. | Cancel preserved the file and returned focus. The successful paths wrote exactly `ceiling: edit` and removed their flags. The stale preview was refused with `This line cannot be written`; the external bytes were preserved. | `ceiling-update-*`; local file observations | **Pass** |
| Settings policy | The rig inspected all four level/hold chips per runtime, selected the refusal policy, reopened Settings, followed the focused section, then restored the default. | `Refuse to seat it` persisted across reopen. `Seat it and say so` was restored and the stored watched policy read back as `seat`. Approvals and Rules remained present. | `ceiling-settings-seat-*`, `ceiling-settings-refuse-*`, `ceiling-settings-narrow-*` | **Pass** |
| Peer message authority | A read sender used the real team message tool to ask a merge-capable receiver to act. The receiver made the actual desk-tool calls. | Refuse prevented the merge; Allow it once admitted one safe pull-request attempt in a disposable unpushed repository; a later merge request timed out unanswered. The UI named sender and receiver and explained that a message cannot carry a ceiling across. Audit outcomes were `refuse`, `allow`, and `timedOut`; the repository stayed unchanged. | Local transcript and audit log | **Pass** |
| Plain conversation | The rig opened an ordinary new conversation. | No ceiling chip, Agent prompt or Agent-created repository folder appeared. | `ceiling-plain-*` | **Pass** |
| Restart restoration | Legacy-key edit/asked and current-key publish/asked seats were recorded, the isolated host was closed and relaunched, and both conversations were reopened. | Both session identities and effective ceilings agreed before and after restart. | Local machine result | **Pass** |
| Themes, keyboard and narrow layout | Every accepted synthetic surface was checked in light and dark. Settings was also opened at 900 CSS pixels. | All 49 visible level/hold chips had equal `scrollWidth` and `clientWidth`; none crossed its row or viewport, overlapped another control, or became unreadable. The explanatory sentence wrapped. Dialog Escape/focus return and section focus were checked. | `ceiling-settings-narrow-*` and the surface pairs above | **Pass** |

`*` means separate `-light.png` and `-dark.png` local artifacts. No screenshot
is published by this report.

## Rig and visual checks

The built product was launched against an isolated synthetic home and
disposable workspaces. The orchestration desk was separate from the product
under test. The rig isolation and screenshot-audit suites passed 23 of 23, and
the UI-system browser suite passed 120 of 120 on a private temporary port.

Every accepted frame passed the repository's `refuseUnpublishable` audit and
was inspected at original resolution. The Settings matrix, warning chips,
one-line update diff, plain control and claimed-card holder were readable in
both themes. An early dark name-card capture and early holder captures were
rejected because they did not show the intended surface; corrected captures
were audited and inspected before being accepted. The narrow frames showed no
chip overflow or clipping.

The peer-action result is additionally corroborated by the persisted receiver
transcript and audit entries: refusal and timeout ran no forge action, and the
allowed safe attempt stopped because its disposable branch was not published.
The restart comparison used the host's reopened session values rather than a
renderer assignment.

The sitting used no video or recording. It did not open, copy or modify a
personal desk or runtime profile. Synthetic frames remain local for controller
review and are not committed here.

## Acceptance status

Phase acceptance is **blocked only on the credential-dependent native read
denial**. Every noncredential host, UI, peer-message and restart case completed.
To clear the phase, run the native case from a dedicated signed-in runtime home:
seat a read Agent, verify read-only and person-review controls read back, make an
actual native write-tool attempt without escalation, refuse any approval, and
confirm the probe file is absent. Synthetic evidence must not replace that run.
