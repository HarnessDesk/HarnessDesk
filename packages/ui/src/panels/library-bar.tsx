import { Button, Menu, MenuItem, PageOptions, Popover, type PageOption } from '../design'
import { CaretIcon, ClockIcon, ImportIcon, PencilIcon, RetryIcon } from '../components/Icons'
import { useStore } from '../state/context'
import { DestinationBar } from './destination-page'
import { CustomizeNavigation } from './customize-navigation'

export const LibraryBar = ({ kind, change, loaded, loading, author, importing, github, checking, check, rescan, choices = [], search }: {
  readonly kind: 'skill' | 'mcp'
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
}) => {
  const store = useStore()
  return <>
    <DestinationBar place="Customize" more={close => <>
      <MenuItem icon={<RetryIcon size={16} />} label={checking ? 'Checking…' : 'Check for updates'} disabled={!loaded || checking} onSelect={() => { check(); close() }} />
      <MenuItem icon={<RetryIcon size={16} />} label="Rescan" disabled={loading} onSelect={() => { rescan(); close() }} />
      <MenuItem icon={<ClockIcon size={16} />} label="Changes made here…" onSelect={() => { store.openDestination({ kind: 'library', section: 'changes' }); close() }} />
    </>} />
    <PageOptions title="Customize">
      {kind === 'skill' ? <Popover icons="all" title="Add skill" label={<>Add skill<CaretIcon /></>} disabled={!loaded} reason={!loaded ? 'Skills have not been read.' : undefined} triggerVariant={{ variant: 'outline', size: 'sm' }}>{close => <Menu close={close}>
        <MenuItem icon={<PencilIcon size={16} />} label="Write a skill" onSelect={() => { author(); close() }} />
        <MenuItem icon={<ImportIcon size={16} />} label="From GitHub…" onSelect={() => { github(); close() }} />
        <MenuItem icon={<ImportIcon size={16} />} label="Copy from another runtime…" onSelect={() => { importing(); close() }} />
      </Menu>}</Popover> : <Button variant="outline" size="sm" disabled={!loaded} onClick={importing}>Import server</Button>}
    </PageOptions>
    <CustomizeNavigation section={kind} onLibrarySection={change} />
    {kind === 'mcp' && <PageOptions choices={choices} search={search} />}
  </>
}
