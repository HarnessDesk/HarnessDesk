import { deskContextContent, leadMessageEnvelope, leadMessageKey, type LeadChatControlList, type LeadChatHolder } from '@harnessdesk/protocol'
import { previewStore, PREVIEW_SESSION_KEY } from './harness'
import { leadProjection } from './lead-fixture'

/** Synthetic conversation, host receipt and button actions; never connects to a desk. */
export const createLeadChatFixture = (holder: LeadChatHolder = 'lead', theme: 'light' | 'dark' = 'light', scenario: 'normal' | 'offline' | 'unreadable' | 'read-error' | 'replay' = 'normal') => {
  const store = previewStore({ leadAvailable: true, theme })
  const prior = store.getSnapshot().sessions.get(PREVIEW_SESSION_KEY)!
  const id = `${prior.runtime}:${prior.id}`
  const envelope = leadMessageEnvelope('Dex', 'Run the focused tests and tell me what fails.')
  let control: LeadChatControlList = { project: '/workspace/demo', chats: [{ id, holder, sent: [leadMessageKey(id, envelope)] }], ...(scenario === 'unreadable' ? { problem: 'The Lead chat control record cannot be read safely. Lead sends and stops are blocked. Use Reset chat control in the chat notice to recover.' } : {}) }
  if (scenario === 'read-error') control = { ...control, problem: 'The desk connection was lost.' }
  if (scenario === 'replay') {
    const source = `${prior.runtime}:lead-source`
    control = { ...control, chats: [
      { id: source, holder: 'lead', sent: [leadMessageKey(source, envelope)] },
      { id, holder, sent: [leadMessageKey(id, leadMessageEnvelope('Dex', 'An earlier instruction.'))] },
    ] }
  }
  const session = { ...prior, title: 'Check the retry behavior', cwd: '/workspace/demo', goal: null, status: { type: 'idle' as const },
    turns: [{ id: 'lead-chat-turn' as never, status: 'completed' as const, items: [
      { type: 'userMessage' as const, id: 'lead-chat-user' as never, content: [deskContextContent(envelope)] },
      { type: 'assistantMessage' as const, id: 'lead-chat-answer' as never, phase: 'final' as const, text: 'The focused tests pass. The retry limit and request ordering are covered.' },
    ] }] }
  Object.assign(store.getSnapshot(), { sessions: new Map([[PREVIEW_SESSION_KEY, session]]) })
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method, params) => {
    if (method === 'lead/chats/resetControl') {
      control = { project: control.project, chats: [] }
      return control
    }
    if (method === 'lead/chat/takeOver' || method === 'lead/chat/handBack') {
      if (scenario === 'offline') throw new Error('The desk is offline. Try again when it reconnects.')
      control = { ...control, chats: control.chats.map(chat => ({ ...chat, holder: method === 'lead/chat/takeOver' ? 'person' : 'lead' })) }
      store.lead.changed({ method: 'lead/chats/controlChanged', params: control })
      return control
    }
    if (method === 'lead/chats/control') return control
    if (method === 'lead/settings/read') return leadProjection()
    return request(method, params as never)
  }) as typeof store.transport.request
  store.lead.changed({ method: 'lead/changed', params: leadProjection() })
  store.lead.changed({ method: 'lead/chats/controlChanged', params: control })
  return { store, session, id, key: PREVIEW_SESSION_KEY }
}
