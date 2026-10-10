import assert from 'node:assert/strict'
import test from 'node:test'

import { catalogCoverage, catalogIntegrity, cvaContract, declarationStrings, importGraph, isReachable, renderedDeclarationStrings, exportedModules, surfaceLoads } from './ui-catalog.mjs'

test('discovers canonical modules through star, named and namespace exports', () => {
  assert.deepEqual(exportedModules(`
    export * from './button'
    export { ProbeWidget, type ProbeProps } from "./probe-widget"
    export * as Widgets from './widgets'
    // export * from './not-a-module'
    export { Other } from './button'
  `), ['button', 'probe-widget', 'widgets'])
})

test('reads declared coverage from the example that renders the cases', () => {
  assert.deepEqual(
    declarationStrings("const BUTTON_CATALOG_VARIANTS = ['default', 'quiet'] as const", 'BUTTON_CATALOG_VARIANTS'),
    ['default', 'quiet'],
  )
})

test('accepts coverage only when the declaration renders runtime case evidence', () => {
  const declaration = "const ALERT_CATALOG_TONE = ['neutral', 'success'] as const\n"
  assert.equal(
    renderedDeclarationStrings(`${declaration}<div data-catalog-tone={ALERT_CATALOG_TONE.join(' ')} />`, 'ALERT_CATALOG_TONE', 'tone'),
    null,
  )
  assert.deepEqual(
    renderedDeclarationStrings(
      `${declaration}ALERT_CATALOG_TONE.map((tone) => <Alert key={tone} tone={tone} data-catalog-tone={tone} />)`,
      'ALERT_CATALOG_TONE',
      'tone',
    ),
    ['neutral', 'success'],
  )
})

test('reads variant and size axes from the canonical cva contract', () => {
  assert.deepEqual(cvaContract(`
    const variants = cva('base', { variants: {
      variant: { default: 'a', quiet: 'b' },
      size: { default: 'c', compact: 'd' },
    } })
  `), {
    variant: ['default', 'quiet'],
    size: ['default', 'compact'],
  })
})

test('rejects catalog metadata that disagrees with its component contract', () => {
  const result = catalogIntegrity({
    entries: [{
      id: 'primitive.input', category: 'Primitives', implementationPath: 'input.tsx',
      exampleId: 'field', examples: ['example.tsx'], consumers: ['consumer.tsx'],
      variants: ['default', 'filled'], sizes: ['default'], states: ['default'], visual: true,
    }],
    existingPaths: new Set(['input.tsx', 'example.tsx', 'consumer.tsx']),
    exampleIds: new Set(['field']), requiredSurfaces: [],
    contracts: new Map([['input.tsx', { variant: ['default', 'quiet'], size: ['default', 'compact'] }]]),
  })
  assert.deepEqual(result.mismatchedVariants, ['primitive.input'])
  assert.deepEqual(result.mismatchedSizes, ['primitive.input'])
})

test('rejects example coverage that omits a recorded variant, size, or state', () => {
  const result = catalogIntegrity({
    entries: [{
      id: 'primitive.button', category: 'Primitives', implementationPath: 'button.tsx',
      exampleId: 'button', examples: ['example.tsx'], consumers: ['consumer.tsx'],
      variants: ['default', 'quiet'], sizes: ['default', 'sm'], states: ['default', 'disabled'], visual: true,
    }],
    existingPaths: new Set(['button.tsx', 'example.tsx', 'consumer.tsx']),
    exampleIds: new Set(['button']), requiredSurfaces: [],
    exampleCoverage: new Map([['button.tsx', {
      variants: ['default'], sizes: ['default'], states: ['default'],
    }]]),
  })
  assert.deepEqual(result.uncoveredExampleVariants, ['primitive.button'])
  assert.deepEqual(result.uncoveredExampleSizes, ['primitive.button'])
  assert.deepEqual(result.uncoveredExampleStates, ['primitive.button'])
})

