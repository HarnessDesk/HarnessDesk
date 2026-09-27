import { type ReactNode, useMemo } from 'react'

import type { AccountStatus, LedgerReport, LedgerRow, RuntimeId, RuntimeInfo, UsageReport } from '@harnessdesk/protocol'

import { burnWord } from '../../lib/burn'
import { prefsForUsage, type AccountPrefs, type AccountPrefsMap } from '../../lib/accounts'
import { formatTokens } from '../../lib/context-usage'
import {
  alignGhost,
  axisTicks as axisTicksFor,
  dayLabel,
  dayLabelWithYear,
  foldOther,
  OTHER_KEY,
  periodTotals,
  previousByRuntime,
  previousPeriod,
  shareOf,
  stackDaily,
} from '../../lib/ledger'
import { paletteTone, usageReadingTone, type Tone } from '../../lib/limits'
import {
  byUrgency,
  coverageLabel,
  describeReport,
  drawnReport,
  formatAge,
  formatCountdown,
  formatMoney,
  planLabel,
  provenanceLabel,
  pricedNote,
  spendHint,
  type LaneView,
  type ReportView,
} from '../../lib/usage'
import { readinessOf, type Readiness } from '../../lib/readiness'
import { RuntimeMark } from '../BrandIcons'
import { AlertIcon, CaretIcon, CheckIcon, InfoIcon, MoreIcon, RetryIcon, SignInIcon, SignOutIcon, UsageIcon } from '../Icons'
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertTitle,
  Button,
  Card as SurfaceCard,
  CardContent,
  CardFooter,
  CardHeader,
  Chip,
  EmptyState,
  Progress,
  SectionHead,
  Segmented,
  Separator,
  Text,
  buttonVariants,
} from '../../design'
import {
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
  ChartTools,
  DayColumns,
  Delta,
  PaceBadge,
  SegmentMeter,
  SeriesDot,
  tintFor,
  tintsFor,
  type Tint,
} from '../../design'
import { Menu, MenuItem, MenuSeparator, Popover } from '../../design'
import styles from '../Usage.module.css'

/**
 * Pieces shared by more than one Dashboard view: `Usage.tsx` (the shell) holds
 * the data loading and the rail; `components/usage/*View.tsx` each mount a
 * subset of what is drawn here. Nothing on this page decides what is true —
 * that is `lib/usage.ts`, tested without a browser — this file only draws it,
 * and only the parts more than one view draws the same way.
 */

export const PIVOTS = [
  { value: 'runtime', label: 'by agent' },
  { value: 'model', label: 'by model' },
  { value: 'project', label: 'by project' },
] as const

export type Pivot = (typeof PIVOTS)[number]['value']

/** How far back the money band looks — see `RANGES` at its use. */
export const RANGES = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
] as const

export const DEFAULT_RANGE = 30

/** One agent's colour, resolved once over the whole roster — see `Usage.tsx`. */
export type TintOf = (runtime: string) => Tint

export const tintsForRoster = (runtimes: readonly RuntimeInfo[]): TintOf => {
  const ids = runtimes.map((info) => String(info.id))
  const tints = tintsFor(ids)
  const map = new Map(ids.map((id, index) => [id, tints[index] as Tint]))
  return (runtime: string): Tint => map.get(runtime) ?? tintFor(runtime)
}

export const BandHead = ({
  name,
  note,
  action,
  className,
}: {
  name: string
  note?: ReactNode
  action?: ReactNode
  className?: string
}) => (
  <SectionHead
    sticky
    level="heading"
    className={`${styles.bandHead}${className ? ` ${className}` : ''}`}
    name={name}
    description={note}
    action={
      <>
        <span className={styles.fill} />
        {action}
      </>
    }
  />
)

/* --- the header's account scope --------------------------------------------- */

/**
 * "All accounts ▾", in every view's header, beside the title.
 *
 * The rail used to be the scope — clicking an account there is what every
 * band on the page read. Now the rail lists views, so the scope moved to the
 * one place common to all five: the header. Built on the same `Popover` +
 * `Menu` a card's own "…" already draws, not a new select — a second control
 * that means "choose one of these" would be a second thing to learn.
 */
