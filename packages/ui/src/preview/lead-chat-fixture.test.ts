import { expect, it } from 'vitest'
import { leadMessageKey, splitContextContent, wrapContext } from '@harnessdesk/protocol'
import { createLeadChatFixture } from './lead-chat-fixture'

it('previews verified Lead words with working button-only hand over', async () => {
  const { store, session, id } = createLeadChatFixture('lead')
  const message = session.turns[0]!.items[0]!
  if (message.type !== 'userMessage') throw new Error('Expected a user turn')
  const block = splitContextContent(message.content).injections[0]!
  expect(store.lead.state.chats[0]!.sent).toEqual([leadMessageKey(id, wrapContext(block.label, block.text))])
  expect(store.lead.state.chats[0]!.holder).toBe('lead')
  await store.lead.takeOverChat(id)
  expect(store.lead.state.chats[0]!.holder).toBe('person')
  await store.lead.handBackChat(id)
  expect(store.lead.state.chats[0]!.holder).toBe('lead')
})

it('previews an offline action and explicit recovery without a desk', async () => {
  const offline = createLeadChatFixture('lead', 'light', 'offline')
  await expect(offline.store.lead.takeOverChat(offline.id)).rejects.toThrow('offline')
  const broken = createLeadChatFixture('lead', 'dark', 'unreadable')
  expect(broken.store.lead.state.chatControlProblem?.message).toContain('Reset chat control')
  await broken.store.lead.resetChatControl()
  expect(broken.store.lead.state.chatControlProblem).toBeNull()
  expect(broken.store.lead.state.chats).toEqual([])
})

it('previews a control-read failure through the existing notice', () => {
  const { store } = createLeadChatFixture('lead', 'light', 'read-error')
  expect(store.lead.state.chatControlProblem?.message).toContain('The desk connection was lost.')
})

it('previews a replayed envelope without a receipt in that chat', () => {
  const { store, id, session } = createLeadChatFixture('lead', 'dark', 'replay')
  const message = session.turns[0]!.items[0]!
  if (message.type !== 'userMessage') throw new Error('Expected a user turn')
  const block = splitContextContent(message.content).injections[0]!
  expect(store.lead.state.chats.find(chat => chat.id === id)!.sent).not.toContain(leadMessageKey(id, wrapContext(block.label, block.text)))
})
