import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { applyLibrary, bundleDigest, planLibrary } from '@harnessdesk/agent-inventory'
import { runtimeId } from '@harnessdesk/protocol'
import { LibrarySources, parseGithubSource } from '../src/library-sources.js'

const URL = 'https://github.com/acme-dev/skills'
const BODY = '---\nname: demo\ndescription: Demo skill\n---\nRead this.\n'

test('GitHub source grammar: canonical repository, tree ref/path, and explicit overrides', () => {
  assert.deepEqual(parseGithubSource(`${URL}.git`), { url: URL, repo: 'acme-dev/skills', ref: 'HEAD', path: '' })
  assert.deepEqual(parseGithubSource(`${URL}/tree/main/tools/demo`), { url: URL, repo: 'acme-dev/skills', ref: 'main', path: 'tools/demo' })
  assert.deepEqual(parseGithubSource(`${URL}/tree/main/tools`, 'feature/demo', 'other'), { url: URL, repo: 'acme-dev/skills', ref: 'feature/demo', path: 'other' })
  assert.equal(parseGithubSource(URL, 'release%1').ref, 'release%1')
  assert.equal(parseGithubSource(`${URL}/tree/main/tools/demo%20file`).path, 'tools/demo file')
  for (const url of ['http://github.com/acme-dev/skills', 'ssh://github.com/acme-dev/skills', 'git@github.com:acme-dev/skills', 'file:///repo', 'acme-dev/skills', 'https://other.dev/acme-dev/skills', 'https://dev@github.com/acme-dev/skills', `${URL}:443`, 'https://github.com:443/acme-dev/skills', `${URL}?x=1`, `${URL}#x`, `${URL}/blob/main`, `${URL}/tree/main?x=1`, `${URL}/tree/main#x`, 'https://github.com/./skills', 'https://github.com/acme-dev/..', 'https://github.com/acme_dev/skills', `${URL}/tree/`, `${URL}/tree/%2e%2e`]) {
    assert.throws(() => parseGithubSource(url), /https:\/\/github.com/, url)
  }
  for (const ref of ['-main', 'two words', 'a..b', 'a:b', 'a\\b', 'a\nb', 'a\u0001b', '']) assert.throws(() => parseGithubSource(URL, ref), /ref/i, ref)
  for (const path of ['../demo', '/demo', 'a//b', 'a/./b', 'C:\\demo', 'a/.GiT/b', 'a\u0001b']) assert.throws(() => parseGithubSource(URL, 'main', path), /path/i, path)
})

async function fixture(fn: (root: string, repo: string, commit: string) => Promise<void>, entries: Record<string, { mode?: string; body: string }> = { 'tools/demo/SKILL.md': { body: BODY }, 'tools/demo/run.sh': { mode: '100755', body: 'echo demo\n' } }) {
  const root = await mkdtemp(join(tmpdir(), 'hd-library-source-'))
  const repo = join(root, 'repo.git')
  const git = (args: string[], input?: string) => execFileSync('git', ['-c', 'core.precomposeUnicode=false', '-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', '--git-dir', repo, ...args], { input, encoding: 'utf8' }).trim()
  try {
    execFileSync('git', ['init', '--bare', '--quiet', repo])
    for (const [path, entry] of Object.entries(entries)) {
      const hash = git(['hash-object', '-w', '--stdin'], entry.body)
      git(['update-index', '--add', '--cacheinfo', entry.mode ?? '100644', hash, path])
    }
    const tree = git(['write-tree'])
    const commit = git(['commit-tree', tree], 'Demo source\n')
    git(['update-ref', 'refs/heads/main', commit])
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
    git(['tag', '-a', 'v1', commit, '-m', 'Demo tag'])
    await fn(root, repo, commit)
  } finally { await rm(root, { recursive: true, force: true }) }
}
const sources = (root: string, repo: string, extra: ConstructorParameters<typeof LibrarySources>[1] = {}) => new LibrarySources(join(root, 'library'), { transport: () => ({ url: pathToFileURL(repo).href, protocol: 'file' }), ...extra })