export const ScopeControl = ({
  everyReport,
  byId,
  scope,
  onScope,
}: {
  everyReport: readonly UsageReport[]
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>
  scope: RuntimeId | null
  onScope: (scope: RuntimeId | null) => void
}) => {
  const scopedInfo = scope === null ? null : (byId.get(scope) ?? null)
  return (
    <Popover
      label={
        <>
          {scopedInfo ? scopedInfo.presentation.name : 'All accounts'}
          <CaretIcon size={12} />
        </>
      }
      title="Scope the dashboard to one account"
      triggerVariant={{ variant: 'outline' }}
      align="left"
    >
      {(close) => (
        <Menu close={close}>
          <MenuItem
            icon={<UsageIcon size={14} />}
            label="All accounts"
            selected={scope === null}
            onSelect={() => onScope(null)}
          />
          {everyReport.length > 0 && <MenuSeparator />}
          {everyReport.map((report) => {
            const info = byId.get(report.runtime) ?? null
            const name = info?.presentation.name ?? String(report.runtime)
            return (
              <MenuItem
                key={`${report.runtime}:${report.account ?? ''}`}
                icon={info ? <RuntimeMark runtime={info} size={14} /> : <UsageIcon size={14} />}
                label={report.account ? `${name} · ${report.account}` : name}
                selected={scope === report.runtime}
                onSelect={() => onScope(report.runtime)}
              />
            )
          })}
        </Menu>
      )}
    </Popover>
  )
}

/* --- who needs looking at first ------------------------------------------- */

/**
 * Whether an account's headline is worth Overview's attention: spent or low,
 * in `lib/limits`' own words for it — the same tone `toneFor` gives the
 * card's figure. A report with no plan lane at all (pay-as-you-go, a prepaid
 * balance) earns a place here only once its balance itself is spent; a quiet
 * balance sitting well above zero is not something to triage.
 */
export const reportNeedsAttention = (
  report: UsageReport,
  now: number,
  preference?: AccountPrefs,
): boolean => {
  if (report.error) return true
  const drawn = drawnReport(report)
  const view = describeReport(drawn, { now, maxLanes: 0, preference })
  if (view.hero) return view.hero.tone !== 'good'
  const balance = balanceOf(report.credits)
  return balance !== null && balance.remaining <= 0
}

/** Every tracked agent that has never answered `runtime/account`, or answered "nobody" — see `readinessOf`. */
export interface SilentAgent {
  readonly info: RuntimeInfo
  readonly reason: string
}

export const silentAgentsOf = (
  tracked: readonly RuntimeInfo[],
  snapshot: {
    readonly activeRuntime: RuntimeId | null
    readonly health: unknown
    readonly accountsByRuntime: Readonly<Partial<Record<RuntimeId, AccountStatus>>>
    readonly usage: readonly UsageReport[]
  },
): readonly SilentAgent[] =>
  tracked
    .filter(
      (info) =>
        readinessOf({
          registered: true,
          health: info.id === snapshot.activeRuntime ? (snapshot.health as never) : null,
          account: snapshot.accountsByRuntime[info.id],
          accounts: info.capabilities.account,
          usage: snapshot.usage.filter((report) => report.runtime === info.id),
        }) === 'signin',
    )
    .map((info) => ({ info, reason: 'It reports its plan once an account is connected.' }))

/* --- one account ----------------------------------------------------------- */

/**
 * Where a plan card's state comes from — a report, not an account.
 *
 * The chip sits beside the account's name, so only an account-wide limit may
 * turn it: `view.blocked`, never `report.reached`, which also names a window
 * scoped to one model. Exported for `Usage.chip.test.tsx`, the way `noteGlyph`
 * is.
 */
export const stateOf = (report: UsageReport, view: ReportView): Readiness => {
  if (report.error) return 'broken'
  if (view.blocked) return 'limit'
  return 'ready'
}

