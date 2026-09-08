import { join, resolve } from 'node:path'

import type { LibraryKind } from '@harnessdesk/protocol'

/**
 * Where each agent keeps things — the one table the scanner and the write
 * path share, so a directory can never be scanned under one spelling and
 * written under another.
 *
 * Every `scanned: true` entry was checked against the build installed on this
 * machine on 2026-08-28 by reading the shipped binary for the path. Every
 * `scanned: false` entry is a directory the agent knows about but does not
 * load from. Adding a row without checking is how this table starts lying.
 */

/**
 * `~/x` is how the table writes a user-scope path, and it does not resolve
 * itself. `home` is a parameter rather than a module constant so the tests
 * can point a whole scan at a temporary directory — a scanner that can only
 * be run against the developer's own machine is one nobody can test.
 */
export const expand = (path: string, home: string): string =>
  path.startsWith('~/') ? join(home, path.slice(2)) : path

/**
 * Where one runtime keeps one kind of thing.
 *
 * Keyed by `RuntimePresentation.brand` rather than runtime id, because the id
 * of an ACP agent is whatever the user's registry called it while the brand is
 * the stable name of the software.
 */
export interface BrandLocations {
  /** Directories holding one bundle each, or a flat definition file. */
  readonly skills: readonly LocationSpec[]
  /** Files carrying MCP server declarations. */
  readonly mcp: readonly McpFileSpec[]
}

export interface LocationSpec {
  readonly path: string
  readonly scope: 'user' | 'project'
  /** False for a directory this agent imports from rather than loads. */
  readonly scanned: boolean
  /** Shipped by the agent: listed, never a write target. */
  readonly readOnly?: boolean
}

export interface McpFileSpec {
  readonly path: string
  readonly scope: 'user' | 'project'
  /** Where in the parsed file the servers live. */
  readonly key: string
  readonly format: 'json' | 'toml'
  readonly scanned: boolean
}

const BRANDED: Readonly<Record<string, BrandLocations>> = {
  claudecode: {
    skills: [
      { path: '~/.claude/skills', scope: 'user', scanned: true },
      { path: '.claude/skills', scope: 'project', scanned: true },
      // Measured: no reference to `.agents/skills` anywhere in 2.1.240.
      { path: '~/.agents/skills', scope: 'user', scanned: false },
    ],
    mcp: [
      { path: '~/.claude.json', scope: 'user', key: 'mcpServers', format: 'json', scanned: true },
      { path: '.mcp.json', scope: 'project', key: 'mcpServers', format: 'json', scanned: true },
    ],
  },
  codex: {
    skills: [
      { path: '~/.codex/skills', scope: 'user', scanned: true },
      {
        path: '~/.codex/skills/.system',
        scope: 'user',
        scanned: true,
        readOnly: true,
      },
      { path: '.codex/skills', scope: 'project', scanned: true },
      // Loaded. Re-measured 2026-09-06 by asking a real 0.149.0 app-server
      // `skills/list` against a temporary `$HOME`: it answered with the
      // skills in `~/.agents/skills`, each carrying its own path there. The
      // row said `scanned: false` on the strength of reading the binary for
      // the string, which found it only in the external-agent migration — a
      // grep is not a measurement, and this is the one row where being wrong
      // is silent: the reach cell is right anyway (Codex *reported* it), so
      // the page went on saying "no agent reads this directory" underneath a
      // copy the agent above it was demonstrably loading.
      { path: '~/.agents/skills', scope: 'user', scanned: true },
    ],
    mcp: [
      {
        path: '~/.codex/config.toml',
        scope: 'user',
        key: 'mcp_servers',
        format: 'toml',
        scanned: true,
      },
    ],
  },
  cursor: {
    skills: [
      { path: '~/.cursor/skills', scope: 'user', scanned: true },
      { path: '~/.cursor/skills-cursor', scope: 'user', scanned: true, readOnly: true },
      { path: '.cursor/skills', scope: 'project', scanned: true },
      // Its single reference sits in a literal list of foreign directories.
      { path: '~/.agents/skills', scope: 'user', scanned: false },
    ],
    mcp: [
      { path: '~/.cursor/mcp.json', scope: 'user', key: 'mcpServers', format: 'json', scanned: true },
      { path: '.cursor/mcp.json', scope: 'project', key: 'mcpServers', format: 'json', scanned: true },
    ],
  },
  geminicli: {
    skills: [
      { path: '~/.gemini/skills', scope: 'user', scanned: true },
      { path: '.gemini/skills', scope: 'project', scanned: true },
      // 40 references to its own directory, none to the shared one.
      { path: '~/.agents/skills', scope: 'user', scanned: false },
    ],
    mcp: [
      {
        path: '~/.gemini/settings.json',
        scope: 'user',
        key: 'mcpServers',
        format: 'json',
        scanned: true,
      },
    ],
  },
  deepseek: {
    skills: [
      { path: '~/.dsh/skills', scope: 'user', scanned: true },
      { path: '.dsh/skills', scope: 'project', scanned: true },
      { path: '~/.agents/skills', scope: 'user', scanned: false },
    ],
    mcp: [],
  },
}

