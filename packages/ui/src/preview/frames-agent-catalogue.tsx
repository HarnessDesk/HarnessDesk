import { useEffect, useMemo, useRef } from 'react'
import { App } from '../app/App'
import { AgentCatalogue, AgentCatalogueCard, AgentCatalogueSources, Chip, Note, Section } from '../design'
import { AgentIcon } from '../components/Icons'
import { StoreProvider } from '../state/context'
import { agentsDestinationStore } from './agents-destination-fixture'
import { PagePreview } from './page-preview'

const AGENTCATALOGUE_CATALOG_VARIANTS = ['default'] as const
const AGENTCATALOGUE_CATALOG_SIZES = ['default'] as const
const AGENTCATALOGUE_CATALOG_STATES = ['default', 'loading', 'empty', 'error', 'long-title', 'closed', 'open'] as const
type CatalogueState = typeof AGENTCATALOGUE_CATALOG_STATES[number]

/** The real retained Agents destination; the fixture answers only with synthetic files and seats. */
const AgentCataloguePage = ({ scene }: { readonly scene: 'default' | 'loading' | 'empty' | 'error' }) => {
  const store = useMemo(() => {
    const next = agentsDestinationStore(new URLSearchParams())
    const snapshot = next.getSnapshot()
    const request = next.transport.request.bind(next.transport)
    if (scene === 'empty') Object.assign(snapshot, { agents: [], agentPlans: new Map() })
    if (scene === 'loading' || scene === 'error') Object.assign(snapshot, { agentPlans: new Map(), agentPlansFailed: scene === 'error' })
    next.transport.request = (async (method, params) => {
      if (scene === 'empty' && method === 'agent/list') return []
      if (scene === 'empty' && method === 'agent/seat/dry') return []
      if (scene === 'loading' && method === 'agent/seat/dry') return new Promise<never>(() => {})
      if (scene === 'error' && method === 'agent/seat/dry') throw new Error('Synthetic seat check is unavailable.')
      return request(method, params as never)
    }) as typeof next.transport.request
    next.openDestination({ kind: 'agents', id: null })
    return next
  }, [scene])
  return <div className="relative h-176 overflow-hidden" style={{ transform: 'translateZ(0)' }}>
    {scene === 'default' ? <PagePreview fixture={store} page={{ kind: 'agents', id: null }} /> : <StoreProvider store={store}><App /></StoreProvider>}
  </div>
}

const CatalogueSpecimen = ({ state }: { readonly state: CatalogueState }) => {
  const sources = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (state === 'open') sources.current?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click()
  }, [state])
  if (state === 'default' || state === 'loading' || state === 'empty' || state === 'error') return <AgentCataloguePage scene={state} />
  if (state === 'long-title') return <AgentCatalogue>
    <AgentCatalogueCard name="Accessibility and international checkout reviewer" face={<AgentIcon />}
      description="Reviews keyboard and screen reader behavior across the checkout, including translated copy and larger text, then records the smallest change that fixes each finding."
      runtime="Local seat · Review model · High effort" ceiling={<Chip tone="neutral" size="sm">Read</Chip>} onOpen={() => {}} />
    <AgentCatalogueCard name="Release checker" face={<AgentIcon />} description="Reads the release against the changelog before it is tagged."
      status="Can't seat here" problem="The preferred seat is signed out. Open this Agent to choose another seat." onOpen={() => {}} />
  </AgentCatalogue>
  return <div ref={sources}><AgentCatalogueSources><Note>Project Agents come first, then yours, then built in. Copies with the same ID use that order.</Note></AgentCatalogueSources></div>
}

/** A measured case is one real catalogue card, never the combined state wall. */
const CatalogueMetricSpecimen = () => <AgentCatalogue>
  <AgentCatalogueCard name="Code reviewer" face={<AgentIcon />} description="Reads a change against the project's rules."
    runtime="Local seat · Review model" ceiling={<Chip tone="neutral" size="sm">Read</Chip>} onOpen={() => {}} />
</AgentCatalogue>

/** Catalogue cards and source disclosure remain the same exports that the production roster composes. */
export const AgentCatalogueBoard = () => <div className="flex flex-col gap-4">
  {AGENTCATALOGUE_CATALOG_VARIANTS.map(variant => <Section key={variant} title={`Variant: ${variant}`}>
    <div data-slot="agent-catalogue-specimen" data-catalog-variant={variant}><CatalogueMetricSpecimen /></div>
  </Section>)}
  {AGENTCATALOGUE_CATALOG_SIZES.map(size => <Section key={size} title={`Size: ${size}`}>
    <div data-slot="agent-catalogue-specimen" data-catalog-size={size}><CatalogueMetricSpecimen /></div>
  </Section>)}
  {AGENTCATALOGUE_CATALOG_STATES.map(state => <Section key={state} title={state} data-catalog-state={state}>
    <CatalogueSpecimen state={state} />
  </Section>)}
</div>
