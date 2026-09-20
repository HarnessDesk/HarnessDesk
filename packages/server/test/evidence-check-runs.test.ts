import assert from 'node:assert/strict'
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  parseClientMessage,
  runtimeId,
  ValidationError,
  type CheckUnseen,
  type EvidenceRecord,
  type Intent,
  type TeamState,
} from '@harnessdesk/protocol'

import { EvidencePlane } from '../src/evidence/plane.js'
import { canonical } from '../src/evidence/revision.js'
import { whichOnPath } from '../src/installs/which.js'
import { evidenceDesk, makeRepo, until, type Repo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * Security-critical. A command a repository names runs only after a person has
 * approved it, verbatim, on this machine, as its committed file says it; and a
 * changed, added or renamed command — or any change to the file — asks again.
 * Every test here that expects a refusal also proves nothing ran: each command
 * would leave a marker file outside the repository, and the marker is not
 * there.
 */

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

const card = (id: number, over: Partial<Intent> = {}): Intent =>
  ({
    id,
    title: `Card ${id}`,
    detail: null,
    state: 'open',
    files: [],
    dependsOn: [],
    claim: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as Intent

interface Rig {
  readonly repo: Repo
  readonly plane: EvidencePlane
  readonly markers: string
  readonly seenFile: string
  /** Rewrites the checks file and commits it, so the tree stays clean. */
  checks(text: string): Promise<void>
  /** The check facts recorded for the room so far. */
  facts(): Promise<EvidenceRecord[]>
}

const rig = async (text: string, options: { cards?: readonly Intent[]; cwdOf?: (runtime: string, id: string) => string | null; root?: string } = {}): Promise<Rig> => {
  const repo = await makeRepo()
  const state = tempDir('hd-check-runs-state-')
  const markers = tempDir('hd-check-runs-markers-')
  const seenFile = join(state, 'commands-seen.json')
  const checks = async (next: string): Promise<void> => {
    await mkdir(join(repo.dir, '.harnessdesk'), { recursive: true })
    await writeFile(join(repo.dir, '.harnessdesk', 'checks.yml'), next.replaceAll('MARKERS', markers))
    await repo.git('add', '.')
    await repo.git('commit', '-q', '-m', 'checks')
  }
  await checks(text)
  const board = {
    id: 'room-1',
    root: options.root ?? repo.dir,
    intents: options.cards ?? [card(1)],
  } as unknown as TeamState
  const plane = new EvidencePlane(
    { dir: join(state, 'evidence'), seenFile },
    {
      board: (room) => (room === 'room-1' ? board : null),
      cwdOf: options.cwdOf ?? (() => null),
      push: () => {},
      log: () => {},
    },
  )
  // Only checks: a run announces the room, and the board read that follows may look at the card's diff.
  const facts = async (): Promise<EvidenceRecord[]> =>
    (await plane.store.read(await canonical(repo.dir), 'evidence')).lines.flatMap((line) =>
      line.type === 'evidence' && line.record.fact.kind === 'check' ? [line.record] : [],
    )
  return { repo, plane, markers, seenFile, checks, facts }
}

/** The refusal a check not yet approved gets, with what it carries. */
const unseen = async (attempt: Promise<unknown>): Promise<CheckUnseen> => {
  let carried: CheckUnseen | null = null
  await assert.rejects(attempt, (error: Error & { wireCode?: string; wireData?: CheckUnseen }) => {
    assert.equal(error.wireCode, 'checkUnseen')
    assert.match(error.message, /runs a command this machine has not approved as it is written now, so it has not run\.$/)
    carried = error.wireData ?? null
    return true
  })
  assert.ok(carried)
  return carried
}

/** The person's answer to a question: the command and the file, exactly as they were shown. */
const answer = (carried: CheckUnseen) => ({ seen: carried.check.run, digest: carried.digest })

/** The checks file's committed blob: the generation a question carries. */
const blob = (r: Rig): Promise<string> => r.repo.git('rev-parse', 'HEAD:.harnessdesk/checks.yml')

/** Waits for the room to have `count` check facts. */
const settled = (r: Rig, count: number): Promise<EvidenceRecord[]> =>
  until(async () => {
    const facts = await r.facts()
    return facts.length >= count && r.plane.running.of('room-1').length === 0 ? facts : null
  }, `${count} check fact(s)`)

test('nothing runs before a person has seen the command, and the refusal carries it verbatim', async () => {
  const r = await rig('verify: { run: touch MARKERS/verify, timeout: 30 }\n')
  const carried = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  assert.deepEqual(carried, {
    check: { name: 'verify', run: `touch ${r.markers}/verify`, timeout: 30 },
    previous: null,
    cwd: r.repo.dir,
    file: join(await canonical(r.repo.dir), '.harnessdesk', 'checks.yml'),
    digest: await blob(r),
  })
  assert.equal(await exists(join(r.markers, 'verify')), false, 'nothing ran')
  assert.equal(await exists(r.seenFile), false, 'and nothing was recorded as seen')
  assert.deepEqual(await r.facts(), [])
})

test('the answer runs exactly the command that was shown, once, and the fact it leaves names it', async () => {
  const r = await rig('verify: { run: touch MARKERS/verify, timeout: 30 }\n')
  const carried = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  assert.deepEqual(await r.plane.checks.run('room-1', 1, 'verify', answer(carried)), { started: true })
  const [fact] = await settled(r, 1)
  assert.equal(await exists(join(r.markers, 'verify')), true)
  assert.deepEqual(fact?.fact, {
    kind: 'check',
    name: 'verify',
    run: `touch ${r.markers}/verify`,
    exit: 0,
    timedOut: false,
    at: await r.repo.git('rev-parse', 'HEAD'),
    digest: carried.digest,
    counted: true,
    dirty: false,
    tail: '',
  })
  assert.deepEqual(fact?.card, { board: 'room-1', id: 1 })
  assert.deepEqual(fact?.checkout, { cwd: r.repo.dir, branch: 'main' })
  // Approved now: the next run does not ask.
  await r.plane.checks.run('room-1', 1, 'verify')
  await settled(r, 2)
})

test('what runs is the file as committed: a change in the working copy is not run, and not asked about', async () => {
  const r = await rig('verify: { run: touch MARKERS/committed }\n')
  const at = await r.repo.git('rev-parse', 'HEAD')
  await writeFile(join(r.repo.dir, '.harnessdesk', 'checks.yml'), `verify: { run: touch ${r.markers}/working }\n`)
  const carried = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  assert.equal(carried.check.run, `touch ${r.markers}/committed`)
  await r.plane.checks.run('room-1', 1, 'verify', answer(carried))
  const [fact] = await settled(r, 1)
  assert.equal(await exists(join(r.markers, 'committed')), true)
  assert.equal(await exists(join(r.markers, 'working')), false)
  assert.equal(fact?.fact.kind === 'check' && fact.fact.dirty, true, 'and the fact says the tree held changes')
  assert.equal(fact?.fact.kind === 'check' && 'digest' in fact.fact ? fact.fact.digest : null, carried.digest)
  assert.equal(fact?.fact.kind === 'check' ? fact.fact.at : null, at)
})

test('a file never committed offers nothing to run', async () => {
  const r = await rig('verify: { run: touch MARKERS/verify }\n')
  await r.repo.git('rm', '-q', '--cached', '.harnessdesk/checks.yml')
  await r.repo.git('commit', '-q', '-m', 'untrack the checks')
  await assert.rejects(
    r.plane.checks.run('room-1', 1, 'verify', { seen: `touch ${r.markers}/verify`, digest: 'anything' }),
    /^Error: verify cannot run: It is not committed yet\./,
  )
  assert.equal(await exists(join(r.markers, 'verify')), false)
})

test('a changed command asks again, says what it was, and runs nothing', async () => {
  const r = await rig('verify: { run: touch MARKERS/first }\n')
  await r.plane.checks.run('room-1', 1, 'verify', answer(await unseen(r.plane.checks.run('room-1', 1, 'verify'))))
  await settled(r, 1)
  await r.checks('verify: { run: touch MARKERS/second }\n')
  const carried = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  assert.equal(carried.check.run, `touch ${r.markers}/second`)
  assert.equal(carried.previous, `touch ${r.markers}/first`)
  assert.equal(await exists(join(r.markers, 'second')), false)
})

test('a renamed check asks again, and so does one just added', async () => {
  const r = await rig('verify: { run: touch MARKERS/verify }\n')
  await r.plane.checks.run('room-1', 1, 'verify', answer(await unseen(r.plane.checks.run('room-1', 1, 'verify'))))
  await settled(r, 1)
  await r.checks('renamed: { run: touch MARKERS/verify }\nadded: { run: touch MARKERS/added }\n')
  const renamed = await unseen(r.plane.checks.run('room-1', 1, 'renamed', undefined))
  assert.equal(renamed.previous, null, 'a new name has nothing before it')
  await unseen(r.plane.checks.run('room-1', 1, 'added', undefined))
  assert.equal(await exists(join(r.markers, 'added')), false)
  assert.equal((await r.facts()).length, 1, 'only the run the person answered for')
})

test('an answer for text the file no longer holds runs nothing, and asks about what it holds now', async () => {
  const r = await rig('verify: { run: touch MARKERS/shown }\n')
  const shown = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  // Between the question and the answer, the file changes under it.
  await r.checks('verify: { run: touch MARKERS/swapped }\n')
  const again = await unseen(r.plane.checks.run('room-1', 1, 'verify', answer(shown)))
  assert.equal(again.check.run, `touch ${r.markers}/swapped`)
  assert.equal(await exists(join(r.markers, 'shown')), false)
  assert.equal(await exists(join(r.markers, 'swapped')), false)
  assert.equal(await exists(r.seenFile), false, 'the stale answer was not recorded')
})

test('an answer given for another generation of the file asks again, even when the command reads the same', async () => {
  const r = await rig('verify: { run: touch MARKERS/verify }\n')
  const shown = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  // Something else in the file changes between the question and the answer.
  await r.checks('verify: { run: touch MARKERS/verify }\nlint: { run: touch MARKERS/lint }\n')
  const again = await unseen(r.plane.checks.run('room-1', 1, 'verify', answer(shown)))
  assert.equal(again.check.run, shown.check.run)
  assert.notEqual(again.digest, shown.digest)
  assert.equal(await exists(join(r.markers, 'verify')), false)
})

test('a commit made while an answered check is being admitted cannot substitute its new command for R\'s', async () => {
  const r = await rig('verify: { run: touch MARKERS/old }\n')
  const shown = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  const pinned = await r.repo.git('rev-parse', 'HEAD')

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const inside = new Promise<void>((resolve) => {
    entered = resolve
  })
  let held = false
  const approved = r.plane.seen.approved.bind(r.plane.seen)
  r.plane.seen.approved = async (...args) => {
    if (!held) {
      held = true
      entered()
      await gate
    }
    return approved(...args)
  }

  const admitting = r.plane.checks.run('room-1', 1, 'verify', answer(shown))
  await inside
  await r.checks('verify: { run: touch MARKERS/new }\n')
  const advanced = await r.repo.git('rev-parse', 'HEAD')
  release()

  assert.deepEqual(await admitting, { started: true })
  const [fact] = await settled(r, 1)
  assert.equal(await exists(join(r.markers, 'old')), true)
  assert.equal(await exists(join(r.markers, 'new')), false)
  assert.equal(fact?.fact.kind === 'check' ? fact.fact.at : null, pinned)
  assert.equal(fact?.fact.kind === 'check' && fact.fact.digest, shown.digest)
  assert.equal(fact?.fact.kind === 'check' && fact.fact.counted, false)
  assert.match(fact?.fact.kind === 'check' ? fact.fact.tail : '', new RegExp(`HEAD moved from ${pinned} to ${advanced}`))
})

test('a checks commit between the generation read and spawn runs only the command from the pinned revision', async (t) => {
  const r = await rig('verify: { run: touch MARKERS/old }\n')
  const shown = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  const pinned = await r.repo.git('rev-parse', 'HEAD')

  // Hold git's branch read after the old implementation's final checks read.
  // The replacement snapshot may reach the same read while assembling R's
  // evidence metadata; either way, the commit lands after R was chosen and
  // before the process starts.
  const fakebin = tempDir('hd-check-runs-git-')
  const entered = join(fakebin, 'entered')
  const release = join(fakebin, 'release')
  const held = join(fakebin, 'held')
  const originalPath = process.env['PATH'] ?? ''
  const realGit = whichOnPath('git', { env: { ...process.env, PATH: originalPath } })
  assert.ok(realGit)
  const wrapper = join(fakebin, 'git')
  await writeFile(
    wrapper,
    `#!${process.execPath}\n` +
      `const { existsSync, writeFileSync } = require('node:fs')\n` +
      `const { spawnSync } = require('node:child_process')\n` +
      `const args = process.argv.slice(2)\n` +
      `if (args[0] === '-C' && args[1] === ${JSON.stringify(r.repo.dir)} && args[2] === 'symbolic-ref' && !existsSync(${JSON.stringify(held)})) {\n` +
      `  writeFileSync(${JSON.stringify(held)}, '')\n` +
      `  writeFileSync(${JSON.stringify(entered)}, '')\n` +
      `  const cell = new Int32Array(new SharedArrayBuffer(4))\n` +
      `  while (!existsSync(${JSON.stringify(release)})) Atomics.wait(cell, 0, 0, 20)\n` +
      `}\n` +
      `const result = spawnSync(${JSON.stringify(realGit)}, args)\n` +
      `if (result.stdout) process.stdout.write(result.stdout)\n` +
      `if (result.stderr) process.stderr.write(result.stderr)\n` +
      `process.exit(result.status ?? 1)\n`,
  )
  await chmod(wrapper, 0o755)
  process.env['PATH'] = `${fakebin}:${originalPath}`
  t.after(() => {
    process.env['PATH'] = originalPath
  })

  const admitting = r.plane.checks.run('room-1', 1, 'verify', answer(shown))
  await until(async () => ((await exists(entered)) ? true : null), 'the held checkout metadata read')
  await r.checks('verify: { run: touch MARKERS/new }\n')
  const advanced = await r.repo.git('rev-parse', 'HEAD')
  await writeFile(release, '')

  assert.deepEqual(await admitting, { started: true })
  const [fact] = await settled(r, 1)
  assert.equal(await exists(join(r.markers, 'old')), true, 'the command read from R ran')
  assert.equal(await exists(join(r.markers, 'new')), false, 'the later command never ran under R\'s approval')
  assert.equal(fact?.fact.kind === 'check' ? fact.fact.at : null, pinned)
  assert.equal(fact?.fact.kind === 'check' && 'digest' in fact.fact ? fact.fact.digest : null, shown.digest)
  assert.equal(fact?.fact.kind === 'check' && 'counted' in fact.fact ? fact.fact.counted : true, false)
  assert.match(fact?.fact.kind === 'check' ? fact.fact.tail : '', new RegExp(`HEAD moved from ${pinned} to ${advanced}`))
})

test('a checkout commit made during final admission leaves R recorded and the moved result not counted', async () => {
  const r = await rig('verify: { run: git rev-parse HEAD > MARKERS/head }\n')
  const shown = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  const pinned = await r.repo.git('rev-parse', 'HEAD')

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const inside = new Promise<void>((resolve) => {
    entered = resolve
  })
  const approve = r.plane.seen.approve.bind(r.plane.seen)
  r.plane.seen.approve = async (...args) => {
    entered()
    await gate
    return approve(...args)
  }

  const admitting = r.plane.checks.run('room-1', 1, 'verify', answer(shown))
  await inside
  await writeFile(join(r.repo.dir, 'during-admission.txt'), 'new revision\n')
  await r.repo.git('add', 'during-admission.txt')
  await r.repo.git('commit', '-q', '-m', 'advance during admission')
  const advanced = await r.repo.git('rev-parse', 'HEAD')
  assert.equal(await blob(r), shown.digest, 'the checks generation did not change')
  release()

  assert.deepEqual(await admitting, { started: true })
  const [fact] = await settled(r, 1)
  assert.equal((await readFile(join(r.markers, 'head'), 'utf8')).trim(), advanced)
  assert.equal(fact?.fact.kind === 'check' ? fact.fact.at : null, pinned)
  assert.equal(fact?.fact.kind === 'check' && fact.fact.counted, false)
  assert.match(fact?.fact.kind === 'check' ? fact.fact.tail : '', new RegExp(`HEAD moved from ${pinned} to ${advanced}`))
})

test('a HEAD move during a check leaves evidence that is not counted for either revision', async () => {
  const command =
    "printf moved > during.txt && git add during.txt && git -c user.email=dev@example.com -c user.name='Jane Doe' commit -qm moved"
  const r = await rig(`verify: { run: ${command} }\n`)
  const shown = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  const pinned = await r.repo.git('rev-parse', 'HEAD')

  await r.plane.checks.run('room-1', 1, 'verify', answer(shown))
  const [fact] = await settled(r, 1)
  const advanced = await r.repo.git('rev-parse', 'HEAD')
  assert.notEqual(advanced, pinned, 'control: the check itself moved HEAD')
  assert.equal(fact?.fact.kind === 'check' ? fact.fact.at : null, pinned)
  assert.equal(fact?.fact.kind === 'check' && 'digest' in fact.fact ? fact.fact.digest : null, shown.digest)
  assert.equal(fact?.fact.kind === 'check' && 'counted' in fact.fact ? fact.fact.counted : true, false)
  assert.match(fact?.fact.kind === 'check' ? fact.fact.tail : '', new RegExp(`HEAD moved from ${pinned} to ${advanced}`))

  const board = await r.plane.board('room-1')
  assert.deepEqual(board.cards[0]?.facts[0]?.freshness, {
    state: 'unknown',
    why: 'HEAD moved while this check ran, so its result is not counted for either revision.',
  })
})

test('a HEAD move away and back during a check is still not counted', async () => {
  const r = await rig('verify: { run: git checkout -q HEAD^ && git checkout -q - }\n')
  const shown = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  const pinned = await r.repo.git('rev-parse', 'HEAD')

  await r.plane.checks.run('room-1', 1, 'verify', answer(shown))
  const [fact] = await settled(r, 1)
  assert.equal(await r.repo.git('rev-parse', 'HEAD'), pinned, 'control: the check returned to the pinned commit')
  assert.equal(fact?.fact.kind === 'check' && 'counted' in fact.fact ? fact.fact.counted : true, false)
  assert.match(fact?.fact.kind === 'check' ? fact.fact.tail : '', /HEAD moved away from .* and returned while this check ran/)

  const board = await r.plane.board('room-1')
  assert.deepEqual(board.cards[0]?.facts[0]?.freshness, {
    state: 'unknown',
    why: 'HEAD moved while this check ran, so its result is not counted for either revision.',
  })
})

test('an approval does not outlive the file it was given for: a command that changes and changes back asks again', async () => {
  const r = await rig('verify: { run: touch MARKERS/a }\n')
  await r.plane.checks.run('room-1', 1, 'verify', answer(await unseen(r.plane.checks.run('room-1', 1, 'verify'))))
  await settled(r, 1)
  await r.checks('verify: { run: touch MARKERS/b }\n')
  await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  await r.checks('verify: { run: touch MARKERS/a }\n')
  const back = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  // Asked again, as a command it ran before: the answer it had then went with the file it was given for.
  assert.equal(back.check.run, `touch ${r.markers}/a`)
  assert.equal(back.previous, null)
  assert.equal((await r.facts()).length, 1)
})

test('a check the file refuses cannot run, whatever the answer says', async () => {
  const lookalike = 'touch MARKERS/ex\u{430}mple'
  const r = await rig(`verify: { run: ${lookalike} }\n`)
  await assert.rejects(
    r.plane.checks.run('room-1', 1, 'verify', { seen: lookalike.replace('MARKERS', r.markers), digest: await blob(r) }),
    /^Error: verify cannot run: The command holds a character that is not plain printable ASCII/,
  )
  assert.deepEqual(await r.facts(), [])
})

test("a card held in a checkout that is not part of the project runs nothing there", async () => {
  const elsewhere = await makeRepo('hd-check-runs-elsewhere-')
  const r = await rig('verify: { run: touch MARKERS/verify }\n', {
    cards: [card(1, { state: 'claimed', claim: { runtime: runtimeId('fake'), sessionId: 's1', at: 1 } })],
    cwdOf: () => elsewhere.dir,
  })
  await assert.rejects(
    r.plane.checks.run('room-1', 1, 'verify', { seen: `touch ${r.markers}/verify`, digest: await blob(r) }),
    /^Error: #1's checkout, .+, is not part of this project, so its check does not run there\.$/,
  )
  assert.equal(await exists(join(r.markers, 'verify')), false)
  assert.equal(await exists(r.seenFile), false, 'refused before anything was recorded as seen')
})

test('a fact a backup brought never says where a check runs', async () => {
  const r = await rig('where: { run: pwd > MARKERS/where }\n')
  const inside = join(r.repo.dir, 'sub')
  await mkdir(inside)
  const at = await r.repo.git('rev-parse', 'HEAD')
  await r.plane.store.append(await canonical(r.repo.dir), 'evidence', [
    {
      type: 'evidence',
      record: {
        id: 'brought',
        fact: { kind: 'diff', files: 1, added: 1, removed: 0, from: at, to: at },
        card: { board: 'room-1', id: 1 },
        checkout: { cwd: inside, branch: 'main' },
        observedAt: 1,
        restored: { at: 1 },
      },
    },
  ])
  await r.plane.checks.run('room-1', 1, 'where', answer(await unseen(r.plane.checks.run('room-1', 1, 'where'))))
  await settled(r, 1)
  assert.equal((await readFile(join(r.markers, 'where'), 'utf8')).trim(), await canonical(r.repo.dir))
})

test('a room in no repository runs no check, since a check is bound to a commit', async () => {
  const r = await rig('verify: { run: touch MARKERS/verify }\n', { root: tempDir('hd-check-runs-plain-') })
  await assert.rejects(r.plane.checks.run('room-1', 1, 'verify'), /is in no git repository, so no check runs here\.$/)
})

test('one check on a card at a time, whatever its name — even renamed while it runs — and a quit stops it without leaving a fact', async () => {
  const r = await rig('slow: { run: sleep 20 && touch MARKERS/slow }\nquick: { run: touch MARKERS/quick }\n', {
    cards: [card(1), card(2)],
  })
  const ask = await unseen(r.plane.checks.run('room-1', 1, 'slow'))
  await r.plane.checks.run('room-1', 1, 'slow', answer(ask))
  await assert.rejects(r.plane.checks.run('room-1', 1, 'slow'), /^Error: slow is running on #1, and one check runs on a card at a time\.$/)
  // Another check on the same card, approved and all, waits its turn too: they would share one checkout.
  const quick = await unseen(r.plane.checks.run('room-1', 1, 'quick'))
  await assert.rejects(r.plane.checks.run('room-1', 1, 'quick', answer(quick)), /^Error: slow is running on #1, /)
  // Renamed while it runs: the new name is the same checkout, so it waits as well.
  await r.checks('slower: { run: sleep 20 && touch MARKERS/slow }\nquick: { run: touch MARKERS/quick }\n')
  const renamed = await unseen(r.plane.checks.run('room-1', 1, 'slower'))
  await assert.rejects(r.plane.checks.run('room-1', 1, 'slower', answer(renamed)), /^Error: slow is running on #1, /)
  // Another card is another checkout's turn.
  await r.plane.checks.run('room-1', 2, 'quick', answer(await unseen(r.plane.checks.run('room-1', 2, 'quick'))))
  await until(async () => ((await exists(join(r.markers, 'quick'))) ? true : null), 'the other card\'s check')

  await r.plane.close()
  assert.deepEqual(r.plane.running.of('room-1'), [])
  assert.deepEqual(
    (await r.facts()).map((fact) => [fact.card?.id, fact.fact.kind === 'check' ? fact.fact.name : '']),
    [[2, 'quick']],
    'the slow one was stopped by the quit: nothing was observed',
  )
  assert.equal(await exists(join(r.markers, 'slow')), false)
})

test('a quit that begins while a check is still being admitted stops it before it starts, and waits for it', async () => {
  const r = await rig('verify: { run: touch MARKERS/verify }\n')
  await r.plane.checks.run('room-1', 1, 'verify', answer(await unseen(r.plane.checks.run('room-1', 1, 'verify'))))
  await settled(r, 1)
  await rm(join(r.markers, 'verify'))

  // Hold the next call inside its admission, where it asks whether the command is approved.
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const inside = new Promise<void>((resolve) => {
    entered = resolve
  })
  const approved = r.plane.seen.approved.bind(r.plane.seen)
  r.plane.seen.approved = async (...args) => {
    entered()
    await gate
    return approved(...args)
  }
  const admitting = r.plane.checks.run('room-1', 1, 'verify')
  await inside

  let closed = false
  const closing = r.plane.close().then(() => {
    closed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(closed, false, 'the quit waits for the call it caught half-way')
  // Anything asked from now on is refused at once — not held, as the caught call is.
  const late = r.plane.checks.run('room-1', 1, 'verify')
  const waited = new Promise((_, reject) => setTimeout(() => reject(new Error('it was held, not refused')), 1_000))
  await assert.rejects(Promise.race([late, waited]), /^Error: The desk is closing, so no check starts now\.$/)

  release()
  await assert.rejects(admitting, /^Error: The desk is closing, so no check starts now\.$/)
  await closing
  assert.equal(await exists(join(r.markers, 'verify')), false, 'nothing started')
  assert.deepEqual(r.plane.running.of('room-1'), [])
  assert.equal((await r.facts()).length, 1)
})

test('through the host: the refusal reaches the caller with its code and the command, and the wire holds the shape', async (t) => {
  const { host, repo } = await evidenceDesk(t)
  await mkdir(join(repo.dir, '.harnessdesk'))
  await writeFile(join(repo.dir, '.harnessdesk', 'checks.yml'), 'verify: { run: pnpm verify }\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'checks')
  const room = (await host.call('team/room/create', { root: repo.dir, name: 'Checks' })) as TeamState
  await host.call('team/add', { room: room.id, title: 'Fix the build' })
  await unseen(host.call('evidence/check/run', { room: room.id, card: 1, name: 'verify' }))

  const refused = [
    { room: room.id, card: 1, name: '' },
    { room: '', card: 1, name: 'verify' },
    { room: room.id, card: '1', name: 'verify' },
    { room: room.id, card: 1, name: 'verify', seen: 42 },
    { room: room.id, card: 1, name: 'verify', seen: 'pnpm verify', digest: 7 },
  ]
  for (const params of refused) {
    assert.throws(() => parseClientMessage({ id: 1, method: 'evidence/check/run', params }), ValidationError)
  }
})
