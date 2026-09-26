import { useState } from 'react'

import {
  AgentIcon,
  BranchIcon,
  CostIcon,
  ExtensionIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  ShieldAlertIcon,
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
import { CodeText, Row, Rows, SectionHead, Text } from '../patterns/Settings'
import { AGENTS, COLUMNS, SESSIONS_TREND, SETUP_STEPS, SPEND_BY_DAY } from '../showcase/fixtures'
import { DialogBoard, type Board as BoardSpec } from './boards'
import { IconBoard } from './icon-board'
import { Specimen } from './specimen'
import styles from './explorer.module.css'

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
const Case = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className={styles.case}>
    <div className={styles.caseLabel}>{label}</div>
    <div className={styles.caseBody}>{children}</div>
  </div>
)

const TEXTAREA_CATALOG_VARIANTS = ['default', 'editor', 'code', 'inline', 'composer'] as const
const TEXTAREA_CATALOG_SIZES = ['default', 'compact', 'composer'] as const
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
const ICON_TILE_CATALOG_SHAPE = ['square', 'round'] as const
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

// --- figures ----------------------------------------------------------------

const StatBoard = () => (
  <>
    <Specimen wide caption="Stat rows: variants, alignment, and a dashboard's own numbers">
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
      <Case label="shape — a person or a thing">
        {ICON_TILE_CATALOG_SHAPE.map((shape) => (
          <IconTile key={shape} shape={shape} data-catalog-shape={shape} tint="violet" size="lg">
            {shape === 'round' ? <AgentIcon /> : <ExtensionIcon />}
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
          <ToolPane variant="integrated" className="h-56 w-full" data-catalog-variant="integrated">
            <ToolPaneHeader variant="window" title="Browser" subtitle="https://example.com" />
            <ToolPaneBar variant="address">example.com</ToolPaneBar>
            <ToolPaneNotice tone="warning">The page is still loading.</ToolPaneNotice>
            <ToolPaneBody bleed>
              <ToolPaneMessage>Waiting for the page.</ToolPaneMessage>
            </ToolPaneBody>
          </ToolPane>
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

// --- input ------------------------------------------------------------------

const FieldBoard = () => (
  <>
    <Specimen caption="InputGroup addons, and Field wiring a hint or an error to its control">
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
      <Specimen caption="Stepper, horizontal and vertical, driven by one current step">
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

const ChartKitBoard = () => (
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
          <div className="flex gap-2">
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

export const COMPOSITION_BOARDS: BoardSpec[] = [
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
    about: 'A glyph on a soft ground of its own, and the tone/tint line drawn where it bites.',
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
    id: 'dialog',
    title: 'Dialog · ConfirmDialog',
    about: 'A surface that takes the window until it is answered.',
    render: DialogBoard,
  },
]
