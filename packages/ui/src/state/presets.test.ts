import { describe, expect, test } from 'vitest'

import type { ConfigOption } from '@harnessdesk/protocol'

import { matchPreset, presetsFor, readCustomPresets, snapshotValues } from './presets'

/**
 * Presets are snapshots of option values, bound to one runtime. The properties
 * that matter: a preset from another runtime is never offered or matched, and
 * changing any control the preset mentions detaches its name.
 */

const options: ConfigOption[] = [
  {
    type: 'select',
    id: 'permissions',
    category: '_permissions',
    label: 'Permissions',
    currentValue: ':workspace',
    choices: [
      { value: ':read-only', label: 'Read only' },
      { value: ':workspace', label: 'Workspace' },
    ],
  },
  { type: 'boolean', id: 'shout', category: 'other', label: 'Shout', currentValue: false },
]

const careful = {
  id: 'careful',
  name: 'Careful',
  description: '',
  runtime: 'codex',
  values: { permissions: ':workspace' },
}

describe('matchPreset', () => {
  test('matches when every recorded value is current, ignoring options it does not mention', () => {
    expect(matchPreset('codex', options, [careful])?.id).toBe('careful')
  })

  test('changing a control the preset mentions detaches it', () => {
    const changed = options.map((option) =>
      option.id === 'permissions' ? { ...option, currentValue: ':read-only' } : option,
    ) as ConfigOption[]
    expect(matchPreset('codex', changed, [careful])).toBeUndefined()
  })

  test('a preset from another runtime never matches, even with identical ids', () => {
    expect(matchPreset('other-agent', options, [careful])).toBeUndefined()
  })

  test('an empty preset matches nothing rather than everything', () => {
    expect(matchPreset('codex', options, [{ ...careful, values: {} }])).toBeUndefined()
  })

  test('no options means no match', () => {
    expect(matchPreset('codex', undefined, [careful])).toBeUndefined()
  })
})

describe('snapshotValues', () => {
  test('records every option by id', () => {
    expect(snapshotValues(options)).toEqual({ permissions: ':workspace', shout: false })
  })
})

describe('presetsFor', () => {
  test('offers only the selected runtime’s presets', () => {
    const other = { ...careful, id: 'x', runtime: 'other' }
    expect(presetsFor('codex', [careful, other])).toEqual([careful])
    expect(presetsFor(null, [careful, other])).toEqual([])
  })
})

describe('readCustomPresets', () => {
  test('reads well-formed entries', () => {
    const presets = readCustomPresets([
      { id: 'mine', name: 'Mine', description: 'x', runtime: 'codex', values: { effort: 'high', shout: true } },
    ])
    expect(presets).toHaveLength(1)
    expect(presets[0]?.values).toEqual({ effort: 'high', shout: true })
  })

  test('skips malformed entries instead of throwing', () => {
    // The state file is a plain JSON document a user can edit by hand.
    expect(readCustomPresets('nonsense')).toEqual([])
    expect(readCustomPresets([null, 42, { id: 'x' }])).toEqual([])
    expect(readCustomPresets([{ id: 'x', name: 'X', runtime: 'codex', values: 'no' }])).toEqual([])
  })

  test('drops values that are not option values, and entries in the old shape', () => {
    expect(
      readCustomPresets([
        { id: 'x', name: 'X', runtime: 'codex', values: { ok: 'yes', bad: 42, worse: null } },
        { id: 'old', name: 'Old', settings: { approvalPolicy: 'never', sandboxPolicy: 'readOnly' } },
      ]),
    ).toEqual([{ id: 'x', name: 'X', description: '', runtime: 'codex', values: { ok: 'yes' } }])
  })
})
