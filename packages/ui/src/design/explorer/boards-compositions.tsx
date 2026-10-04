import { TeamRecordBoard } from '../../preview/frames-team-record'
import { RunInspectorBoard } from '../../preview/frames-run-inspector'
import { FlowGraphBoard } from '../../preview/frames-flow-graph'
import { RunViewBoard } from '../../preview/frames-run-view'
import { TeamsPageBoard } from '../../preview/frames-teams-page'
import { TeamOverviewBoard } from '../../preview/frames-team-overview'
import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'

import {
  NO_CAPABILITIES,
  isBusy,
  runtimeId,
  type FindingRunView,
  type LedgerDay,
  type LedgerReport,
  type LedgerRow,
  type PlanSuggestion,
  type RuntimeId,
  type RuntimeInfo,
  type UsageBilling,
  type UsageReport,
} from '@harnessdesk/protocol'
import { FindingDecision } from '../../components/FindingDecision'
import { WindowControls } from '../../components/WindowControls'
import { splitRefusal } from '../../panels/PanelActions'
import { SideBySide, sideBySideTileEntry } from '../../components/SideBySide'
import { Menu, MenuItem } from '..'
import { OverviewStrip, type StripMetric } from '../../components/usage/OverviewStrip'

import {
  AgentIcon,
  BranchIcon,
  CostIcon,
  ExtensionIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  ShieldAlertIcon,
  TeamIcon,
  TerminalIcon,
  UsageIcon,
} from '../../components/Icons'
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  Avatar,
  AvatarFallback,
  AvatarStack,
  Bar,
  Bars,
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Board,
  BoardCard,
  BoardColumn,
  BoardMenuButton,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardViewport,
  Checkbox,
  ChoiceRow,
  DataTableColumnHeader,
  DataTablePagination,
  DataTableSelectAll,
  Delta,
  Donut,
  EmptyState,
  Field,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSet,
  FieldSeparator,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Badge,
  IconTile,
  InputGroupAddon,
  InputGroupInput,
  InputGroup,
  KeyValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  KeyValueRow,
  ListRow,
  ListRows,
  Marker,
  MarkerContent,
  MarkerIcon,
  Progress,
  ProgressRing,
  ProgressStack,
  RadioGroup,
  RadioGroupItem,
  ResizeHandle,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Section,
  SectionAction,
  SectionBody,
  SectionDescription,
  SectionFooter,
  SectionHeader,
  SectionTitle,
  BurnDown,
  ChartAxis,
  ChartCard,
  ChartFoot,
  ChartFrame,
  ChartHead,
  ChartHint,
  ChartKey,
  ChartKeys,
  ChartTitle,
  DayColumns,
  PaceBadge,
  SegmentMeter,
  Sparkline,
  Stat,
  Tick,
  StatRow,
  Stepper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  ToolPane,
  ToolPaneBar,
  ToolPaneBody,
  ToolPaneHeader,
  ToolPaneMessage,
  ToolPaneNotice,
  Toaster,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TINTS,
  useTableSelection,
  useTableSort,
  TONES,
  Toolbar,
  ToolbarGap,
  toast,
  SummaryItem,
  SummaryList,
} from '../ui'
import { ConversationEmptyState } from '../patterns/ConversationEmptyState'
import { entriesFromSilent, NotReportingList } from '../../components/usage/NotReporting'
import { PlansTable, ShapeFilters } from '../../components/usage/PlansTable'
import type { SilentAgent } from '../../components/usage/shared'
import { StoreProvider } from '../../state/context'
import { emptySnapshot, type AppStore } from '../../state/store'
import { dock, emptyWorkbench } from '../../state/workbench'
import type { PaneView } from '../../state/layout'
import { emptySideBySide, type SideBySideState } from '../../lib/side-by-side'
import { SIDE_BY_SIDE_KEYS, SIDE_BY_SIDE_MEMBERS, sideBySideStore } from '../../preview/side-by-side-fixture'
import { runtimeTint } from '../../lib/accounts'
import { seatCeilingOf } from '../../lib/ceilings'
import { planRows, shapeCountsOf, type PlanRow } from '../../lib/plans-table'
import {
  Counts,
  GroupLine,
  PanelBody,
  PanelFilter,
  PanelFooter,
  PanelFrame,
  PanelRow,
  PanelTools,
  RunDot,
} from '../patterns/InspectorPanel'
import { PatchHeader } from '../patterns/Change'
import {
  DockDropEdge,
  DockDropTarget,
  PaneSurface,
  WorkbenchCanvas,
  WorkbenchRail,
  WorkbenchScrim,
} from '../patterns/DockPanel'
import { CodeText, Dot, Row, Rows, SectionHead, Spinner, Text } from '../patterns/Settings'
import { HeatGrid, HeatLegend, type HeatGridRow } from '../ui/heat-grid'
import {
  agentLevels,
  buildAgentRows,
  buildHourGrid,
  buildYearGrid,
  toGridCell,
  toHourGridCell,
  yearLevels,
  WEEKDAY_NAMES,
  type HeatCell,
  type HeatMetric,
} from '@/lib/heat'
import { AGENTS, COLUMNS, SESSIONS_TREND, SETUP_STEPS, SPEND_BY_DAY } from '../showcase/fixtures'
import { DialogBoard, type Board as BoardSpec } from './boards'
import { IconBoard } from './icon-board'
import { Specimen } from './specimen'
import styles from './explorer.module.css'
import { PlanCard } from '../patterns/PlanCard'

/**
 * The composition layer, board by board.
 *
 * These sit beside the primitive boards rather than replacing them, because
 * they answer a different question. A primitive board asks *is this component
 * right in all its states* — every variant, side by side, on a plain ground.
 * A composition board has to ask that too, and then one more thing: *does the
 * variant set make sense*. Three ways to draw a figure is a system; six is a
 * decision nobody made, and the only place that shows is a page like this with
 * all six on it.
 *
 * So each board below carries the states first and the rule last. Where a
 * component's variants encode a judgement — a stat's ground, a column's hue —
 * the board shows the wrong choice next to the right one, because the rule
 * only means something if the alternative is visible.
 */

