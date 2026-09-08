/**
 * Who is reviewing, on what, and what each of them signs.
 *
 * A review is worth reading because of who wrote it, so the signature is not
 * left to the model: the agent's name, the version of the software actually
 * running, the model and the level of effort are all read out of the desk and
 * handed to each reviewer as a finished line to copy.
 */
import { spawn } from 'node:child_process'

import { modelsFor, runtimes } from './desk.mjs'

/**
 * The default room: three labs' strongest reasoning models, all seated through
 * Cursor (user's choice, 2026-09-07).
 *
 * It used to be one seat per *vendor* — Claude Code, Codex and Cursor, each
 * driving its own CLI — and that is a real property this trades away: three
 * harnesses reading a diff three ways is what produced the round where all
 * three independently found the same half-applied fix. Here the harness, the
 * tooling and the approval behaviour are one vendor's, and only the model
 * differs. What it buys is the model spread — Codex 5.3 at extra-high, Opus
 * 4.6 at max, Gemini 3.8 Flash at high — with no second CLI to keep signed in
 * and no second vendor's rate limit to run into mid-round.
 *
 * Three seats on one runtime is a shape the rest of this file already
 * supports: each has to post a comment of its own to be counted, and because
 * no two share both a model and an effort, every signature is distinct and the
 * record can say which of them wrote what. `seatSlugs` names them
 * `cursor-gpt-5-3-codex-xhigh` and so on.
 *
 * Gemini 3.8 Flash is Cursor's free model, which is why the cheap seat is
 * still the one that reads the most pull requests in `all` mode — and on the
 * round that set this default it was also the only seat to request changes,
 * with two defects the two expensive ones missed.
 *
 * Measured against the desk on 2026-09-07 (cursor-agent 2026.09.02-c22c1a3).
 * Model ids follow the binary: check `--models` before editing this list.
 */
export const DEFAULT_CAST = [
  { runtime: 'cursor', model: 'gpt-5.3-codex', effort: 'xhigh' },
  { runtime: 'cursor', model: 'claude-4.6-opus', effort: 'max' },
  { runtime: 'cursor', model: 'gemini-3.8-flash', effort: 'high' },
]

/**
 * What the agent's own vendor calls it.
 *
 * The desk names a *row* — "Claude", because the account is the unit there —
 * and a review signed "Claude" would not say which of Anthropic's things
 * wrote it. These are the product names their own CLIs print.
 */
const PRODUCT = {
  'claude-code': 'Claude Code',
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  dsh: 'DeepSeek',
  opencode: 'OpenCode',
  cline: 'Cline',
  kimi: 'Kimi CLI',
  grok: 'Grok',
}

/** `runtime`, `runtime=model`, `runtime=model/effort`, `runtime/effort`. */
export const parseCast = (spec) =>
  spec
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean)
    .map((one) => {
      const [head, effort = null] = one.split('/')
      const [runtime, model = null] = head.split('=')
      return { runtime: runtime.trim(), model: model?.trim() ?? null, effort: effort?.trim() ?? null }
    })

/**
 * `claude --version` and friends, when the desk has no version of its own.
 *
 * Never `execFile` with a timeout: a Homebrew-cask `cursor-agent` hangs on
 * `--version`, ignores SIGTERM, and once held a whole catalogue for eleven
 * minutes. The process gets its own group and the group gets SIGKILL.
 */
export const probeVersion = (command, args = ['--version'], ms = 8000) =>
  new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    const done = (value) => {
      clearTimeout(timer)
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
      resolve(value)
    }
    const timer = setTimeout(() => done(null), ms)
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('error', () => done(null))
    child.on('close', () => done(out.trim().split('\n')[0] || null))
  })

/** `2.1.259 (Claude Code)` becomes `2.1.259`; anything without a triple is kept whole. */
export const versionIn = (printed) => {
  if (!printed) return null
  const match = /\d+[\d.]*\d(?:[-+][\w.]+)?/.exec(printed)
  return match ? match[0] : printed.trim() || null
}

/**
 * The cast, resolved against the desk that is actually running.
 *
 * Every refusal here is loud and names what the desk does offer. A model that
 * has gone missing is nearly always a stale agent binary rather than a typo,
 * and the version in the reviewer's own signature is what makes that visible
 * afterwards.
 */