/**
 * The table, answering also to the names a brand-less runtime guesses at.
 *
 * A caller whose runtime declares no `brand` falls back to the display name,
 * lowercased and squeezed — "DeepSeek Harness" arrives as `deepseekharness`,
 * "Cursor Agent" as `cursoragent`. Refusing those spellings does not make the
 * caller honest, it makes the whole column table-less and the failure a
 * footnote (which is exactly how it shipped, and how it was found). Aliases
 * are the same objects, not copies: one table, several names.
 */
export const LOCATIONS: Readonly<Record<string, BrandLocations>> = {
  ...BRANDED,
  ...(BRANDED['deepseek'] ? { deepseekharness: BRANDED['deepseek'] } : {}),
  ...(BRANDED['cursor'] ? { cursoragent: BRANDED['cursor'] } : {}),
  ...(BRANDED['claudecode'] ? { claude: BRANDED['claudecode'] } : {}),
  ...(BRANDED['codex'] ? { openaicodex: BRANDED['codex'] } : {}),
  ...(BRANDED['geminicli'] ? { gemini: BRANDED['geminicli'] } : {}),
}

/** Every directory any agent might keep skills in, whether it loads them or not. */
export const extraSkillRoots: readonly LocationSpec[] = [
  { path: '~/.agents/skills', scope: 'user', scanned: false },
  { path: '.agents/skills', scope: 'project', scanned: false },
]

/** A location's absolute path, or null for a project path with no project. */
export const locate = (
  spec: { readonly path: string; readonly scope: 'user' | 'project' },
  home: string,
  cwd: string | undefined,
): string | null =>
  spec.scope === 'project' ? (cwd ? resolve(cwd, spec.path) : null) : expand(spec.path, home)

/**
 * Where an install for this brand writes: the agent's own user-scope
 * directory, the first one its build is measured to scan and nobody
 * write-protects. Null is an answer — a brand this table does not know
 * cannot honestly be written for.
 */
export const skillWriteRoot = (brand: string, home: string): string | null => {
  const spec = LOCATIONS[brand]?.skills.find(
    (one) => one.scanned && one.readOnly !== true && one.scope === 'user',
  )
  return spec ? expand(spec.path, home) : null
}

/** The configuration file an MCP install for this brand writes, when one is known. */
export const mcpWriteTarget = (brand: string, home: string): (McpFileSpec & { readonly resolved: string }) | null => {
  const spec = LOCATIONS[brand]?.mcp.find((one) => one.scanned && one.scope === 'user')
  return spec ? { ...spec, resolved: expand(spec.path, home) } : null
}

/**
 * The universe of paths the write path may touch, resolved. Everything apply
 * does is checked against this: a path outside it is refused whatever the
 * plan said, because the plan crossed a socket.
 */
export const knownRoots = (
  kind: LibraryKind,
  home: string,
  cwd: string | undefined,
): readonly string[] => {
  const out = new Set<string>()
  for (const table of Object.values(LOCATIONS)) {
    for (const spec of kind === 'skill' ? table.skills : []) {
      const path = locate(spec, home, cwd)
      if (path !== null) out.add(path)
    }
    for (const spec of kind === 'mcp' ? table.mcp : []) {
      const path = locate(spec, home, cwd)
      if (path !== null) out.add(path)
    }
  }
  if (kind === 'skill') {
    for (const spec of extraSkillRoots) {
      const path = locate(spec, home, cwd)
      if (path !== null) out.add(path)
    }
  }
  return [...out]
}

/**
 * Whether `path` is one of `roots` or inside one of them.
 *
 * `path` is resolved first: a `..` segment must not let a value that reads as
 * inside a root (`…/skills/../../.ssh`) escape it. This is the only
 * containment check the apply path has, and its inputs cross the socket, so a
 * lexical prefix test on the raw string would be a hole. The roots are already
 * absolute; resolving them too keeps the comparison honest on either side.
 */
export const insideRoots = (path: string, roots: readonly string[]): boolean => {
  const target = resolve(path)
  return roots.some((raw) => {
    const root = resolve(raw)
    return target === root || target.startsWith(`${root}/`)
  })
}

/**
 * Whether writing at `path` would land in a root some agent ships and
 * write-protects. Checked at plan *and* apply: the plan is advice, the
 * refusal is the host's.
 */
export const insideReadOnlyRoot = (path: string, home: string, cwd: string | undefined): boolean => {
  const target = resolve(path)
  for (const table of Object.values(LOCATIONS)) {
    for (const spec of table.skills) {
      if (spec.readOnly !== true) continue
      const root = locate(spec, home, cwd)
      if (root !== null && (target === resolve(root) || target.startsWith(`${resolve(root)}/`))) {
        return true
      }
    }
  }
  return false
}
