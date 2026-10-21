import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as imports from './ci-imports.mjs'
import { devServerSpecs, splitServerSpecs } from './ci-server-split.mjs'

const fixture = (files, run) => {
  const root = mkdtempSync(join(tmpdir(), 'ci-imports-'))
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

for (const comment of [
  "// readFileSync('docs/comment-only.md', 'utf8')",
  "/* readFileSync('docs/comment-only.md', 'utf8') */",
  "// import '../docs/comment-only.mjs'",
  "/* new URL('../docs/comment-only.md', import.meta.url) */",
]) {
  test(`repository readers ignore comment literals: ${comment}`, () => {
    fixture({
      'e2e/ui-system/example.spec.ts': "import '../../script/reader.mjs'",
      'script/reader.mjs': `${comment}\nreadFileSync('docs/actual.md', 'utf8')`,
      'docs/actual.md': 'contract',
      'docs/comment-only.md': 'comment',
      'docs/comment-only.mjs': 'export {}',
    }, root => {
      const graph = imports.repositoryGraph(root)
      assert.equal(graph.importers.has(join(root, 'docs/comment-only.md')), false)
      assert.equal(graph.importers.has(join(root, 'docs/comment-only.mjs')), false)
      assert.deepEqual(imports.specsReaching(graph, [join(root, 'docs/actual.md')]), [join(root, 'e2e/ui-system/example.spec.ts')])
    })
  })
}

test('repository readers follow a URL inside a generated executable template', () => {
  fixture({
    'e2e/ui-system/example.spec.ts': "import '../../script/reader.mjs'",
    'script/reader.mjs': "writeFileSync(executable, `#!/usr/bin/env node\\nawait import('${new URL('./generated.mjs', import.meta.url).href}')\\n`)",
    'script/generated.mjs': 'export {}',
  }, root => {
    assert.deepEqual(imports.specsReaching(imports.repositoryGraph(root), [join(root, 'script/generated.mjs')]), [join(root, 'e2e/ui-system/example.spec.ts')])
  })
})

const patterns = [
  "await page.evaluate(async () => import('/src/state/store.ts'))",
  "const modulePath = '/src/state/store.ts'; await page.evaluate(() => import(/* @vite-ignore */ modulePath))",
  "await page.route('**/src/preview/main.tsx*', route => route.fetch())",
  "await page.route('**/lib/flow-model.ts', route => route.fetch())",
  "await page.route('**/run-shapes-fixture.ts', route => route.fetch())",
  "await import('/@fs/workspace/helper.ts')",
  "await import('/@vite/client')",
  "await import('/@id/helper')",
  "await fetch('/node_modules/.vite/deps/helper.js')",
  "await page.goto('/site-demo/index.html?view=hero')",
  "await page.evaluate(() => import('/some-new-module.js'))",
  'if (import.meta.hot) import.meta.hot.accept()',
  "await page.goto('/other.html')",
  "await page.goto('/new-server-route')",
  'await page.goto(unknownURL)',
  'await page.evaluate(() => import(unknownModule))',
  "await page.goto('/preview.html' + unknownSuffix)",
  "await fetch('/new-server-route')",
  "await page.request.get('/new-server-route')",
  "await page.route(unknownRoute, r => r.fulfill({ body: '' }))",
  "await page.addScriptTag({ url: '/new-helper.js' })",
  "const url = '/preview.html' + '/other.html'; await page.goto(url)",
  'await page.goto(`/preview${unknown}.html`)',
  'await page.goto(`${unknown}/preview.html`)',
  'await page.goto(makeURL())',
  "const url = '/preview.html'; async function open(url) { await page.goto(url) }",
  "const url = '/preview.html'; for (const url of pages) { await page.goto(url) }",
  "const { url } = '/preview.html'; await page.goto(url)",
  "const pattern = '**/*.ts'; await page.route(pattern, r => r.fulfill({ body: '' }))",
  "await page.route('**/*', r => r.fulfill({ body: '' }))",
  "await page.route(/anything/, r => r.fulfill({ body: '' }))",
  "await page.route(/module|\\.png$/, r => r.fulfill({ body: '' }))",
  "await page.route(/.*|\\/preview-frame\\?ticket=x$/, r => r.fulfill({ body: '' }))",
  "await page.addScriptTag({ type: 'module', url: 'helper.js' })",
  "await page.addStyleTag({ content: '', url: 'helper.css' })",
  "await page.addScriptTag({ path: '/src/helper.js' })",
  "await page.addStyleTag({ path: '/src/helper.css' })",
  "const options = { content: '' }; await page.addStyleTag(options)",
  "test.use({ serviceWorkers: 'allow' })",
  "test.use({ 'serviceWorkers': 'allow' })",
  'navigator.serviceWorker.ready',
  "registerServiceWorker('worker.js')",
  'context.serviceWorkers()',
  "context.route('**/api/**', r => r.fulfill({ body: '' }))",
  "browserContext.route('**/*.png', r => r.fulfill({ body: '' }))",
  "page.routeFromHAR('fixture.har')",
  "context.addInitScript(async () => { await import('https://example.com/helper.js') })",
  'context.addInitScript(unknownScript)',
  'context.addInitScript({ content: unknownScript })',
]

for (const pattern of patterns) {
  test(`a future dev dependency cannot be classified static: ${pattern}`, () => {
    fixture({
      'e2e/ui-system/a.spec.ts': "import './first'\n",
      'e2e/ui-system/first.ts': "import './second'\n",
      'e2e/ui-system/second.ts': pattern,
      'e2e/ui-system/plain.spec.ts': "await page.goto('/preview.html?theme=dark')\n",
    }, root => assert.deepEqual(devServerSpecs(root), ['a.spec.ts']))
  })
}

test('the built pages, constant routes, relative source imports and fulfilled API routes are static-safe', () => {
  fixture({
    'e2e/ui-system/a.spec.ts': `import './helper'
const route = '/design.html?view=propagation'
await page.goto(route)
await page.goto('/narrow-overlay.html')
await page.goto('about:blank')
await page.route('**/fixture.json', route => route.fulfill({ json: {} }))`,
    'e2e/ui-system/helper.ts': "await page.goto(`${origin}/preview.html?theme=${theme}`)",
  }, root => assert.deepEqual(devServerSpecs(root), []))
})

test('literal API and asset routes, fixed query templates and content-only injection stay static', () => {
  fixture({ 'e2e/ui-system/a.spec.ts': `
const route = '/design.html?view=propagation'
await page.goto(route, { waitUntil: 'load' })
await page.goto(\`/preview.html?theme=\${theme}\`)
await page.route('**/api/**', r => r.fulfill({ body: '' }))
await page.route('**/*.png', r => r.fulfill({ body: '' }))
await page.route(/\\/preview-frame\\?ticket=frame-preview-[^&]*$/, r => r.fulfill({ body: '' }))
await page.addStyleTag({ content: css })
await page.addScriptTag({ content: script })
await context.addInitScript(() => { window.fixture = true })
` }, root => assert.deepEqual(devServerSpecs(root), []))
})

test('unknown specs and unreadable helpers use dev, with a stable partition of the supplied list', () => {
  fixture({
    'e2e/ui-system/a.spec.ts': "import './helper'\n",
    'e2e/ui-system/helper.ts': 'export {}',
    'e2e/ui-system/b.spec.ts': "await page.goto('/preview.html')",
  }, root => {
    const graph = imports.suiteGraph(root)
    rmSync(join(root, 'e2e/ui-system/helper.ts'))
    assert.deepEqual(devServerSpecs(root, graph), ['a.spec.ts'])
    const specs = ['e2e/ui-system/b.spec.ts', 'a.spec.ts', 'unknown.spec.ts']
    assert.deepEqual(splitServerSpecs(root, specs, graph), {
      static: ['e2e/ui-system/b.spec.ts'], dev: ['a.spec.ts', 'unknown.spec.ts'],
    })
  })
})

test('an unresolved suite graph stays conservative', () => {
  fixture({ 'e2e/ui-system/a.spec.ts': "import './missing'" }, root => {
    assert.deepEqual(devServerSpecs(root), ['a.spec.ts'])
  })
})

test('an external helper is followed transitively, and a missing edge stays on dev', () => {
  fixture({
    'e2e/ui-system/a.spec.ts': "import '../../script/first.mjs'",
    'script/first.mjs': "import './second.mjs'",
    'script/second.mjs': "await page.goto('/new-server-route')",
  }, root => {
    assert.deepEqual(devServerSpecs(root), ['a.spec.ts'])
    rmSync(join(root, 'script/second.mjs'))
    assert.deepEqual(devServerSpecs(root), ['a.spec.ts'])
  })
})

test('every real spec belongs to exactly one group, in input order', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const graph = imports.suiteGraph(root)
  const specs = graph.sources.filter(file => imports.SPEC.test(file))
  const split = splitServerSpecs(root, specs, graph)
  assert.equal(split.static.length + split.dev.length, specs.length)
  assert.equal(new Set([...split.static, ...split.dev]).size, specs.length)
  for (const group of Object.values(split)) assert.deepEqual(group, specs.filter(spec => group.includes(spec)))
  for (const name of ['conversation-map', 'capability-lists', 'compact-inspectors', 'archive-worktrees', 'alignment-census', 'side-by-side']) {
    assert.ok(split.static.some(file => file.endsWith(`/${name}.spec.ts`)), name)
  }
  assert.ok(split.dev.some(file => file.endsWith('/preview-coverage.spec.ts')))
  for (const name of ['detail-head', 'flow-canvas-repairs', 'run-shapes', 'demo-resources', 'usage-tables', 'focus-ring', 'focus-ring-frames', 'frame-contract-palette', 'run-check-again', 'tables-family', 'git-log']) {
    const file = specs.find(file => file.endsWith(`/${name}.spec.ts`))
    assert.ok(file, `${name} exists`)
    assert.ok(split.dev.includes(file), name)
  }
})

