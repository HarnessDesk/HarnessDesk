#!/usr/bin/env node
/**
 * HarnessDesk multi-agent review.
 *
 * Opens a real HarnessDesk on a repository, seats one conversation per vendor
 * with the model and effort asked for, puts them in a room together, and hands
 * each of them the same brief with its own signature filled in. Then it stays
 * at the desk: it answers the approvals the agents ask for, watches the
 * channel, and at the end checks GitHub itself for which reviews actually
 * landed rather than believing the agents' own account of it.
 *
 *   node review.mjs                      the pull request open on this branch
 *   node review.mjs 56 53                those pull requests
 *   node review.mjs https://…/pull/56    the same, by link
 *   node review.mjs all                  every open pull request on this repo
 *
 * Options
 *   --cast <spec>     runtime[=model][/effort], comma separated. Replaces the
 *                     default room. `--add <spec>` extends it instead.
 *   --repo <path>     the checkout to review in (default: this folder's repo)
 *   --app <path>      the HarnessDesk checkout to run (default: the skill's own)
 *   --home <path>     HARNESSDESK_HOME (default: ~/.harnessdesk)
 *   --out <path>      where the record is written
 *   --note <text>     an extra paragraph for the brief
 *   --room <name>     what to call the room
 *   --timeout <min>   how long to wait for the reviews
 *   --port <n>        the debugger port to drive (default 9470)
 *   --no-post         review, but publish nothing: reports are written to disk
 *   --rehearse        prove the room, the picks, the hand-out and the approval
 *                     loop with a one-line ask. Publishes nothing.
 *   --build           build the app first, even if it is already built
 *   --keep-open       leave the desk open when the reviews are in
 *   --dry-run         resolve everything, print the plan and the brief, launch
 *                     nothing
 *   --models          open the desk and print what every agent offers — model
 *                     ids and effort levels — then close it again
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { briefFor, evidenceOf, readsAsReport } from './lib/brief.mjs'
import { DEFAULT_CAST, describeCast, parseCast, seatLabel, seatSlugs, signatureFor } from './lib/cast.mjs'
import {
  answerApprovals,
  board,
  closeDesk,
  deskInUse,
  dismissNotices,
  handout,
  launchDesk,
  makeRoom,
  openWorkspace,
  modelsFor,
  optionsOf,
  runtimes,
  seat,
  setSessionOption,
  showRoom,
  sleep,
  splitKey,
} from './lib/desk.mjs'
import { attributionOn, branchStat, hasGh, repoRoot, resolveTargets } from './lib/targets.mjs'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const targetsNamed = argv.filter((arg, index) => {
  if (arg.startsWith('--')) return false
  const before = argv[index - 1]
  return !(before?.startsWith('--') && !['--no-post', '--build', '--keep-open', '--dry-run'].includes(before))
})

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const DRY = has('dry-run')
const REHEARSE = has('rehearse')
/* A rehearsal never publishes: the point of it is the plumbing. */
const POST = !has('no-post') && !REHEARSE
const KEEP = has('keep-open')
const PORT = Number(flag('port', '9470'))
const HOME = resolve(flag('home', process.env['HARNESSDESK_HOME'] ?? `${homedir()}/.harnessdesk`))
/* The app that runs is this skill's own checkout: the skill ships with it, so
   its path is known without being configured, and a review is never driven by
   a build nobody can point at. */
const APP = resolve(flag('app', resolve(here, '../..')))

const say = (line = '') => console.log(line)
const fail = (line) => {
  console.error(`\n${line}\n`)
  process.exit(1)
}

/** The words that go out — one decision, made once, printed by `--dry-run`. */
const wordsFor = (seats = wanted.length) =>
  briefFor({ rehearse: REHEARSE, post: POST, prs: target.prs, branch: target.branch ?? null, note, others: seats - 1 })

// ------------------------------------------------------------------ the plan

if (!(await hasGh())) fail('gh is not installed, and this reads pull requests through it.')

const REPO = await repoRoot(resolve(flag('repo', process.cwd()))).catch(() => null)
if (!REPO) fail(`${flag('repo', process.cwd())} is not inside a git repository.`)

const target = await resolveTargets(targetsNamed, REPO).catch((error) => fail(error.message))
/* What this run is evidenced by — comments on GitHub, signed reports on disk,
   or a signed line in the room. Asked for by the brief, watched for by the
   wait, counted by the closing table: one answer, read in three places, which
   is the whole of what `--no-post` used to get wrong. */
