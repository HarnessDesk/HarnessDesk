import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { shortPath } from '@harnessdesk/protocol'
import type {
  LibraryIntent,
  LibraryKind,
  LibraryOpResult,
  LibraryPlan,
  LibraryPlannedOp,
  RuntimeId,
} from '@harnessdesk/protocol'

import { digestOf } from './digest.js'
import { unifiedDiff } from './diff.js'
import {
  insideReadOnlyRoot,
  insideRoots,
  knownRoots,
  LOCATIONS,
  locate,
  mcpWriteTarget,
  skillWriteRoot,
} from './locations.js'
import { LibraryManifest } from './manifest.js'
import {
  applyMcpEdit,
  canHostMcp,
  canonicalMcp,
  decodeMcpEntry,
  decodeRawMcpEntry,
  dialectFor,
  encodeJsonEntry,
  encodeTomlBlock,
  readRawMcpEntry,
  type McpDialect,
  type McpServerSpec,
} from './mcp.js'

/**
 * The write path: plan, then apply — never one call that does both.
 *
 * `planLibrary` turns intents into concrete operations and touches nothing.
 * Every operation carries the exact content it would write, a unified diff
 * of the change, and a digest of the target as the plan found it.
 *
 * `applyLibrary` takes those operations back and performs them one at a
 * time, each with its own result — one failure never aborts the rest. It
 * trusts nothing the plan says about safety: the target must sit inside a
 * directory the location table knows, must not sit in a root an agent
 * ships read-only, and must still digest to what the plan saw. The plan
 * crossed a socket; the checks did not.
 *
 * The overwrite rule both halves enforce: a copy the manifest vouches for
 * (path and digest both match) is ours to update or remove. Anything else
 * is replaced only by an operation that says `replace` and carries
 * `backup: true` — and installs never produce one; only the explicit
 * resolve and remove flows do.
 */

export interface WriteAgent {
  readonly id: RuntimeId
  readonly brand: string
}

export interface WriteContext {
  /** Where the manifest and backups live — the host's own state directory. */
  readonly libraryDir: string
  readonly home?: string
  readonly cwd?: string
}

/** Caps on what an install will carry: past these, a bundle is a project. */
const MAX_BUNDLE_FILES = 200
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024

/** A name is a path segment. Anything that is not one segment is an attack. */
const validName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 128 &&
  name !== '.' &&
  name !== '..' &&
  !name.includes('/') &&
  !name.includes('\\') &&
  !name.includes('\0')

interface Definition {
  /** The bundle directory or the flat file itself. */
  readonly container: string
  readonly flat: boolean
  readonly text: string
}

/** Read a copy's definition wherever its spelling put it. */
const readDefinition = (path: string): Definition | null => {
  try {
    const stats = statSync(path)
    if (stats.isDirectory()) {
      const text = readFileSync(join(path, 'SKILL.md'), 'utf8')
      return { container: path, flat: false, text }
    }
    if (stats.isFile()) {
      return { container: path, flat: true, text: readFileSync(path, 'utf8') }
    }
  } catch {
    return null
  }
  return null
}

/** Everything in a bundle beyond the definition, relative, size-capped. */
const bundleExtras = (
  root: string,
): { readonly files: readonly string[] } | { readonly refused: string } => {
  const files: string[] = []
  let bytes = 0
  const walk = (dir: string, prefix: string): string | null => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return null
    }
    for (const name of names) {
      const relative = prefix === '' ? name : `${prefix}/${name}`
      if (relative === 'SKILL.md') continue
      const path = join(dir, name)
      let stats
      try {
        // lstat, not stat: stat resolves the link and reports the target, so a
        // symlink would read as a plain file and get copied — carrying
        // `creds -> ~/.aws/credentials` out of a bundle, or looping forever on
        // a cycle. lstat sees the link itself, and the guard below drops it.
        stats = lstatSync(path)
      } catch {
        continue
      }
      if (stats.isSymbolicLink()) continue
      if (stats.isDirectory()) {
        const failed = walk(path, relative)
        if (failed !== null) return failed
        continue
      }
      files.push(relative)
      bytes += stats.size
      if (files.length > MAX_BUNDLE_FILES) {
        return `The bundle holds more than ${MAX_BUNDLE_FILES} files — too large to carry as a skill.`
      }
      if (bytes > MAX_BUNDLE_BYTES) {
        return `The bundle holds more than ${Math.round(MAX_BUNDLE_BYTES / 1024 / 1024)} MB — too large to carry as a skill.`
      }
    }
    return null
  }
  const refused = walk(root, '')
  return refused !== null ? { refused } : { files: files.sort() }
}

/** Whether a directory exists and holds anything at all. */
const dirHasEntries = (path: string): boolean => {
  try {
    return readdirSync(path).length > 0
  } catch {
    return false
  }
}

