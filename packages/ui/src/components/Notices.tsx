import { useEffect, useState, type ReactNode } from 'react'
import { RuntimeMark } from './BrandIcons'

import type { RuntimeId } from '@harnessdesk/protocol'

import { sessionKey, type SessionId } from '@harnessdesk/protocol'

import { useRuntime, useRuntimeAccount, useRuntimeHealth, useSnapshot, useStore } from '../state/context'
import {
  ComposerNotice,
  NoticeCard,
  NoticeStrip,
  showToast,
  type InboxMessage,
  type NoticeAct,
  type NoticeMessage,
  type NoticeTone,
} from '../design'
import { describeLimits } from '../lib/limits'
import { conditionFor } from '../lib/usage-alerts'
import { isSilenced, offersMute, surfaceFor, type NoticeIdentity, type NoticePolicy, type NoticeSurface } from '../lib/notice-policy'
import { useShell } from '../panels/views'
import { useImportOffer } from './ImportOffer'

/**
 * Transient messages — the result of something just done, or a failure the
 * store could not say in place — become toasts, one shape through the
 * design system's `showToast`. An error stays until it is closed; the rest
 * leave on their own. The store's list is only a queue into the toaster.
 */
export const Notices = () => {
  const store = useStore()
  const notices = useSnapshot().notices

  useEffect(() => {
    for (const notice of notices) {
      showToast(
        {
          id: notice.id,
          tone: TOAST_TONE[notice.level] ?? 'neutral',
          title: notice.message,
          ...(notice.action ? { action: { label: notice.action.label, onSelect: () => notice.action?.run() } } : {}),
        },
        notice.level === 'error' ? { persist: true } : {},
      )
      store.dismissNotice(notice.id)
    }
  }, [notices, store])

  return null
}

const TOAST_TONE: Record<string, NoticeTone> = {
  error: 'danger',
  warning: 'warning',
  info: 'info',
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
  readonly tone: NoticeTone
  readonly title: string
  readonly body?: ReactNode
  readonly action?: NoticeAct
}

/** The identity of a notice, without what it looks like. */
const identify = (notice: Notice): NoticeIdentity => ({
  key: notice.key,
  kind: notice.kind,
  lifetime: notice.lifetime,
})

/**
 * The one standing condition for the active agent — a dropped link, an agent
 * that cannot start or is not signed in, a plan that is spent or running out
 * — with how it is put away. Where it is drawn is the surfaces' business
 * (`surfaceFor`); this only says what is true.
 *
 * Each states the condition as its title and what it means underneath,
 * because "Usage limit reached" and "past sessions are still readable"
 * answer two different questions and only one of them is the alarm.
 */
interface Standing {
  readonly message: NoticeMessage
  readonly identity: NoticeIdentity
  readonly dismiss: () => void
  readonly mute?: () => void
}

