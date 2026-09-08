import { expect, it } from 'vitest'

import { summonable, views } from '../panels/views'
import '../panels/builtins'

/**
 * The inspectors, and the way in.
 *
 * This used to mount `Details` and count the tabs in its own header, because
 * the panel *was* the four views: a component that drew a strip, chose one of
 * four bodies, and could only ever appear in the right-hand column. The claim
 * it pinned is the one that still matters — **a view that nothing offers is a
 * view nobody can open** — but the tab row is the panel system's now, and the
 * four are ordinary views it mounts.
 *
 * It then pinned that claim against `DETAIL_VIEWS`, a table in `Details.tsx`
 * that named them a second time. That table is gone, and this is why: both the
 * things it was written to keep honest — the conversation header and the
 * command palette — had quietly moved to `summonable()`, so the test was
 * comparing the registry against a list nothing drew any more. It passed, and
 * it was checking nothing a person could see. The claim is asked of the
 * registry itself now, which is what both surfaces actually read.
 */

const INSPECTORS = ['changes', 'trajectory', 'agents', 'activity', 'tasks'] as const

it('every inspector is a view the panel system mounts on the right', () => {
  for (const kind of INSPECTORS) {
    const definition = views.get(kind)
    expect(definition, `${kind} is an inspector but not registered`).toBeDefined()
    // The right panel is where an inspector goes when nothing says otherwise,
    // and where every entry that opens one sends it.
    expect(definition?.mounts).toContain('right')
    expect(definition?.defaultMount).toBe('right')
  }
})

it('and every panel the app ships has a way in', () => {
  const panels = views
    .all()
    .filter((definition) => definition.mounts.includes('sidebar') || definition.mounts.includes('right'))
    .filter((definition) => !definition.bare)
    // `plugin` is a family, not a view: one definition standing in for every
    // panel a plugin contributes. Those get their own entry in the command
    // palette, built from the contribution, so they are reachable — this row
    // is about the ones the app itself ships.
    .filter((definition) => definition.kind !== 'plugin')
  const offered = new Set(summonable().map((definition) => definition.kind))
  for (const definition of panels) {
    expect(offered.has(definition.kind), `${definition.kind} is a panel nothing offers`).toBe(true)
  }
  // And the set is exactly the inspectors, so a sixth added without a door
  // fails here rather than being merely unreachable.
  expect(panels.map((definition) => definition.kind).sort()).toEqual([...INSPECTORS].sort())
})
