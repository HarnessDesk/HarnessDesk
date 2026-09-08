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
  IconTile,
  InputGroupAddon,
  InputGroupInput,
  InputGroup,
  KeyValue,
  KeyValueRow,
  ListRow,
  ListRows,
  Marker,
  MarkerContent,
  MarkerIcon,
  Progress,
  RadioGroup,
  RadioGroupItem,
  ResizeHandle,
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
  StatRow,
  Stepper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TINTS,
  useTableSelection,
  useTableSort,
  TONES,
  Toolbar,
  ToolbarGap,
} from '../ui'
import { AGENTS, COLUMNS, SESSIONS_TREND, SETUP_STEPS, SPEND_BY_DAY } from '../showcase/fixtures'
import type { Board as BoardSpec } from './boards'
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

/** The rule this component holds, said under the states that demonstrate it. */
const Rule = ({ children }: { children: React.ReactNode }) => (
  <p className={styles.rule}>{children}</p>
)

// --- figures ----------------------------------------------------------------

const StatBoard = () => (
  <>
    <div className={styles.stack} style={{ maxWidth: 'none' }}>
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

const SectionBoard = () => (
  <>
    <div className={styles.stack} style={{ maxWidth: 640 }}>
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
    <Rule>
      The header lays out on a grid that grows a second column only when a{' '}
      <code>SectionAction</code> is really there — <code>has-data-[slot=…]</code> asks the DOM
      instead of making the caller pass a flag, so a conditionally rendered button cannot leave a
      dead column behind. <code>SectionBody inset={'{false}'}</code> is for rows that draw their own
      padding and need their hover ground to reach the card&rsquo;s edge.
    </Rule>
  </>
)

const TileBoard = () => (
  <>
    <div className={styles.matrix}>
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
        <IconTile size="sm" tint="blue">
          <FolderIcon />
        </IconTile>
        <IconTile tint="blue">
          <FolderIcon />
        </IconTile>
        <IconTile size="lg" tint="blue">
          <FolderIcon />
        </IconTile>
      </Case>
      <Case label="shape — a person or a thing">
        <IconTile shape="round" tint="violet" size="lg">
          <AgentIcon />
        </IconTile>
        <IconTile shape="square" tint="violet" size="lg">
          <ExtensionIcon />
        </IconTile>
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
              subtitle="Waiting on approval since 09:12"
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
    <div className={styles.matrix}>
      <Case label="one column, with a total">
        <KeyValue className="w-full">
          <KeyValueRow label="Prompt">5.9M</KeyValueRow>
          <KeyValueRow label="Completion">2.5M</KeyValueRow>
          <KeyValueRow label="Cached">−1.8M</KeyValueRow>
          <KeyValueRow label="Charged" emphasis>
            $212.40
          </KeyValueRow>
        </KeyValue>
      </Case>
      <Case label="progress, as a reading">
        <div className="flex w-full flex-col gap-2">
          <Progress value={82} tone="success" />
          <Progress value={44} />
          <Progress value={19} tone="warning" />
          <Progress value={96} tone="danger" label="96% of plan" />
        </div>
      </Case>
    </div>
    <Rule>
      The bar fills with what has <em>happened</em>. An earlier version of this app&rsquo;s usage
      meter filled with what was left, sat next to a number counting up, and the two contradicted
      each other on the same line — see <code>docs</code> and the meter-direction note.
    </Rule>
  </>
)

// --- input ------------------------------------------------------------------

const FieldBoard = () => (
  <>
    <div className={styles.stack} style={{ maxWidth: 420 }}>
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
    </div>
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
    </div>
    <Rule>
      An empty state is a menu, not an apology: it takes the space the missing content would have
      occupied and spends it saying what could fill it. On a <code>ChoiceRow</code> the second line
      is always earned — the reader is choosing between options whose names cannot tell them apart.
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
      <Rule>
        A card&rsquo;s column is its state, so no card repeats it — every card says who has it, how
        urgent it is and how much conversation it has collected, and none of them says &ldquo;in
        progress&rdquo;. The columns take a <em>tint</em>, not a tone: a red &ldquo;Blocked&rdquo;
        column pushes every card in it into a verdict it has not earned, and a card sitting there
        three days starts to read as an incident. Only <code>priority</code> judges. Unassigned is
        said out loud, because an unassigned card and a card whose avatars failed to load look
        identical otherwise.
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
      <div className={styles.matrix}>
        <Case label="marker &mdash; three variants, was one">
          <div className="flex w-full flex-col">
            <Marker>
              <MarkerIcon>
                <BranchIcon />
              </MarkerIcon>
              <MarkerContent>Switched to feat/auth-migration</MarkerContent>
            </Marker>
            <Marker variant="separator">
              <MarkerContent>Context compacted</MarkerContent>
            </Marker>
            <Marker variant="border">
              <MarkerIcon>
                <FolderIcon />
              </MarkerIcon>
              <MarkerContent>Explored 4 files</MarkerContent>
            </Marker>
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
      </div>

      <div className={styles.stack} style={{ maxWidth: 560, marginTop: 'var(--hd-space-4)' }}>
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
                    <TableCell className="text-right tabular-nums">${one.spend}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
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
        under <code>Kit.Segmented</code>, which kept its look and gained arrow keys. The last two
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
    title: 'Stat · Delta',
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
]
