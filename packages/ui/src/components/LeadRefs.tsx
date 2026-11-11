import { useEffect, useSyncExternalStore } from 'react'
import { LEAD_PULL_REQUEST_REF, leadTeamKey, runtimeId, sessionId, sessionKey, type LeadDigestRef, type LeadMessageRef, type LeadWorkBoard, type RuntimeId, type SessionId } from '@harnessdesk/protocol'
import { Button, InlineParts } from '../design'
import { useSnapshot, useStore } from '../state/context'
import type { AppSnapshot } from '../state/snapshot'
import type { AppStore } from '../state/store'
import { openExternal } from '../lib/desktop'
import { sanitizeText } from '../lib/sanitize'

/** Where one link a reply carries goes, once the desk has confirmed it. */
export type LeadRefTarget =
  | { readonly kind: 'chat'; readonly runtime: RuntimeId; readonly session: SessionId }
  | { readonly kind: 'team'; readonly id: string }
  | { readonly kind: 'goal'; readonly id: string }
  | { readonly kind: 'pr'; readonly repository: string; readonly number: string }
  /** A decision card in the Lead conversation. */
  | { readonly kind: 'card'; readonly id: string }

export interface LeadRefLink { readonly key: string; readonly label: string; readonly title: string; readonly target: LeadRefTarget }

/** What the desk knows, read to confirm a ref. Only what is here can become a link. */
export interface LeadRefDesk {
  readonly runtimes: AppSnapshot['runtimes']
  readonly sessions: AppSnapshot['sessions']
  readonly teams: AppSnapshot['teams']
  readonly goals: AppSnapshot['goals']
  /** The `runtime:session` ids the Lead holds or has held: its chats and the work board's. */
  readonly chats: ReadonlySet<string>
  readonly work: LeadWorkBoard | null
}

const FALLBACK: Record<LeadMessageRef['kind'], string> = { team: 'Team', goal: 'Team', session: 'Chat', chat: 'Chat', work: 'Work item' }

/** The model's own title, as plain text. It names a ref only when the desk has no name of its own for it. */
const modelTitle = (ref: LeadMessageRef) => {
  const title = ref.title ? sanitizeText(ref.title).replace(/\s+/g, ' ').trim() : ''
  return title || FALLBACK[ref.kind]
}

const chatTarget = (id: string, desk: LeadRefDesk): { target: LeadRefTarget; title: string | null } | null => {
  const at = id.indexOf(':')
  if (at <= 0) return null
  const runtime = runtimeId(id.slice(0, at)), session = sessionId(id.slice(at + 1))
  if (!desk.runtimes.some(one => one.id === runtime)) return null
  const known = desk.sessions.get(sessionKey(runtime, session))
  if (!known && !desk.chats.has(id)) return null
  return { target: { kind: 'chat', runtime, session }, title: known?.title?.trim() || null }
}

/**
 * The links a reply's refs become. A ref is only a pointer the model wrote: it turns into a link only when the desk
 * itself has what it names, and it is labelled with the desk's own name for it before the model's. Anything the desk
 * cannot find is left out, never drawn as a link that goes nowhere.
 */
export const leadRefLinks = (refs: readonly LeadMessageRef[], desk: LeadRefDesk): readonly LeadRefLink[] => {
  const links: LeadRefLink[] = [], seen = new Set<string>()
  const add = (ref: LeadMessageRef, target: LeadRefTarget, label: string, title: string) => {
    const key = target.kind === 'chat' ? `chat:${target.runtime}:${target.session}` : target.kind === 'pr' ? `pr:${target.repository}#${target.number}` : `${target.kind}:${target.id}`
    if (seen.has(key)) return
    seen.add(key)
    links.push({ key, label, title, target })
  }
  for (const ref of refs) {
    if (ref.kind === 'chat' || ref.kind === 'session') {
      const found = chatTarget(ref.id, desk)
      if (found) add(ref, found.target, found.title ?? modelTitle(ref), 'Open the chat')
    } else if (ref.kind === 'team' || ref.kind === 'goal') {
      const found = teamTarget(ref.id, desk)
      if (found) add(ref, found.target, found.name || modelTitle(ref), 'Open the Team')
    } else {
      const item = desk.work?.items.find(one => one.id === ref.id), found = item ? workTarget(ref.id, desk) : null
      if (item && found) add(ref, found.target, item.title, found.title)
    }
  }
  return links
}

/**
 * The Team a ref names, by any id the desk knows it by: a goal's own id, the room its board is (what the Lead's tools
 * call a Team, and what the phone also matches), or a room the desk holds with no goal. A goal opens by its goal id,
 * so a reply naming one Team both ways is one link. The Team's own name comes before the goal's sentence.
 */