/** One account with one agent: what it has left, and how we know. */
export const Card = ({
  report,
  info,
  preference,
  now,
  onRefresh,
  onStopTracking,
}: {
  report: UsageReport
  info: RuntimeInfo | null
  preference?: AccountPrefs
  now: number
  onRefresh: () => void
  onStopTracking: () => void
}) => {
  // Another sign-in's figures are drawn, under its name; the chip is still the
  // agent's own, read from the report itself, so a spent `agy` account can
  // never put "Limit" on an agent that may be running as somebody else — and
  // a failing `agy` cannot put "Unavailable" on it either: that failure is
  // `report.unverified.error`, drawn in the note, never `report.error`.
  const drawn = drawnReport(report)
  const borrowed = drawn !== report
  const view: ReportView = describeReport(drawn, { now, maxLanes: 3, preference })
  const plan = planLabel(report.plan)
  const spend = report.spend
  // A prepaid balance is something to say, so an agent that has one is not
  // "not metered" — it is an account with nothing to run out of.
  const balance = balanceOf(report.credits)
  const state = stateOf(report, borrowed ? describeReport(report, { now, maxLanes: 0 }) : view)
  const hero = view.hero
  const agent = info?.presentation.name ?? String(report.runtime)

  // The headline. It is not a second number: it is whichever row of the table
  // below has least left, promoted — which is why the word beside it is only
  // ever "left", and which window it belongs to is said on the line under the
  // bar rather than smuggled into the figure.
  const money = spend?.windowCost != null ? formatMoney(spend.windowCost, spend.currency) : null
  const figure = hero
    ? hero.remainingPercent === null
      ? '—'
      : `${hero.remainingPercent}%`
    : balance
      ? amount(balance.remaining, balance.unit)
      : (money ?? '—')
  const word = hero
    ? 'left'
    : balance
      ? 'left on the balance'
      : report.error
        ? 'not reporting'
        : money
          ? `spent in ${spend?.windowDays ?? 0}d`
          : 'not metered'
  const note =
    borrowed && !drawn.error && view.blocked
      ? {
          text: `Everything is spent on the ${drawn.account ?? 'other sign-in'} — ${agent} may be signed in as another account`,
          tone: 'warn' as const,
        }
      : noteOf(drawn, view, balance, Boolean(spend))

  return (
    <SurfaceCard
      as="article"
      variant={hero || balance || money ? 'default' : 'muted'}
      className={styles.card}
    >
      <CardHeader className={styles.cardHead}>
        {info && (
          <Text role="muted" className={styles.cardMark}>
            <RuntimeMark runtime={info} size={15} />
          </Text>
        )}
        <Text role="subject" truncate className={styles.cardName}>{drawn.account ?? agent}</Text>
        {drawn.account && <Text role="meta" truncate className={styles.cardAgent}>{agent}</Text>}
        <span className={styles.fill} />
        <Chip state={state} {...(plan ? { label: plan } : {})} />
      </CardHeader>

      <CardContent className={styles.cardBody}>
        <div className={styles.hero}>
          <div className={styles.heroFigure}>
            <Text role="figure" tone={hero ? usageReadingTone(hero.tone) : balance || money ? undefined : 'neutral'}>{figure}</Text>
            <Text role="muted" truncate>{word}</Text>
            <span className={styles.fill} />
          {/* The pace sits beside the figure it qualifies, not in the header.
              It spent a year as the *last* of six candidates for the card's
              one line of prose, which meant the only card that ever showed it
              was one with nothing else wrong — the opposite of when it
              matters; it is a standing rather than a sentence, so it wears a
              badge. The header was the first place tried and it is the wrong
              one: an account address, an agent name, a badge and a plan chip
              on one 320px line truncated the agent to "Cur…". */}
            {hero?.burn?.forecast && <LanePace lane={hero} />}
          </div>
        {/* No lane, no meter: an empty track under a balance or a month's spend
            reads as "nothing left", which is the opposite of what those cards
            are saying. */}
          {hero && (
            <>
              <SegmentMeter
                className={styles.heroMeter}
                percent={hero.known ? (hero.remainingPercent ?? 0) : null}
                tone={paletteTone(hero.tone)}
                label={`${hero.title} — what is left`}
              />
              {resetOf(hero) && <Text as="div" role="meta" className={styles.resetLine}>{resetOf(hero)}</Text>}
            </>
          )}
        </div>

        {view.all.length > 0 && (
          <div className={styles.lanes}>
            <Separator />
          {view.all.map((lane) => (
            <div
              key={lane.id}
              className={styles.lane}
              {...(lane.id === view.heroId ? { 'data-hero': '' } : {})}
            >
              <Text className={styles.laneName} role="muted" truncate title={lane.title}>
                {lane.title}
              </Text>
              <Progress
                className={styles.laneProgress}
                value={lane.known ? lane.remainingPercent : null}
                measure="remaining"
                size="xs"
                label={false}
                aria-label={`${lane.title} — what is left`}
              />
              <Text role="muted" align="end" tone={paletteTone(lane.tone)} numeric>
                {lane.remainingPercent === null ? '—' : `${lane.remainingPercent}%`}
              </Text>
              <Text role="meta" align="end" numeric>{lane.shortCountdown ?? ''}</Text>
            </div>
          ))}
          {view.overflow > 0 && (
            <Text as="div" role="meta">
              +{view.overflow} more {view.overflow === 1 ? 'limit' : 'limits'} reported
            </Text>
          )}
          </div>
        )}

        {note && (
          <Text as="div" role="muted" tone={note.tone ? paletteTone(note.tone) : 'neutral'} className={styles.cardWord}>
            <span className={styles.cardWordIcon}>{noteGlyph(note.tone)}</span>
            <span>{note.text}</span>
          </Text>
        )}
      </CardContent>

      <CardFooter className={styles.cardFoot} {...(view.stale ? { 'data-stale': '' } : {})}>
        <Text role="meta" truncate className={styles.cardSource}>{report.source.label}</Text>
        {hero && <Text role="meta" tone={view.stale ? 'warning' : 'neutral'} className={styles.cardAge}>· {view.age}</Text>}
        <span className={styles.fill} />
        <Popover
          label={<MoreIcon size={14} />}
          title={`What to do about ${agent}`}
          triggerClassName={buttonVariants({ variant: 'muted', size: 'icon-xs' })}
          align="right"
        >
          {(close) => (
            <Menu close={close}>
              <MenuItem
                icon={<RetryIcon size={14} />}
                label="Refresh this account"
                onSelect={onRefresh}
              />
              <MenuItem
                icon={<SignOutIcon size={14} />}
                label="Stop tracking"
                hint="Nothing is asked of it. What it already spent is still counted."
                onSelect={onStopTracking}
              />
            </Menu>
          )}
        </Popover>
      </CardFooter>
    </SurfaceCard>
  )
}

