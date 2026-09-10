import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type {
  LedgerReport,
  LedgerRow,
  RuntimeId,
  RuntimeInfo,
  UsageReport,
} from '@harnessdesk/protocol'

import { burnWord } from '../lib/burn'
import { formatTokens } from '../lib/context-usage'
import { dayLabel, dayLabelLong, periodTotals, shareOf, stackDaily } from '../lib/ledger'
import { paletteTone, type Tone } from '../lib/limits'
import { readinessOf, type Readiness } from '../lib/readiness'
import {
  byUrgency,
  coverageLabel,
  describeReport,
  formatAge,
  formatCountdown,
  formatMoney,
  planLabel,
  provenanceLabel,
  runway,
  type LaneView,
  type ReportView,
} from '../lib/usage'
import { useSnapshot, useStore } from '../state/context'
import { AppWindow, WindowGroup, WindowNav, WindowPage } from './AppWindow'
import { RuntimeMark } from './BrandIcons'
import {
  AlertIcon,
  CheckIcon,
  InfoIcon,
  MoreIcon,
  RetryIcon,
  SignInIcon,
  SignOutIcon,
  UsageIcon,
} from './Icons'
import { Btn, Chip, PageHead, Segmented } from '../design/primitives/Kit'
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
  Donut,
  PaceBadge,
  SegmentMeter,
  SeriesDot,
  tintFor,
  tintsFor,
  type Tint,
} from '../design/ui'
import { Menu, MenuItem } from './Menu'
import { dismissOverlays, Popover } from './Popover'
import styles from './Usage.module.css'

/**
 * Usage — what every plan has left, when it comes back, and what it cost.
 *
 * Design and rationale: `docs/usage-dashboard.md`. Everything true on this
 * screen is decided in `lib/usage.ts`, which is tested without a browser; this
 * file only draws. In particular it never picks the headline lane itself, and
 * it never names an agent — every name comes from `RuntimeInfo.presentation`.
 *
 * Three bands, and the order is the order of the questions people arrive
 * with: what is left, what it cost, where it went. The first is the only one
 * that can stop work, so it is the one at the top and the only one whose
 * figures are large.
 *
 * The rail lists **accounts**, not bands. It held the three band names for a
 * while, which made three rows that looked like tabs and only scrolled a page
 * that mostly does not scroll; and the thing you actually want to do here —
 * look at one account — was a segmented control wedged into the first band's
 * header. Now the rail is the scope, each row carrying the one figure that
 * account is about, and the band names stick to the top of the page as you
 * pass them.
 */

const PIVOTS = [
  { value: 'runtime', label: 'by agent' },
  { value: 'model', label: 'by model' },
  { value: 'project', label: 'by project' },
] as const

type Pivot = (typeof PIVOTS)[number]['value']

/**
 * How far back the money band looks.
 *
 * A week answers "what am I spending now", a month is the billing cycle most
 * plans run on, and a quarter is the one that shows a habit. Longer than the
 * ledger has scanned is not an error — the line under the chart says how many
 * of those days it actually holds.
 */
const RANGES = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
] as const

const DEFAULT_RANGE = 30

