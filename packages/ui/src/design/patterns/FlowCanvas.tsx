import { lazy, Suspense } from 'react'
import { Text } from './Settings'
import type { FlowCanvasProps, FlowCanvasStep } from './FlowCanvas/types'

// Neither the interaction engine nor its base sheet enters the main bundle.
const Engine = lazy(() => import('./FlowCanvas/Engine')) as typeof import('./FlowCanvas/Engine').default

/** A controlled plan drawing. Give its container a height; Fit only shrinks. */
export const FlowCanvas = <Data extends FlowCanvasStep = FlowCanvasStep>(props: FlowCanvasProps<Data>) => (
  <Suspense fallback={<Text role="meta">Loading plan…</Text>}>
    <Engine {...props} />
  </Suspense>
)
export type { FlowCanvasStep, FlowCanvasNode, FlowCanvasEdge, FlowCanvasNodeChange, FlowCanvasEdgeChange, FlowCanvasNodeProps, FlowCanvasProps } from './FlowCanvas/types'