/**
 * One window's standing against the rate that would make it last.
 *
 * The tone is not the lane's. A lane at 8% left is amber whatever it is
 * doing, and repeating that here would put two amber things on one card
 * saying the same thing; what this badge judges is the *rate*, so it is
 * neutral until the burn is actually going to cost something — which is the
 * moment the projection crosses the floor before the reset does.
 */
export const LanePace = ({ lane }: { lane: LaneView }) => {
  const burn = lane.burn
  if (!burn || !burn.forecast) return null
  const tone = burn.status === 'spent' ? 'danger' : burn.runsOut ? 'warning' : 'neutral'
  const outcome = burn.runsOut
    ? `runs out in ${formatCountdown(burn.etaMs ?? 0) ?? 'moments'}`
    : 'lasts to the reset'
  return (
    <PaceBadge
      status={burn.status}
      {...(burn.status === 'fresh' || burn.status === 'spent' ? {} : { margin: burn.margin })}
      tone={tone}
      word={burnWord(burn.status)}
      title={`${lane.title}: ${describeMargin(burn.margin)} — at this rate it ${outcome}.`}
    />
  )
}

const describeMargin = (margin: number): string => {
  const points = Math.abs(Math.round(margin))
  if (points === 0) return 'exactly on the sustainable rate'
  return margin > 0
    ? `${points}% more left than an even burn would have`
    : `${points}% less left than an even burn would have`
}

/* --- will it last -------------------------------------------------------- */

/**
 * The burn-down band: what is left against what an even burn would have left.
 *
 * Only when a view is scoped to one account — see `PlansView`, the one place
 * this mounts. Three of these across "All accounts" would be a wall of charts
 * answering a question nobody asked yet; scoping to an account *is* the
 * question "tell me more about this one", and this is the more.
 *
 * The lanes are the account's own, capped at three: past three the small
 * multiple stops being comparable and starts being a list.
 */
export const Runway = ({
  reports,
  now,
  accountsByRuntime,
  accountPrefs,
}: {
  reports: readonly UsageReport[]
  now: number
  accountsByRuntime: Readonly<Partial<Record<RuntimeId, AccountStatus>>>
  accountPrefs: AccountPrefsMap
}) => {
  const many = reports.length > 1
  const cards = reports.flatMap((report) => {
    const view = describeReport(report, {
      now,
      maxLanes: 8,
      preference: prefsForUsage(report.runtime, report.account, accountsByRuntime, accountPrefs),
    })
    return view.all
      .filter((lane) => lane.burn !== null)
      .slice(0, many ? 2 : 3)
      .map((lane) => ({ lane, account: many ? report.account : null, report }))
  })
  if (cards.length === 0) return null
  return (
    <section className={styles.band} aria-label="Will it last">
      <BandHead
        name="Will it last"
        note="What is left against an even burn to the reset. Above the dashed line is headroom; below it is borrowing from the rest of the window."
      />
      <div className={styles.burnRow}>
        {cards.map(({ lane, account, report }) => (
          <BurnCard
            key={`${report.runtime}:${report.account ?? ''}:${lane.id}`}
            lane={lane}
            account={account}
            now={now}
          />
        ))}
      </div>
    </section>
  )
}

