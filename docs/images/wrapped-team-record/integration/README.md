# Wrapped record integration frames

Before source: `1e7593490ee05cb73d7c05d16dee716b9e321faf`.
After source: `64c40f5c467f313775b52a71502f1f0d978bf8f2`.
Integrated main: `3003b787`.

These 30 inspected frames use production components in `preview.html?team-record` with synthetic data. No frame comes from a real desk. Both themes are included. Narrow and person scenes are 384 pixels wide.

The receipt, older receipt, narrow receipt, person receipt and unlinked sidebar frames are byte-identical before and after in both themes. The Run changes to retain main's inspector and Timeline/Flow control. Additional after frames show the Flow tab, an older receipt's Run details and a card whose conversation was not kept. This preview's older Flow records no steps or card-to-Seat operations; the views say what was recorded. Linked card openings and retained costs are covered by unit fixtures that record those operations.

| Scene | Before light | Before dark | After light | After dark |
| --- | --- | --- | --- | --- |
| Wrapped receipt | [light](before/wrapped-light.png) | [dark](before/wrapped-dark.png) | [light](after/wrapped-light.png) | [dark](after/wrapped-dark.png) |
| Older receipt | [light](before/older-light.png) | [dark](before/older-dark.png) | [light](after/older-light.png) | [dark](after/older-dark.png) |
| Narrow receipt | [light](before/narrow-light.png) | [dark](before/narrow-dark.png) | [light](after/narrow-light.png) | [dark](after/narrow-dark.png) |
| Team that never had a Run | [light](before/person-light.png) | [dark](before/person-dark.png) | [light](after/person-light.png) | [dark](after/person-dark.png) |
| Sidebar Seats without conversations | [light](before/sidebar-unlinked-light.png) | [dark](before/sidebar-unlinked-dark.png) | [light](after/sidebar-unlinked-light.png) | [dark](after/sidebar-unlinked-dark.png) |
| Run timeline and detail | [light](before/run-light.png) | [dark](before/run-dark.png) | [light](after/run-light.png) | [dark](after/run-dark.png) |

| Additional integrated view | Light | Dark |
| --- | --- | --- |
| Flow tab | [light](after/flow-light.png) | [dark](after/flow-dark.png) |
| Older receipt Run details | [light](after/older-inspector-light.png) | [dark](after/older-inspector-dark.png) |
| Unlinked Seat card detail | [light](after/unlinked-inspector-light.png) | [dark](after/unlinked-inspector-dark.png) |
