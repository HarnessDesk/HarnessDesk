import { inlineMarkdown } from '../../lib/markdown-inline'
import type { ReactNode } from 'react'
import { Button } from '../ui/button'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, TableFooter } from '../ui/table'
import { Text } from './Settings'
import styles from './LibraryMatrix.module.css'

export interface LibraryMatrixColumn { readonly id: string; readonly label: string; readonly mark?: ReactNode; readonly help?: string }
export interface LibraryMatrixCell { readonly id: string; readonly state: string; readonly mark: ReactNode; readonly label: string; readonly help?: string; readonly problem?: boolean; readonly run?: () => void }
export interface LibraryMatrixRow {
  readonly id: string; readonly name: string; readonly description?: string; readonly open: () => void
  readonly cells: readonly LibraryMatrixCell[]; readonly expanded?: ReactNode
}
export interface LibraryMatrixFooter { readonly label: string; readonly title: string; readonly values: Readonly<Record<string, number>> }
/** Availability geometry belongs to this data block; Page owns the outer measure. Descriptions use sanitized inline markdown. */
export const LibraryMatrix = ({ columns, rows, caption, footer, fired }: {
  readonly columns: readonly LibraryMatrixColumn[]; readonly rows: readonly LibraryMatrixRow[]; readonly caption?: string
  readonly footer?: LibraryMatrixFooter; readonly fired?: LibraryMatrixFooter
}) => <div data-slot="library-matrix" className={styles.scroll}>
  <Table aria-label="Library availability" variant="framed" className={styles.table}>
    {caption && <TableCaption variant="sr-only">{caption}</TableCaption>}
    <TableHeader><TableRow variant="matrix"><TableHead variant="matrix" className={styles.name} scope="col">Name</TableHead>
      {columns.map(column => <TableHead variant="matrix" align="center" key={column.id} scope="col" title={column.help}>
        <span className={styles.heading}>{column.mark}<Text role="muted" truncate title={column.label}>{column.label}</Text></span>
      </TableHead>)}
    </TableRow></TableHeader>
    <TableBody>{rows.flatMap(row => [
      <TableRow key={row.id} variant="matrix" interactive data-state={row.expanded ? 'selected' : undefined}>
        <TableHead variant="row" scope="row" className={styles.name}><Button variant="row" size="content-min" bordered={false} onClick={row.open} aria-expanded={Boolean(row.expanded)} className={styles.disclosure}>
          <Text role="row" truncate title={row.name}>{row.name}</Text>
          {row.description && <Text role="meta" title={row.description}><span dangerouslySetInnerHTML={{ __html: inlineMarkdown(row.description) }} /></Text>}
        </Button></TableHead>
        {row.cells.map(cell => <TableCell variant="matrix" key={cell.id} data-state={cell.state} data-library-state={cell.state} data-problem={cell.problem ? '' : undefined} title={cell.help ?? cell.label}>
          {cell.run ? <Button variant="quiet" size="content" aria-label={cell.label} title={cell.label} onClick={cell.run}>{cell.mark}</Button>
            : <span title={cell.label}>{cell.mark}</span>}
        </TableCell>)}
      </TableRow>,
      ...(row.expanded ? [<TableRow variant="matrix" key={`${row.id}:expanded`}><TableCell variant="detail" colSpan={columns.length + 1}><div className={styles.detail}>{row.expanded}</div></TableCell></TableRow>] : []),
    ])}</TableBody>
    {footer && <TableFooter variant="plain"><TableRow variant="matrix">
      <TableHead variant="footer" scope="row" title={footer.title}>{footer.label}</TableHead>
      {columns.map(column => <TableCell key={column.id} variant="footer">{footer.values[column.id]! > 0 ? `≈${footer.values[column.id]!.toLocaleString()} tok` : '—'}</TableCell>)}
    </TableRow>{fired && <TableRow variant="matrix"><TableHead variant="footer" scope="row" title={fired.title}>{fired.label}</TableHead>
      {columns.map(column => <TableCell key={column.id} variant="footer">{fired.values[column.id]! > 0 ? `${fired.values[column.id]} of ${rows.length}` : '—'}</TableCell>)}
    </TableRow>}</TableFooter>}
  </Table>
</div>
