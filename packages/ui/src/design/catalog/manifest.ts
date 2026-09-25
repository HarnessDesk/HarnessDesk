export type CatalogCategory = 'Foundation' | 'Primitives' | 'Patterns' | 'Product Surfaces' | 'Boundary'
export type CatalogVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'floating' | 'destructive' | 'link' | 'soft' | 'solid' | 'vertical' | 'horizontal' | 'single' | 'multiple' | 'light' | 'dark' | 'row' | 'navigation' | 'choice' | 'quiet' | 'muted' | 'warning' | 'reveal' | 'subtle' | 'primary' | 'action' | 'filled' | 'chrome' | 'code' | 'editor' | 'inline' | 'composer' | 'border' | 'separator' | 'card' | 'plain' | 'panel' | 'integrated' | 'flush' | 'framed' | 'bordered' | 'tinted' | 'line' | 'remaining' | 'ring' | 'stack' | 'sticky' | 'workbench'
export type CatalogSize = 'default' | 'xs' | 'sm' | 'lg' | 'compact' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg' | 'content' | 'pattern' | 'chip' | 'inline' | 'panel' | 'row' | 'navigation' | 'fill' | 'icon-circle' | 'bare' | 'composer'
export type CatalogState = 'default' | 'hover' | 'focus-visible' | 'disabled' | 'checked' | 'unchecked' | 'indeterminate' | 'selected' | 'unselected' | 'open' | 'closed' | 'loading' | 'empty' | 'populated' | 'error' | 'success' | 'warning' | 'active' | 'inactive' | 'collapsed' | 'expanded' | 'stale' | 'unknown' | 'derived' | 'draft' | 'merged' | 'passed' | 'failed' | 'running' | 'skipped' | 'timed out'

export type CatalogEntry = {
  readonly id: string
  readonly category: CatalogCategory
  readonly implementationPath: string
  readonly purpose: string
  readonly exampleId: string
  readonly variants: readonly CatalogVariant[]
  readonly sizes: readonly CatalogSize[]
  readonly states: readonly CatalogState[]
  readonly examples: readonly string[]
  readonly consumers: readonly string[]
  readonly catalogOnly?: boolean
  readonly coverageExemption?: string
  readonly visual: boolean
}

type ModuleSeed = readonly [name: string, exampleId: string, purpose: string]

const EXAMPLE_CONSUMER: Readonly<Record<string, string>> = {
  button: 'packages/ui/src/design/explorer/boards.tsx',
  control: 'packages/ui/src/design/explorer/boards.tsx',
  face: 'packages/ui/src/design/explorer/boards.tsx',
  banner: 'packages/ui/src/design/explorer/boards.tsx',
  code: 'packages/ui/src/design/explorer/boards.tsx',
  dialog: 'packages/ui/src/design/explorer/boards.tsx',
  stat: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  delta: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  section: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  tile: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  list: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  readings: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  field: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  stepper: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  empty: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  kanban: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  adopted: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  spark: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  chart: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  foundation: 'packages/ui/src/design/explorer/Explorer.tsx',
  coverage: 'packages/ui/src/design/explorer/Explorer.tsx',
  group: 'packages/ui/src/design/explorer/Explorer.tsx',
  conversation: 'packages/ui/src/design/explorer/Explorer.tsx',
  composer: 'packages/ui/src/design/explorer/Explorer.tsx',
  rail: 'packages/ui/src/design/explorer/Explorer.tsx',
  git: 'packages/ui/src/design/explorer/Explorer.tsx',
  panels: 'packages/ui/src/design/explorer/Explorer.tsx',
  propagation: 'packages/ui/src/design/explorer/Explorer.tsx',
  tools: 'packages/ui/src/design/explorer/Explorer.tsx',
  'tool-pane': 'packages/ui/src/design/explorer/boards-compositions.tsx',
}

