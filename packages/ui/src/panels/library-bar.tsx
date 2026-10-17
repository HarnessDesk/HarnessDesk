import { Menu, MenuItem, PageOptions, Popover, type PageOption } from '../design'
import { CaretIcon, ImportIcon, PencilIcon, RetryIcon } from '../components/Icons'
import { DestinationBar } from './destination-page'

export const LibraryBar = ({ kind, counts, change, loaded, loading, author, importing, github, checking, check, rescan, choices = [], search }: {
  readonly kind: 'skill' | 'mcp'
  readonly counts: Readonly<Record<'skill' | 'mcp', number>>
  readonly change: (kind: 'skill' | 'mcp') => void
  readonly loaded: boolean
  readonly loading: boolean
  readonly author: () => void
  readonly importing: () => void
  readonly github: () => void
  readonly checking: boolean
  readonly check: () => void
  readonly rescan: () => void
  readonly choices?: readonly PageOption[]
  readonly search?: { readonly label: string; readonly value: string; readonly change: (value: string) => void }
}) => <>
  <DestinationBar place="Library"
  more={close => <>
    {kind === 'mcp' && <><MenuItem icon={<ImportIcon size={16} />} label="Import" disabled={!loaded} onSelect={() => { importing(); close() }} />
    <MenuItem icon={<ImportIcon size={16} />} label="Add from GitHub…" disabled={!loaded} onSelect={() => { github(); close() }} /></>}
    <MenuItem icon={<RetryIcon size={16} />} label={checking ? 'Checking…' : 'Check for updates'} disabled={!loaded || checking} onSelect={() => { check(); close() }} />
    <MenuItem icon={<RetryIcon size={16} />} label="Rescan" disabled={loading} onSelect={() => { rescan(); close() }} />
  </>} />
  <PageOptions title="Library" action={kind === 'mcp' ? { label: 'New skill', disabled: loaded ? false : 'The library has not been read.', run: author } : undefined}
    choices={[{ id: 'kind', label: 'Library sections', value: kind, mode: 'menu', showCount: true,
      items: [{ value: 'skill', label: 'Skills', count: counts.skill }, { value: 'mcp', label: 'MCP servers', count: counts.mcp }],
      change: value => change(value as 'skill' | 'mcp') }, ...choices]} search={search} >
    {kind === 'skill' && <Popover icons="all" title="Add skill" label={<>Add skill<CaretIcon /></>} disabled={!loaded} reason={!loaded ? 'The library has not been read.' : undefined} triggerVariant={{ variant: 'outline', size: 'sm' }}>{close => <Menu close={close}>
      <MenuItem icon={<PencilIcon size={16} />} label="Write a skill" onSelect={() => { author(); close() }} />
      <MenuItem icon={<ImportIcon size={16} />} label="From GitHub…" onSelect={() => { github(); close() }} />
      <MenuItem icon={<ImportIcon size={16} />} label="Copy from another runtime…" onSelect={() => { importing(); close() }} />
    </Menu>}</Popover>}
  </PageOptions>
</>
