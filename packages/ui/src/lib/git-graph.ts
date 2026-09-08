/**
 * Lane layout for the commit graph — pure data over the loaded log, so the
 * drawing is a dumb SVG per row and the topology is testable without one.
 *
 * The algorithm is the classic sparse-lane walk every git client draws with.
 * Newest first, each active lane expects the sha it is waiting to meet:
 *
 * - A commit lands on the leftmost lane expecting it; every other lane
 *   expecting it curves into the same dot and is freed.
 * - A commit nobody expects is a branch tip and opens the first free lane.
 * - Its first parent keeps the commit's lane; each further parent either
 *   curves to a lane already expecting that parent, or opens a new one.
 *
 * Lanes are sparse — freed columns keep their position and are reused later —
 * because shifting every column left on each merge turns history into
 * diagonal spaghetti. Colour follows the lane from the moment it opens, so a
 * branch keeps its colour for its whole visible life.
 */

export interface GraphInput {
  readonly sha: string
  readonly parents: readonly string[]
}

export interface GraphSegment {
  /**
   * `pass` runs top to bottom beside the dot; `in` runs from the top edge at
   * `from` into the dot at `to`; `out` runs from the dot at `from` to the
   * bottom edge at `to`.
   */
  readonly kind: 'pass' | 'in' | 'out'
  readonly from: number
  readonly to: number
  readonly color: number
}

export interface GraphRow {
  readonly sha: string
  readonly lane: number
  readonly color: number
  readonly segments: readonly GraphSegment[]
  /** Lanes in play around this row, for sizing the gutter. */
  readonly width: number
}

/** How many colours the drawing cycles through; the CSS palette matches it. */
export const GRAPH_COLORS = 8

interface Lane {
  expects: string
  color: number
}

export const layoutGraph = (commits: readonly GraphInput[]): GraphRow[] => {
  const lanes: (Lane | null)[] = []
  let opened = 0

  /**
   * Indices this row opened. A column index is not enough to tell "was this
   * lane running above?": a lane freed by an arriving merge is reused by the
   * next parent *in the same row*, at the same index and a lower one than
   * the row started with. Only the identity of what opened here answers it.
   */
  let born = new Set<number>()

  const open = (expects: string): number => {
    const color = opened % GRAPH_COLORS
    opened += 1
    const free = lanes.findIndex((lane) => lane === null)
    const at = free === -1 ? lanes.length : free
    lanes[at] = { expects, color }
    born.add(at)
    return at
  }

  return commits.map((commit) => {
    const segments: GraphSegment[] = []
    born = new Set<number>()

    const incoming = lanes.flatMap((lane, index) => (lane !== null && lane.expects === commit.sha ? [index] : []))
    const fresh = incoming.length === 0
    const at = fresh ? open(commit.sha) : incoming[0]!
    const color = lanes[at]!.color
    const widthBefore = lanes.length

    // Everything that was waiting for this commit arrives at the dot; the
    // leftmost lane is the one the commit keeps, drawn straight only when
    // the lane really was open above this row.
    if (!fresh) {
      for (const index of incoming) {
        segments.push({ kind: 'in', from: index, to: at, color: lanes[index]!.color })
        if (index !== at) lanes[index] = null
      }
    }

    // The first parent continues the commit's lane; the rest either join a
    // lane already expecting them or open one of their own.
    const [first, ...rest] = commit.parents
    if (first === undefined) {
      lanes[at] = null
    } else {
      lanes[at] = { expects: first, color }
      segments.push({ kind: 'out', from: at, to: at, color })
    }
    for (const parent of rest) {
      const joins = lanes.findIndex((lane) => lane !== null && lane.expects === parent)
      const to = joins === -1 ? open(parent) : joins
      segments.push({ kind: 'out', from: at, to, color: lanes[to]!.color })
    }

    // Every lane still open runs straight through this row — except one this
    // row opened, which starts at the dot and has nothing above it.
    //
    // A merge edge arriving in a lane is *not* a reason to skip its line. An
    // `out` covers only the half below the dot, so suppressing the pass left
    // the lane's own line dead-ending at the row's top edge: the visible
    // break where a side branch merges into a line that keeps going.
    //
    // "Opened here" is asked of `born`, not of the index. A row can free a
    // lane and reuse that very index for one of its own parents, and the
    // index alone then claims a lane was running above when it starts here.
    for (const [index, lane] of lanes.entries()) {
      if (lane === null || index === at) continue
      if (!born.has(index)) segments.push({ kind: 'pass', from: index, to: index, color: lane.color })
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()

    return {
      sha: commit.sha,
      lane: at,
      color,
      segments,
      width: Math.max(widthBefore, lanes.length, at + 1),
    }
  })
}

/**
 * Which lanes a graph column narrower than the history can show.
 *
 * Clipping the column at some pixel is the obvious answer and the wrong one:
 * it cuts lanes in half, so lines end in mid-air — the exact thing the walk
 * above works to avoid. Squeezing every lane into less space is worse, because
 * the spacing is what makes a lane followable at all.
 *
 * So whole lanes are dropped instead, and the ones kept are the ones **most
 * recently in play** — ranked by the newest row that touches them. Narrowing
 * the column is then a statement about how much history you want to see the
 * shape of: at eight lanes, everything; at three, the branches in flight right
 * now; at zero, no graph at all, which is a legitimate way to read a log.
 *
 * The choice is made once for the whole loaded page rather than per row, so a
 * lane keeps its column while you scroll instead of sliding about. A commit
 * whose lane did not make the cut is drawn as a hollow ring in the last
 * column: the row still says "a commit is here", and says it is on a branch
 * this width cannot show.
 */
export interface LaneWindow {
  /** Lane index → the column it draws in. Lanes left out are absent. */
  readonly columnOf: ReadonlyMap<number, number>
  /** How many lanes did not fit. Zero when the graph is whole. */
  readonly hidden: number
  /** Columns in use — what the gutter must be wide enough for. */
  readonly columns: number
}

const lanesOf = (row: GraphRow): number[] => [
  row.lane,
  ...row.segments.flatMap((segment) => [segment.from, segment.to]),
]

export const laneWindow = (rows: readonly GraphRow[], capacity: number): LaneWindow => {
  // The newest row each lane appears in; lanes are ranked by it.
  const newest = new Map<number, number>()
  for (const [index, row] of rows.entries()) {
    for (const lane of lanesOf(row)) {
      if (!newest.has(lane)) newest.set(lane, index)
    }
  }
  const total = newest.size
  if (total === 0) return { columnOf: new Map(), hidden: 0, columns: 0 }
  if (capacity <= 0) return { columnOf: new Map(), hidden: total, columns: 0 }
  if (capacity >= total) {
    // Every lane is drawn where the walk put it — no compaction, because the
    // gaps a freed lane leaves are part of how the shape reads.
    const whole = new Map<number, number>()
    for (const lane of newest.keys()) whole.set(lane, lane)
    return { columnOf: whole, hidden: 0, columns: Math.max(...newest.keys()) + 1 }
  }

  const kept = [...newest.entries()]
    .sort(([laneA, rowA], [laneB, rowB]) => rowA - rowB || laneA - laneB)
    .slice(0, capacity)
    .map(([lane]) => lane)
    .sort((a, b) => a - b)

  const columnOf = new Map<number, number>()
  for (const [column, lane] of kept.entries()) columnOf.set(lane, column)
  return { columnOf, hidden: total - kept.length, columns: kept.length }
}
