/**
 * Every `components/` and `panels/` file's own exports, indexed by the file
 * they came from — built with Vite's `import.meta.glob` (eager, so this
 * module already holds the resolved values, not loaders) rather than by
 * parsing source text for `export const Name`.
 *
 * `preview-coverage.spec.ts` imports this once per page load and matches a
 * mounted fiber's own `type` against these exact references, not against a
 * bare name a fiber walk can only read as a string. A name collides the
 * moment two files export the same identifier — `GitDialogs.tsx`'s own local
 * `ConfirmDialog` next to the design system's `ConfirmDialog`, or
 * `ToolPaneHeader`, `ActivityView`, `AgentRow`, `CodeEditor`, each defined
 * twice under different files for different reasons — and a name match
 * cannot tell which one a screen actually rendered. A reference can: this
 * page's `import()` of a file resolves to the very same module instance
 * already sitting in the fiber tree Vite built for it, so `===` settles what
 * a string never could.
 *
 * The glob's `**` reaches into a subdirectory the way `readdirSync` alone did
 * not — `components/usage/*.tsx` is covered by the same registry as
 * `components/*.tsx` — and eager evaluation reads a module's actual export
 * object, so `export { Counts, PanelBody } from '../design'` (`Panel.tsx`)
 * counts exactly as `export const Counts = …` would: both are properties on
 * the same object this file iterates with `Object.entries`.
 */

type ModuleNamespace = Readonly<Record<string, unknown>>

export interface CoverageEntry {
  readonly file: string
  readonly exports: ModuleNamespace
}

const relativeFile = (fullPath: string, dir: string): string => {
  const marker = `/${dir}/`
  const at = fullPath.lastIndexOf(marker)
  return `${dir}/${fullPath.slice(at + marker.length)}`
}

const buildEntries = (modules: Record<string, ModuleNamespace>, dir: string): readonly CoverageEntry[] =>
  Object.entries(modules).map(([file, exports]) => ({ file: relativeFile(file, dir), exports }))

// The `!…test.tsx` exclusion has to sit in the glob itself, not in a filter
// applied after: `eager: true` imports every *matched* module right away, so
// a test file merely filtered out afterward has already run — and a
// `.test.tsx` calls `beforeEach`/`describe` at its own top level, which
// throws outside a Vitest runner (this page has none).
const componentModules = import.meta.glob(['../components/**/*.tsx', '!../components/**/*.test.tsx'], {
  eager: true,
}) as Record<string, ModuleNamespace>
const panelModules = import.meta.glob(['../panels/*.tsx', '!../panels/*.test.tsx'], { eager: true }) as Record<
  string,
  ModuleNamespace
>

export const coverageRegistry: readonly CoverageEntry[] = [
  ...buildEntries(componentModules, 'components'),
  ...buildEntries(panelModules, 'panels'),
]
