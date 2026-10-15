# Review round 1 frames

These images come from the headless preview harness with its synthetic stores and demo identities. The code revision and validation are recorded in PR #1668.

| File pair | What was checked |
| --- | --- |
| teams-1100-light/dark.png | The body heading shares the page inset and content edge. |
| teams-1800-light/dark.png | The same heading inset at wide measure. |
| swapped-browser-light/dark.png | The pane occupies main and its resize seam remains on its boundary. |
| flow-push-light/dark.png | Flow remains selected after the fixture advances to review, with one bar and no duplicate sidebar. |
| wrapped-menu-light/dark.png | The wrapped Team's title menu omits Wrap. |

The earlier Teams offset is visible in `../page-titles/after/teams-1100-light.png` and its dark counterpart. The round 1 repair removes the compact top inset.

Each new image was read before publication. The focused shell regressions also exercise the seam from the keyboard, embedded command ownership, and live fixture updates.