const PRIMITIVE_CONSUMER: Readonly<Record<string, string>> = {
  alert: 'packages/ui/src/components/WorktreeAlerts.tsx',
  badge: 'packages/ui/src/components/Channel.tsx',
  board: 'packages/ui/src/components/TeamBoardPane.tsx',
  button: 'packages/ui/src/components/SignIn.tsx',
  chart: 'packages/ui/src/components/Usage.tsx',
  composer: 'packages/ui/src/components/RoomComposer.tsx',
  checkbox: 'packages/ui/src/components/AddWork.tsx',
  dialog: 'packages/ui/src/components/Composer.tsx',
  delta: 'packages/ui/src/components/Usage.tsx',
  'dropdown-menu': 'packages/ui/src/components/TeamBoardPane.tsx',
  'empty-state': 'packages/ui/src/components/Library.tsx',
  field: 'packages/ui/src/components/Settings.tsx',
  'group-label': 'packages/ui/src/components/Settings.tsx',
  'hover-card': 'packages/ui/src/components/AgentCards.tsx',
  'icon-tile': 'packages/ui/src/components/SkillSheet.tsx',
  input: 'packages/ui/src/components/SignIn.tsx',
  label: 'packages/ui/src/components/Library.tsx',
  'list-row': 'packages/ui/src/components/TeamRoomPane.tsx',
  'native-select': 'packages/ui/src/components/PluginsSection.tsx',
  popover: 'packages/ui/src/components/ComposerControls.tsx',
  'radio-group': 'packages/ui/src/components/AddMember.tsx',
  'resize-handle': 'packages/ui/src/components/Panes.tsx',
  separator: 'packages/ui/src/components/Channel.tsx',
  spark: 'packages/ui/src/components/Usage.tsx',
  switch: 'packages/ui/src/components/PluginsSection.tsx',
  tabs: 'packages/ui/src/components/Extensions.tsx',
  textarea: 'packages/ui/src/components/AddWork.tsx',
  toast: 'packages/ui/src/app/App.tsx',
  'toggle-group': 'packages/ui/src/components/Library.tsx',
  'tool-pane': 'packages/ui/src/components/BrowserPane.tsx',
  tone: 'packages/ui/src/components/Usage.tsx',
  tooltip: 'packages/ui/src/components/Sidebar.tsx',
}

const MODULE_EXAMPLE_CONSUMER: Readonly<Record<string, string>> = {
  /* Shown on the compositions board, beside the panes it resizes. Its example
     used to be `showcase/PanelPlayground.tsx`, where coloured rectangles stood
     in for every feature — so the handle was documented against a drawing of
     the thing it drags. */
  'resize-handle': 'packages/ui/src/design/explorer/boards-compositions.tsx',
  /* The catalogue's own rail heads its groups with it. */
  'group-label': 'packages/ui/src/design/explorer/Explorer.tsx',
  badge: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  card: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  'hover-card': 'packages/ui/src/design/explorer/boards-compositions.tsx',
  input: 'packages/ui/src/design/explorer/boards.tsx',
  'radio-group': 'packages/ui/src/design/explorer/boards-compositions.tsx',
  'scroll-area': 'packages/ui/src/design/explorer/boards-compositions.tsx',
  select: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  tabs: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  textarea: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  toast: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  tooltip: 'packages/ui/src/design/explorer/boards-compositions.tsx',
}

/* Explicit and fail-closed: entries absent from this map must publish
   machine-checked variant/size/state arrays in their example source. These
   exemptions are for compound anatomy whose state is already exercised by
   the named interactive board but is not expressed as CVA axes. */
const COMPOUND_COVERAGE_EXEMPTIONS = new Set([
  'alert-dialog', 'avatar', 'avatar-stack', 'board',
  'breadcrumb', 'card', 'chart', 'checkbox', 'composer',
  'data-table', 'delta', 'dialog', 'dropdown-menu', 'empty-state', 'field', 'group-label',
  'hover-card', 'key-value', 'label', 'list-row', 'popover', 'progress',
  'radio-group', 'resize-handle', 'scroll-area', 'select', 'separator',
  'spark', 'stepper', 'table', 'toast', 'tool-pane', 'tooltip',
  'Settings', 'ModalDialog', 'ApprovalDialog', 'ConfirmDialog', 'Lightbox', 'Menu',
  'Popover', 'MessageQueue', 'ChannelMessage', 'AgentCard', 'CodeBlock', 'CopyButton', 'DockPanel', 'PublicationCard', 'ActionError', 'AppWindow', 'Change', 'RefusedAction',
  'InspectorPanel', 'ConversationEmptyState', 'GitHistory', 'TurnWork',
])

