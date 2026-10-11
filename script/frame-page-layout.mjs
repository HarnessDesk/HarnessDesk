import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { screenLayoutOf, pageMeasuresOf, retiredComponentsOf } from './design-audit.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const families = {
  settings: ['Settings', 'SettingsYou', 'SettingsAgents', 'SettingsCeilings', 'SettingsQuestionWait', 'SettingsClientAnswers', 'ProjectPage', 'LaneSettings', 'TriggerSettings', 'History', 'Archive', 'Storage', 'Extensions'],
  dashboard: ['Usage', 'UsageActivity', 'InsightUsage'],
  agents: ['AgentsWindow', 'AgentRoster', 'AgentPage', 'AgentFields', 'AgentNew', 'AgentAttachments'],
  teams: ['TeamsWindow'],
  library: ['Library', 'LibraryActions'],
  plugins: ['PluginsSection', 'InstallPlugin', 'SchemaForm'],
  review: ['ChangesReview'],
}
export const pageLayoutFindings = (family, sources) => {
  if (!Object.hasOwn(families, family)) throw new Error(`Unknown page family: ${family}`)
  const directory = path.join(root, 'packages/ui/src/components')
  const names = new Set(families[family].flatMap(name => [`${name}.tsx`, `${name}.module.css`]))
  if (family === 'plugins') names.add('Plugins.module.css')
  if (family === 'settings') names.add('Archive.module.css'), names.add('Extensions.module.css')
  if (family === 'agents') names.add('AgentAttachments.module.css')
  const files = [...names].map(name => path.join(directory, name))
  if (family === 'dashboard') for (const name of fs.readdirSync(path.join(directory, 'usage'))) {
    if (!name.includes('.test.') && /\.(tsx|css)$/.test(name)) files.push(path.join(directory, 'usage', name))
  }
  return files.filter(file => sources ? sources.has(path.relative(directory, file)) : fs.existsSync(file)).flatMap(file => {
    const source = sources ? sources.get(path.relative(directory, file)) : fs.readFileSync(file, 'utf8')
    return [...screenLayoutOf(file, source), ...pageMeasuresOf(file, source), ...retiredComponentsOf(file, source)]
  })
}
