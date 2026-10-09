import { describe, expect, it } from 'vitest'
import type { FlowPolicy } from '@harnessdesk/protocol'

// The host's real parser/writer, used only by this test. The renderer has neither.
import { parseFlowPolicy } from '../../../../server/dist/src/flow-policy.js'
import { writeShape } from '../../../../server/dist/src/authoring/model.js'
import { flowLayout } from '../flow-layout'
import { flowModel } from '../flow-model'
import { emptyShapePolicy } from '../shapes'
import {
  createDocument, documentGraph, graphDocument, sourceRequest, documentPolicy, builderProblems,
  addStep, moveStep, renameStep, deleteStep,
} from './index'

const shipped = import.meta.glob('../../../../server/flows/*.yml', { eager: true, query: '?raw', import: 'default' })
const SHIPPED = ['alignment', 'comparison', 'fan-out', 'fix-and-review', 'independent-review', 'investigation', 'mechanical-contest', 'review', 'review-pr', 'staged-relay']
const policyOf = (source: string): FlowPolicy => {
  const parsed = parseFlowPolicy(source)
  expect(parsed.problems.filter((one) => one.level === 'error')).toEqual([])
  if (parsed.document?.format !== 'agents') throw new Error('Expected an Agent-routed Flow')
  return parsed.document.flow
}

