import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { readDefinition } from '../src/index.js'

/**
 * One entry's definition, read.
 *
 * Two properties, and the second is the one that matters.
 *
 * **It reads what is there.** The `SKILL.md` text whole, frontmatter
 * included — the frontmatter is what the agent consults to decide whether to
 * fire the skill, so a reader that strips it hides the mechanism — plus the
 * bundle's own files, `SKILL.md` first and the rest in a stable order.
 *
 * **It reads nothing else.** The path arrives from the renderer, which read
 * it out of a report this package produced, and then crossed a socket. A
 * read confined by the caller's honesty is not confined, so the containment
 * check is re-run here against the same roots the write path uses, and it
 * resolves `..` before comparing. `~/.ssh/id_ed25519` reachable by asking for
 * a skill would be the whole of this feature's cost.
 */

const home = async (): Promise<string> => mkdtemp(join(tmpdir(), 'hd-definition-'))

/** A bundle under Claude's user skills directory — a root the table knows. */
const bundle = async (root: string, name: string, body: string): Promise<string> => {
  const path = join(root, '.claude', 'skills', name)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'SKILL.md'), body, 'utf8')
  return path
}

test('reads the definition whole, frontmatter and all', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const body = '---\nname: review\ndescription: Read the diff.\n---\n\n# Review\n\nCorrectness first.'
  const path = await bundle(root, 'review', body)

  const answer = readDefinition({ kind: 'skill', name: 'review', path }, { home: root })
  assert.ok(answer, 'a definition inside a known root should be readable')
  assert.equal(answer.text, body)
  assert.equal(answer.truncated, false)
  assert.equal(answer.name, 'review')
  assert.equal(answer.path, path)
})

test('lists the bundle with SKILL.md first, whatever readdir felt like', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = await bundle(root, 'kit', '---\nname: kit\n---\n\nBody.')
  await mkdir(join(path, 'scripts'), { recursive: true })
  await writeFile(join(path, 'zebra.md'), 'z', 'utf8')
  await writeFile(join(path, 'alpha.md'), 'a', 'utf8')
  await writeFile(join(path, 'scripts', 'run.py'), 'print(1)', 'utf8')

  const answer = readDefinition({ kind: 'skill', name: 'kit', path }, { home: root })
  assert.ok(answer)
  assert.deepEqual(
    answer.files.map((one) => one.path),
    ['SKILL.md', 'alpha.md', 'scripts/run.py', 'zebra.md'],
  )
  assert.equal(answer.moreFiles, 0)
  // Sizes are real, because the sheet prints them and a made-up number in a
  // file listing is worse than no listing.
  assert.equal(answer.files.find((one) => one.path === 'scripts/run.py')?.bytes, 8)
})

test('a flat definition is one file, never an empty bundle', async (t) => {
  // The hollow state's sentence is "no definition inside it". A flat
  // `<name>.md` holds the whole definition, and reporting zero files for one
  // would put that sentence on a skill that is perfectly fine.
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.claude', 'skills'), { recursive: true })
  const path = join(root, '.claude', 'skills', 'flat.md')
  await writeFile(path, '---\nname: flat\n---\n\nBody.', 'utf8')

  const answer = readDefinition({ kind: 'skill', name: 'flat', path }, { home: root })
  assert.ok(answer)
  assert.deepEqual(
    answer.files.map((one) => one.path),
    ['flat.md'],
  )
})

test('refuses a path outside every known root', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const secret = join(root, 'private', 'id_ed25519')
  await mkdir(join(root, 'private'), { recursive: true })
  await writeFile(secret, 'PRIVATE KEY', 'utf8')

  assert.equal(
    readDefinition({ kind: 'skill', name: 'anything', path: secret }, { home: root }),
    null,
  )
})

test('a traversal that reads as inside a root does not escape it', async (t) => {
  // The lexical-prefix hole: `…/.claude/skills/../../private/id_ed25519`
  // starts with a root and is not in it. The path is resolved before the
  // comparison, here as in the write path.
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'private'), { recursive: true })
  await writeFile(join(root, 'private', 'id_ed25519'), 'PRIVATE KEY', 'utf8')

  const sneaky = join(root, '.claude', 'skills', '..', '..', 'private', 'id_ed25519')
  assert.equal(
    readDefinition({ kind: 'skill', name: 'review', path: sneaky }, { home: root }),
    null,
  )
})

test('an empty directory has no definition to answer with', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, '.claude', 'skills', 'hollow')
  await mkdir(path, { recursive: true })

  // Null rather than a throw: the sheet has a good sentence for this, and an
  // exception would take the page instead of the pane.
  assert.equal(readDefinition({ kind: 'skill', name: 'hollow', path }, { home: root }), null)
})

test('a symlink out of a root is followed only as far as the root allows', async (t) => {
  // Containment is checked on the path asked for, which is the path the
  // report handed out. A link planted *inside* a skills directory is a
  // question about what the agent itself would load — it would follow this
  // too — so the answer here matches the agent's own behaviour rather than
  // inventing a stricter one the reach column would then disagree with.
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'elsewhere'), { recursive: true })
  await writeFile(join(root, 'elsewhere', 'SKILL.md'), 'linked', 'utf8')
  const path = join(root, '.claude', 'skills', 'linked')
  await mkdir(join(root, '.claude', 'skills'), { recursive: true })
  await symlink(join(root, 'elsewhere'), path, 'dir')

  const answer = readDefinition({ kind: 'skill', name: 'linked', path }, { home: root })
  assert.ok(answer, 'a link inside a scanned root is what the agent would load')
  assert.equal(answer.text, 'linked')
})
