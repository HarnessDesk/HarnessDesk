import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
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
import { isSilenced, offersMute, surfaceFor, wasKept, type NoticeIdentity, type NoticePolicy, type NoticeSurface } from '../lib/notice-policy'
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
  /**
   * The words of `body`, when `body` is not itself already a string.
   *
   * The inbox stores plain text, never React elements, so a notice whose body
   * carries markup (a `<code>` run naming a command) has to say the same
   * thing in words as well — dropping it silently is how the sign-in
   * instruction went missing from the kept copy.
   */
  readonly inboxBody?: string
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
  /** The plain-text form of `message.body`, for the inbox copy (see `Notice.inboxBody`). */
  readonly inboxBody?: string
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
        ...(!driveable && command ? { inboxBody: `Run ${command} in a terminal to connect an account.` } : {}),
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
    ...(notice.inboxBody !== undefined ? { inboxBody: notice.inboxBody } : {}),
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
 * Which outlets of one kind are on screen right now, so two things a global
 * condition would otherwise draw twice can agree on which one actually does.
 *
 * `ComposerNotices` mounts wherever a composer does — a conversation's own,
 * or a room's — and a mount is registered here the moment it exists, whether
 * or not it currently has anything to show: the strip's fallback (below)
 * cares that a composer surface *exists*, not that it is presently drawn.
 * `NoticeStripOutlet` mounts once per pane that needs a strip and once more
 * inside a room's composer, and a split can show both at once; only the
 * first one registered — the "leader" — actually renders the shared,
 * pane-independent messages (a standing condition, the import offer), so a
 * dropped link is said once, not once per outlet that happens to be mounted.
 *
 * Plain mutable state, read straight off at render time — not a
 * `useSyncExternalStore` the registry pushes updates through. A message here
 * is drawn or withheld beside a `useSnapshot()` read that already re-renders
 * on every relevant change (the standing condition, the notice policy, the
 * workbench layout), so this only ever has to be *correct by the next one of
 * those*, not independently reactive — a bar a coordination flag this rarely
 * wrong does not clear, and a store that pushed its own updates would add a
 * render of its own for every mount and unmount, which is exactly what once
 * pushed `NoticeStripOutlet` and `ComposerNotices` mounting together past the
 * ceiling `TeamRoomPane`'s "does not spin" test holds the app to.
 */
const makeOutletRegistry = () => {
  const ids: string[] = []
  return {
    mount: (id: string): void => {
      if (!ids.includes(id)) ids.push(id)
    },
    unmount: (id: string): void => {
      const at = ids.indexOf(id)
      if (at !== -1) ids.splice(at, 1)
    },
    leader: (): string | null => ids[0] ?? null,
    count: (): number => ids.length,
  }
}

const composerOutlets = makeOutletRegistry()
const stripOutlets = makeOutletRegistry()

/**
 * Registers this component instance as one mount of the given outlet kind for
 * as long as it stays mounted.
 *
 * Registered from the render itself, guarded so one commit registers once,
 * rather than from an effect — the read this feeds (`leader`/`count`, below)
 * happens in that same render, so the registration has to already be in
 * place for it, not one render behind.
 */
const useOutletRegistration = (registry: ReturnType<typeof makeOutletRegistry>): string => {
  const id = useId()
  const mounted = useRef(false)
  if (!mounted.current) {
    mounted.current = true
    registry.mount(id)
  }
  useEffect(
    () => () => {
      registry.unmount(id)
      mounted.current = false
    },
    [registry, id],
  )
  return id
}

/** Whether this mount is the one, among every outlet of this kind on screen, that should draw the shared messages. */
const useIsLeaderOutlet = (registry: ReturnType<typeof makeOutletRegistry>): boolean => {
  const id = useOutletRegistration(registry)
  return registry.leader() === id
}

/** Whether a composer surface of either kind is mounted anywhere right now. */
const useComposerMounted = (): boolean => composerOutlets.count() > 0

/**
 * Keeps, once, a notice whose kind the person moved to "Inbox only". Keyed by
 * the notice's own key, so the same condition is one kept message however
 * often the window draws it, and it is not made unread again by redrawing.
 *
 * "Already kept" is answered from the notice policy's own `kept` list, never
 * from whether the inbox still holds the entry: the inbox is exactly the
 * thing a person can clear or read, and a policy read back from *that* would
 * put the message right back, unread, on the render after "Clear" — the same
 * standing condition being true is not news a second time. The key leaves
 * `kept` only when the occurrence itself does, which shows up as a new key.
 *
 * `bodyText` carries the plain words for the inbox row when the message's own
 * body is markup (`NoticeMessage.body` is a `ReactNode`, and the inbox stores
 * a string) — see `Notice.inboxBody`.
 */
const useKeptOnce = (message: NoticeMessage | null, kind: string | null, place: NoticeSurface | null, bodyText?: string): void => {
  const store = useStore()
  const policy = useSnapshot().noticePolicy
  const id = message?.id ?? null
  const title = typeof message?.title === 'string' ? message.title : null
  const body = bodyText ?? (typeof message?.body === 'string' ? message.body : undefined)
  const tone = message?.tone ?? 'neutral'
  const already = id !== null && wasKept(policy, id)
  useEffect(() => {
    if (place !== 'inbox' || id === null || title === null || already) return
    store.keep({ id, ...(kind ? { kind } : {}), tone, title, ...(body ? { body } : {}), at: Date.now() })
    store.markNoticeKept(id)
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
  // Registered on every mount, whether or not there is anything to show right
  // now: the strip's fallback below asks whether a composer surface *exists*
  // on screen, which is true the whole time a conversation's or a room's
  // composer is, not only on the renders where it happens to hold a message.
  useOutletRegistration(composerOutlets)
  const standing = useStanding()
  const place = standing ? placeOf(snapshot.noticePolicy, standing) : null
  useKeptOnce(standing?.message ?? null, standing?.identity.kind ?? null, place, standing?.inboxBody)
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
  // A split can mount this outlet more than once at a time — a room's
  // composer draws its own beside a pane that needs one for lack of a header
  // — and every mount would otherwise mirror the same global condition. Only
  // the leader draws; the rest stay silent so the message is said once.
  const isLeader = useIsLeaderOutlet(stripOutlets)
  const composerMounted = useComposerMounted()
  const messages: NoticeMessage[] = []
  const dismissals = new Map<string, () => void>()
  if (standing) {
    const place = placeOf(snapshot.noticePolicy, standing)
    // A kind that belongs on the composer still has to reach someone: when no
    // composer of either kind is on screen to carry it — a board-only layout,
    // a folder that is gone where the composer would be, a zoomed dock, the
    // narrow window's overlay — the strip is the fallback rather than the
    // message going unseen.
    if (place === 'strip' || (place === 'composer' && !composerMounted)) {
      messages.push(standing.message)
      dismissals.set(standing.message.id, standing.dismiss)
    }
  }
  if (offer && surfaceFor(snapshot.noticePolicy, 'import:offer') === 'strip') {
    messages.push(offer.message)
    dismissals.set(offer.message.id, offer.dismiss)
  }
  if (!isLeader || messages.length === 0) return null
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
