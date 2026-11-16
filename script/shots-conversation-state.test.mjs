import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversationState } from './shots/conversation-state.mjs'

const doc = (heads, answer = '') => ({
  body: { innerText: answer },
  querySelectorAll: () => heads.map(([textContent, expanded]) => ({ textContent, getAttribute: () => expanded, querySelector: () => /^Worked/.test(textContent) ? { textContent } : null })),
})
test('conversation readiness distinguishes running, missing, and completed work', () => {
  assert.deepEqual(conversationState(doc([])), { headers: 0, finished: 0, expanded: false, answer: false })
  assert.equal(conversationState(doc([['Working for 3s', 'true']])).finished, 0)
  assert.equal(conversationState(doc([['Stopped after 3s', 'false']])).finished, 0)
  const troubled = { textContent: 'Worked for 3s', getAttribute: () => 'true', querySelector: () => null }
  assert.equal(conversationState({ body: { innerText: '' }, querySelectorAll: () => [troubled] }).finished, 0)
  assert.deepEqual(conversationState(doc([['Worked', 'false']], '502 is retryable alongside 503 and 504 now')), { headers: 1, finished: 1, expanded: false, answer: true })
  assert.equal(conversationState(doc([['Worked for 3s', 'true']])).expanded, true)
})

test('finished label remains detectable beside an adjacent receipt', () => {
  const head = { textContent: 'Worked· read 3 files', getAttribute: () => 'false', querySelector: () => ({ textContent: 'Worked' }) }
  const document = { body: { innerText: '502 is retryable alongside 503 and 504 now' }, querySelectorAll: () => [head] }
  assert.equal(conversationState(document).finished, 1)
})