const compoundCoverageExemption = (name: string, exampleId: string): string | undefined =>
  COMPOUND_COVERAGE_EXEMPTIONS.has(name)
    ? `${name} has no detectable CVA contract; its compound anatomy and states are reviewed on the reachable ${exampleId} board.`
    : undefined

const VARIANTS: Readonly<Record<string, readonly CatalogVariant[]>> = {
  alert: ['default', 'soft'],
  'alert-dialog': ['default'],
  attachment: ['default'],
  avatar: ['default'],
  'avatar-stack': ['default'],
  badge: ['default', 'secondary', 'destructive', 'outline'],
  board: ['default'],
  breadcrumb: ['default'],
  button: ['default', 'outline', 'secondary', 'ghost', 'floating', 'destructive', 'link', 'row', 'navigation', 'choice', 'quiet', 'muted', 'warning', 'reveal', 'subtle', 'primary', 'action'],
  card: ['default', 'muted', 'flush'],
  chart: ['default'],
  checkbox: ['default'],
  commit: ['default'],
  composer: ['default'],
  'data-table': ['default'],
  delta: ['default'],
  dialog: ['default'],
  'dropdown-menu': ['default'],
  'empty-state': ['panel', 'inline', 'row'],
  field: ['default'],
  'group-label': ['default'],
  'hover-card': ['default'],
  'icon-tile': ['default'],
  input: ['default', 'quiet', 'filled', 'chrome', 'code'],
  'input-group': ['default'],
  'key-value': ['default', 'panel'],
  label: ['default'],
  'list-row': ['default'],
  marker: ['default', 'border', 'separator'],
  'native-select': ['default', 'filled'],
  popover: ['default'],
  progress: ['default', 'remaining', 'ring', 'stack'],
  'radio-group': ['vertical', 'horizontal'],
  rail: ['default'],
  'resize-handle': ['default', 'line'],
  'scroll-area': ['default'],
  section: ['card', 'plain', 'quiet', 'panel'],
  select: ['default'],
  separator: ['horizontal', 'vertical'],
  spark: ['default'],
  stat: ['plain', 'bordered', 'tinted'],
  stepper: ['default'],
  switch: ['default'],
  table: ['default', 'framed', 'panel'],
  tabs: ['default', 'line'],
  textarea: ['default', 'editor', 'inline', 'composer'],
  toast: ['default'],
  'toggle-group': ['default', 'outline'],
  'tool-pane': ['default', 'integrated'],
  tone: ['default'],
  turn: ['default'],
  tooltip: ['default'],
  Settings: ['default', 'sticky'],
  ModalDialog: ['default'],
  ApprovalDialog: ['default'],
  ConfirmDialog: ['default'],
  Lightbox: ['default'],
  Menu: ['default'],
  Popover: ['default'],
  MessageQueue: ['default'],
  ChannelMessage: ['default'],
  AgentCard: ['default'],
  CodeBlock: ['default'],
  CopyButton: ['default'],
  DockPanel: ['default', 'workbench'],
  PublicationCard: ['default'],
  ActionError: ['default'],
  AppWindow: ['default'],
  Change: ['default'],
  RefusedAction: ['default'],
  InspectorPanel: ['default'],
  ConversationEmptyState: ['default'],
  GitHistory: ['default'],
  TurnWork: ['default'],
}