const BurnCard = ({
  lane,
  account,
  now,
}: {
  lane: LaneView
  /** Whose window this is, when the agent has more than one account. */
  account: string | null
  now: number
}) => {
  const burn = lane.burn
  if (!burn) return null
  const tone = paletteTone(lane.tone)
  const untilReset = burn.resetsAt - now
  return (
    <ChartFrame>
      <ChartCard>
        <ChartHead>
          <div className={styles.burnName}>
            <ChartTitle>{lane.title}</ChartTitle>
            <ChartHint>
              {windowLength(burn.windowMs)} window
              {account ? ` · ${account}` : ''}
            </ChartHint>
          </div>
          <ChartTools>
            <LanePace lane={lane} />
          </ChartTools>
        </ChartHead>

        <div className={styles.burnBody}>
          <div className={styles.burnStats}>
            <div className={styles.heroFigure}>
              <Text role="figure">{Math.round(burn.left)}%</Text>
              <Text role="muted">left</Text>
            </div>
            <StatLine label="Resets in" value={formatCountdown(untilReset) ?? 'any moment'} />
            {/* "after reset" rather than a blank: the row is the answer to
                "will this run dry", and a row that disappears when the answer
                is no makes the reader check whether it failed to load. Past
                tense once it has: "Runs out in — budget spent" was a label
                and a value in two different tenses, and it wrapped. */}
            <StatLine
              label={burn.status === 'spent' ? 'Ran out' : burn.runsOut ? 'Runs out in' : 'Runs out'}
              value={
                burn.status === 'spent'
                  ? 'already'
                  : burn.runsOut
                    ? `~${formatCountdown(burn.etaMs ?? 0) ?? 'moments'}`
                    : 'after reset'
              }
              danger={burn.runsOut}
            />
          </div>

          <div className={styles.burnPlot}>
            <BurnDown
              elapsed={burn.elapsed}
              left={burn.left}
              projectedAt={burn.projectedAt}
              projectedLeft={burn.projectedLeft}
              forecast={burn.forecast}
              tone={tone}
              label={`${lane.title}: ${Math.round(burn.left)}% left with ${Math.round(
                (1 - burn.elapsed) * 100,
              )}% of the window to go`}
            />
            <ChartAxis
              start={burnAxisLabel(burn.startsAt, burn.windowMs)}
              end={burnAxisLabel(burn.resetsAt, burn.windowMs)}
              now={burn.elapsed}
            />
          </div>
        </div>
      </ChartCard>
    </ChartFrame>
  )
}

const StatLine = ({
  label,
  value,
  danger,
}: {
  label: string
  value: string
  danger?: boolean
}) => (
  <div className={styles.statLine}>
    <Text role="meta">{label}</Text>
    <Text role="row" tone={danger ? 'danger' : 'neutral'} numeric>
      {value}
    </Text>
  </div>
)

/**
 * The axis reads in whatever unit the window is measured in.
 *
 * A five-hour session wants clock times; anything a day or longer wants a
 * date. Weekdays were tried and are the one option that cannot work: a
 * seven-day window begins and ends on the same weekday, so both ends of the
 * axis read "Wed" — true, and no help at all in placing yourself on it.
 */
const burnAxisLabel = (at: number, windowMs: number): string =>
  new Date(at).toLocaleString(
    undefined,
    windowMs >= 86_400_000
      ? { month: 'short', day: 'numeric' }
      : { hour: 'numeric', minute: '2-digit' },
  )

/** "5-hour", "7-day" — the length in the unit a person would say it in. */
const windowLength = (ms: number): string => {
  const hours = Math.round(ms / 3_600_000)
  if (hours < 24) return `${hours}-hour`
  const days = Math.round(ms / 86_400_000)
  return `${days}-day`
}

/** A prepaid balance a card can actually print: every figure in it nameable. */
interface Balance {
  readonly remaining: number
  /** Null where the source knows what is left but not what is gone. */
  readonly used: number | null
  readonly unit: string
}

/**
 * The balance a card may print, or none at all.
 *
 * `UsageCredits.remaining` is typed `number | null` and `NaN` is a number to
 * both `typeof` and that type, so the card read it, cast it, and printed "NaN
 * credits" in the place a figure goes. `describeLimits` has refused a
 * non-finite balance since round 1 of #207 and Codex's `balanceOf` since #207
 * itself — which left the guard on the producer's side of a type that cannot
 * express the difference, protecting Settings and not the Dashboard (#225).
 * Any later meter that computes a remaining by arithmetic reopens it, and one
 * already does: `claude-file.ts` subtracts two fields of a file another
 * application writes.
 *
 * So the reading is done here, where the figure is printed. A balance nobody
 * can name is no balance: the card mutes rather than captioning a word as
 * money. `used` is read on its own, because a source may know what is left
 * without knowing what is gone. A zero balance is still a balance (#85) —
 * only what is not finite is none.
 *
 * Exported for `Usage.balance.test.tsx`, the way `stateOf` and `noteGlyph` are.
 */
export const balanceOf = (credits: UsageReport['credits']): Balance | null => {
  if (!credits) return null
  const remaining = credits.remaining
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return null
  const used = typeof credits.used === 'number' && Number.isFinite(credits.used) ? credits.used : null
  return { remaining, used, unit: credits.unit }
}

/** A balance in whatever unit the vendor keeps it in. */
const amount = (value: number, unit: string): string =>
  unit === 'USD' ? (formatMoney(value) ?? '—') : `${value.toLocaleString()} ${unit}`

