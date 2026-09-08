import { useState } from 'react'

import {
  AgentIcon,
  BranchIcon,
  ClockIcon,
  CostIcon,
  ExtensionIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  ShieldAlertIcon,
  TerminalIcon,
  UsageIcon,
} from '@/components/Icons'
import {
  AvatarStack,
  Bars,
  Breadcrumb,
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
  ChoiceRow,
  Delta,
  Donut,
  EmptyState,
  Field,
  IconTile,
  InputGroupAddon,
  InputGroupInput,
  InputGroup,
  KeyValue,
  KeyValueRow,
  ListRow,
  ListRows,
  Progress,
  Section,
  SectionAction,
  SectionBody,
  SectionDescription,
  SectionFooter,
  SectionHeader,
  SectionTitle,
  Sparkline,
  Stat,
  StatRow,
  Stepper,
  Toolbar,
  ToolbarGap,
} from '../ui'
import type { Tone } from '../ui'
import {
  AGENT_SHARE,
  AGENTS,
  COLUMNS,
  SESSIONS,
  SESSIONS_TREND,
  SETUP_STEPS,
  SPEND_BY_DAY,
  SPEND_LABELS,
} from './fixtures'
import styles from './showcase.module.css'

/**
 * A page that does not exist, built only out of parts that do.
 *
 * Every board in this explorer shows a component against a white background
 * with its states beside it, which is the right way to *check* a component and
 * a poor way to *judge* one. A stat tile that looks confident alone can be
 * illegible in a row of four; a card header that reads well in isolation can
 * fight the toolbar above it. Composition problems only appear in composition.
 *
 * So this is a plausible HarnessDesk screen — a workspace overview with its
 * agents, its spend, its sessions and its board — assembled from the shipped
 * components and nothing else. There is no private markup here: if this page
 * needed a `<div className="…">` that the system could not supply, that is a
 * missing component, and the honest response is to add it rather than to
 * special-case it here.
 *
 * The knobs across the top change the composition rather than the tokens. The
 * explorer's own bar already swaps theme and foundation, which answers "what
 * would everything look like under a different design"; these answer the other
 * half — "which of the variants we shipped is right for this screen", which is
 * the question a variant exists to let someone ask.
 */

type Knobs = {
  statVariant: 'plain' | 'bordered' | 'tinted'
  statTone: boolean
  sectionVariant: 'card' | 'plain' | 'quiet'
  columnTint: boolean
  charts: boolean
  dense: boolean
}

const DEFAULTS: Knobs = {
  statVariant: 'bordered',
  statTone: true,
  sectionVariant: 'card',
  columnTint: true,
  charts: true,
  dense: false,
}

/** One knob: a label and the values it can take. Deliberately plain buttons —
 *  the explorer's chrome is a screen like any other and owns its furniture. */
const Knob = <T extends string | boolean>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) => (
  <div className={styles.knob}>
    <span className={styles.knobLabel}>{label}</span>
    <div className={styles.knobChoices}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          className={styles.knobChoice}
          {...(option.value === value ? { 'data-selected': '' } : {})}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  </div>
)

const ON_OFF = [
  { value: true, label: 'on' },
  { value: false, label: 'off' },
]

