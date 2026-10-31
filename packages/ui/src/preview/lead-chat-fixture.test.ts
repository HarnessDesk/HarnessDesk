import { expect, it } from 'vitest'
import { leadMessageKey, splitContextContent, wrapContext } from '@harnessdesk/protocol'
import { createLeadChatFixture } from './lead-chat-fixture'

it('previews verified Lead words with working button-only hand over', async () => {
  const { store, session, id } = createLeadChatFixture('lead')
  const message = session.turns[0]!.items[0]!
  if (message.type !== 'userMessage') throw new Error('Expected a user turn')
  const block = splitContextContent(message.content).injections[0]!
  expect(store.lead.state.chats[0]!.sent).toEqual([leadMessageKey(wrapContext(block.label, block.text))])
  expect(store.lead.state.chats[0]!.holder).toBe('lead')
  await store.lead.takeOverChat(id)
  expect(store.lead.state.chats[0]!.holder).toBe('person')
  await store.lead.handBackChat(id)
  expect(store.lead.state.chats[0]!.holder).toBe('lead')
})
