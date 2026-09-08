import { useEffect, useMemo, useState } from 'react'

import type { RuntimeId } from '@harnessdesk/protocol'

import { describeStrip, type StripMeter, type StripRest } from '../lib/plan-strip'
import { describeLane, formatAge, formatMoney } from '../lib/usage'
import { useActiveSession, useSnapshot } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { RosterIcon, SignInIcon, UsageIcon } from './Icons'
import { Menu } from './Menu'
import { Popover } from './Popover'
import styles from './PlanMeters.module.css'

/**
 * The strip in the header: this conversation's agent, and one token for the
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
        health: snapshot.health,
        activeRuntime: snapshot.activeRuntime,
        sessionRuntime: session?.runtime ?? null,
        now,
      }),
    [
      snapshot.runtimes,
      snapshot.usage,
      snapshot.accountsByRuntime,
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
        <button
          type="button"
          className={styles.signInChip}
          onClick={() => onSignIn(anchor.info.id)}
          title={`${anchor.info.presentation.name} has no account here — sign in to use it`}
        >
          <SignInIcon size={12} />
          {anchor.info.presentation.name}
        </button>
      )}
      {/* An agent that is out and is not this conversation's is the one piece
          of roster news worth its own space: the token can say how many are
          out, but not which. Dropped first when the header narrows, because
          the token beside it already carries the count. */}
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
    title={view.title}
    drop="down"
    align="right"
    triggerClassName={styles.trigger}
    label={
      <span
        className={styles.meter}
        data-tone={view.tone}
        {...(view.low ? { 'data-low': '' } : {})}
        {...(promoted ? { 'data-promoted': '' } : {})}
      >
        <RuntimeMark runtime={view.info} size={14} />
        {/* A promoted chip's whole content is the countdown, so a full red
            track beside it would only say the same thing twice. */}
        {!promoted && (
          <span className={styles.track}>
            <span className={styles.fill} style={{ width: `${view.lane.remainingPercent ?? 0}%` }} />
          </span>
        )}
        <span className={styles.figure}>{view.figure}</span>
      </span>
    }
  >
    {(close) => (
      <Menu close={close}>
        <div className={styles.panel}>
          <button
            type="button"
            className={styles.panelHead}
            onClick={() => {
              close()
              onOpen()
            }}
          >
            <RuntimeMark runtime={view.info} size={14} />
            <span className={styles.panelName}>{view.name}</span>
            <span className={styles.panelOpen}>Open</span>
          </button>
          {(view.report.plan || view.report.account) && (
            <p className={styles.identity}>
              {[view.report.plan, view.report.account].filter(Boolean).join(' · ')}
            </p>
          )}
          <div className={styles.lanes}>
            {view.report.lanes.map((raw) => {
              const lane = describeLane(raw, now, view.report.lanes)
              return (
                <div key={lane.id} className={styles.laneRow} data-tone={lane.tone}>
                  <span className={styles.laneName}>{lane.title}</span>
                  <span className={styles.laneTrack}>
                    <span
                      className={styles.laneFill}
                      style={{ width: `${lane.remainingPercent ?? 0}%` }}
                    />
                  </span>
                  <span className={styles.laneValue}>
                    {lane.remainingPercent === null ? '—' : `${lane.remainingPercent}% left`}
                  </span>
                  <span className={styles.laneWhen}>
                    {lane.gatedUntil !== null ? `blocked ${lane.gatedFor ?? ''}` : (lane.shortCountdown ?? '')}
                  </span>
                </div>
              )
            })}
          </div>
          <p className={styles.foot}>
            {view.report.spend?.todayCost !== undefined && view.report.spend?.todayCost !== null && (
              <>
                <span>{formatMoney(view.report.spend.todayCost, view.report.spend.currency)} today</span>
                <span className={styles.dot}>·</span>
              </>
            )}
            <span>{view.report.source.label}</span>
            <span className={styles.dot}>·</span>
            <span>{formatAge(view.report.fetchedAt, now)}</span>
          </p>
        </div>
      </Menu>
    )}
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
    title={rest.title}
    drop="down"
    align="right"
    triggerClassName={styles.trigger}
    label={
      <span className={styles.rest} data-tone={rest.tone} aria-label={rest.title}>
        <RosterIcon size={13} />
        <span className={styles.figure}>{rest.figure}</span>
      </span>
    }
  >
    {(close) => (
      <Menu close={close}>
        <div className={styles.panel}>
          <p className={styles.rosterHead}>{rest.title}</p>
          <div className={styles.roster}>
            {rest.meters.map((meter) => (
              <button
                key={`${meter.runtime}:${meter.report.account ?? ''}`}
                type="button"
                className={styles.rosterRow}
                data-tone={meter.tone}
                onClick={() => {
                  close()
                  onOpen(meter.runtime)
                }}
              >
                <RuntimeMark runtime={meter.info} size={14} />
                <span className={styles.rosterName}>
                  {meter.name}
                  {meter.account && <span className={styles.rosterAccount}>{meter.account}</span>}
                </span>
                <span className={styles.laneTrack}>
                  <span
                    className={styles.laneFill}
                    style={{ width: `${meter.lane.remainingPercent ?? 0}%` }}
                  />
                </span>
                <span className={styles.laneValue}>{meter.lane.remainingPercent}% left</span>
                <span className={styles.laneWhen}>
                  {meter.out ? (meter.lane.shortCountdown ?? 'out') : (meter.lane.shortCountdown ?? '')}
                </span>
              </button>
            ))}
            {/* The agents with no bar. They are why the count and the bars can
                disagree, so the panel has to hold them or the count looks wrong. */}
            {rest.asides.map((aside) => (
              <button
                key={aside.runtime}
                type="button"
                className={styles.rosterRow}
                data-quiet=""
                onClick={() => {
                  close()
                  onOpen(aside.runtime)
                }}
              >
                <RuntimeMark runtime={aside.info} size={14} />
                <span className={styles.rosterName}>{aside.info.presentation.name}</span>
                <span className={styles.rosterDetail}>{aside.detail}</span>
              </button>
            ))}
          </div>
          <p className={styles.foot}>
            <UsageIcon size={12} />
            <span>Every plan, and what it cost — ⌘U</span>
            <span className={styles.dot}>·</span>
            <span>{formatAge(oldest(rest, now), now)}</span>
          </p>
        </div>
      </Menu>
    )}
  </Popover>
)

/** The stalest reading behind the token, which is what its age is worth. */
const oldest = (rest: StripRest, now: number): number =>
  rest.meters.reduce((at, meter) => Math.min(at, meter.report.fetchedAt), now)
