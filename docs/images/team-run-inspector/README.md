# Run inspector review frames

Synthetic preview data only. These 28 personally inspected frames mount the
production Run inspector and responsive workspace; the Team frames also mount
its connected read wrapper.
Code revision: `501a4f64a19c1f3a6fb0916958b0ba68f5f1c21d`.

Card and person data are held in the shape the host really stores: the
authored sentence is a Flow's `detail: |` block, so it ends in a newline, and
the host's completion and split instructions follow after more than one blank
line. Their human-facing detail keeps only the authored sentence. The card
depends on the source card, while the intervening check has an unrelated
handoff.

Only the Run and Authorized budget frames hold a Run that recorded a budget,
with an authorization for two rounds after round three. Every other Run here
recorded no findings, so its Budgets say "Limit not recorded" rather than
borrowing a limit it was never given.

| Frame | Light | Dark |
| --- | --- | --- |
| Run | [light](run-light.png) | [dark](run-dark.png) |
| Authorized budget, scrolled detail | [light](run-budget-light.png) | [dark](run-budget-dark.png) |
| Card | [light](card-light.png) | [dark](card-dark.png) |
| Check | [light](check-light.png) | [dark](check-dark.png) |
| Person's step | [light](person-light.png) | [dark](person-dark.png) |
| Findings | [light](findings-light.png) | [dark](findings-dark.png) |
| Findings still being read | [light](findings-reading-light.png) | [dark](findings-reading-dark.png) |
| Findings could not be read | [light](findings-failed-light.png) | [dark](findings-failed-dark.png) |
| No rounds | [light](empty-light.png) | [dark](empty-dark.png) |
| Reading | [light](pending-light.png) | [dark](pending-dark.png) |
| Failed read | [light](failed-light.png) | [dark](failed-dark.png) |
| Connected Team | [light](team-light.png) | [dark](team-dark.png) |
| Narrow timeline | [light](narrow-timeline-light.png) | [dark](narrow-timeline-dark.png) |
| Narrow pushed detail | [light](narrow-detail-light.png) | [dark](narrow-detail-dark.png) |

The detail body scrolls independently, keeping the back link and heading visible.