interface PlanState {
  readonly agents: readonly WriteAgent[]
  readonly manifest: LibraryManifest
  readonly home: string
  readonly cwd: string | undefined
  readonly ops: LibraryPlannedOp[]
  counter: number
}

const push = (state: PlanState, op: Omit<LibraryPlannedOp, 'id'>): void => {
  state.counter += 1
  state.ops.push({ id: `op-${state.counter}`, ...op })
}

const refuse = (
  state: PlanState,
  kind: LibraryKind,
  name: string,
  targetPath: string,
  reason: string,
  targetRuntime?: RuntimeId,
): void =>
  push(state, {
    kind,
    name,
    action: 'refuse',
    targetPath,
    reason,
    guardDigest: null,
    backup: false,
    ...(targetRuntime !== undefined ? { targetRuntime } : {}),
  })

const brandOf = (state: PlanState, runtime: RuntimeId): string | null =>
  state.agents.find((agent) => agent.id === runtime)?.brand ?? null

/**
 * Ownership of an existing definition, in the manifest's terms.
 *
 * `ours` — we wrote it and nobody has touched it since. `edited` — we wrote
 * it and someone changed it. `foreign` — the manifest never saw it, so it
 * belongs to whoever put it there.
 */
const ownership = (
  manifest: LibraryManifest,
  kind: LibraryKind,
  path: string,
  name: string,
  currentDigest: string,
): 'ours' | 'edited' | 'foreign' => {
  const entry = manifest.find(kind, path, name)
  if (!entry) return 'foreign'
  return entry.digest === currentDigest ? 'ours' : 'edited'
}

const planInstallSkill = (
  state: PlanState,
  intent: { name: string; sourcePath: string; targetRuntime: RuntimeId },
  content?: string,
  extras?: { files: readonly string[]; sourcePath: string },
): void => {
  const { name, targetRuntime } = intent
  const brand = brandOf(state, targetRuntime)
  if (brand === null) {
    refuse(state, 'skill', name, '', 'This agent is not on the roster any more.', targetRuntime)
    return
  }
  const root = skillWriteRoot(brand, state.home)
  if (root === null) {
    refuse(
      state,
      'skill',
      name,
      '',
      'No directory this agent is measured to scan is known, so nothing can be installed for it.',
      targetRuntime,
    )
    return
  }

  let text = content
  let files: readonly string[] = extras?.files ?? []
  let sourcePath = extras?.sourcePath
  if (text === undefined) {
    const skillRoots = knownRoots('skill', state.home, state.cwd)
    if (!insideRoots(intent.sourcePath, skillRoots)) {
      refuse(state, 'skill', name, '', 'The source is not in any directory this library reads.', targetRuntime)
      return
    }
    const source = readDefinition(intent.sourcePath)
    if (source === null) {
      refuse(state, 'skill', name, '', 'The source copy has no definition to install.', targetRuntime)
      return
    }
    text = source.text
    if (!source.flat) {
      const walked = bundleExtras(source.container)
      if ('refused' in walked) {
        refuse(state, 'skill', name, '', walked.refused, targetRuntime)
        return
      }
      files = walked.files
      sourcePath = source.container
    }
  }

  const bundleTarget = join(root, name)
  const flatTarget = join(root, `${name}.md`)
  if (intent.sourcePath === bundleTarget || intent.sourcePath === flatTarget) {
    push(state, {
      kind: 'skill',
      name,
      action: 'skip',
      targetPath: bundleTarget,
      targetRuntime,
      reason: 'This copy already is the one this agent reads.',
      guardDigest: null,
      backup: false,
    })
    return
  }

  const existing = readDefinition(bundleTarget) ?? readDefinition(flatTarget)
  const hollow = existing === null && existsSync(bundleTarget)
  const targetPath = existing?.container ?? bundleTarget
  const label = shortPath(existing?.flat === true ? targetPath : join(targetPath, 'SKILL.md'), state.home)

  if (insideReadOnlyRoot(targetPath, state.home, state.cwd)) {
    refuse(state, 'skill', name, targetPath, 'This directory is shipped by the agent and is not written to.', targetRuntime)
    return
  }

  if (existing !== null) {
    const current = digestOf(existing.text)
    if (current === digestOf(text)) {
      push(state, {
        kind: 'skill',
        name,
        action: 'skip',
        targetPath,
        targetRuntime,
        reason: 'Already present, and identical.',
        guardDigest: current,
        backup: false,
      })
      return
    }
    const who = ownership(state.manifest, 'skill', targetPath, name, current)
    if (who !== 'ours') {
      refuse(
        state,
        'skill',
        name,
        targetPath,
        who === 'edited'
          ? 'HarnessDesk installed this copy, but it has been edited since — resolve the copies from the row instead of overwriting the edit.'
          : 'A different copy already sits here, and it was not written by HarnessDesk — resolve the copies from the row instead.',
        targetRuntime,
      )
      return
    }
    push(state, {
      kind: 'skill',
      name,
      action: 'update',
      targetPath,
      targetRuntime,
      preview: unifiedDiff(existing.text, text, { fromLabel: label, toLabel: label }),
      guardDigest: current,
      backup: false,
      content: text,
      ...(existing.flat ? { flat: true } : {}),
      ...(files.length > 0 ? { extraFiles: files } : {}),
      ...(sourcePath !== undefined ? { sourcePath } : {}),
    })
    return
  }

  push(state, {
    kind: 'skill',
    name,
    action: hollow ? 'replace' : 'create',
    targetPath: bundleTarget,
    targetRuntime,
    preview: unifiedDiff('', text, {
      fromLabel: '/dev/null',
      toLabel: shortPath(join(bundleTarget, 'SKILL.md'), state.home),
    }),
    guardDigest: null,
    backup: hollow && dirHasEntries(bundleTarget),
    ...(hollow ? { reason: 'An empty directory of this name sits here; it is backed up and replaced.' } : {}),
    content: text,
    ...(files.length > 0 ? { extraFiles: files } : {}),
    ...(sourcePath !== undefined ? { sourcePath } : {}),
  })
}

