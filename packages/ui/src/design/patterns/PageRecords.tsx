import { Fragment, type ReactNode, type MouseEvent } from 'react'
import { Button } from '../ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'
import { ListRow, ListRows } from '../ui/list-row'
import { Text } from './Settings'
import { GroupLabel } from '../ui/group-label'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'
import { useNarrowLayout } from '../../lib/use-narrow-layout'
import styles from './PageRecords.module.css'

export interface RecordColumn { readonly id: string; readonly label: string; readonly numeric?: boolean }
export interface PageRecord {
  readonly id: string; readonly title: string; readonly description?: string
  readonly lead?: ReactNode; readonly mark?: ReactNode; readonly state?: ReactNode
  readonly values: Readonly<Record<string, ReactNode>>; readonly compact?: ReactNode
  readonly actions?: ReactNode; readonly open: () => void
}
export interface RecordGroup { readonly id: string; readonly label: string; readonly rows: readonly PageRecord[] }

/** A record page's views belong in its first body row, using the shared tab switcher. */
export const PageRecordViews = <T extends string,>({label,value,choices,change}: {
  readonly label: string; readonly value: T; readonly choices: readonly { readonly value: T; readonly label: string; readonly count: number }[]
  readonly change: (value: T) => void
}) => <Tabs value={value} onValueChange={next=>change(next as T)}>
  <TabsList aria-label={label}>{choices.map(choice=><TabsTrigger key={choice.value} value={choice.value} count={choice.count}>{choice.label}</TabsTrigger>)}</TabsList>
</Tabs>

/** Records share a table above 600px of content, and whole earned sentences in list rows below it.
 * Row actions and portalled menus never activate the record; the title is its keyboard button.
 */
export const PageRecords = ({ label, columns, groups, showGroupLabels = true }: {
  readonly label: string; readonly columns: readonly RecordColumn[]; readonly groups: readonly RecordGroup[]; readonly showGroupLabels?: boolean
}) => {
  const { ref, narrow } = useNarrowLayout<HTMLDivElement>(600)
  const rowPressed = (event: MouseEvent<HTMLElement>, row: PageRecord): void => {
    if (!event.currentTarget.contains(event.target as Node)) return
    if ((event.target as Element).closest('button, a, input, select, textarea, [role=menuitem], [role=menuitemradio], [role=switch]')) return
    row.open()
  }
  const title = (row: PageRecord) => <Button stretched hoverFill={false} variant="row" size="content-min" bordered={false}
    aria-label={`Open ${row.title}`} onClick={row.open} className={styles.title}>
    <Text as="span" role="subject" truncate title={row.title}>{row.title}</Text>
  </Button>
  const trailing = (row: PageRecord) => <span className={styles.trailing}>{row.state}{row.actions}</span>
  return <div ref={ref} data-slot="page-records" data-layout={narrow === null ? 'unmeasured' : narrow ? 'narrow' : 'table'} className={styles.records}>
    {narrow === true ? groups.map(group => <section key={group.id} aria-label={group.label} data-team-project={group.id} className={styles.group}>
      {showGroupLabels && <GroupLabel>{group.label}</GroupLabel>}
      <ListRows>{group.rows.map(row => <ListRow key={row.id} data-team-row={row.id} interactive
        onClick={event => rowPressed(event, row)} lead={row.lead} mark={row.mark ?? false} title={title(row)}
        subtitle={<span data-slot="team-detail">{row.compact}</span>} wrapSubtitle trail={trailing(row)} />)}</ListRows>
    </section>) : narrow === false && <Table aria-label={label} variant="framed" className="table-auto">
      <TableHeader><TableRow><TableHead>{label}</TableHead><TableHead className={styles.fact}>State</TableHead>
        {columns.map(column => <TableHead key={column.id} numeric={column.numeric} className={styles.fact}>{column.label}</TableHead>)}
        <TableHead className={styles.fact}><span className="sr-only">Actions</span></TableHead>
      </TableRow></TableHeader>
      <TableBody>{groups.map(group => <Fragment key={group.id}>
        {showGroupLabels && <TableRow data-team-project={group.id}>
          <TableCell colSpan={columns.length + 3}><GroupLabel>{group.label}</GroupLabel></TableCell>
        </TableRow>}
        {group.rows.map(row => <TableRow key={row.id} data-team-row={row.id} interactive onClick={event => rowPressed(event, row)}>
          <TableCell className={styles.identityCell} lead={row.lead}>
            <div data-slot="team-identity" className={styles.identity}>
              <span className={styles.mark}>{row.mark}</span>{title(row)}
              {row.description && <div data-slot="team-detail" title={row.description} className={styles.description}><Text role="meta">{row.description}</Text></div>}
            </div>
          </TableCell><TableCell>{row.state}</TableCell>
          {columns.map(column => <TableCell key={column.id} numeric={column.numeric}>{row.values[column.id]}</TableCell>)}
          <TableCell><span className={styles.trailing}>{row.actions}</span></TableCell>
        </TableRow>)}
      </Fragment>)}</TableBody>
    </Table>}
  </div>
}
