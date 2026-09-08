import { useEffect, useState, type ReactNode } from 'react'

import type { RuntimeId } from '@harnessdesk/protocol'

import { useRuntime, useSnapshot, useStore } from '../state/context'
import { Banner, BannerAction, bannerStyles as styles, type BannerTone } from '../design/primitives/Banner'
import { describeLimits } from '../lib/limits'
import { conditionFor } from '../lib/usage-alerts'
import { isSilenced, offersMute, type NoticeIdentity } from '../lib/notice-policy'

const TONE: Record<string, BannerTone> = {
  error: 'danger',
  warning: 'warning',
  info: 'info',
}

/** Transient messages, auto-dismissed unless they are errors. */
export const Notices = () => {
  const store = useStore()
  const notices = useSnapshot().notices

  useEffect(() => {
    const timers = notices
      .filter((notice) => notice.level !== 'error')
      .map((notice) =>
        window.setTimeout(() => store.dismissNotice(notice.id), notice.level === 'info' ? 5_000 : 9_000),
      )
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [notices, store])

  if (notices.length === 0) return null

  return (
    <div className={styles.stack}>
      {notices.map((notice) => (
        <Banner
          key={notice.id}
          compact
          role="status"
          tone={TONE[notice.level] ?? 'neutral'}
          onDismiss={() => store.dismissNotice(notice.id)}
          {...(notice.action
            ? {
                actions: (
                  <BannerAction
                    onClick={() => {
                      notice.action?.run()
                      store.dismissNotice(notice.id)
                    }}
                  >
                    {notice.action.label}
                  </BannerAction>
                ),
              }
            : {})}
        >
          {notice.message}
        </Banner>
      ))}
    </div>
  )
}

/**
 * Every persistent banner can be put away — and now, put away for good.
 *
 * A card that states a condition and offers one filled button and no way out
 * does not read as information — it reads as a demand, and the one that
 * offered another agent read as being pushed off the one you had chosen.
 * Nothing here is a decision the app is entitled to insist on: an agent about
 * to run out is still working, and an agent that cannot start says so again
 * the moment you try to start it.
 *
 * The dismissal is remembered against the *fact*, not the sentence. The
 * sentence carries a countdown that moves every minute; `key` carries the
 * window that countdown is inside. So putting away "runs out in 17h" keeps it
 * away for that window, and the next window is a new banner — because it is
 * genuinely new news, the first time.
 *
 * The second time it is not. A five-hour lane turns over five times a day, so
 * a warning honestly keyed to its window still arrives at nearly every launch,
 * and by the third one the user has said what they think of it twice. That is
 * what `kind` is for: strip the window off the key and you have the sentence
 * itself, which is the thing someone gets tired of and the thing they can
 * silence. Where that is stored, and the way back, live in
 * `lib/notice-policy.ts` and Settings › Notifications.
 */

/** One condition, ready to draw. */
interface Notice extends NoticeIdentity {
  readonly tone: BannerTone
  readonly title: string
  readonly body: ReactNode
  readonly role: 'status' | 'alert'
  readonly actions?: ReactNode
}

/** The identity of a notice, without what it looks like. */
const identify = (notice: Notice): NoticeIdentity => ({
  key: notice.key,
  kind: notice.kind,
  lifetime: notice.lifetime,
})

/**
 * A persistent strip for states that change what the app can do, rather than a
 * toast that scrolls away: being out of credits or disconnected is not an event,
 * it is a condition.
 *
 * Each one states the condition as its title and what it means for the user
 * underneath, because "Usage limit reached" and "past sessions are still
 * readable" answer two different questions and only one of them is the alarm.
 */
export const StatusBanner = ({ onSignIn }: { onSignIn: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const runtime = useRuntime()
  const nameFor = (id: RuntimeId): string =>
    snapshot.runtimes.find((entry) => entry.id === id)?.presentation.name ?? String(id)

  const notice = ((): Notice | null => {
    if (snapshot.status === 'reconnecting' || snapshot.status === 'closed') {
      return {
        // Never written down, on purpose: a dropped link is news every time
        // it drops, and it clears itself the moment it is fixed. Putting it
        // away is a statement about right now and nothing further.
        key: `link:${snapshot.status}`,
        kind: 'link',
        lifetime: 'session',
        tone: 'warning',
        title: 'Reconnecting to HarnessDesk',
        body: 'The connection to the host dropped. Sessions keep running; this window will catch up.',
        role: 'status',
      }
    }

    if (snapshot.health?.state === 'unavailable') {
      return {
        key: `health:${runtime.id}:${snapshot.health.message}`,
        kind: 'agent:health',
        lifetime: 'occurrence',
        tone: 'danger',
        title: snapshot.health.message,
        body: snapshot.health.remediation,
        role: 'alert',
      }
    }

    if (runtime.capabilities.account && snapshot.account && snapshot.account.accounts.length === 0) {
      const driveable = snapshot.account.signInMethods.some((method) => method.flow !== 'external')
      const command = runtime.presentation.signIn?.command
      return {
        key: `signin:${runtime.id}`,
        kind: 'agent:signin',
        lifetime: 'occurrence',
        tone: 'warning',
        title: `${runtime.presentation.name} is not signed in`,
        role: 'status',
        ...(driveable ? { actions: <BannerAction onClick={onSignIn}>Sign in</BannerAction> } : {}),
        body: driveable ? (
          'Sessions cannot start until an account is connected.'
        ) : command ? (
          <>
            Run <code>{command}</code> in a terminal to connect an account.
          </>
        ) : (
          'Sessions cannot start until an account is connected.'
        ),
      }
    }

    // What the agent this conversation talks to is up against, and — the one
    // thing a menu bar cannot do — somewhere else to take the work.
    const condition = conditionFor(runtime.id, snapshot.usage, nameFor, Date.now())
    if (condition) {
      const elsewhere = condition.handoff
      return {
        key: condition.key,
        kind: condition.kind,
        lifetime: 'occurrence',
        tone: condition.tone,
        title: condition.title,
        body: condition.detail,
        role: condition.tone === 'danger' ? 'alert' : 'status',
        ...(elsewhere
          ? {
              actions: (
                <BannerAction onClick={() => void store.handOff(elsewhere.runtime)}>
                  {snapshot.activeSessionKey
                    ? `Continue with ${elsewhere.name}`
                    : `Switch to ${elsewhere.name}`}
                </BannerAction>
              ),
            }
          : {}),
      }
    }

    // Nothing metered reached us: the narrow view still speaks for a runtime
    // that answers `runtime/limits` and has no report of its own.
    const blocked = runtime.capabilities.metered ? describeLimits(snapshot.limits)?.blocked : null
    if (blocked) {
      return {
        key: `limits:${runtime.id}:${blocked.title}`,
        kind: 'usage:limits',
        lifetime: 'occurrence',
        tone: 'warning',
        title: blocked.title,
        body: blocked.detail,
        role: 'status',
      }
    }

    return null
  })()

  // Put away for this run only, for the lifetimes nothing is written down for.
  // Cleared as soon as the notice changes to a different one or to none, so a
  // link that drops a second time is a second piece of news rather than a
  // thing this window has already decided it knows.
  const [putAway, setPutAway] = useState<string | null>(null)
  const key = notice?.key ?? null
  useEffect(() => {
    setPutAway((current) => (current === key ? current : null))
  }, [key])

  if (!notice) return null
  // Held until the host has said what the user silenced. A banner that flashes
  // on its way to being hidden is the launch this mechanism exists to stop.
  if (!snapshot.preferencesLoaded) return null
  const identity = identify(notice)
  if (putAway === notice.key || isSilenced(snapshot.noticePolicy, identity)) return null

  return (
    <Banner
      tone={notice.tone}
      title={notice.title}
      role={notice.role}
      onDismiss={() => {
        if (notice.lifetime === 'session') setPutAway(notice.key)
        else store.dismissStanding(identity)
      }}
      {...(offersMute(snapshot.noticePolicy, identity)
        ? { onMute: () => store.setNoticeMuted(notice.kind, true) }
        : {})}
      {...(notice.actions ? { actions: notice.actions } : {})}
    >
      {notice.body}
    </Banner>
  )
}
