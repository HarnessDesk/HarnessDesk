import { GRAPH_COLORS, type GraphRow, type LaneWindow } from '../lib/git-graph'

/**
 * One row's slice of the graph, drawn through the lane window.
 *
 * A lane the window left out is not drawn at all — not clipped, not stubbed.
 * Half a line is worse than no line: it reads as a branch that stops, which
 * is a thing the history could actually mean. A commit whose own lane was
 * left out still gets a mark, a hollow ring in the last column, so the row
 * says "a commit is here, on a branch this width cannot show".
 */
export const GitGraph = ({ row, lanes, rowHeight: ROW, laneWidth: LANE_W, className, offGraphClassName }: {
  row: GraphRow
  lanes: LaneWindow
  rowHeight: number
  laneWidth: number
  className?: string
  offGraphClassName?: string
}) => {
  const x = (lane: number): number | null => {
    const column = lanes.columnOf.get(lane)
    return column === undefined ? null : column * LANE_W + LANE_W / 2
  }
  const mid = ROW / 2
  const dot = x(row.lane)
  return (
    <svg className={className} width={Math.max(lanes.columns, 1) * LANE_W} height={ROW} aria-hidden="true">
      {row.segments.map((segment, index) => {
        const from = x(segment.from)
        const to = x(segment.to)
        if (from === null || to === null) return null
        const color = `var(--lane-${segment.color % GRAPH_COLORS})`
        if (segment.kind === 'pass') {
          return <line key={index} x1={from} y1={0} x2={to} y2={ROW} stroke={color} />
        }
        if (segment.kind === 'in') {
          return from === to ? (
            <line key={index} x1={from} y1={0} x2={to} y2={mid} stroke={color} />
          ) : (
            <path key={index} d={`M ${from} 0 C ${from} ${mid} ${to} 2 ${to} ${mid}`} stroke={color} fill="none" />
          )
        }
        return from === to ? (
          <line key={index} x1={from} y1={mid} x2={to} y2={ROW} stroke={color} />
        ) : (
          <path
            key={index}
            d={`M ${from} ${mid} C ${from} ${ROW - 2} ${to} ${mid} ${to} ${ROW}`}
            stroke={color}
            fill="none"
          />
        )
      })}
      {dot === null ? (
        <circle
          className={offGraphClassName}
          cx={Math.max(lanes.columns - 1, 0) * LANE_W + LANE_W / 2}
          cy={mid}
          r={3}
          fill="none"
        />
      ) : (
        <circle cx={dot} cy={mid} r={3.5} fill={`var(--lane-${row.color % GRAPH_COLORS})`} />
      )}
    </svg>
  )
}