const STATES: Readonly<Record<string, readonly CatalogState[]>> = {
  alert: ['default', 'success', 'warning', 'error'],
  'alert-dialog': ['closed', 'open'],
  avatar: ['default', 'loading', 'error'],
  attachment: ['default', 'loading', 'error'],
  'avatar-stack': ['default', 'populated', 'empty'],
  badge: ['default', 'active', 'inactive'],
  board: ['default', 'loading', 'empty', 'populated', 'derived'],
  breadcrumb: ['default', 'active'],
  button: ['default', 'hover', 'focus-visible', 'disabled'],
  card: ['default', 'hover', 'selected'],
  chart: ['default', 'loading', 'empty', 'populated'],
  checkbox: ['unchecked', 'checked', 'indeterminate', 'focus-visible', 'disabled'],
  commit: ['default', 'selected', 'expanded', 'collapsed'],
  composer: ['default', 'focus-visible', 'disabled', 'loading'],
  'data-table': ['loading', 'empty', 'populated', 'selected'],
  delta: ['default', 'success', 'warning', 'error'],
  dialog: ['closed', 'open'],
  'dropdown-menu': ['closed', 'open', 'selected', 'disabled'],
  'empty-state': ['empty', 'loading', 'error'],
  field: ['default', 'focus-visible', 'disabled', 'error'],
  'group-label': ['default'],
  'hover-card': ['closed', 'open'],
  'icon-tile': ['default', 'hover', 'selected'],
  input: ['default', 'focus-visible', 'disabled', 'error'],
  'input-group': ['default', 'focus-visible', 'disabled', 'error'],
  'key-value': ['default', 'empty', 'populated'],
  label: ['default', 'disabled'],
  'list-row': ['default', 'hover', 'selected', 'disabled'],
  marker: ['default', 'success', 'warning', 'error'],
  'native-select': ['closed', 'open', 'focus-visible', 'disabled'],
  popover: ['closed', 'open'],
  progress: ['default', 'success', 'warning', 'error'],
  'radio-group': ['unselected', 'selected', 'focus-visible', 'disabled'],
  rail: ['default', 'active', 'inactive', 'collapsed', 'expanded'],
  'resize-handle': ['default', 'hover', 'focus-visible', 'active'],
  'scroll-area': ['default', 'active'],
  section: ['expanded', 'collapsed'],
  select: ['closed', 'open', 'selected', 'disabled'],
  separator: ['default'],
  spark: ['default', 'success', 'warning', 'error'],
  stat: ['default', 'loading', 'error'],
  stepper: ['default', 'active', 'success', 'error'],
  switch: ['unchecked', 'checked', 'focus-visible', 'disabled'],
  table: ['default', 'loading', 'empty', 'populated'],
  tabs: ['unselected', 'selected', 'focus-visible', 'disabled'],
  textarea: ['default', 'focus-visible', 'disabled', 'error'],
  toast: ['default', 'success', 'warning', 'error'],
  'toggle-group': ['unselected', 'selected', 'focus-visible', 'disabled'],
  'tool-pane': ['default', 'loading', 'empty', 'error'],
  tone: ['default', 'success', 'warning', 'error'],
  turn: ['default', 'loading', 'success', 'error'],
  tooltip: ['closed', 'open'],
  Settings: ['default', 'loading', 'error', 'stale', 'unknown'],
  ModalDialog: ['closed', 'open'],
  ApprovalDialog: ['closed', 'open', 'loading', 'error'],
  ConfirmDialog: ['closed', 'open', 'loading', 'error'],
  Lightbox: ['closed', 'open'],
  Menu: ['closed', 'open', 'selected', 'disabled'],
  Popover: ['closed', 'open'],
  MessageQueue: ['default', 'warning', 'active'],
  DockPanel: ['expanded', 'collapsed'],
  ChannelMessage: ['default', 'loading', 'success', 'error'],
  AgentCard: ['default', 'active', 'inactive', 'loading'],
  CodeBlock: ['default', 'error'],
  CopyButton: ['default'],
  PublicationCard: ['default', 'open', 'draft', 'merged', 'closed', 'passed', 'failed', 'running', 'skipped', 'timed out'],
  ActionError: ['error'],
  AppWindow: ['default'],
  Change: ['default', 'selected', 'warning', 'error'],
  RefusedAction: ['disabled', 'focus-visible'],
  InspectorPanel: ['default', 'selected', 'empty', 'running'],
  ConversationEmptyState: ['empty'],
  GitHistory: ['default', 'selected', 'expanded'],
  TurnWork: ['default', 'expanded'],
}

const DEFAULT_SIZE = ['default'] as const
const SIZES: Record<string, readonly CatalogSize[]> = Object.fromEntries(
  Object.keys(VARIANTS).map((name) => [name, DEFAULT_SIZE]),
)
Object.assign(SIZES, {
  button: ['default', 'xs', 'sm', 'icon', 'icon-xs', 'icon-sm', 'content', 'pattern', 'chip', 'inline', 'panel', 'row', 'navigation', 'fill', 'icon-circle'],
  card: ['default', 'compact'],
  input: ['default', 'compact', 'bare'],
  attachment: ['sm', 'default', 'lg'],
  'icon-tile': ['xs', 'sm', 'default', 'lg'],
  'native-select': ['default', 'compact'],
  switch: ['default', 'sm'],
  textarea: ['default', 'compact', 'composer'],
  'toggle-group': ['default', 'sm', 'lg'],
} satisfies Partial<Record<string, readonly CatalogSize[]>>)