const useStanding = (): Standing | null => {
  const store = useStore()
  const shell = useShell()
  const snapshot = useSnapshot()
  const runtime = useRuntime()
  const health = useRuntimeHealth()
  const account = useRuntimeAccount()
  const nameFor = (id: RuntimeId): string =>
    snapshot.runtimes.find((entry) => entry.id === id)?.presentation.name ?? String(id)

  const notice = ((): Notice | null => {
    if (snapshot.status === 'reconnecting' || snapshot.status === 'closed') {
      return {
        // Never written down, on purpose: a dropped link is news every time
        // it drops, and it clears itself the moment it is fixed.
        key: `link:${snapshot.status}`,
        kind: 'link',
        lifetime: 'session',
        tone: 'warning',
        title: 'Reconnecting to HarnessDesk.',
        body: 'Sessions keep running; this window will catch up.',
      }
    }
    if (health?.state === 'unavailable') {
      return {
        key: `health:${runtime.id}:${health.message}`,
        kind: 'agent:health',
        lifetime: 'occurrence',
        tone: 'danger',
        title: health.message,
        ...(health.remediation ? { body: health.remediation } : {}),
      }
    }
    if (runtime.capabilities.account && account && account.accounts.length === 0) {
      const driveable = account.signInMethods.some((method) => method.flow !== 'external')
      const command = runtime.presentation.signIn?.command
      return {
        key: `signin:${runtime.id}`,
        kind: 'agent:signin',
        lifetime: 'occurrence',
        tone: 'warning',
        title: `${runtime.presentation.name} is not signed in.`,
        ...(driveable ? { action: { label: 'Sign in', onSelect: () => shell.signIn() } } : {}),
        body: !driveable && command ? (
          <>
            Run <code>{command}</code> in a terminal to connect an account.
          </>
        ) : (
          'Sessions cannot start until an account is connected.'
        ),
      }
    }
    // What the agent this conversation talks to is up against, and somewhere
    // else to take the work.
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
        ...(elsewhere
          ? {
              action: {
                label: snapshot.activeSessionKey ? `Continue with ${elsewhere.name}` : `Switch to ${elsewhere.name}`,
                onSelect: () => void store.handOff(elsewhere.runtime),
              },
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
      }
    }
    return null
  })()

  // Put away for this run only, for the lifetimes nothing is written down
  // for; cleared as soon as the notice changes, so a second drop is news.
  const [putAway, setPutAway] = useState<string | null>(null)
  const key = notice?.key ?? null
  useEffect(() => {
    setPutAway((current) => (current === key ? current : null))
  }, [key])

  if (!notice) return null
  // Held until the host has said what the user silenced, so a silenced
  // message never flashes on its way to being hidden.
  if (!snapshot.preferencesLoaded) return null
  const identity = identify(notice)
  if (putAway === notice.key || isSilenced(snapshot.noticePolicy, identity)) return null
  return {
    message: {
      id: notice.key,
      tone: notice.tone,
      title: notice.title,
      ...(notice.body !== undefined ? { body: notice.body } : {}),
      ...(notice.action ? { action: notice.action } : {}),
    },
    identity,
    dismiss: () => {
      if (notice.lifetime === 'session') setPutAway(notice.key)
      else store.dismissStanding(identity)
    },
    ...(offersMute(snapshot.noticePolicy, identity) ? { mute: () => store.setNoticeMuted(notice.kind, true) } : {}),
  }
}

/** Where a standing notice goes: a dropped link is always the strip; the rest, the person's setting. */
const placeOf = (policy: NoticePolicy, standing: Standing): NoticeSurface | null =>
  standing.identity.kind === 'link' ? 'strip' : surfaceFor(policy, standing.identity.kind)

/**
 * Keeps, once, a notice whose kind the person moved to "Inbox only". Keyed by
 * the notice's own key, so the same condition is one kept message however
 * often the window draws it, and it is not made unread again by redrawing.
 */
const useKeptOnce = (message: NoticeMessage | null, kind: string | null, place: NoticeSurface | null): void => {
  const store = useStore()
  const inbox = useSnapshot().inbox
  const id = message?.id ?? null
  const title = typeof message?.title === 'string' ? message.title : null
  const body = typeof message?.body === 'string' ? message.body : undefined
  const tone = message?.tone ?? 'neutral'
  const already = id !== null && inbox.some((entry) => entry.id === id)
  useEffect(() => {
    if (place !== 'inbox' || id === null || title === null || already) return
    store.keep({ id, ...(kind ? { kind } : {}), tone, title, ...(body ? { body } : {}), at: Date.now() })
  }, [place, id, title, body, tone, kind, already, store])
}

/**
 * Above the composer: the standing condition, when the person's setting puts
 * it here, and any decision an Agent in this conversation is waiting on.
 * Mounted inside the composer's own frame, so nothing else is ever covered.
 */
