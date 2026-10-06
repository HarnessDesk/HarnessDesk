import { describe, expect, it } from 'vitest'

import type { FlowPolicy } from '@harnessdesk/protocol'

import { boundInputIds, boundInputValues, readGraphPositions } from './shapes'

/**
 * `boundInputIds` reads `layout.frontDoor.bindings` defensively, exactly like
 * `readGraphPositions` reads `layout.positions`: an untrusted or malformed
 * shape never throws, and a binding naming an input the policy does not have
 * is dropped rather than trusted.
 */

const policy = (over: Partial<FlowPolicy> = {}): FlowPolicy => ({
  version: 2,
  name: 'Review',
  inputs: [{ id: 'branch', label: 'Branch' }, { id: 'topic', label: 'Topic' }],
  roles: [{ id: 'reviewer', kind: 'person', outcomes: ['done'] }],
  rules: [],
  seed: { role: 'reviewer', title: 'Go' },
  messaging: 'board-only',
  wait: 240,
  ...over,
})

it('reads saved positions for every role id except __proto__', () => {
  const positions = Object.fromEntries([
    ['constructor', { x: 400, y: 500 }],
    ['prototype', { x: 700, y: 410 }],
    ['__proto__', { x: 900, y: 320 }],
  ])
  const shape = policy({
    roles: [
      { id: 'constructor', kind: 'person', outcomes: ['done'] },
      { id: 'prototype', kind: 'person', outcomes: ['done'] },
    ],
    layout: { positions },
  })

  expect(readGraphPositions(shape)).toEqual({
    positions: { constructor: { x: 400, y: 500 }, prototype: { x: 700, y: 410 } },
    invalid: true,
  })
})

describe('boundInputIds', () => {
  it('names the inputs a layout binds from the start context, and nothing else', () => {
    const shape = policy({ layout: { frontDoor: { bindings: [{ input: 'branch', value: 'branch' }] } } })
    expect(boundInputIds(shape)).toEqual(new Set(['branch']))
  })

  it('is empty for a shape with no layout, or a layout with no bindings', () => {
    expect(boundInputIds(policy())).toEqual(new Set())
    expect(boundInputIds(policy({ layout: {} }))).toEqual(new Set())
    expect(boundInputIds(policy({ layout: { frontDoor: {} } }))).toEqual(new Set())
  })

  it('drops a binding naming an input this policy does not have, rather than trusting it', () => {
    const shape = policy({ layout: { frontDoor: { bindings: [{ input: 'nope', value: 'head' }] } } })
    expect(boundInputIds(shape)).toEqual(new Set())
  })

  it('never throws on a malformed or untrusted layout shape', () => {
    expect(() => boundInputIds(policy({ layout: 'not an object' as never }))).not.toThrow()
    expect(() => boundInputIds(policy({ layout: { frontDoor: { bindings: 'not an array' as never } } }))).not.toThrow()
    expect(() => boundInputIds(policy({ layout: { frontDoor: { bindings: [{ input: '__proto__', value: 'head' }] } } }))).not.toThrow()
    expect(boundInputIds(policy({ layout: { frontDoor: { bindings: [{ input: '__proto__', value: 'head' }] } } }))).toEqual(new Set())
  })
})

describe('boundInputValues', () => {
  it('names which resolved fact each bound input takes — a branch, a base, a head, a pull request', () => {
    const shape = policy({ layout: { frontDoor: { bindings: [{ input: 'branch', value: 'branch' }, { input: 'topic', value: 'head' }] } } })
    expect(boundInputValues(shape)).toEqual(new Map([['branch', 'branch'], ['topic', 'head']]))
  })

  it('drops a binding whose own value is not one of the five the host resolves', () => {
    const shape = policy({ layout: { frontDoor: { bindings: [{ input: 'branch', value: 'not-a-real-kind' }] } } })
    expect(boundInputValues(shape)).toEqual(new Map())
  })

  it('is empty for a shape with no layout, or a layout with no bindings', () => {
    expect(boundInputValues(policy())).toEqual(new Map())
  })
})
