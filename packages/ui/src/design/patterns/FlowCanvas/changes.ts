import type { FlowCanvasNodeChange } from './types'

export const forwardNodeChanges = (changes: readonly unknown[], readOnly: boolean): FlowCanvasNodeChange[] => changes.flatMap<FlowCanvasNodeChange>(value => {
  if (!value || typeof value !== 'object') return []
  const change = value as {
    type?: string
    id?: string
    selected?: boolean
    position?: { x?: number; y?: number }
    dragging?: boolean
  }
  if (typeof change.id !== 'string') return []
  if (change.type === 'select' && typeof change.selected === 'boolean') return [{ type: 'select', id: change.id, selected: change.selected }]
  if (!readOnly && change.type === 'position' && typeof change.position?.x === 'number' && typeof change.position.y === 'number') {
    return [{ type: 'position', id: change.id, position: { x: change.position.x, y: change.position.y }, dragging: Boolean(change.dragging) }]
  }
  if (!readOnly && change.type === 'remove') return [{ type: 'remove', id: change.id }]
  return []
})