const planSyncSkill = (
  state: PlanState,
  intent: { name: string; sourcePath: string; targetPaths: readonly string[] },
): void => {
  const { name } = intent
  const skillRoots = knownRoots('skill', state.home, state.cwd)
  if (!insideRoots(intent.sourcePath, skillRoots)) {
    refuse(state, 'skill', name, '', 'The winning copy is not in any directory this library reads.')
    return
  }
  const source = readDefinition(intent.sourcePath)
  if (source === null) {
    refuse(state, 'skill', name, '', 'The winning copy has no definition to copy from.')
    return
  }
  // The winner's supporting files travel with it. Without this a bundle skill
  // is "synced" by deleting the loser's directory and writing back only
  // SKILL.md — its scripts and references gone, and the definition left
  // pointing at files that no longer exist.
  let files: readonly string[] = []
  let extrasFrom: string | undefined
  if (!source.flat) {
    const walked = bundleExtras(source.container)
    if ('refused' in walked) {
      refuse(state, 'skill', name, '', walked.refused)
      return
    }
    files = walked.files
    extrasFrom = source.container
  }
  for (const targetPath of intent.targetPaths) {
    if (targetPath === intent.sourcePath) continue
    if (!insideRoots(targetPath, skillRoots)) {
      refuse(state, 'skill', name, targetPath, 'Not in any directory this library reads.')
      continue
    }
    if (insideReadOnlyRoot(targetPath, state.home, state.cwd)) {
      refuse(state, 'skill', name, targetPath, 'This directory is shipped by the agent and is not written to.')
      continue
    }
    const existing = readDefinition(targetPath)
    if (existing === null && !existsSync(targetPath)) {
      refuse(state, 'skill', name, targetPath, 'There is no copy here to bring into line.')
      continue
    }
    const current = existing === null ? null : digestOf(existing.text)
    if (current !== null && current === digestOf(source.text)) {
      push(state, {
        kind: 'skill',
        name,
        action: 'skip',
        targetPath,
        reason: 'Already identical to the winning copy.',
        guardDigest: current,
        backup: false,
      })
      continue
    }
    const who = current === null ? 'foreign' : ownership(state.manifest, 'skill', targetPath, name, current)
    const targetIsFlat = existing?.flat === true
    const label = shortPath(targetIsFlat ? targetPath : join(targetPath, 'SKILL.md'), state.home)
    push(state, {
      kind: 'skill',
      name,
      action: who === 'ours' ? 'update' : 'replace',
      targetPath,
      preview: unifiedDiff(existing?.text ?? '', source.text, { fromLabel: label, toLabel: label }),
      guardDigest: current,
      backup: who !== 'ours',
      ...(who === 'foreign'
        ? { reason: 'Not written by HarnessDesk — a backup of this copy is kept.' }
        : who === 'edited'
          ? { reason: 'Edited since HarnessDesk wrote it — a backup of the edit is kept.' }
          : {}),
      content: source.text,
      // The winner's supporting files travel with it into a bundle target — the
      // path that was silently losing them. A flat `.md` target cannot hold
      // extras and stays as it is (converting it to a bundle is a separate,
      // path-changing operation).
      ...(targetIsFlat ? { flat: true } : {}),
      ...(!targetIsFlat && files.length > 0 ? { extraFiles: files } : {}),
      ...(!targetIsFlat && extrasFrom !== undefined ? { sourcePath: extrasFrom } : {}),
    })
  }
}