test('rejects an unmapped nonstandard CVA axis', () => {
  const base = {
    id: 'primitive.attachment', category: 'Primitives', implementationPath: 'attachment.tsx',
    exampleId: 'adopted', examples: ['example.tsx'], consumers: ['consumer.tsx'],
    variants: ['default'], sizes: ['default'], states: ['default'], visual: true,
  }
  const args = {
    entries: [base], existingPaths: new Set(['attachment.tsx', 'example.tsx', 'consumer.tsx']),
    exampleIds: new Set(['adopted']), requiredSurfaces: [],
    contracts: new Map([['attachment.tsx', { size: ['default'], orientation: ['horizontal', 'vertical'] }]]),
  }
  const missing = catalogIntegrity({
    ...args,
    exampleCoverage: new Map([['attachment.tsx', {
      variants: ['default'], sizes: ['default'], states: ['default'], axes: { size: ['default'] },
    }]]),
  })
  assert.deepEqual(missing.uncoveredCvaAxes, ['primitive.attachment:orientation'])
  const complete = catalogIntegrity({
    ...args,
    exampleCoverage: new Map([['attachment.tsx', {
      variants: ['default'], sizes: ['default'], states: ['default'],
      axes: { size: ['default'], orientation: ['horizontal', 'vertical'] },
      renderedAxes: { size: ['default'], orientation: ['horizontal', 'vertical'] },
    }]]),
  })
  assert.deepEqual(complete.uncoveredCvaAxes, [])
  assert.deepEqual(complete.unrenderedCvaAxes, [])
})

test('rejects a declared CVA axis that is not mounted by its catalog example', () => {
  const result = catalogIntegrity({
    entries: [{
      id: 'primitive.alert', category: 'Primitives', implementationPath: 'alert.tsx',
      exampleId: 'banner', examples: ['example.tsx'], consumers: ['consumer.tsx'],
      variants: ['default'], sizes: ['default'], states: ['default'], visual: true,
    }],
    existingPaths: new Set(['alert.tsx', 'example.tsx', 'consumer.tsx']),
    exampleIds: new Set(['banner']), requiredSurfaces: [],
    contracts: new Map([['alert.tsx', { tone: ['neutral', 'success'] }]]),
    exampleCoverage: new Map([['alert.tsx', {
      variants: ['default'], sizes: ['default'], states: ['default'],
      axes: { tone: ['neutral', 'success'] }, renderedAxes: { tone: null },
    }]]),
  })
  assert.deepEqual(result.unrenderedCvaAxes, ['primitive.alert:tone'])
})

test('requires coverage for every visual entry unless it carries a reviewed exemption', () => {
  const base = {
    category: 'Patterns', implementationPath: 'Pattern.tsx', exampleId: 'pattern',
    examples: ['example.tsx'], consumers: ['consumer.tsx'], variants: ['default'],
    sizes: ['default'], states: ['default'], visual: true,
  }
  const args = {
    existingPaths: new Set(['Pattern.tsx', 'example.tsx', 'consumer.tsx']),
    exampleIds: new Set(['pattern']), requiredSurfaces: [],
  }
  const missing = catalogIntegrity({ ...args, entries: [{ ...base, id: 'pattern.missing' }] })
  assert.deepEqual(missing.missingExampleCoverage, ['pattern.missing'])
  const exempt = catalogIntegrity({
    ...args,
    entries: [{ ...base, id: 'pattern.exempt', coverageExemption: 'Compound portal state is covered by its keyboard scenario.' }],
  })
  assert.deepEqual(exempt.missingExampleCoverage, [])
})

test('rejects coverage exemptions for detectable CVA contracts', () => {
  const result = catalogIntegrity({
    entries: [{
      id: 'primitive.badge', category: 'Primitives', implementationPath: 'badge.tsx',
      exampleId: 'adopted', examples: ['example.tsx'], consumers: ['consumer.tsx'],
      variants: ['default'], sizes: ['default'], states: ['default'], visual: true,
      coverageExemption: 'Badge is reviewed on the adopted board instead of declaring its CVA cases.',
    }],
    existingPaths: new Set(['badge.tsx', 'example.tsx', 'consumer.tsx']),
    exampleIds: new Set(['adopted']), requiredSurfaces: [],
    contracts: new Map([['badge.tsx', { variant: ['default'] }]]),
  })
  assert.deepEqual(result.invalidCoverageExemptions, ['primitive.badge'])
})

