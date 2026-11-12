import assert from 'node:assert/strict'
import { test } from 'node:test'

import { leadWorkNamedIn, type LeadNamedWork } from '../src/index.js'

const team = (id: string, title: string, over: Partial<LeadNamedWork> = {}): LeadNamedWork => ({ kind: 'team', id, title, ...over })
const session = (id: string, title: string, over: Partial<LeadNamedWork> = {}): LeadNamedWork => ({ kind: 'session', id, title, ...over })
const ids = (found: readonly LeadNamedWork[]) => found.map(one => `${one.kind}:${one.id}`)

test('a reply with no refs names the Team its words name, in CJK text as in English (#2149)', () => {
  const items = [team('goal-1', 'build a game'), session('fake:s1', 'Fix the stalled "build a game" task'), session('fake:s2', 'Untitled')]
  assert.deepEqual(ids(leadWorkNamedIn('"build a game" 团队任务（HarnessDesk 里）：状态是需要你处理。', items)), ['team:goal-1'])
  assert.deepEqual(ids(leadWorkNamedIn('The Build A Game Team needs you.', items)), ['team:goal-1'], 'case does not matter')
  // The longer title wins its words, and the shorter one inside it is not found a second time.
  assert.deepEqual(ids(leadWorkNamedIn('I stopped Fix the stalled "build a game" task.', items)), ['session:fake:s1'])
})

test('a reply names only whole words, unique titles, named work, and at most three (#2149)', () => {
  assert.deepEqual(leadWorkNamedIn('rebuild a gamer', [team('t', 'build a game')]), [], 'inside other words is no name')
  assert.deepEqual(leadWorkNamedIn('Fix the build', [session('s', 'build')]), [], 'too light to be a name')
  assert.deepEqual(leadWorkNamedIn('new chat', [session('s', 'New chat')]), [], 'a generic title names nothing')
  assert.deepEqual(leadWorkNamedIn('ship the docs', [session('a', 'ship the docs'), session('b', 'ship the docs')]), [], 'two holders: nothing says which')
  assert.deepEqual(leadWorkNamedIn('ship the docs', [session('a', 'ship the docs', { archived: true })]), [])
  const many = ['alpha work', 'bravo work', 'charlie work', 'delta work'].map((title, at) => session(`s${at}`, title))
  assert.equal(leadWorkNamedIn('alpha work, bravo work, charlie work and delta work', many).length, 3)
  assert.deepEqual(ids(leadWorkNamedIn('看一下构建游戏吧', [team('t', '构建游戏')])), ['team:t'], 'a CJK title needs no spaces around it')
  assert.deepEqual(ids(leadWorkNamedIn('ＢＵＩＬＤ ａ ＧＡＭＥ', [team('t', 'build a game')])), ['team:t'], 'width does not matter')
})
