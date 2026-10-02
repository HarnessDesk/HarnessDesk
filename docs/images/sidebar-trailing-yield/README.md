# Sidebar trailing rail evidence

Frames from the synthetic preview harness and the isolated fake-agent native rig, inspected individually in both themes. Preview frames passed the repository's unchanged `COLLECT` / `textReasons` privacy audit before capture. Native frames passed the native smoke rig's privacy and geometry checks. No real desk was photographed.

The 32 preview frames cover sidebar widths 200, 260, 320 and 540px in light and dark, at rest and while hovering the Working room, its member, and the Needs you room. The six `native-*` frames cover session rest, workspace hover and session hover in light and dark. The catalogue guide marks the trailing target's right edge, inset 20px; glyph centres are inset 32px.

The Working-room measurements are identical in both themes:

| Sidebar width | Title width | Count shown | Chip right edge relative to rail | Gap after visible title |
| --- | --- | --- | --- | --- |
| 200px | 74.75px | No | 0px | 4px |
| 260px | 110.75px | Yes | -24px | 4px |
| 320px | 170.75px | Yes | -24px | 4px |
| 540px | 390.75px | Yes | -24px | 205.39px |

At 540px the title's natural text width is 189.36px. The 205.39px gap consists of 201.39px of unused title width plus the 4px title/chip gap. The short title is fully visible; a longer title can use the entire title box.

Before the change, the 200px Working room showed the count and left only 2.75px for its title. At 200, 260 and 320px the full chip ended 48px before its available rail; at 540px it ended 201.39px before it. Parent and member actions both had opacity 1 when either row was hovered or focused. The four new owner-decision tests failed on that baseline, then passed with the shared grammar correction.

Validation: 149 focused sidebar unit tests, 36 sidebar browser tests, six native app frames plus About and relaunch persistence, strict design audit, and the complete `pnpm verify` gate passed. All 38 frames were inspected: state chips are whole at rest, counts yield at the narrow width, and only the hovered row's actions appear. Hovering folds the chip to its dot, clears the actions, and preserves or increases the title's available width.
