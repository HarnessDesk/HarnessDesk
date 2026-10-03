# ListRow and Team rail — owner decision 1A

Captured from the real ListRow catalogue (`design.html?view=list`) and the
real TeamRoomPane in the synthetic preview (`preview.html`, `goal-roster`).
The ListRow board already includes regular subjects and selected/unselected
small navigation rows; the preview already includes Alpha and Beta members.
No duplicate specimens or product style changes were needed.

Before removes only ListRow’s title `data-role` declaration; after restores
it. Both runs use the same integrated source, 1440×1000 viewport, reduced
motion and loaded bundled fonts. Each PNG was opened and inspected.
The catalogue uses the project’s permitted public demo persona; the rail
uses placeholder agents. No frame comes from a real desk.

`pixel-diff.json` records zero differing pixels in all six before/after
pairs. `measurements.json` records navigation/13px/400 for both rail names
in light/dark × Desk/Studio.

## Regression proof

Removing the title’s role declaration makes both focused unit regressions
fail (missing navigation metadata), and makes both new browser regressions
fail (the mutation is no longer matched and the rail role is null).
Restoring it passes the two focused UI files: 139 tests, and the names-rule
browser group: seven tests. No assertions or timeouts were relaxed.

```sh
pnpm --filter @harnessdesk/ui exec vitest run src/design/ui/list-row.test.tsx src/components/TeamRoomPane.test.tsx
pnpm exec playwright test -c playwright.ui-system.config.ts rules.spec.ts -g 'rule: names'
```

The before/after frames also demonstrate that rolling back the role
metadata does not change pixels. Reverse-applying the complete patch
against the integrated tree passes `git apply --reverse --check`.