const PATTERN_CONSUMER: Readonly<Record<string, string>> = {
  Settings: 'packages/ui/src/components/Settings.tsx',
  ModalDialog: 'packages/ui/src/components/Settings.tsx',
  ApprovalDialog: 'packages/ui/src/components/Approvals.tsx',
  ConfirmDialog: 'packages/ui/src/components/Settings.tsx',
  Lightbox: 'packages/ui/src/components/Items.tsx',
  Menu: 'packages/ui/src/components/ComposerControls.tsx',
  Popover: 'packages/ui/src/components/ComposerControls.tsx',
  MessageQueue: 'packages/ui/src/components/MessageQueue.tsx',
  ChannelMessage: 'packages/ui/src/components/Channel.tsx',
  AgentCard: 'packages/ui/src/components/AgentCards.tsx',
  CodeBlock: 'packages/ui/src/components/Items.tsx',
  CopyButton: 'packages/ui/src/components/MessageActions.tsx',
  DockPanel: 'packages/ui/src/panels/Workbench.tsx',
  PublicationCard: 'packages/ui/src/components/Publication.tsx',
  ActionError: 'packages/ui/src/components/BranchSwitcher.tsx',
  AppWindow: 'packages/ui/src/components/AppWindow.tsx',
  Change: 'packages/ui/src/components/GitPane.tsx',
  RefusedAction: 'packages/ui/src/components/Archive.tsx',
  InspectorPanel: 'packages/ui/src/components/Panel.tsx',
  ConversationEmptyState: 'packages/ui/src/components/Conversation.tsx',
  GitHistory: 'packages/ui/src/components/GitPane.tsx',
  TurnWork: 'packages/ui/src/components/TurnWork.tsx',
}

const PATTERN_EXAMPLE_CONSUMER: Readonly<Record<string, string>> = {
  /* The workbench is the example: it is what docks, seams and expands, and the
     Panels surface mounts exactly this file. The old example was the
     playground, which drove the same model with coloured rectangles standing
     in for every feature. */
  DockPanel: 'packages/ui/src/panels/Workbench.tsx',
  ApprovalDialog: 'packages/ui/src/design/explorer/boards.tsx',
  Lightbox: 'packages/ui/src/design/explorer/boards.tsx',
  MessageQueue: 'packages/ui/src/design/explorer/boards.tsx',
  Popover: 'packages/ui/src/design/explorer/boards.tsx',
  ChannelMessage: 'packages/ui/src/design/explorer/boards.tsx',
  AgentCard: 'packages/ui/src/design/explorer/boards.tsx',
  CodeBlock: 'packages/ui/src/design/explorer/boards.tsx',
  CopyButton: 'packages/ui/src/design/explorer/boards.tsx',
  PublicationCard: 'packages/ui/src/design/explorer/boards.tsx',
  ActionError: 'packages/ui/src/design/explorer/boards.tsx',
  AppWindow: 'packages/ui/src/design/explorer/boards.tsx',
  Change: 'packages/ui/src/design/explorer/boards.tsx',
  RefusedAction: 'packages/ui/src/design/explorer/boards.tsx',
  InspectorPanel: 'packages/ui/src/design/explorer/boards-compositions.tsx',
  ConversationEmptyState: 'packages/ui/src/components/Conversation.tsx',
  GitHistory: 'packages/ui/src/components/GitPane.tsx',
  TurnWork: 'packages/ui/src/components/TurnWork.tsx',
}

const variantsFor = (name: string): readonly CatalogVariant[] => {
  const variants = VARIANTS[name]
  if (!variants) throw new Error(`Catalog variants are not declared for ${name}`)
  return variants
}
const statesFor = (name: string): readonly CatalogState[] => {
  const states = STATES[name]
  if (!states) throw new Error(`Catalog states are not declared for ${name}`)
  return states
}
const sizesFor = (name: string): readonly CatalogSize[] => {
  const sizes = SIZES[name]
  if (!sizes) throw new Error(`Catalog sizes are not declared for ${name}`)
  return sizes
}

