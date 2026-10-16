import assert from 'node:assert/strict'
import { test } from 'node:test'

import { unitsToRun } from '../e2e/ui-system/impact-units.ts'

test('only a nonempty selection of known units narrows a spec', () => {
  const previous = process.env.UI_SYSTEM_UNITS
  const spec = 'guides-standard.spec.ts'
  const known = ['one', 'two']
  try {
    for (const value of [undefined, '', '{', 'null', '[]', '1', '{}',
      JSON.stringify({ [spec]: [] }), JSON.stringify({ [spec]: ['missing'] }),
      JSON.stringify({ [spec]: ['one', 'missing'] }), JSON.stringify({ [spec]: 'one' }),
      JSON.stringify({ [spec]: [1] }), JSON.stringify({ [spec]: [''] })]) {
      if (value === undefined) delete process.env.UI_SYSTEM_UNITS
      else process.env.UI_SYSTEM_UNITS = value
      assert.equal(unitsToRun(spec, known), null, `run whole for ${value}`)
    }
    process.env.UI_SYSTEM_UNITS = JSON.stringify({ [spec]: ['two', 'two'] })
    assert.deepEqual([...unitsToRun(spec, known)], ['two'])
  } finally {
    if (previous === undefined) delete process.env.UI_SYSTEM_UNITS
    else process.env.UI_SYSTEM_UNITS = previous
  }
})