export const Usage = ({
  onClose,
  onSignIn,
  runtime = null,
}: {
  onClose: () => void
  /** Opening the sign-in window from the agent that has nothing to report. */
  onSignIn?: (runtime: RuntimeId) => void
  /** Opened from one agent's meter: that agent is the one shown. */
  runtime?: RuntimeId | null
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [now, setNow] = useState(() => Date.now())
  const [pivot, setPivot] = useState<Pivot>('runtime')
  const [range, setRange] = useState<number>(DEFAULT_RANGE)
  const [scope, setScope] = useState<RuntimeId | null>(runtime)
  const [ledger, setLedger] = useState<LedgerReport | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(dismissOverlays, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Countdowns are the point of half this screen, so the clock has to move.
  // Once a minute is enough for figures measured in hours and days.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    void store.loadUsage()
  }, [store])

  // While the screen is open someone is looking, which is the only time a
  // network source is worth asking again.
  useEffect(() => {
    const timer = window.setInterval(() => void store.refreshUsage(), 120_000)
    return () => window.clearInterval(timer)
  }, [store])

  useEffect(() => {
    let cancelled = false
    void store
      .ledger({ days: range, groupBy: pivot, ...(scope ? { runtime: scope } : {}) })
      .then((report) => {
        if (!cancelled) setLedger(report)
      })
    return () => {
      cancelled = true
    }
  }, [store, pivot, scope, range, snapshot.scan?.finishedAt])

  const off = useMemo(() => new Set(snapshot.usageOff), [snapshot.usageOff])
  const tracked = useMemo(
    () => snapshot.runtimes.filter((info) => !off.has(info.id)),
    [snapshot.runtimes, off],
  )
  const untracked = useMemo(
    () => snapshot.runtimes.filter((info) => off.has(info.id)),
    [snapshot.runtimes, off],
  )

  // Scoping to an agent and then switching it off would leave the screen
  // showing one card that is not there any more.
  useEffect(() => {
    if (scope !== null && off.has(scope)) setScope(null)
  }, [scope, off])

  const byId = useMemo(
    () => new Map(snapshot.runtimes.map((info) => [info.id, info] as const)),
    [snapshot.runtimes],
  )
  const nameOf = (id: RuntimeId): string => byId.get(id)?.presentation.name ?? String(id)

  /**
   * One colour per agent, decided over the whole roster rather than over
   * whatever is currently on screen.
   *
   * `tintsFor` guarantees no two members of a set share a hue, which is what a
   * legend needs — but only *within* that set. Handing it the agents that
   * happen to have spent something made the set change with the range control
   * and with the rail: clicking Cursor scoped the ledger to one runtime, the
   * set became a single name, and Cursor's own columns changed colour on that
   * click alone. Resolving against every registered agent instead means the
   * set never changes, so an agent keeps one colour across the money chart,
   * the doughnut, the ranked rows, every range and every scope.
   */
  const agentTints = useMemo(() => {
    const ids = snapshot.runtimes.map((info) => String(info.id))
    const tints = tintsFor(ids)
    const map = new Map(ids.map((id, index) => [id, tints[index] as Tint]))
    return (runtime: string): Tint => map.get(runtime) ?? tintFor(runtime)
  }, [snapshot.runtimes])

  // Every registered agent gets a card, whether or not it reported anything:
  // "why is this one missing" is a question the screen has to answer.
  const everyReport = useMemo(() => {
    // The host already stops reporting a switched-off agent; filtering here
    // too is what makes the switch feel immediate rather than round-trip.
    const metered = snapshot.usage.filter((report) => !off.has(report.runtime))
    const known = new Set(metered.map((report) => report.runtime))
    const silent: UsageReport[] = tracked
      .filter((info) => !known.has(info.id))
      .map((info) => ({
        runtime: info.id,
        account: null,
        plan: null,
        lanes: [],
        credits: null,
        spend: null,
        reached: null,
        source: { kind: 'runtime', label: 'no source available' },
        fetchedAt: now,
        staleAfterMs: Number.POSITIVE_INFINITY,
        error: null,
      }))
    return byUrgency([...metered, ...silent])
  }, [snapshot.usage, tracked, off, now])

  // The rail lists every account whatever the scope is — a filter you cannot
  // see the other side of is a trap.
  const reports = useMemo(
    () => (scope === null ? everyReport : everyReport.filter((report) => report.runtime === scope)),
    [everyReport, scope],
  )

  const summary = useMemo(
    () => runway(reports, (report) => nameOf(report.runtime), now),
    // `nameOf` closes over the runtime map, which is what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reports, byId, now],
  )

  /** The agent with nothing to report because nobody has signed it in. */
  const asleep = useMemo(
    () =>
      tracked.find(
        (info) =>
          readinessOf({
            registered: true,
            health: info.id === snapshot.activeRuntime ? snapshot.health : null,
            account: snapshot.accountsByRuntime[info.id],
            accounts: info.capabilities.account,
            usage: snapshot.usage.filter((report) => report.runtime === info.id),
          }) === 'signin',
      ) ?? null,
    [tracked, snapshot.accountsByRuntime, snapshot.usage, snapshot.health, snapshot.activeRuntime],
  )

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    await store.refreshUsage(scope ?? undefined)
    setRefreshing(false)
  }

  const oldest = snapshot.usage.reduce<number | null>(
    (at, report) => (at === null ? report.fetchedAt : Math.min(at, report.fetchedAt)),
    null,
  )

  const scoped = scope === null ? null : (byId.get(scope) ?? null)

  return (
    <AppWindow label="Dashboard">
      <WindowNav onBack={onClose}>
        <WindowGroup label="Accounts">
          <RailRow
            mark={<UsageIcon size={14} />}
            name="All accounts"
            figure={String(everyReport.length)}
            selected={scope === null}
            onClick={() => setScope(null)}
          />
          {everyReport.map((report) => (
            <AccountRow
              key={`${report.runtime}:${report.account ?? ''}`}
              report={report}
              info={byId.get(report.runtime) ?? null}
              now={now}
              selected={scope === report.runtime}
              onClick={() => setScope(report.runtime)}
            />
          ))}
        </WindowGroup>

        {untracked.length > 0 && (
          <WindowGroup label="Not tracked">
            {untracked.map((info) => (
              <RailRow
                key={info.id}
                mark={<RuntimeMark runtime={info} size={15} />}
                name={info.presentation.name}
                action="Track"
                sub="Nothing is asked of it"
                selected={false}
                onClick={() => store.setUsageTracked(info.id, true)}
              />
            ))}
          </WindowGroup>
        )}

        <div className={styles.navFoot}>
          {oldest !== null && <span className={styles.age}>Read {formatAge(oldest, now)}</span>}
          <Btn small disabled={refreshing} onClick={() => void refresh()}>
            <RetryIcon size={13} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Btn>
        </div>
      </WindowNav>

      <WindowPage wide>
        <PageHead
          title={scoped ? scoped.presentation.name : 'Dashboard'}
          blurb={
            scoped
              ? `One agent's plans, spend and history, read from ${scoped.presentation.name}'s own numbers on this machine.`
              : 'What every plan has left, what the work cost at public rates, and where it went, read from each agent’s own numbers on this machine.'
          }
        />

        <div className={styles.body}>
          <section className={styles.band} aria-label="What is left">
            <div className={styles.bandHead}>
              <span className={styles.bandTitle}>What is left</span>
              <span className={styles.bandNote}>{summary.headline}</span>
            </div>

            <div className={styles.cards}>
              {reports.map((report) => (
                <Card
                  key={`${report.runtime}:${report.account ?? ''}`}
                  report={report}
                  info={byId.get(report.runtime) ?? null}
                  now={now}
                  onRefresh={() => void store.refreshUsage(report.runtime)}
                  onStopTracking={() => store.setUsageTracked(report.runtime, false)}
                />
              ))}
            </div>

            {/* Not while the rail is showing somebody else: an offer to sign in
                to an agent whose card is filtered out has nothing to attach
                itself to. */}
            {asleep && (scope === null || scope === asleep.id) && (
              <div className={styles.callout}>
                <span className={styles.calloutIcon}>
                  <SignInIcon size={18} />
                </span>
                <span className={styles.calloutText}>
                  <span className={styles.calloutTitle}>
                    {asleep.presentation.name} has nothing to report
                  </span>
                  <span className={styles.calloutHint}>
                    It reports its plan once an account is connected — until then this screen is
                    missing its share.
                  </span>
                </span>
                {onSignIn && (
                  <Btn variant="primary" onClick={() => onSignIn(asleep.id)}>
                    Sign in to {asleep.presentation.name}
                  </Btn>
                )}
              </div>
            )}
          </section>

          {/* Only when the rail is on one agent: see `Runway`. Its own lanes
              decide whether it draws anything at all, so an agent with no
              plottable window costs no heading. */}
          {scoped && <Runway reports={reports} now={now} />}

          <Spend
            ledger={ledger}
            byId={byId}
            tintOf={agentTints}
            scan={snapshot.scan}
            now={now}
            range={range}
            onScan={() => void store.scanUsage()}
            rangeControl={
              <Segmented
                label="How far back"
                options={RANGES}
                value={String(range)}
                onChange={(next) => setRange(Number(next))}
              />
            }
          />

          <section className={styles.band} aria-label="Where it went">
            <div className={styles.bandHead}>
              <span className={styles.bandTitle}>Where it went</span>
              <span className={styles.fill} />
              <Segmented label="Group spend by" options={PIVOTS} value={pivot} onChange={setPivot} />
            </div>
            <Ranked ledger={ledger} pivot={pivot} byId={byId} tintOf={agentTints} />
          </section>
        </div>
      </WindowPage>
    </AppWindow>
  )
}

