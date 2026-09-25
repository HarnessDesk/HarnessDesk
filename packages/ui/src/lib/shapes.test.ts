import { describe, expect, it } from 'vitest'

import type { FlowPolicy } from '@harnessdesk/protocol'

import { boundInputIds } from './shapes'

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
