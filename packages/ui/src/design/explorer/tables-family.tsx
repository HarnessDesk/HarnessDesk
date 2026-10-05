import {
  AccountMark, Button, Chip, EmptyState, Face, FaceStack, IconTile, KeyValue, KeyValueRow, ListRow, ListRows,
  Row, RowButton, RowChoice, RowValue, Rows, SectionHead, Switch,
  Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow,
} from '..'
import { AgentIcon, FolderIcon, ShieldAlertIcon } from '../../components/Icons'

const DENSITIES = ['comfortable', 'compact'] as const
const LONG_NAME = 'Review the shared workspace and its library of reusable project checks'
const SENTENCE = 'The folder is unavailable. Choose another folder before starting a new session here.'

const Name = ({ children, fact }: { children: string; fact?: string }) => (
  <div className="min-w-0">
    <div className="truncate text-(length:--hd-table-name-size) font-medium">{children}</div>
    {fact && <div className="mt-(--hd-table-line-gap) truncate text-(length:--hd-table-fact-size) text-(--hd-muted-foreground)">{fact}</div>}
  </div>
)

/** The catalogue and preview share the real row components and the same data. */
export const TablesFamily = () => (
  <div data-slot="tables-family" className="grid min-w-0 gap-(--hd-space-6) lg:grid-cols-2">
    {DENSITIES.map(density => (
      <section key={density} data-hd-table={density} className="flex min-w-0 flex-col gap-(--hd-space-4)">
        <h2 className="text-(length:--hd-text-lg) font-semibold">{density === 'comfortable' ? 'Comfortable' : 'Compact'}</h2>
        <SectionHead name="Data table · 3" />
        <Table density={density} data-catalog-size={density} variant="framed" className="table-fixed">
          <TableCaption variant="sr-only">Projects, their state, and recorded cost</TableCaption>
          <TableHeader><TableRow><TableHead className="w-1/2">Project</TableHead><TableHead>State</TableHead><TableHead numeric>Cost</TableHead></TableRow></TableHeader>
          <TableBody>
            <TableRow interactive data-testid={`tables-hover-${density}`}>
              <TableCell lead={<Face avatar="wizard" />}><Name fact="acme.dev">Storefront</Name></TableCell>
              <TableCell><Chip tone="neutral">Ready</Chip></TableCell><TableCell numeric>$12.34</TableCell>
            </TableRow>
            <TableRow data-state="selected"><TableCell><Name fact="dev@example.com">Jane Doe</Name></TableCell><TableCell><Chip tone="neutral">Selected</Chip></TableCell><TableCell numeric>$0.00</TableCell></TableRow>
            <TableRow><TableCell lead={<FaceStack faces={Array.from({length:6}, (_,n)=>({id:String(n),name:`Agent ${n+1}`,tint:(['blue','violet','rose'] as const)[n%3]!,mark:<AgentIcon />}))} />}><Name>{LONG_NAME}</Name></TableCell><TableCell><Chip tone="warning">Warning</Chip></TableCell><TableCell numeric><span className="text-(--hd-muted-foreground)">—</span></TableCell></TableRow>
          </TableBody>
        </Table>
        <SectionHead name="Face stack" />
        <FaceStack faces={Array.from({length:6}, (_,n)=>({id:String(n),name:`Agent ${n+1}`,tint:(['blue','violet','rose'] as const)[n%3]!,mark:<AgentIcon />}))} />
        <SectionHead name="List · 3" />
        <ListRows>
          <ListRow as="button" data-catalog-size={density} interactive lead={<Face avatar="wizard" />} title={LONG_NAME} subtitle="acme.dev / storefront" trail={<RowValue numeric>12</RowValue>} />
          <ListRow selected title="Review project checks" subtitle="3 checks" trail={<Chip tone="neutral">Selected</Chip>} />
          <ListRow lead={<IconTile tone="warning"><ShieldAlertIcon /></IconTile>} title="Workspace unavailable" subtitle={SENTENCE} wrapSubtitle trail={<Button size="sm" variant="outline">Choose…</Button>} />
        </ListRows>
        <SectionHead name="Settings rows · 4" />
        <Rows data-catalog-size={density}>
          <Row kind="record" face={<AccountMark size="row" data-tint="blue">JD</AccountMark>} title="Jane Doe" desc="dev@example.com" truncateDesc />
          <Row mark={<FolderIcon />} title="Working folder" desc={SENTENCE} control={<Button size="sm" variant="outline">Choose…</Button>} />
          <RowButton title="Library" desc="3 shared skills" onClick={() => {}} action={<Button size="sm" variant="outline">Manage</Button>} />
          <Row title="Start automatically" control={<Switch aria-label={`Start automatically (${density})`} defaultChecked />} />
        </Rows>
        <SectionHead name="Choices · 2" />
        <Rows role="radiogroup" aria-label={`Review mode (${density})`}>
          <RowChoice title="Review every change" selected onClick={() => {}} />
          <RowChoice title="Run on this machine" desc="Choose a working folder first." selected={false} disabled onClick={() => {}} />
        </Rows>
        <SectionHead name="Matrix · 2" />
        <Table variant="framed" density={density} rows="bare">
          <TableCaption variant="sr-only">Which projects load each skill</TableCaption>
          <TableHeader><TableRow variant="matrix"><TableHead variant="matrix">Skill</TableHead><TableHead variant="matrix" align="center">Storefront</TableHead><TableHead variant="matrix" align="center">Service</TableHead></TableRow></TableHeader>
          <TableBody>
            <TableRow variant="matrix" interactive data-state="selected"><TableHead variant="row" pinned>Review</TableHead><TableCell variant="matrix" align="center">Loaded</TableCell><TableCell variant="matrix" align="center">Loaded</TableCell></TableRow>
            <TableRow variant="matrix"><TableHead variant="row">Build</TableHead><TableCell variant="matrix" align="center">Loaded</TableCell><TableCell variant="matrix" align="center"><span className="text-(--hd-muted-foreground)">—</span></TableCell></TableRow>
          </TableBody>
        </Table>
        <SectionHead name="Key-value" />
        <KeyValue><KeyValueRow label="Owner">Jane Doe</KeyValueRow><KeyValueRow label="Host">acme.dev</KeyValueRow><KeyValueRow label="Recorded cost" numeric footer emphasis>$12.34</KeyValueRow></KeyValue>
        <SectionHead name="Empty list" />
        <Rows><EmptyState variant="row" title="No projects" description="Projects appear here after you choose a folder." /></Rows>
        <p className="text-(length:--hd-text-xs) text-(--hd-muted-foreground)">Log: see the Git surface for its fixed 26px row pitch. Hover the first project to see the interactive row.</p>
      </section>
    ))}
  </div>
)