test('requires a non-CVA exemption to name its own entry evidence', () => {
  const base = {
    id: 'pattern.menu', category: 'Patterns', implementationPath: 'Menu.tsx',
    exampleId: 'propagation', examples: ['example.tsx'], consumers: ['consumer.tsx'],
    variants: ['default'], sizes: ['default'], states: ['open'], visual: true,
  }
  const args = {
    existingPaths: new Set(['Menu.tsx', 'example.tsx', 'consumer.tsx']),
    exampleIds: new Set(['propagation']), requiredSurfaces: [],
  }
  const generic = catalogIntegrity({
    ...args,
    entries: [{ ...base, coverageExemption: 'Compound anatomy is exercised by a reachable interactive board and does not use CVA.' }],
  })
  assert.deepEqual(generic.invalidCoverageExemptions, ['pattern.menu'])
  const specific = catalogIntegrity({
    ...args,
    entries: [{ ...base, coverageExemption: 'Menu has no CVA contract; its keyboard states are reviewed on the propagation board.' }],
  })
  assert.deepEqual(specific.invalidCoverageExemptions, [])
})

test('fails coverage when a public component has no catalog registration', () => {
  const result = catalogCoverage({
    uiModules: ['button', 'new-control'],
    patternModules: ['Settings'],
    registeredUi: ['button'],
    registeredPatterns: ['Settings'],
  })
  assert.deepEqual(result.missingUi, ['new-control'])
})

const siblingExports = [
  { path: 'packages/ui/src/design/index.ts', source: "export { Button, NewControl, CatalogOnly } from './ui/button'\nexport { AccountMark } from './patterns/Settings'" },
  { path: 'packages/ui/src/design/ui/button.tsx', source: 'export const Button = () => null\nexport const NewControl = () => null\nexport const CatalogOnly = () => null' },
  { path: 'packages/ui/src/design/patterns/Settings.tsx', source: 'export const AccountMark = () => null' },
  { path: 'packages/ui/src/components/Screen.tsx', source: "import { Button, NewControl, AccountMark as Mark } from '../design'\nexport const Screen = () => <><Button /><NewControl /><Mark /></>" },
]

const siblingCoverage = (entries, exportExemptions = []) => catalogCoverage({
  uiModules: ['button'], patternModules: ['Settings'],
  registeredUi: ['button'], registeredPatterns: ['Settings'],
  graph: importGraph(siblingExports),
  screenPaths: ['packages/ui/src/components/Screen.tsx'],
  entries, exportExemptions,
})

test('fails for consumed public siblings even when their modules are registered (#987)', () => {
  const result = siblingCoverage([
    { implementationPath: siblingExports[1].path, symbols: ['Button'] },
    { implementationPath: siblingExports[2].path, symbols: [] },
  ])
  assert.deepEqual(result.missingExports, [
    `${siblingExports[2].path}#AccountMark`, `${siblingExports[1].path}#NewControl`,
  ])
  assert.deepEqual(result.missingUi, [])
})

test('accepts explicit sibling registration and only reasoned export exemptions (#987)', () => {
  const entries = [
    { implementationPath: siblingExports[1].path, symbols: ['Button', 'NewControl'] },
  ]
  const key = `${siblingExports[2].path}#AccountMark`
  const exempt = siblingCoverage(entries, [{ export: key, reason: 'AccountMark is a nonvisual helper checked in its dedicated scenario.' }])
  assert.deepEqual(exempt.missingExports, [])
  assert.deepEqual(exempt.invalidExportExemptions, [])
  const invalid = siblingCoverage(entries, [{ export: key, reason: '' }])
  assert.deepEqual(invalid.missingExports, [key])
  assert.deepEqual(invalid.invalidExportExemptions, [key])
  assert.deepEqual(siblingCoverage([...entries, { implementationPath: siblingExports[2].path, symbols: ['Retired'] }]).staleExports, [`${siblingExports[2].path}#Retired`])
})

test('symbol reachability does not credit another export of the same module (#987)', () => {
  const files = siblingExports.map((file) => file.path.endsWith('Screen.tsx')
    ? { ...file, source: "import { Button } from '../design'" } : file)
  const graph = importGraph(files)
  assert.equal(isReachable(graph, files[3].path, `${files[1].path}#Button`), true)
  assert.equal(isReachable(graph, files[3].path, `${files[1].path}#NewControl`), false)
})