export const describeCast = async (cdp, wanted) => {
  const rows = await runtimes(cdp)
  const members = []
  for (const one of wanted) {
    const row = rows.find((r) => r.id === one.runtime)
    if (!row) {
      // A desk of its own is empty of everything the default desk was told
      // about: the roster lives in `agents.json` under `HARNESSDESK_HOME`, and
      // without it only the built-in agent is registered. `--models` reads the
      // desk it opens, so it says four agents on the real desk and one here,
      // which reads as the cast being wrong rather than the home being new.
      throw new Error(
        `this desk has no agent called "${one.runtime}" — it has: ${rows.map((r) => r.id).join(', ')}.
` +
          `  A desk of its own starts with no agent roster. Copy the one you use:
` +
          `    cp ~/.harnessdesk/agents.json <this desk>/agents.json
` +
          `  (the agents stay signed in through their own homes; only the list of them lives here)`,
      )
    }
    const models = (await modelsFor(cdp, one.runtime)) ?? []
    const wantedModel = one.model ?? models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? null
    const model = models.find((m) => m.id === wantedModel) ?? null
    if (one.model && !model) {
      throw new Error(
        `${one.runtime} has no model "${one.model}". It offers: ${models.map((m) => m.id).join(', ') || '(nothing — is it signed in?)'}`,
      )
    }
    /* Effort is only refused here when the catalogue is in a position to
       refuse it. A bridge that declares its levels per session has none to
       show before one exists — a cold desk lists Claude Code's models with no
       levels at all — and refusing then would refuse a level the conversation
       goes on to accept. The live session is asked instead, once it exists. */
    const levels = model?.reasoningLevels ?? []
    const level = one.effort ? levels.find((l) => l.id === one.effort) : null
    if (one.effort && !level && levels.length > 0) {
      throw new Error(
        `${one.runtime}'s ${model?.displayName ?? wantedModel} has no effort level "${one.effort}" — it has: ${levels.map((l) => l.id).join(', ')}`,
      )
    }
    const printed = row.drives?.version ?? row.version ?? (await probeVersion(row.drives?.command ?? one.runtime))
    const version = versionIn(printed)
    const product = PRODUCT[one.runtime] ?? row.name
    const modelLabel = model?.displayName ?? wantedModel ?? 'default model'
    members.push({
      runtime: one.runtime,
      product,
      version,
      model: wantedModel,
      modelLabel,
      effort: one.effort ?? null,
      effortLabel: level?.label ?? null,
      picks: {
        ...(wantedModel ? { model: wantedModel } : {}),
        ...(one.effort ? { effort: one.effort } : {}),
      },
    })
  }
  return members
}

/**
 * What a reviewer signs with, from what its conversation is actually running.
 *
 * Built after the session exists rather than from the cast that was asked for,
 * because those are two different facts and only one of them is true.
 */
export const signatureFor = ({ product, version, modelLabel, effortLabel }) => {
  const parts = [modelLabel, ...(effortLabel ? [`${effortLabel} effort`] : [])].filter(Boolean)
  const who = `Review by ${product}${version ? ` ${version}` : ''}`
  return {
    signature: `**${[who, ...parts, 'via HarnessDesk'].join(' · ')}**`,
    /**
     * What proves *this* reviewer wrote something.
     *
     * The model and the effort are in it, and they have to be: two seats on
     * one agent share a product and a version, so a mark built from those
     * alone is the same string for both. Everything after the effort is still
     * tolerated, because the tail is the part a model is most likely to
     * reformat and it identifies nobody — which is what makes the mark the
     * fallback `attribute` reaches for when the full signature does not
     * appear verbatim.
     *
     * A distinct mark is no longer what makes the count honest, though it
     * still makes it *attributable*: `attribute` gives one comment to one
     * member whatever the marks say, so seats that are identical in all three
     * are each counted only if each posted. What their sameness costs is the
     * naming — which of them wrote which comment — and the run says so up
     * front rather than in the closing table.
     */
    mark: parts.length > 0 ? `${who} · ${parts.join(' · ')}` : who,
  }
}

/**
 * One seat, in the words its own review is signed with.
 *
 * The product alone names a *row* on the desk, and three seats on one agent
 * are three identical rows: a closing table reading "missing: Cursor, Cursor,
 * Cursor" names nobody, which is precisely what it printed. The model and the
 * effort are what tell seats apart, so they are what a line about a seat
 * carries.
 */
export const seatLabel = ({ product, version, modelLabel, effortLabel }) =>
  [`${product}${version ? ` ${version}` : ''}`, modelLabel, effortLabel ? `${effortLabel} effort` : null]
    .filter(Boolean)
    .join(' · ')

/**
 * A filename for each seat's own record, unique within the cast.
 *
 * The record used to be written per *runtime* — `cursor.channel.md` — so three
 * Cursor seats wrote one file three times and only the last one's survived.
 * The run of 2026-09-07 left a three-line file saying "(said nothing in the
 * room)" where three reviews should have been.
 *
 * A lone runtime keeps its plain name, because `codex.md` is what a person
 * looks for; a runtime seated twice takes the model and the effort with it,
 * and a cast that repeats itself exactly is numbered, since a name that is
 * merely *unlikely* to collide is the shape of bug being fixed here.
 */
export const seatSlugs = (seats) => {
  const clean = (text) =>
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  const names = seats.map((seat) =>
    seats.filter((other) => other.runtime === seat.runtime).length > 1
      ? [seat.runtime, seat.model, seat.effort].map(clean).filter(Boolean).join('-')
      : clean(seat.runtime),
  )
  const numbered = names.map((name, index) =>
    names.filter((other) => other === name).length > 1
      ? `${name}-${names.slice(0, index).filter((other) => other === name).length + 1}`
      : name,
  )
  /* And then made unique for real. Numbering a repeated seat `-1`, `-2` can
     land on a name another seat already had — a cast of two `gemini` seats
     beside one `gemini-1` gives two `cursor-gemini-1`s — and a name that is
     merely *unlikely* to collide is the shape of bug this file is fixing. */
  const used = new Set()
  return numbered.map((name) => {
    let slug = name
    for (let next = 2; used.has(slug); next += 1) slug = `${name}-${next}`
    used.add(slug)
    return slug
  })
}