const primitive = ([name, exampleId, purpose]: ModuleSeed): CatalogEntry => ({
  id: `primitive.${name}`,
  category: 'Primitives',
  implementationPath: `packages/ui/src/design/ui/${name}.${name === 'tone' ? 'ts' : 'tsx'}`,
  purpose,
  exampleId,
  variants: variantsFor(name),
  sizes: sizesFor(name),
  states: statesFor(name),
  examples: [MODULE_EXAMPLE_CONSUMER[name] ?? EXAMPLE_CONSUMER[exampleId] ?? 'packages/ui/src/design/explorer/Explorer.tsx'],
  consumers: PRIMITIVE_CONSUMER[name] ? [PRIMITIVE_CONSUMER[name]] : [],
  catalogOnly: !PRIMITIVE_CONSUMER[name],
  coverageExemption: compoundCoverageExemption(name, exampleId),
  visual: name !== 'tone',
})

const pattern = ([name, exampleId, purpose]: ModuleSeed): CatalogEntry => ({
  id: `pattern.${name}`,
  category: 'Patterns',
  implementationPath: `packages/ui/src/design/patterns/${name}.tsx`,
  purpose,
  exampleId,
  variants: variantsFor(name),
  sizes: sizesFor(name),
  states: statesFor(name),
  examples: [PATTERN_EXAMPLE_CONSUMER[name] ?? EXAMPLE_CONSUMER[exampleId] ?? 'packages/ui/src/design/explorer/Explorer.tsx'],
  consumers: [PATTERN_CONSUMER[name] ?? 'packages/ui/src/design/explorer/Explorer.tsx'],
  coverageExemption: compoundCoverageExemption(name, exampleId),
  visual: true,
})

export const CANONICAL_UI_MODULES = [
  ['alert', 'banner', 'Status and notification anatomy'],
  ['alert-dialog', 'dialog', 'Consequential question semantics'],
  ['avatar', 'face', 'Identity image primitive'],
  ['attachment', 'adopted', 'File attachment states'],
  ['avatar-stack', 'adopted', 'Overlapping identity group'],
  ['badge', 'badge', 'Compact categorical state'],
  ['board', 'kanban', 'Scrollable board and columns'],
  ['breadcrumb', 'adopted', 'Hierarchical location trail'],
  ['button', 'button', 'All action and icon buttons'],
  ['card', 'adopted', 'Generic grouped surface'],
  ['chart', 'chart', 'Panel-sized quantitative charts'],
  ['composer', 'composer', 'Shared composer presentation shell'],
  ['data-table', 'adopted', 'Sortable and selectable data table'],
  ['checkbox', 'adopted', 'Multiple-choice control'],
  ['dialog', 'dialog', 'Base UI dialog parts and portal policy'],
  ['delta', 'delta', 'Signed change indicator'],
  ['dropdown-menu', 'propagation', 'Base UI dropdown-menu parts'],
  ['empty-state', 'empty', 'Empty and unavailable states'],
  ['field', 'field', 'Label, help and validation anatomy'],
  ['group-label', 'section', 'The one group heading: 13px, secondary, sentence case'],
  ['hover-card', 'adopted', 'Preview-card behavior'],
  ['icon-tile', 'tile', 'Icon and mark plate'],
  ['input', 'field', 'Single-line text input'],
  ['input-group', 'adopted', 'Affixed text input'],
  ['key-value', 'readings', 'Measured fact rows'],
  ['label', 'field', 'Native form label'],
  ['list-row', 'list', 'Generic selectable list row'],
  ['marker', 'adopted', 'Status marker'],
  ['native-select', 'control', 'Native finite-choice select'],
  ['popover', 'propagation', 'Base UI anchored popup parts'],
  ['progress', 'readings', 'Progress and usage meter'],
  ['radio-group', 'control', 'Single-choice radio behavior'],
  ['resize-handle', 'panels', 'Keyboard-accessible resize seam'],
  ['scroll-area', 'adopted', 'Themed scroll container'],
  ['section', 'section', 'Titled content region'],
  ['select', 'adopted', 'Custom Base UI select'],
  ['separator', 'adopted', 'Semantic divider'],
  ['spark', 'spark', 'Inline quantitative marks'],
  ['stat', 'stat', 'Primary reading tile'],
  ['stepper', 'stepper', 'Ordered progress steps'],
  ['switch', 'control', 'Immediate boolean control'],
  ['table', 'adopted', 'Table anatomy'],
  ['tabs', 'badge', 'Roving-focus tab set'],
  ['textarea', 'field', 'Multiline text input'],
  ['toast', 'banner', 'Transient notification host'],
  ['toggle-group', 'control', 'Segmented and multi-toggle behavior'],
  ['tool-pane', 'tool-pane', 'Shared tool-pane chrome'],
  ['tone', 'foundation', 'Typed semantic tone mapping'],
  ['tooltip', 'adopted', 'Accessible hover and focus help'],
] as const satisfies readonly ModuleSeed[]