test('fails when local union size values are missing from a registered sibling (#987)', () => {
  const implementationPath = 'packages/ui/src/design/patterns/Settings.tsx'
  const source = `
    type MarkSize = 'sm' | 'lg' | 'dot'
    type MarkProps = React.ComponentProps<'span'> & { size?: MarkSize }
    export const AccountMark = ({ size }: MarkProps) => <span />
    export const Other = ({ size }: { size?: 'compact' }) => <span />
  `
  const args = {
    entries: [{
      id: 'pattern.Settings', category: 'Patterns', implementationPath,
      symbols: ['AccountMark'], symbolAxes: { AccountMark: { size: ['sm', 'lg'] } },
      exampleId: 'row', examples: ['example.tsx'], consumers: ['consumer.tsx'],
      variants: ['default'], sizes: ['default'], states: ['default'], visual: true,
    }],
    existingPaths: new Set([implementationPath, 'example.tsx', 'consumer.tsx']),
    exampleIds: new Set(['row']), requiredSurfaces: [],
    sourceByPath: new Map([[implementationPath, source]]),
  }
  assert.deepEqual(catalogIntegrity(args).mismatchedUnionAxes, ['pattern.Settings:AccountMark:size'])
  args.entries[0].symbolAxes.AccountMark.size.push('dot')
  assert.deepEqual(catalogIntegrity(args).mismatchedUnionAxes, [])
})

test('reads local function union variants through interfaces and discriminated props (#987)', () => {
  const implementationPath = 'packages/ui/src/design/ui/probe.tsx'
  const args = {
    entries: [{
      id: 'primitive.probe', implementationPath, symbols: ['Probe'], symbolAxes: { Probe: { variant: ['plain'] } },
      exampleId: 'probe', examples: ['example.tsx'], consumers: ['consumer.tsx'],
      variants: ['default'], sizes: ['default'], states: ['default'], visual: true,
    }],
    existingPaths: new Set([implementationPath, 'example.tsx', 'consumer.tsx']),
    exampleIds: new Set(['probe']), requiredSurfaces: [],
    sourceByPath: new Map([[implementationPath, `
      interface Base { size?: 'sm' | 'lg' }
      type Props = Base & ({ variant: 'plain' } | { variant: 'quiet' })
      function Probe({ variant }: Props) { return null }
      export { Probe }
    `]]),
  }
  assert.deepEqual(catalogIntegrity(args).mismatchedUnionAxes, ['primitive.probe:Probe:size', 'primitive.probe:Probe:variant'])
})

test('does not register type-only exports and keeps a public re-export facade (#987)', () => {
  const files = [
    { path: 'packages/ui/src/design/index.ts', source: "export * from './patterns/Probe'" },
    { path: 'packages/ui/src/design/patterns/Probe.tsx', source: "import type { ImportedProps } from './types'\nexport type ExplicitProps = { size: 'sm' }\ninterface LocalProps { size: 'sm' }\nexport { LocalProps, type ImportedProps }\nexport { ImportedProps as ReexportedProps } from './types'\nexport { Probe as PublicProbe } from './implementation'" },
    { path: 'packages/ui/src/design/patterns/types.ts', source: 'export type ImportedProps = {}' },
    { path: 'packages/ui/src/design/patterns/implementation.tsx', source: 'export const Probe = () => null' },
    { path: 'packages/ui/src/components/Screen.tsx', source: "import { PublicProbe, type ReexportedProps } from '../design'" },
  ]
  const result = catalogCoverage({
    uiModules: [], patternModules: ['Probe'], registeredUi: [], registeredPatterns: ['Probe'],
    graph: importGraph(files), screenPaths: [files[4].path],
    entries: [{ implementationPath: files[1].path, symbols: ['PublicProbe'] }],
  })
  assert.deepEqual(result.missingExports, [])
  assert.deepEqual(result.staleExports, [])
})

test('checks a locally aliased export with nullable union props (#987)', () => {
  const implementationPath = 'packages/ui/src/design/ui/probe.tsx'
  const result = catalogIntegrity({
    entries: [{
      id: 'primitive.probe', implementationPath, symbols: ['PublicProbe'],
      symbolAxes: { PublicProbe: { size: ['sm'] } },
      exampleId: 'probe', examples: ['example.tsx'], consumers: ['consumer.tsx'],
      variants: ['default'], sizes: ['default'], states: ['default'], visual: true,
    }],
    existingPaths: new Set([implementationPath, 'example.tsx', 'consumer.tsx']),
    exampleIds: new Set(['probe']), requiredSurfaces: [],
    sourceByPath: new Map([[implementationPath, `
      const Probe = ({ size }: { size?: 'sm' | 'lg' | undefined }) => null
      export { Probe as PublicProbe }
    `]]),
  })
  assert.deepEqual(result.mismatchedUnionAxes, ['primitive.probe:PublicProbe:size'])
})

