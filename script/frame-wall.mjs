#!/usr/bin/env node
/**
 * Lays the frame wall's captures out as one page, so a review looks at every
 * destination side by side rather than one screen alone (spec, "How it stays
 * one app"). Reads `<destination>-<width>-<theme>.png` from a directory and
 * writes `index.html` beside them.
 *
 *   node script/frame-wall.mjs output/frame-wall/after
 *   node script/frame-wall.mjs output/frame-wall/after --before ../before
 *
 * `--before` is a path relative to the wall's directory; each frame is then
 * shown next to the frame of the same name there.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = /^(.+)-(\d+)-(light|dark)\.png$/

export const wallOf = (names) => {
  const byDestination = new Map()
  for (const name of names) {
    const match = NAME.exec(name)
    if (!match) continue
    const [, destination, width, theme] = match
    const widths = byDestination.get(destination) ?? new Map()
    const themes = widths.get(Number(width)) ?? {}
    themes[theme] = name
    widths.set(Number(width), themes)
    byDestination.set(destination, widths)
  }
  return [...byDestination.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([destination, widths]) => ({
      destination,
      widths: [...widths.entries()].sort(([a], [b]) => b - a).map(([width, themes]) => ({ width, themes })),
    }))
}

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

export const wallHtml = (wall, { before = null } = {}) => {
  const frame = (name) => name
    ? `<figure><img loading="lazy" src="${escape(name)}" alt="${escape(name)}">${before ? `<img loading="lazy" class="before" src="${escape(`${before}/${name}`)}" alt="before: ${escape(name)}">` : ''}<figcaption>${escape(name)}</figcaption></figure>`
    : '<figure class="missing"><figcaption>not captured</figcaption></figure>'
  const sections = wall.map(({ destination, widths }) => `<section><h2>${escape(destination)}</h2>${widths.map(({ width, themes }) =>
    `<div class="row"><h3>${width}</h3>${frame(themes.light)}${frame(themes.dark)}</div>`).join('')}</section>`).join('\n')
  return `<!doctype html><meta charset="utf-8"><title>Frame wall</title>
<style>
body{font:14px/1.4 system-ui;margin:24px;background:#f4f4f5;color:#18181b}
section{margin-bottom:48px}h2{font-size:16px;margin:0 0 8px}h3{font-size:13px;margin:0;width:48px;flex:none}
.row{display:flex;gap:16px;align-items:flex-start;margin-bottom:16px}
figure{margin:0;display:flex;flex-direction:column;gap:4px}figure img{max-width:720px;border:1px solid #d4d4d8}
figure img.before{opacity:.85;border-style:dashed}figcaption{font-size:12px;color:#71717a}
.missing{width:240px;height:120px;border:1px dashed #a1a1aa;justify-content:center;align-items:center}
</style>
<h1>Frame wall</h1>
${sections}
`
}

const isMain = process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const dir = process.argv[2]
  if (!dir) { console.error('usage: node script/frame-wall.mjs <frames dir> [--before <relative dir>]'); process.exit(2) }
  const at = process.argv.indexOf('--before')
  const before = at > 0 ? process.argv[at + 1] : null
  const wall = wallOf(fs.readdirSync(dir))
  fs.writeFileSync(path.join(dir, 'index.html'), wallHtml(wall, { before }))
  console.log(`wrote ${path.join(dir, 'index.html')}: ${wall.length} destinations`)
}