export const CANONICAL_PATTERN_MODULES = [
  ['Settings', 'row', 'Settings pages, sections, rows and form layouts'],
  ['ModalDialog', 'dialog', 'Application reading and form dialog'],
  ['ApprovalDialog', 'conversation', 'Pane-local consequential approval policy'],
  ['ConfirmDialog', 'dialog', 'Safe confirmation policy'],
  ['Lightbox', 'dialog', 'Full-window image gallery and modal policy'],
  ['Menu', 'propagation', 'Menu, context menu and submenu policy'],
  ['Popover', 'propagation', 'HarnessDesk anchored action popover'],
  ['MessageQueue', 'queue', 'Queued-message frame, rows and timing states'],
  ['ChannelMessage', 'channel', 'Room and channel message anatomy'],
  ['AgentCard', 'group', 'Agent, account and member card anatomy'],
  ['CodeBlock', 'code', 'Verbatim command and output plate'],
  ['CopyButton', 'code', 'The one copy control'],
  ['DockPanel', 'panels', 'Docked panel chrome and actions'],
  ['PublicationCard', 'conversation', 'Published plan and artifact card'],
  ['ActionError', 'banner', 'Failure and reason for an action just taken'],
  ['AppWindow', 'app-window', 'Full-window destination chrome and plates'],
  ['Change', 'git', 'File state, change counts and patch anatomy'],
  ['RefusedAction', 'propagation', 'Keyboard-reachable disabled-action explanation'],
  ['InspectorPanel', 'tool-pane', 'Right-hand inspector anatomy'],
  ['ConversationEmptyState', 'conversation', 'Conversation empty-state anatomy'],
  ['GitHistory', 'git', 'Repository history controls and detail anatomy'],
  ['TurnWork', 'conversation', 'Turn work header and disclosure anatomy'],
] as const satisfies readonly ModuleSeed[]

/**
 * The whole-screen entries, and the module each one actually mounts.
 *
 * `implementationPath` is the promise this row makes to a reader: open the
 * surface and you are looking at that file. Most of these used to name a page
 * in `design/showcase` that was built to look like the screen — same shapes,
 * separate code — so the promise was kept only for as long as nobody edited
 * the real one. Every row but one now names the shipped module, and
 * `script/check-ui-system.mjs` holds it three ways: the row's own export in
 * `surfaces.tsx` (the last field) must reach the module, the explorer tab for
 * the row must load that exact export, and the app must ship the module (the
 * field before names the file in the app that mounts it).
 *
 * The one exception is the propagation page, which is a test rig rather than
 * a screen — built only from production implementations, driven by two
 * browser specs, and with no shipped screen to point at. `catalogOnly` marks
 * it, and it is the exemption the check looks for.
 */
export const PRODUCT_SURFACES = [
  ['surface.dashboard', 'dashboard', 'Plan usage, cost and limits', 'packages/ui/src/components/Usage.tsx', false, 'packages/ui/src/app/App.tsx', 'DashboardSurface'],
  ['surface.group', 'group', 'Room, board and agent collaboration', 'packages/ui/src/components/TeamBoardPane.tsx', false, 'packages/ui/src/panels/builtins.tsx', 'GroupSurface'],
  ['surface.conversation', 'conversation', 'Complete transcript and approval', 'packages/ui/src/components/Conversation.tsx', false, 'packages/ui/src/panels/builtins.tsx', 'ConversationSurface'],
  ['surface.composer', 'composer', 'Composer states and overflow', 'packages/ui/src/components/Composer.tsx', false, 'packages/ui/src/components/Conversation.tsx', 'ComposerSurface'],
  ['surface.rail', 'rail', 'Sidebar and navigation rows', 'packages/ui/src/components/Sidebar.tsx', false, 'packages/ui/src/app/App.tsx', 'RailSurface'],
  ['surface.git', 'git', 'Repository history and detail', 'packages/ui/src/components/GitPane.tsx', false, 'packages/ui/src/panels/builtins.tsx', 'GitSurface'],
  ['surface.panels', 'panels', 'Dock, split, collapse and resize', 'packages/ui/src/panels/Workbench.tsx', false, 'packages/ui/src/app/App.tsx', 'PanelsSurface'],
  ['surface.propagation', 'propagation', 'Cross-surface foundation propagation', 'packages/ui/src/design/showcase/PropagationPage.tsx', true],
  ['surface.tools', 'tools', 'Browser, terminal and editor chrome', 'packages/ui/src/components/BrowserPane.tsx', false, 'packages/ui/src/panels/builtins.tsx', 'ToolsSurface'],
] as const

