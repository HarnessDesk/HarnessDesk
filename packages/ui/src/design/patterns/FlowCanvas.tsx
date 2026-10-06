import { lazy, Suspense } from 'react'
import { Text } from './Settings'
import type { FlowCanvasProps, FlowCanvasStep } from './FlowCanvas/types'

// Neither the interaction engine nor its base sheet enters the main bundle.
const Engine = lazy(() => import('./FlowCanvas/Engine')) as typeof import('./FlowCanvas/Engine').default

/**
 * A controlled plan drawing. Give its container a height; Fit only shrinks.
 * Steps connect by pointer here; the builder dock will add keyboard connection later.
 */
export const FlowCanvas = <Data extends FlowCanvasStep = FlowCanvasStep>(props: FlowCanvasProps<Data>) => (
  <Suspense fallback={<Text role="meta">Loading plan…</Text>}>
    <Engine {...props} />
  </Suspense>
)
export type { FlowCanvasStep, FlowCanvasNode, FlowCanvasEdge, FlowCanvasNodeChange, FlowCanvasEdgeChange, FlowCanvasNodeProps, FlowCanvasProps } from './FlowCanvas/types'
export { FLOW_CANVAS_CARD_WIDTH, FLOW_CANVAS_RUN_CARD_HEIGHT } from './FlowCanvas/geometry'