/** A labelled cell in a state matrix, drawn the way the primitive boards draw one. */
const Case = ({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) => (
  <div className={className ? `${styles.case} ${className}` : styles.case}>
    <div className={styles.caseLabel}>{label}</div>
    <div className={styles.caseBody}>{children}</div>
  </div>
)

const TEXTAREA_CATALOG_VARIANTS = ['default', 'editor', 'code', 'inline', 'composer'] as const
const TEXTAREA_CATALOG_SIZES = ['default', 'compact', 'composer', 'paragraphs'] as const
const TEXTAREA_CATALOG_STATES = ['default', 'focus-visible', 'disabled', 'error'] as const
const ATTACHMENT_CATALOG_VARIANTS = ['default'] as const
const ATTACHMENT_CATALOG_SIZES = ['sm', 'default', 'lg'] as const
const ATTACHMENT_CATALOG_STATES = ['default', 'loading', 'error'] as const
const ATTACHMENT_CATALOG_ORIENTATION = ['horizontal', 'vertical', 'tile'] as const
const BADGE_CATALOG_VARIANTS = ['default', 'secondary', 'destructive', 'outline'] as const
const BADGE_CATALOG_SIZES = ['default'] as const
const BADGE_CATALOG_STATES = ['default', 'active', 'inactive'] as const

const TABS_CATALOG_VARIANTS = ['default', 'line'] as const
const TABS_CATALOG_SIZES = ['default'] as const
const TABS_CATALOG_STATES = ['unselected', 'selected', 'focus-visible', 'disabled'] as const

const ICON_TILE_CATALOG_VARIANTS = ['default'] as const
const ICON_TILE_CATALOG_SIZES = ['xs', 'sm', 'default', 'lg'] as const
const ICON_TILE_CATALOG_STATES = ['default', 'hover', 'selected'] as const
const ICON_TILE_CATALOG_SHAPE = ['square', 'round', 'face'] as const
const INPUT_GROUP_CATALOG_VARIANTS = ['default'] as const
const INPUT_GROUP_CATALOG_SIZES = ['default'] as const
const INPUT_GROUP_CATALOG_STATES = ['default', 'focus-visible', 'disabled', 'error'] as const
const INPUT_GROUP_CATALOG_ALIGN = ['inline-start', 'inline-end', 'block-start', 'block-end'] as const
const MARKER_CATALOG_VARIANTS = ['default', 'border', 'separator'] as const
const MARKER_CATALOG_SIZES = ['default'] as const
const MARKER_CATALOG_STATES = ['default', 'success', 'warning', 'error'] as const
const SECTION_CATALOG_VARIANTS = ['card', 'plain', 'quiet', 'panel', 'page'] as const
const SECTION_CATALOG_SIZES = ['default'] as const
const SECTION_CATALOG_STATES = ['expanded', 'collapsed'] as const
const KEY_VALUE_CATALOG_VARIANTS = ['default', 'panel', 'summary'] as const
const KEY_VALUE_CATALOG_SIZES = ['default'] as const
const KEY_VALUE_CATALOG_STATES = ['default', 'empty', 'populated'] as const
const TOOL_PANE_CATALOG_VARIANTS = ['default', 'integrated'] as const
const TOOL_PANE_CATALOG_SIZES = ['default'] as const
const TOOL_PANE_CATALOG_STATES = ['default', 'loading', 'empty', 'error'] as const
const STAT_CATALOG_VARIANTS = ['plain', 'bordered', 'tinted'] as const
const STAT_CATALOG_SIZES = ['default'] as const
const STAT_CATALOG_STATES = ['default', 'loading', 'error'] as const
const STAT_CATALOG_ALIGN = ['start', 'center'] as const

/** The rule this component holds, said under the states that demonstrate it. */
const Rule = ({ children }: { children: React.ReactNode }) => (
  <p className={styles.rule}>{children}</p>
)

// --- panel controls ----------------------------------------------------------

const panelControlsStore = (views: readonly PaneView[], collapsed = false): AppStore => {
  const right = views.reduce((workbench, view) => dock(workbench, 'right', view), emptyWorkbench()).right
  const snapshot = { ...emptySnapshot(), workbench: { ...emptyWorkbench(), right: { ...right, collapsed } } }
  return { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
}

const PanelControlsBoard = () => {
  const shown = panelControlsStore([{ kind: 'trajectory' }])
  const putAwayOne = panelControlsStore([{ kind: 'trajectory' }], true)
  const putAwayThree = panelControlsStore([
    { kind: 'trajectory' },
    { kind: 'changes' },
    { kind: 'agents' },
  ], true)
  const rowRefusal = splitRefusal('row', { width: 280, height: 280 })
  const columnRefusal = splitRefusal('column', { width: 280, height: 280 })
  return (
    <>
      <Specimen measure="page" caption="The header toggle counts views left in a hidden right panel; split actions carry their measured refusal">
        <div className={styles.matrix}>
          <Case label="right panel shown — Hide the right panel, no badge">
            <StoreProvider store={shown}><WindowControls /></StoreProvider>
          </Case>
          <Case label="right panel put away — 1 view badge">
            <StoreProvider store={putAwayOne}><WindowControls /></StoreProvider>
          </Case>
          <Case label="right panel put away — 3 views badge">
            <StoreProvider store={putAwayThree}><WindowControls /></StoreProvider>
          </Case>
          <Case label="Side by side disabled at 280px">
            <Menu close={() => { }}><MenuItem label="Side by side" disabled={rowRefusal ?? false} onSelect={() => {}} /></Menu>
          </Case>
          <Case label="One above the other disabled at 280px">
            <Menu close={() => { }}><MenuItem label="One above the other" disabled={columnRefusal ?? false} onSelect={() => {}} /></Menu>
          </Case>
        </div>
      </Specimen>
      <Rule>
        The header examples mount the shipped WindowControls against three right-dock snapshots. The split rows use the shipped splitRefusal result and MenuItem props from PanelActions; they are rendered directly because opening the panel menu needs a mounted workbench.
      </Rule>
    </>
  )
}

// --- figures ----------------------------------------------------------------

const StatBoard = () => (
  <>
    <Specimen measure="wide" caption="Stat rows: variants, alignment, and a dashboard's own numbers">
    <div
      className={styles.stack}
      style={{ maxWidth: 'none' }}
      data-catalog-variants={STAT_CATALOG_VARIANTS.join(' ')}
      data-catalog-sizes={STAT_CATALOG_SIZES.join(' ')}
      data-catalog-states={STAT_CATALOG_STATES.join(' ')}
      data-catalog-align={STAT_CATALOG_ALIGN.join(' ')}
    >
      <StatRow>
        {STAT_CATALOG_VARIANTS.map((variant) => (
          <Stat key={variant} variant={variant} data-catalog-variant={variant} label={variant} value="12" caption="catalog case" />
        ))}
      </StatRow>
      <StatRow>
        {STAT_CATALOG_ALIGN.map((align) => (
          <Stat key={align} align={align} data-catalog-align={align} label={align} value="12" caption="catalog case" />
        ))}
      </StatRow>
      <StatRow>
        <Stat
          label="Sessions today"
          value="46"
          icon={<TerminalIcon />}
          tone="brand"
          trend={<Delta value={18} />}
          caption="vs. yesterday"
        />
        <Stat
          label="Tokens spent"
          value="8.4M"
          icon={<UsageIcon />}
          trend={<Delta value={6} />}
          caption="this week"
        />
        <Stat
          label="Waiting on you"
          value="3"
          icon={<ShieldAlertIcon />}
          tone="warning"
          trend={<Delta value={-2} better="down" />}
          caption="approvals"
        />
        <Stat
          label="Cost"
          value="$212.40"
          icon={<CostIcon />}
          tone="success"
          trend={<Delta value={-12} better="down" />}
          caption="vs. last week"
        />
      </StatRow>
      <StatRow>
        <Stat variant="tinted" tone="neutral" label="Total" value="8" caption="intents" align="center" />
        <Stat variant="tinted" tone="warning" label="Waiting" value="2" caption="on you" align="center" />
        <Stat variant="tinted" tone="info" label="Open" value="2" caption="unclaimed" align="center" />
        <Stat variant="tinted" tone="danger" label="Blocked" value="4" caption="need a decision" align="center" />
      </StatRow>
    </div>
    </Specimen>
    <div className={styles.matrix} style={{ marginTop: 'var(--hd-space-4)' }}>
      <Case label="variant=plain">
        <Stat variant="plain" label="Turns" value="1,284" caption="this month" />
      </Case>
      <Case label="no caption — the figure means less">
        <Stat label="Turns" value="1,284" />
      </Case>
      <Case label="down is good">
        <Stat
          label="Latency"
          value="612ms"
          trend={<Delta value={-9} better="down" format={(n) => `${n}%`} />}
          caption="p95"
        />
      </Case>
      <Case label="flat">
        <Stat label="Failures" value="0" trend={<Delta value={0} />} caption="seven days" />
      </Case>
    </div>
    <Rule>
      <code>tinted</code> is for a set that is read together — four counts over a queue, where
      &ldquo;4 blocked&rdquo; has to be red before it is read. One tinted tile among bordered ones
      reads as an alert nobody raised. And <code>caption</code> is not decoration: a figure with no
      period attached could be today, this month, or since install.
    </Rule>
  </>
)

const DeltaBoard = () => (
  <>
    <div className={styles.matrix}>
      <Case label="up is good (default)">
        <Delta value={18} />
        <Delta value={-5} />
        <Delta value={0} />
      </Case>
      <Case label="down is good">
        <Delta value={-12} better="down" />
        <Delta value={9} better="down" />
      </Case>
      <Case label="a fact, not a verdict">
        <Delta value={-5} tone="neutral" />
      </Case>
      <Case label="own format, with a basis">
        <Delta value={-40} better="down" format={(n) => `${n}ms`} caption="p95" />
      </Case>
    </div>
    <Rule>
      The sign picks the colour, so no call site can accidentally paint a regression green. Where
      down is the good news — cost, latency, failures — say <code>better=&quot;down&quot;</code>: the
      arrow keeps reporting the measurement while the colour reports the verdict.
    </Rule>
  </>
)

// --- surfaces ---------------------------------------------------------------

/**
 * The Agent page, before and after the page grammar.
 *
 * Before: five facts about one Agent, each a grey label over a card that
 * holds one row — the label 18px under the card above and 20px over its own,
 * so it named neither. After: one `Section` holding one `SummaryList`, the
 * facts read top to bottom like an inspector and every action in one column
 * at the end. The words are the page's own, so the comparison is the layout
 * and nothing else.
 */
const AGENT_FILE = '~/work/storefront/.harnessdesk/agents/code-reviewer/AGENT.md'
const AGENT_BRIEF = 'Read a change against the checkout rules before anyone merges it, and say what would break.'

const PageGrammar = () => (
  <>
    <div className="grid w-full items-start gap-(--hd-space-3) xl:grid-cols-2" data-catalog-example="page-grammar">
      <Case label="the Agent page, before: a label over a one-row card, five times">
        <div className="w-full">
          <SectionHead name="File" />
          <Rows>
            <Row
              title={<CodeText>{AGENT_FILE}</CodeText>}
              desc="Comes first over the one that ships"
              control={<><Button size="sm" variant="outline">Open file</Button><Button size="sm" variant="outline">Reveal</Button></>}
            />
          </Rows>
          <SectionHead name="Ceiling" />
          <Rows>
            <Row title="Edit" desc="May change files and commit in its own checkout, and never push." control={<Button size="sm" variant="outline">Update…</Button>} />
          </Rows>
          <SectionHead name="Skills" />
          <Rows><Row title="Runtime defaults" control={<Button size="sm" variant="outline">Edit…</Button>} /></Rows>
          <SectionHead name="Servers" />
          <Rows><Row title="Runtime defaults" control={<Button size="sm" variant="outline">Edit…</Button>} /></Rows>
          <SectionHead name="Brief" />
          <Rows><Row title={AGENT_BRIEF} control={<Button size="sm" variant="outline">Open in editor</Button>} /></Rows>
        </div>
      </Case>
      <Case label="after: one Section, one SummaryList">
        <div className="w-full">
          <Section title="Agent" description="Read from its file; the file is the truth.">
            <SummaryList>
              <SummaryItem label="File" kind="path" note="Comes first over the one that ships" action={<Button size="sm" variant="secondary">Open file</Button>}>
                {AGENT_FILE}
              </SummaryItem>
              <SummaryItem label="Ceiling" note="May change files and commit in its own checkout, and never push." action={<Button size="sm" variant="secondary">Update…</Button>}>
                Edit
              </SummaryItem>
              <SummaryItem label="Skills" action={<Button size="sm" variant="secondary">Edit…</Button>}>Runtime defaults</SummaryItem>
              <SummaryItem label="Servers" action={<Button size="sm" variant="secondary">Edit…</Button>}>Runtime defaults</SummaryItem>
              <SummaryItem label="Brief" action={<Button size="sm" variant="secondary">Open in editor</Button>}>{AGENT_BRIEF}</SummaryItem>
            </SummaryList>
          </Section>
          <Section title="Seats" action={<Button size="sm" variant="outline"><PlusIcon /> Add a seat…</Button>}>
            <Rows>
              <Row title="Claude · Opus" desc="The seat it takes here" />
              <Row title="Codex" desc="Free here" />
            </Rows>
          </Section>
        </div>
      </Case>
    </div>
    <Rule>
      A page is a head and a column of <code>Section</code>s, each a <code>GroupLabel</code> over one
      card. The section owns the space — 8px from label to card, 32px to the next section — so a
      screen writes no margin. Five facts about one thing are one <code>SummaryList</code>: a key
      column, a value that wraps, an optional note and an action at the row&rsquo;s end.
    </Rule>
  </>
)

const SectionBoard = () => (
  <>
    <div
      className={styles.stack}
      style={{ maxWidth: 640 }}
      data-catalog-variants={SECTION_CATALOG_VARIANTS.join(' ')}
      data-catalog-sizes={SECTION_CATALOG_SIZES.join(' ')}
      data-catalog-states={SECTION_CATALOG_STATES.join(' ')}
    >
      {SECTION_CATALOG_VARIANTS.map((variant) =>
        variant === 'page' ? (
          /* The page form: a title makes it a section of a page — the label
             over its card, and the spacing owned. */
          <div key={variant}>
            <Section
              title="Rules"
              description="A rule answers a request before it reaches you."
              action={<Button variant="outline" size="sm"><PlusIcon /> Add rule</Button>}
              data-catalog-variant={variant}
            >
              <Rows>
                <Row title="Allow the test runner" desc="Approves commands containing “pnpm test”." />
                <Row title="Never push" desc="Denies commands containing “git push”." />
              </Rows>
            </Section>
          </div>
        ) : (
          <Section key={variant} variant={variant} data-catalog-variant={variant}>
            <SectionHeader><SectionTitle>{variant}</SectionTitle></SectionHeader>
            <SectionBody>Canonical section variant.</SectionBody>
          </Section>
        ),
      )}
      <Section>
        <SectionHeader>
          <SectionTitle>Approvals</SectionTitle>
          <SectionDescription>What an agent may do without asking you first.</SectionDescription>
          <SectionAction>
            <Button variant="outline" size="sm">
              Edit
            </Button>
          </SectionAction>
        </SectionHeader>
        <SectionBody>
          <KeyValue>
            <KeyValueRow label="Read files">Always</KeyValueRow>
            <KeyValueRow label="Write files">Ask</KeyValueRow>
            <KeyValueRow label="Run commands">Ask</KeyValueRow>
          </KeyValue>
        </SectionBody>
        <SectionFooter>
          <ToolbarGap />
          <Button variant="ghost" size="sm">
            Reset
          </Button>
          <Button size="sm">Save</Button>
        </SectionFooter>
      </Section>
      <Section variant="quiet">
        <SectionHeader>
          <SectionTitle>Note</SectionTitle>
        </SectionHeader>
        <SectionBody>
          A quiet section is an aside inside a surface that already has an edge. A card inside a card
          is a box someone forgot to delete.
        </SectionBody>
      </Section>
      <Section variant="quiet">
        <SectionBody spacing="compact">Compact inset for a short grant or summary.</SectionBody>
      </Section>
      <Section variant="plain">
        <SectionHeader>
          <SectionTitle>Plain</SectionTitle>
          <SectionDescription>No ground and no edge — a titled region of a page.</SectionDescription>
        </SectionHeader>
        <SectionBody className="px-0">
          <Toolbar>
            <Button size="sm">
              <PlusIcon /> New
            </Button>
            <ToolbarGap />
            <InputGroup className="w-44">
              <InputGroupAddon align="inline-start">
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput placeholder="Search…" aria-label="Search" />
            </InputGroup>
          </Toolbar>
        </SectionBody>
      </Section>
    </div>
    <PageGrammar />
    <Rule>
      The header lays out on a grid that grows a second column only when a{' '}
      <code>SectionAction</code> is really there — <code>has-data-[slot=…]</code> asks the DOM
      instead of making the caller pass a flag, so a conditionally rendered button cannot leave a
      dead column behind. <code>SectionBody inset={'{false}'}</code> is for rows that draw their own
      padding and need their hover ground to reach the card&rsquo;s edge.
    </Rule>
  </>
)


/**
 * Badge and Tabs — the two primitives that had no board.
 *
 * Both are shipped: `Badge` in the conversation, the composer controls, the
 * skill sheet and a channel; `Tabs` in the changes review, extensions and the
 * plugins section. Their only appearance in this catalogue used to be inside
 * `showcase/ToolsPage`, a drawing of the tool panes — so the one place a
 * reader could see a badge was a place where no badge the app ships had ever
 * been rendered. Deleting the drawing left two primitives undocumented, which
 * is how they came to be here.
 */
const BadgeTabsBoard = () => (
  <div className={styles.stack} data-catalog-sizes={[...BADGE_CATALOG_SIZES, ...TABS_CATALOG_SIZES].join(' ')}>
    <div className={styles.matrix} data-catalog-states={BADGE_CATALOG_STATES.join(' ')}>
      {BADGE_CATALOG_VARIANTS.map((variant) => (
        <Badge key={variant} variant={variant} data-catalog-variant={variant}>
          {variant}
        </Badge>
      ))}
    </div>

    {TABS_CATALOG_VARIANTS.map((variant) => (
      <Tabs key={variant} defaultValue="one" data-catalog-states={TABS_CATALOG_STATES.join(' ')}>
        <TabsList variant={variant} data-catalog-variant={variant}>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="one">The first panel.</TabsContent>
        <TabsContent value="two">The second.</TabsContent>
      </Tabs>
    ))}
  </div>
)

const TileBoard = () => (
  <>
    <div
      className={styles.matrix}
      data-catalog-variants={ICON_TILE_CATALOG_VARIANTS.join(' ')}
      data-catalog-sizes={ICON_TILE_CATALOG_SIZES.join(' ')}
      data-catalog-states={ICON_TILE_CATALOG_STATES.join(' ')}
      data-catalog-shape={ICON_TILE_CATALOG_SHAPE.join(' ')}
    >
      <Case label="tone — a judgement">
        {TONES.map((tone) => (
          <IconTile key={tone} tone={tone} title={tone}>
            <ShieldAlertIcon />
          </IconTile>
        ))}
      </Case>
      <Case label="tint — an identity">
        {TINTS.map((tint) => (
          <IconTile key={tint} tint={tint} title={tint}>
            <AgentIcon />
          </IconTile>
        ))}
      </Case>
      <Case label="size">
        {ICON_TILE_CATALOG_SIZES.map((size) => (
          <IconTile key={size} size={size} data-catalog-size={size} tint="blue">
            <FolderIcon />
          </IconTile>
        ))}
      </Case>
      <Case label="shape — a thing, an account's ring, a face (follows Faces)">
        {ICON_TILE_CATALOG_SHAPE.map((shape) => (
          <IconTile key={shape} shape={shape} data-catalog-shape={shape} tint="violet" size="lg">
            {shape === 'square' ? <ExtensionIcon /> : <AgentIcon />}
          </IconTile>
        ))}
      </Case>
    </div>
    <Rule>
      Tone and tint are different vocabularies and the type refuses both at once. A warning tile says
      the number beside it is bad news; a violet tile says nothing except &ldquo;Codex, not
      Claude&rdquo;. Collapsing the two is how a green badge comes to mean &ldquo;passing&rdquo; on
      one card and &ldquo;the Marketplace channel&rdquo; on the next.
    </Rule>
  </>
)

// --- lists ------------------------------------------------------------------

const ListBoard = () => (
  <>
    <div className={styles.stack} style={{ maxWidth: 560 }}>
      <Section>
        <SectionBody inset={false}>
          <ListRows>
            <ListRow
              interactive
              lead={<AvatarStack members={[AGENTS[0]!]} />}
              title="Migrate the auth callers"
              subtitle="harnessdesk / src/api"
              trail={<Delta value={12} />}
            />
            {/* One face on its own, the primitive the stack is made of — the
                catalogue's measured case for `avatar`. */}
            <ListRow
              lead={
                <Avatar data-catalog-size="default">
                  <AvatarFallback>SH</AvatarFallback>
                </Avatar>
              }
              title="Review the migration"
              subtitle="Shane · asked 5m ago"
            />
            <ListRow
              interactive
              lead={
                <IconTile tint="teal">
                  <TerminalIcon />
                </IconTile>
              }
              title="Integration tests for the gateway"
              subtitle="packages/server · claimed 2h ago"
              meta={<Progress value={44} size="sm" className="max-w-56" />}
              trail={<span className="text-(--hd-muted-foreground)">Running</span>}
            />
            <ListRow
              lead={
                <IconTile tone="warning">
                  <ShieldAlertIcon />
                </IconTile>
              }
              title="Trace the flaky socket test"
              subtitle="Waiting on approval because the socket runner is still holding the port from its last failed attempt."
              wrapSubtitle
              trail={<Progress value={19} tone="warning" className="w-24" />}
            />
            <ListRow size="sm" nav title="Board" />
            <ListRow size="sm" nav selected title="Chat" />
          </ListRows>
        </SectionBody>
      </Section>
    </div>
    <Rule>
      Rows are divided by hairlines, not gaps: a list separated by whitespace is a stack of cards,
      which claims each entry is its own object. <code>interactive</code> is a promise — the third
      row is a reading and does not light up, because teaching a reader to click things that ignore
      them is worse than a flat row.
    </Rule>
  </>
)

const KeyValueBoard = () => (
  <>
    <div
      className={styles.matrix}
      data-catalog-variants={KEY_VALUE_CATALOG_VARIANTS.join(' ')}
      data-catalog-sizes={KEY_VALUE_CATALOG_SIZES.join(' ')}
      data-catalog-states={KEY_VALUE_CATALOG_STATES.join(' ')}
    >
      <Case label="inspector: sentences wrap, a path gives up its middle">
        <KeyValue className="w-full" data-catalog-variant="default">
          <KeyValueRow label="Source" kind="path">~/work/storefront/.harnessdesk/triggers/review.json</KeyValueRow>
          <KeyValueRow label="Declares">When a pull request opens, open review-pr.</KeyValueRow>
          <KeyValueRow label="Repository">acme/widgets</KeyValueRow>
        </KeyValue>
      </Case>
      <Case label="numbers, with a total">
        <KeyValue className="w-full">
          <KeyValueRow label="Prompt" numeric>5.9M</KeyValueRow>
          <KeyValueRow label="Completion" numeric>2.5M</KeyValueRow>
          <KeyValueRow label="Cached" numeric>−1.8M</KeyValueRow>
          <KeyValueRow label="Charged" numeric emphasis>
            $212.40
          </KeyValueRow>
        </KeyValue>
      </Case>
      <Case label="summary: facts about one object, as a card">
        <SummaryList className="w-full" data-catalog-variant="summary">
          <SummaryItem label="File" kind="path" action={<Button size="sm" variant="secondary">Open file</Button>}>
            ~/work/storefront/.harnessdesk/agents/code-reviewer/AGENT.md
          </SummaryItem>
          <SummaryItem label="Ceiling" note="May change files and commit in its own checkout, and never push.">Edit</SummaryItem>
          <SummaryItem label="Seats" numeric>3</SummaryItem>
        </SummaryList>
      </Case>
      <Case label="compact panel facts">
        <KeyValue variant="panel" className="w-full" data-catalog-variant="panel">
          <KeyValueRow variant="panel" label="Branch">main</KeyValueRow>
          <KeyValueRow variant="panel" label="Status">Ready</KeyValueRow>
        </KeyValue>
      </Case>
      <Case label="progress, as a reading">
        <div className="flex w-full flex-col gap-2">
          <Progress value={82} tone="success" />
          <Progress value={44} />
          <Progress value={19} tone="warning" />
          <Progress value={96} tone="danger" label="96% of plan" />
          <Progress value={12} measure="remaining" label="12% left" />
        </div>
      </Case>
      <Case label="ring and composed reading">
        <div className="flex w-full items-start gap-4">
          <ProgressRing value={74} size={28} tone="warning" label="Context window" />
          <ProgressStack
            className="min-w-48 flex-1"
            label="What is in context"
            parts={[
              { id: 'instructions', label: 'Instructions', value: 62, reading: '62K', meta: '62%' },
              { id: 'tools', label: 'Tools', value: 38, reading: '38K', meta: '38%' },
            ]}
          />
        </div>
      </Case>
      <Case label="text roles">
        <div className="flex flex-col gap-1">
          <Text as="h2" role="section">What is left</Text>
          <Text role="subject">Account name</Text>
          <Text role="row">Weekly allowance</Text>
          <Text role="muted">Resets in four days</Text>
          <Text role="meta">Read 2m ago</Text>
          <Text role="meta" ink="secondary">Operation detail</Text>
          <Text role="figure">74%</Text>
        </div>
      </Case>
    </div>
    <Rule>
      Ordinary progress fills with what has <em>happened</em>. A remaining budget says so through
      <code>measure=&quot;remaining&quot;</code>, fills with the amount left, and takes its warning and danger
      tones from the same thresholds on every screen.
    </Rule>
  </>
)

const ToolPaneBoard = () => {
  const [filter, setFilter] = useState('')
  return (
    <>
      <div
        className={styles.matrix}
        data-catalog-variants={TOOL_PANE_CATALOG_VARIANTS.join(' ')}
        data-catalog-sizes={TOOL_PANE_CATALOG_SIZES.join(' ')}
        data-catalog-states={TOOL_PANE_CATALOG_STATES.join(' ')}
      >
        <Case label="standalone frame">
          <ToolPane className="h-56 w-full" data-catalog-variant="default">
            <ToolPaneHeader title="Terminal" subtitle="/work/project" />
            <ToolPaneBody>
              <CodeText>$ pnpm verify</CodeText>
            </ToolPaneBody>
          </ToolPane>
        </Case>
        <Case label="integrated tool">
          <ToolPane variant="integrated" className="@container/browser h-56 w-full" data-catalog-variant="integrated">
            <ToolPaneHeader variant="window" title="Browser" subtitle="https://example.com" />
            <ToolPaneBar variant="address">example.com</ToolPaneBar>
            <ToolPaneNotice tone="warning">The page is still loading.</ToolPaneNotice>
            <ToolPaneBody bleed>
              <ToolPaneMessage>Waiting for the page.</ToolPaneMessage>
            </ToolPaneBody>
            <Bar rule="top">
              <Dot state="signin" pulse />
              <Text role="meta">Being driven</Text>
              <ToolbarGap />
              <Text role="meta" className="hidden @[18rem]/browser:inline">Framed pages only — the desktop app runs a real browser</Text>
            </Bar>
          </ToolPane>
        </Case>
        <Case label="integrated tool — page failed to load">
          <ToolPane variant="integrated" className="@container/browser h-56 w-full" data-catalog-case="tool-pane-failure">
            <ToolPaneBar variant="address">http://127.0.0.1:9/</ToolPaneBar>
            <ToolPaneBody bleed>
              <EmptyState
                title="Couldn't reach 127.0.0.1 — the connection was refused"
                description="http://127.0.0.1:9/"
                className="h-full justify-center py-0"
              >
                <Button variant="secondary" size="sm">Try again</Button>
              </EmptyState>
            </ToolPaneBody>
            <Bar rule="top">
              <Text role="meta">Page failed to load</Text>
              <ToolbarGap />
              <Text role="meta" className="hidden @[18rem]/browser:inline">Framed pages only — the desktop app runs a real browser</Text>
            </Bar>
          </ToolPane>
        </Case>
        <Case label="bar — focused pane among several">
          <div className="flex flex-col gap-3">
            <Bar rule="bottom" active><Text role="row">Alpha · Model A</Text></Bar>
            <Bar rule="bottom"><Text role="row">Beta · Model B</Text></Bar>
          </div>
        </Case>
        <Case label="bar — grows for a name that must not truncate">
          <div className="w-72">
            <Bar rule="bottom" grow>
              <Text role="row" className="min-w-0 [overflow-wrap:anywhere]">Alpha, the long-running reviewer of the checkout</Text>
            </Bar>
          </div>
        </Case>
        <Case label="inspector panel">
          <PanelFrame>
            <PanelTools>
              <PanelFilter value={filter} placeholder="Filter changes" onChange={setFilter} />
            </PanelTools>
            <PanelBody>
              <GroupLine left="Today" right="2" />
              <PanelRow title="src/app.ts" sub="Modified" selected trail={<Counts added={4} removed={2} />} />
              <PanelRow mark={<RunDot />} title="Run checks" sub="In progress" />
            </PanelBody>
            <PanelFooter left="2 changes" right="Running" />
          </PanelFrame>
        </Case>
        <Case label="panel blocks">
          <Section variant="panel" className="w-full">
            <Card variant="flush">
              <CardViewport size="editor" className="h-24">
                <PatchHeader level="block"><CodeText>src/app.ts</CodeText></PatchHeader>
                <ToolPaneMessage>Block content reaches the card edge.</ToolPaneMessage>
              </CardViewport>
            </Card>
          </Section>
        </Case>
        <Case label="workbench chrome and drop target">
          <WorkbenchCanvas className="relative flex h-56 w-full overflow-hidden">
            <WorkbenchRail data-floating className="w-28 p-3">Rail</WorkbenchRail>
            <ResizeHandle appearance="line" orientation="vertical" value={0.35} onChange={() => {}} />
            <PaneSurface className="relative flex-1 p-3">
              Pane
              <DockDropEdge area="bottom" className="absolute inset-x-0 bottom-0">
                <DockDropTarget active label="Dock in Bottom" />
              </DockDropEdge>
            </PaneSurface>
            <WorkbenchScrim className="pointer-events-none absolute inset-0 opacity-20" />
          </WorkbenchCanvas>
        </Case>
      </div>
      <Rule>
        A tool owns one frame whether it is freestanding or fills a dock. Inspectors use the same
        row, filter, state and facts roles, so selection remains a fill and running remains a dot.
      </Rule>
    </>
  )
}

const sideBySideState = (count: 2 | 4): SideBySideState => {
  const tiles = SIDE_BY_SIDE_KEYS.slice(0, count)
  return { ...emptySideBySide(), tiles, focused: tiles[1] ?? tiles[0] ?? null, seen: tiles }
}

const SideBySideBoard = () => {
  const [two, setTwo] = useState(() => sideBySideState(2))
  const [four, setFour] = useState(() => sideBySideState(4))
  const [narrow, setNarrow] = useState(() => sideBySideState(4))
  const [waiting, setWaiting] = useState(() => sideBySideState(2))
  const [waitingTabs, setWaitingTabs] = useState(() => sideBySideState(4))
  const plainStore = useMemo(() => sideBySideStore({ noGoal: true }), [])
  const waitingStore = useMemo(() => sideBySideStore({ noGoal: true, waiting: true }), [])
  const statesStore = useMemo(() => sideBySideStore({ noGoal: true, working: true, stopped: true, ready: true }), [])
  const memberOf = (key: (typeof SIDE_BY_SIDE_KEYS)[number]) => {
    const member = SIDE_BY_SIDE_MEMBERS[SIDE_BY_SIDE_KEYS.indexOf(key)]
    return member ? { nickname: member.nickname, agent: member.agent, model: member.model } : undefined
  }
  const entryOf = (store: AppStore, key: (typeof SIDE_BY_SIDE_KEYS)[number]) => {
    const snapshot = store.getSnapshot()
    const session = snapshot.sessions.get(key)
    if (!session) return null
    return sideBySideTileEntry({
      tint: runtimeTint(session.runtime, snapshot.accountsByRuntime, snapshot.accountPrefs),
      // Public catalogue frames keep agent marks neutral even when the staged
      // fixture uses runtime IDs internally to resolve the conversation.
      brand: null,
      busy: isBusy(session),
      waitingForYou: snapshot.approvals.some((approval) => approval.key === key),
      ceiling: seatCeilingOf(session.settings, [], session.runtime, session.id),
      lastTurnStatus: session.turns.at(-1)?.status,
    })
  }
  const grid = (
    state: SideBySideState,
    onChange: Dispatch<SetStateAction<SideBySideState>>,
    paneId: string,
    store: AppStore,
    widthClass = 'h-96 w-full min-w-0',
  ) => (
    <StoreProvider store={store}>
      <div className={widthClass}>
        <SideBySide
          state={state}
          onChange={onChange}
          paneId={paneId}
          memberOf={memberOf}
          entryOf={(key) => entryOf(store, key)}
          onOpenMember={() => {}}
          conversationProps={{ onChooseProject: () => {}, onSignIn: () => {}, onOpenUsage: () => {}, onOpenRuntimes: () => {} }}
        />
      </div>
    </StoreProvider>
  )
  return (
    <>
      <div className={styles.matrix}>
        <Case label="room rail — Side by side · disabled with its reason">
          <div className="w-full max-w-80">
            <ListRows>
              <ListRow
                as="button"
                size="sm"
                nav
                aria-disabled="true"
                title="Side by side"
                subtitle="Watch a member to put it here"
                lead={<IconTile size="sm" tint="violet"><TeamIcon /></IconTile>}
              />
            </ListRows>
          </div>
        </Case>
        <Case className="col-span-full" label="room — Side by side · two members, grid without a composer">{grid(two, setTwo, 'catalog-side-by-side-two', plainStore)}</Case>
        <Case className="col-span-full" label="room — Side by side · two members, waiting for you">{grid(waiting, setWaiting, 'catalog-side-by-side-waiting', waitingStore)}</Case>
        <Case className="col-span-full" label="room — Side by side · four members, tile states and ceiling">{grid(four, setFour, 'catalog-side-by-side-four', statesStore)}</Case>
        <Case label="room — Side by side · narrow tabs">
          {grid(narrow, setNarrow, 'catalog-side-by-side-narrow', plainStore, 'h-96 w-100 max-w-full')}
        </Case>
        <Case className="col-span-2" label="room — Side by side · narrow tabs with a waiting mark">
          {grid(waitingTabs, setWaitingTabs, 'catalog-side-by-side-waiting-tabs', waitingStore, 'h-144 w-80 max-w-full')}
        </Case>
      </div>
      <Rule>A room keeps the members you chose as tiles. Width changes the arrangement; focus stays visible in the tile header.</Rule>
    </>
  )
}

// --- input ------------------------------------------------------------------

const FieldBoard = () => (
  <>
    <Specimen measure="page" caption="InputGroup addons, and Field wiring a hint or an error to its control">
    <div
      className={styles.stack}
      style={{ maxWidth: 420 }}
      data-catalog-variants={INPUT_GROUP_CATALOG_VARIANTS.join(' ')}
      data-catalog-sizes={INPUT_GROUP_CATALOG_SIZES.join(' ')}
      data-catalog-states={INPUT_GROUP_CATALOG_STATES.join(' ')}
      data-catalog-align={INPUT_GROUP_CATALOG_ALIGN.join(' ')}
    >
      {INPUT_GROUP_CATALOG_ALIGN.map((align) => (
        <InputGroup key={align}>
          <InputGroupAddon align={align} data-catalog-align={align}>{align}</InputGroupAddon>
          <InputGroupInput aria-label={`${align} input group`} defaultValue="Value" />
        </InputGroup>
      ))}
      <Field label="Repository" required hint="A local checkout. Worktrees are fine.">
        {(control) => (
          <InputGroup>
            <InputGroupAddon align="inline-start">~/code</InputGroupAddon>
            <InputGroupInput {...control} defaultValue="harnessdesk" />
            <InputGroupAddon align="inline-end">
              Browse
            </InputGroupAddon>
          </InputGroup>
        )}
      </Field>
      <Field label="Branch" error="That branch has uncommitted changes in another worktree.">
        {(control) => (
          <InputGroup>
            <InputGroupAddon align="inline-start">
              <BranchIcon />
            </InputGroupAddon>
            <InputGroupInput {...control} defaultValue="main" />
          </InputGroup>
        )}
      </Field>
      <Field label="Idle timeout" layout="inline" hint="Zero never times out.">
        {(control) => (
          <InputGroup className="w-40">
            <InputGroupInput {...control} defaultValue="30" inputMode="numeric" />
            <InputGroupAddon align="inline-end">minutes</InputGroupAddon>
          </InputGroup>
        )}
      </Field>
      <Field label="Command" hint="Block affixes remain part of the same field contract.">
        {(control) => (
          <InputGroup>
            <InputGroupAddon align="block-start">Shell</InputGroupAddon>
            <InputGroupInput {...control} defaultValue="pnpm verify" />
            <InputGroupAddon align="block-end">Runs in the project root</InputGroupAddon>
          </InputGroup>
        )}
      </Field>
    </div>
    </Specimen>
    <Rule>
      The error replaces the hint rather than stacking under it — the hint said what to type, and the
      reader now knows, because they typed it and it was wrong. <code>Field</code> wires{' '}
      <code>aria-describedby</code> and <code>aria-invalid</code> itself, because that is exactly the
      attribute written on a project&rsquo;s first form and none of the next twelve.
    </Rule>
  </>
)

const StepperBoard = () => {
  const [current, setCurrent] = useState(1)
  return (
    <>
      <Specimen measure="page" caption="Stepper, horizontal and vertical, driven by one current step">
      <div className={styles.stack} style={{ maxWidth: 560 }}>
        <Stepper steps={SETUP_STEPS} current={current} />
        <div className={styles.caseBody}>
          <Button variant="outline" size="sm" onClick={() => setCurrent((n) => Math.max(0, n - 1))}>
            Back
          </Button>
          <Button
            size="sm"
            onClick={() => setCurrent((n) => Math.min(SETUP_STEPS.length, n + 1))}
          >
            Next
          </Button>
        </div>
        <Stepper steps={SETUP_STEPS} current={current} orientation="vertical" />
      </div>
      </Specimen>
      <Rule>
        Worth drawing only when the steps are ordered, cannot be skipped, and the number remaining
        changes whether someone starts. Done steps show a tick rather than their number: once a step
        is behind you, its position is not the fact you want.
      </Rule>
    </>
  )
}

const EmptyBoard = () => (
  <>
    <div className={styles.stack} style={{ maxWidth: 560 }}>
      <Section>
        <SectionBody>
          <EmptyState
            icon={<AgentIcon />}
            title="No agent on this workspace"
            description="Pick where the first session should run. You can add the rest later."
            footer="Nothing is written to the repo until you approve it."
          >
            <ChoiceRow
              icon={
                <IconTile tint="blue" size="lg" shape="round">
                  <AgentIcon />
                </IconTile>
              }
              title="Claude Code"
              description="Signed in · Opus 5 · 3 workspaces"
            />
            <ChoiceRow
              icon={
                <IconTile tint="violet" size="lg" shape="round">
                  <ExtensionIcon />
                </IconTile>
              }
              title="Add from the registry"
              description="Eleven agents speak ACP"
            />
          </EmptyState>
        </SectionBody>
      </Section>
      <Section>
        <SectionBody>
          <EmptyState tight icon={<SearchIcon />} title="No sessions match" description="Try a shorter query." />
        </SectionBody>
      </Section>
      <div className="flex flex-col gap-1">
        <Text role="meta">inline — inside a list, a column or a pane</Text>
        <div className="flex min-h-24 flex-col rounded-(--hd-radius-lg) bg-(--hd-muted) p-3">
          <EmptyState variant="inline" className="mt-auto" title="Nothing here" />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Text role="meta">row — one row of a Rows card</Text>
        <Rows>
          <EmptyState variant="row" title="No presets yet" description="Set a session up the way you like, then save it here." />
        </Rows>
        <Rows>
          <EmptyState
            variant="row"
            icon={<SearchIcon size={15} />}
            title="Nothing here matches “retry”"
            description="Search covers the name, the opening message and the folder."
          />
        </Rows>
      </div>
      {/* The conversation pane's own two shapes, exactly as Conversation.tsx
          mounts them: a title over a sentence, and the loading row. */}
      <div className="flex flex-col gap-1">
        <Text role="meta">conversation pane — a column, and the loading row</Text>
        <div className="flex h-48 rounded-(--hd-radius-lg) border border-(--hd-border)">
          <ConversationEmptyState data-catalog-variant="column">
            <Text as="div" role="page" weight="medium">What should we build?</Text>
            <Text as="p" role="prose" className="m-0">
              Describe what you want done in harnessdesk.
            </Text>
          </ConversationEmptyState>
        </div>
        <div className="flex h-32 rounded-(--hd-radius-lg) border border-(--hd-border)">
          <ConversationEmptyState row data-catalog-variant="row">
            <Spinner size="sm" tone="brand" />
            <Text role="prose" ink="muted">Loading transcript…</Text>
          </ConversationEmptyState>
        </div>
      </div>
    </div>
    <Rule>
      An empty state is a menu, not an apology: it takes the space the missing content would have
      occupied and spends it saying what could fill it. On a <code>ChoiceRow</code> the second line
      is always earned — the reader is choosing between options whose names cannot tell them apart.
      Three shapes, one per place: <code>panel</code> owns a page or pane, <code>inline</code> is one
      muted line in a list or column, <code>row</code> is a quiet row in a card. A navigation tree
      never carries one under a node, and when the header already holds the primary action the empty
      state&apos;s own action is secondary.
    </Rule>
  </>
)

// --- the board --------------------------------------------------------------

const KanbanBoard = () => {
  const [tinted, setTinted] = useState(true)
  return (
    <>
      <Toolbar className="mb-3">
        <Button
          size="sm"
          variant={tinted ? 'default' : 'outline'}
          onClick={() => setTinted((on) => !on)}
        >
          Column tint {tinted ? 'on' : 'off'}
        </Button>
      </Toolbar>
      <Board>
        {COLUMNS.map((column) => (
          <BoardColumn
            key={column.id}
            title={column.title}
            count={column.tasks.length}
            tint={tinted ? column.tint : 'blue'}
            onAdd={() => undefined}
            addLabel="Add intent"
            actions={<BoardMenuButton />}
          >
            {column.tasks.map((task) => (
              <BoardCard
                key={task.id}
                title={task.title}
                assignees={task.assignees}
                priority={task.priority}
                tag={task.tag}
                attachments={task.attachments}
                comments={task.comments}
                actions={<BoardMenuButton />}
              />
            ))}
          </BoardColumn>
        ))}
      </Board>
      <Board derived className="mt-3">
        <BoardColumn title="No result" count={0} onAdd={() => undefined} />
      </Board>
      <Rule>
        A card&rsquo;s column is its state, so no card repeats it — every card says who has it, how
        urgent it is and how much conversation it has collected, and none of them says &ldquo;in
        progress&rdquo;. The columns take a <em>tint</em>, not a tone: a red &ldquo;Blocked&rdquo;
        column pushes every card in it into a verdict it has not earned, and a card sitting there
        three days starts to read as an incident. Only <code>priority</code> judges. Unassigned is
        said out loud, because an unassigned card and a card whose avatars failed to load look
        identical otherwise. A derived board reports facts and therefore offers no way to add or
        move one; its empty column says so without drawing a drop target.
      </Rule>
    </>
  )
}

// --- charts -----------------------------------------------------------------

const SparkBoard = () => (
  <>
    <div className={styles.matrix}>
      <Case label="sparkline, with area">
        <Sparkline values={SESSIONS_TREND} tint="blue" />
      </Case>
      <Case label="two series share a frame — no area">
        <div className="relative w-full">
          <Sparkline values={SESSIONS_TREND} tint="blue" area={false} />
          <Sparkline
            values={SPEND_BY_DAY}
            tint="orange"
            area={false}
            className="absolute inset-0"
          />
        </div>
      </Case>
      <Case label="bars, one highlighted">
        <Bars values={SPEND_BY_DAY} tint="teal" highlight={8} />
      </Case>
      <Case label="donut, with the total in the hole">
        <Donut
          slices={[
            { label: 'Claude Code', value: 46, tint: 'blue' },
            { label: 'Codex', value: 28, tint: 'teal' },
            { label: 'Cursor', value: 17, tint: 'violet' },
            { label: 'DSH', value: 9, tint: 'orange' },
          ]}
          size={104}
        >
          <div className="text-base font-semibold tabular-nums">100</div>
        </Donut>
      </Case>
      <Case label="ticks — a strip index, the asked and the answered">
        <div className="flex w-10 flex-col gap-2">
          <Tick emphasis="strong" className="w-3" />
          <Tick className="w-2" />
          <Tick emphasis="strong" className="w-5" />
          <Tick className="w-2" />
        </div>
      </Case>
    </div>
    <Rule>
      Not a charting library and not trying to be one: no axes, no legend, no dependency. The job is
      the one a full chart does badly — sitting next to a figure and showing its shape, so a number
      gains &ldquo;and it dipped in March&rdquo; without costing a second card. Series take a tint,
      because a line is not green because things are going well.
    </Rule>
  </>
)


const CHART_SERIES = [
  { key: 'claude', label: 'Claude Code', tint: 'blue' as const },
  { key: 'codex', label: 'Codex', tint: 'teal' as const },
]

const CHART_DAYS = [18, 24, 0, 0, 31, 44, 29, 52, 38, 0, 41, 63, 47, 35].map((total, index) => ({
  label: `Day ${index + 1}`,
  total,
  parts: [total * 0.72, total * 0.28],
}))

/**
 * The same fourteen days, with the first two before the ledger's own
 * coverage — hatched rather than a priced zero — and a dashed ghost line for
 * the fourteen days before that, aligned by day index rather than calendar
 * day (`lib/ledger.ts`'s `alignGhost`).
 */
const CHART_DAYS_WITH_GAP = CHART_DAYS.map((bucket, index) => ({
  ...bucket,
  unknown: index < 2,
}))
const CHART_GHOST = [12, 19, 9, 6, 27, 39, 24, 46, 33, 8, 36, 55, 41, 30]
const CHART_TICKS: readonly [number, number, number] = [0, 32, 63]

/**
 * "When it ran"'s own board — the same `HeatGrid`/`HeatLegend` the Dashboard
 * mounts, fed hand-built ledgers rather than a live store: this page loads
 * with no store at all (`main.tsx`), the same boundary that keeps every
 * whole-screen surface behind a lazy split. The Dashboard's own board is
 * `surface.dashboard`, which mounts the real `Usage` (and so the real
 * `UsageActivity` band, live) once opened — this board exists for the piece
 * that band is built from.
 */
const HEAT_NOW = new Date('2026-09-20T12:00:00').getTime()
const HEAT_CLAUDE = runtimeId('claude')
const HEAT_CODEX = runtimeId('codex')

const heatLedger = ({ days, notScanned = 0, unpricedDay = false }: { days: number; notScanned?: number; unpricedDay?: boolean }): LedgerReport => {
  const midnight = new Date(HEAT_NOW)
  midnight.setHours(0, 0, 0, 0)
  const start = midnight.getTime()
  const daily: LedgerDay[] = []
  for (let index = days - 1; index >= 0; index -= 1) {
    if (index >= days - notScanned) continue
    const date = new Date(start)
    date.setDate(date.getDate() - index)
    const day = date.getTime()
    const weekend = [0, 6].includes(date.getDay())
    if (weekend && index % 3 !== 0) continue
    const wobble = 0.5 + ((index * 37) % 100) / 100
    const swell = index === 4 ? 3 : 1
    daily.push({ day, runtime: HEAT_CLAUDE, cost: unpricedDay && index === 2 ? 0 : 6 * wobble * swell, tokens: 520_000 * wobble * swell })
    if (index % 2 === 0) daily.push({ day, runtime: HEAT_CODEX, cost: 1.6 * wobble, tokens: 140_000 * wobble })
  }
  return {
    days,
    currency: 'USD',
    totalCost: daily.reduce((sum, entry) => sum + entry.cost, 0),
    totalTokens: daily.reduce((sum, entry) => sum + entry.tokens, 0),
    provenance: 'listPrice',
    coverage: { priced: daily.length, unpriced: unpricedDay ? 1 : 0, unmetered: 0, estimated: 0, daysCovered: days - notScanned, daysRequested: days },
    rows: [],
    daily,
    scannedAt: HEAT_NOW,
  } as LedgerReport
}

/** The year grid, transposed from `buildYearGrid`'s weeks-of-weekdays into `HeatGrid`'s rows-of-weeks. */
const heatYearRows = (ledger: LedgerReport | null, metric: HeatMetric): { rows: HeatGridRow[]; columns: number } => {
  const grid = buildYearGrid(ledger, HEAT_NOW)
  const levelOf = yearLevels(grid.weeks.flatMap((week) => week.filter((cell): cell is HeatCell => cell !== null)), metric)
  const rows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((name, weekday) => ({
    key: name,
    cells: grid.weeks.map((week) => {
      const cell = week[weekday]
      return cell ? toGridCell(cell, metric, levelOf) : null
    }),
  }))
  return { rows, columns: grid.weeks.length }
}

const heatAgentRows = (ledger: LedgerReport | null, metric: HeatMetric, byId: Readonly<Record<string, string>>): { rows: HeatGridRow[]; columns: number } => {
  const cells = buildYearGrid(ledger, HEAT_NOW).weeks.slice(-13).flatMap((week) => week.filter((cell): cell is HeatCell => cell !== null))
  const agentRows = buildAgentRows(cells, metric)
  const levelOf = agentLevels(agentRows, metric)
  const rows = agentRows.map((row) => ({
    key: String(row.runtime),
    header: <Text role="meta">{byId[String(row.runtime)] ?? String(row.runtime)}</Text>,
    cells: row.cells.map((cell) => toGridCell(cell, metric, levelOf, { rowKey: String(row.runtime) })),
  }))
  return { rows, columns: cells.length / 7 }
}

const heatHourRows = (ledger: LedgerReport): { rows: HeatGridRow[]; columns: number; columnLabels: { index: number; label: string }[] } => {
  const grid = buildHourGrid(ledger, 'tokens')
  return {
    rows: grid.cells.map((cells, weekday) => ({
      key: WEEKDAY_NAMES[weekday] ?? String(weekday),
      header: [0, 2, 4].includes(weekday) ? <Text role="meta">{WEEKDAY_NAMES[weekday]?.slice(0, 3)}</Text> : undefined,
      cells: cells.map((cell) => toHourGridCell(cell, grid.levelOf)),
    })),
    columns: 24,
    columnLabels: [
      { index: 0, label: '12a' },
      { index: 6, label: '6a' },
      { index: 12, label: '12p' },
      { index: 18, label: '6p' },
    ],
  }
}

const heatHourLedger = (): LedgerReport => ({
  ...heatLedger({ days: 365, notScanned: 40 }),
  hourly: Array.from({ length: 7 * 24 }, (_, index) => {
    const weekday = Math.floor(index / 24)
    const hour = index % 24
    const daytime = hour >= 9 && hour < 19
    const weekend = weekday === 0 || weekday === 6
    const factor = (weekend ? 0.25 : 1) * (daytime ? 1 : 0.22) * (0.65 + ((index * 31) % 35) / 100)
    return [
      { runtime: HEAT_CLAUDE, weekday, hour, requests: Math.round(36 * factor), tokens: Math.round(2_100_000 * factor) },
      { runtime: HEAT_CODEX, weekday, hour, requests: Math.round(19 * factor), tokens: Math.round(1_050_000 * factor) },
    ]
  }).flat(),
  coverage: {
    ...heatLedger({ days: 365, notScanned: 40 }).coverage,
    hoursKnownFor: [HEAT_CLAUDE, HEAT_CODEX],
  },
})

const HEAT_AGENT_NAMES: Readonly<Record<string, string>> = { [String(HEAT_CLAUDE)]: 'Claude Code', [String(HEAT_CODEX)]: 'Codex' }

const heatLevelTitle = (level: 0 | 1 | 2 | 3 | 4): string => (level === 0 ? 'Nothing' : `Level ${level} of 4`)

const ChartKitBoard = () => {
  const heatNoData = heatYearRows(null, 'tokens')
  const heatOneDay = heatYearRows(heatLedger({ days: 30, notScanned: 29 }), 'tokens')
  const heatFullYear = heatYearRows(heatLedger({ days: 365, notScanned: 40 }), 'tokens')
  const heatByAgent = heatAgentRows(heatLedger({ days: 365, notScanned: 40 }), 'tokens', HEAT_AGENT_NAMES)
  const heatByHour = heatHourRows(heatHourLedger())
  const heatCostUnpriced = heatYearRows(heatLedger({ days: 60, unpricedDay: true }), 'cost')

  return (
  <>
    <div className={styles.matrix}>
      <Case label="what is left — a countable budget">
        <div className="flex w-full flex-col gap-2">
          <SegmentMeter percent={64} label="Weekly" />
          <SegmentMeter percent={12} tone="warning" label="Weekly, low" />
          <SegmentMeter percent={0} tone="danger" label="Weekly, spent" />
          <SegmentMeter percent={null} label="Never reported" />
        </div>
      </Case>
      <Case label="a distribution — one continuous share, not a budget">
        <div className="w-full">
          <SegmentMeter
            label="Where it went, by share"
            parts={[
              { key: 'claude', tint: 'blue', value: 46 },
              { key: 'codex', tint: 'teal', value: 28 },
              { key: 'cursor', tint: 'violet', value: 17 },
              { key: 'other', tint: 'orange', value: 9 },
            ]}
          />
        </div>
      </Case>
      <Case label="will it last — actual against an even burn">
        <div className="w-full">
          <BurnDown
            elapsed={0.55}
            left={12}
            projectedAt={0.61}
            projectedLeft={0}
            tone="warning"
            label="Weekly: 12% left with 45% of the window to go"
          />
          <ChartAxis start="Sep 2" end="Sep 9" now={0.55} />
        </div>
      </Case>
      <Case label="a pace, as a standing rather than a sentence">
        <div className="flex flex-wrap items-center gap-2">
          <PaceBadge status="conserving" margin={14} word="conserving" />
          <PaceBadge status="onPace" margin={1} word="on pace" />
          <PaceBadge status="overPace" margin={-33} word="over pace" tone="warning" />
          <PaceBadge status="spent" word="spent" tone="danger" />
        </div>
      </Case>
    </div>
    <div className={styles.matrix}>
      <Case label="a quantity per day, split by whoever spent it">
        <ChartFrame className="w-full">
          <ChartCard>
            <ChartHead>
              <div>
                <ChartTitle>$1,450</ChartTitle>
                <ChartHint>Last 14 days — hover or use ← → to read a day.</ChartHint>
              </div>
            </ChartHead>
            <div className="mt-3">
              <DayColumns
                buckets={CHART_DAYS}
                series={CHART_SERIES}
                format={(value) => `$${value.toFixed(2)}`}
                label="Spend per day"
              />
              <ChartAxis start="Aug 24" end="Sep 6" />
              <ChartKeys>
                {CHART_SERIES.map((entry) => (
                  <ChartKey key={entry.key} tint={entry.tint} label={entry.label} />
                ))}
              </ChartKeys>
            </div>
          </ChartCard>
          <ChartFoot>List-price equivalent · 146.6M tokens · 22 of 30 days scanned</ChartFoot>
        </ChartFrame>
      </Case>
    </div>
    <div className={styles.matrix}>
      <Case label="bars — a ghost line for the previous period, and two days before coverage">
        <ChartFrame className="w-full">
          <ChartCard>
            <ChartHead>
              <div>
                <ChartTitle>$465</ChartTitle>
                <ChartHint>Last 14 days — hover or use ← → to read a day.</ChartHint>
              </div>
            </ChartHead>
            <div className="mt-3">
              <DayColumns
                buckets={CHART_DAYS_WITH_GAP}
                series={CHART_SERIES}
                format={(value) => `$${value.toFixed(2)}`}
                label="Spend per day"
                ghost={CHART_GHOST}
                today={CHART_DAYS_WITH_GAP.length - 1}
                axisTicks={CHART_TICKS}
              />
              <ChartAxis start="Aug 24" end="Sep 6" />
              <ChartKeys>
                {CHART_SERIES.map((entry) => (
                  <ChartKey key={entry.key} tint={entry.tint} label={entry.label} />
                ))}
              </ChartKeys>
            </div>
          </ChartCard>
        </ChartFrame>
      </Case>
      <Case label="line — the same window, one area line and its ghost">
        <ChartFrame className="w-full">
          <ChartCard>
            <ChartHead>
              <div>
                <ChartTitle>$465</ChartTitle>
                <ChartHint>Last 14 days, as a line rather than stacked columns.</ChartHint>
              </div>
            </ChartHead>
            <div className="mt-3">
              <DayColumns
                buckets={CHART_DAYS_WITH_GAP}
                series={CHART_SERIES}
                format={(value) => `$${value.toFixed(2)}`}
                label="Spend per day"
                mode="line"
                ghost={CHART_GHOST}
                today={CHART_DAYS_WITH_GAP.length - 1}
                axisTicks={CHART_TICKS}
              />
              <ChartAxis start="Aug 24" end="Sep 6" />
            </div>
          </ChartCard>
        </ChartFrame>
      </Case>
    </div>
    <div className={styles.matrix}>
      <Case label="a calendar heatmap — no data, one day, a not-scanned stretch">
        <div className="flex flex-col gap-3">
          <HeatGrid label="No data" rows={heatNoData.rows} columns={heatNoData.columns} minCellPx={5} />
          <HeatGrid label="One day" rows={heatOneDay.rows} columns={heatOneDay.columns} minCellPx={5} />
        </div>
      </Case>
      <Case label="a full year">
        <div className="w-full">
          <HeatGrid label="A year" rows={heatFullYear.rows} columns={heatFullYear.columns} minCellPx={5} />
          <div className="mt-2">
            <HeatLegend levelTitle={heatLevelTitle} />
          </div>
        </div>
      </Case>
    </div>
    <div className={styles.matrix}>
      <Case label="by agent — one row each, sorted by total">
        <HeatGrid label="By agent" rows={heatByAgent.rows} columns={heatByAgent.columns} minCellPx={7} />
      </Case>
      <Case label="cost, with a day the ledger can't price">
        <HeatGrid label="Cost, unpriced day included" rows={heatCostUnpriced.rows} columns={heatCostUnpriced.columns} minCellPx={5} />
      </Case>
    </div>
    <div className={styles.matrix}>
      <Case label="by hour — local weekday and hour">
        <div className="flex w-full flex-col gap-3">
          <HeatGrid
            label="Tokens by local weekday and hour"
            rows={heatByHour.rows}
            columns={heatByHour.columns}
            columnLabels={heatByHour.columnLabels}
            minCellPx={7}
          />
          <HeatLegend levelTitle={heatLevelTitle} showNotScanned={false} />
        </div>
      </Case>
      <Case label="no hourly data">
        <EmptyState tight title="No hours recorded yet" />
      </Case>
    </div>
    <Rule>
      The other size of chart: the one that is the subject of its own panel. The frame is a hairline
      round a 3px gutter of the muted ground, so the header and the axis sit visibly outside the
      plotting area rather than on one continuous surface. Every mark takes plain numbers — the
      arithmetic lives in <code>lib/</code> and is tested without a browser. A meter takes a{' '}
      <em>tone</em> because &ldquo;12% left&rdquo; is a claim about condition; a series takes a{' '}
      <em>tint</em> because &ldquo;which agent&rdquo; identifies and does not judge. Two rules the
      marks hold that no token can: a meter fills with what is <em>left</em>, and a figure nobody
      reported is drawn hollow rather than as zero.
    </Rule>
    <Rule>
      <code>DayColumns</code> draws either shape from the same props: stacked bars, or one accent
      area line, both able to carry a dashed ghost line for the previous period (index-aligned,
      broken rather than bridged across a gap the ledger cannot answer for), an emphasised marker
      on today, and the same hatch the calendar heatmap uses for a day before its own coverage —
      never an empty, priced day. An optional three-tick y-axis scales either mode to a round
      ceiling instead of the tallest bar, so a bar is never drawn touching the frame as though it
      were clipped. <code>SegmentMeter</code>'s <code>parts</code> mode is the same 10px bar drawn
      as a continuous <em>distribution</em> — &ldquo;which slice is biggest&rdquo; — rather than a
      countable budget: the Dashboard's &ldquo;Where it went&rdquo; reading, in place of a doughnut
      whose slice count this kit's own rule already limits.
    </Rule>
    <Rule>
      The calendar heatmap — <code>design/ui/heat-grid.tsx</code>, mounted as the Dashboard's
      &ldquo;When it ran&rdquo; band (<code>components/UsageActivity.tsx</code>, live on the Dashboard
      surface board) — levels its cells from the data's own quartiles rather than a fixed scale, so
      one outlier day cannot wash out the rest of the grid. Not-scanned and zero are drawn
      differently on purpose: a day before the ledger's earliest row is unknown, not empty, and with
      Cost selected a day whose tokens carry no public price reads the same honest way rather than as
      $0.
    </Rule>
  </>
  )
}

/**
 * The Overview strip (`components/usage/OverviewStrip.tsx`) — Paid, Value,
 * Turns and Tokens for the same 7/30/90-day window the Spend chart draws.
 * Mounted here as the production component, fed hand-built reports and a
 * ledger rather than a live store — the same boundary `ChartKitBoard`'s own
 * doc comment names: this page loads with no store at all (`main.tsx`), and
 * `OverviewStrip` never reaches for one, so the real component is the
 * fixture. `docs/usage-dashboard.md`, "The Overview strip".
 */
const STRIP_NOW = new Date('2026-09-20T18:00:00').getTime()
const STRIP_CLAUDE = runtimeId('claude')
const STRIP_CODEX = runtimeId('codex')

const stripLedger = ({
  range,
  turnsPartial = false,
}: {
  range: number
  turnsPartial?: boolean
}): LedgerReport => {
  const midnight = new Date(STRIP_NOW)
  midnight.setHours(0, 0, 0, 0)
  const daily: LedgerDay[] = []
  for (let index = 0; index < range; index += 1) {
    const day = midnight.getTime() - index * 86_400_000
    const claudeTurns = 3 + (index % 3)
    const codexTurns = 2 + (index % 2)
    daily.push({
      day,
      runtime: STRIP_CLAUDE,
      cost: 8 + (index % 5),
      tokens: 12_400 + index * 41,
      turns: turnsPartial ? undefined : claudeTurns,
      input: 6_200,
      output: 5_800,
      cacheRead: 14_100,
      cacheWrite: 240,
      requests: 6,
    })
    daily.push({
      day,
      runtime: STRIP_CODEX,
      cost: 5 + (index % 3),
      tokens: 9_100 + index * 29,
      turns: codexTurns,
      input: 4_300,
      output: 4_900,
      cacheRead: 9_050,
      cacheWrite: 110,
      requests: 4,
    })
  }
  const sum = (pick: (entry: LedgerDay) => number | undefined): number =>
    daily.reduce((total, entry) => total + (pick(entry) ?? 0), 0)
  const sumFor = (runtime: RuntimeId, pick: (entry: LedgerDay) => number | undefined): number =>
    daily
      .filter((entry) => entry.runtime === runtime)
      .reduce((total, entry) => total + (pick(entry) ?? 0), 0)
  // One row per runtime — real ledger rows, not `[]`, so `ledgerRuntimeIds`
  // (`lib/overview-strip.ts`) has something to name: the Turns and Tokens
  // captions both read the runtimes the ledger has *rows* for, not the
  // accounts in scope.
  const rows: LedgerRow[] = [STRIP_CLAUDE, STRIP_CODEX].map((runtime) => ({
    key: String(runtime),
    label: String(runtime),
    runtime,
    tokens: sumFor(runtime, (entry) => entry.tokens),
    cost: sumFor(runtime, (entry) => entry.cost),
    hasUnpriced: false,
  }))
  return {
    days: range,
    currency: 'USD',
    totalCost: sum((entry) => entry.cost),
    totalTokens: sum((entry) => entry.tokens),
    provenance: 'listPrice',
    coverage: {
      priced: daily.length,
      unpriced: 0,
      unmetered: 0,
      estimated: 0,
      daysCovered: range,
      daysRequested: range,
      earliestDay: midnight.getTime() - (range + 60) * 86_400_000,
      turnsKnownFor: turnsPartial ? [STRIP_CLAUDE] : [STRIP_CLAUDE, STRIP_CODEX],
    },
    rows,
    daily,
    scannedAt: STRIP_NOW,
    totals: {
      input: sum((entry) => entry.input),
      output: sum((entry) => entry.output),
      cacheRead: sum((entry) => entry.cacheRead),
      cacheWrite: sum((entry) => entry.cacheWrite),
      reasoning: 0,
      requests: sum((entry) => entry.requests),
      turns: turnsPartial ? undefined : sum((entry) => entry.turns),
    },
  }
}

const stripReport = (runtime: RuntimeId, account: string, billing?: UsageBilling): UsageReport => ({
  runtime,
  account,
  plan: 'Pro',
  lanes: [],
  credits: null,
  spend: null,
  reached: null,
  source: { kind: 'runtime', label: 'from its own cache' },
  fetchedAt: STRIP_NOW,
  staleAfterMs: 300_000,
  error: null,
  billing,
})

const MONTHLY_FEE = (amount: number, currency = 'USD'): UsageBilling => ({
  kinds: ['windows'],
  fee: { amount, currency, period: 'month', source: 'user' },
})

/** One case's own reports, ledger and (twice-as-wide) previous-period ledger. */
const StripCase = ({
  reports,
  ledger,
  range = 30,
}: {
  reports: readonly UsageReport[]
  ledger: LedgerReport | null
  range?: number
}) => {
  const [metric, setMetric] = useState<StripMetric>('value')
  const wideLedger = ledger ? stripLedger({ range: range * 2, turnsPartial: ledger.totals?.turns === undefined }) : null
  return (
    <OverviewStrip
      reports={reports}
      ledger={ledger}
      wideLedger={wideLedger}
      range={range}
      now={STRIP_NOW}
      metric={metric}
      onMetricChange={setMetric}
      onOpenPlan={() => {}}
    />
  )
}

const OverviewStripBoard = () => (
  <>
    <div className={styles.matrix}>
      <Case label="every account priced — Paid, Value, Turns and Tokens all known">
        <StripCase
          reports={[
            stripReport(STRIP_CLAUDE, 'work', {
              ...MONTHLY_FEE(20),
              overage: { enabled: true, spent: 4.2, currency: 'USD' },
            }),
            stripReport(STRIP_CODEX, 'work', MONTHLY_FEE(20)),
          ]}
          ledger={stripLedger({ range: 30 })}
        />
      </Case>
      <Case label="fee not set for one of two accounts">
        <StripCase
          reports={[
            stripReport(STRIP_CLAUDE, 'work', MONTHLY_FEE(20)),
            stripReport(STRIP_CODEX, 'work', { kinds: ['windows'] }),
          ]}
          ledger={stripLedger({ range: 30 })}
        />
      </Case>
    </div>
    <div className={styles.matrix}>
      <Case label="no account has a fee set — Paid reads “—”">
        <StripCase
          reports={[
            stripReport(STRIP_CLAUDE, 'work', { kinds: ['windows'] }),
            stripReport(STRIP_CODEX, 'work', { kinds: ['windows'] }),
          ]}
          ledger={stripLedger({ range: 30 })}
        />
      </Case>
      <Case label="turns known for only one of two agents">
        <StripCase
          reports={[
            stripReport(STRIP_CLAUDE, 'work', MONTHLY_FEE(20)),
            stripReport(STRIP_CODEX, 'work', MONTHLY_FEE(20)),
          ]}
          ledger={stripLedger({ range: 30, turnsPartial: true })}
        />
      </Case>
    </div>
    <div className={styles.matrix}>
      <Case label="two accounts, two currencies — the main one leads, the other is named">
        <StripCase
          reports={[
            stripReport(STRIP_CLAUDE, 'work', MONTHLY_FEE(20, 'USD')),
            stripReport(STRIP_CODEX, 'eu', MONTHLY_FEE(18, 'EUR')),
          ]}
          ledger={stripLedger({ range: 30 })}
        />
      </Case>
      <Case label="nothing scanned yet — every figure is “—”, never $0">
        <StripCase
          reports={[stripReport(STRIP_CLAUDE, 'work', MONTHLY_FEE(20)), stripReport(STRIP_CODEX, 'work', MONTHLY_FEE(20))]}
          ledger={null}
        />
      </Case>
    </div>
    <div className={styles.matrix}>
      <Case label="Value costs less than Paid — the ×paid chip is amber, never green">
        <StripCase
          reports={[
            stripReport(STRIP_CLAUDE, 'work', MONTHLY_FEE(260)),
            stripReport(STRIP_CODEX, 'work', MONTHLY_FEE(260)),
          ]}
          ledger={stripLedger({ range: 30 })}
        />
      </Case>
      <Case label="overage spent this cycle, shown beside Paid rather than folded in">
        <StripCase
          reports={[
            stripReport(STRIP_CLAUDE, 'work', {
              ...MONTHLY_FEE(20),
              overage: { enabled: true, spent: 50, currency: 'USD' },
            }),
            stripReport(STRIP_CODEX, 'work', MONTHLY_FEE(20)),
          ]}
          ledger={stripLedger({ range: 30 })}
        />
      </Case>
    </div>
    <Rule>
      Every figure here comes from the real <code>OverviewStrip</code>, fed the same
      <code>LedgerReport</code>/<code>UsageReport</code> shapes <code>Usage.tsx</code> loads — nothing on this board
      is redrawn by hand. Paid is never $0 for an account with no fee set: it is left out of the sum and
      counted in the caption instead (&ldquo;fee not set for N&rdquo;, linking to that account's own Plan
      card), and the figure itself reads &ldquo;—&rdquo; only when <em>no</em> account in scope has one. Paid
      carries no delta of its own — there is no billing history yet to compare a past Paid against — and
      overage spent this cycle is folded into the figure only when its own cycle started at or after the
      window opened; otherwise it is named beside the figure (&ldquo;+ $50 overage this cycle&rdquo;),
      never dropped. Value's ratio and Turns' per-turn price against Paid only appear when every account
      in scope has a fee, in one currency, matching the ledger's own — otherwise Value falls back to a
      plain per-day average and Turns to its own coverage caption, and the ratio chip is neutral at 1× or
      above and amber below it, never green (there is no state this figure calls good news). Value, Turns
      and Tokens are also a <code>ToggleGroup</code>: clicking one switches the Spend chart below between
      cost, turns and tokens per day (<code>lib/ledger.ts</code>'s <code>stackDailyMetric</code>).
    </Rule>
  </>
)

// --- what the registry brought ---------------------------------------------

const AdoptedBoard = () => {
  const [ratio, setRatio] = useState(0.55)
  const rows = [
    { id: 'a', session: 'Migrate the auth callers', agent: 'Claude Code', spend: 84 },
    { id: 'b', session: 'Integration tests', agent: 'Codex', spend: 41 },
    { id: 'c', session: 'Release notes', agent: 'Cursor', spend: 12 },
  ]
  const compare = {
    session: (x: (typeof rows)[number], y: (typeof rows)[number]) => x.session.localeCompare(y.session),
    spend: (x: (typeof rows)[number], y: (typeof rows)[number]) => x.spend - y.spend,
  }
  const { sort, toggle, sorted } = useTableSort(rows, compare)
  const pick = useTableSelection(rows.map((one) => one.id))
  const [theme, setTheme] = useState('system')

  return (
    <>
      <div
        className={styles.matrix}
        data-marker-catalog-variants={MARKER_CATALOG_VARIANTS.join(' ')}
        data-marker-catalog-sizes={MARKER_CATALOG_SIZES.join(' ')}
        data-marker-catalog-states={MARKER_CATALOG_STATES.join(' ')}
      >
        <Case label="marker &mdash; three variants, was one">
          <div className="flex w-full flex-col">
            {MARKER_CATALOG_VARIANTS.map((variant) => (
              <Marker key={variant} variant={variant} data-catalog-variant={variant}>
                <MarkerIcon>{variant === 'border' ? <FolderIcon /> : <BranchIcon />}</MarkerIcon>
                <MarkerContent>{variant === 'separator' ? 'Context compacted' : 'Explored 4 files'}</MarkerContent>
              </Marker>
            ))}
          </div>
        </Case>

        <Case label="breadcrumb">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href="#">harnessdesk</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbEllipsis />
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>tone.ts</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Case>

        <Case label="radio-group &mdash; arrows move between these">
          <RadioGroup value={theme} onValueChange={(next) => setTheme(String(next))} aria-label="Theme">
            {['system', 'light', 'dark'].map((one) => (
              <label key={one} className="flex items-center gap-2 text-base">
                <RadioGroupItem value={one} />
                {one}
              </label>
            ))}
          </RadioGroup>
        </Case>

        <Case label="resize handle &mdash; focus it, then arrow">
          <div className="flex h-16 w-full overflow-hidden rounded-(--hd-radius-sm) border border-(--hd-border)">
            <div
              className="grid place-items-center bg-(--hd-muted) text-xs text-(--hd-muted-foreground)"
              style={{ flexBasis: `${ratio * 100}%` }}
            >
              {Math.round(ratio * 100)}%
            </div>
            <ResizeHandle orientation="vertical" value={ratio} onChange={setRatio} />
            <div className="grid flex-1 place-items-center bg-(--hd-muted) text-xs text-(--hd-muted-foreground)">
              {Math.round((1 - ratio) * 100)}%
            </div>
          </div>
        </Case>

        <Case label="card &mdash; grouped content">
          <Card className="w-full" data-catalog-size="default">
            <CardHeader>
              <CardTitle>Catalog source</CardTitle>
              <CardDescription>The production card primitive, not copied markup.</CardDescription>
            </CardHeader>
            <CardContent>One border, one ground, one spacing contract.</CardContent>
          </Card>
          <Card variant="muted" className="w-full">
            <CardHeader>
              <CardTitle>No reading yet</CardTitle>
              <CardDescription>The object remains present without claiming a figure.</CardDescription>
            </CardHeader>
          </Card>
          <Card variant="flush" className="w-full">
            <CardHeader>
              <CardTitle>Content-owned rhythm</CardTitle>
              <CardDescription>A flush card lets a table or diff reach its edge.</CardDescription>
            </CardHeader>
          </Card>
          <Card radius="lg" className="w-full">
            <CardContent>Large-radius configuration surface.</CardContent>
          </Card>
          <Card variant="flush" radius="sm" className="w-full">
            <CardContent className="py-2">Small-radius code or diff plate.</CardContent>
          </Card>
          <Card spacing="compact" radius="sm" className="w-full" data-catalog-size="compact">
            A dense report keeps one inset and one rhythm.
          </Card>
          <Card variant="plate" spacing="compact" className="w-full">
            The app&rsquo;s own card: it follows the interface&rsquo;s card family, as the files card under an answer does.
          </Card>
          <Card variant="plate" spacing="flush" className="w-full">
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs">A dense transcript row: the plate&rsquo;s own surface, its gap and padding zeroed.</div>
          </Card>
        </Case>

        <Case label="select &mdash; open with pointer or keyboard">
          <Select defaultValue="desk">
            <SelectTrigger aria-label="Interface">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desk">Desk</SelectItem>
              <SelectItem value="studio">Studio</SelectItem>
            </SelectContent>
          </Select>
        </Case>

        <Case label="scroll area &mdash; real overflow">
          <ScrollArea className="h-20 w-full rounded-(--hd-radius-sm) border border-(--hd-border) p-2">
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index}>Recorded line {index + 1}</div>
            ))}
          </ScrollArea>
        </Case>

        <Case label="textarea &mdash; supported roles">
          <div className="grid w-full gap-2" data-catalog-states={TEXTAREA_CATALOG_STATES.join(' ')}>
            {TEXTAREA_CATALOG_VARIANTS.map((variant) => (
              <Textarea key={variant} variant={variant} data-catalog-variant={variant} controlSize={variant === 'composer' ? 'composer' : 'compact'} defaultValue={variant} aria-label={`${variant} textarea`} />
            ))}
            {TEXTAREA_CATALOG_SIZES.map((controlSize) => (
              <Textarea key={controlSize} controlSize={controlSize} data-catalog-size={controlSize} defaultValue={controlSize} aria-label={`${controlSize} textarea size`} />
            ))}
            <Textarea disabled defaultValue="disabled" aria-label="Disabled textarea" />
            <Textarea aria-invalid defaultValue="invalid" aria-label="Invalid textarea" />
          </div>
        </Case>

        <Case label="tooltip and toast &mdash; focusable help and transient status">
          <div className="flex flex-wrap gap-2">
            <HoverCard>
              <HoverCardTrigger render={<Button variant="outline">Preview details</Button>} />
              <HoverCardContent className="p-3">A richer, enterable preview rather than a repeated label.</HoverCardContent>
            </HoverCard>
            <Tooltip>
              <TooltipTrigger render={<Button variant="outline">Rest or focus</Button>} />
              <TooltipContent>This help is the real portal-backed tooltip.</TooltipContent>
            </Tooltip>
            <Button variant="secondary" onClick={() => toast.success('Catalog event delivered')}>Show toast</Button>
            <Toaster />
          </div>
        </Case>
      </div>

      <div
        className={styles.stack}
        style={{ maxWidth: 560, marginTop: 'var(--hd-space-4)' }}
        data-attachment-catalog-variants={ATTACHMENT_CATALOG_VARIANTS.join(' ')}
        data-attachment-catalog-sizes={ATTACHMENT_CATALOG_SIZES.join(' ')}
        data-attachment-catalog-states={ATTACHMENT_CATALOG_STATES.join(' ')}
        data-attachment-catalog-orientation={ATTACHMENT_CATALOG_ORIENTATION.join(' ')}
      >
        <div className={styles.caseLabel}>attachment &mdash; the states ours never had</div>
        <AttachmentGroup>
          {(
            [
              { state: 'done', title: 'review.png', note: 'PNG · 184 KB' },
              { state: 'uploading', title: 'trace.har', note: 'Uploading · 54%' },
              { state: 'processing', title: 'session.jsonl', note: 'Processing' },
              { state: 'error', title: 'legacy.ts', note: 'Too large — 24 MB of 8 MB' },
            ] as const
          ).map((one) => (
            <Attachment key={one.title} state={one.state} progress={54}>
              <AttachmentMedia />
              <AttachmentContent>
                <AttachmentTitle>{one.title}</AttachmentTitle>
                <AttachmentDescription>{one.note}</AttachmentDescription>
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction aria-label={`Remove ${one.title}`} />
              </AttachmentActions>
            </Attachment>
          ))}
        </AttachmentGroup>
        <Attachment orientation="vertical" size="lg" state="done">
          <AttachmentMedia />
          <AttachmentContent>
            <AttachmentTitle>portrait.png</AttachmentTitle>
            <AttachmentDescription>Vertical orientation</AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions>
            <AttachmentAction aria-label="Remove portrait.png" />
          </AttachmentActions>
        </Attachment>
        <AttachmentGroup>
          {ATTACHMENT_CATALOG_SIZES.map((size) => (
            <Attachment key={size} size={size} data-catalog-size={size} state="done">
              <AttachmentMedia />
              <AttachmentContent><AttachmentTitle>{size}</AttachmentTitle></AttachmentContent>
            </Attachment>
          ))}
        </AttachmentGroup>
        <AttachmentGroup>
          {ATTACHMENT_CATALOG_ORIENTATION.map((orientation) => (
            <Attachment key={orientation} orientation={orientation} data-catalog-orientation={orientation} state="done">
              <AttachmentMedia />
              {orientation !== 'tile' && (
                <AttachmentContent><AttachmentTitle>{orientation}</AttachmentTitle></AttachmentContent>
              )}
            </Attachment>
          ))}
        </AttachmentGroup>

        {/* AttachmentMedia `picture`: the img itself, no frame of its own, as
            the transcript and a draft draw an attached image. A lone picture
            taller than the cap stops at --hd-image-max-height; in a tile, it
            covers the tile. */}
        <div className={styles.caseLabel} style={{ marginTop: 'var(--hd-space-3)' }}>
          attachment media &mdash; picture, a lone one contained under --hd-image-max-height
        </div>
        <AttachmentMedia
          variant="picture"
          data-catalog-variant="picture"
          src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='900'%3E%3Crect width='600' height='900' fill='%23888'/%3E%3C/svg%3E"
          alt="Sample photo, taller than the cap"
        />
        <div className={styles.caseLabel} style={{ marginTop: 'var(--hd-space-3)' }}>
          attachment media &mdash; picture, fill: covering its tile, one of several
        </div>
        <div className="flex h-24 gap-(--hd-space-2)">
          {['%23888', '%23aaa'].map((fill, index) => (
            <div key={fill} className="w-32 overflow-hidden rounded-(--hd-radius-md)">
              <AttachmentMedia
                variant="picture"
                fill
                {...(index === 0 ? { 'data-catalog-variant': 'picture-fill' } : {})}
                src={`data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect width='400' height='300' fill='${fill}'/%3E%3C/svg%3E`}
                alt="Sample photo in a grid"
              />
            </div>
          ))}
        </div>

        <div className={styles.caseLabel} style={{ marginTop: 'var(--hd-space-3)' }}>
          data-table &mdash; press a heading, tick a row
        </div>
        <Section>
          <SectionBody inset={false} className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <DataTableSelectAll all={pick.all} some={pick.some} onCheckedChange={pick.toggleAll} />
                  </TableHead>
                  <TableHead>
                    <DataTableColumnHeader
                      direction={sort?.key === 'session' ? sort.direction : null}
                      onClick={() => toggle('session')}
                    >
                      Session
                    </DataTableColumnHeader>
                  </TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">
                    <DataTableColumnHeader
                      direction={sort?.key === 'spend' ? sort.direction : null}
                      onClick={() => toggle('spend')}
                    >
                      Spend
                    </DataTableColumnHeader>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((one) => (
                  <TableRow key={one.id}>
                    <TableCell>
                      <Checkbox
                        aria-label={`Select ${one.session}`}
                        checked={pick.selected.has(one.id)}
                        onCheckedChange={() => pick.toggle(one.id)}
                      />
                    </TableCell>
                    <TableCell>{one.session}</TableCell>
                    <TableCell className="text-(--hd-muted-foreground)">{one.agent}</TableCell>
                    <TableCell align="end">${one.spend}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Table variant="framed" data-catalog-variant="framed">
              <TableHeader>
                <TableRow variant="matrix">
                  <TableHead variant="matrix" pinned>Name</TableHead>
                  <TableHead variant="matrix" align="center">Agent</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow variant="matrix" interactive data-state="selected">
                  <TableHead variant="row" pinned>code-review</TableHead>
                  <TableCell variant="matrix">Loaded</TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <Table variant="panel" data-catalog-variant="panel">
              <TableHeader><TableRow variant="panel"><TableHead variant="panel">Panel fact</TableHead></TableRow></TableHeader>
              <TableBody><TableRow variant="panel"><TableCell variant="panel">Compact value</TableCell></TableRow></TableBody>
            </Table>
          </SectionBody>
          <DataTablePagination
            className="border-t-0"
            selected={pick.count}
            total={rows.length}
            page={1}
            pages={1}
          />
        </Section>

        <div className={styles.caseLabel} style={{ marginTop: 'var(--hd-space-3)' }}>
          field &mdash; the grouping layer, which neither side had
        </div>
        <FieldSet>
          <FieldLegend>Where sessions run</FieldLegend>
          <FieldGroup>
            <Field label="Repository" required hint="A local checkout. Worktrees are fine.">
              {(control) => (
                <InputGroup>
                  <InputGroupAddon align="inline-start">~/code</InputGroupAddon>
                  <InputGroupInput {...control} defaultValue="harnessdesk" />
                </InputGroup>
              )}
            </Field>
            <FieldSeparator>or</FieldSeparator>
            <Field label="Clone from" hint="An https or ssh remote.">
              {(control) => (
                <InputGroup>
                  <InputGroupInput {...control} placeholder="git@github.com:…" />
                </InputGroup>
              )}
            </Field>
            <FieldError errors={[{ message: 'That remote is unreachable from this network.' }]} />
          </FieldGroup>
        </FieldSet>
      </div>

      <Rule>
        Seven components taken from the registry rather than written here. Four were outright gaps
        &mdash; <code>marker</code> had one variant of three, <code>attachment</code> had no upload
        state at all, <code>breadcrumb</code> existed only in the mock pages, and{' '}
        <code>field</code> had no grouping layer. <code>radio-group</code> replaced the behaviour
        under the canonical <code>RadioGroup</code>, which keeps the product look and supplies arrow keys. The last two
        were taken as capability rather than code: <code>data-table</code>&rsquo;s recipe wants
        TanStack, and <code>resizable</code>&rsquo;s wants to own the sizes the layout store owns
        &mdash; so the sortable heading, the selection and the pagination are here, and the resize
        handle is here with the keyboard support that was the point, and neither library came with
        them.
      </Rule>
    </>
  )
}

/**
 * `PlanCard` (`design/patterns/PlanCard.tsx`) directly, no store and no
 * screen: it is pure props, so the board is exactly what a person editing
 * this file would expect — no `SettingsAgents` import, no preview harness,
 * no fake `AppStore`. Five states, the ones the pattern actually has: a
 * suggestion a click away, a plan with nothing to suggest, a price already
 * set, a key account's own budget, and `plans.json`'s own read failure shown
 * as a `Note`.
 */
const PLAN_CLAUDE_SUGGESTION: PlanSuggestion = {
  runtime: runtimeId('claude'),
  planMatch: 'Pro',
  amount: 20,
  currency: 'USD',
  period: 'month',
  sourceUrl: 'https://claude.com/pricing',
  checkedAt: '2026-09-26',
}

const inertPlanCallbacks = {
  onSetFee: async () => {},
  onClearFee: async () => {},
  onSetBudget: async () => {},
  onClearBudget: async () => {},
}

const PlanCardBoard = () => (
  <>
    <Specimen
      measure="page"
      caption="The Plan card: a suggested price, a plan nothing suggests, a price you set, a key account's own budget, and plans.json's own refusal"
    >
      <div className={styles.stack} data-catalog-states="not-set-suggested not-set-plain set budget refusal">
        <div data-catalog-case="not-set-suggested">
          <div className={styles.caseLabel}>Not set — a suggestion is offered</div>
          <PlanCard
            entry={null}
            suggestion={PLAN_CLAUDE_SUGGESTION}
            refusal={null}
            showBudget={false}
            {...inertPlanCallbacks}
          />
        </div>
        <div data-catalog-case="not-set-plain">
          <div className={styles.caseLabel}>Not set — no suggestion for this plan</div>
          <PlanCard entry={null} suggestion={null} refusal={null} showBudget={false} {...inertPlanCallbacks} />
        </div>
        <div data-catalog-case="set">
          <div className={styles.caseLabel}>Set — &ldquo;you set this&rdquo;</div>
          <PlanCard
            entry={{ fee: { amount: 200, currency: 'USD', period: 'month', source: 'user', setAt: Date.now() } }}
            suggestion={null}
            refusal={null}
            showBudget={false}
            {...inertPlanCallbacks}
          />
        </div>
        <div data-catalog-case="budget">
          <div className={styles.caseLabel}>A key account&rsquo;s monthly budget</div>
          <PlanCard
            entry={{ budget: { amount: 50, currency: 'USD', period: 'month', setAt: Date.now() } }}
            suggestion={null}
            refusal={null}
            showBudget
            {...inertPlanCallbacks}
          />
        </div>
        <div data-catalog-case="refusal">
          <div className={styles.caseLabel}>plans.json could not be read</div>
          <PlanCard
            entry={null}
            suggestion={null}
            refusal="~/.harnessdesk/plans.json was not read: it is not JSON"
            showBudget={false}
            {...inertPlanCallbacks}
          />
        </div>
      </div>
    </Specimen>
    <Rule>
      Five states, one card: a suggestion is a click away when the vendor&rsquo;s own page gave an
      unambiguous number; otherwise the row asks for one. A stored fee reads &ldquo;you set
      this&rdquo; and a vendor-reported fee never would. A key or metered account gets a second row
      for its own spending cap, unrelated to any plan limit &mdash; never bundled, never guessed.
      A <code>plans.json</code> that fails to read shows its own refusal rather than going blank.
    </Rule>
  </>
)

/**
 * The Plans table (`claude/plans-table`): the real `ShapeFilters`, `PlansTable`
 * and `NotReportingList` against hand-built `UsageReport`s, with inert
 * callbacks — no store, the way `PlanCardBoard` above reads pure props. Each
 * shape's own case opens its row (`initialExpanded`), which is how the five
 * shape bodies (`AllowanceBody`, `BalanceBody`, `KeyBody`, `FreeBody`, and
 * `Card` for Windows) actually get mounted here, through `PlansTable`'s own
 * `ExpandedBody` switch — never redrawn a second way for the catalogue.
 */
const PLANS_NOW = new Date('2026-09-26T12:00:00').getTime()
const PLANS_DAY = 86_400_000

const plansInfo = (id: string, name: string): RuntimeInfo =>
  ({ id: runtimeId(id), name, capabilities: { ...NO_CAPABILITIES }, presentation: { name } }) as unknown as RuntimeInfo

const PLANS_CLAUDE = plansInfo('claude', 'Claude Code')
const PLANS_CODEX = plansInfo('codex', 'Codex')
const PLANS_CURSOR = plansInfo('cursor', 'Cursor')
const PLANS_GEMINI = plansInfo('gemini', 'Antigravity')

const plansReport = (over: Partial<UsageReport>): UsageReport =>
  ({
    runtime: PLANS_CLAUDE.id,
    account: null,
    plan: null,
    lanes: [],
    credits: null,
    spend: null,
    reached: null,
    source: { kind: 'runtime', label: 'from its own API' },
    fetchedAt: PLANS_NOW - 60_000,
    staleAfterMs: 600_000,
    error: null,
    ...over,
  }) as UsageReport

/** One report per catalogue case — the smallest fixture that puts a row in exactly the state its case name says. */
const PLANS_CASES = {
  windows: plansReport({
    runtime: PLANS_CLAUDE.id,
    account: 'windows@harnessdesk.app',
    plan: 'Max 20x',
    lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 42, windowMinutes: 10_080, resetsAt: PLANS_NOW + 2 * PLANS_DAY }],
    accountActivity: {
      days: [
        { day: new Date(2026, 8, 24).getTime(), tokens: 320_000 },
        { day: new Date(2026, 8, 26).getTime(), tokens: 510_000 },
      ],
      lifetimeTokens: 82_000_000,
      peakDailyTokens: 1_400_000,
      currentStreakDays: 6,
      longestStreakDays: 18,
    },
    spend: {
      currency: 'USD', todayCost: null, windowCost: 50, windowDays: 30,
      todayTokens: null, windowTokens: null, provenance: 'listPrice', coverage: null,
    },
    billing: { kinds: ['windows'], fee: { amount: 30, currency: 'USD', period: 'month', source: 'user' } },
  }),
  allowance: plansReport({
    runtime: PLANS_CURSOR.id,
    account: 'allowance@harnessdesk.app',
    plan: 'Pro',
    lanes: [
      {
        id: 'monthly',
        label: 'Requests',
        usedPercent: 62.4,
        windowMinutes: 30 * 24 * 60,
        resetsAt: PLANS_NOW + 12 * PLANS_DAY,
        unit: 'requests',
        used: 312,
        limit: 500,
        layer: 'plan',
      },
    ],
    billing: { kinds: ['allowance'] },
    turns: { count: 80, unitsPerTurn: 3.2, since: PLANS_NOW - 14 * PLANS_DAY },
  }),
  balance: plansReport({
    runtime: PLANS_CODEX.id,
    account: 'balance@harnessdesk.app',
    credits: { remaining: 8.8, unit: 'USD' },
    balanceHistory: {
      unit: 'USD',
      points: Array.from({ length: 22 }, (_, index) => ({
        at: new Date(2026, 8, 5 + index, 12).getTime(),
        remaining: Number((21 - index * 0.58).toFixed(2)),
      })),
    },
    spend: {
      currency: 'USD',
      todayCost: null,
      windowCost: null,
      windowDays: 7,
      todayTokens: null,
      windowTokens: null,
      provenance: 'vendorMetered',
      coverage: { priced: 3, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: 3, daysRequested: 3 },
      daily: [
        { day: PLANS_NOW - 2 * PLANS_DAY, cost: 1.1, tokens: null },
        { day: PLANS_NOW - PLANS_DAY, cost: 0.9, tokens: null },
        { day: PLANS_NOW, cost: 1.2, tokens: null },
      ],
    },
    billing: { kinds: ['balance'] },
  }),
  key: plansReport({
    runtime: PLANS_CLAUDE.id,
    account: 'key@harnessdesk.app',
    spend: {
      currency: 'USD',
      todayCost: 1.4,
      windowCost: 22.4,
      windowDays: 30,
      todayTokens: 180_000,
      windowTokens: 2_400_000,
      provenance: 'listPrice',
      coverage: null,
    },
    billing: { kinds: ['metered'], budget: { amount: 50, currency: 'USD', period: 'month' } },
  }),
  free: plansReport({
    runtime: PLANS_CURSOR.id,
    account: 'free@harnessdesk.app',
    plan: 'Hobby',
    spend: {
      currency: 'USD',
      todayCost: null,
      windowCost: null,
      windowDays: 30,
      todayTokens: null,
      windowTokens: 1_140_000,
      provenance: 'listPrice',
      coverage: null,
    },
    turns: { count: 64, unitsPerTurn: null, since: PLANS_NOW - 14 * PLANS_DAY },
    billing: { kinds: ['free'] },
  }),
  low: plansReport({
    runtime: PLANS_CLAUDE.id,
    account: 'low@harnessdesk.app',
    plan: 'Pro',
    lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 88, windowMinutes: 10_080, resetsAt: PLANS_NOW + PLANS_DAY }],
    billing: { kinds: ['windows'] },
  }),
  out: plansReport({
    runtime: PLANS_CLAUDE.id,
    account: 'out@harnessdesk.app',
    plan: 'Pro',
    lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 100, windowMinutes: 10_080, resetsAt: PLANS_NOW + PLANS_DAY }],
    billing: { kinds: ['windows'] },
  }),
  overage: plansReport({
    runtime: PLANS_CURSOR.id,
    account: 'overage@harnessdesk.app',
    plan: 'Pro',
    lanes: [
      {
        id: 'requests',
        label: 'Requests',
        usedPercent: 62.6,
        windowMinutes: 30 * 24 * 60,
        resetsAt: PLANS_NOW + 12 * PLANS_DAY,
        unit: 'requests',
        used: 313,
        limit: 500,
        layer: 'plan',
      },
      {
        id: 'overage',
        label: 'On-demand usage',
        usedPercent: 25,
        windowMinutes: 60 * 24 * 60,
        resetsAt: PLANS_NOW + 30 * PLANS_DAY,
        unit: 'usd',
        used: 5,
        limit: 20,
        layer: 'overage',
      },
    ],
    spend: {
      currency: 'USD', todayCost: null, windowCost: 10, windowDays: 30,
      todayTokens: null, windowTokens: null, provenance: 'listPrice', coverage: null,
    },
    billing: {
      kinds: ['allowance', 'metered'],
      fee: { amount: 30, currency: 'USD', period: 'month', source: 'user' },
      overage: { enabled: true, spent: 5, currency: 'USD' },
    },
  }),
  'key-no-budget': plansReport({
    runtime: PLANS_GEMINI.id,
    account: 'key-no-budget@harnessdesk.app',
    spend: {
      currency: 'USD',
      todayCost: 0.6,
      windowCost: 9.2,
      windowDays: 30,
      todayTokens: 90_000,
      windowTokens: 980_000,
      provenance: 'listPrice',
      coverage: null,
    },
    billing: { kinds: ['metered'] },
  }),
  'balance-negative': plansReport({
    runtime: PLANS_CODEX.id,
    account: 'balance-negative@harnessdesk.app',
    credits: { remaining: -2.15, unit: 'USD' },
    balanceHistory: {
      unit: 'USD',
      points: [
        { at: new Date(2026, 8, 5, 12).getTime(), remaining: 4.2 },
        { at: new Date(2026, 8, 14, 12).getTime(), remaining: 0 },
        { at: new Date(2026, 8, 26, 12).getTime(), remaining: -2.15 },
      ],
    },
    billing: { kinds: ['balance'] },
  }),
  'balance-no-draw': plansReport({
    runtime: PLANS_CODEX.id,
    account: 'balance-no-draw@harnessdesk.app',
    credits: { remaining: 15, unit: 'USD' },
    billing: { kinds: ['balance'] },
  }),
  // A report the table has a row for — an agent that answered but whose own
  // `primaryShapeOf` is `'none'` (no billing, no lanes, no balance) — distinct
  // from `PLANS_NOT_REPORTING_AGENT` below, which never sent one at all.
  // "Not reporting" reads on the row itself now, never "No limit".
  'not-reporting-row': plansReport({
    runtime: PLANS_GEMINI.id,
    account: 'not-reporting-row@harnessdesk.app',
  }),
} satisfies Readonly<Record<string, UsageReport>>