test('inventories namespace and default re-exports through the symbol graph (#987)', () => {
  const files = [
    { path: 'packages/ui/src/design/index.ts', source: "export * as Controls from './ui'" },
    { path: 'packages/ui/src/design/ui/index.ts', source: "export * from './probe'" },
    { path: 'packages/ui/src/design/ui/probe.tsx', source: "export { default as NewControl } from './implementation'" },
    { path: 'packages/ui/src/design/ui/implementation.tsx', source: 'export default function Control() { return null }' },
    { path: 'packages/ui/src/components/Screen.tsx', source: "import { Controls } from '../design'\nconst Screen = () => <Controls.NewControl />" },
  ]
  for (const source of [
    'export default function Control() { return null }',
    'export default () => null',
    'export default function () { return null }',
  ]) {
    files[3].source = source
    const result = catalogCoverage({
      uiModules: ['probe'], patternModules: [], registeredUi: ['probe'], registeredPatterns: [],
      graph: importGraph(files), screenPaths: [files[4].path], entries: [],
    })
    assert.deepEqual(result.missingExports, [`${files[2].path}#NewControl`], source)
  }
})

test('does not count a type-only screen import as a value consumer (#987)', () => {
  for (const source of [
    "import type { NewControl } from '../design'",
    "import { type NewControl } from '../design'",
  ]) {
    const files = siblingExports.map((file) => file.path.endsWith('Screen.tsx') ? { ...file, source } : file)
    const result = catalogCoverage({
      uiModules: ['button'], patternModules: ['Settings'], registeredUi: ['button'], registeredPatterns: ['Settings'],
      graph: importGraph(files), screenPaths: [files[3].path], entries: [],
    })
    assert.deepEqual(result.missingExports, [], source)
  }
})

test('rejects dangling implementation paths and example ids', () => {
  const result = catalogIntegrity({
    entries: [{
      id: 'primitive.button',
      category: 'Primitives',
      implementationPath: 'missing.tsx',
      exampleId: 'missing-board',
      consumers: [],
    }],
    existingPaths: new Set(),
    exampleIds: new Set(['button']),
    requiredSurfaces: [],
  })
  assert.deepEqual(result.danglingPaths, ['primitive.button'])
  assert.deepEqual(result.danglingExamples, ['primitive.button'])
  assert.deepEqual(result.missingConsumers, ['primitive.button'])
  assert.deepEqual(result.missingVariants, ['primitive.button'])
  assert.deepEqual(result.missingSizes, ['primitive.button'])
  assert.deepEqual(result.missingStates, ['primitive.button'])
  assert.deepEqual(result.missingExamples, ['primitive.button'])
})

test('rejects a consumer reference that names no file', () => {
  const result = catalogIntegrity({
    entries: [{
      id: 'primitive.button',
      category: 'Primitives',
      implementationPath: 'button.tsx',
      exampleId: 'button',
      variants: ['default'],
      states: ['default'],
      consumers: ['packages/ui/src/components/Missing.tsx'],
    }],
    existingPaths: new Set(['button.tsx']),
    exampleIds: new Set(['button']),
    requiredSurfaces: [],
  })
  assert.deepEqual(result.danglingConsumers, ['primitive.button'])
})

test('rejects a real but unrelated path presented as a component consumer', () => {
  const files = [
    { path: 'packages/ui/src/components/Unrelated.tsx', source: "import './Unrelated.css'" },
    { path: 'packages/ui/src/components/Unrelated.css', source: '.unrelated {}' },
    { path: 'packages/ui/src/design/ui/button.tsx', source: 'export const Button = 1' },
  ]
  const graph = importGraph(files)
  assert.equal(isReachable(graph, files[0].path, files[2].path), false)
  const result = catalogIntegrity({
    entries: [{
      id: 'primitive.button',
      category: 'Primitives',
      implementationPath: files[2].path,
      exampleId: 'button',
      variants: ['default'],
      states: ['default'],
      consumers: [files[0].path],
    }],
    existingPaths: new Set(files.map((file) => file.path)),
    exampleIds: new Set(['button']),
    requiredSurfaces: [],
    reachablePairs: new Set(),
  })
  assert.deepEqual(result.unreachableConsumers, ['primitive.button'])
})