describe('the builder document', () => {
  it('uses flow-layout when the source has no positions, without writing an automatic layout', () => {
    const policy = emptyShapePolicy()
    const document = createDocument(policy)
    const layout = flowLayout(flowModel(policy))
    expect(documentGraph(document).nodes.map((node) => node.position)).toEqual(layout.nodes.map((node) => ({ x: node.box.x, y: node.box.y })))
    expect(documentPolicy(document)).toBe(policy)
  })

  it('rounds loop layout positions so a no-op graph sync preserves source provenance', () => {
    const policy: FlowPolicy = {
      ...emptyShapePolicy(),
      roles: [
        { id: 'a', kind: 'person', outcomes: ['done'] },
        { id: 'b', kind: 'person', outcomes: ['done'] },
        { id: 'c', kind: 'person', outcomes: ['done'] },
      ],
      seed: { role: 'a', title: 'Start' },
      rules: [
        { id: 'forward', on: 'a', then: { role: 'b', title: 'Continue' } },
        { id: 'back', on: 'b', then: { role: 'a', title: 'Retry' } },
      ],
    }
    const source = '# original source'
    const document = createDocument(policy, source)
    const graph = documentGraph(document)
    expect(graph.nodes.every((node) => Number.isInteger(node.position.x) && Number.isInteger(node.position.y))).toBe(true)
    expect(graphDocument(document, graph)).toBe(document)
    expect(sourceRequest(document)).toEqual({ kind: 'source', source })
  })

  it('round-trips saved positions for roles named prototype or constructor', () => {
    const policy: FlowPolicy = {
      ...emptyShapePolicy(),
      roles: [
        { id: 'constructor', kind: 'person', outcomes: ['done'] },
        { id: 'prototype', kind: 'person', outcomes: ['done'] },
      ],
      rules: [{ id: 'continue', on: 'constructor', then: { role: 'prototype', title: 'Continue' } }],
      seed: { role: 'constructor', title: 'Start' },
      layout: { positions: { constructor: { x: 400, y: 500 }, prototype: { x: 700, y: 410 } } },
    }
    const source = writeShape(policy)
    const parsed = parseFlowPolicy(source)
    expect(parsed.problems.filter((one) => one.level === 'error')).toEqual([])
    if (parsed.document?.format !== 'agents') throw new Error('Expected an Agent-routed Flow')

    const reopened = createDocument(parsed.document.flow, source)
    const ids = new Map(reopened.steps.map((step) => [step.role, step.id]))
    expect(reopened.positions[ids.get('constructor')!]).toEqual({ x: 400, y: 500 })
    expect(reopened.positions[ids.get('prototype')!]).toEqual({ x: 700, y: 410 })
    expect(reopened.invalidPositions).toBe(false)
    expect(builderProblems(reopened).some((problem) => problem.kind === 'layout')).toBe(false)
  })

  it('keeps unchanged fractional saved positions exact during graph sync', () => {
    const source = shipped['../../../../server/flows/review.yml'] as string
    const policy = policyOf(source)
    const role = policy.roles[0]!.id
    const document = createDocument({
      ...policy,
      layout: { positions: { [role]: { x: 10.5, y: 20.5 } } },
    }, source)
    const graph = documentGraph(document)
    expect(graph.nodes.find((node) => node.data.kind === 'step' && node.data.role.id === role)!.position).toEqual({ x: 10.5, y: 20.5 })
    expect(graphDocument(document, graph)).toBe(document)
    expect(sourceRequest(document)).toEqual({ kind: 'source', source })
  })

  it('reads explicit coordinates exactly, fills missing ones from auto layout, and keeps unknown metadata', () => {
    const policy = { ...emptyShapePolicy(), roles: [...emptyShapePolicy().roles, { id: 'done', kind: 'person' as const, outcomes: ['done'] }], layout: { positions: { review: { x: -100, y: 250 } }, frontDoor: { order: 3 }, other: { key: 'kept' } } }
    const document = createDocument(policy)
    const graph = documentGraph(document)
    expect(graph.nodes[0]!.position).toEqual({ x: -100, y: 250 })
    const automatic = flowLayout(flowModel({ ...policy, layout: undefined })).nodes[1]!.box
    expect(graph.nodes[1]!.position).toEqual({ x: automatic.x, y: automatic.y })
    expect(documentPolicy(document)).toBe(policy)
    const moved = moveStep(document, graph.nodes[0]!.id, { x: 88.3, y: 120.8 })
    expect(documentPolicy(moved).layout).toMatchObject({ frontDoor: { order: 3 }, other: { key: 'kept' }, positions: { review: { x: 88, y: 121 } } })
    expect(policy.layout.positions.review).toEqual({ x: -100, y: 250 })
  })

  it('keeps unreadable metadata untouched on read and a non-layout edit', () => {
    const policy = { ...emptyShapePolicy(), layout: { positions: { review: { x: Infinity, y: 0 }, gone: { x: 10, y: 20 } }, other: 'kept' } }
    const document = createDocument(policy)
    expect(document.invalidPositions).toBe(true)
    expect(documentPolicy(document)).toBe(policy)
    expect(documentPolicy(renameStep(document, document.steps[0]!.id, 'decision')).layout).toMatchObject({ other: 'kept', positions: { decision: { x: Infinity, y: 0 }, gone: { x: 10, y: 20 } } })
  })

  it('has a node per role and an edge per rule, including parallel and dangling rules', () => {
    const policy = { ...emptyShapePolicy(), rules: [
      { id: 'again', on: 'review', when: { any: ['retry'], evidence: [{ ci: 'green' as const }] }, then: { role: 'review', title: 'Again' } },
      { id: 'other', on: 'review', when: { every: ['done'] }, then: { role: 'review', title: 'Other' } },
      { id: 'missing', on: 'review', then: { role: 'nowhere', title: 'Missing' } },
    ] }
    const document = createDocument(policy)
    const graph = documentGraph(document)
    expect(graph.nodes).toHaveLength(1)
    expect(graph.edges).toHaveLength(3)
    expect(graph.edges.map((edge) => edge.data.view.word)).toEqual(['retry', 'done', null])
    expect(graph.edges[2]!.target).toBeNull()
    expect(documentPolicy(graphDocument(document, graph))).toEqual(policy)
    expect(graphDocument(document, graph)).toBe(document)
  })

  it('reads malformed note metadata defensively and retains the original file on read', () => {
    const policy = { ...policyOf(writeShape(emptyShapePolicy())), layout: { builder: { notes: [
      { id: 'note-3', text: 'Remember', position: { x: 50, y: 100 } },
      { id: 'note-3', text: 'Duplicate', position: { x: 0, y: 0 } },
      { id: '__proto__', text: 'Ignored', position: { x: 0, y: 0 } },
      { id: 'note-4', text: 'Broken', position: { x: NaN, y: 0 } },
    ] }, positions: { review: { x: 50, y: 100 } } } }
    const document = createDocument(policy)
    expect(document.notes).toEqual([{ id: 'note-3', text: 'Remember', position: { x: 50, y: 100 } }])
    expect(document.invalidNotes).toBe(true)
    expect(documentPolicy(document)).toBe(policy)
    const added = addStep(document, 'note', 'Another')
    expect(new Set(added.notes.map((note) => note.id)).size).toBe(2)
    const graph = documentGraph(added)
    const moved = graphDocument(added, { ...graph, nodes: graph.nodes.map((node) => node.data.kind === 'note' ? { ...node, position: { x: 40, y: 70 } } : node) })
    expect(moved.notes.map((note) => note.position)).toEqual([{ x: 40, y: 70 }, { x: 40, y: 70 }])
    expect(policyOf(writeShape(moved.policy))).toEqual(moved.policy)
  })

  it('keeps unrelated layout and builder metadata through note add, move and delete', () => {
    const policy = {
      ...emptyShapePolicy(),
      layout: { frontDoor: { order: 4 }, builder: { tint: 'kept', notes: [] }, other: { value: 7 } },
    }
    const document = createDocument(policy)
    const added = addStep(document, 'note', 'Remember', { x: 40, y: 80 })
    const id = added.notes[0]!.id
    const moved = moveStep(added, id, { x: 90, y: 140 })
    const deleted = deleteStep(moved, id)
    for (const current of [added, moved, deleted]) {
      expect(current.policy.layout).toMatchObject({ frontDoor: { order: 4 }, builder: { tint: 'kept' }, other: { value: 7 } })
    }
    expect(deleted.notes).toEqual([])
  })

  it('refuses stale, missing and semantic graph changes instead of losing them', () => {
    const document = createDocument({
      ...emptyShapePolicy(),
      roles: [{ id: 'review', kind: 'agent', uses: ['implementer'], seats: [{ runtime: 'demo', model: 'example-model' }], grant: 'edit', isolate: true, independentOf: [] }],
    })
    const graph = documentGraph(document)
    expect(() => graphDocument(document, { ...graph, nodes: [] })).toThrow(/operations/i)
    expect(() => graphDocument(document, { ...graph, nodes: [{ ...graph.nodes[0]!, id: 'unknown' }] })).toThrow(/operations/i)
    expect(() => graphDocument(document, { ...graph, nodes: [{ ...graph.nodes[0]!, position: { x: Infinity, y: 0 } }] })).toThrow(/finite/i)
    expect(graphDocument(document, { ...graph, nodes: [...graph.nodes].reverse() })).toBe(document)

    const step = graph.nodes[0]!
    if (step.data.kind !== 'step') throw new Error("Expected the empty draft's node to be a step")
    const stepData = step.data
    if (stepData.role.kind !== 'agent') throw new Error("Expected the empty draft's role to be an Agent")
    const role = stepData.role
    expect(() => graphDocument(document, { ...graph, nodes: [{ ...step, data: { ...stepData, role: { ...stepData.role, id: 'changed' } } }] })).toThrow(/step/i)
    expect(() => graphDocument(document, { ...graph, nodes: [{ ...step, data: { ...stepData, role: { ...role, uses: [...role.uses, 'reviewer'] } } }] })).toThrow(/step/i)
    expect(() => graphDocument(document, { ...graph, nodes: [{ ...step, data: { ...stepData, role: { ...role, seats: [{ ...role.seats[0]!, nested: { extra: true } }] as never } } }] })).toThrow(/step/i)
    expect(() => graphDocument(document, { ...graph, nodes: [{ ...step, data: { ...stepData, view: { ...stepData.view, name: 'Changed' } } }] })).toThrow(/step/i)
    expect(() => graphDocument(document, { ...graph, nodes: [{ ...step, data: { ...stepData, role: { ...stepData.role, blind: false } as never } }] })).toThrow(/step/i)
    expect(() => graphDocument(document, { ...graph, nodes: [{ ...step, data: { ...stepData, view: { ...stepData.view, extra: true } as never } }] })).toThrow(/step/i)
    expect(() => graphDocument(document, { ...graph, nodes: [...graph.nodes, { ...step, id: 'extra' }] })).toThrow(/operations/i)
    expect(() => graphDocument(document, { ...graph, edges: [...graph.edges, { id: 'extra', source: null, target: null, data: { rule: {}, view: {} } as never }] })).toThrow(/operations/i)

    const withEdge = createDocument({ ...emptyShapePolicy(), rules: [{ id: 'to-nowhere', on: 'review', then: { role: 'missing', title: 'Missing' } }] })
    const withEdgeGraph = documentGraph(withEdge)
    const edge = withEdgeGraph.edges[0]!
    expect(() => graphDocument(withEdge, { ...withEdgeGraph, edges: [{ ...edge, data: { ...edge.data, rule: { ...edge.data.rule, id: 'changed' } } }] })).toThrow(/rule/i)
    expect(() => graphDocument(withEdge, { ...withEdgeGraph, edges: [{ ...edge, data: { ...edge.data, rule: { ...edge.data.rule, when: { every: ['looks good'] } } } }] })).toThrow(/rule/i)
    expect(() => graphDocument(withEdge, { ...withEdgeGraph, edges: [{ ...edge, source: 'elsewhere' }] })).toThrow(/rule/i)
    expect(() => graphDocument(withEdge, { ...withEdgeGraph, edges: [{ ...edge, target: 'elsewhere' }] })).toThrow(/rule/i)
  })

  it('ignores graph-owned extras and object key order when syncing model fields', () => {
    const document = createDocument({ ...emptyShapePolicy(), rules: [{ id: 'to-nowhere', on: 'review', then: { role: 'missing', title: 'Missing' } }] })
    const graph = documentGraph(document)
    const nodes = graph.nodes.map((node) => ({ ...node, selected: true, data: { ...node.data, selected: true } }))
    const edges = graph.edges.map((edge) => ({ ...edge, selected: true, data: { ...edge.data, selected: true } }))
    expect(graphDocument(document, { nodes, edges } as never)).toBe(document)
    const reordered = graph.edges.map((edge) => ({ ...edge, data: { view: edge.data.view, rule: edge.data.rule } }))
    expect(graphDocument(document, { ...graph, edges: reordered } as never)).toBe(document)
  })

  it('reports an independentOf parent whose predecessor path was removed', () => {
    const source = shipped['../../../../server/flows/comparison.yml'] as string
    const document = createDocument(policyOf(source))
    const verify = document.steps.find((step) => step.role === 'verify')!
    const judge = document.steps.find((step) => step.role === 'judge')!
    const deleted = deleteStep(document, verify.id)
    const problem = builderProblems(deleted).find((one) => one.kind === 'independent-of')
    expect(problem).toMatchObject({ step: judge.id, text: expect.stringContaining('competitor') })
    expect(problem?.text).toContain('judge')
    expect(() => writeShape(documentPolicy(deleted))).toThrow(/no predecessor path/i)
  })

  it('round trips graph edits without losing fields the canvas does not draw', () => {
    const policy = { ...emptyShapePolicy(), description: 'Keep me', base: { remote: 'origin', branch: 'main' }, budget: { rounds: 4, withoutProgress: 2 } }
    const document = addStep(createDocument(policy), 'person', 'Done')
    const graph = documentGraph(document)
    const edited = graphDocument(document, { ...graph, nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, position: { x: 500, y: 200 } } : node) })
    expect(documentGraph(edited).nodes[0]!.position).toEqual({ x: 500, y: 200 })
    expect(documentPolicy(edited)).toMatchObject({ description: 'Keep me', base: policy.base, budget: policy.budget })
    expect(() => graphDocument(document, { ...graph, nodes: [graph.nodes[0]!, graph.nodes[0]!] })).toThrow(/duplicate/i)
  })
})

