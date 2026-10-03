# Sidebar trailing rail, round 2 evidence

Every preview frame uses the synthetic catalogue store; every native frame uses the isolated fake-agent rig. All 38 images were opened and inspected individually. The unchanged screenshot privacy audit passed before each capture. No real desk was photographed.

`rail` in `measurements.json` is the visible right edge of a real session dot, **28.5px inside the sidebar**. `targetRail` is the larger trailing hit target's right edge, 20px inside. The grey catalogue guide marks that target edge; it is 8.5px to the right of the visible dot rail and is not the sidebar border. Chips without neighboring marks end on the dot rail. A neighboring count/mark occupies one 24px column, so a chip ends one column left for each visible mark. Hover preserves the existing action and glyph centres.

The measurement visits every row with trailing content, including members and nested sessions: each frame records 24 rows. Every full chip must be inside all ancestor clipping boxes and within 0.5px of its available visible rail. Every row's rightmost badge/action target must remain on the shared target rail. At rest, all nine full chips have exactly 0px error in every width and theme.

Before the CSS repair, the strengthened browser test ran with production source at `5746bc61`: both theme cases failed, reporting an 8.5px chip offset at 200, 260, 320 and 540px. The same two cases pass after the repair. The native settling regression also failed before the repair (zero rendered readiness reads) and passes with opaque actions and two matching geometry reads.

| Width | Dot rail inset | No-count chip offset | Counted chip offset | Count shown |
| --- | --- | --- | --- | --- |
| 200px | 28.5px | 0px | 0px | No |
| 260px | 28.5px | 0px | -24px | Yes |
| 320px | 28.5px | 0px | -24px | Yes |
| 540px | 28.5px | 0px | -24px | Yes |

Reproduction (from the source branch, with its UI dev server listening on the origin passed to the capture):

```bash
pnpm --filter @harnessdesk/ui exec vite --host 127.0.0.1 --port 5719
node script/shots/sidebar-trailing.mjs --origin http://127.0.0.1:5719
TMPDIR=/tmp/hdv pnpm test:ui-system:native --scene session-rest --scene workspace-hover --scene session-hover
```

Validation: 95 focused sidebar unit tests; 13 native screenshot-driver tests; 38 sidebar UI-system specs; six native frames plus About and relaunch persistence; strict design audit; and the unpiped `TMPDIR=/tmp/hdv pnpm verify` gate. The full gate ended with `All checks passed.`

Individual visual inspection:

- `light-200-rest.png`: all full no-count chips end on the session dots' right-edge line; counts yield and the remaining full room chips reach that line; every pill has a whole right cap and a visible gap from the border.
- `light-200-hover-room.png`: the hovered Working chip folds to a dot; other full no-count chips end on the dots' right-edge line; counts yield and the remaining full room chips reach that line; every pill has a whole right cap and a visible gap from the border.
- `light-200-hover-member.png`: only the member actions appear; full no-count chips end on the dots' right-edge line; counts yield and the remaining full room chips reach that line; every pill has a whole right cap and a visible gap from the border.
- `light-200-hover-needs-you.png`: the hovered counted Needs you chip folds to a dot; other full no-count chips end on the dots' right-edge line; counts yield and the remaining full room chips reach that line; every pill has a whole right cap and a visible gap from the border.
- `light-260-rest.png`: all full no-count chips end on the session dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `light-260-hover-room.png`: the hovered Working chip folds to a dot; other full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `light-260-hover-member.png`: only the member actions appear; full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `light-260-hover-needs-you.png`: the hovered counted Needs you chip folds to a dot; other full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `light-320-rest.png`: all full no-count chips end on the session dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `light-320-hover-room.png`: the hovered Working chip folds to a dot; other full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `light-320-hover-member.png`: only the member actions appear; full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `light-320-hover-needs-you.png`: the hovered counted Needs you chip folds to a dot; other full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `light-540-rest.png`: all full no-count chips end on the session dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `light-540-hover-room.png`: the hovered Working chip folds to a dot; other full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `light-540-hover-member.png`: only the member actions appear; full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `light-540-hover-needs-you.png`: the hovered counted Needs you chip folds to a dot; other full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `dark-200-rest.png`: all full no-count chips end on the session dots' right-edge line; counts yield and the remaining full room chips reach that line; every pill has a whole right cap and a visible gap from the border.
- `dark-200-hover-room.png`: the hovered Working chip folds to a dot; other full no-count chips end on the dots' right-edge line; counts yield and the remaining full room chips reach that line; every pill has a whole right cap and a visible gap from the border.
- `dark-200-hover-member.png`: only the member actions appear; full no-count chips end on the dots' right-edge line; counts yield and the remaining full room chips reach that line; every pill has a whole right cap and a visible gap from the border.
- `dark-200-hover-needs-you.png`: the hovered counted Needs you chip folds to a dot; other full no-count chips end on the dots' right-edge line; counts yield and the remaining full room chips reach that line; every pill has a whole right cap and a visible gap from the border.
- `dark-260-rest.png`: all full no-count chips end on the session dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `dark-260-hover-room.png`: the hovered Working chip folds to a dot; other full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `dark-260-hover-member.png`: only the member actions appear; full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `dark-260-hover-needs-you.png`: the hovered counted Needs you chip folds to a dot; other full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `dark-320-rest.png`: all full no-count chips end on the session dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `dark-320-hover-room.png`: the hovered Working chip folds to a dot; other full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `dark-320-hover-member.png`: only the member actions appear; full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `dark-320-hover-needs-you.png`: the hovered counted Needs you chip folds to a dot; other full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `dark-540-rest.png`: all full no-count chips end on the session dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `dark-540-hover-room.png`: the hovered Working chip folds to a dot; other full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `dark-540-hover-member.png`: only the member actions appear; full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `dark-540-hover-needs-you.png`: the hovered counted Needs you chip folds to a dot; other full no-count chips end on the dots' right-edge line; counted chips end 24px left to clear their counts; every pill has a whole right cap and a visible gap from the border.
- `native-session-rest-light.png`: No full state chip in this scene; the session glyphs are inset on the shared trailing columns.
- `native-workspace-hover-light.png`: No full state chip in this scene; both project actions are opaque, and the pin sits two columns left of the rightmost action, aligned with the marked sessions below.
- `native-session-hover-light.png`: No full state chip in this scene; the session action is opaque, with worktree and missing-folder glyphs shifted into separate inset columns.
- `native-session-rest-dark.png`: No full state chip in this scene; the session glyphs are inset on the shared trailing columns.
- `native-workspace-hover-dark.png`: No full state chip in this scene; both project actions are opaque, and the pin sits two columns left of the rightmost action, aligned with the marked sessions below.
- `native-session-hover-dark.png`: No full state chip in this scene; the session action is opaque, with worktree and missing-folder glyphs shifted into separate inset columns.