const teamTarget = (id: string, desk: LeadRefDesk): { target: LeadRefTarget; name: string | null } | null => {
  const goal = desk.goals.get(leadTeamKey([...desk.goals.values()].map(view => ({ goal: view.goal.id, room: view.board?.id ?? null })))(id))
  if (goal) {
    const board = desk.teams.get(goal.goal.id) ?? goal.board
    return { target: { kind: 'goal', id: goal.goal.id }, name: board?.name?.trim() || goal.goal.sentence?.trim() || null }
  }
  const team = desk.teams.get(id)
  return team ? { target: { kind: 'team', id }, name: team.name?.trim() || null } : null
}

/** Where a work item opens: its newest chat, else its Team, else its pull request; null when the desk has none of them. */
const workTarget = (id: string, desk: LeadRefDesk): { target: LeadRefTarget; title: string } | null => {
  const item = desk.work?.items.find(one => one.id === id)
  if (!item) return null
  const chat = item.links.chats.at(-1), team = item.links.teams.at(-1), pr = item.links.prs.at(-1)?.match(LEAD_PULL_REQUEST_REF)
  const found = chat ? chatTarget(chat, { ...desk, chats: new Set([...desk.chats, chat]) }) : null
  if (found) return { target: found.target, title: 'Open its chat' }
  const room = team ? teamTarget(team, desk) : null
  if (room) return { target: room.target, title: 'Open its Team' }
  if (pr) return { target: { kind: 'pr', repository: `${pr[1]}/${pr[2]}`, number: pr[3]! }, title: `Open pull request ${pr[1]}/${pr[2]}#${pr[3]}` }
  return null
}

/**
 * Where a digest item opens, with the tooltip that says so. The host chose the ref from the work ledger, so a chat it
 * names is one the Lead's work holds; it still becomes a link only when this desk has the agent, the Team or the work
 * item it names. A decision card is in the Lead conversation itself. Null: the row stays a plain reading.
 */
export const leadDigestTarget = (ref: LeadDigestRef | undefined, desk: LeadRefDesk): { readonly target: LeadRefTarget; readonly title: string } | null => {
  if (!ref) return null
  if (ref.kind === 'chat') { const found = chatTarget(ref.id, { ...desk, chats: new Set([...desk.chats, ref.id]) }); return found ? { target: found.target, title: 'Open the chat' } : null }
  if (ref.kind === 'team') { const room = teamTarget(ref.id, desk); return room ? { target: room.target, title: 'Open the Team' } : null }
  if (ref.kind === 'pr') { const pr = ref.id.match(LEAD_PULL_REQUEST_REF); return pr ? { target: { kind: 'pr', repository: `${pr[1]}/${pr[2]}`, number: pr[3]! }, title: `Open pull request ${pr[1]}/${pr[2]}#${pr[3]}` } : null }
  if (ref.kind === 'card') return { target: { kind: 'card', id: ref.id }, title: 'Show the decision' }
  return workTarget(ref.id, desk)
}

/** Opens what a link names: a chat, a Team, a pull request in the browser, or a decision card in the Lead conversation. */
export const openLeadRefTarget = (store: Pick<AppStore, 'openSession' | 'openTeamRoom' | 'openGoal' | 'openDestination'>, target: LeadRefTarget): void => {
  if (target.kind === 'chat') void store.openSession(target.session, { runtime: target.runtime })
  else if (target.kind === 'team') store.openTeamRoom(target.id)
  else if (target.kind === 'goal') store.openGoal(target.id)
  else if (target.kind === 'card') store.openDestination({ kind: 'lead', focus: target.id })
  else openExternal(`https://github.com/${target.repository}/pull/${target.number}`)
}

/** The chats, Teams and work a reply names, as links under it that open them. */
export const LeadRefs = ({ refs }: { readonly refs: readonly LeadMessageRef[] }) => {
  const store = useStore(), snapshot = useSnapshot()
  const state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const wantsWork = refs.some(ref => ref.kind === 'work')
  useEffect(() => { if (wantsWork && !state.work) void store.lead.readWork().catch(() => {}) }, [store, wantsWork, state.work])
  const chats = new Set([...(state.chats ?? []).map(chat => chat.id), ...(state.work?.items ?? []).flatMap(item => item.links.chats)])
  const links = leadRefLinks(refs, { runtimes: snapshot.runtimes, sessions: snapshot.sessions, teams: snapshot.teams, goals: snapshot.goals, chats, work: state.work ?? null })
  if (!links.length) return null
  const open = (target: LeadRefTarget) => openLeadRefTarget(store, target)
  return <div data-slot="lead-refs"><InlineParts>
    {links.map(link => <Button key={link.key} variant="link" size="inline-link" title={link.title} onClick={() => open(link.target)}>{link.label}</Button>)}
  </InlineParts></div>
}
