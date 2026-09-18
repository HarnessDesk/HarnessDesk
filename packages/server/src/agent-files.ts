import { cp, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { FlowPermission, FlowSeat } from '@harnessdesk/protocol'

import { PROJECT_AGENT_DIR } from './agents.js'
import { seatSpec, seatWritesCompactly } from './flow.js'

/**
 * An Agent's folder, written: a new one, or a copy of one.
 *
 * Editing an Agent's content is editing its file in the desk's editor; these
 * are the writes that are not that. Two rules hold for all of them. Nothing
 * overwrites an Agent that is there — a folder that exists is a refusal,
 * never a merge. And nothing is written through a link out of a project: the
 * roster never reads through one, and a write through one would put a file
 * somewhere the person never chose.
 */

/** A folder name an Agent can have: what `uses:` and `seating.json` name it by. */
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/

/** The folder a name makes: lower case, words joined by hyphens, accents dropped; null when nothing is left. */
export const agentIdOf = (name: string): string | null => {
  const id = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return AGENT_ID.test(id) ? id : null
}

/** One line of text, as a double-quoted scalar the front matter can carry. */
const quoted = (text: string): string => JSON.stringify(text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim())

/**
 * A seat as front matter writes it: the spec, or the long form when writing
 * it compactly would not read back the same seat (`seatWritesCompactly`,
 * shared with `agent-seating-file.ts`'s `written()` so a model, runtime or
 * effort holding one of the compact grammar's own separators — `=`, `/`,
 * `+` — is never written where any file would misread it).
 */
const seatLines = (seat: FlowSeat): string[] =>
  seatWritesCompactly(seat)
    ? [`  - ${quoted(seatSpec(seat))}`]
    : [
        `  - runtime: ${quoted(seat.runtime)}`,
        ...(seat.model ? [`    model: ${quoted(seat.model)}`] : []),
        ...(seat.effort ? [`    effort: ${quoted(seat.effort)}`] : []),
        ...(seat.thinking ? ['    thinking: true'] : []),
      ]

/**
 * A new Agent's `AGENT.md`: its fields, and a brief with the parts every
 * shipped brief has, each holding one line for its author to replace. The
 * desk opens it in the editor the moment it is written.
 */
export const agentSource = (agent: {
  readonly name: string
  readonly description: string | null
  readonly permission: FlowPermission
  readonly prefer: readonly FlowSeat[]
}): string =>
  [
    '---',
    `name: ${quoted(agent.name)}`,
    ...(agent.description ? [`description: ${quoted(agent.description)}`] : []),
    `permission: ${agent.permission}`,
    'prefer:',
    ...agent.prefer.flatMap(seatLines),
    '---',
    '',
    agent.description ?? 'What this Agent is for, in your words.',
    '',
    '## How to report',
    '',
    'What it reports when it is done, and the line it ends on.',
    '',
    '## What you never do',
    '',
    'What it must never do, whatever it is asked.',
    '',
  ].join('\n')

/**
 * A project's Agent directory, made where it is missing and refused where it
 * leads out: each step is looked at before it is made, and a link at either
 * step is refused whether it leads in or out, because telling the two apart
 * means following it.
 */
export const projectAgentDir = async (project: string): Promise<string> => {
  const within = await realpath(project)
  let at = within
  for (const step of PROJECT_AGENT_DIR.split('/')) {
    at = join(at, step)
    const info = await lstat(at).catch(() => null)
    if (info?.isSymbolicLink()) {
      throw new Error(`${at} is a link, so no Agent was written through it: a project's Agents are written only inside it.`)
    }
    if (info && !info.isDirectory()) throw new Error(`${at} is not a folder, so no Agent was written there.`)
    if (!info) await mkdir(at)
  }
  return at
}

/** Writes a new Agent's folder and file, or refuses if an Agent by that name is there. Answers the file's path. */
export const createAgentFolder = async (root: string, id: string, source: string): Promise<string> => {
  await mkdir(root, { recursive: true })
  const folder = join(root, id)
  try {
    await mkdir(folder)
  } catch (error) {
    if ((error as { code?: unknown }).code === 'EEXIST') {
      throw new Error(`There is already an Agent called “${id}” in ${root}.`)
    }
    throw error
  }
  const path = join(folder, 'AGENT.md')
  await writeFile(path, source, { encoding: 'utf8', flag: 'wx' })
  return path
}

/**
 * Copies an Agent's folder whole — its `AGENT.md`, and its `skills/` and
 * notes where it has them — leaving every link inside it behind rather than
 * following it, and refusing if an Agent by that name is already at the
 * destination.
 *
 * `from` is followed once, at the top, with `realpath` before anything is
 * read from it: the roster reads this machine's own folders straight through
 * a link at their top — a dotfiles checkout linked into place — so `from`
 * itself may be exactly such a link, and `cp`'s own filter (below) would
 * otherwise drop it whole, copying nothing. Every link *inside* the tree is
 * still left behind, because only the one step the roster itself already
 * took is repeated here. And a copy that followed nothing but links copied
 * nothing worth having, so if no `AGENT.md` arrived, what was made is removed
 * and the copy is refused — never left as an Agent with no brief, and never
 * left to fail later in a stranger's sentence than this one.
 */
export const copyAgentFolder = async (from: string, to: string): Promise<void> => {
  const id = to.split('/').pop() ?? to
  if (await lstat(to).then(() => true, () => false)) {
    throw new Error(`There is already an Agent called “${id}” in ${dirname(to)}.`)
  }
  await mkdir(dirname(to), { recursive: true })
  const real = await realpath(from)
  await cp(real, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (source) => {
      const info = await lstat(source)
      return info.isDirectory() || info.isFile()
    },
  })
  const hasBrief = await lstat(join(to, 'AGENT.md')).then(
    (info) => info.isFile(),
    () => false,
  )
  if (!hasBrief) {
    await rm(to, { recursive: true, force: true })
    throw new Error(`${from} has no AGENT.md to copy — nothing but links, which are left behind rather than followed.`)
  }
}
