import { useEffect, useMemo, useState } from 'react'
import { AgentIcon, CheckIcon, DevToolsIcon } from '../components/Icons'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { FlowGraph, Text } from '../design'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { FLOW_OVERLAY_SCENES, flowOverlayFixture, flowOverlayRig, type FlowOverlayScene } from './flow-overlay-fixture'
import { flowGraphModel } from './flow-graph-fixture'

const FACES = new Map([['alpha', <DevToolsIcon />], ['beta', <AgentIcon />], ['gamma', <CheckIcon />]])
const DOING = new Map([['alpha', 'Edited src/checkout/retry.ts'], ['beta', 'Read src/checkout/retry.ts'], ['gamma', 'Read src/checkout/retry.ts']])
export const FLOW_STEP_CATALOG_VARIANTS = ['default'] as const
export const FLOW_STEP_CATALOG_SIZES = ['default'] as const
export const FLOW_STEP_CATALOG_STATES = ['default', 'working', 'needs-you', 'loading', 'error', 'empty'] as const

export const FlowOverlayBoard = () => <div className="flex flex-col gap-8">{FLOW_OVERLAY_SCENES.map(scene => {
  const source = flowOverlayFixture(scene)
  return <section key={scene} data-catalog-state={scene === 'pending' ? 'loading' : scene === 'failed' ? 'error' : scene === 'empty' ? 'empty' : scene === 'you' ? 'needs-you' : scene === 'settled' ? 'default' : 'working'} className="flex flex-col gap-2">
    <Text role="section">{scene}</Text><FlowGraph model={source.model} overlay={source.overlay} faces={FACES} doing={DOING} />
  </section>
})}<section data-catalog-state="narrow" className="flex max-w-sm flex-col"><FlowGraph model={flowGraphModel('blueprint')} overlay={flowOverlayFixture('fix').overlay} /></section></div>

export const FlowOverlayFrames = () => {
  useTheme()
  const rig = useMemo(() => flowOverlayRig(), [])
  const [scene, setScene] = useState<FlowOverlayScene>('fix')
  useEffect(() => {
    const advance = (event: Event) => {
      const next = (event as CustomEvent<string>).detail
      if (next === 'refresh' || FLOW_OVERLAY_SCENES.some(scene => scene === next)) {
        rig.advance(next as FlowOverlayScene | 'refresh')
        if (next !== 'refresh') setScene(next as FlowOverlayScene)
      }
    }
    window.addEventListener('flow-overlay-scene', advance)
    return () => window.removeEventListener('flow-overlay-scene', advance)
  }, [rig])
  return <div className="flex min-h-full flex-col gap-8 bg-background p-4 text-foreground">
    <section id="flow-overlay-live" data-scene={scene} className="h-192"><StoreProvider store={rig.store}><TeamRoomPane room="overlay-team" /></StoreProvider></section>
    <section id="flow-overlay-blueprint"><FlowGraph model={flowGraphModel('blueprint')} /></section>
    {FLOW_OVERLAY_SCENES.map(scene => { const source = flowOverlayFixture(scene); return <section key={scene} id={`flow-overlay-${scene}`}><Text role="section">{scene}</Text><FlowGraph model={source.model} overlay={source.overlay} faces={FACES} doing={DOING} /></section> })}
  </div>
}
