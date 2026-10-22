import { Button, Menu, MenuItem, MenuLabel, MenuNote, MenuSeparator, Popover, Search, Text, ToggleGroup, ToggleGroupItem, Toolbar, ToolbarGap, type PageOption } from '../design'
import { CaretIcon, FilterIcon } from '../components/Icons'
import type { SkillChip } from '../components/SkillRow'

/** Browsing stays compact; diagnostics and comparison are deliberate choices. */
export const LibrarySkillsControls = ({ chip, counts, onChip, view, onView, filters, agent, runtime, search }: {
  readonly chip: SkillChip; readonly counts: Readonly<Record<SkillChip, number>>; readonly onChip: (chip: SkillChip) => void
  readonly view: 'cards' | 'list' | 'matrix'; readonly onView: (view: 'cards' | 'list' | 'matrix') => void
  readonly filters: PageOption; readonly agent: PageOption; readonly runtime: PageOption
  readonly search: { label: string; value: string; change: (value: string) => void }
}) => {
  const selected = Number(filters.value !== 'all') + Number(agent.value !== '') + Number(chip !== 'all' && chip !== 'needs-you')
  return <>
    <Toolbar data-slot="library-skills-controls">
      <Search label={search.label} placeholder={search.label} value={search.value} onChange={search.change} />
      <ToolbarGap />
      <Popover title="Runtime" label={<>{runtime.items.find(item => item.value === runtime.value)?.label ?? (runtime.value ? 'Selected runtime' : 'All runtimes')}<CaretIcon /></>}
        triggerVariant={{ variant: 'outline', size: 'sm' }}>{close => <Menu close={close}>
        {runtime.items.map(item => <MenuItem key={item.value} label={item.label} selected={runtime.value === item.value}
          onSelect={() => { runtime.change(item.value); close() }} />)}
      </Menu>}</Popover>
      <Popover title="Filter skills" label={<><FilterIcon size={13} />Filter{selected > 0 && <Text role="meta" numeric>{selected}</Text>}</>} narrowed={selected > 0}
        triggerVariant={{ variant: 'ghost', size: 'sm' }}>{close => <Menu close={close}>
        {filters.items.filter(item => item.value !== 'problems').map(item => <MenuItem key={item.value} label={item.label} value={item.count}
          selected={filters.value === item.value} disabled={item.disabled} title={item.title} onSelect={() => { filters.change(item.value); close() }} />)}
        <MenuSeparator /><MenuLabel>Loaded by</MenuLabel>
        {chip === 'needs-you' && <MenuNote>Clear Needs attention to filter by runtime count.</MenuNote>}
        {([{ value: 'all', label: 'Any number' }, { value: 'one-runtime', label: 'One runtime' }, { value: 'nobody', label: 'No runtime' }] as const).map(item =>
          <MenuItem key={item.value} label={item.label} value={counts[item.value]} disabled={chip === 'needs-you'} selected={(chip === 'needs-you' ? 'all' : chip) === item.value} onSelect={() => { onChip(item.value); close() }} />)}
        <MenuSeparator /><MenuLabel>Declared by</MenuLabel>
        {agent.items.map(item => <MenuItem key={item.value} label={item.label} selected={agent.value === item.value} onSelect={() => { agent.change(item.value); close() }} />)}
      </Menu>}</Popover>
      <Popover title="View" label={<>View<CaretIcon /></>} triggerVariant={{ variant: 'ghost', size: 'sm' }}>{close => <Menu close={close}>
        {([{ value: 'cards', label: 'Cards' }, { value: 'list', label: 'List' }, { value: 'matrix', label: 'Runtime comparison', title: 'Compare every runtime’s measured reach.' }] as const).map(item =>
          <MenuItem key={item.value} label={item.label} selected={view === item.value} onSelect={() => { onView(item.value); close() }} />)}
      </Menu>}</Popover>
    </Toolbar>
    <Toolbar>
      <ToggleGroup type="single" size="sm" variant="chips" aria-label="Skills" value={chip === 'all' || chip === 'needs-you' ? chip : ''} onValueChange={value => { if (value) onChip(value as SkillChip) }}>
        <ToggleGroupItem value="all">All<Text role="meta" numeric>{counts.all}</Text></ToggleGroupItem>
        {(counts['needs-you'] > 0 || chip === 'needs-you') && <ToggleGroupItem value="needs-you">Needs attention<Text role="meta" numeric>{counts['needs-you']}</Text></ToggleGroupItem>}
      </ToggleGroup>
      {(chip === 'one-runtime' || chip === 'nobody') && <Button variant="ghost" size="sm" onClick={() => onChip('all')}>{chip === 'nobody' ? 'No runtime' : 'One runtime'} · Clear</Button>}
    </Toolbar>
  </>
}