test('resolve HEAD, branch, slash branch, peeled tag, and full commit; copy bytes and modes without checkout', async () => {
  await fixture(async (root, repo, commit) => {
    execFileSync('git', ['--git-dir', repo, 'update-ref', 'refs/heads/feature/demo', commit])
    const reader = sources(root, repo)
    for (const ref of [undefined, 'main', 'feature/demo', 'v1', commit]) {
      const result = await reader.fetch({ url: URL, ...(ref === undefined ? {} : { ref }), path: 'tools' })
      assert.equal(result.commit, commit)
      assert.equal(result.ref, ref ?? 'HEAD')
      assert.equal(result.url, URL)
      assert.equal(result.repo, 'acme-dev/skills')
      assert.deepEqual(result.refused, [])
      assert.equal(result.skills.length, 1)
      const skill = result.skills[0]!
      assert.equal(skill.name, 'demo')
      assert.equal(skill.dir, 'tools/demo')
      assert.equal(skill.files, 2)
      assert.equal(skill.bytes, Buffer.byteLength(BODY + 'echo demo\n'))
      assert.equal(await readFile(join(skill.sourcePath, 'SKILL.md'), 'utf8'), BODY)
      assert.equal((await lstat(join(skill.sourcePath, 'run.sh'))).mode & 0o777, 0o755)
      assert.equal((await lstat(join(skill.sourcePath, 'SKILL.md'))).mode & 0o777, 0o644)
      assert.equal((await lstat(skill.sourcePath)).mode & 0o777, 0o700)
      assert.equal(skill.bundle, bundleDigest([{ path: 'SKILL.md', bytes: Buffer.from(BODY) }, { path: 'run.sh', bytes: Buffer.from('echo demo\n') }]))
      assert.deepEqual((await readdir(join(root, 'library/sources'))).filter(name => name.startsWith('.tmp-')), [])
    }
    for (const ref of [commit.slice(0, 7), 'missing']) await assert.rejects(reader.fetch({ url: URL, ref }), /Use a branch, a tag or the full commit hash/)
    const fetched = await reader.fetch({ url: URL, ref: commit })
    await writeFile(join(fetched.skills[0]!.sourcePath, 'run.sh'), 'changed')
    await assert.rejects(reader.fetch({ url: URL, ref: commit }), /changed/)
  })
})

test('listing refuses links, submodules, path collisions and controls per skill while preserving others', async () => {
  await fixture(async (root, repo, commit) => {
    // A submodule is an object entry, never a checked-out repository.
    execFileSync('git', ['--git-dir', repo, 'update-index', '--add', '--cacheinfo', '160000', commit, 'module/sub'])
    const tree = execFileSync('git', ['--git-dir', repo, 'write-tree'], { encoding: 'utf8' }).trim()
    const next = execFileSync('git', ['-c', 'core.precomposeUnicode=false', '-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', '--git-dir', repo, 'commit-tree', tree], { input: 'Module fixture\n', encoding: 'utf8' }).trim()
    const result = await sources(root, repo).fetch({ url: URL, ref: next })
    assert.deepEqual(result.skills.map(skill => skill.dir), ['good'])
    for (const dir of ['linked', 'module', 'case', 'unicode', 'control']) assert.ok(result.refused.some(one => one.dir === dir), dir)
    assert.match(result.refused.find(one => one.dir === 'linked')!.reason, /contains a link at .*links are not carried/)
    assert.match(result.refused.find(one => one.dir === 'module')!.reason, /contains a link at .*links are not carried/)
  }, {
    'good/SKILL.md': { body: BODY }, 'linked/SKILL.md': { body: BODY }, 'linked/a': { mode: '120000', body: '/elsewhere' },
    'module/SKILL.md': { body: BODY }, 'case/SKILL.md': { body: BODY }, 'case/A': { body: 'a' }, 'case/a': { body: 'b' },
    'unicode/SKILL.md': { body: BODY }, 'unicode/é': { body: 'a' }, 'unicode/é': { body: 'b' },
    'control/SKILL.md': { body: BODY }, 'control/a\u0001b': { body: 'a' },
  })
})