test('follows public barrels and stylesheet imports to prove consumers', () => {
  const files = [
    { path: 'packages/ui/src/components/Good.tsx', source: "import { Button } from '../design'" },
    { path: 'packages/ui/src/design/index.ts', source: "export * from './ui'" },
    { path: 'packages/ui/src/design/ui/index.ts', source: "export * from './button'" },
    { path: 'packages/ui/src/design/ui/button.tsx', source: 'export const Button = 1' },
    { path: 'packages/ui/src/main.tsx', source: "import './styles/app.css'" },
    { path: 'packages/ui/src/styles/app.css', source: "@import '../design/foundation/tokens.css';" },
    { path: 'packages/ui/src/design/foundation/tokens.css', source: ':root {}' },
  ]
  const graph = importGraph(files)
  assert.equal(isReachable(graph, files[0].path, files[3].path), true)
  assert.equal(isReachable(graph, files[4].path, files[6].path), true)
})

test('does not credit an unrelated symbol imported from the same public barrel', () => {
  const files = [
    { path: 'packages/ui/src/components/InputOnly.tsx', source: "import { Input } from '../design'" },
    { path: 'packages/ui/src/design/index.ts', source: "export * from './ui'" },
    { path: 'packages/ui/src/design/ui/index.ts', source: "export * from './button'\nexport * from './input'" },
    { path: 'packages/ui/src/design/ui/button.tsx', source: 'export const Button = 1' },
    { path: 'packages/ui/src/design/ui/input.tsx', source: 'export const Input = 1' },
  ]
  const graph = importGraph(files)
  assert.equal(isReachable(graph, files[0].path, files[3].path), false)
  assert.equal(isReachable(graph, files[0].path, files[4].path), true)
})

test('does not fan a named re-export out to sibling exports in the same barrel', () => {
  const files = [
    { path: 'packages/ui/src/components/InputOnly.tsx', source: "import { Input } from '../design'" },
    { path: 'packages/ui/src/design/index.ts', source: "export { Button } from './ui/button'\nexport { Input } from './ui/input'" },
    { path: 'packages/ui/src/design/ui/button.tsx', source: 'export const Button = 1' },
    { path: 'packages/ui/src/design/ui/input.tsx', source: 'export const Input = 1' },
  ]
  const graph = importGraph(files)
  assert.equal(isReachable(graph, files[0].path, files[2].path), false)
  assert.equal(isReachable(graph, files[0].path, files[3].path), true)
})

test('rejects a product surface missing from the live manifest', () => {
  const result = catalogIntegrity({
    entries: [],
    existingPaths: new Set(),
    exampleIds: new Set(),
    requiredSurfaces: [{ id: 'surface.settings', implementationPath: 'packages/ui/src/components/Settings.tsx' }],
  })
  assert.deepEqual(result.missingSurfaces, ['surface.settings'])
})

test('rejects a manifest surface that points somewhere other than the independent registry', () => {
  const result = catalogIntegrity({
    entries: [{
      id: 'surface.settings',
      category: 'Product Surfaces',
      implementationPath: 'packages/ui/src/design/showcase/Other.tsx',
      exampleId: 'settings',
      consumers: ['design.html'],
    }],
    existingPaths: new Set(['packages/ui/src/design/showcase/Other.tsx']),
    exampleIds: new Set(['settings']),
    requiredSurfaces: [{ id: 'surface.settings', implementationPath: 'packages/ui/src/components/Settings.tsx' }],
  })
  assert.deepEqual(result.mismatchedSurfacePaths, ['surface.settings'])
})

test('reports stale catalog entries as well as missing ones', () => {
  const result = catalogCoverage({
    uiModules: ['button'],
    patternModules: ['Settings'],
    registeredUi: ['button', 'retired'],
    registeredPatterns: ['Settings', 'OldDialog'],
  })
  assert.deepEqual(result.staleUi, ['retired'])
  assert.deepEqual(result.stalePatterns, ['OldDialog'])
})

