import { useEffect, useRef, useState, type ReactNode } from 'react'
import { RuntimeMark } from './BrandIcons'

import type { RuntimeId } from '@harnessdesk/protocol'

import { sessionKey, type SessionId } from '@harnessdesk/protocol'

import {
  useIsFocusedPane,
  usePane,
  useRuntime,
  useRuntimeAccount,
  useRuntimeHealth,
  useSessionKey,
  useSnapshot,
  useStore,
} from '../state/context'
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
import { useShell, type ShellActions } from '../panels/views'
import { focusedComposerVisible } from '../state/workbench'
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
          // A toast with an action is really about the thing it undoes — two
          // archives in a row must leave two ways back — so it keeps a fresh
          // id per occurrence. A plain toast's words are the whole story, so
          // asking again for the identical words replaces the one already on
          // screen instead of stacking a second beside it, which is what a
          // deliberate retry of a failing action used to do.
          id: notice.action ? notice.id : `${notice.level}:${notice.message}`,
          tone: TOAST_TONE[notice.level] ?? 'neutral',
          title: notice.message,
          ...(notice.action ? { action: { label: notice.action.label, onSelect: () => notice.action?.run() } } : {}),
        },
        notice.level === 'error' ? { persist: true } : {},
      )
      store.dismissNotice(notice.id)
    }
  }, [notices, store])

  // Kept in the inbox from here, always mounted, rather than from wherever a
  // composer happens to be: a board-only layout with no composer on screen
  // at all must not be the reason a kind moved to "Inbox only" is never kept.
  useKeepsStandingInInbox()

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
  /**
   * Somewhere a kept copy of this notice can send a person back to, resolved
   * by `resolveOpen` when the inbox draws it — a sign-in target for an agent
   * that is not signed in. Named the way `InboxEntry.open` already promises:
   * a place the app knows how to go, not a callback that cannot survive a
   * relaunch.
   */
  readonly inboxOpen?: string
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
  /** See `Notice.inboxOpen`. */
  readonly inboxOpen?: string
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
        // Kept in the inbox, this is somewhere to send a person back to sign
        // in — the same runtime, whichever conversation reads the row.
        ...(driveable ? { inboxOpen: `runtime:${runtime.id}:signin` } : {}),
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
    ...(notice.inboxOpen !== undefined ? { inboxOpen: notice.inboxOpen } : {}),
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
 *
 * "Already kept" is answered from the notice policy's own `kept` list, never
 * from whether the inbox still holds the entry: the inbox is exactly the
 * thing a person can clear or read, and a policy read back from *that* would
 * put the message right back, unread, on the render after "Clear" — the same
 * standing condition being true is not news a second time.
 *
 * `kept` does not empty itself on its own: `signin:<runtime>` and
 * `health:<id>:<message>` are stable across occurrences — unlike a usage
 * key, which carries its window — so nothing about a *second* sign-out would
 * ever look like a new key. The second effect below clears the *previous*
 * key the moment this one stops being it, which is what "the occurrence
 * ended" looks like for a kind with no window of its own: signed back in,
 * the failure cleared, or simply nothing to say any more. That is also why
 * this runs once, from `Notices` (always mounted) and `SidebarNotices`, and
 * not from `ComposerNotices`: a board-only layout with no composer on screen
 * at all must not be the reason a message is never kept in the first place.
 *
 * `bodyText` carries the plain words for the inbox row when the message's own
 * body is markup (`NoticeMessage.body` is a `ReactNode`, and the inbox stores
 * a string) — see `Notice.inboxBody`. `open` is somewhere the row can send a
 * person back to — see `Notice.inboxOpen` and `resolveOpen`, below.
 */
const useKeptOnce = (
  message: NoticeMessage | null,
  kind: string | null,
  place: NoticeSurface | null,
  bodyText?: string,
  open?: string,
): void => {
  const store = useStore()
  const policy = useSnapshot().noticePolicy
  const id = message?.id ?? null
  const title = typeof message?.title === 'string' ? message.title : null
  const body = bodyText ?? (typeof message?.body === 'string' ? message.body : undefined)
  const tone = message?.tone ?? 'neutral'
  const already = id !== null && wasKept(policy, id)
  useEffect(() => {
    if (place !== 'inbox' || id === null || title === null || already) return
    store.keep({ id, ...(kind ? { kind } : {}), tone, title, ...(body ? { body } : {}), ...(open ? { open } : {}), at: Date.now() })
    store.markNoticeKept(id)
  }, [place, id, title, body, tone, kind, open, already, store])

  const previousId = useRef<string | null>(null)
  useEffect(() => {
    const before = previousId.current
    if (before !== null && before !== id) store.clearNoticeKept(before)
    previousId.current = id
  }, [id, store])
}

/**
 * Keeps the standing condition in the inbox when the person's setting is
 * "Inbox only", from `Notices` — mounted once, always, at the app's root —
 * rather than from wherever a composer happens to be. `ComposerNotices` only
 * exists where a composer does, and a board-only layout with no composer on
 * screen at all must not be the reason a message moved to the inbox is never
 * kept there in the first place.
 */
const useKeepsStandingInInbox = (): void => {
  const snapshot = useSnapshot()
  const standing = useStanding()
  const place = standing ? placeOf(snapshot.noticePolicy, standing) : null
  useKeptOnce(standing?.message ?? null, standing?.identity.kind ?? null, place, standing?.inboxBody, standing?.inboxOpen)
}