test('listing enforces file/byte limits, exact root definition, discovery depth and skill count', async () => {
  await fixture(async (root, repo) => {
    const files = await sources(root, repo, { maxBundleFiles: 1 }).fetch({ url: URL })
    assert.match(files.refused.find(one => one.dir === 'two')!.reason, /files/)
    const bytes = await sources(root, repo, { maxBundleBytes: 2 }).fetch({ url: URL })
    assert.equal(bytes.skills.length, 0)
    assert.ok(bytes.refused.some(one => /bytes/.test(one.reason)))
    const normal = await sources(root, repo).fetch({ url: URL })
    assert.ok(normal.skills.some(one => one.dir === 'a/b/c/d'))
    assert.ok(!normal.skills.some(one => one.dir === 'a/b/c/d/e'))
    assert.ok(normal.refused.some(one => one.dir === 'lower' && /SKILL.md/.test(one.reason)))
    assert.ok(!normal.skills.some(one => one.dir === 'parent'))
    const count = await sources(root, repo, { maxSkills: 1 }).fetch({ url: URL })
    assert.equal(count.skills.length, 1)
    assert.ok(count.refused.some(one => /skills/.test(one.reason)))
  }, { 'two/SKILL.md': { body: BODY }, 'two/extra': { body: 'x' }, 'lower/skill.md': { body: BODY }, 'parent/child/SKILL.md': { body: BODY }, 'a/b/c/d/SKILL.md': { body: BODY }, 'a/b/c/d/e/SKILL.md': { body: BODY } })
})

test('cache expires old entries, refuses linked destinations, and discards an oversized temporary repo', async () => {
  await fixture(async (root, repo) => {
    const cache = join(root, 'library/sources')
    await mkdir(join(cache, 'old'), { recursive: true })
    await utimes(join(cache, 'old'), 0, 0)
    await assert.rejects(sources(root, repo, { maxRepositoryBytes: 1 }).fetch({ url: URL }), /64 MB|repository.*limit/i)
    assert.deepEqual(await readdir(cache), [])
    await mkdir(join(root, 'elsewhere'))
    await symlink(join(root, 'elsewhere'), join(cache, 'acme-dev__skills'))
    await assert.rejects(sources(root, repo).fetch({ url: URL }), /outside|link/)
    assert.deepEqual(await readdir(join(root, 'elsewhere')), [])
  })
})

test('root skill names, literal selected paths, missing definitions, and timeout cleanup', async () => {
  await fixture(async (root, repo, commit) => {
    const result = await sources(root, repo).fetch({ url: URL, ref: commit, path: 'literal[1]' })
    assert.equal(result.skills[0]?.dir, 'literal[1]')
    assert.equal(result.skills[0]?.name, 'literal[1]')
    const missing = await sources(root, repo).fetch({ url: URL, path: 'missing' })
    assert.match(missing.refused[0]?.reason ?? '', /No SKILL.md/)
    await assert.rejects(sources(root, repo, { timeoutMs: 1 }).fetch({ url: URL }), /60 seconds/)
    assert.deepEqual((await readdir(join(root, 'library/sources'))).filter(name => name.startsWith('.tmp-')), [])
  }, { 'literal[1]/SKILL.md': { body: '---\nname: ../elsewhere\n---\nDemo.\n' }, 'literal1/SKILL.md': { body: BODY } })
  await fixture(async (root, repo) => {
    const result = await sources(root, repo).fetch({ url: URL })
    assert.equal(result.skills[0]?.dir, '')
    assert.equal(result.skills[0]?.name, 'demo')
  }, { 'SKILL.md': { body: BODY } })
})

