import { describe, expect, test } from 'vitest'

import type { ConfigOption, SelectOption } from '@harnessdesk/protocol'

import { describesEveryChoice, riskTone, summarise } from './options'

const select = (id: string, current: string, risk?: 'elevated' | 'high'): ConfigOption => ({
  type: 'select',
  id,
  label: id,
  currentValue: current,
  choices: [
    { value: 'safe', label: 'Safe' },
    { value: current === 'safe' ? 'other' : current, label: 'Risky', ...(risk ? { risk } : {}) },
  ],
})

describe('riskTone', () => {
  test('calm when every current choice is unmarked', () => {
    expect(riskTone([select('a', 'safe'), select('b', 'safe')])).toBe('calm')
  })

  test('the loudest current choice wins, wherever it sits', () => {
    expect(riskTone([select('a', 'safe'), select('b', 'x', 'elevated')])).toBe('warn')
    expect(riskTone([select('a', 'x', 'elevated'), select('b', 'y', 'high')])).toBe('alert')
  })

  test('a risky choice that is not current does not colour the control', () => {
    // The risk is on the "Risky" choice; the current value is "safe".
    expect(riskTone([select('a', 'safe', 'high')])).toBe('calm')
  })
})

describe('summarise', () => {
  test('names the current choice of each select and only the on toggles', () => {
    const options: ConfigOption[] = [
      select('a', 'safe'),
      { type: 'boolean', id: 'x', label: 'Shout', currentValue: true },
      { type: 'boolean', id: 'y', label: 'Whisper', currentValue: false },
    ]
    expect(summarise(options)).toBe('Safe · Shout')
  })
})

describe('describesEveryChoice', () => {
  const list = (...descriptions: (string | undefined)[]): SelectOption => ({
    type: 'select',
    id: 'model',
    label: 'Model',
    currentValue: '0',
    choices: descriptions.map((description, index) => ({
      value: String(index),
      label: `Choice ${index}`,
      ...(description === undefined ? {} : { description }),
    })),
  })

  test('a described column stays on screen', () => {
    expect(describesEveryChoice(list('Latest frontier model.', 'Balanced.', 'Fast.'))).toBe(true)
  })

  test('a ragged edge does not', () => {
    expect(describesEveryChoice(list("Claude Code's own setting.", undefined, undefined))).toBe(false)
  })

  test('blank is the same as absent', () => {
    expect(describesEveryChoice(list('Described.', '   '))).toBe(false)
  })

  test('a sentence that appears twice cannot tell the two rows apart', () => {
    const claude = list(
      'Opus 5 with 1M context · Best for everyday, complex tasks',
      'Opus 5 with 1M context · Best for everyday, complex tasks',
      'Sonnet 5 · Efficient for routine tasks',
    )
    expect(describesEveryChoice(claude)).toBe(false)
  })

  test('descriptions that merely share a phrase are still distinct', () => {
    const opus = list('Opus 5 with 1M context · Best for everyday', 'Opus 5 · Best for everyday')
    expect(describesEveryChoice(opus)).toBe(true)
  })

  test('an empty list has no rows to rag, either way', () => {
    expect(describesEveryChoice(list())).toBe(true)
  })
})
