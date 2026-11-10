import { isWaitingOnYou, LEAD_INBOX_LIMIT, leadDisplayName, type LeadDeskSummary, type LeadInbox, type LeadInboxItem, type LeadWindowProjection } from '@harnessdesk/protocol'

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

/** The Lead's own line: its open question when it asked one, else that it waits on the person, else nothing. */
const leadItems = (window: LeadWindowProjection | null, now: number): LeadInboxItem[] => {
  if (!window || window.stage === undefined || !isWaitingOnYou(window.stage)) return []
  const messages = window.thread?.messages ?? []
  const last = messages.at(-1)
  if (last?.role === 'assistant' && last.ask) {
    return [{ id: `ask:${last.id}`, kind: 'ask', title: scrub(last.ask.question, 160) || 'A question for you', at: now, needsYou: true, target: last.id }]
  }
  const name = leadDisplayName(window.settings?.name ?? 'dex')
  return [{ id: 'lead', kind: 'lead', title: `${name} is waiting for you`, ...(window.stageReason ? { detail: window.stageReason } : {}), at: now, needsYou: true }]
}

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
}): LeadInbox => {
  const work: LeadInboxItem[] = (input.desk?.needsYou ?? []).map(item => ({
    id: `${item.kind}:${item.id}`, kind: item.kind, title: item.title || 'Untitled', ...(item.project ? { project: item.project } : {}),
    at: item.updatedAt, needsYou: true, target: item.id,
  }))
  const lead = leadItems(input.window, input.now)
  const waiting = [...lead, ...work.sort((a, b) => b.at - a.at)].slice(0, LEAD_INBOX_LIMIT)
  const listed = new Set(work.flatMap(item => [`${item.kind}:${item.target}`, `goal:${item.target}`]))
  const notices = (Array.isArray(input.kept) ? input.kept : []).map(noticeOf)
    .filter((one): one is LeadInboxItem => one !== null && !(one.target && listed.has(one.target)))
    .sort((a, b) => b.at - a.at).slice(0, LEAD_INBOX_LIMIT)
  const more = input.desk?.needsYouMore ?? 0
  return { version: 1, needsYou: lead.length + work.length + more, items: [...waiting, ...notices] }
}
