import { Button, Progress, Text, type Tone } from '../design'
import { useEffect, useMemo, useState } from 'react'

import type { RuntimeId } from '@harnessdesk/protocol'

import { describeStrip, type StripMeter, type StripRest } from '../lib/plan-strip'
import { describeLane, formatAge, formatMoney } from '../lib/usage'
import { useActiveSession, useSnapshot } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { RosterIcon, SignInIcon } from './Icons'
import { WideMenu, Popover } from '../design'
import styles from './PlanMeters.module.css'

/**
 * The strip at the app foot: this conversation's agent, and one token for the
 * rest of the roster.
 *
 * The screen answers "where do I stand" when you go and ask it. This answers
 * the question nobody thinks to ask — *is the agent I am about to use still
 * working?* — and so it has to be true without being opened. Design:
 * `docs/usage-dashboard.md`.
 *
 * A bar per metered agent made this a dashboard, and a dashboard grows: the
 * strip is inelastic and the session's name is the only elastic thing in the
 * header, so the fifth agent was paid for by the title of the conversation you
 * were in. What is true here is decided in `lib/plan-strip.ts` — which agent
 * anchors the strip, which get chips, what the token says — and this file only
 * draws. It never names an agent: names come from `RuntimeInfo.presentation`.
 */

export const PlanMeters = ({
  onOpen,
  onSignIn,
}: {
  onOpen: (runtime: RuntimeId) => void
  /** The one thing that stops a session from starting at all, offered here. */
  onSignIn: (runtime: RuntimeId) => void
}) => {
  const snapshot = useSnapshot()
  const session = useActiveSession()
  const [now, setNow] = useState(() => Date.now())

  // Countdowns and ages move; once a minute is enough for figures measured in
  // hours, and the strip is on screen all day.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const view = useMemo(
    () =>
      describeStrip({
        runtimes: snapshot.runtimes,
        usage: snapshot.usage,
        accountsByRuntime: snapshot.accountsByRuntime,
        accountPrefs: snapshot.accountPrefs,
        health: snapshot.health,
        activeRuntime: snapshot.activeRuntime,
        sessionRuntime: session?.runtime ?? null,
        now,
      }),
    [
      snapshot.runtimes,
      snapshot.usage,
      snapshot.accountsByRuntime,
      snapshot.accountPrefs,
      snapshot.health,
      snapshot.activeRuntime,
      session?.runtime,
      now,
    ],
  )

  const { anchor, promoted, rest } = view
  if (anchor === null && rest === null) return null

  return (
    <div
      className={styles.strip}
      role="group"
      aria-label="Plan usage"
      {...(anchor ? { 'data-anchored': '' } : {})}
    >
      {anchor?.kind === 'meter' && (
        <Meter view={anchor.meter} now={now} onOpen={() => onOpen(anchor.meter.runtime)} />
      )}
      {anchor?.kind === 'signIn' && (
          <Button
            type="button"
            variant="primary" size="chip" className={`${styles.signInChip} truncate`}
            onClick={() => onSignIn(anchor.info.id)}
            aria-label={`Sign in to ${anchor.info.presentation.name}`}
            title={`${anchor.info.presentation.name} has no account here — sign in to use it`}
          >
            <SignInIcon size={12} />
            {anchor.info.presentation.name}
          </Button>
      )}
      {/* An agent that is out and is not this conversation's is the one piece
          of roster news worth its own space: the token can say how many are
          out, but not which. The token beside it carries the roster count. */}
      {promoted.map((meter) => (
        <Meter
          key={`${meter.runtime}:${meter.report.account ?? ''}`}
          view={meter}
          now={now}
          promoted
          onOpen={() => onOpen(meter.runtime)}
        />
      ))}
      {rest && <Rest rest={rest} now={now} onOpen={onOpen} />}
    </div>
  )
}

const meterTitle = (view: StripMeter): string => `${view.title}${view.lane.remainingPercent === 0 ? ' · out of quota' : ''}${view.lane.shortCountdown ? ` · resets in ${view.lane.shortCountdown}` : ''}`