test('non-test UI source names only built pages and no dev-server module URLs', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const ui = join(root, 'packages/ui')
  const entries = new Set(imports.E2E_PAGES.map(page => join(ui, page)))
  const files = new Set([...imports.walk(join(ui, 'src')), ...entries])
  const hits = [], failures = []
  for (const file of files) {
    if (/\.(?:test|spec)\./.test(file) || !/\.(?:[cm]?[jt]sx?|html|css)$/.test(file)) continue
    const text = readFileSync(file, 'utf8')
    const entryScripts = entries.has(file) ? [...text.matchAll(/<script\b[^>]*\ssrc\s*=\s*['"]([^'"]+)['"][^>]*>/g)]
      .map(script => ({ start: script.index + script[0].indexOf(script[1]), length: script[1].length })) : []
    for (const match of text.matchAll(/['"`]((?:\/src\/[^'"`\s?#]+)|\/(?:design|preview|narrow-overlay)\.html|\/(?:@fs|@vite|site-demo)\/[^'"`\s?#]*)/g)) {
      if (entryScripts.some(script => match.index + 1 === script.start && match[1].length <= script.length)) continue
      const url = match[1]
      const location = `${relative(root, file)}:${text.slice(0, match.index).split('\n').length}: ${url}`
      if (url.endsWith('.html')) {
        hits.push(location)
        if (!imports.E2E_PAGES.includes(url.slice(1))) failures.push(location)
      } else if (/^\/(?:@fs|@vite|site-demo)\/|^\/src\/.*\.[cm]?[jt]sx?$/.test(url)) failures.push(location)
    }
  }
  assert.deepEqual(failures, [], `Unbuilt UI page or dev-server dependency:\n${failures.join('\n')}`)
  assert.ok(hits.some(hit => hit.endsWith('/src/preview/tile-page.html')), 'the embedded Seat page is covered')
  assert.ok(imports.E2E_PAGES.includes('src/preview/tile-page.html'))
  assert.ok(!imports.E2E_PAGES.includes('src/preview/browser-lanes.html'))
})