const planRemoveCopy = (state: PlanState, intent: { name: string; path: string }): void => {
  const { name, path } = intent
  const skillRoots = knownRoots('skill', state.home, state.cwd)
  if (!insideRoots(path, skillRoots)) {
    refuse(state, 'skill', name, path, 'Not in any directory this library reads.')
    return
  }
  if (insideReadOnlyRoot(path, state.home, state.cwd)) {
    refuse(state, 'skill', name, path, 'This directory is shipped by the agent and is not written to.')
    return
  }
  const existing = readDefinition(path)
  if (existing === null && !existsSync(path)) {
    push(state, {
      kind: 'skill',
      name,
      action: 'skip',
      targetPath: path,
      reason: 'Already gone.',
      guardDigest: null,
      backup: false,
    })
    return
  }
  const current = existing === null ? null : digestOf(existing.text)
  const who = current === null ? 'foreign' : ownership(state.manifest, 'skill', path, name, current)
  const hollow = existing === null
  push(state, {
    kind: 'skill',
    name,
    action: 'remove',
    targetPath: path,
    ...(existing !== null
      ? {
          preview: unifiedDiff(existing.text, '', {
            fromLabel: shortPath(existing.flat ? path : join(path, 'SKILL.md'), state.home),
            toLabel: '/dev/null',
          }),
        }
      : {}),
    reason: hollow
      ? dirHasEntries(path)
        ? 'A directory with no definition inside — its files are backed up before it goes.'
        : 'An empty directory with no definition inside.'
      : who === 'ours'
        ? 'Installed by HarnessDesk; a backup is kept anyway.'
        : 'Not written by HarnessDesk — a backup of this copy is kept.',
    guardDigest: current,
    backup: hollow ? dirHasEntries(path) : true,
    ...(existing?.flat === true ? { flat: true } : {}),
  })
}

/**
 * A restore: the backup becomes the copy again.
 *
 * The backup's shape says what it was — a directory or bare file is a skill
 * copy, a `.txt` is one MCP declaration with its home on the first line. In
 * both cases whatever sits at the target *now* is backed up in turn before
 * being replaced, so restoring can never be the operation that loses data.
 */
const planRestoreCopy = (
  state: PlanState,
  intent: { name: string; backupPath: string; targetPath: string },
  libraryDir: string,
): void => {
  const { name, backupPath, targetPath } = intent
  if (!insideRoots(backupPath, [join(libraryDir, 'backups')])) {
    refuse(state, 'skill', name, targetPath, 'Restores only read from the library’s own backups.')
    return
  }

  if (backupPath.endsWith('.txt')) {
    // An MCP declaration: `<config file>\n\n<raw entry>` as the remove filed it.
    let filed: string
    try {
      filed = readFileSync(backupPath, 'utf8')
    } catch {
      refuse(state, 'mcp', name, targetPath, 'The backup could not be read.')
      return
    }
    const split = filed.indexOf('\n\n')
    const raw = split === -1 ? '' : filed.slice(split + 2).trimEnd()
    const file = mcpFileFor(state, targetPath)
    if (file === null || file.dialect === null || raw === '') {
      refuse(state, 'mcp', name, targetPath, 'The backup does not match any configuration file this library manages.')
      return
    }
    const spec = decodeRawMcpEntry(raw, file.format, name, file.dialect)
    if (spec === null) {
      refuse(state, 'mcp', name, targetPath, 'The backed-up declaration could not be read faithfully.')
      return
    }
    const currentText = readFileOrNull(targetPath)
    const currentRaw = readRawMcpEntry(currentText, file.format, file.key, name)
    if (currentRaw !== null && digestOf(currentRaw) === digestOf(raw)) {
      push(state, {
        kind: 'mcp',
        name,
        action: 'skip',
        targetPath,
        reason: 'Already configured exactly as the backup has it.',
        guardDigest: digestOf(currentRaw),
        backup: false,
      })
      return
    }
    push(state, {
      kind: 'mcp',
      name,
      action: currentRaw === null ? 'create' : 'replace',
      targetPath,
      preview: unifiedDiff(currentRaw ?? '', raw, {
        fromLabel: `${shortPath(targetPath, state.home)} › ${name}`,
        toLabel: `${shortPath(targetPath, state.home)} › ${name}`,
      }),
      guardDigest: currentRaw === null ? null : digestOf(currentRaw),
      backup: currentRaw !== null,
      content: JSON.stringify(spec),
      sourcePath: backupPath,
      ...(currentRaw !== null ? { reason: 'What is configured now is backed up before the restore.' } : {}),
    })
    return
  }

  const filed = readDefinition(backupPath)
  if (filed === null) {
    refuse(state, 'skill', name, targetPath, 'The backup holds no definition to restore.')
    return
  }
  const skillRoots = knownRoots('skill', state.home, state.cwd)
  if (!insideRoots(targetPath, skillRoots)) {
    refuse(state, 'skill', name, targetPath, 'Not in any directory this library reads.')
    return
  }
  if (insideReadOnlyRoot(targetPath, state.home, state.cwd)) {
    refuse(state, 'skill', name, targetPath, 'This directory is shipped by the agent and is not written to.')
    return
  }
  let files: readonly string[] = []
  if (!filed.flat) {
    const walked = bundleExtras(backupPath)
    if ('refused' in walked) {
      refuse(state, 'skill', name, targetPath, walked.refused)
      return
    }
    files = walked.files
  }
  const existing = readDefinition(targetPath)
  const current = existing === null ? null : digestOf(existing.text)
  if (current !== null && current === digestOf(filed.text)) {
    push(state, {
      kind: 'skill',
      name,
      action: 'skip',
      targetPath,
      reason: 'Already exactly what the backup holds.',
      guardDigest: current,
      backup: false,
    })
    return
  }
  const label = shortPath(filed.flat ? targetPath : join(targetPath, 'SKILL.md'), state.home)
  push(state, {
    kind: 'skill',
    name,
    action: existing === null && !existsSync(targetPath) ? 'create' : 'replace',
    targetPath,
    preview: unifiedDiff(existing?.text ?? '', filed.text, { fromLabel: label, toLabel: label }),
    guardDigest: current,
    backup: existsSync(targetPath),
    content: filed.text,
    sourcePath: backupPath,
    ...(filed.flat ? { flat: true } : {}),
    ...(files.length > 0 ? { extraFiles: files } : {}),
    ...(existsSync(targetPath) ? { reason: 'What sits here now is backed up before the restore.' } : {}),
  })
}