/** Which window the headline belongs to, and when it comes back. */
const resetOf = (lane: LaneView): string =>
  [lane.title, lane.resetClock && `resets ${lane.resetClock}`, lane.countdown && `in ${lane.countdown}`]
    .filter(Boolean)
    .join(' · ')

/**
 * The glyph a note wears.
 *
 * The tone, not merely the presence of one. Every toned note used to draw a
 * warning triangle — including the pace line's good news, so three cards read
 * "lasts to reset" under a ⚠, beneath a heading saying "Nothing is close to a
 * limit". A warning that also means "you are fine" stops meaning anything.
 */
export const noteGlyph = (tone: Tone | undefined): ReactNode =>
  tone === undefined ? (
    <InfoIcon size={13} />
  ) : tone === 'good' ? (
    <CheckIcon size={13} />
  ) : (
    <AlertIcon size={13} />
  )

export const noteOf = (
  report: UsageReport,
  view: ReportView,
  balance: Balance | null,
  hasSpend: boolean,
): { text: string; tone?: Tone } | null => {
  if (report.error) return { text: report.error.message, tone: 'bad' }
  if (view.blocked) {
    // A prepaid balance does not come back on its own; a window does.
    return !view.hero && balance && balance.remaining <= 0
      ? { text: 'The balance is spent — new turns will fail until it is topped up', tone: 'bad' }
      : { text: 'Reached — new turns will fail until it resets', tone: 'bad' }
  }
  const gated = view.all.find((lane) => lane.gatedUntil !== null)
  if (gated) {
    return {
      text: `${gated.title} is held behind a spent window${gated.gatedFor ? ` for ${gated.gatedFor}` : ''}.`,
      tone: 'warn',
    }
  }
  // One model is out, not the account. Saying "new turns will fail" here would
  // send someone to another agent they do not need.
  if (view.reachedLane?.scope) {
    return { text: `${view.reachedLane.scope} is spent — other models still work`, tone: 'warn' }
  }
  // A balance beside a plan lane, not instead of it: the headline percentage is
  // the plan's included usage, and a pay-as-you-go balance is a second pot.
  if (view.hero && balance) {
    const used = balance.used === null ? '' : `, ${amount(balance.used, balance.unit)} used`
    return { text: `${amount(balance.remaining, balance.unit)} left on top of the plan${used}` }
  }
  // The badge in the header carries the standing now, so this line is only
  // worth its height when there is a *consequence* the badge cannot state.
  // "−33% over pace" beside "33% ahead of pace · runs out in 12h" was one
  // fact in two vocabularies on one card, and the reader has to check whether
  // they are the same number before deciding they can ignore one of them.
  if (view.pace && !view.pace.willLastToReset) {
    const eta = view.pace.etaMs === null ? null : formatCountdown(view.pace.etaMs)
    return {
      text: eta
        ? `At this rate it runs out in ${eta} — before the window resets.`
        : 'At this rate it runs out before the window resets.',
      tone: 'warn',
    }
  }
  if (!view.hero && !balance) {
    return {
      text: hasSpend
        ? 'Pay as you go — nothing to run out of. What it cost is below.'
        : 'This agent reports no plan usage here.',
    }
  }
  return null
}

/* --- what it cost -------------------------------------------------------- */

/**
 * The money band: what the window cost, its shape, and what the figure is
 * worth.
 */
const MODE_OPTIONS = [
  { value: 'bars', label: 'Bars' },
  { value: 'line', label: 'Line' },
] as const

