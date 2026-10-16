/** Placeholder-only evidence for registry browsing and runtime brand tiles. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentTemplateInfo, Library } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { SettingsPreview } from './settings-pages'
import { LIBRARY, previewStore, runtime } from './harness'
import '../styles/app.css'

const brands = ['codex', 'claudecode', 'cursor'] as const
const infos = brands.map((brand, index) => ({ ...runtime(`runtime-${index}`, ['Alpha', 'Beta', 'Gamma'][index]!), presentation: { name: ['Alpha', 'Beta', 'Gamma'][index]!, brand, tagline: 'An installed runtime.' } }))
const store = previewStore({ runtimes: infos, activeRuntime: infos[0]!.id, accountsByRuntime: Object.fromEntries(infos.map(info => [info.id, { accounts: [{ kind: 'oauth', label: 'dev@example.com', email: 'dev@example.com' }], signInMethods: [] }])) })
store.agentCatalog = async (): Promise<readonly AgentTemplateInfo[]> => infos.map((info, index) => ({ key: `template-${index}`, name: info.presentation.name, brand: brands[index]!, tagline: 'An installed runtime.', available: true, registered: false, requires: { command: 'runtime', found: true } }))
store.acpRegistry = async () => ({ agents: [{ id: 'registry-agent', name: 'Delta', version: '1.0.0', description: 'An optional third-party runtime.', run: 'npx', available: true, registered: false }], fetchedAt: 1 })
const example = LIBRARY.entries[0]!
const library = { ...LIBRARY, home: '/home/u', runtimes: infos.map(info => info.id), entries: [{ ...example, name: 'shared-review', title: 'Shared review', description: 'Review changes with every installed runtime.', reach: infos.map(info => ({ runtime: info.id, state: 'reaches', basis: 'reported' })) }] } as unknown as Library
const request = store.transport.request.bind(store.transport)
store.transport.request = async (method, params) => method === 'library/read' ? library : request(method, params)
const surface = new URLSearchParams(location.search).get('surface')
createRoot(document.getElementById('root')!).render(<StrictMode><StoreProvider store={store}><SettingsPreview section={surface === 'library' ? 'library' : 'runtimes'} focus={surface === 'add' ? 'add' : null} /></StoreProvider></StrictMode>)