/** The Agent Skills frontmatter an authored skill must at least carry. */
const AUTHORED = /^---\n[\s\S]*?\bname:\s*\S[\s\S]*?\n---\n/

const planAuthorSkill = (
  state: PlanState,
  intent: { name: string; content: string; targetRuntimes: readonly RuntimeId[] },
): void => {
  if (!AUTHORED.test(intent.content)) {
    for (const targetRuntime of intent.targetRuntimes) {
      refuse(
        state,
        'skill',
        intent.name,
        '',
        'A skill starts with frontmatter naming itself (`---`, a `name:` line, `---`).',
        targetRuntime,
      )
    }
    return
  }
  for (const targetRuntime of intent.targetRuntimes) {
    planInstallSkill(state, { name: intent.name, sourcePath: '', targetRuntime }, intent.content)
  }
}

/** The file spec for a configuration path the location table knows. */
const mcpFileFor = (
  state: PlanState,
  path: string,
): { readonly format: 'json' | 'toml'; readonly key: string; readonly dialect: McpDialect | null } | null => {
  for (const [brand, table] of Object.entries(LOCATIONS)) {
    for (const spec of table.mcp) {
      const resolved = locate(spec, state.home, state.cwd)
      if (resolved === path) return { format: spec.format, key: spec.key, dialect: dialectFor(brand) }
    }
  }
  return null
}

const readFileOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// Two specs mean the same server when their canonical forms match — otherwise
// an identical server already present is refused as "different settings"
// instead of skipped. Shared with the scanner so display and write agree.
const specsEqual = (a: McpServerSpec, b: McpServerSpec): boolean =>
  canonicalMcp(a) === canonicalMcp(b)

