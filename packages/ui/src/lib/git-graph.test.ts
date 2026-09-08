import { describe, expect, test } from 'vitest'

import { laneWindow, layoutGraph, type GraphRow } from './git-graph'

/**
 * The lane walk on synthetic DAGs. The properties, not the pixels: a chain
 * stays in one lane, a branch opens a second, a merge closes it back into
 * the dot, a freed lane is reused with a fresh colour, and a parent beyond
 * the loaded page keeps its line running off the bottom edge.
 */

const chain = (...shas: string[]) =>
  shas.map((sha, index) => ({ sha, parents: index + 1 < shas.length ? [shas[index + 1]!] : [] }))

const kinds = (row: GraphRow, kind: 'pass' | 'in' | 'out') =>
  row.segments.filter((segment) => segment.kind === kind)

/**
 * Lines must join up across the seam between two rows, in both directions:
 * a lane handed to the row below has to be picked up there, and a line
 * arriving at a row's top edge has to have been sent down by the row above.
 * Neither is visible to a test that looks at one row at a time — the first
 * shows as a branch that stops for no reason, the second as a branch that
 * starts from nothing.
 */
const dangling = (rows: readonly GraphRow[]): string[] => {
  const breaks: string[] = []
  for (let index = 0; index < rows.length - 1; index += 1) {
    const row = rows[index]!
    const next = rows[index + 1]!
    const goesDown = new Set(row.segments.filter((s) => s.kind !== 'in').map((s) => s.to))
    const comesUp = new Set(next.segments.filter((s) => s.kind !== 'out').map((s) => s.from))
    for (const lane of goesDown) {
      // The next row's own dot absorbs whatever arrives in its lane.
      if (lane !== next.lane && !comesUp.has(lane)) breaks.push(`row ${index} → ${index + 1}: lane ${lane} ends`)
    }
    for (const lane of comesUp) {
      // A line may leave this row's own dot; anything else came from above.
      if (lane !== row.lane && !goesDown.has(lane)) {
        breaks.push(`row ${index} → ${index + 1}: lane ${lane} starts from nothing`)
      }
    }
  }
  return breaks
}

describe('layoutGraph', () => {
  test('a linear chain is one straight lane', () => {
    const rows = layoutGraph(chain('c3', 'c2', 'c1'))
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0])
    expect(rows.map((row) => row.width)).toEqual([1, 1, 1])
    expect(rows.map((row) => row.color)).toEqual([0, 0, 0])
    // The tip has no line above it, the root none below.
    expect(kinds(rows[0]!, 'in')).toHaveLength(0)
    expect(kinds(rows[0]!, 'out')).toEqual([{ kind: 'out', from: 0, to: 0, color: 0 }])
    expect(kinds(rows[2]!, 'in')).toEqual([{ kind: 'in', from: 0, to: 0, color: 0 }])
    expect(kinds(rows[2]!, 'out')).toHaveLength(0)
  })

  test('a merge opens a lane out and closes it at the fork point', () => {
    const rows = layoutGraph([
      { sha: 'M', parents: ['A', 'B'] },
      { sha: 'B', parents: ['A'] },
      { sha: 'A', parents: ['R'] },
      { sha: 'R', parents: [] },
    ])
    const [m, b, a, r] = rows as [GraphRow, GraphRow, GraphRow, GraphRow]

    // The merge sits on lane 0 and sends its second parent out to lane 1.
    expect(m.lane).toBe(0)
    expect(kinds(m, 'out')).toEqual([
      { kind: 'out', from: 0, to: 0, color: 0 },
      { kind: 'out', from: 0, to: 1, color: 1 },
    ])

    // The branch commit lives on lane 1, in its own colour, while lane 0 passes.
    expect(b.lane).toBe(1)
    expect(b.color).toBe(1)
    expect(kinds(b, 'pass')).toEqual([{ kind: 'pass', from: 0, to: 0, color: 0 }])

    // Both lines arrive at the fork point, and lane 1 closes there.
    expect(a.lane).toBe(0)
    expect(kinds(a, 'in')).toEqual([
      { kind: 'in', from: 0, to: 0, color: 0 },
      { kind: 'in', from: 1, to: 0, color: 1 },
    ])
    expect(a.width).toBe(2)
    expect(r.width).toBe(1)
  })

  test('a second parent joins a lane that already expects it', () => {
    const rows = layoutGraph([
      { sha: 'M', parents: ['A', 'P'] },
      { sha: 'N', parents: ['B', 'P'] },
      { sha: 'A', parents: ['P'] },
      { sha: 'B', parents: ['P'] },
      { sha: 'P', parents: [] },
    ])
    const n = rows[1]!
    // N's second parent P is already awaited on M's merge lane — no third
    // lane opens for it.
    const out = kinds(n, 'out')
    expect(out.some((segment) => segment.to === 1)).toBe(true)
    expect(Math.max(...rows.map((row) => row.width))).toBeLessThanOrEqual(3)
  })

  test('two roots run in parallel lanes', () => {
    const rows = layoutGraph([
      { sha: 'x2', parents: ['x1'] },
      { sha: 'y2', parents: ['y1'] },
      { sha: 'x1', parents: [] },
      { sha: 'y1', parents: [] },
    ])
    expect(rows.map((row) => row.lane)).toEqual([0, 1, 0, 1])
    expect(rows[1]!.color).not.toBe(rows[0]!.color)
  })

  test('a freed lane is reused, with a colour of its own', () => {
    const rows = layoutGraph([
      { sha: 'M', parents: ['A', 'B'] },
      { sha: 'B', parents: ['A'] },
      { sha: 'A', parents: ['R'] },
      { sha: 'T', parents: ['R'] },
      { sha: 'R', parents: [] },
    ])
    const t = rows[3]!
    expect(t.lane).toBe(1)
    expect(t.color).not.toBe(rows[1]!.color)
  })

  test('a parent beyond the page keeps its line running off the edge', () => {
    const rows = layoutGraph([
      { sha: 'c2', parents: ['c1'] },
      { sha: 'c1', parents: ['beyond-the-page'] },
    ])
    const last = rows[1]!
    expect(kinds(last, 'out')).toEqual([{ kind: 'out', from: 0, to: 0, color: 0 }])
  })

  test('appending the next page does not disturb the rows already laid out', () => {
    const commits = [
      { sha: 'M', parents: ['A', 'B'] },
      { sha: 'B', parents: ['A'] },
      { sha: 'A', parents: ['R'] },
      { sha: 'R', parents: [] },
    ]
    const firstPage = layoutGraph(commits.slice(0, 2))
    const both = layoutGraph(commits)
    expect(both.slice(0, 2)).toEqual(firstPage)
  })
  test('a merge into a lane that keeps going does not break that lane’s line', () => {
    // `side` merges back into `main`, whose own line continues past the merge
    // row. The `out` edge covers only the half below the dot, so the lane
    // still needs its own pass — this is the break the real history showed.
    const rows = layoutGraph([
      { sha: 'tip', parents: ['side'] },
      { sha: 'side', parents: ['s1', 'm1'] },
      { sha: 's1', parents: ['m1'] },
      { sha: 'm1', parents: ['m0'] },
      { sha: 'm0', parents: [] },
    ])
    expect(dangling(rows)).toEqual([])
  })

  test('a lane freed and reused within one row starts at that row, not above it', () => {
    // `A` takes C's merge into lane 1, freeing it, and then opens lane 1
    // again for its own second parent `X`. The index is unchanged and lower
    // than the row started with, so index arithmetic alone says lane 1 was
    // running above — and the graph grows an X line over a commit that
    // predates it.
    const rows = layoutGraph([
      { sha: 'H', parents: ['B', 'C'] },
      { sha: 'B', parents: ['A'] },
      { sha: 'C', parents: ['A'] },
      { sha: 'A', parents: ['P', 'X'] },
      { sha: 'X', parents: ['P'] },
      { sha: 'P', parents: [] },
    ])
    const a = rows.find((row) => row.sha === 'A')!
    expect(a.segments).toContainEqual({ kind: 'out', from: 0, to: 1, color: 2 })
    expect(kinds(a, 'pass')).toEqual([])
    expect(dangling(rows)).toEqual([])
  })

  test('no line runs to the bottom edge and meets nothing, however tangled', () => {
    // A knot with several long-running lanes, repeated merges back into them,
    // and lanes freed and reused — the shapes that produced dead ends.
    const rows = layoutGraph([
      { sha: 'h', parents: ['g', 'f'] },
      { sha: 'g', parents: ['e', 'd'] },
      { sha: 'f', parents: ['c'] },
      { sha: 'e', parents: ['c', 'b'] },
      { sha: 'd', parents: ['b'] },
      { sha: 'c', parents: ['a'] },
      { sha: 'b', parents: ['a'] },
      { sha: 'a', parents: ['root'] },
      { sha: 'root', parents: [] },
    ])
    expect(dangling(rows)).toEqual([])

    // And a second head joining the same history later on.
    const two = layoutGraph([
      { sha: 'x2', parents: ['x1'] },
      { sha: 'y2', parents: ['y1'] },
      { sha: 'x1', parents: ['shared'] },
      { sha: 'y1', parents: ['shared', 'x1'] },
      { sha: 'shared', parents: [] },
    ])
    expect(dangling(two)).toEqual([])
  })
})

