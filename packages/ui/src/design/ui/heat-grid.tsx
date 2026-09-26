import { useState, type KeyboardEvent, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { ChartTip } from './chart'
import styles from './heat-grid.module.css'

/**
 * A calendar heatmap: rows and columns of level-0..4 cells, one tab stop,
 * arrow keys walking a cursor over the two axes.
 *
 * Generic on purpose. "When it ran" draws two shapes with it — a year as 53
 * weeks (columns) of 7 weekdays (rows), and 13 weeks of one row per agent —
 * and the two disagree about which axis is which. The primitive does not
 * need to know: `ArrowRight`/`ArrowLeft` always move a column, `ArrowUp`/
 * `ArrowDown` always move a row, and the caller decides what a row and a
 * column mean by how it lays the cells out.
 *
 * Colour is a level, not a value — the caller has already reduced whatever
 * it is measuring (tokens, cost) to `0..4` via `lib/heat.ts`'s quartile
 * breakpoints, the same split `DayColumns` keeps between arithmetic and
 * drawing.
 *
 * One CSS grid, not a nested pair — a row's header and its cells have to
 * share a row height, and that height comes from the cells' own
 * `aspect-ratio` once the grid is fluid. Two independent grids agree on
 * nothing once the column width changes; explicit `grid-column` /
 * `grid-row` placement on one grid keeps a row's header level with its day.
 */

export interface HeatGridCell {
  readonly key: string
  readonly level: 0 | 1 | 2 | 3 | 4
  readonly state: 'empty' | 'filled' | 'not-scanned'
  readonly today?: boolean
  readonly ariaLabel: string
  readonly tooltip?: ReactNode
}

export interface HeatGridRow {
  readonly key: string
  /** Drawn to the row's left — a weekday name, or an agent's mark and total. */
  readonly header?: ReactNode
  readonly cells: readonly (HeatGridCell | null)[]
}

export interface HeatGridColumnLabel {
  readonly index: number
  readonly label: string
}

interface Cursor {
  readonly row: number
  readonly col: number
}

const cellAt = (rows: readonly HeatGridRow[], at: Cursor | null): HeatGridCell | null => {
  if (!at) return null
  return rows[at.row]?.cells[at.col] ?? null
}

export const HeatGrid = ({
  className,
  label,
  rows,
  columns,
  columnLabels,
  minCellPx = 9,
}: {
  className?: string
  /** The grid's own accessible name — what it is a calendar of. */
  label: string
  rows: readonly HeatGridRow[]
  columns: number
  /** Month names, or nothing when the caller has no header row to draw. */
  columnLabels?: readonly HeatGridColumnLabel[]
  /** The narrowest a cell is allowed to get before the row scrolls. */
  minCellPx?: number
}) => {
  const [active, setActive] = useState<Cursor | null>(null)
  const shown = cellAt(rows, active)
  const hasHeaders = rows.some((row) => row.header !== undefined)
  const headerCol = hasHeaders ? 1 : 0
  const labelRow = columnLabels ? 1 : 0

  const clamp = (at: Cursor): Cursor => ({
    row: Math.min(rows.length - 1, Math.max(0, at.row)),
    col: Math.min(columns - 1, Math.max(0, at.col)),
  })

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (rows.length === 0 || columns === 0) return
    const move = (step: (from: Cursor | null) => Cursor): void => {
      event.preventDefault()
      // Read out of the setter, not the render's closure: held arrow keys
      // outpace React's renders, and a stale closure turns "walk the grid"
      // into "jump back to the first cell, over and over" — the same bug
      // `DayColumns` guards against.
      setActive((from) => clamp(step(from)))
    }
    if (event.key === 'ArrowRight') move((from) => (from === null ? { row: 0, col: 0 } : { row: from.row, col: from.col + 1 }))
    else if (event.key === 'ArrowLeft') move((from) => (from === null ? { row: 0, col: 0 } : { row: from.row, col: from.col - 1 }))
    else if (event.key === 'ArrowDown') move((from) => (from === null ? { row: 0, col: 0 } : { row: from.row + 1, col: from.col }))
    else if (event.key === 'ArrowUp') move((from) => (from === null ? { row: 0, col: 0 } : { row: from.row - 1, col: from.col }))
    else if (event.key === 'Escape' && active !== null) {
      // Only when a cursor is active: a chart's Escape once closed the whole
      // window because it swallowed the key even with nothing to put away.
      event.preventDefault()
      event.stopPropagation()
      setActive(null)
    }
  }

  const at = columns > 1 && active !== null ? (active.col + 0.5) / columns : 0.5

  return (
    <div className={cn('relative', className)}>
      {shown?.tooltip && (
        <ChartTip at={at} className="bottom-auto top-0 -translate-y-full">
          {shown.tooltip}
        </ChartTip>
      )}

      <div className={styles.scroller}>
        <div
          role="group"
          aria-label={label}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          className={styles.grid}
          style={{
            gridTemplateColumns: `${hasHeaders ? 'auto ' : ''}repeat(${columns}, minmax(${minCellPx}px, 1fr))`,
            gridTemplateRows: `${columnLabels ? 'auto ' : ''}repeat(${rows.length}, 1fr)`,
          }}
        >
          {rows.map((row, rowIndex) => (
            <>
              {row.header !== undefined && (
                <div
                  key={`${row.key}:header`}
                  className={styles.header}
                  style={{ gridColumn: 1, gridRow: rowIndex + 1 + labelRow }}
                >
                  {row.header}
                </div>
              )}
              {Array.from({ length: columns }, (_, colIndex) => {
                const cell = row.cells[colIndex]
                const isActive = active?.row === rowIndex && active.col === colIndex
                const place = { gridColumn: colIndex + 1 + headerCol, gridRow: rowIndex + 1 + labelRow }
                if (!cell) return <div key={`${row.key}:${colIndex}`} aria-hidden style={place} />
                return (
                  <div
                    key={`${row.key}:${colIndex}`}
                    aria-hidden
                    data-level={cell.state === 'not-scanned' ? undefined : cell.level}
                    data-state={cell.state === 'not-scanned' ? 'not-scanned' : undefined}
                    {...(cell.today ? { 'data-today': '' } : {})}
                    {...(isActive ? { 'data-active': '' } : {})}
                    onPointerEnter={() => setActive({ row: rowIndex, col: colIndex })}
                    className={styles.cell}
                    style={place}
                  />
                )
              })}
            </>
          ))}

          {columnLabels && (
            <>
              {columnLabels.map((entry) => (
                <span
                  key={entry.index}
                  aria-hidden
                  className={styles.monthLabel}
                  style={{ gridColumn: entry.index + 1 + headerCol, gridRow: 1 }}
                >
                  {entry.label}
                </span>
              ))}
            </>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <>
          <span aria-live="polite" className="sr-only">
            {shown?.ariaLabel ?? ''}
          </span>
          <ul className="sr-only">
            {rows.flatMap((row) =>
              row.cells
                .filter((cell): cell is HeatGridCell => cell !== null)
                .map((cell) => <li key={cell.key}>{cell.ariaLabel}</li>),
            )}
          </ul>
        </>
      )}
    </div>
  )
}