/* --- the rail ------------------------------------------------------------ */

/**
 * One row of the rail: a mark, a name, one figure, and a meter under both.
 *
 * The meter is the row's second line rather than a column of its own, because
 * a 3px rule beside a percentage reads as that percentage's own bar — which
 * is exactly what it is.
 */
const RailRow = ({
  mark,
  name,
  title,
  figure,
  tone,
  percent,
  sub,
  action,
  selected,
  onClick,
}: {
  mark: ReactNode
  name: string
  /** The full account, when the row had to shorten it. */
  title?: string
  figure?: string
  tone?: Tone
  /** What is left, drawn as the row's meter. Absent when nothing is measured. */
  percent?: number | null
  /** A word instead of a meter, for a row with nothing to measure. */
  sub?: string
  /** An offer rather than a figure — the one row that does something. */
  action?: string
  selected: boolean
  onClick: () => void
}) => (
  <button
    type="button"
    className={styles.acct}
    {...(selected ? { 'data-selected': '' } : {})}
    {...(title ? { title } : {})}
    onClick={onClick}
  >
    <span className={styles.acctMark}>{mark}</span>
    <span className={styles.acctName}>{name}</span>
    {action ? (
      <span className={styles.acctAdd}>{action}</span>
    ) : (
      <span className={styles.acctFigure} {...(tone ? { 'data-tone': tone } : {})}>
        {figure}
      </span>
    )}
    {percent !== undefined && percent !== null ? (
      <span className={styles.acctTrack}>
        <span
          className={styles.acctFill}
          {...(tone ? { 'data-tone': tone } : {})}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </span>
    ) : sub ? (
      <span className={styles.acctSub}>{sub}</span>
    ) : null}
  </button>
)