describe('laneWindow', () => {
  const rows = layoutGraph([
    { sha: 'h', parents: ['g', 'f'] },
    { sha: 'g', parents: ['e', 'd'] },
    { sha: 'f', parents: ['c'] },
    { sha: 'e', parents: ['c', 'b'] },
    { sha: 'd', parents: ['b'] },
    { sha: 'c', parents: ['a'] },
    { sha: 'b', parents: ['a'] },
    { sha: 'a', parents: [] },
  ])
  const lanes = new Set(rows.flatMap((row) => [row.lane, ...row.segments.flatMap((s) => [s.from, s.to])]))

  test('a column with room for everything draws every lane where the walk put it', () => {
    const window = laneWindow(rows, 10)
    expect(window.hidden).toBe(0)
    for (const lane of lanes) expect(window.columnOf.get(lane)).toBe(lane)
  })

  test('a narrow column keeps the lanes most recently in play, in their own order', () => {
    const window = laneWindow(rows, 2)
    expect(window.columns).toBe(2)
    expect(window.hidden).toBe(lanes.size - 2)
    // Lane 0 and lane 1 are the two the newest rows touch.
    expect([...window.columnOf.keys()].sort()).toEqual([0, 1])
    // Kept lanes are compacted left, keeping their left-to-right order.
    expect([...window.columnOf.values()]).toEqual([0, 1])
  })

  test('a column dragged shut drops the graph rather than drawing half of it', () => {
    const window = laneWindow(rows, 0)
    expect(window.columns).toBe(0)
    expect(window.columnOf.size).toBe(0)
    expect(window.hidden).toBe(lanes.size)
  })

  test('the choice is the same for every row, so a lane keeps its column', () => {
    // Ranking reads the whole page once; scrolling must not re-rank.
    const all = laneWindow(rows, 3)
    const again = laneWindow(rows, 3)
    expect([...again.columnOf.entries()]).toEqual([...all.columnOf.entries()])
  })

  test('an empty history has no lanes and nothing hidden', () => {
    expect(laneWindow([], 4)).toEqual({ columnOf: new Map(), hidden: 0, columns: 0 })
  })
})
