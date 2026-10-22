import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'

export type CustomizeSection = 'skill' | 'mcp' | 'plugins'

/** One section vocabulary for the shared capability destination. */
export const CustomizeTabs = ({ value, onChange }: {
  readonly value: CustomizeSection
  readonly onChange: (section: CustomizeSection) => void
}) => <ToggleGroup type="single" size="sm" variant="chips" aria-label="Customize sections" value={value}
  onValueChange={next => { if (next === 'skill' || next === 'mcp' || next === 'plugins') onChange(next) }}>
  <ToggleGroupItem value="skill">Skills</ToggleGroupItem>
  <ToggleGroupItem value="mcp">MCP</ToggleGroupItem>
  <ToggleGroupItem value="plugins">Plugins</ToggleGroupItem>
</ToggleGroup>