export const Spend = ({
  ledger,
  wideLedger,
  byId,
  tintOf,
  scan,
  now,
  range,
  mode,
  onModeChange,
  onScan,
  rangeControl,
}: {
  ledger: LedgerReport | null
  /** Twice `range`'s worth of the same window, for the previous period and its ghost line. */
  wideLedger: LedgerReport | null
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>
  /** The roster's colours, resolved once — see `tintsForRoster`. */
  tintOf: TintOf
  scan: { running: boolean; filesDone: number; filesTotal: number } | null
  now: number
  range: number
  mode: 'bars' | 'line'
  onModeChange: (mode: 'bars' | 'line') => void
  onScan: () => void
  /** How far back to look. It belongs to this band: it changes nothing above it. */
  rangeControl?: ReactNode
}) => {
  const series = useMemo(() => stackDaily(ledger, now), [ledger, now])
  const wideSeries = useMemo(() => stackDaily(wideLedger, now), [wideLedger, now])
  const currency = ledger?.currency ?? 'USD'
  const money = (value: number): string => formatMoney(value, currency) ?? '—'

  const headline =
    ledger === null ? '—' : ledger.totalCost === null ? 'unpriced' : money(series.total)

  const previous = useMemo(
    () => previousPeriod(wideSeries, range, series.total),
    [wideSeries, range, series.total],
  )
  const ghost = useMemo(
    () => alignGhost(series.days.length, previous.daily),
    [series.days.length, previous.daily],
  )
  const ceiling = useMemo(() => {
    const previousPeak = previous.daily.reduce((high, day) => Math.max(high, day.total), 0)
    return axisTicksFor(Math.max(series.peak, previousPeak))
  }, [series.peak, previous.daily])

  const periods = useMemo(
    () => periodTotals(series, [1, 7, 30].filter((span) => span < series.days.length)),
    [series],
  )

  const runtimes = useMemo(
    () =>
      series.keys.map((runtime) => ({
        key: String(runtime),
        label: byId.get(runtime)?.presentation.name ?? String(runtime),
        tint: tintOf(String(runtime)),
      })),
    [series.keys, byId, tintOf],
  )

  const buckets = useMemo(
    () =>
      series.days.map((day) => ({
        label: dayLabelWithYear(day.day),
        total: day.total,
        parts: day.parts,
        unknown: day.unknown,
      })),
    [series.days],
  )
  const todayIndex = buckets.length - 1

  return (
    <section className={styles.band} aria-label="What it cost">
      <BandHead
        name="What it cost"
        action={
          <div className={styles.costControls}>
            <Segmented
              label="Bars or line"
              options={MODE_OPTIONS}
              value={mode}
              onChange={(next) => onModeChange(next as 'bars' | 'line')}
            />
            {rangeControl}
          </div>
        }
      />

      <ChartFrame>
        <ChartCard className={styles.costHead}>
          <ChartHead>
            <div>
              <ChartTitle figure>{headline}</ChartTitle>
              <ChartHint>
                Last {ledger?.days ?? range} days — {spendHint(ledger?.provenance)}
              </ChartHint>
            </div>
            {previous.change !== null && (
              <Delta
                value={Math.round(previous.change)}
                better="down"
                caption={`vs the ${range} days before`}
              />
            )}
          </ChartHead>
          <div className={styles.periods}>
            {periods.map((period) => (
              <div key={period.days} className={styles.period}>
                <Text role="meta">{period.label}</Text>
                <Text role="metric">{money(period.cost)}</Text>
                {period.partial ? (
                  <Text role="meta">so far</Text>
                ) : (
                  period.change !== null && (
                    <Delta
                      value={Math.round(period.change)}
                      better="down"
                      caption={`vs the ${period.days} days before`}
                    />
                  )
                )}
              </div>
            ))}
          </div>
        </ChartCard>

        <ChartCard className={styles.costPlot}>
          {series.peak > 0 || previous.total > 0 ? (
            <>
              <DayColumns
                buckets={buckets}
                series={runtimes}
                format={money}
                label={`Spend per day for the last ${series.days.length} days`}
                emptyLabel="Nothing spent"
                mode={mode}
                ghost={ghost}
                today={todayIndex}
                axisTicks={ceiling}
                previousLabel="Previous"
              />
              <ChartAxis
                start={dayLabel(series.days[0]?.day ?? now)}
                end={dayLabel(series.days[series.days.length - 1]?.day ?? now)}
              />
              {mode === 'bars' && runtimes.length > 1 && (
                <ChartKeys>
                  {runtimes.map((entry) => (
                    <ChartKey key={entry.key} tint={entry.tint} label={entry.label} />
                  ))}
                </ChartKeys>
              )}
            </>
          ) : (
            <EmptyState
              tight
              className={styles.chartEmpty}
              title={scan?.running ? 'Reading transcripts' : 'No priced usage in this window yet'}
              description={scan?.running ? `${scan.filesDone} of ${scan.filesTotal} files` : undefined}
            />
          )}
        </ChartCard>

        <ChartFoot>
          <Text role="meta" className={styles.costWord}>{coverageSentence(ledger)}</Text>
          <span className={styles.fill} />
          <Button size="sm" variant="ghost" disabled={scan?.running} onClick={onScan}>
            {scan?.running ? `Scanning ${scan.filesDone}/${scan.filesTotal}` : 'Rescan'}
          </Button>
        </ChartFoot>
      </ChartFrame>
    </section>
  )
}

const coverageSentence = (ledger: LedgerReport | null): string => {
  if (!ledger) return 'Nothing has been scanned yet.'
  const parts: string[] = [provenanceLabel(ledger)]
  if (ledger.totalTokens !== null) parts.push(`${formatTokens(ledger.totalTokens)} tokens`)
  const { priced, unpriced } = ledger.coverage
  if (unpriced > 0) {
    parts.push(
      `${unpriced.toLocaleString()} of ${(priced + unpriced).toLocaleString()} calls carry no public price`,
    )
  }
  const covered = coverageLabel(ledger)
  if (covered) parts.push(covered)
  return parts.join(' · ')
}

/* --- where it went ------------------------------------------------------- */

