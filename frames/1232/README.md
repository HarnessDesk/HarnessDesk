# Issue #1232 frame evidence

Source commit: `6ecfe1a3b5ba7459672d08ffe91ec819b348895a`.

Captured from the preview and design catalogue rigs at 1440 × 900, in light and dark. Every image was opened and inspected. No real desk or account was used.

The composer dismiss delta against Send's visible right edge fell from 2.5px to 0.5px. Goal clear's delta against its alert text edge fell from 8.5px to 0px. The marked dock label's delta against the inspector search text, and the plain pane label's delta against its search lead, fell from 6px to 0px.

These browser frames compute `--titlebar-inset: 0px`. None of their original header reports is explained solely by native window controls. The census had compared Activity with a later status chip, room titles with an unrelated section label, and an approval title with the text inside an independently inset code box. Those references are corrected. Actual dock/pane label offsets are fixed in `DockPanelBar` and `DockPanelTab`.

A separate browser probe on the real narrow-overlay and zoomed-dock headers applied an 80px native inset: both produced zero header findings after normalization. Adding an extra 8px text offset produced one finding in each. The committed regression also checks the residual offset and a header that lacks the corner marker.

## Per-frame classification

Each row links both final themes. “Dock label” means the real 6px offset, fixed in the shared design component; the incorrect status-chip reference is also corrected.

| Frame | Header classification | Light | Dark |
| --- | --- | --- | --- |
| narrow-overlay | Dock label; not a native-inset artefact | [frame](light-narrow-overlay.png) | [frame](dark-narrow-overlay.png) |
| room-board | Dock label; room/nav reference artefact | [frame](light-room-board.png) | [frame](dark-room-board.png) |
| room-pending-approval | Dock label; room/nav and nested approval-code reference artefacts | [frame](light-room-pending-approval.png) | [frame](dark-room-pending-approval.png) |
| room-container-query | Dock label; room/nav reference artefact | [frame](light-room-container-query.png) | [frame](dark-room-container-query.png) |
| folder-gone | Dock label | [frame](light-folder-gone.png) | [frame](dark-folder-gone.png) |
| zoomed-sidebar | No header finding in the visible surface | [frame](light-zoomed-sidebar.png) | [frame](dark-zoomed-sidebar.png) |
| zoomed-dock | Dock label; not a native-inset artefact | [frame](light-zoomed-dock.png) | [frame](dark-zoomed-dock.png) |
| split-composers | Dock label | [frame](light-split-composers.png) | [frame](dark-split-composers.png) |
| split-unfocused-composer | Dock label plus real 6px plain pane-label offset | [frame](light-split-unfocused-composer.png) | [frame](dark-split-unfocused-composer.png) |
| composer-strip | Dock label | [frame](light-composer-strip.png) | [frame](dark-composer-strip.png) |
| pane-bar-strip | Dock label plus real 6px plain pane-label offset | [frame](light-pane-bar-strip.png) | [frame](dark-pane-bar-strip.png) |

The whole-frame census now measures all eleven cases and requires zero findings for all three checks, without per-frame exemptions. `BEHAVIOUR_FIXTURES` had already been removed from current main; these frames now live behind `preview.html?notice-placement` and are covered explicitly.

## Additional control captures

- Goal clear: [light](light-goal-clear.png), [dark](dark-goal-clear.png).
- Transcript Edit aligned with its message column: [light](light-message-footer.png), [dark](dark-message-footer.png).

## Reproduce

```sh
NOTICE_FRAME_DIR=output/1232-final-frames NOTICE_FRAME_PREFIX=light pnpm exec playwright test -c playwright.ui-system.config.ts notice-layouts.spec.ts
NOTICE_FRAME_THEME=dark NOTICE_FRAME_DIR=output/1232-final-frames NOTICE_FRAME_PREFIX=dark pnpm exec playwright test -c playwright.ui-system.config.ts notice-layouts.spec.ts
pnpm design:alignment
```