export const CATALOG_ENTRIES: readonly CatalogEntry[] = [
  {
    id: 'foundation.tokens',
    category: 'Foundation',
    implementationPath: 'packages/ui/src/design/foundation/tokens.css',
    purpose: 'The authoritative structured CSS token source',
    exampleId: 'foundation',
    variants: ['light', 'dark'] as const,
    sizes: ['default'] as const,
    states: ['default'] as const,
    examples: ['packages/ui/src/design/explorer/main.tsx'],
    consumers: ['packages/ui/src/main.tsx'],
    coverageExemption: 'Foundation presets are verified through computed token propagation, not component CVA axes.',
    visual: true,
  },
  ...CANONICAL_UI_MODULES.map(primitive),
  ...CANONICAL_PATTERN_MODULES.map(pattern),
  ...PRODUCT_SURFACES.map(([id, exampleId, purpose, implementationPath, catalogOnly, consumer, surface]): CatalogEntry => ({
    id,
    category: 'Product Surfaces' as const,
    implementationPath,
    purpose,
    exampleId,
    variants: ['light', 'dark'] as const,
    sizes: ['default'] as const,
    states: ['default', 'loading', 'empty', 'populated', 'error'] as const,
    /* The one export that mounts this row's screen, not the file that holds
       every surface: walked from the file, any row was satisfied by a sibling
       that happened to mount the same screen (#762 review). The explorer tab
       for `exampleId` has to load this exact export, too — see
       `script/ui-catalog.mjs`. */
    examples: [surface ? `packages/ui/src/design/surfaces/surfaces.tsx#${surface}` : 'packages/ui/src/design/explorer/Explorer.tsx'],
    // A surface that mounts a shipped screen names the file that mounts it in
    // the app — the panel registry, or the screen that owns it. `main.tsx` was
    // the obvious guess and the wrong one: panels are registered through a
    // table, so nothing reaches a pane from the entry by import. Only the
    // three assembled for the catalogue have no consumer at all.
    consumers: consumer ? [consumer] : [],
    catalogOnly,
    coverageExemption: `${id} has no component CVA contract; the ${exampleId} surface matrix is reviewed by browser and native scenario suites.`,
    visual: true,
  })),
  {
    id: 'boundary.specialized-renderers',
    category: 'Boundary',
    implementationPath: 'packages/ui/src/styles/editor.css',
    purpose: 'CodeMirror, xterm, browser and external-document bridges; only first-party chrome is themed',
    exampleId: 'tools',
    variants: ['light', 'dark'] as const,
    sizes: ['default'] as const,
    states: ['default', 'loading', 'error'] as const,
    examples: ['packages/ui/src/design/explorer/main.tsx'],
    consumers: ['packages/ui/src/main.tsx'],
    coverageExemption: 'The tools board verifies specialized renderer states through adapter option and computed-style assertions.',
    visual: true,
  },
  {
    id: 'boundary.native-desktop',
    category: 'Boundary',
    implementationPath: 'packages/desktop/electron/main.mjs',
    purpose: 'OS-rendered menus, pickers, traffic lights and auxiliary native surfaces',
    exampleId: 'coverage',
    variants: ['light', 'dark'] as const,
    sizes: ['default'] as const,
    states: ['default', 'active', 'inactive'] as const,
    examples: ['packages/desktop/electron/main.mjs'],
    consumers: ['packages/desktop/electron/main.mjs'],
    visual: false,
  },
]
