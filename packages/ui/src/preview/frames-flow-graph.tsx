import { FlowGraph, Text } from '../design'
import { FLOW_GRAPH_SCENES, flowGraphModel, type FlowGraphScene } from './flow-graph-fixture'
import { RunWorkspaceExample } from './frames-run-view'

const TITLES: Readonly<Record<FlowGraphScene, string>> = {
  blueprint: 'A Flow whose Run has been seated',
  straight: 'A straight Flow',
  loop: 'A loop that ends when the review does',
  'fan-out': 'A step that opens three seats at once',
  person: 'A person at the gate',
  positions: 'A Flow with positions of its own',
  long: 'A long Flow',
  legacy: 'A Flow in the older format',
  empty: 'A Flow with no steps',
}

/** The real drawing of each kind of Flow: the catalogue and the preview mount the same pattern. */
export const FlowGraphBoard = () => (
  <div className="flex flex-col gap-8">
    {FLOW_GRAPH_SCENES.map(scene => (
      <section key={scene} data-catalog-state={scene === 'empty' ? 'empty' : 'default'} data-flow-scene={scene} className="flex flex-col gap-2">
        <Text role="section">{TITLES[scene]}</Text>
        <FlowGraph model={flowGraphModel(scene)} />
      </section>
    ))}
    <section data-flow-scene="narrow" className="flex max-w-sm flex-col gap-2">
      <Text role="section">In a window too narrow for the drawing, the list is the view</Text>
      <FlowGraph model={flowGraphModel('blueprint')} />
    </section>
  </div>
)

/** `/preview.html?flow-graph` — every scene alone, then the Run's Flow tab, wide and narrow. */
export const FlowGraphFrames = () => (
  <div className="flex flex-col gap-8 p-4">
    {FLOW_GRAPH_SCENES.map(scene => (
      <section key={scene} id={`flow-graph-${scene}`} className="flex flex-col gap-2">
        <Text role="section">{TITLES[scene]}</Text>
        <FlowGraph model={flowGraphModel(scene)} />
      </section>
    ))}
    <section id="flow-graph-narrow" className="flex w-80 flex-col gap-2">
      <Text role="section">In a window too narrow for the drawing, the list is the view</Text>
      <FlowGraph model={flowGraphModel('blueprint')} />
    </section>
    <section id="flow-graph-run" className="flex h-176 flex-col"><RunWorkspaceExample scene="running" view="flow" /></section>
    <section id="flow-graph-run-narrow" className="flex h-176 max-w-sm flex-col"><RunWorkspaceExample scene="narrow" view="flow" /></section>
  </div>
)
