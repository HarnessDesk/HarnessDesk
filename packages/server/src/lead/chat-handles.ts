import { LEAD_CHAT_HANDLES, leadChatHandleBase, leadChatHandleOf, type LeadJournal } from '@harnessdesk/lead'

/**
 * The host's side of chat handles: it names the chats the Lead is shown and reads a name back. The name comes from the
 * Lead's project folder and the chat's model, or its agent when the desk does not know the model; the journal keeps the
 * map, so a restart keeps every handle and none is given twice (`packages/lead/src/chat-handles.ts`).
 *
 * Naming is a convenience, never a gate: a chat the map cannot name, or one named while the journal is closing, is
 * simply shown by its id.
 */
export interface LeadChatHandlesPort {
  /** The handle a chat already has, without naming it. */
  of(id: string): string | undefined
  /** Names the chats not yet named and answers every handle it can. */
  name(ids: readonly string[]): Promise<ReadonlyMap<string, string>>
}

export const leadChatHandlesPort = (options: {
  readonly journal: Pick<LeadJournal, 'state' | 'nameChats'>
  /** The Lead's project folder: every chat it is shown is in it. */
  readonly project: () => string
  /** The chat's model as the desk knows it, if it does. */
  readonly model: (id: string) => string | null | undefined
}): LeadChatHandlesPort => ({
  of: id => leadChatHandleOf(options.journal.state.chatHandles, id),
  name: async ids => {
    const unique = [...new Set(ids)]
    const wanted = unique.filter(id => leadChatHandleOf(options.journal.state.chatHandles, id) === undefined).map(id => {
      let model: string | null | undefined
      try { model = options.model(id) } catch { model = null }
      return { id, base: leadChatHandleBase({ project: options.project(), agent: id.slice(0, Math.max(0, id.indexOf(':'))), model }) }
    })
    try { for (let at = 0; at < wanted.length; at += LEAD_CHAT_HANDLES.perRecord) await options.journal.nameChats(wanted.slice(at, at + LEAD_CHAT_HANDLES.perRecord)) }
    catch { /* Shown by its id: a name is never a gate. */ }
    const out = new Map<string, string>()
    for (const id of unique) { const handle = leadChatHandleOf(options.journal.state.chatHandles, id); if (handle) out.set(id, handle) }
    return out
  },
})