/**
 * Above the composer: the standing condition, when it belongs here and this
 * is the composer focused right now, and any decision an Agent is asking of
 * *this* composer's own audience. Mounted inside the composer's own frame,
 * so nothing else is ever covered.
 *
 * "Focused right now" is `useIsFocusedPane` — `layout.focused` or the docked
 * `workbench.focus`, whichever names the mount someone is actually working
 * in — and it names exactly one mount in the whole window, ever. That is what
 * keeps a standing condition, which is about the active agent as a whole and
 * not any one conversation, from also turning up on a second composer beside
 * this one in a split. A composer that is not focused draws nothing here for
 * it, not even a fainter copy — see `NoticeStripOutlet` for what happens when
 * the focused mount is not a composer at all, or is not visible.
 *
 * The audience for an Agent's own question is narrower still: a room's own
 * seats for a room's composer (`pane.view.room`, read off the roster this
 * project's board already keeps), a conversation's own session for a
 * conversation's — never the window's `activeSessionKey`, which can name a
 * *different* pane's conversation the moment two are open in a split.
 */
export const ComposerNotices = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const pane = usePane()
  const focused = useIsFocusedPane()
  const sessionKeyOfPane = useSessionKey()
  const standing = useStanding()
  const place = standing ? placeOf(snapshot.noticePolicy, standing) : null
  const showStanding = focused && place === 'composer' && standing !== null
  const room = pane?.view.kind === 'room' ? pane.view.room : null
  const members = room !== null ? (snapshot.teams.get(room)?.members ?? []) : null
  const asking = snapshot.agentNotices.filter((notice) => {
    const from = sessionKey(notice.from.runtime, notice.from.sessionId as SessionId)
    return members !== null ? members.includes(from) : sessionKeyOfPane !== null && from === sessionKeyOfPane
  })
  if (!showStanding && asking.length === 0) return null
  return (
    <>
      {showStanding && standing ? (
        <ComposerNotice message={standing.message} onDismiss={standing.dismiss} onMute={standing.mute} />
      ) : null}
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

/**
 * The slim strip above the panes: a dropped link, and whatever the person
 * moved here — drawn only where `host` says the layout has chosen it.
 *
 * `host` is passed in by each caller from pure layout state (`mainNoticeHost`
 * for a pane in the split tree, `noticeArea` directly for a docked panel), so
 * "which outlet draws the shared messages" is decided the same way for every
 * render rather than raced for at mount time — a caller that is not the
 * layout's answer renders nothing here, ever, not even for one frame.
 */
export const NoticeStripOutlet = ({ host }: { readonly host: boolean }) => {
  const snapshot = useSnapshot()
  const standing = useStanding()
  const offer = useImportOffer()
  if (!host) return null
  const messages: NoticeMessage[] = []
  const dismissals = new Map<string, () => void>()
  if (standing) {
    const place = placeOf(snapshot.noticePolicy, standing)
    // A kind that belongs on the composer still has to reach someone: when
    // the focused mount is not a composer that is actually visible — a
    // board-only layout, a folder that is gone where the composer would be,
    // a zoomed dock, the narrow window's overlay — the strip this outlet
    // hosts is the fallback rather than the message going unseen.
    if (place === 'strip' || (place === 'composer' && !focusedComposerVisible(snapshot.workbench, snapshot.narrowWindow))) {
      messages.push(standing.message)
      dismissals.set(standing.message.id, standing.dismiss)
    }
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
  // The Library is where the offer sends a person back, whether they act on
  // it now from the card or later from the kept copy in the inbox.
  useKeptOnce(offer?.message ?? null, 'import:offer', offerPlace, undefined, 'settings:library')
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
/**
 * What a kept notice's `open` means, in the words the shell already knows how
 * to act on — `InboxEntry.open` promises "a place the app knows how to go (a
 * settings page, a Goal)"; this is where that promise is kept for the two
 * places `useKeptOnce` currently sends one: the Library, and an agent's own
 * sign-in. A session is not spelled this way — `from` already resolves that,
 * more specifically, below — so this is only ever consulted when `from` did
 * not answer.
 */
const resolveOpen = (shell: ShellActions, open: string): (() => void) | null => {
  if (open === 'settings:library') return () => shell.reviewImports()
  const signin = /^runtime:(.+):signin$/.exec(open)
  if (signin) return () => shell.signIn(signin[1] as RuntimeId)
  return null
}

export const useInboxMessages = (): InboxMessage[] => {
  const store = useStore()
  const snapshot = useSnapshot()
  const shell = useShell()
  return snapshot.inbox.map((entry) => {
    const sender = entry.from ? snapshot.runtimes.find((info) => info.id === entry.from?.runtime) : undefined
    const sessionGo =
      sender && entry.from
        ? () => void store.openSession(entry.from!.sessionId as SessionId, { runtime: sender.id })
        : null
    const go = sessionGo ?? (entry.open ? resolveOpen(shell, entry.open) : null)
    return {
      id: entry.id,
      tone: entry.tone,
      title: entry.title,
      ...(entry.body ? { body: entry.body } : {}),
      at: entry.at,
      read: entry.read,
      ...(entry.from ? { from: entry.from.name } : {}),
      ...(sender ? { mark: <RuntimeMark runtime={sender} size={14} /> } : {}),
      ...(go ? { go } : {}),
      ...(entry.task ? { action: { label: 'Start as a task', onSelect: () => void store.startSuggestedTask(entry.id) } } : {}),
    }
  })
}
