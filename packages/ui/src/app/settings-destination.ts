import type { RuntimeId } from '@harnessdesk/protocol'
import { resolveSection } from '../components/Settings'
import type { PageDestination } from '../state/destinations'
export const destinationForSettings = (name: string | null | undefined, focus: string | null = null, leadAvailable = false): PageDestination => {
  const section = resolveSection(name, 'runtimes', leadAvailable)
  if (section === 'library' || section === 'skills') return {kind:'library',section:'skill'}
  if (section === 'plugins') return {kind:'plugins',section:'installed',id:null}
  if (section === 'workspaces' && focus === 'triggers') return {kind:'flows',root:null,id:null,origin:null}
  if (section === 'workspaces' && focus && focus !== 'triggers') return {kind:'settings',route:{kind:'project',root:focus}}
  if (section === 'runtimes' && focus === 'add') return {kind:'settings',route:{kind:'add-runtime'}}
  if (section === 'runtimes' && focus) return {kind:'settings',route:{kind:'runtime',runtime:focus as RuntimeId}}
  return {kind:'settings',route:{kind:'section',section,focus}}
}
