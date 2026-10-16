import type { ReactNode } from 'react'
import { Button } from '../ui/button'
import { Rows, Row, Text } from './Settings'
import { Section } from '../ui/section'
import { Card, CardContent } from '../ui/card'
import { SummaryList, SummaryItem } from '../ui/key-value'
import { Table } from '../ui/table'
import { Stat, StatRow } from '../ui/stat'
import styles from './DashboardBands.module.css'

export interface DashboardBand {
  readonly id: string; readonly title: string; readonly explanation?: ReactNode
  readonly rows: readonly { readonly id: string; readonly title: ReactNode; readonly description?: ReactNode; readonly value: ReactNode }[]
  readonly chart?: ReactNode
}
/** Recorded facts and quantitative figures; controls belong to the shared section head. */
export const DashboardBands = ({ bands }: { readonly bands: readonly DashboardBand[] }) => <>
  {bands.map(band => <Section key={band.id} title={band.title}>
    {band.explanation && <Text as="p" role="prose">{band.explanation}</Text>}
    {band.chart && <Card><CardContent><div data-slot="quantitative-chart" className={styles.chart}>{band.chart}</div></CardContent></Card>}
    {band.rows.length > 0 && <Rows>{band.rows.map(row => <Row key={row.id} kind="record"
      title={row.title} desc={row.description} control={row.value} />)}</Rows>}
  </Section>)}
</>
/** Overview's two related sections; the secondary column yields on narrow pages. */
export const DashboardColumns = ({ primary, secondary }: { readonly primary: ReactNode; readonly secondary: ReactNode }) =>
  <div data-slot="dashboard-columns" className={styles.columns}><div>{primary}</div><div>{secondary}</div></div>
/** Plan readings share a responsive card grid. */
export const DashboardAccounts = ({ accounts }: { readonly accounts: readonly ReactNode[] }) => <div className={styles.accounts}>{accounts}</div>
export const DashboardAccountHead = ({ mark, name, agent, states }: { readonly mark?: ReactNode; readonly name: ReactNode; readonly agent?: ReactNode; readonly states: ReactNode }) =>
  <CardContent><div className={styles.accountHead}>{mark && <span className={styles.mark}>{mark}</span>}<Text role="subject" truncate>{name}</Text>{agent && <Text role="meta" truncate>{agent}</Text>}<span className={styles.states}>{states}</span></div></CardContent>
export const DashboardAccountBody = ({ children }: { readonly children: ReactNode }) => <CardContent><div className={styles.accountBody}>{children}</div></CardContent>
export const DashboardAccountFoot = ({ source, age, actions, stale }: { readonly source: ReactNode; readonly age?: ReactNode; readonly actions?: ReactNode; readonly stale?: boolean }) =>
  <CardContent data-stale={stale ? '' : undefined}><Row kind="record" title={<Text role="meta" truncate>{source}</Text>} control={<>{age}{actions}</>} /></CardContent>
/** A plan's measured figure and its qualifiers, never a new control. */
export const DashboardFigure = ({ children }: { readonly children: ReactNode }) => <div className={styles.figure}>{children}</div>
/** Related meter rows inside one account. */
export const DashboardLanes = ({ children }: { readonly children: ReactNode }) => <div className={styles.lanes}>{children}</div>
/** A complete note next to its source glyph. */
export const DashboardReadingNote = ({ glyph, text }: { readonly glyph: ReactNode; readonly text: ReactNode }) => <div className={styles.readingNote}>{glyph}{text}</div>
/** A single quantitative fact; groups keep the same key column. */
export const DashboardFact = ({ label, value }: { readonly label: ReactNode; readonly value: ReactNode }) =>
  <SummaryList><SummaryItem label={label}>{value}</SummaryItem></SummaryList>
export const DashboardMoney = ({ children }: { readonly children: ReactNode }) => <CardContent><div className={styles.money}>{children}</div></CardContent>
/** Tables carry their shared account/reading/action column geometry in the system. */
export const DashboardTable = ({ kind, compact = false, children }: { readonly kind: 'plans' | 'ranked' | 'insight'; readonly compact?: boolean; readonly children: ReactNode }) =>
  <div data-slot={kind === 'plans' ? 'plans-table' : undefined} data-dashboard-table={kind} data-compact={compact || undefined} className={styles.table}>
    <Table variant="framed" density={compact ? 'compact' : 'comfortable'}>{children}</Table>
  </div>
export const DashboardPlanName = ({ name, meta }: { readonly name: ReactNode; readonly meta: ReactNode }) => <span className={styles.planName}><Text role="subject" truncate>{name}</Text><Text role="meta" truncate>{meta}</Text></span>
export const DashboardPlanReading = ({ meter, value, estimate }: { readonly meter?: ReactNode; readonly value: ReactNode; readonly estimate?: ReactNode }) => meter
  ? <div className={styles.planReading}>{meter}<span>{value}</span></div>
  : <div className={styles.balance}>{value}{estimate}</div>
export const DashboardAgentReading = ({ mark, name, value }: { readonly mark?: ReactNode; readonly name: ReactNode; readonly value: ReactNode }) => <span className={styles.agentReading}>{mark}<Text role="row">{name}</Text><Text role="meta">{value}</Text></span>
/** Periods and heatmap facts compose the canonical numeric tiles. */
export const DashboardStats = ({ facts }: { readonly facts: readonly { readonly id: string; readonly label: ReactNode; readonly value: ReactNode; readonly qualifier?: ReactNode; readonly caption?: ReactNode; readonly trend?: ReactNode }[] }) =>
  <StatRow>{facts.map(fact => <Stat key={fact.id} variant="plain" label={fact.label} value={fact.qualifier == null
    ? <Text role="metric">{fact.value}</Text>
    : <span className={styles.inlineFigure}><Text role="metric">{fact.value}</Text><Text role="meta">{fact.qualifier}</Text></span>}
    caption={fact.caption} trend={fact.trend} />)}</StatRow>
export const DashboardBurn = ({ readings, plot }: { readonly readings: ReactNode; readonly plot: ReactNode }) => <div className={styles.burn}><div>{readings}</div><div>{plot}</div></div>
/** A borrowed reading's activity summary belongs to that account, in one band. */
export const DashboardAccountActivity = ({ label, readings }: { readonly label: ReactNode; readonly readings: readonly ReactNode[] }) => <Card variant="muted" data-slot="account-activity"><CardContent><Text role="meta">{label}</Text><div className={styles.money}>{readings}</div></CardContent></Card>

/** Paid plus named chart measures such as Usage cost; the shared quiet button's pressed fill shows selection without a repeated chip. */
export const DashboardOverviewStats = ({ paid, measures }: {
  readonly paid: { readonly value: ReactNode; readonly caption?: ReactNode }
  readonly measures: readonly { readonly id: string; readonly label: string; readonly value: ReactNode; readonly caption?: ReactNode; readonly trend?: ReactNode; readonly title: string; readonly selected: boolean; readonly run: () => void }[]
}) => <div aria-label="What it cost, in brief">
  <StatRow><Stat variant="plain" label={<span className={styles.figureLabel}>Paid</span>} value={paid.value} caption={paid.caption} />
    {measures.map(item => <Button key={item.id} size="content" edgePlate variant="quiet" bordered={false} title={item.title} aria-pressed={item.selected} onClick={item.run}>
      <Stat variant="plain" label={<span className={styles.figureLabel}>{item.label}</span>} value={item.value} caption={item.caption} trend={item.trend} />
    </Button>)}
  </StatRow>
</div>