/*
 * Two surfaces in one module, one screen each. The #762 review built exactly
 * this and found the lazy handle for one surface "reaching" the other's
 * screen, because a dynamic import was recorded as a whole-file edge.
 */
const surfaceModule = [
  { path: 'app/surfaces.tsx', source: "import { Conversation } from './Conversation'\nimport { Sidebar } from './Sidebar'\nexport const ConversationSurface = () => <Conversation />\nexport const RailSurface = () => <Sidebar />" },
  { path: 'app/Conversation.tsx', source: 'export const Conversation = () => null' },
  { path: 'app/Sidebar.tsx', source: 'export const Sidebar = () => null' },
]
const withHandle = (source) => importGraph([{ path: 'app/Explorer.tsx', source }, ...surfaceModule])

test('a lazy handle reaches only the export it takes, not its siblings (#762)', () => {
  const graph = withHandle("export const C = lazy(() => import('./surfaces').then((m) => ({ default: m.ConversationSurface })))")
  assert.deepEqual(
    { conversation: isReachable(graph, 'app/Explorer.tsx', 'app/Conversation.tsx'), unrelatedSidebar: isReachable(graph, 'app/Explorer.tsx', 'app/Sidebar.tsx') },
    { conversation: true, unrelatedSidebar: false },
  )
  const destructured = withHandle("export const C = lazy(() => import('./surfaces').then(({ RailSurface }) => ({ default: RailSurface })))")
  assert.equal(isReachable(destructured, 'app/Explorer.tsx', 'app/Sidebar.tsx'), true)
  assert.equal(isReachable(destructured, 'app/Explorer.tsx', 'app/Conversation.tsx'), false)
})

test('a dynamic import whose exports cannot be read stays whole-file (#762)', () => {
  // over-reaching is the safe direction for "reachable"
  for (const source of [
    "export const C = lazy(() => import('./surfaces').then((m) => ({ default: pick(m) })))",
    "const load = () => import('./surfaces')\nexport const C = lazy(() => load().then((m) => ({ default: m.ConversationSurface })))",
    "export const C = lazy(() => import('./surfaces').then(({ ...all }) => ({ default: all.ConversationSurface })))",
  ]) assert.equal(isReachable(withHandle(source), 'app/Explorer.tsx', 'app/Sidebar.tsx'), true, source)
})

test('an anchored example is walked from that one export (#762)', () => {
  const graph = importGraph(surfaceModule)
  assert.equal(isReachable(graph, 'app/surfaces.tsx#RailSurface', 'app/Sidebar.tsx'), true)
  assert.equal(isReachable(graph, 'app/surfaces.tsx#ConversationSurface', 'app/Sidebar.tsx'), false)
  // an anchor naming nothing the file exports reaches nothing
  assert.equal(isReachable(graph, 'app/surfaces.tsx#Missing', 'app/Sidebar.tsx'), false)
})

test('each explorer tab is bound to the export its handle renders, and a swap is flagged (#762)', () => {
  const explorer = [
    "const RailSurface = lazy(() => import('./surfaces').then((m) => ({ default: m.RailSurface })))",
    "const GitSurface = lazy(() => import('./surfaces').then((m) => ({ default: m.GitSurface })))",
    "const Hidden = lazy(() => load().then((m) => ({ default: m.RailSurface })))",
    "const SURFACES = [",
    "  { id: 'rail', title: 'Left bar', about: '', render: GitSurface },",
    "  { id: 'git', title: 'Git', about: '', render: GitSurface },",
    "  { id: 'hidden', title: 'Hidden', about: '', render: Hidden },",
    "] as const",
  ].join('\n')
  const loads = surfaceLoads(explorer, 'app/Explorer.tsx', new Set(['app/surfaces.tsx']))
  assert.deepEqual(loads.get('git'), { target: 'app/surfaces.tsx', symbol: 'GitSurface' })
  // a handle that hides its import behind a helper renders nothing the check can read
  assert.equal(loads.get('hidden'), null)
  const integrity = catalogIntegrity({
    entries: [
      { id: 'surface.rail', exampleId: 'rail', implementationPath: 'app/Sidebar.tsx', examples: ['app/surfaces.tsx#RailSurface'], consumers: [], catalogOnly: true, variants: ['default'], sizes: ['default'], states: ['default'], visual: false },
      { id: 'surface.git', exampleId: 'git', implementationPath: 'app/GitPane.tsx', examples: ['app/surfaces.tsx#GitSurface'], consumers: [], catalogOnly: true, variants: ['default'], sizes: ['default'], states: ['default'], visual: false },
    ],
    existingPaths: new Set(['app/Sidebar.tsx', 'app/GitPane.tsx', 'app/surfaces.tsx']),
    exampleIds: new Set(['rail', 'git']),
    requiredSurfaces: [],
    surfaceLoadsByView: loads,
  })
  // the rail tab renders the git handle: its row's export is never loaded
  assert.deepEqual(integrity.unloadedAnchors, ['surface.rail'])
  assert.deepEqual(integrity.danglingExamplePaths, [])
})

