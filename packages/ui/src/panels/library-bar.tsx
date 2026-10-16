import { MenuItem, PageOptions, type PageOption } from '../design'
import { ImportIcon, RetryIcon } from '../components/Icons'
import { DestinationBar } from './destination-page'

export const LibraryBar = ({ kind, counts, change, loaded, loading, author, importing, github, rescan, choices = [], search }: {
  readonly kind: 'skill' | 'mcp'
  readonly counts: Readonly<Record<'skill' | 'mcp', number>>
  readonly change: (kind: 'skill' | 'mcp') => void
  readonly loaded: boolean
  readonly loading: boolean
  readonly author: () => void
  readonly importing: () => void
  readonly github: () => void
  readonly rescan: () => void
  readonly choices?: readonly PageOption[]
  readonly search?: { readonly label: string; readonly value: string; readonly change: (value: string) => void }
}) => <>
  <DestinationBar place="Library"
  more={close => <>
    <MenuItem icon={<ImportIcon size={16} />} label="Import" disabled={!loaded} onSelect={() => { importing(); close() }} />
    <MenuItem icon={<ImportIcon size={16} />} label="Add from GitHub…" disabled={!loaded} onSelect={() => { github(); close() }} />
    <MenuItem icon={<RetryIcon size={16} />} label="Rescan" disabled={loading} onSelect={() => { rescan(); close() }} />
  </>} />
  <PageOptions title="Library" action={{ label: 'New skill', disabled: loaded ? false : 'The library has not been read.', run: author }}
    choices={[{ id: 'kind', label: 'Library sections', value: kind, mode: 'menu', showCount: true,
      items: [{ value: 'skill', label: 'Skills', count: counts.skill }, { value: 'mcp', label: 'MCP servers', count: counts.mcp }],
      change: value => change(value as 'skill' | 'mcp') }, ...choices]} search={search} />
</>