type PlansCaseKey = keyof typeof PLANS_CASES

const PLANS_BY_ID = new Map<RuntimeInfo['id'], RuntimeInfo>([
  [PLANS_CLAUDE.id, PLANS_CLAUDE],
  [PLANS_CODEX.id, PLANS_CODEX],
  [PLANS_CURSOR.id, PLANS_CURSOR],
  [PLANS_GEMINI.id, PLANS_GEMINI],
])

const PLANS_NOT_REPORTING_AGENT: SilentAgent = {
  info: plansInfo('gemini-cli', 'Gemini CLI'),
  reason: 'It reports its plan once an account is connected.',
}

const plansInertCallbacks = {
  onRefreshAccount: () => {},
  onStopTracking: () => {},
  onOpenPlanSettings: () => {},
}

const PlansCase = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <div className={styles.caseLabel}>{label}</div>
    {children}
  </div>
)

/* No fake `AppStore`: this dialog's own actions are never taken from the board, only opened and read. */
const findingDecisionSnapshot = emptySnapshot()
const findingDecisionStore = { subscribe: () => () => {}, getSnapshot: () => findingDecisionSnapshot } as unknown as AppStore
const FINDING_DECISION_CEILING_VIEW: FindingRunView = {
  run: 'run-catalogue', goal: 'goal-catalogue', round: 4, finished: 3, total: 4, embargoed: false, open: 0, blocking: 0,
  reason: 'Round 4 ended with 0 open findings. To let it continue, open Findings and choose Authorise another round.',
  ceilingStop: true, stamp: 'catalogue-stamp-ceiling', publication: 'posted', rounds: [],
  reviewersFinished: null, reviewersTotal: null, pendingExceptions: [], repair: null,
  boundPr: { repo: 'acme/widgets', pr: 42 }, unbound: null, undecidable: null,
}
/* A pending security finding — never the round ceiling, so a count past one round buys nothing here (#1083). */
const FINDING_DECISION_EXCEPTION_VIEW: FindingRunView = {
  ...FINDING_DECISION_CEILING_VIEW,
  round: 3, reason: 'Review the new regression or security finding before continuing.',
  ceilingStop: false, stamp: 'catalogue-stamp-exception', pendingExceptions: ['finding-0007'],
}

