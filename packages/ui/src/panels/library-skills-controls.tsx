import { Menu, MenuItem, MenuLabel, MenuSeparator, Popover, Search, Text, ToggleGroup, ToggleGroupItem, Toolbar, ToolbarGap, type PageOption } from '../design'
import { CardsIcon, FilterIcon, MatrixIcon } from '../components/Icons'
import type { SkillChip } from '../components/SkillRow'

const CHIPS: readonly { value: SkillChip; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'needs-you', label: 'Needs you' },
  { value: 'one-runtime', label: 'One runtime' }, { value: 'nobody', label: 'Nobody' },
]
/** Local viewer choices only: nothing is persisted or sent to the host. */
export const LibrarySkillsControls = ({ chip, counts, onChip, view, onView, filters, agent, search }: {
  readonly chip: SkillChip; readonly counts: Readonly<Record<SkillChip, number>>; readonly onChip: (chip: SkillChip) => void
  readonly view: 'cards' | 'matrix'; readonly onView: (view: 'cards' | 'matrix') => void
  readonly filters: PageOption; readonly agent: PageOption
  readonly search: { label: string; value: string; change: (value: string) => void }
}) => {
  const selected = Number(filters.value !== 'all') + Number(agent.value !== '')
  return <Toolbar data-slot="library-skills-controls">
    <ToggleGroup type="single" size="sm" variant="chips" aria-label="Skills" value={chip} onValueChange={value => { if (value) onChip(value as SkillChip) }}>
      {CHIPS.map(one => <ToggleGroupItem key={one.value} value={one.value} aria-label={one.label}>
        {one.label}<Text role="meta" numeric>{counts[one.value]}</Text>
      </ToggleGroupItem>)}
    </ToggleGroup>
    <Popover title="Filter the library" label={<><FilterIcon size={13} />Filter{selected > 0 && <Text role="meta" numeric>{selected}</Text>}</>} narrowed={selected > 0}
      triggerVariant={{ variant: 'ghost', size: 'sm' }}>{close => <Menu close={close}>
      {filters.items.filter(one => one.value !== 'problems').map(one => <MenuItem key={one.value} label={one.label} value={one.count}
        selected={filters.value === one.value} disabled={one.disabled} title={one.title} onSelect={() => { filters.change(one.value); close() }} />)}
      <MenuSeparator /><MenuLabel>Declared by</MenuLabel>
      {agent.items.map(one => <MenuItem key={one.value} label={one.label} selected={agent.value === one.value} onSelect={() => { agent.change(one.value); close() }} />)}
    </Menu>}</Popover>
    <ToolbarGap /><Toolbar>
      <ToggleGroup type="single" size="sm" aria-label="How to show the library" value={view} onValueChange={value => { if (value) onView(value as 'cards' | 'matrix') }}>
        <ToggleGroupItem value="cards" aria-label="Cards" title="Cards"><CardsIcon size={14} /></ToggleGroupItem>
        <ToggleGroupItem value="matrix" aria-label="Matrix" title="Matrix"><MatrixIcon size={14} /></ToggleGroupItem>
      </ToggleGroup>
      <Search label={search.label} placeholder={search.label} value={search.value} onChange={search.change} />
    </Toolbar>
  </Toolbar>
}