const planInstallMcp = (
  state: PlanState,
  intent: { name: string; sourcePath: string; targetRuntime: RuntimeId },
): void => {
  const { name, targetRuntime } = intent
  const source = mcpFileFor(state, intent.sourcePath)
  if (source === null || source.dialect === null) {
    refuse(state, 'mcp', name, '', 'The source is not a configuration file this library reads.', targetRuntime)
    return
  }
  const spec = decodeMcpEntry(readFileOrNull(intent.sourcePath), source.format, source.key, name, source.dialect)
  if (spec === null) {
    refuse(
      state,
      'mcp',
      name,
      intent.sourcePath,
      'This declaration could not be read faithfully, so it will not be copied at all.',
      targetRuntime,
    )
    return
  }

  const brand = brandOf(state, targetRuntime)
  if (brand === null) {
    refuse(state, 'mcp', name, '', 'This agent is not on the roster any more.', targetRuntime)
    return
  }
  const target = mcpWriteTarget(brand, state.home)
  const dialect = dialectFor(brand)
  if (target === null || dialect === null) {
    refuse(
      state,
      'mcp',
      name,
      '',
      'No configuration location is known for this agent, so its servers cannot be written.',
      targetRuntime,
    )
    return
  }
  const hostable = canHostMcp(dialect, spec)
  if (!hostable.ok) {
    refuse(state, 'mcp', name, target.resolved, hostable.reason, targetRuntime)
    return
  }
  if (target.resolved === intent.sourcePath) {
    push(state, {
      kind: 'mcp',
      name,
      action: 'skip',
      targetPath: target.resolved,
      targetRuntime,
      reason: 'This file already is where this agent reads it.',
      guardDigest: null,
      backup: false,
    })
    return
  }

  const currentText = readFileOrNull(target.resolved)
  const currentRaw = readRawMcpEntry(currentText, target.format, target.key, name)
  if (currentText !== null && currentText.trim() !== '' && target.format === 'json') {
    try {
      JSON.parse(currentText)
    } catch {
      refuse(
        state,
        'mcp',
        name,
        target.resolved,
        'This agent’s configuration file does not parse, so it will not be edited.',
        targetRuntime,
      )
      return
    }
  }

  if (currentRaw !== null) {
    const existing = decodeMcpEntry(currentText, target.format, target.key, name, dialect)
    if (existing !== null && specsEqual(existing, spec)) {
      push(state, {
        kind: 'mcp',
        name,
        action: 'skip',
        targetPath: target.resolved,
        targetRuntime,
        reason: 'Already configured here, and identical.',
        guardDigest: digestOf(currentRaw),
        backup: false,
      })
      return
    }
    const who = ownership(state.manifest, 'mcp', target.resolved, name, digestOf(currentRaw))
    if (who !== 'ours') {
      refuse(
        state,
        'mcp',
        name,
        target.resolved,
        who === 'edited'
          ? 'HarnessDesk wrote this declaration, but it has been edited since — remove it first, or edit it by hand.'
          : 'A server of this name is already configured here with different settings, and not by HarnessDesk.',
        targetRuntime,
      )
      return
    }
  }

  const nextRaw =
    target.format === 'json'
      ? JSON.stringify(encodeJsonEntry(spec, dialect), null, 2)
      : encodeTomlBlock(spec, target.key)
  push(state, {
    kind: 'mcp',
    name,
    action: currentRaw === null ? 'create' : 'update',
    targetPath: target.resolved,
    targetRuntime,
    preview: unifiedDiff(currentRaw ?? '', nextRaw, {
      fromLabel: `${shortPath(target.resolved, state.home)} › ${name}`,
      toLabel: `${shortPath(target.resolved, state.home)} › ${name}`,
    }),
    guardDigest: currentRaw === null ? null : digestOf(currentRaw),
    backup: false,
    content: JSON.stringify(spec),
  })
}

const planRemoveMcp = (state: PlanState, intent: { name: string; path: string }): void => {
  const { name, path } = intent
  const file = mcpFileFor(state, path)
  if (file === null) {
    refuse(state, 'mcp', name, path, 'Not a configuration file this library reads.')
    return
  }
  const text = readFileOrNull(path)
  const raw = readRawMcpEntry(text, file.format, file.key, name)
  if (raw === null) {
    push(state, {
      kind: 'mcp',
      name,
      action: 'skip',
      targetPath: path,
      reason: 'Not configured here.',
      guardDigest: null,
      backup: false,
    })
    return
  }
  const who = ownership(state.manifest, 'mcp', path, name, digestOf(raw))
  push(state, {
    kind: 'mcp',
    name,
    action: 'remove',
    targetPath: path,
    preview: unifiedDiff(raw, '', { fromLabel: `${shortPath(path, state.home)} › ${name}`, toLabel: '/dev/null' }),
    reason:
      who === 'ours'
        ? 'Configured by HarnessDesk; a backup is kept anyway.'
        : 'Not written by HarnessDesk — a backup of the declaration is kept.',
    guardDigest: digestOf(raw),
    backup: true,
  })
}

/** Intents in, previewed operations out, nothing touched. */
export const planLibrary = async (
  agents: readonly WriteAgent[],
  intents: readonly LibraryIntent[],
  context: WriteContext,
): Promise<LibraryPlan> => {
  const state: PlanState = {
    agents,
    manifest: await LibraryManifest.load(context.libraryDir),
    home: context.home ?? homedir(),
    cwd: context.cwd,
    ops: [],
    counter: 0,
  }

  for (const intent of intents) {
    if (!validName(intent.name)) {
      refuse(state, intent.kind.endsWith('Mcp') ? 'mcp' : 'skill', intent.name, '', 'Not a name a directory can carry.')
      continue
    }
    switch (intent.kind) {
      case 'installSkill':
        planInstallSkill(state, intent)
        break
      case 'authorSkill':
        planAuthorSkill(state, intent)
        break
      case 'syncSkill':
        planSyncSkill(state, intent)
        break
      case 'removeCopy':
        planRemoveCopy(state, intent)
        break
      case 'restoreCopy':
        planRestoreCopy(state, intent, context.libraryDir)
        break
      case 'installMcp':
        planInstallMcp(state, intent)
        break
      case 'removeMcp':
        planRemoveMcp(state, intent)
        break
    }
  }

  return { plannedAt: Date.now(), ops: state.ops }
}

