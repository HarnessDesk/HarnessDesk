import { describe, expect, it } from 'vitest'

import type { ConfigOption } from '@harnessdesk/protocol'

import { optionsBySlot, slotForCategory } from './composer-slots'
import * as mapping from './composer-slots'

describe('composer option slots', () => {
  it.each([
    ['_permissions', 'permissions'],
    ['mode', 'mode'],
    ['model', 'model'],
    ['thought_level', 'model'],
    ['other', 'more'],
    ['model_config', 'more'],
    ['_x', 'more'],
    [undefined, 'more'],
  ] as const)('maps %s to %s', (category, expected) => {
    expect(slotForCategory(category)).toBe(expected)
  })

  it('keeps every option in its agent order, including options with the same category', () => {
    const one = { id: 'first', category: 'mode' }
    const two = { id: 'second', category: 'mode' }
    const three = { id: 'third', category: 'model' }

    const slots = optionsBySlot([one, two, three] as ConfigOption[])

    expect(slots.mode).toEqual([one, two])
    expect(slots.model).toEqual([three])
    expect(slots.permissions).toEqual([])
    expect(slots.more).toEqual([])
  })

  it.each([
    {
      shape: 'shape one',
      options: [
        { id: 'mode', category: 'mode' },
        { id: 'model', category: 'model' },
        { id: 'permissions', category: '_permissions' },
        { id: 'other', category: 'other' },
      ],
      expected: { permissions: ['permissions'], mode: ['mode'], model: ['model'], more: ['other'] },
    },
    {
      shape: 'shape two',
      options: [
        { id: 'mode', category: 'mode' },
        { id: 'model', category: 'model' },
        { id: 'config', category: 'model_config' },
        { id: 'reasoning', category: 'thought_level' },
      ],
      expected: { permissions: [], mode: ['mode'], model: ['model', 'reasoning'], more: ['config'] },
    },
    {
      shape: 'shape three',
      options: [
        { id: 'mode', category: 'mode' },
        { id: 'reasoning', category: 'thought_level' },
        { id: 'other', category: 'other' },
      ],
      expected: { permissions: [], mode: ['mode'], model: ['reasoning'], more: ['other'] },
    },
    {
      shape: 'shape four',
      options: [
        { id: 'mode', category: 'mode' },
        { id: 'model', category: 'model' },
        { id: 'reasoning', category: 'thought_level' },
        { id: 'permissions', category: '_permissions' },
        { id: 'other', category: 'other' },
      ],
      expected: { permissions: ['permissions'], mode: ['mode'], model: ['model', 'reasoning'], more: ['other'] },
    },
  ] as const)('places each option for $shape', ({ options, expected }) => {
    const slots = optionsBySlot(options as unknown as ConfigOption[])
    expect(Object.fromEntries(Object.entries(slots).map(([slot, entries]) => [slot, entries.map(({ id }) => id)])))
      .toEqual(expected)
  })
})

const before: ConfigOption[] = [
  { id: 'model', type: 'select', label: 'Model', category: 'model', currentValue: 'old', choices: [{ value: 'old', label: 'Old model' }] },
  { id: 'mode', type: 'select', label: 'Mode', category: 'mode', currentValue: 'plan', choices: [{ value: 'plan', label: 'Plan' }] },
]

it('describes missing options, removed choices and agent-rejected values with their saved value', () => {
  const options: ConfigOption[] = [
    { ...before[0]!, currentValue: 'current', choices: [{ value: 'current', label: 'Current model' }] } as ConfigOption,
    { id: 'effort', label: 'Effort', type: 'select', category: 'thought_level', currentValue: 'low', choices: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] },
    { id: 'accepted', label: 'Accepted', type: 'boolean', currentValue: false },
  ]
  expect(mapping.staleDefaults?.({ model: 'old', mode: 'plan', effort: 'high', accepted: false }, options, before)).toEqual([
    { id: 'model', label: 'Model', category: 'model', value: 'old', valueLabel: 'Old model', reason: 'This value is no longer offered.' },
    { id: 'mode', label: 'Mode', category: 'mode', value: 'plan', valueLabel: 'Plan', reason: 'This setting is no longer offered.' },
    { id: 'effort', label: 'Effort', category: 'thought_level', value: 'high', valueLabel: 'High', reason: 'The agent returned a different value.' },
  ])
})