const FindingDecisionBoard = () => {
  const [open, setOpen] = useState<'ceiling' | 'exception' | null>(null)
  return (
    <div className={styles.matrix}>
      <Case label="stopped at its round ceiling — the number beside the button chooses how many rounds it authorizes">
        <Button variant="secondary" onClick={() => setOpen('ceiling')}>Decide this run</Button>
        {open === 'ceiling' && (
          <StoreProvider store={findingDecisionStore}>
            <FindingDecision goal={FINDING_DECISION_CEILING_VIEW.goal} view={FINDING_DECISION_CEILING_VIEW} onClose={() => setOpen(null)} />
          </StoreProvider>
        )}
      </Case>
      <Case label="stopped on a pending exception — not the ceiling, so the count field never shows">
        <Button variant="secondary" onClick={() => setOpen('exception')}>Decide this run</Button>
        {open === 'exception' && (
          <StoreProvider store={findingDecisionStore}>
            <FindingDecision goal={FINDING_DECISION_EXCEPTION_VIEW.goal} view={FINDING_DECISION_EXCEPTION_VIEW} onClose={() => setOpen(null)} />
          </StoreProvider>
        )}
      </Case>
    </div>
  )
}

const PlansTableBoard = () => {
  const allRows: readonly PlanRow[] = planRows(Object.values(PLANS_CASES), PLANS_NOW)
  const rowFor = (key: PlansCaseKey): PlanRow => allRows.find((row) => row.report.account === PLANS_CASES[key].account)!
  const oneUp = (key: PlansCaseKey, expanded = true) => {
    const row = rowFor(key)
    return (
      <PlansTable
        rows={[row]}
        byId={PLANS_BY_ID}
        now={PLANS_NOW}
        filter="all"
        preferenceFor={() => ({})}
        initialExpanded={expanded ? row.key : null}
        {...plansInertCallbacks}
      />
    )
  }
  return (
    <>
      <Specimen
        measure="page"
        caption="Every account, least left first, and the shape body each row opens into, in every state"
      >
        <div
          className={styles.stack}
          data-catalog-states="windows allowance balance key free not-reporting not-reporting-row low out overage key-no-budget balance-negative balance-no-draw filter-applied row-expanded"
        >
          <PlansCase label="Windows — a plan lane">
            <div data-catalog-case="windows">{oneUp('windows')}</div>
          </PlansCase>
          <PlansCase label="Allowance — a request-metered plan">
            <div data-catalog-case="allowance">{oneUp('allowance')}</div>
          </PlansCase>
          <PlansCase label="Balance — a prepaid account with a draw rate">
            <div data-catalog-case="balance">{oneUp('balance')}</div>
          </PlansCase>
          <PlansCase label="Key — a metered account with its own budget">
            <div data-catalog-case="key">{oneUp('key')}</div>
          </PlansCase>
          <PlansCase label="Free — local, nothing to run out of">
            <div data-catalog-case="free">{oneUp('free')}</div>
          </PlansCase>
          <PlansCase label="Not reporting — never answered runtime/account">
            <div data-catalog-case="not-reporting">
              <NotReportingList entries={entriesFromSilent([PLANS_NOT_REPORTING_AGENT])} />
            </div>
          </PlansCase>
          <PlansCase label='Not reporting — a report with no shape at all, its own row reads "Not reporting," never "No limit"'>
            <div data-catalog-case="not-reporting-row">{oneUp('not-reporting-row')}</div>
          </PlansCase>
          <PlansCase label="Low — an amber row">
            <div data-catalog-case="low">{oneUp('low')}</div>
          </PlansCase>
          <PlansCase label="Out — a spent window">
            <div data-catalog-case="out">{oneUp('out')}</div>
          </PlansCase>
          <PlansCase label="On overage — metered spend already in use">
            <div data-catalog-case="overage">{oneUp('overage')}</div>
          </PlansCase>
          <PlansCase label="Key, no budget — &ldquo;No limit&rdquo; rather than an empty bar">
            <div data-catalog-case="key-no-budget">{oneUp('key-no-budget')}</div>
          </PlansCase>
          <PlansCase label="Balance, spent — Out, never a reset">
            <div data-catalog-case="balance-negative">{oneUp('balance-negative')}</div>
          </PlansCase>
          <PlansCase label='Balance, no draw yet — runway reads "—"'>
            <div data-catalog-case="balance-no-draw">{oneUp('balance-no-draw')}</div>
          </PlansCase>
          <PlansCase label="Filtered to Balances">
            <div data-catalog-case="filter-applied">
              <ShapeFilters counts={shapeCountsOf(allRows.map((row) => row.shape))} value="balance" onChange={() => {}} />
              <PlansTable
                rows={allRows}
                byId={PLANS_BY_ID}
                now={PLANS_NOW}
                filter="balance"
                preferenceFor={() => ({})}
                {...plansInertCallbacks}
              />
            </div>
          </PlansCase>
          <PlansCase label="A row already open">
            <div data-catalog-case="row-expanded">
              <PlansTable
                rows={allRows}
                byId={PLANS_BY_ID}
                now={PLANS_NOW}
                filter="all"
                preferenceFor={() => ({})}
                initialExpanded={rowFor('allowance').key}
                {...plansInertCallbacks}
              />
            </div>
          </PlansCase>
        </div>
      </Specimen>
      <Rule>
        A row is thin on purpose: mark, name, the shape and status chips, a bar, a percent, the
        vendor&rsquo;s own unit, an approximate turn count and the reset. The account&rsquo;s own
        story &mdash; the lanes, the pace, the money &mdash; belongs to the shape body a row expands
        into, one of five plus the existing Windows card. <code>reportNeedsAttention</code> decides
        Low, not a second reading of the headline&rsquo;s own tone, so a healthy headline pinned over
        a low account-wide lane still turns the row amber.
      </Rule>
    </>
  )
}

