import type { ComponentType, ReactNode } from 'react'
import type { FlowStepState } from '../../../lib/flow-overlay'

/** Presentation only. The caller owns the document, layout and persistence. */
export interface FlowCanvasStep {
  readonly name: string
  readonly kind: 'start' | 'agent' | 'check' | 'person' | 'note'
  readonly roleLine?: string
  readonly seatLine?: string
}
export interface FlowCanvasNode<Data extends FlowCanvasStep = FlowCanvasStep> {
  readonly id: string
  /** Accepts { x: box.x, y: box.y } from flow-layout without a second layout. */
  readonly position: { readonly x: number; readonly y: number }
  readonly data: Data
  readonly selected?: boolean
  readonly size?: { readonly width: number; readonly height?: number }
  readonly state?: FlowStepState | 'failed' | 'skipped'
  /** A Run can supply its own state, duration, faces or doing line here. */
  readonly stateSlot?: ReactNode
}
export interface FlowCanvasEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly label?: string
  readonly kind?: 'rule' | 'attachment'
  readonly selected?: boolean
  readonly state?: 'travelled' | 'future'
  readonly current?: boolean
  readonly loop?: boolean
}
export type FlowCanvasNodeChange =
  | { readonly type: 'select'; readonly id: string; readonly selected: boolean }
  | { readonly type: 'position'; readonly id: string; readonly position: { readonly x: number; readonly y: number }; readonly dragging: boolean }
  | { readonly type: 'remove'; readonly id: string }
export type FlowCanvasEdgeChange =
  | { readonly type: 'select'; readonly id: string; readonly selected: boolean }
  | { readonly type: 'remove'; readonly id: string }
export interface FlowCanvasNodeProps<Data extends FlowCanvasStep = FlowCanvasStep> {
  readonly node: FlowCanvasNode<Data>
  readonly selected: boolean
  readonly readOnly: boolean
}
export interface FlowCanvasProps<Data extends FlowCanvasStep = FlowCanvasStep> {
  readonly nodes: readonly FlowCanvasNode<Data>[]
  readonly edges: readonly FlowCanvasEdge[]
  readonly readOnly?: boolean
  /** The ordered shape editor can arrange existing steps, but cannot change the graph. */
  readonly positionOnly?: boolean
  /** Posters keep the plan and attribution, without navigation tools or a minimap. */
  readonly showControls?: boolean
  readonly title?: ReactNode
  readonly actions?: ReactNode
  readonly label?: string
  readonly className?: string
  readonly NodeComponent?: ComponentType<FlowCanvasNodeProps<Data>>
  readonly onNodesChange?: (changes: readonly FlowCanvasNodeChange[]) => void
  readonly onEdgesChange?: (changes: readonly FlowCanvasEdgeChange[]) => void
  readonly onConnect?: (connection: { readonly source: string; readonly target: string }) => void
  readonly onSelectionChange?: (selection: { readonly nodes: readonly string[]; readonly edges: readonly string[] }) => void
}
