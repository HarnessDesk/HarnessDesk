import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ConfigOption } from '@harnessdesk/protocol'

import { seatOf } from '../src/seat.js'

/**
 * The seat is built from the agent's own labels, never from a table of ours,
 * so the fixtures below are the shapes the adapters actually declare: a model
 * with a separate effort control (Codex, Cursor), a model whose label folds
 * the effort in (Antigravity), a model with no label at all (Gemini CLI's raw
 * ids), and the automatic choice that is not a model.
 */

const select = (id: string, current: string, choices: readonly [string, string][]): ConfigOption => ({
  type: 'select',
  id,
  label: id,
  currentValue: current,
  choices: choices.map(([value, label]) => ({ value, label })),
})

test('the seat is the agent, the model by its label, then a separate effort', () => {
  const seat = seatOf(
    'Codex',
    [select('model', 'gpt-5.4', [['gpt-5.4', 'GPT-5.4']]), select('effort', 'high', [['high', 'High']])],
    '0.153.0',
  )
  assert.deepEqual(seat, {
    agent: 'Codex',
    version: '0.153.0',
    model: 'GPT-5.4',
    effort: 'High',
    thinking: false,
    label: 'Codex GPT-5.4 · High',
  })
})

test('an effort folded into the model’s own label is split back out', () => {
  const seat = seatOf('Google Antigravity', [
    select('model', 'gemini-3.8-flash-high', [['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)']]),
  ])
  assert.equal(seat.model, 'Gemini 3.8 Flash')
  assert.equal(seat.effort, 'High')
  assert.equal(seat.label, 'Google Antigravity Gemini 3.8 Flash · High')
})

test('only an effort word is folded out of a model’s brackets; a version or a size stays as the model wrote it', () => {
  const named = (label: string): ConfigOption[] => [select('model', 'm', [['m', label]])]
  assert.equal(seatOf('Antigravity', named('Gemini 3.8 Flash (Medium)')).label, 'Antigravity Gemini 3.8 Flash · Medium')
  assert.equal(seatOf('Anywhere', named('Llama 3.3 (70B)')).label, 'Anywhere Llama 3.3 (70B)')
  assert.equal(seatOf('Anywhere', named('GPT-4o (2024-08-06)')).label, 'Anywhere GPT-4o (2024-08-06)')
  assert.equal(seatOf('Anywhere', named('Claude 3.7 Sonnet (Hybrid)')).label, 'Anywhere Claude 3.7 Sonnet (Hybrid)')
})

test('a model with no label is named by its id, and an agent with no model by its name alone', () => {
  assert.equal(seatOf('Gemini CLI', [select('model', 'gemini-3.5-flash', [])]).label, 'Gemini CLI gemini-3.5-flash')
  assert.equal(seatOf('Gemini CLI', []).label, 'Gemini CLI')
  assert.equal(seatOf('Gemini CLI', []).model, null)
})

test('the automatic choice is not a model: the seat is the agent alone', () => {
  // Gemini CLI labels a real id "Auto"; Cursor spells the family `auto` in both.
  assert.equal(seatOf('Gemini CLI', [select('model', 'auto', [['auto', 'Auto']])]).label, 'Gemini CLI')
  assert.equal(seatOf('Cursor', [select('model', 'auto', [['auto', 'auto']])]).label, 'Cursor')
  assert.equal(seatOf('Anything', [select('model', 'x', [['x', 'Default']])]).model, null)
  // With an effort control set, the effort still signs.
  assert.equal(
    seatOf('Cursor', [select('model', 'auto', [['auto', 'Auto']]), select('effort', 'high', [['high', 'High']])]).label,
    'Cursor · High',
  )
})

test('a boolean under an effort id is a thinking switch, not an effort', () => {
  const thinking: ConfigOption = { type: 'boolean', id: 'reasoning', label: 'Thinking', currentValue: true }
  const seat = seatOf('Cursor', [select('model', 'gemini-3.8-flash', [['gemini-3.8-flash', 'Gemini 3.8 Flash']]), thinking])
  assert.equal(seat.effort, null)
  assert.equal(seat.thinking, true)
  assert.equal(seat.label, 'Cursor Gemini 3.8 Flash')
})

test('a blank version is no version', () => {
  assert.equal(seatOf('Codex', [], '  ').version, null)
  assert.equal(seatOf('Codex', [], null).version, null)
})
