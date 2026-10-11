import { MenuItem } from '../design'
import { ImportIcon, RetryIcon } from '../components/Icons'
import { DestinationBar } from './destination-page'

export const LibraryBar = ({ kind, counts, change, loaded, loading, author, importing, rescan }: {
  readonly kind: 'skill' | 'mcp'
  readonly counts: Readonly<Record<'skill' | 'mcp', number>>
  readonly change: (kind: 'skill' | 'mcp') => void
  readonly loaded: boolean
  readonly loading: boolean
  readonly author: () => void
  readonly importing: () => void
  readonly rescan: () => void
}) => <DestinationBar place="Library" tab={kind}
  tabs={([{ value: 'skill', label: 'Skills' }, { value: 'mcp', label: 'MCP servers' }] as const)
    .map(tab => ({ ...tab, count: counts[tab.value], run: () => change(tab.value) }))}
  verb={{ label: 'New skill', disabled: loaded ? false : 'The library has not been read.', run: author }}
  more={close => <>
    <MenuItem icon={<ImportIcon size={16} />} label="Import" disabled={!loaded} onSelect={() => { importing(); close() }} />
    <MenuItem icon={<RetryIcon size={16} />} label="Rescan" disabled={loading} onSelect={() => { rescan(); close() }} />
  </>} />