const Meter = ({
  view,
  now,
  promoted,
  onOpen,
}: {
  view: StripMeter
  now: number
  /** An out-of-quota agent this conversation is not using: no bar, just when. */
  promoted?: boolean
  onOpen: () => void
}) => (
    <Popover
      panelWidth="wide" icons="all"
      title={meterTitle(view)}
      aria-label={meterTitle(view)}
      drop="down"
      align="right"
      label={
        <span
          data-slot="plan-meter"
          data-plan-popup={promoted ? 'promoted' : 'anchor'}
          className={styles.meter}
          data-tone={promoted ? 'neutral' : toneOf(view.tone)}
          {...(view.low ? { 'data-low': '' } : {})}
          {...(promoted ? { 'data-promoted': '' } : {})}
        >
          <RuntimeMark runtime={view.info} size={14} />
          {/* A promoted chip's whole content is the countdown, so a full red
              track beside it would only say the same thing twice. */}
          {!promoted && (
            <Progress
              className={styles.stripProgress}
              value={view.lane.remainingPercent}
              measure="remaining"
              label={false}
              size="sm"
              aria-label={`${view.lane.title} — what is left`}
            />
          )}
          {promoted ? (
            <Text role="meta" numeric>{view.figure}</Text>
          ) : (
            <Text role="meta" tone={toneOf(view.tone)} numeric>{view.figure}</Text>
          )}
        </span>
      }
    >
      {close => <WideMenu close={close} title={view.name}
        items={[{ id: 'open', label: view.name, icon: <RuntimeMark runtime={view.info} size={16} />, badge: view.report.plan || undefined, hint: view.report.account || undefined, trailing: 'Open', onSelect: onOpen }]}
        facts={view.report.lanes.map(raw => {
          const lane = describeLane(raw, now, view.report.lanes)
          return { id: lane.id, name: lane.title, percent: lane.remainingPercent, countdown: lane.gatedUntil === null ? lane.resetCountdown : `blocked ${lane.gatedFor ?? '—'}`, countdownTitle: lane.gatedUntil !== null ? `blocked until ${lane.gatedClock}` : lane.resetClock ? `resets ${lane.resetClock}` : undefined, tone: toneOf(lane.tone) }
        })}
        footer={[view.report.spend?.todayCost != null ? `${formatMoney(view.report.spend.todayCost, view.report.spend.currency)} today` : null, view.report.source.label, formatAge(view.report.fetchedAt, now)].filter(Boolean).join(' · ')}
      />}
    </Popover>
)

/**
 * Every other agent, in the space of a word.
 *
 * The token is what makes the strip cost the same at forty agents as at two,
 * and it carries tone rather than only a count: a bare `+5` would have to be
 * opened before anyone could tell whether it mattered, which is the one thing
 * chrome must never ask.
 */
const Rest = ({
  rest,
  now,
  onOpen,
}: {
  rest: StripRest
  now: number
  onOpen: (runtime: RuntimeId) => void
}) => (
    <Popover
      panelWidth="wide" icons="all"
      title={rest.title}
      drop="down"
      align="right"
      tone="calm"
      label={
        <span data-slot="plan-meter" data-plan-popup="rest" className={styles.rest} data-tone="neutral" aria-label={rest.title}>
          <Text role="meta" tone="neutral"><RosterIcon size={13} /></Text>
          <Text role="meta" tone="neutral" numeric>{rest.figure}</Text>
        </span>
      }
    >
      {close => <WideMenu close={close} title={rest.title}
        items={[
          ...rest.meters.map(meter => ({ id: `${meter.runtime}:${meter.report.account ?? ''}`, label: meter.name, icon: <RuntimeMark runtime={meter.info} size={16} />, hint: meter.account || undefined, meter: { id: meter.lane.id, name: meter.lane.title, label: `${meter.name}${meter.account ? ` · ${meter.account}` : ''} — what is left`, percent: meter.lane.remainingPercent, countdown: meter.lane.resetCountdown, countdownTitle: meter.lane.resetClock ? `resets ${meter.lane.resetClock}` : undefined, tone: toneOf(meter.tone) }, onSelect: () => onOpen(meter.runtime) })),
          ...rest.asides.map(aside => ({ id: String(aside.runtime), label: aside.info.presentation.name, icon: <RuntimeMark runtime={aside.info} size={16} />, meter: { id: String(aside.runtime), name: 'Plan', percent: null, countdown: '', note: aside.detail }, onSelect: () => onOpen(aside.runtime) })),
        ]}
        footer={`Every plan, and what it cost — ⌘U · ${formatAge(oldest(rest, now), now)}`}
      />}
    </Popover>
)

/** The stalest reading behind the token, which is what its age is worth. */
const oldest = (rest: StripRest, now: number): number =>
  rest.meters.reduce((at, meter) => Math.min(at, meter.report.fetchedAt), now)

const toneOf = (tone: 'good' | 'warn' | 'bad'): Tone =>
  tone === 'warn' ? 'warning' : tone === 'bad' ? 'danger' : 'neutral'