const AccountRow = ({
  report,
  info,
  now,
  selected,
  onClick,
}: {
  report: UsageReport
  info: RuntimeInfo | null
  now: number
  selected: boolean
  onClick: () => void
}) => {
  // No lanes below the headline: the rail asks one question of each account.
  const view = describeReport(report, { now, maxLanes: 0 })
  const left = view.hero?.remainingPercent ?? null
  const agent = info?.presentation.name ?? String(report.runtime)
  return (
    <RailRow
      mark={info ? <RuntimeMark runtime={info} size={15} /> : <UsageIcon size={14} />}
      name={agent}
      {...(report.account ? { title: `${agent} · ${report.account}` } : {})}
      figure={left === null ? '—' : `${left}%`}
      {...(view.hero ? { tone: view.hero.tone } : {})}
      percent={left}
      {...(left === null && report.account ? { sub: report.account } : {})}
      selected={selected}
      onClick={onClick}
    />
  )
}

/* --- one account --------------------------------------------------------- */

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
const Card = ({
  report,
  info,
  now,
  onRefresh,
  onStopTracking,
}: {
  report: UsageReport
  info: RuntimeInfo | null
  now: number
  onRefresh: () => void
  onStopTracking: () => void
}) => {
  const view: ReportView = describeReport(report, { now, maxLanes: 3 })
  const plan = planLabel(report.plan)
  const spend = report.spend
  // A prepaid balance is something to say, so an agent that has one is not
  // "not metered" — it is an account with nothing to run out of.
  const credits = report.credits
  const balance = credits?.remaining !== undefined && credits.remaining !== null ? credits : null
  const state = stateOf(report, view)
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
      ? amount(balance.remaining as number, balance.unit)
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
  const note = noteOf(report, view, balance, Boolean(spend))

  return (
    <article
      className={styles.card}
      {...(hero || balance || money ? {} : { 'data-muted': '' })}
    >
      <div className={styles.cardHead}>
        {info && (
          <span className={styles.cardMark}>
            <RuntimeMark runtime={info} size={15} />
          </span>
        )}
        <span className={styles.cardName}>{report.account ?? agent}</span>
        {report.account && <span className={styles.cardAgent}>{agent}</span>}
        <span className={styles.fill} />
        <Chip state={state} {...(plan ? { label: plan } : {})} />
      </div>

      <div className={styles.hero}>
        <div className={styles.heroFigure}>
          <span className={styles.figure}>{figure}</span>
          <span className={styles.figureWord}>{word}</span>
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
            {resetOf(hero) && <div className={styles.resetLine}>{resetOf(hero)}</div>}
          </>
        )}
      </div>

      {view.all.length > 0 && (
        <div className={styles.lanes}>
          {view.all.map((lane) => (
            <div
              key={lane.id}
              className={styles.lane}
              {...(lane.id === view.heroId ? { 'data-hero': '' } : {})}
            >
              <span className={styles.laneName} title={lane.title}>
                {lane.title}
              </span>
              <span
                className={styles.laneTrack}
                {...(lane.known ? {} : { 'data-unknown': '' })}
              >
                <span
                  className={styles.laneFill}
                  data-tone={lane.tone}
                  style={{ width: `${Math.min(100, lane.remainingPercent ?? 0)}%` }}
                />
              </span>
              <span className={styles.laneFigure} data-tone={lane.tone}>
                {lane.remainingPercent === null ? '—' : `${lane.remainingPercent}%`}
              </span>
              <span className={styles.laneWhen}>{lane.shortCountdown ?? ''}</span>
            </div>
          ))}
          {view.overflow > 0 && (
            <div className={styles.laneMore}>
              +{view.overflow} more {view.overflow === 1 ? 'limit' : 'limits'} reported
            </div>
          )}
        </div>
      )}

      {note && (
        <div className={styles.cardWord} {...(note.tone ? { 'data-tone': note.tone } : {})}>
          <span className={styles.cardWordIcon}>{noteGlyph(note.tone)}</span>
          <span>{note.text}</span>
        </div>
      )}

      <div className={styles.cardFoot} {...(view.stale ? { 'data-stale': '' } : {})}>
        <span className={styles.cardSource}>{report.source.label}</span>
        {hero && <span className={styles.cardAge}>· {view.age}</span>}
        <span className={styles.fill} />
        <Popover
          label={<MoreIcon size={14} />}
          title={`What to do about ${agent}`}
          triggerClassName={styles.footMore}
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
      </div>
    </article>
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
const LanePace = ({ lane }: { lane: LaneView }) => {
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
 * Only when the rail is on one account, and that is the whole argument for
 * it. Three of these across the "All accounts" view would be a wall of charts
 * answering a question nobody asked yet — the first screen is triage, and
 * triage wants one figure per account. Scoping to an account *is* the
 * question "tell me more about this one", and this is the more.
 *
 * The lanes are the account's own, capped at three: past three the small
 * multiple stops being comparable and starts being a list.
 */
const Runway = ({ reports, now }: { reports: readonly UsageReport[]; now: number }) => {
  /*
   * Every account the scoped agent has, not the first one that sorted.
   *
   * The rail scopes by *runtime*, and one agent can hold several accounts —
   * the cards above are keyed `${runtime}:${account}` for exactly that reason.
   * Taking `reports[0]` drew the burn-down for whichever happened to sort
   * first and named it nowhere, so with two accounts signed in the band was a
   * chart belonging to one of the two cards above it and the reader had no way
   * to tell which. Now every account contributes, each card says whose window
   * it is as soon as there is more than one, and the per-account cap tightens
   * so the band stays a row of comparable charts rather than a list.
   */
  const many = reports.length > 1
  const cards = reports.flatMap((report) => {
    const view = describeReport(report, { now, maxLanes: 8 })
    return view.all
      .filter((lane) => lane.burn !== null)
      .slice(0, many ? 2 : 3)
      .map((lane) => ({ lane, account: many ? report.account : null, report }))
  })
  if (cards.length === 0) return null
  return (
    <section className={styles.band} aria-label="Will it last">
      <div className={styles.bandHead}>
        <span className={styles.bandTitle}>Will it last</span>
        <span className={styles.bandNote}>
          What is left against an even burn to the reset. Above the dashed line is headroom;
          below it is borrowing from the rest of the window.
        </span>
      </div>
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
              <span className={styles.figure}>{Math.round(burn.left)}%</span>
              <span className={styles.figureWord}>left</span>
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
    <span className={styles.statLabel}>{label}</span>
    <span className={styles.statValue} {...(danger ? { 'data-tone': 'bad' } : {})}>
      {value}
    </span>
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

/** A balance in whatever unit the vendor keeps it in. */
const amount = (value: number, unit: string): string =>
  unit === 'USD' ? (formatMoney(value) ?? '—') : `${value.toLocaleString()} ${unit}`

/** Which window the headline belongs to, and when it comes back. */
const resetOf = (lane: LaneView): string =>
  [lane.title, lane.resetClock && `resets ${lane.resetClock}`, lane.countdown && `in ${lane.countdown}`]
    .filter(Boolean)
    .join(' · ')

/**
 * The one line of prose a card is allowed, and only when something needs
 * saying in words.
 *
 * A card used to carry five of these stacked at one size — the reset, a
 * sentence per lane, the overflow, the balance, the pace and the spend — and
 * a column of unrelated sentences at one weight is what a log looks like.
 * Everything with a number in it now has a column; what is left here is the
 * caveat, and there is only ever one.
 */
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

const noteOf = (
  report: UsageReport,
  view: ReportView,
  balance: { remaining: number | null; used?: number | null; unit: string } | null,
  hasSpend: boolean,
): { text: string; tone?: Tone } | null => {
  if (report.error) return { text: report.error.message, tone: 'bad' }
  if (view.blocked) return { text: 'Reached — new turns will fail until it resets', tone: 'bad' }
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
    const used = typeof balance.used === 'number' ? `, ${amount(balance.used, balance.unit)} used` : ''
    return { text: `${amount(balance.remaining as number, balance.unit)} left on top of the plan${used}` }
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
 *
 * Three things changed here and each was a fact the band already held and
 * threw away. The **shorter periods** — today, a week — are arithmetic on the
 * days already loaded, and a total with nothing beside it cannot be read:
 * $6,472 is either alarming or unremarkable depending on last month, which is
 * in the same array. The **split by agent** was in `LedgerDay` all along; the
 * chart summed it into one grey column, so a $40 Tuesday spent three ways
 * looked exactly like a $40 Tuesday spent by one agent, and the ranked table
 * below had nothing above it to explain. And the **tooltip** is the app's own
 * rather than the browser's `title`, which took a second to appear, could not
 * hold a breakdown, and was invisible to a keyboard.
 */
const Spend = ({
  ledger,
  byId,
  tintOf,
  scan,
  now,
  range,
  onScan,
  rangeControl,
}: {
  ledger: LedgerReport | null
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>
  /** The roster's colours, resolved once — see `agentTints` in `Usage`. */
  tintOf: (runtime: string) => Tint
  scan: { running: boolean; filesDone: number; filesTotal: number } | null
  now: number
  range: number
  onScan: () => void
  /** How far back to look. It belongs to this band: it changes nothing above it. */
  rangeControl?: ReactNode
}) => {
  const series = useMemo(() => stackDaily(ledger, now), [ledger, now])
  const currency = ledger?.currency ?? 'USD'
  const money = (value: number): string => formatMoney(value, currency) ?? '—'

  /*
   * The headline, and the two states that are not a figure.
   *
   * `stackDaily` always answers with a number, so reading its total alone
   * painted a confident `$0` in 34px for the whole of the first round-trip —
   * on every open of the screen, because the ledger arrives asynchronously —
   * and again for a window where nothing could be priced at all, where the
   * footer underneath was simultaneously saying "Spend unavailable". The
   * ledger's own `totalCost` is the field that distinguishes them: the host
   * sets it to null deliberately when nothing in the window has a public
   * price. The *figure* stays the chart's own sum so the headline and the
   * columns under it cannot disagree; only the two empty states come from
   * the report.
   */
  const headline =
    ledger === null ? '—' : ledger.totalCost === null ? 'unpriced' : money(series.total)

  // The comparison periods, which are by definition *shorter* than the
  // window: the window's own total is the headline above them, and repeating
  // it as a third tile made the band answer one question twice. Each carries
  // its change against the period of the same length before it, which is the
  // thing that makes a total readable — $422 is either a quiet week or an
  // alarming one, and only the week before it says which.
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
        label: dayLabelLong(day.day),
        total: day.total,
        parts: day.parts,
      })),
    [series.days],
  )

  return (
    <section className={styles.band} aria-label="What it cost">
      <div className={styles.bandHead}>
        <span className={styles.bandTitle}>What it cost</span>
        <span className={styles.fill} />
        {rangeControl}
      </div>

      <ChartFrame>
        {/* Two surfaces inside one frame, separated by the frame's own gutter:
            the figures the band is about, and the plot they came from. A rule
            between them would be a third line in a card that already has a
            border and a baseline. */}
        <ChartCard className={styles.costHead}>
          <ChartHead>
            <div>
              <ChartTitle>{headline}</ChartTitle>
              <ChartHint>
                Last {ledger?.days ?? range} days — what these tokens would have cost at public
                API rates. Not a bill.
              </ChartHint>
            </div>
          </ChartHead>
          <div className={styles.periods}>
            {periods.map((period) => (
              <div key={period.days} className={styles.period}>
                <span className={styles.periodLabel}>{period.label}</span>
                <span className={styles.periodValue}>{money(period.cost)}</span>
                {/* Today carries no percentage and says "so far" instead. A day
                    still running measured against a whole one falls every
                    morning and recovers by evening, which is a property of the
                    clock rather than of the spending — and those two words are
                    also what tell a reader that the finished window beside it
                    is a different kind of figure. */}
                {period.partial ? (
                  <span className={styles.periodNote}>so far</span>
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
          {series.peak > 0 ? (
            <>
              <DayColumns
                buckets={buckets}
                series={runtimes}
                format={money}
                label={`Spend per day for the last ${series.days.length} days`}
                emptyLabel="Nothing spent"
              />
              <ChartAxis
                start={dayLabel(series.days[0]?.day ?? now)}
                end={dayLabel(series.days[series.days.length - 1]?.day ?? now)}
              />
              {/* Only when the stack is actually stacked: a legend naming the
                  one series a single-colour chart already is says nothing. */}
              {runtimes.length > 1 && (
                <ChartKeys>
                  {runtimes.map((entry) => (
                    <ChartKey key={entry.key} tint={entry.tint} label={entry.label} />
                  ))}
                </ChartKeys>
              )}
            </>
          ) : (
            <div className={styles.chartEmpty}>
              {scan?.running
                ? `Reading transcripts — ${scan.filesDone} of ${scan.filesTotal} files.`
                : 'No priced usage in this window yet.'}
            </div>
          )}
        </ChartCard>

        <ChartFoot>
          <span className={styles.costWord}>{coverageSentence(ledger)}</span>
          <span className={styles.fill} />
          <Btn small variant="quiet" disabled={scan?.running} onClick={onScan}>
            {scan?.running ? `Scanning ${scan.filesDone}/${scan.filesTotal}` : 'Rescan'}
          </Btn>
        </ChartFoot>
      </ChartFrame>
    </section>
  )
}

/**
 * What the figure is worth, as one sentence.
 *
 * This was four chips and a button. A chip is a thing you can act on, and
 * none of these were: they were four unrelated facts wearing the same border,
 * which made the band's most important line look like a toolbar.
 */
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

/**
 * How few slices a doughnut can tell apart, and how few are worth drawing.
 *
 * The upper bound is the chart kit's own rule, kept where it is applied: past
 * five or six wedges a doughnut is a stacked bar wearing a costume, and the
 * ranking a bar does well is the thing this table is for. So the shape
 * switches rather than shrinking — parts of a whole while the parts are
 * countable, a ranked bar when they are not.
 *
 * The lower bound is the same argument from the other end. One row is not a
 * proportion, and a doughnut of it is a solid ring saying 100% — a chart
 * whose only reading is that it is the only thing there.
 */
const DONUT_FITS = { least: 2, most: 6 }

const Ranked = ({
  ledger,
  pivot,
  byId,
  tintOf,
}: {
  ledger: LedgerReport | null
  pivot: Pivot
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>
  /** The roster's colours, for the pivot whose rows *are* agents. */
  tintOf: (runtime: string) => Tint
}) => {
  if (!ledger || ledger.rows.length === 0) {
    return <p className={styles.bandNote}>Nothing recorded in this window.</p>
  }
  const rows = ledger.rows.slice(0, 12)
  const peak = ledger.rows.reduce((high, row) => Math.max(high, row.cost ?? 0), 0)
  const total = ledger.rows.reduce((sum, row) => sum + (row.cost ?? 0), 0)
  const unpriced = rows.filter((row) => row.hasUnpriced).length
  const nameOf = (row: LedgerRow): string =>
    pivot === 'runtime'
      ? (byId.get(row.key as RuntimeId)?.presentation.name ?? row.label)
      : row.label
  // A doughnut is drawn from every row the window holds, not from the twelve
  // the table shows: a whole with a slice missing is not a whole.
  const asParts =
    ledger.rows.length >= DONUT_FITS.least && ledger.rows.length <= DONUT_FITS.most && total > 0
  // One assignment for the wedges and the rows together, so no two rows of a
  // short list can land on the same hue — see `tintsFor`. Under the agent
  // pivot the rows *are* the roster, so they take the roster's own colours
  // and the doughnut agrees with the money chart above it; the other two
  // pivots are their own set and resolve it here.
  const tints = tintsFor(ledger.rows.map((row) => row.key))
  const tintAt = (index: number): Tint =>
    pivot === 'runtime'
      ? tintOf(ledger.rows[index]?.key ?? '')
      : (tints[index] as Tint)

  return (
    <>
      <div className={styles.wentRow} {...(asParts ? { 'data-parts': '' } : {})}>
        {asParts && (
          <div className={styles.wentDonut}>
            <Donut
              size={132}
              slices={ledger.rows.map((row, index) => ({
                label: nameOf(row),
                value: row.cost ?? 0,
                tint: tintAt(index),
              }))}
            >
              <span className={styles.donutTotal}>
                {formatMoney(total, ledger.currency) ?? '—'}
              </span>
              <span className={styles.donutWord}>in total</span>
            </Donut>
          </div>
        )}

        <div className={styles.ranked}>
          {rows.map((row, index) => {
            const info = row.runtime ? byId.get(row.runtime) : null
            const label = nameOf(row)
            const share = shareOf(row.cost, total)
            return (
              <div key={row.key} className={styles.rank} {...(asParts ? { 'data-parts': '' } : {})}>
                <span className={styles.rankMark}>
                  {/* The doughnut keyed these rows by colour, so the colour is
                      what identifies them here — a second identity beside it
                      would have the reader checking which one to trust. */}
                  {asParts ? (
                    <SeriesDot tint={tintAt(index)} />
                  ) : (
                    (pivot === 'runtime' || info) && (
                      <RuntimeMark
                        runtime={info ?? byId.get(row.key as RuntimeId) ?? fallbackInfo(row.key)}
                        size={15}
                      />
                    )
                  )}
                </span>
                <span className={styles.rankName} title={label}>
                  {label}
                </span>
                {!asParts && (
                  <span className={styles.rankTrack}>
                    <span
                      className={styles.rankFill}
                      style={{
                        width: `${peak > 0 ? Math.max(1, Math.round(((row.cost ?? 0) / peak) * 100)) : 0}%`,
                      }}
                    />
                  </span>
                )}
                <span className={styles.rankShare}>
                  {share === null ? '' : share < 1 ? '<1%' : `${Math.round(share)}%`}
                </span>
                <span className={styles.rankTokens}>
                  {row.tokens === null ? '—' : formatTokens(row.tokens)}
                </span>
                <span className={styles.rankCost}>
                  {formatMoney(row.cost, ledger.currency) ?? '—'}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      {/* One caveat under the table, rather than a "has unpriced" chip on every
          second row — a badge that repeats down a column stops reading as a
          warning and starts reading as a category. */}
      <div className={styles.footnote}>
        {unpriced === 0
          ? 'Every call in this window has a public price, so these figures are exact.'
          : unpriced === 1
            ? 'One of these rows includes a model with no public price, so its cost is lower than shown.'
            : `${unpriced} of these rows include models with no public price, so their cost is lower than shown.`}
      </div>
    </>
  )
}

/** A row whose agent is no longer registered still draws, with the generic mark. */
const fallbackInfo = (id: string): { id: string; presentation: { name: string } } => ({
  id,
  presentation: { name: id },
})

export type { Tone }