const EVIDENCE = evidenceOf({ rehearse: REHEARSE, post: POST, prs: target.prs })
const wanted = [
  ...(flag('cast') ? parseCast(flag('cast')) : DEFAULT_CAST),
  ...(flag('add') ? parseCast(flag('add')) : []),
]
const note = flag('note')
const OUT = resolve(flag('out', `${HOME}/reviews/${stamp}`))
const ROOM =
  flag('room') ??
  (target.prs.length > 0
    ? `Review — ${target.prs.length > 3 ? `${target.prs.length} pull requests` : target.prs.map((pr) => `#${pr.number}`).join(', ')}`
    : `Review — ${target.branch.name}`)
const MINUTES = Number(flag('timeout', String(Math.min(120, 15 + 10 * Math.max(1, target.prs.length)))))

say(`\nHarnessDesk multi-agent review`)
say(`  repository   ${REPO}`)
say(`  app          ${APP}`)
say(`  desk         ${HOME}`)
say(`  room         ${ROOM}`)
if (target.prs.length > 0) {
  say(`  reviewing    ${target.prs.length} pull request${target.prs.length === 1 ? '' : 's'} (${target.mode})`)
  for (const pr of target.prs) say(`               #${pr.number} ${pr.title}${pr.draft ? ' (draft)' : ''}`)
  say(
    `  publishing   ${
      EVIDENCE === 'comments'
        ? 'one signed comment per reviewer, per pull request'
        : EVIDENCE === 'rehearsal'
          ? 'nothing — this is a rehearsal of the machinery'
          : 'nothing — one signed report per reviewer, written into the record'
    }`,
  )
} else {
  const stat = await branchStat(REPO, target.branch.base).catch(() => '')
  say(`  reviewing    branch ${target.branch.name} against ${target.branch.base}${stat ? ` (${stat})` : ''}`)
  say(`  publishing   nothing — there is no pull request; one signed report per reviewer, in the record`)
}
say(`  record       ${OUT}`)
say(`  waiting      up to ${MINUTES} minutes`)

if (DRY) {
  say(`\n  cast (as asked for; the desk has the last word on models)`)
  for (const one of wanted) say(`               ${one.runtime}${one.model ? ` · ${one.model}` : ''}${one.effort ? ` · ${one.effort}` : ''}`)
  const preview = wordsFor()
  say(`\n--- the brief, as each reviewer will get it ---\n`)
  say(
    preview
      .replace('{{signature}}', '**Review by <agent> <version> (<model>, <effort> effort) via HarnessDesk**')
      .replace('{{report}}', `${OUT}/<agent>.md`),
  )
  say(`\n--- nothing was launched (--dry-run) ---\n`)
  process.exit(0)
}

// ------------------------------------------------------------------ the desk

const held = await deskInUse(HOME)
if (held) {
  fail(
    `HarnessDesk is already running on ${HOME} (pid ${held}).\n` +
      `Two hosts on one desk is two writers on one set of rooms, so this stops here.\n` +
      `Quit that window, or give this run a desk of its own with ` +
      `--home ${homedir()}/.harnessdesk-review (the agents are signed in through their own homes, not this one).`,
  )
}

if (has('build') || !existsSync(`${APP}/packages/ui/dist/index.html`)) {
  say(`\n  building ${APP} …`)
  await run('pnpm', ['build'], { cwd: APP, maxBuffer: 1 << 26 }).catch((error) => {
    fail(`the build failed, so there is nothing honest to review with:\n${error.stdout ?? error.message}`)
  })
}

await mkdir(OUT, { recursive: true })
say(`\n  opening the desk …`)
const desk = await launchDesk({
  app: APP,
  home: HOME,
  port: PORT,
  userDataDir: `${OUT}/chrome`,
  logPath: `${OUT}/app.log`,
})
const { cdp } = desk

let closing = false
const shutdown = async (code) => {
  if (closing) return
  closing = true
  if (!KEEP) await closeDesk(desk)
  else say(`\n  the desk is still open — the room is "${ROOM}".`)
  process.exit(code)
}
process.on('SIGINT', () => {
  say('\n  stopping.')
  void shutdown(130)
})