const RANKED_LIMIT = 6

export const rankedChange = (current: number | null, previous: number | null): number | null => {
  if (current === null || previous === null || previous === 0) return null
  return ((current - previous) / previous) * 100
}

export const Ranked = ({
  ledger,
  wideLedger,
  pivot,
  range,
  now,
  byId,
  tintOf,
}: {
  ledger: LedgerReport | null
  wideLedger: LedgerReport | null
  pivot: Pivot
  range: number
  now: number
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>
  tintOf: TintOf
}) => {
  const previous = useMemo(
    () => (pivot === 'runtime' ? previousByRuntime(stackDaily(wideLedger, now), range) : null),
    [pivot, wideLedger, range, now],
  )

  if (!ledger || ledger.rows.length === 0) {
    return <EmptyState tight title="Nothing recorded in this window" />
  }
  const { shown, other } = foldOther(ledger.rows, RANKED_LIMIT)
  const rows = other ? [...shown, other] : shown
  const total = ledger.rows.reduce((sum, row) => sum + (row.cost ?? 0), 0)
  const unpriced = ledger.rows.filter((row) => row.hasUnpriced).length
  const nameOf = (row: LedgerRow): string =>
    row.key === OTHER_KEY
      ? row.label
      : pivot === 'runtime'
        ? (byId.get(row.key as RuntimeId)?.presentation.name ?? row.label)
        : row.label
  const tints = tintsFor(rows.map((row) => row.key))
  const tintAt = (index: number, row: LedgerRow): Tint =>
    row.key !== OTHER_KEY && pivot === 'runtime' ? tintOf(row.key) : (tints[index] as Tint)

  return (
    <>
      <SegmentMeter
        className={styles.distribution}
        label="Where it went, by share"
        parts={rows
          .map((row, index) => ({ key: row.key, tint: tintAt(index, row), value: row.cost ?? 0 }))
          .filter((part) => part.value > 0)}
      />

      <SurfaceCard className={styles.ranked}>
        {rows.map((row, index) => {
          const info = row.runtime ? byId.get(row.runtime) : null
          const label = nameOf(row)
          const share = shareOf(row.cost, total)
          const change =
            row.key === OTHER_KEY
              ? null
              : rankedChange(row.cost, previous?.complete ? (previous.totals.get(row.key as RuntimeId) ?? null) : null)
          return (
            <CardContent key={row.key} className={styles.rank} data-pivot={pivot}>
              <Text role="meta" className={styles.rankMark}>
                {row.key === OTHER_KEY ? (
                  <SeriesDot tint={tintAt(index, row)} />
                ) : pivot === 'runtime' ? (
                  <RuntimeMark
                    runtime={info ?? byId.get(row.key as RuntimeId) ?? fallbackInfo(row.key)}
                    size={15}
                  />
                ) : (
                  <SeriesDot tint={tintAt(index, row)} />
                )}
              </Text>
              <Text role="subject" truncate title={label}>
                {label}
              </Text>
              {pivot === 'runtime' && (
                <span className={styles.rankChange}>
                  {change !== null && <Delta value={Math.round(change)} better="down" />}
                </span>
              )}
              <Text role="muted" align="end" numeric>
                {share === null ? '' : share < 1 ? '<1%' : `${Math.round(share)}%`}
              </Text>
              <Text role="muted" align="end" numeric>
                {row.tokens === null ? '—' : formatTokens(row.tokens)}
              </Text>
              <Text role="value" align="end" numeric>
                {row.cost === null ? 'unpriced' : (formatMoney(row.cost, ledger.currency) ?? '—')}
              </Text>
            </CardContent>
          )
        })}
      </SurfaceCard>
      <Text as="div" role="meta">
        {pricedNote(unpriced, ledger.provenance)}
      </Text>
    </>
  )
}

const fallbackInfo = (id: string): { id: string; presentation: { name: string } } => ({
  id,
  presentation: { name: id },
})

/** The "N agents don't report usage" callout, drawn wherever a view needs one — Plans, in full, and Overview, as one line. */
export const AsleepAlert = ({
  silent,
  onSignIn,
}: {
  silent: SilentAgent
  onSignIn?: (runtime: RuntimeId) => void
}) => (
  <Alert className={styles.callout} tone="neutral">
    <SignInIcon size={18} />
    <AlertContent>
      <AlertTitle>{silent.info.presentation.name} has nothing to report</AlertTitle>
      <AlertDescription>
        {silent.reason} Until then this screen is missing its share.
      </AlertDescription>
    </AlertContent>
    {onSignIn && (
      <Button variant="default" onClick={() => onSignIn(silent.info.id)}>
        Sign in to {silent.info.presentation.name}
      </Button>
    )}
  </Alert>
)

export type { Tone }
