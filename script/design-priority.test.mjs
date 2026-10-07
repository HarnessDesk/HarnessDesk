import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compareBaseline, priorityOverrides } from './design-audit.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const reset = '@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0s !important; animation-iteration-count: 1 !important; transition-duration: 0s !important; } }'

test('priority overrides count declarations, including escaped and commented priority', () => {
  assert.deepEqual(priorityOverrides('components/Sample.module.css', String.raw`
    /* color: red !important; */
    .sample { padding: 0 !important; color: inherit ! /**/ IMPORTANT; --local: 1 !\69 mportant; }
    .sample::after { content: '!important'; background: url('!important'); }
  `).map(({ property }) => property), ['padding', 'color', '--local'])
})

test('priority overrides count important Tailwind utilities in class sites', () => {
  const source = '<><div className="!text-danger data-[variant=destructive]:*:[svg]:!text-danger hover:text-warning! data-[open=true]:text-success" />\n'
    + '<span title="!text-danger" />'
    + '</>'
  assert.deepEqual(
    priorityOverrides('design/ui/Probe.tsx', source),
    [
      { property: 'utility', value: '!text-danger' },
      { property: 'utility', value: 'data-[variant=destructive]:*:[svg]:!text-danger' },
      { property: 'utility', value: 'hover:text-warning!' },
    ],
  )
})

test('the vendored dropdown menu has no class-site priority override', () => {
  const source = fs.readFileSync(path.join(repo, 'packages/ui/src/design/ui/dropdown-menu.tsx'), 'utf8')
  assert.deepEqual(priorityOverrides('design/ui/dropdown-menu.tsx', source), [])
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

test('priority category scans global, foundation and class utilities in a scratch checkout', (t) => {
  const zero = Object.fromEntries(Object.keys(JSON.parse(fs.readFileSync('packages/ui/src/design/audit-baseline.json', 'utf8'))).map((key) => [key, 0]))
  assert.equal(compareBaseline({ ...zero, priorityOverride: 1 }, { ...zero, priorityOverride: 0 }).worse, true)
  assert.equal(compareBaseline({ ...zero, priorityOverride: 0 }, { ...zero, priorityOverride: 1 }).worse, true)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-priority-audit-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const file of execFileSync('git', ['ls-files', '-z'], { cwd: repo }).toString().split('\0').filter(Boolean)) {
    const target = path.join(dir, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (
      file.startsWith('script/')
      || file === 'packages/ui/src/styles/app.css'
      || file === 'packages/ui/src/design/foundation/tokens.css'
      || file === 'packages/ui/src/design/ui/dropdown-menu.tsx'
    ) {
      fs.copyFileSync(path.join(repo, file), target)
    } else {
      fs.symlinkSync(path.join(repo, file), target)
    }
  }
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  execFileSync('git', ['init', '-q'], { cwd: dir })

  for (const [file, probe] of [
    ['packages/ui/src/styles/app.css', '\n.priorityProbe { cursor: auto !important; }\n'],
    ['packages/ui/src/design/foundation/tokens.css', '\n.priorityProbe { color: red !important; }\n'],
  ]) {
    const target = path.join(dir, file)
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8') + probe)
  }
  const utilityTarget = path.join(dir, 'packages/ui/src/design/ui/dropdown-menu.tsx')
  fs.writeFileSync(utilityTarget, fs.readFileSync(utilityTarget, 'utf8') + '\nconst priorityProbe = <div className="!text-danger" />;\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })

  const result = spawnSync(process.execPath, ['script/design-audit.mjs', '--strict', '--verbose'], { cwd: dir, encoding: 'utf8' })
  const output = result.stdout + '\n' + result.stderr
  assert.notEqual(result.status, 0)
  assert.match(output, /styles\/app\.css.*cursor.*auto/)
  assert.match(output, /design\/foundation\/tokens\.css.*color.*red/)
  assert.match(output, /design\/ui\/dropdown-menu\.tsx.*!text-danger/)
})