try {
  await openWorkspace(cdp, REPO)

  /* What this desk actually offers, from the desk. The cast a person writes
     down is only ever as good as this list, and the list belongs to whichever
     agent binary is installed today — a model that has gone missing is nearly
     always an upgrade, not a typo. */
  if (has('models')) {
    for (const row of await runtimes(cdp)) {
      const models = (await modelsFor(cdp, row.id)) ?? []
      say(`\n  ${row.id}  ${row.name}  ${row.drives?.version ?? row.version ?? '(no version)'}`)
      for (const model of models) {
        const levels = (model.reasoningLevels ?? []).map((level) => level.id).join(' ')
        say(`      ${model.id}${model.isDefault ? ' *' : ''}  ${model.displayName}${levels ? `   [${levels}]` : ''}`)
      }
      if (models.length === 0) say('      (no models — is it signed in?)')
    }
    say('')
    await shutdown(0)
  }

  const cast = await describeCast(cdp, wanted)

  say(`\n  seating ${cast.length} reviewer${cast.length === 1 ? '' : 's'} …`)
  const members = []
  /* A name for each seat's own files, decided over the whole cast — three
     Cursor seats are three records, not one written three times. */
  const slugs = seatSlugs(cast)
  for (const [index, one] of cast.entries()) {
    const key = await seat(cdp, { work: REPO, runtime: one.runtime, picks: one.picks })
    const { runtime, sessionId } = splitKey(key)

    /* What the conversation kept, not what it was asked for. A pick the
       runtime declines is dropped rather than refused aloud, so every one is
       read back off the live session and — where the session offers it —
       applied again there, which is the surface that knows its own levels. */
    let options = (await optionsOf(cdp, key)) ?? []
    for (const [id, value] of Object.entries(one.picks)) {
      const option = options.find((entry) => entry.id === id)
      if (option && String(option.currentValue) === String(value)) continue
      if (!option || (option.choices.length > 0 && !option.choices.some((choice) => String(choice.value) === String(value)))) {
        throw new Error(
          `${one.runtime}'s conversation has no ${id} "${value}"` +
            `${option?.choices.length ? ` — it offers: ${option.choices.map((choice) => choice.value).join(', ')}` : ''}. ` +
            (option
              ? 'Nothing is worth signing on that.'
              : `That agent's conversation declares no ${id} control at all, which usually means the bridge is running the copy of the agent embedded in its own SDK rather than the one installed on this machine — give its registry entry an "executable", or run with --models to see what it really offers.`),
        )
      }
      await setSessionOption(cdp, key, id, value)
      /* Changing effort restarts the agent's process on the same conversation,
         so the answer is not there the moment the call returns. */
      let now = null
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await sleep(2000)
        options = (await optionsOf(cdp, key)) ?? []
        now = options.find((entry) => entry.id === id)
        if (String(now?.currentValue) === String(value)) break
      }
      if (String(now?.currentValue) !== String(value)) {
        throw new Error(
          `${one.runtime} would not take ${id} "${value}" — it is running ${JSON.stringify(now?.currentValue ?? null)}. Nothing is worth signing on that.`,
        )
      }
    }

    /* The signature is built from the conversation, not from the cast: the
       runtime's own words for the model it is on and the level it is at. */
    const labelOf = (id) => {
      const option = options.find((entry) => entry.id === id)
      if (!option) return null
      const choice = option.choices.find((entry) => String(entry.value) === String(option.currentValue))
      return choice?.label ?? (option.currentValue == null ? null : String(option.currentValue))
    }
    const modelLabel = labelOf('model') ?? one.modelLabel
    const effortLabel = one.effort ? labelOf('effort') : null
    const signed = signatureFor({ product: one.product, version: one.version, modelLabel, effortLabel })

    say(`               ${one.product} ${one.version ?? '(version unknown)'} · ${modelLabel}${effortLabel ? ` · ${effortLabel} effort` : ''}`)
    if (!one.version) say(`               ⚠︎ no version could be read for ${one.product}; its signature will not carry one`)
    members.push({ ...one, ...signed, slug: slugs[index], modelLabel, effortLabel, key, sessionId, runtime, ran: Object.fromEntries(options.map((entry) => [entry.id, entry.currentValue])) })
  }

  /* What to call a reviewer in a line of running output. The product alone is
     a row on the desk, and two seats on one agent are the same row twice. */
  for (const member of members) {
    member.short =
      members.filter((other) => other.product === member.product).length > 1
        ? `${member.product} · ${member.modelLabel}`
        : member.product
  }

  /* Two seats that resolved to the same agent, model and effort sign the same
     line. Each still has to post a comment of its own to be counted — the
     evidence check matches reviewers to *comments*, one apiece — but nothing
     afterwards can say which of them wrote which, so the record names them by
     seat and cannot tell you more than that. Said before anything is spent,
     because it is the kind of thing a person would rather change than learn. */
  const signing = new Map()
  for (const member of members) signing.set(member.mark, [...(signing.get(member.mark) ?? []), member])
  for (const [mark, group] of signing) {
    if (group.length < 2) continue
    say(
      `\n  note: ${group.length} seats sign the same line (${mark}).` +
        `\n        All ${group.length} comments are still required for the run to pass, but which` +
        `\n        seat wrote which is a guess — give them different models or efforts to tell.`,
    )
  }

  const room = await makeRoom(cdp, { work: REPO, name: ROOM, members })
  await showRoom(cdp, room)
  await dismissNotices(cdp)
  say(`  the room is open: ${ROOM}`)

  const reportOf = (member) => `${OUT}/${member.slug}.md`
  /* The reading of what comes back, split exactly where `briefFor` is split:
     each brief closes by asking for something different, and the wait has to
     be looking for the thing this one asked for. A run whose reviews go to
     disk closes by asking for the path, whether or not there is a pull
     request behind it. */
  const isReport = (text, member) =>
    readsAsReport(text, {
      rehearsal: REHEARSE,
      prs: target.prs,
      report: EVIDENCE === 'files' ? reportOf(member) : null,
    })
  const template = wordsFor(members.length)
  const recipients = members.map((member) => ({
    runtime: member.runtime,
    sessionId: member.sessionId,
    vars: { signature: member.signature, agent: member.product, report: reportOf(member) },
  }))

  await writeFile(
    `${OUT}/plan.json`,
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        repo: REPO,
        app: APP,
        home: HOME,
        room: { id: room, name: ROOM },
        mode: target.mode,
        prs: target.prs,
        branch: target.branch ?? null,
        posting: POST,
        evidence: EVIDENCE,
        cast: members.map(({ key, ...rest }) => rest),
        template,
      },
      null,
      1,
    ),
  )

  const since = new Date(Date.now() - 5000).toISOString()
  const sent = await handout(cdp, room, template, recipients)
  say(`\n  brief handed out: ${sent.delivered} delivered, ${sent.queued} queued, ${sent.refused} refused`)
  if (sent.refused > 0) fail('a reviewer never got the brief; there is nothing to wait for.')

  // ---------------------------------------------------------------- the wait
  //
  // What finishes the wait is the *evidence*, not the conversation. An agent
  // that says "done, posted" has not necessarily posted, and a run that stops
  // on the last reply reports a success it never checked. So where there is
  // something to check — comments on a pull request — GitHub is asked, once a
  // minute; the channel only shortens the wait once everyone has *reported*.
  //
  // Reported, not spoken. Three facts are kept apart below, and conflating
  // the first two is what cost the round of 2026-09-07: a seat that has said
  // something, a seat that has delivered the report its brief asked for, and
  // a seat whose comment GitHub can be seen to be carrying. Only the last two
  // end a seat's wait — an agent thinking out loud is an agent still working,
  // and the brief tells every one of them to write its signature, so nothing
  // about a message merely existing says the reading is over.
  const deadline = Date.now() + MINUTES * 60_000
  const seen = new Set()
  let approvals = 0
  const asked = new Map()
  const replied = new Set()
  const reported = new Set()
  const posted = new Set()
  const finished = () => new Set([...reported, ...posted])
  /* A member the room says has stopped — its usage window ran out, its
     sign-in lapsed, its turn died. Waiting out a deadline for one of those is
     how a run takes ninety minutes to report a failure it knew about in ten. */
  const stopped = new Map()
  let grace = null
  let checkedAt = 0
  let landed = false

  say(`\n  working. Approvals are answered here; questions are left for you.\n`)
  for (;;) {
    const { answered, asking } = await answerApprovals(cdp).catch(() => ({ answered: [], asking: [] }))
    approvals += answered.length
    for (const one of asking) {
      if (asked.has(one.id)) continue
      asked.set(one.id, one)
      say(`  ？ ${one.type} needs a person: ${String(one.what ?? '').slice(0, 120)}`)
    }
    const state = await board(cdp, room).catch(() => null)
    for (const entry of state?.channel ?? []) {
      if (seen.has(entry.id)) continue
      if (entry.kind === 'notice') {
        seen.add(entry.id)
        const who = members.find((m) => m.sessionId === entry.about?.sessionId)
        stopped.set(entry.about?.sessionId, { cause: entry.cause, text: entry.text })
        say(`  ✗ ${who?.short ?? entry.about?.nickname ?? 'a reviewer'} stopped — ${entry.cause}: ${entry.text}`)
        continue
      }
      if (entry.kind !== 'message') continue
      seen.add(entry.id)
      if (entry.from?.kind !== 'agent') continue
      const who = members.find((m) => m.sessionId === entry.from.sessionId)
      replied.add(entry.from.sessionId)
      const its = Boolean(who) && isReport(entry.text, who)
      if (its) reported.add(entry.from.sessionId)
      const line = String(entry.text ?? '').replace(/\s+/g, ' ').trim()
      /* ✓ this one answered the brief; → this one was talking. The difference
         is the whole fix, so it is on the screen while the run is happening
         rather than only in the closing table. */
      say(`  ${its ? '✓' : '→'} ${who?.short ?? entry.from.nickname ?? entry.from.runtime}: ${line.slice(0, 300)}${line.length > 300 ? '…' : ''}`)
    }
    if (EVIDENCE === 'comments' && Date.now() - checkedAt > 60_000) {
      checkedAt = Date.now()
      const found = await Promise.all(
        /* One comment per member and one member per comment, so this is a
           count of reviews and not of matching strings. The failure returns a
           row of nulls rather than an empty array: `every` over nothing is
           true, and a GitHub that cannot be read must never end the wait. */
        target.prs.map((pr) => attributionOn(pr, since, members, REPO).catch(() => members.map(() => null))),
      )
      /* A seat whose comment is on every pull request under review has
         finished, whatever it did or did not say in the room. The evidence is
         what this skill trusts; a seat still owing the channel a sentence is
         not a seat still owing anyone a review. */
      for (const [index, member] of members.entries()) {
        if (found.every((row) => row[index])) posted.add(member.sessionId)
      }
      landed = found.every((row) => row.every(Boolean))
      if (landed) say(`  ✓ every reviewer's comment is on every pull request`)
    } else if (EVIDENCE === 'files' && Date.now() - checkedAt > 60_000) {
      checkedAt = Date.now()
      /* A review written to disk is evidenced by the file it was told to
         write — a branch, or a pull request under `--no-post` — and the same
         rule applies to it: a seat whose signed report is on disk has
         finished, whatever it did or did not say in the room. */
      for (const member of members) {
        const written = await readFile(reportOf(member), 'utf8').catch(() => null)
        if (written?.includes(member.mark)) posted.add(member.sessionId)
      }
    }
    if (landed) break
    /* Everyone has either answered or stopped: there is nobody left to wait
       for, whatever the clock says. */
    const done = finished()
    if (members.every((member) => done.has(member.sessionId) || stopped.has(member.sessionId))) {
      /* Nobody left to wait for. Give the last comment a few minutes to appear
         on GitHub rather than waiting out a deadline set for the reading —
         and say what actually happened, because "all three reported" over two
         answers and one agent that ran out is the same silence in a new
         place. */
      if (grace === null) {
        grace = Date.now() + 180_000
        if (EVIDENCE !== 'comments') break
        say(
          `  ${done.size} reported${stopped.size > 0 ? `, ${stopped.size} stopped` : ''}` +
            ` — nobody left to wait for; checking GitHub for a few minutes more`,
        )
      }
      if (Date.now() > grace) break
    }
    if (Date.now() > deadline) {
      /* Which kind of silence it was. "2 of 3 back" over a reviewer that had
         been talking all along reads as an agent that died; it was reading. */
      const talking = members.filter((one) => !done.has(one.sessionId) && replied.has(one.sessionId)).length
      say(
        `\n  the clock ran out with ${done.size} of ${members.length} reported` +
          `${talking > 0 ? `; ${talking} still working` : ''}.`,
      )
      break
    }
    await sleep(4000)
  }

  // ------------------------------------------------------------- the evidence
  const state = (await board(cdp, room)) ?? { channel: [] }
  await writeFile(`${OUT}/room.json`, JSON.stringify(state, null, 1))
  for (const member of members) {
    const said = state.channel
      .filter((entry) => entry.kind === 'message' && entry.from?.kind === 'agent' && entry.from.sessionId === member.sessionId)
      .map((entry) => entry.text)
      .join('\n\n')
    await writeFile(`${OUT}/${member.slug}.channel.md`, `${member.signature}\n\n${said || '(said nothing in the room)'}\n`)
  }

  say(`\n  what landed`)
  /* Whatever each mode's evidence is — a comment on GitHub, a signed report
     on disk, a signed line in the room — a seat that produced it has
     finished, and the summary below counts it whether or not it ever said so
     in the channel. The room can only add to this; it cannot answer for it. */
  let missing = 0
  if (EVIDENCE === 'comments') {
    const evidence = {}
    /* How many of the pull requests each seat is signed on, over this last
       read. A comment that landed in the final seconds of the wait must not
       leave the table saying `3/3 signed` above a summary saying two
       reviewers reported back. */
    const landedFor = members.map(() => 0)
    for (const pr of target.prs) {
      /* A read that failed is not an absence of reviews, and saying so is the
         difference between "nobody posted" and "nobody looked". */
      const failed = []
      const found = await attributionOn(pr, since, members, REPO).catch((error) => {
        failed.push(error.message)
        return members.map(() => null)
      })
      evidence[pr.url] = members.map((member, index) => ({
        seat: member.slug,
        who: seatLabel(member),
        signature: member.signature,
        comment: found[index],
      }))
      found.forEach((one, index) => {
        if (one) landedFor[index] += 1
      })
      const signed = found.filter(Boolean).length
      missing += members.length - signed
      say(
        `    #${pr.number}  ${signed}/${members.length} signed` +
          `${failed.length > 0 ? ` — GitHub could not be read: ${failed[0]}` : ''}`,
      )
      /* By seat, with its model and its effort. The product on its own was
         what printed "missing: Cursor, Cursor, Cursor" and named nobody. */
      for (const [index, member] of members.entries()) {
        const comment = found[index]
        say(
          `           ${comment ? '✓' : '✗'} ${seatLabel(member)}` +
            `${comment?.how === 'mark' ? '  (its mark; the full signature was reformatted)' : ''}`,
        )
      }
    }
    for (const [index, member] of members.entries()) {
      if (landedFor[index] === target.prs.length) posted.add(member.sessionId)
    }
    await writeFile(`${OUT}/evidence.json`, JSON.stringify({ since, evidence }, null, 1))
  } else if (EVIDENCE === 'rehearsal') {
    for (const member of members) {
      const said = state.channel
        .filter((entry) => entry.kind === 'message' && entry.from?.kind === 'agent' && entry.from.sessionId === member.sessionId)
        .map((entry) => entry.text)
        .join('\n')
      const signed = said.includes(member.mark)
      if (!signed) missing += 1
      else posted.add(member.sessionId)
      say(`    ${seatLabel(member)}  ${said ? (signed ? 'answered, signed' : 'answered without its signature') : 'never answered'}`)
    }
  } else {
    for (const member of members) {
      const path = reportOf(member)
      const text = await readFile(path, 'utf8').catch(() => null)
      const signed = text?.includes(member.mark) ?? false
      if (!signed) missing += 1
      else posted.add(member.sessionId)
      say(`    ${seatLabel(member)}  ${text ? `${signed ? 'signed' : 'unsigned'} report at ${path}` : 'no report written'}`)
    }
  }
  const done = finished()
  for (const member of members) {
    const gone = stopped.get(member.sessionId)
    if (gone) {
      say(`    ${seatLabel(member)}  stopped before it finished — ${gone.cause}: ${gone.text}`)
      continue
    }
    /* The 2026-09-07 seat, named. It had been talking in the room the whole
       time; what it never did was report, and "never answered" would have
       been the wrong thing to tell anyone about it. */
    if (!done.has(member.sessionId) && replied.has(member.sessionId)) {
      say(`    ${seatLabel(member)}  spoke in the room but never reported — it was still working`)
    }
  }
  say(`\n  ${done.size}/${members.length} reviewers reported back · ${approvals} approvals answered${stopped.size > 0 ? ` · ${stopped.size} stopped` : ''}${asked.size > 0 ? ` · ${asked.size} question(s) left for you` : ''}`)
  say(`  the record is in ${OUT}`)
  say(`  the room is "${ROOM}" on ${HOME} — open HarnessDesk to read it.\n`)

  await shutdown(missing > 0 || done.size < members.length ? 1 : 0)
} catch (error) {
  console.error(`\n  ${error?.stack ?? error}\n`)
  await shutdown(1)
}
