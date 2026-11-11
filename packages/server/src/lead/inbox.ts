import { isWaitingOnYou, LEAD_INBOX_LIMIT, leadDisplayName, leadPersonNeeds, type LeadDeskSummary, type LeadInbox, type LeadInboxItem, type LeadWindowProjection } from '@harnessdesk/protocol'

import { scrub } from '../phone-redact.js'

/** One kept notice as the host stores it in preferences (`inbox`); read field by field, since a window writes it. */
const noticeOf = (raw: unknown): LeadInboxItem | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  if (typeof row['id'] !== 'string' || !row['id'] || typeof row['title'] !== 'string' || typeof row['at'] !== 'number' || !Number.isFinite(row['at'])) return null
  const body = typeof row['body'] === 'string' ? scrub(row['body'], 300) : ''
  return { id: `notice:${row['id']}`, kind: 'notice', title: scrub(row['title'], 160) || 'Notice', ...(body ? { detail: body } : {}), at: row['at'], needsYou: false, read: row['read'] === true,
    ...(typeof row['open'] === 'string' ? { target: row['open'] } : {}) }
}

/**
 * The Lead's own lines: the question it asked that is still open, and, when it also waits on the person, that it does.
 * An ask leaves the Lead's stage as it was, so the question is listed by the desk's own record of it (`open`), never by
 * the stage: answered, expired, replaced or talked past, it is gone.
 */
const leadItems = (window: LeadWindowProjection | null, now: number, ask: LeadInboxAsk | null | undefined, askSeenAt?: (id: string) => number | undefined): LeadInboxItem[] => {
  const asked: LeadInboxItem[] = ask ? [{ id: `ask:${ask.id}`, kind: 'ask', title: scrub(ask.question, 160) || 'A question for you', at: askSeenAt?.(ask.id) ?? now, needsYou: true, target: ask.id }] : []
  if (!window || window.stage === undefined || !isWaitingOnYou(window.stage)) return asked
  // One row for the Lead, counting each thing it waits on, by the rule the Lead's own word uses.
  const needs = Math.max(1, leadPersonNeeds(window)), count = needs > 1 ? { count: needs } : {}
  const name = leadDisplayName(window.settings?.name ?? 'dex')
  return [...asked, { id: 'lead', kind: 'lead', title: `${name} is waiting for you`, ...(window.stageReason ? { detail: scrub(window.stageReason, 300) } : {}), at: now, needsYou: true, ...count }]
}
/** The Lead's open question as the desk's presence record holds it (`LeadPresenceStore.unansweredAsk`). */
export interface LeadInboxAsk { readonly id: string; readonly question: string }

/**
 * The inbox every surface lists. What needs the person comes from the same reads the desk's own screens use: the
 * Lead's window stage and the desk summary's needs-you work (host stages, never re-derived). The kept notices are the
 * desktop bell's own list. A notice that points at work already listed as needing the person is not listed twice.
 */
export const leadInbox = (input: {
  readonly window: LeadWindowProjection | null
  readonly desk: LeadDeskSummary | null
  readonly kept: unknown
  readonly now: number
  /** When the desk first saw an ask, so the ask is dated by itself rather than by the read. */
  readonly askSeenAt?: (id: string) => number | undefined
  /** The Lead's question that is open now, or null when none is. */
  readonly ask?: LeadInboxAsk | null
}): LeadInbox => {
  const work: LeadInboxItem[] = (input.desk?.needsYou ?? []).map(item => ({
    id: `${item.kind}:${item.id}`, kind: item.kind, title: scrub(item.title ?? '', 160) || 'Untitled', ...(item.project ? { project: item.project } : {}),
    at: item.updatedAt, needsYou: true, target: item.id,
  }))
  const lead = leadItems(input.window, input.now, input.ask, input.askSeenAt)
  const waiting = [...lead, ...work.sort((a, b) => b.at - a.at)].slice(0, LEAD_INBOX_LIMIT)
  // The keys a kept notice opens the same work by: `session:<runtime>:<session>` for a chat, `team:<id>` for a Team.
  const listed = new Set(work.flatMap(item => item.kind === 'chat' ? [`session:${item.target}`] : [`team:${item.target}`, `goal:${item.target}`]))
  const notices = (Array.isArray(input.kept) ? input.kept : []).map(noticeOf)
    .filter((one): one is LeadInboxItem => one !== null && !(one.target && listed.has(one.target)))
    .sort((a, b) => b.at - a.at).slice(0, LEAD_INBOX_LIMIT)
  const more = input.desk?.needsYouMore ?? 0
  return { version: 1, needsYou: lead.reduce((sum, item) => sum + (item.count ?? 1), 0) + work.length + more, items: [...waiting, ...notices] }
}