test('case-folded directory and skill-root collisions are refused per skill', async () => {
  await fixture(async (root, repo) => {
    const result = await sources(root, repo).fetch({ url: URL })
    assert.deepEqual(result.skills.map(one => one.dir), ['good'])
    for (const dir of ['one', 'cross/Demo', 'cross/demo']) assert.ok(result.refused.some(one => one.dir === dir && /normalisation/.test(one.reason)), dir)
  }, {
    'good/SKILL.md': { body: BODY }, 'good/référence.md': { body: 'Demo\n' },
    'one/SKILL.md': { body: BODY }, 'one/A/first': { body: 'a' }, 'one/a/second': { body: 'b' },
    'cross/Demo/SKILL.md': { body: BODY }, 'cross/demo/SKILL.md': { body: BODY },
  })
})


test('fetched commit installs through the ordinary preview and persists its origin', async () => {
  await fixture(async (root, repo, commit) => {
    const fetched = await sources(root, repo).fetch({ url: URL, ref: 'main' })
    const skill = fetched.skills[0]!
    const context = { home: join(root, 'home'), libraryDir: join(root, 'library') }
    const origin = { url: fetched.url, ref: fetched.ref, commit, path: skill.dir, bundle: skill.bundle }
    const plan = await planLibrary([{ id: runtimeId('claudecode'), brand: 'claudecode' }], [{ kind: 'installSkill', name: skill.name, sourcePath: skill.sourcePath, targetRuntime: runtimeId('claudecode'), origin }], context)
    assert.equal(plan.ops[0]?.action, 'create')
    assert.deepEqual(plan.ops[0]?.origin, origin)
    assert.match(plan.ops[0]?.preview ?? '', /Read this/)
    assert.equal((await applyLibrary(plan.ops, context))[0]?.outcome, 'done')
    assert.deepEqual(await readFile(join(plan.ops[0]!.targetPath, 'bytes.bin')), Buffer.from('\0\u0001é\n'))
    const manifest = JSON.parse(await readFile(join(context.libraryDir, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.entries[0].origin, { url: URL, ref: 'main', commit, path: 'demo' })
  }, { 'demo/SKILL.md': { body: BODY }, 'demo/bytes.bin': { body: '\0\u0001é\n' } })
})


test('repository size limit also stops the fetch when objects arrive', async () => {
  await fixture(async (root, repo) => {
    await assert.rejects(sources(root, repo, { maxRepositoryBytes: 32 * 1024 }).fetch({ url: URL }), /64 MB repository size limit/)
    assert.deepEqual((await readdir(join(root, 'library/sources'))).filter(name => name.startsWith('.tmp-')), [])
  }, { 'demo/SKILL.md': { body: BODY }, 'demo/data': { body: randomBytes(128 * 1024).toString('hex') } })
})


test('Git object checking refuses a .git tree before any skills are listed', async () => {
  await fixture(async (root, repo) => {
    const git = (args: string[], input?: string) => execFileSync('git', ['-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', '--git-dir', repo, ...args], { input, encoding: 'utf8' }).trim()
    const blob = git(['hash-object', '-w', '--stdin'], BODY)
    const good = git(['mktree'], `100644 blob ${blob}\tSKILL.md\n`)
    const bad = git(['mktree'], `100644 blob ${blob}\tSKILL.md\n100644 blob ${blob}\t.git\n`)
    const tree = git(['mktree'], `040000 tree ${good}\tgood\n040000 tree ${bad}\tbad\n`)
    const commit = git(['commit-tree', tree], 'Dot directory fixture\n')
    await assert.rejects(sources(root, repo).fetch({ url: URL, ref: commit }), /public repository or requested commit could not be read/)
    assert.deepEqual(await readdir(join(root, 'library/sources')), [])
  })
})