export const COMPOSITION_BOARDS: BoardSpec[] = [
  {
    id: 'panel-controls',
    title: 'Window · panel controls',
    about: 'The right-panel visibility count and the panel split actions when a half would be too small.',
    render: PanelControlsBoard,
  },
  {
    id: 'stat',
    title: 'Stat',
    about:
      'A figure, and everything the reader needs to trust it: what it counts, what period it covers, which way it is moving.',
    render: StatBoard,
  },
  {
    id: 'delta',
    title: 'Delta',
    about: 'A change, with its sign said in colour as well as in punctuation.',
    render: DeltaBoard,
  },
  {
    id: 'plan-card',
    title: 'Plan card',
    about:
      'A plan\'s price and a key or metered account\'s monthly budget, in every state the card can be in.',
    render: PlanCardBoard,
  },
  {
    id: 'section',
    title: 'Section · Toolbar',
    about: 'A titled region of a page — the shell almost every screen wants on top of a card.',
    render: SectionBoard,
  },
  {
    id: 'badge',
    title: 'Badge · Tabs',
    about:
      'A small standing label, and the two ways a set of panels names itself — a track with a raised active tab, and an underline with no track at all.',
    render: BadgeTabsBoard,
  },
  {
    id: 'icons',
    title: 'The icon set',
    about:
      'Every glyph the app has, enumerated from the module rather than listed here — so the board cannot fall behind the set. The tile board beside this one judges the container; this one judges the set: one weight, no duplicates, no two arrows meaning the same thing.',
    render: IconBoard,
  },
  {
    id: 'tile',
    title: 'IconTile',
    about: 'A glyph on its own ground: soft for things and categories, solid for faces, with tone and tint kept distinct.',
    render: TileBoard,
  },
  {
    id: 'list',
    title: 'ListRow',
    about: 'A line in a list of things, each of which has a face, a name and a reading.',
    render: ListBoard,
  },
  {
    id: 'readings',
    title: 'KeyValue · Progress',
    about: 'Facts about one thing, and how far along it is.',
    render: KeyValueBoard,
  },
  {
    id: 'tool-pane',
    title: 'ToolPane · InspectorPanel',
    about: 'The shared frame, bars, messages and inspector anatomy around live tools.',
    render: ToolPaneBoard,
  },
  {
    id: 'field',
    title: 'Field · InputGroup',
    about: 'A control and the three things that can be said around it — wired up, not just placed.',
    render: FieldBoard,
  },
  {
    id: 'stepper',
    title: 'Stepper',
    about: 'A journey with a known length, drawn only when the length changes the decision.',
    render: StepperBoard,
  },
  {
    id: 'empty',
    title: 'EmptyState · ChoiceRow',
    about: 'The screen with nothing on it yet, doing something useful anyway.',
    render: EmptyBoard,
  },
  {
    id: 'kanban',
    title: 'Board',
    about: 'Work in columns: what is waiting, what is being done, and who has it.',
    render: KanbanBoard,
  },
  {
    id: 'run-inspector',
    title: 'Run inspector',
    about: 'Recorded detail for a Run, card, check or person’s step, beside the timeline or pushed at narrow widths.',
    render: RunInspectorBoard,
  },
  {
    id: 'run-view',
    title: 'Run timeline',
    about: 'The recorded rounds, cards, checks and findings, with a selectable row — and the Flow the Run started with, one choice away.',
    render: RunViewBoard,
  },
  {
    id: 'flow-graph',
    title: 'FlowGraph',
    about: 'A Flow’s steps and rules, drawn read-only: cards on a dot grid, edges with the outcome word above them, loops under the line, and the list that says the same.',
    render: FlowGraphBoard,
  },
  {
    id: 'teams-page',
    title: 'Teams on the desk',
    about: 'Attention first, settled work folded, and recorded usage in its own unit.',
    render: TeamsPageBoard,
  },
  {
    id: 'team-record',
    title: 'The wrapped Team',
    about: 'The receipt, conversations and Run stay readable after work ends.',
    render: TeamRecordBoard,
  },
  {
    id: 'team-overview',
    title: 'The Team overview',
    about: 'Every Seat, its state and recorded cost, with finished Seats folded.',
    render: TeamOverviewBoard,
  },
  {
    id: 'room-side-by-side',
    title: 'Room — Side by side',
    about: 'Two or four member conversations, with one focused tile and the room’s real conversations.',
    render: SideBySideBoard,
  },
  {
    id: 'adopted',
    title: 'Adopted from the registry',
    about:
      'Seven components taken from shadcn/ui rather than written here, and what each one brought that the app did not have.',
    render: AdoptedBoard,
  },
  {
    id: 'spark',
    title: 'Sparkline · Bars · Donut',
    about: 'Charts small enough to live inside a sentence.',
    render: SparkBoard,
  },
  {
    id: 'chart',
    title: 'The chart kit',
    about: 'The other size: a figure that is the subject of its own panel.',
    render: ChartKitBoard,
  },
  {
    id: 'overview-strip',
    title: 'The Overview strip',
    about: 'Paid, Value, Turns and Tokens for the Overview\'s own spend window — the real component, every state.',
    render: OverviewStripBoard,
  },
  {
    id: 'dialog',
    title: 'Dialog · ConfirmDialog',
    about: 'A surface that takes the window until it is answered.',
    render: DialogBoard,
  },
  {
    id: 'plans-table',
    title: 'Plans table',
    about: 'Every account, least left first, with Paid, Value, the paid ratio, fee state and overage aside in the shape body.',
    render: PlansTableBoard,
  },
  {
    id: 'finding-decision',
    title: 'FindingDecision · Decide this run',
    about: 'The real dialog, in both states (#1083): a round-ceiling stop shows a 1-to-20 count next to "Authorise another round" that relabels the button and is the count the wire sends; every other stop keeps the plain single button, with no count field at all.',
    render: FindingDecisionBoard,
  },
]