/*
 * The #762 re-review: a handle that touched the Left bar export and rendered
 * Git satisfied the Left bar anchor, because every export the callback read
 * counted as loaded. What a tab shows is the `default` its loader returns.
 */
const renders = (handle) =>
  surfaceLoads(
    `const H = ${handle}\nconst SURFACES = [ { id: 'rail', title: 'Left bar', about: '', render: H } ] as const`,
    'app/Explorer.tsx',
    new Set(['app/surfaces.tsx']),
  ).get('rail')

test('a tab renders the default its loader returns, not every export it touches (#762)', () => {
  assert.deepEqual(
    renders("lazy(() => import('./surfaces').then((m) => { void m.RailSurface; return { default: m.GitSurface } }))"),
    { target: 'app/surfaces.tsx', symbol: 'GitSurface' },
  )
  assert.deepEqual(
    renders("lazy(() => import('./surfaces').then(({ RailSurface: Rail }) => ({ default: Rail })))"),
    { target: 'app/surfaces.tsx', symbol: 'RailSurface' },
  )
  // a bare import renders the module's own default export
  assert.deepEqual(renders("lazy(() => import('./surfaces'))"), { target: 'app/surfaces.tsx', symbol: 'default' })
})

test('a loader whose rendered export cannot be read renders nothing, and is reported (#762)', () => {
  for (const handle of [
    // two returns that disagree
    "lazy(() => import('./surfaces').then((m) => { if (flag) return { default: m.RailSurface }; return { default: m.GitSurface } }))",
    // a computed default
    "lazy(() => import('./surfaces').then((m) => ({ default: pick(m) })))",
    // a helper that hides the import
    "lazy(() => load().then((m) => ({ default: m.RailSurface })))",
  ]) assert.equal(renders(handle), null, handle)

  const integrity = catalogIntegrity({
    entries: [{ id: 'surface.rail', exampleId: 'rail', implementationPath: 'app/Sidebar.tsx', examples: ['app/surfaces.tsx#RailSurface'], consumers: [], catalogOnly: true, variants: ['default'], sizes: ['default'], states: ['default'], visual: false }],
    existingPaths: new Set(['app/Sidebar.tsx', 'app/surfaces.tsx']),
    exampleIds: new Set(['rail']),
    requiredSurfaces: [],
    surfaceLoadsByView: new Map([['rail', renders("lazy(() => import('./surfaces').then((m) => { void m.RailSurface; return { default: m.GitSurface } }))")]]),
  })
  assert.deepEqual(integrity.unloadedAnchors, ['surface.rail'])
})

test('a pattern folder is catalogued through its public facade, with no orphan folders hidden', async () => {
  const { patternModulesFromPaths } = await import('./ui-catalog.mjs')
  assert.deepEqual(patternModulesFromPaths([
    'packages/ui/src/design/patterns/FlowCanvas.tsx',
    'packages/ui/src/design/patterns/FlowCanvas/Engine.tsx',
    'packages/ui/src/design/patterns/FlowCanvas/StepCard.tsx',
    'packages/ui/src/design/patterns/FlowCanvas/types.ts',
    'packages/ui/src/design/patterns/FlowCanvas/FlowCanvas.test.tsx',
    'packages/ui/src/design/patterns/Orphan/Part.tsx',
    'packages/ui/src/components/Other.tsx',
  ]), ['FlowCanvas', 'Orphan'])
})