export const Showcase = () => {
  const [knobs, setKnobs] = useState<Knobs>(DEFAULTS)
  const set = <K extends keyof Knobs>(key: K, value: Knobs[K]) =>
    setKnobs((prior) => ({ ...prior, [key]: value }))

  const tone = (judged: Tone): Tone => (knobs.statTone ? judged : 'neutral')
  const gap = knobs.dense ? styles.pageDense : styles.page

  return (
    <div className={styles.frame}>
      <div className={styles.knobs}>
        <Knob
          label="Stat"
          value={knobs.statVariant}
          options={[
            { value: 'bordered' as const, label: 'bordered' },
            { value: 'plain' as const, label: 'plain' },
            { value: 'tinted' as const, label: 'tinted' },
          ]}
          onChange={(value) => set('statVariant', value)}
        />
        <Knob
          label="Stat tone"
          value={knobs.statTone}
          options={ON_OFF}
          onChange={(value) => set('statTone', value)}
        />
        <Knob
          label="Section"
          value={knobs.sectionVariant}
          options={[
            { value: 'card' as const, label: 'card' },
            { value: 'plain' as const, label: 'plain' },
            { value: 'quiet' as const, label: 'quiet' },
          ]}
          onChange={(value) => set('sectionVariant', value)}
        />
        <Knob
          label="Column tint"
          value={knobs.columnTint}
          options={ON_OFF}
          onChange={(value) => set('columnTint', value)}
        />
        <Knob
          label="Charts"
          value={knobs.charts}
          options={ON_OFF}
          onChange={(value) => set('charts', value)}
        />
        <Knob
          label="Density"
          value={knobs.dense}
          options={[
            { value: false, label: 'comfortable' },
            { value: true, label: 'dense' },
          ]}
          onChange={(value) => set('dense', value)}
        />
      </div>

      <div className={gap}>
        {/* ---- the page's own head, and what can be done from it ---------- */}
        <header className={styles.head}>
          <div className={styles.headText}>
            {/* The registry's breadcrumb, adopted: a real nav around an ol,
                with the last crumb marked as the page rather than merely
                styled like it. */}
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <FolderIcon aria-hidden />
                  <BreadcrumbLink href="#">harnessdesk</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BranchIcon aria-hidden />
                  <BreadcrumbPage>main</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <h1 className={styles.title}>Workspace</h1>
          </div>
          <Toolbar>
            <InputGroup className="w-56">
              <InputGroupAddon align="inline-start">
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput placeholder="Find a session…" aria-label="Find a session" />
            </InputGroup>
            <Button variant="outline">
              <ExtensionIcon /> Add agent
            </Button>
            <Button>
              <PlusIcon /> New session
            </Button>
          </Toolbar>
        </header>

        {/* ---- the four figures the desk is judged on --------------------- */}
        <StatRow>
          <Stat
            variant={knobs.statVariant}
            label="Sessions today"
            value="46"
            icon={<TerminalIcon />}
            tone={tone('brand')}
            trend={<Delta value={18} />}
            caption="vs. yesterday"
          />
          <Stat
            variant={knobs.statVariant}
            label="Tokens spent"
            value="8.4M"
            icon={<UsageIcon />}
            tone={tone('neutral')}
            trend={<Delta value={6} />}
            caption="this week"
          />
          <Stat
            variant={knobs.statVariant}
            label="Waiting on you"
            value="3"
            icon={<ShieldAlertIcon />}
            tone={tone('warning')}
            trend={<Delta value={-2} better="down" />}
            caption="approvals"
          />
          <Stat
            variant={knobs.statVariant}
            label="Cost"
            value="$212.40"
            icon={<CostIcon />}
            tone={tone('success')}
            trend={<Delta value={-12} better="down" />}
            caption="vs. last week"
          />
        </StatRow>

        {/* ---- spend, and who is spending it ------------------------------ */}
        <div className={styles.split}>
          <Section variant={knobs.sectionVariant}>
            <SectionHeader>
              <SectionTitle>Spend</SectionTitle>
              <SectionDescription>Twelve days, all agents, all workspaces.</SectionDescription>
              <SectionAction>
                <Delta value={-12} better="down" caption="vs. last period" />
              </SectionAction>
            </SectionHeader>
            <SectionBody>
              {knobs.charts ? (
                <Bars values={SPEND_BY_DAY} labels={SPEND_LABELS} tint="blue" height={96} highlight={8} />
              ) : (
                <KeyValue>
                  <KeyValueRow label="Peak day">$94.00</KeyValueRow>
                  <KeyValueRow label="Median day">$71.00</KeyValueRow>
                </KeyValue>
              )}
              <div className={styles.totals}>
                <KeyValue>
                  <KeyValueRow label="Prompt tokens">5.9M</KeyValueRow>
                  <KeyValueRow label="Completion tokens">2.5M</KeyValueRow>
                  <KeyValueRow label="Cached">−1.8M</KeyValueRow>
                  <KeyValueRow label="Charged" emphasis>
                    $212.40
                  </KeyValueRow>
                </KeyValue>
              </div>
            </SectionBody>
          </Section>

          <Section variant={knobs.sectionVariant}>
            <SectionHeader>
              <SectionTitle>By agent</SectionTitle>
              <SectionDescription>Share of this week&rsquo;s turns.</SectionDescription>
            </SectionHeader>
            <SectionBody className={styles.donutBody}>
              {knobs.charts && (
                <Donut slices={AGENT_SHARE} size={128}>
                  <div className={styles.donutValue}>100</div>
                  <div className={styles.donutCaption}>turns</div>
                </Donut>
              )}
              <div className={styles.legend}>
                {AGENT_SHARE.map((slice) => (
                  <div key={slice.label} className={styles.legendRow}>
                    <span
                      aria-hidden
                      className={styles.legendDot}
                      style={{ background: `var(--hd-tint-${slice.tint}-ink)` }}
                    />
                    <span className={styles.legendLabel}>{slice.label}</span>
                    <span className={styles.legendValue}>{slice.value}%</span>
                  </div>
                ))}
              </div>
            </SectionBody>
          </Section>
        </div>

        {/* ---- what is running right now ---------------------------------- */}
        <Section variant={knobs.sectionVariant}>
          <SectionHeader>
            <SectionTitle>Sessions</SectionTitle>
            <SectionAction>
              <AvatarStack members={AGENTS} max={4} />
              <Button variant="ghost" size="sm">
                View all
              </Button>
            </SectionAction>
          </SectionHeader>
          <SectionBody inset={false} className="pt-0">
            <ListRows>
              {SESSIONS.map((session) => (
                <ListRow
                  key={session.title}
                  interactive
                  lead={<AvatarStack members={[{ name: session.agent }]} size="default" />}
                  title={session.title}
                  subtitle={session.workspace}
                  meta={
                    <Progress
                      value={session.progress}
                      tone={session.tone}
                      size="sm"
                      className="max-w-64"
                    />
                  }
                  trail={
                    <>
                      <span className="text-(--hd-muted-foreground)">{session.state}</span>
                      <ClockIcon aria-hidden className="size-3.5 text-(--hd-muted-foreground)" />
                    </>
                  }
                />
              ))}
            </ListRows>
          </SectionBody>
          <SectionFooter>
            {knobs.charts && <Sparkline values={SESSIONS_TREND} tint="teal" height={28} className="max-w-40" />}
            <ToolbarGap />
            <span className="text-xs text-(--hd-muted-foreground)">46 sessions this week</span>
          </SectionFooter>
        </Section>

        {/* ---- the board: who has what ------------------------------------ */}
        <Section variant={knobs.sectionVariant}>
          <SectionHeader>
            <SectionTitle>Task board</SectionTitle>
            <SectionDescription>
              An intent&rsquo;s column is its state, so no card has to repeat it.
            </SectionDescription>
            <SectionAction>
              <Button variant="outline" size="sm">
                <PlusIcon /> Add column
              </Button>
            </SectionAction>
          </SectionHeader>
          <SectionBody>
            <Board>
              {COLUMNS.map((column) => (
                <BoardColumn
                  key={column.id}
                  title={column.title}
                  count={column.tasks.length}
                  tint={knobs.columnTint ? column.tint : 'blue'}
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
          </SectionBody>
        </Section>

        {/* ---- a screen with nothing on it, and a form ---------------------- */}
        <div className={styles.split}>
          <Section variant={knobs.sectionVariant}>
            <SectionBody>
              <EmptyState
                icon={<AgentIcon />}
                title="No agent on this workspace"
                description="Pick where the first session should run. You can add the rest later."
                footer="Nothing is written to the repo until you approve it."
              >
                <ChoiceRow
                  icon={<IconTile tint="blue" size="lg" shape="round" children={<AgentIcon />} />}
                  title="Claude Code"
                  description="Signed in · Opus 5 · 3 workspaces"
                />
                <ChoiceRow
                  icon={<IconTile tint="teal" size="lg" shape="round" children={<TerminalIcon />} />}
                  title="Codex"
                  description="Signed in · GPT-5.6 · 1 workspace"
                />
                <ChoiceRow
                  icon={<IconTile tint="violet" size="lg" shape="round" children={<ExtensionIcon />} />}
                  title="Add from the registry"
                  description="Eleven agents speak ACP"
                />
              </EmptyState>
            </SectionBody>
          </Section>

          <Section variant={knobs.sectionVariant}>
            <SectionHeader>
              <SectionTitle>Add a workspace</SectionTitle>
              <SectionDescription>Four steps; you are on the second.</SectionDescription>
            </SectionHeader>
            <SectionBody className={styles.form}>
              <Stepper steps={SETUP_STEPS} current={1} />
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
              <Field
                label="Branch"
                error="That branch has uncommitted changes in another worktree."
              >
                {(control) => (
                  <InputGroup>
                    <InputGroupAddon align="inline-start">
                      <BranchIcon />
                    </InputGroupAddon>
                    <InputGroupInput {...control} defaultValue="main" />
                  </InputGroup>
                )}
              </Field>
            </SectionBody>
            <SectionFooter>
              <ToolbarGap />
              <Button variant="ghost">Back</Button>
              <Button>Continue</Button>
            </SectionFooter>
          </Section>
        </div>
      </div>
    </div>
  )
}
