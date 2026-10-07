import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { compareBaseline, priorityOverrides } from './design-audit.mjs'

const reset = '@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0s !important; animation-iteration-count: 1 !important; transition-duration: 0s !important; } }'

test('priority overrides count declarations, including escaped and commented priority', () => {
  assert.deepEqual(priorityOverrides('components/Sample.module.css', String.raw`
    /* color: red !important; */
    .sample { padding: 0 !important; color: inherit ! /**/ IMPORTANT; --local: 1 !\69 mportant; }
    .sample::after { content: '!important'; background: url('!important'); }
  `).map(({ property }) => property), ['padding', 'color', '--local'])
})

test('only the exact global reduced-motion reset is exempt from priority audit', () => {
  assert.deepEqual(priorityOverrides('styles/app.css', reset), [])
  for (const [css, count] of [
    [reset.replace('animation-duration: 0s', 'animation-duration: 1s'), 1],
    [reset.replace('transition-duration: 0s', 'color: red'), 1],
    [reset.replace('prefers-reduced-motion: reduce', 'prefers-reduced-motion: no-preference'), 3],
    [reset.replace('*, *::before, *::after', '.sample'), 3],
    [`@media (min-width: 800px) { ${reset} }`, 3],
  ]) assert.equal(priorityOverrides('styles/app.css', css).length, count)
  assert.equal(priorityOverrides('design/foundation/tokens.css', reset).length, 3)
})

test('priority category scans global and foundation sheets and rejects a non-zero baseline', () => {
  const zero = Object.fromEntries(Object.keys(JSON.parse(fs.readFileSync('packages/ui/src/design/audit-baseline.json', 'utf8'))).map((key) => [key, 0]))
  assert.equal(compareBaseline({ ...zero, priorityOverride: 1 }, { ...zero, priorityOverride: 0 }).worse, true)
  assert.equal(compareBaseline({ ...zero, priorityOverride: 0 }, { ...zero, priorityOverride: 1 }).worse, true)
  for (const file of ['styles/app.css', 'design/foundation/tokens.css']) {
    const target = path.join('packages/ui/src', file)
    const original = fs.readFileSync(target, 'utf8')
    try {
      fs.writeFileSync(target, `${original}\n.priorityProbe { cursor: auto !important; }\n`)
      const result = spawnSync(process.execPath, ['script/design-audit.mjs', '--strict', '--verbose'], { encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(`${file.replaceAll('.', '\\.')}.*cursor.*auto`))
    } finally { fs.writeFileSync(target, original) }
  }
})
