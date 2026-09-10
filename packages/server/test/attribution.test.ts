import assert from 'node:assert/strict'
import { test } from 'node:test'

import { splitContext, type ConfigOption, type Turn, type UserContent } from '@harnessdesk/protocol'

import {
  ATTRIBUTION_SOURCE,
  attributionLine,
  lastAttributionIn,
  seatLabel,
  withAttribution,
} from '../src/attribution.js'

/**
 * The seat line is built from the agent's own labels, never from a table of
 * ours, so the fixtures below are the shapes the adapters actually declare:
 * a model with a separate effort control (Codex, Cursor), a model whose label
 * folds the effort in (Antigravity), and a model with no label at all
 * (Gemini CLI's raw ids).
 */

const select = (id: string, current: string, choices: readonly [string, string][]): ConfigOption => ({
  type: 'select',
  id,
  label: id,
  currentValue: current,
  choices: choices.map(([value, label]) => ({ value, label })),
})

test('the seat is the agent, the model by its label, then a separate effort', () => {
  const options = [
    select('model', 'gpt-5.4', [['gpt-5.4', 'GPT-5.4']]),
    select('effort', 'high', [['high', 'High']]),
  ]
  assert.equal(seatLabel('Codex', options), 'Codex GPT-5.4 · High')
})

test('an effort folded into the model’s own label is written the same way', () => {
  const options = [select('model', 'gemini-3.8-flash-high', [['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)']])]
  assert.equal(seatLabel('Google Antigravity', options), 'Google Antigravity Gemini 3.8 Flash · High')
})

test('a model with no label is named by its id, and an agent with no model by its name alone', () => {
  assert.equal(seatLabel('Gemini CLI', [select('model', 'gemini-3.5-flash', [])]), 'Gemini CLI gemini-3.5-flash')
  assert.equal(seatLabel('Gemini CLI', []), 'Gemini CLI')
  // A boolean control under an effort id is not an effort label.
  const thinking: ConfigOption = { type: 'boolean', id: 'reasoning', label: 'Thinking', currentValue: true }
  assert.equal(seatLabel('Cursor', [thinking]), 'Cursor')
})

test('the line links the desk and brackets the seat', () => {
  assert.equal(
    attributionLine('Gemini CLI gemini-3.5-flash'),
    '🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Gemini CLI gemini-3.5-flash)',
  )
})

test('the instruction rides on the last text block, in the desk’s own envelope', () => {
  const line = attributionLine('Codex GPT-5.4 · High')
  const input: UserContent[] = [
    { type: 'text', text: 'Open the PR.' },
    { type: 'image', url: 'data:image/png;base64,AA==' },
  ]
  const sent = withAttribution(input, line)
  assert.equal(sent.length, 2, 'nothing was added as a block of its own')
  assert.equal(sent[1], input[1], 'the image is untouched')
  const text = sent[0]
  assert.equal(text?.type, 'text')
  if (text?.type !== 'text') return
  const split = splitContext(text.text)
  assert.equal(split.text, 'Open the PR.', 'the person’s words come back whole')
  assert.equal(split.injections[0]?.label, ATTRIBUTION_SOURCE)
  assert.ok(split.injections[0]?.text.includes(line), 'the envelope carries the exact line')
  assert.ok(split.injections[0]?.text.startsWith('When you open or update a pull request'))
})

test('a turn with no text gets the envelope as a text block of its own', () => {
  const sent = withAttribution([{ type: 'image', url: 'data:image/png;base64,AA==' }], attributionLine('Codex'))
  assert.equal(sent.length, 2)
  assert.equal(sent[1]?.type, 'text')
})

test('only an effort word is folded out of a model’s brackets; a version or a size stays as the model wrote it', () => {
  const named = (label: string): ConfigOption[] => [select('model', 'm', [['m', label]])]
  assert.equal(seatLabel('Antigravity', named('Gemini 3.8 Flash (Medium)')), 'Antigravity Gemini 3.8 Flash · Medium')
  assert.equal(seatLabel('Anywhere', named('Llama 3.3 (70B)')), 'Anywhere Llama 3.3 (70B)')
  assert.equal(seatLabel('Anywhere', named('GPT-4o (2024-08-06)')), 'Anywhere GPT-4o (2024-08-06)')
  assert.equal(seatLabel('Anywhere', named('Claude 3.7 Sonnet (Hybrid)')), 'Anywhere Claude 3.7 Sonnet (Hybrid)')
})

test('the line a conversation was last told is read back from its own transcript', () => {
  const line = attributionLine('Codex GPT-5.4 · High')
  const older = attributionLine('Codex GPT-5.4 · Low')
  const user = (text: string) => ({ id: 'u', type: 'userMessage' as const, content: [{ type: 'text' as const, text }] })
  const turns = [
    { id: 't1', status: 'completed', items: [user((withAttribution([{ type: 'text', text: 'first' }], older)[0] as { text: string }).text)] },
    { id: 't2', status: 'completed', items: [user('nothing riding on this one')] },
    { id: 't3', status: 'completed', items: [user((withAttribution([{ type: 'text', text: 'third' }], line)[0] as { text: string }).text)] },
    { id: 't4', status: 'completed', items: [user('plain again')] },
  ] as unknown as Turn[]
  assert.equal(lastAttributionIn(turns), line, 'the newest envelope wins, not the first')
  assert.equal(lastAttributionIn(turns.slice(0, 2)), older)
  assert.equal(lastAttributionIn([turns[1]!]), null)
  assert.equal(lastAttributionIn([]), null)
})