describe('source provenance and the built-in Flows', () => {
  it('names every shipped case, so a new shape cannot silently go untested', () => {
    expect(Object.keys(shipped).map((path) => path.split('/').at(-1)!.replace('.yml', '')).sort()).toEqual(SHIPPED)
  })
  for (const name of SHIPPED) it(`${name}: source → document → source keeps meaning and unedited bytes`, () => {
    const source = shipped[`../../../../server/flows/${name}.yml`] as string
    const policy = policyOf(source)
    const document = createDocument(policy, source)
    const request = sourceRequest(graphDocument(document, documentGraph(document)))
    expect(request).toEqual({ kind: 'source', source })
    expect(policyOf(writeShape(documentPolicy(document)))).toEqual(policy)
    const moved = moveStep(document, document.steps[0]!.id, { x: 450, y: 220 })
    expect(sourceRequest(moved)).toEqual({ kind: 'render', policy: documentPolicy(moved) })
    const rendered = writeShape(documentPolicy(moved))
    expect(policyOf(rendered)).toEqual(documentPolicy(moved))
    const renamed = renameStep(moved, moved.steps[0]!.id, 'renamed-seed')
    const after = documentGraph(renamed)
    expect(after.nodes.map((node) => node.id)).toEqual(documentGraph(moved).nodes.map((node) => node.id))
    expect(after.edges.map((edge) => edge.id)).toEqual(documentGraph(moved).edges.map((edge) => edge.id))
    expect(policyOf(writeShape(documentPolicy(renamed)))).toEqual(documentPolicy(renamed))
  })
})
