import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { screenPropertySideOf } from './design-audit.mjs'

describe('padding reclassification: system-token spacing is layout', () => {
  test('padding: var(--hd-space-*) is layout', () => {
    assert.equal(screenPropertySideOf('padding', 'var(--hd-space-2)'), 'layout')
    assert.equal(screenPropertySideOf('padding', 'var(--hd-space-0-5) var(--hd-space-2-5)'), 'layout')
    assert.equal(screenPropertySideOf('padding', 'var(--hd-space-1) var(--hd-space-3) var(--hd-space-3)'), 'layout')
    assert.equal(screenPropertySideOf('padding', '0 var(--hd-space-2)'), 'layout')
    assert.equal(screenPropertySideOf('padding-right', 'var(--hd-space-3)'), 'layout')
    assert.equal(screenPropertySideOf('padding-bottom', 'var(--hd-space-2)'), 'layout')
    assert.equal(screenPropertySideOf('padding', 'var(--hd-space-2-5) var(--hd-space-3)'), 'layout')
  })

  test('padding: raw pixel is still appearance', () => {
    assert.equal(screenPropertySideOf('padding', '4px'), 'appearance')
    assert.equal(screenPropertySideOf('padding', '10px 12px'), 'appearance')
    assert.equal(screenPropertySideOf('padding', '0 12px'), 'appearance')
  })

  test('padding: non-spacing tokens is still appearance', () => {
    assert.equal(screenPropertySideOf('padding', 'var(--hd-radius-md)'), 'appearance')
    assert.equal(screenPropertySideOf('padding', 'var(--hd-foreground)'), 'appearance')
  })

  test('padding: mix of token and raw is still appearance', () => {
    assert.equal(screenPropertySideOf('padding', '4px var(--hd-space-2)'), 'appearance')
  })
})

describe('height reclassification: system control tokens are layout', () => {
  test('height: var(--hd-control-h-sm) is layout', () => {
    assert.equal(screenPropertySideOf('height', 'var(--hd-control-h-sm)'), 'layout')
    assert.equal(screenPropertySideOf('height', 'var(--hd-titlebar-height)'), 'layout')
    assert.equal(screenPropertySideOf('height', 'var(--hd-bar-height, 42px)'), 'layout')
  })

  test('height: raw pixel is still appearance', () => {
    assert.equal(screenPropertySideOf('height', '34px'), 'appearance')
    assert.equal(screenPropertySideOf('height', '200px'), 'appearance')
  })

  test('height: 100%, auto, fit-content, etc. are layout', () => {
    assert.equal(screenPropertySideOf('height', '100%'), 'layout')
    assert.equal(screenPropertySideOf('height', 'auto'), 'layout')
    assert.equal(screenPropertySideOf('height', 'fit-content'), 'layout')
    assert.equal(screenPropertySideOf('height', '0'), 'layout')
    assert.equal(screenPropertySideOf('height', '0px'), 'layout')
  })

  test('height: non-system tokens are still appearance', () => {
    assert.equal(screenPropertySideOf('height', 'var(--hd-radius-md)'), 'appearance')
  })
})