export const ComposerNotices = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const standing = useStanding()
  const place = standing ? placeOf(snapshot.noticePolicy, standing) : null
  useKeptOnce(standing?.message ?? null, standing?.identity.kind ?? null, place)
  const active = snapshot.activeSessionKey
  const asking = snapshot.agentNotices.filter(
    (notice) => active !== null && sessionKey(notice.from.runtime, notice.from.sessionId as SessionId) === active,
  )
  if ((place !== 'composer' || !standing) && asking.length === 0) return null
  return (
    <>
      {place === 'composer' && standing ? <ComposerNotice message={standing.message} onDismiss={standing.dismiss} onMute={standing.mute} /> : null}
      {asking.map((notice) => {
        const sender = snapshot.runtimes.find((info) => info.id === notice.from.runtime)
        return (
          <ComposerNotice
            key={notice.id}
            message={{
              id: notice.id,
              tone: 'info',
              title: notice.title,
              ...(notice.body ? { body: notice.body } : {}),
              ...(sender ? { mark: <RuntimeMark runtime={sender} size={14} /> } : {}),
            }}
            onDismiss={() => store.dismissAgentNotice(notice.id)}
          />
        )
      })}
    </>
  )
}

/** The slim strip above the panes: a dropped link, and whatever the person moved here. */
export const NoticeStripOutlet = () => {
  const snapshot = useSnapshot()
  const standing = useStanding()
  const offer = useImportOffer()
  const messages: NoticeMessage[] = []
  const dismissals = new Map<string, () => void>()
  if (standing && placeOf(snapshot.noticePolicy, standing) === 'strip') {
    messages.push(standing.message)
    dismissals.set(standing.message.id, standing.dismiss)
  }
  if (offer && surfaceFor(snapshot.noticePolicy, 'import:offer') === 'strip') {
    messages.push(offer.message)
    dismissals.set(offer.message.id, offer.dismiss)
  }
  if (messages.length === 0) return null
  return (
    <NoticeStrip
      messages={messages}
      onDismiss={(id) => dismissals.get(id)?.()}
      onMute={(id) => (standing && id === standing.message.id ? standing.mute : undefined)}
    />
  )
}

/** The card at the foot of the sidebar: offers and news that can wait. */
export const SidebarNotices = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const offer = useImportOffer()
  const offerPlace = surfaceFor(snapshot.noticePolicy, 'import:offer')
  useKeptOnce(offer?.message ?? null, 'import:offer', offerPlace)
  const messages: NoticeMessage[] = []
  const dismissals = new Map<string, () => void>()
  if (offer && offerPlace === 'card') {
    messages.push(offer.message)
    dismissals.set(offer.message.id, offer.dismiss)
  }
  if (snapshot.goalMigrationPending) {
    const ack = () => void store.ackGoalMigration()
    messages.push({
      id: 'goal:migration',
      tone: 'info',
      title: 'Rooms are now Goals',
      body: 'Your rooms, boards and members were kept. Goal Seats now define active membership.',
      action: { label: 'Got it', onSelect: ack },
    })
    dismissals.set('goal:migration', ack)
  }
  if (messages.length === 0) return null
  return <NoticeCard messages={messages} onDismiss={(id) => dismissals.get(id)?.()} />
}

/**
 * The kept messages as the inbox draws them: the sender's name and mark on
 * the card, and "Start as a task" for a task one suggests.
 */
export const useInboxMessages = (): InboxMessage[] => {
  const store = useStore()
  const snapshot = useSnapshot()
  return snapshot.inbox.map((entry) => {
    const sender = entry.from ? snapshot.runtimes.find((info) => info.id === entry.from?.runtime) : undefined
    return {
      id: entry.id,
      tone: entry.tone,
      title: entry.title,
      ...(entry.body ? { body: entry.body } : {}),
      at: entry.at,
      read: entry.read,
      ...(entry.from ? { from: entry.from.name } : {}),
      ...(sender ? { mark: <RuntimeMark runtime={sender} size={14} /> } : {}),
      ...(sender && entry.from
        ? { go: () => void store.openSession(entry.from!.sessionId as SessionId, { runtime: sender.id }) }
        : {}),
      ...(entry.task ? { action: { label: 'Start as a task', onSelect: () => void store.startSuggestedTask(entry.id) } } : {}),
    }
  })
}