/** Where one op's backup goes; a timestamped directory that never collides. */
const backupHome = (libraryDir: string, name: string): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(libraryDir, 'backups', `${stamp}-${name}-${Math.random().toString(36).slice(2, 6)}`)
}

const currentSkillDigest = (targetPath: string): string | null => {
  const existing = readDefinition(targetPath)
  return existing === null ? null : digestOf(existing.text)
}

/**
 * One op, performed. Throws with the sentence the result should carry;
 * `applyLibrary` catches per op.
 */
const applyOne = async (
  op: LibraryPlannedOp,
  manifest: LibraryManifest,
  context: Required<Pick<WriteContext, 'libraryDir'>> & { home: string; cwd: string | undefined },
): Promise<LibraryOpResult> => {
  const roots = knownRoots(op.kind, context.home, context.cwd)
  if (!insideRoots(op.targetPath, roots)) {
    throw new Error('The target is not in any directory this library manages.')
  }
  // The source too: bundle files are copied from it at apply time, and an op
  // that crossed the socket could otherwise name any path on the machine.
  if (
    op.sourcePath !== undefined &&
    !insideRoots(op.sourcePath, [
      ...knownRoots('skill', context.home, context.cwd),
      join(context.libraryDir, 'backups'),
    ])
  ) {
    throw new Error('The source is not in any directory this library reads.')
  }
  if (op.kind === 'skill' && insideReadOnlyRoot(op.targetPath, context.home, context.cwd)) {
    throw new Error('The target directory is shipped by the agent and is not written to.')
  }

  let backupPath: string | undefined

  if (op.kind === 'skill') {
    const current = currentSkillDigest(op.targetPath)
    if (current !== op.guardDigest) {
      throw new Error('The target changed since the preview — plan again to see what is there now.')
    }
    const existsNow = existsSync(op.targetPath)
    // The overwrite rule, re-derived here rather than trusted from the wire.
    // A hollow directory with nothing in it has nothing to lose, so it alone
    // may be replaced without a backup.
    if (existsNow) {
      const who = current === null ? 'foreign' : ownership(manifest, 'skill', op.targetPath, op.name, current)
      const losable = current !== null || dirHasEntries(op.targetPath)
      if (who !== 'ours' && losable && !op.backup) {
        throw new Error('This copy was not written by HarnessDesk and the operation carries no backup.')
      }
    }

    if (op.action === 'remove') {
      if (op.backup && existsNow) {
        backupPath = backupHome(context.libraryDir, op.name)
        await mkdir(dirname(backupPath), { recursive: true })
        await cp(op.targetPath, backupPath, { recursive: true })
      }
      await rm(op.targetPath, { recursive: true, force: true })
      manifest.forget('skill', op.targetPath, op.name)
      await manifest.save()
      return { id: op.id, outcome: 'done', ...(backupPath !== undefined ? { backupPath } : {}) }
    }

    const content = op.content
    if (content === undefined) throw new Error('The operation carries nothing to write.')
    if (op.backup && existsNow) {
      backupPath = backupHome(context.libraryDir, op.name)
      await mkdir(dirname(backupPath), { recursive: true })
      await cp(op.targetPath, backupPath, { recursive: true })
    }
    if (op.action === 'replace' && existsNow) {
      await rm(op.targetPath, { recursive: true, force: true })
    }

    if (op.flat === true) {
      await mkdir(dirname(op.targetPath), { recursive: true })
      await writeFile(op.targetPath, content)
    } else {
      await mkdir(op.targetPath, { recursive: true })
      await writeFile(join(op.targetPath, 'SKILL.md'), content)
      for (const relative of op.extraFiles ?? []) {
        if (op.sourcePath === undefined) break
        if (relative.split('/').some((part) => part === '..' || part === '')) continue
        const from = join(op.sourcePath, relative)
        const to = join(op.targetPath, relative)
        try {
          await mkdir(dirname(to), { recursive: true })
          await cp(from, to)
        } catch {
          // A bundle file that vanished since the plan is not worth failing
          // the definition for; the definition is the skill.
        }
      }
    }
    manifest.record({
      kind: 'skill',
      name: op.name,
      path: op.targetPath,
      digest: digestOf(content),
      at: Date.now(),
      ...(op.sourcePath !== undefined ? { source: op.sourcePath } : {}),
    })
    await manifest.save()
    return { id: op.id, outcome: 'done', ...(backupPath !== undefined ? { backupPath } : {}) }
  }

  // MCP: the file is read fresh, the guard is checked against it, and the
  // edit is written atomically beside it.
  const table = ((): { format: 'json' | 'toml'; key: string; dialect: McpDialect | null } => {
    for (const [brand, locations] of Object.entries(LOCATIONS)) {
      for (const spec of locations.mcp) {
        const resolved = locate(spec, context.home, context.cwd)
        if (resolved === op.targetPath) {
          return { format: spec.format, key: spec.key, dialect: dialectFor(brand) }
        }
      }
    }
    throw new Error('The target is not a configuration file this library manages.')
  })()

  let text: string | null = null
  try {
    text = await readFile(op.targetPath, 'utf8')
  } catch {
    text = null
  }
  const raw = readRawMcpEntry(text, table.format, table.key, op.name)
  const currentDigest = raw === null ? null : digestOf(raw)
  if (currentDigest !== op.guardDigest) {
    throw new Error('The declaration changed since the preview — plan again to see what is there now.')
  }
  if (raw !== null) {
    const who = ownership(manifest, 'mcp', op.targetPath, op.name, digestOf(raw))
    if (who !== 'ours' && !op.backup) {
      throw new Error('This declaration was not written by HarnessDesk and the operation carries no backup.')
    }
  }

  let spec: McpServerSpec | null = null
  if (op.action !== 'remove') {
    if (op.content === undefined) throw new Error('The operation carries nothing to write.')
    let parsed: unknown
    try {
      parsed = JSON.parse(op.content)
    } catch {
      throw new Error('The operation carries an unreadable declaration.')
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('The operation carries an invalid declaration.')
    }
    // The name is the op's, never the wire content's: the TOML header, the
    // guard digest, the manifest record and the audit line all key on
    // `op.name`, so a `content` naming a different server would write a table
    // none of them could find, remove, or own.
    spec = { ...(parsed as McpServerSpec), name: op.name }
    if (table.dialect === null) throw new Error('No dialect is known for this configuration file.')
    const hostable = canHostMcp(table.dialect, spec)
    if (!hostable.ok) throw new Error(hostable.reason)
  }

  if (op.backup && raw !== null) {
    backupPath = `${backupHome(context.libraryDir, op.name)}.txt`
    await mkdir(dirname(backupPath), { recursive: true })
    await writeFile(backupPath, `${op.targetPath}\n\n${raw}\n`)
  }

  const next = applyMcpEdit(text, table.format, table.key, op.name, spec, table.dialect ?? 'claude')
  await mkdir(dirname(op.targetPath), { recursive: true })
  const tmp = `${op.targetPath}.harnessdesk-tmp`
  await writeFile(tmp, next)
  await rename(tmp, op.targetPath)

  if (op.action === 'remove') {
    manifest.forget('mcp', op.targetPath, op.name)
  } else {
    const written = readRawMcpEntry(next, table.format, table.key, op.name)
    manifest.record({
      kind: 'mcp',
      name: op.name,
      path: op.targetPath,
      digest: digestOf(written ?? ''),
      at: Date.now(),
      ...(op.sourcePath !== undefined ? { source: op.sourcePath } : {}),
    })
  }
  await manifest.save()
  return { id: op.id, outcome: 'done', ...(backupPath !== undefined ? { backupPath } : {}) }
}

/**
 * The planned operations, performed in order, one result each. `skip` and
 * `refuse` come back as `skipped` with their reason — they are part of the
 * record, not silently dropped.
 */
export const applyLibrary = async (
  ops: readonly LibraryPlannedOp[],
  context: WriteContext,
): Promise<readonly LibraryOpResult[]> => {
  const manifest = await LibraryManifest.load(context.libraryDir)
  const full = {
    libraryDir: context.libraryDir,
    home: context.home ?? homedir(),
    cwd: context.cwd,
  }
  const results: LibraryOpResult[] = []
  for (const op of ops) {
    if (op.action === 'skip' || op.action === 'refuse') {
      results.push({ id: op.id, outcome: 'skipped', ...(op.reason !== undefined ? { detail: op.reason } : {}) })
      continue
    }
    if (!validName(op.name) || basename(op.targetPath) === '') {
      results.push({ id: op.id, outcome: 'failed', detail: 'Not a name a directory can carry.' })
      continue
    }
    try {
      results.push(await applyOne(op, manifest, full))
    } catch (error) {
      results.push({
        id: op.id,
        outcome: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}
