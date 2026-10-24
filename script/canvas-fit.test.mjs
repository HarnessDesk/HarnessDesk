import assert from 'node:assert/strict'
import { test } from 'node:test'

import { shapeViewportReady } from '../e2e/ui-system/canvas-fit.ts'

test('the identity viewport is not an initial fit even at a readable scale', () => {
  assert.equal(shapeViewportReady({ scale: 1, x: 0, y: 0 }), false)
  assert.equal(shapeViewportReady({ scale: 1, x: 460, y: 59 }), true)
  assert.equal(shapeViewportReady({ scale: 0.5, x: 460, y: 59 }), false)
})
