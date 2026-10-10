import { useState } from 'react'
import { Dot, LeftColumnGroup, LeftColumnHead, LeftColumnRow, Search, Text, type LeftColumnTrail } from '../design'
import { useRuntime, useSnapshot } from '../state/context'
import { ArrowLeftIcon } from './Icons'
import { moveWindowRailFocus } from './AppWindow'
import type { Section } from './Settings'
import { filterSettingsGroups, settingsGroups } from './settings-navigation'

export const SettingsNavigation = ({ section, onSection, onBack }: {
  section: Section; onSection: (section: Section) => void; onBack: () => void
}) => {
  const snapshot = useSnapshot(), runtime = useRuntime()
  const [query, setQuery] = useState('')
  const groups = filterSettingsGroups(settingsGroups(snapshot, runtime), query)
  return <nav aria-label="Settings navigation" data-left-settings onKeyDown={moveWindowRailFocus}>
    <LeftColumnRow label="Back" icon={<ArrowLeftIcon size={16} />} onClick={onBack} />
    <LeftColumnHead search={<Search value={query} onChange={setQuery}
      label="Search settings" placeholder="Search settings…" />} />
    {groups.map(group => <LeftColumnGroup key={group.label} label={group.label}>
      {group.entries.map(entry => {
        const trailing: LeftColumnTrail | undefined = entry.state
          ? { kind: 'mark', icon: <Dot state={entry.state} />, label: `Runtimes: ${entry.state}` }
          : entry.count !== undefined ? { kind: 'count', value: entry.count, label: `${entry.count} accounts` } : undefined
        return <LeftColumnRow key={entry.id} label={entry.label} icon={entry.icon} title={entry.title ?? entry.label}
          selected={section === entry.id} trailing={trailing} onClick={() => onSection(entry.id)} />
      })}
    </LeftColumnGroup>)}
    {groups.length === 0 && <Text as="p" role="meta">Nothing in settings matches “{query.trim()}”.</Text>}
  </nav>
}
