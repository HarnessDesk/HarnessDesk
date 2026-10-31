import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from './full-ci-label.mjs';

const sha = 'a'.repeat(40), other = 'b'.repeat(40), repo = 'acme/widgets';
const event = { action: 'labeled', label: { name: 'full-ci' }, number: 12, pull_request: { number: 12, head: { sha, ref: 'feature', repo: { full_name: repo } }, base: { ref: 'development', repo: { full_name: repo } } } };
const current = () => ({ ...structuredClone(event.pull_request), labels: [{ name: 'full-ci' }] });
const labeled = { event: 'labeled', label: { name: 'full-ci' }, created_at: '2026-01-02T00:00:00Z' };
const candidate = () => ({ id: 42, path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: sha, created_at: '2026-01-03T00:00:00Z', repository: { full_name: repo }, pull_requests: [{ number: 12, head: { sha }, base: { ref: 'development' } }] });
const full = () => ({ id: 101, run_id: 42, head_sha: sha, name: 'CI tier: full', status: 'completed', conclusion: 'success' });
function fixture(options = {}) {
  const calls = [], dispatches = []; let reads = 0;
  const api = async (path, paginate) => {
    calls.push([path, paginate]);
    if (options.error && path.includes(options.error)) throw Error('API failure');
    if (path.includes('/pulls/')) return (options.prs || [current()])[Math.min(reads++, (options.prs || [0]).length - 1)];
    if (path.includes('/issues/')) return options.events ?? [[labeled]];
    if (path.includes('/jobs?')) return options.jobs ?? [{ jobs: [full()] }];
    if (path.includes('/actions/runs?')) return options.runs ?? [{ workflow_runs: [] }];
    throw Error('unexpected endpoint');
  };
  return { calls, dispatches, invoke: () => run({ event: options.event ?? event, repository: repo, api, dispatch: async (...args) => dispatches.push(args) }) };
}
test('unchanged PR dispatches once', async () => { const f = fixture(); assert.equal(await f.invoke(), 'dispatched'); assert.deepEqual(f.dispatches, [[repo, 'feature']]); });
test('changed head does not dispatch', async () => { const pr = current(); pr.head.sha = other; const f = fixture({ prs: [pr] }); assert.match(await f.invoke(), /changed/); assert.equal(f.dispatches.length, 0); });
test('removed label and foreign repository skip', async () => { const pr = current(); pr.labels = []; const f = fixture({ prs: [pr] }); assert.equal(await f.invoke(), 'label removed'); assert.equal(f.dispatches.length, 0); const fork = structuredClone(event); fork.pull_request.head.repo.full_name = 'acme/fork'; const g = fixture({ event: fork }); assert.equal(await g.invoke(), 'foreign repository'); assert.equal(g.calls.length, 0); });
test('live recheck prevents stale dispatch or reuse', async () => { const stale = current(); stale.head.sha = other; const f = fixture({ prs: [current(), stale], runs: [{ workflow_runs: [candidate()] }] }); assert.match(await f.invoke(), /changed/); assert.equal(f.dispatches.length, 0); });
test('malformed PR and API errors fail', async () => { for (const opts of [{ prs: [{}] }, { error: '/pulls/' }, { error: '/issues/' }, { error: '/actions/runs?' }, { runs: [{ workflow_runs: [candidate()] }], error: '/jobs?' }, { events: [{}] }]) { const f = fixture(opts); await assert.rejects(f.invoke()); assert.equal(f.dispatches.length, 0); } });
test('wrong or missing current PR number fails without dispatch', async () => { for (const number of [13, undefined]) for (const final of [false, true]) { const pr = current(); pr.number = number; const f = fixture({ prs: final ? [current(), pr] : [pr] }); await assert.rejects(f.invoke(), /Invalid current PR/); assert.equal(f.dispatches.length, 0); } });
test('same head full marker reuses run', async () => { const f = fixture({ runs: [{ workflow_runs: [candidate()] }] }); assert.equal(await f.invoke(), 'existing full-tier run'); assert.equal(f.dispatches.length, 0); });
test('full marker at exact label timestamp reuses run', async () => { const c = candidate(); c.created_at = labeled.created_at; const f = fixture({ runs: [{ workflow_runs: [c] }] }); assert.equal(await f.invoke(), 'existing full-tier run'); assert.equal(f.dispatches.length, 0); });
test('old and mismatched runs dispatch', async () => { const variants = [ c => c.created_at = '2026-01-01T00:00:00Z', c => c.path = '.github/workflows/other.yml', c => c.event = 'push', c => c.head_sha = other, c => c.pull_requests[0].number = 13, c => c.pull_requests[0].base.ref = 'main', c => c.repository.full_name = 'acme/other', c => c.pull_requests[0].head.sha = other ]; for (const change of variants) { const c = candidate(); change(c); const f = fixture({ runs: [{ workflow_runs: [c] }] }); assert.equal(await f.invoke(), 'dispatched'); assert.equal(f.dispatches.length, 1); } });
test('bounded, queued and newer bounded markers dispatch', async () => { for (const jobs of [[{ ...full(), name: 'CI tier: bounded' }], [{ ...full(), status: 'queued', conclusion: null }], [full(), { ...full(), id: 102, name: 'CI tier: bounded' }], []]) { const f = fixture({ runs: [{ workflow_runs: [candidate()] }], jobs: [{ jobs }] }); assert.equal(await f.invoke(), 'dispatched'); } });
test('all pages are read and missing label time dispatches', async () => { const f = fixture({ events: [[], [labeled]], runs: [{ workflow_runs: [] }, { workflow_runs: [candidate()] }], jobs: [{ jobs: [] }, { jobs: [full()] }] }); assert.equal(await f.invoke(), 'existing full-tier run'); assert.equal(f.calls.filter(([, paginated]) => paginated).length, 3); const g = fixture({ events: [[]] }); assert.equal(await g.invoke(), 'dispatched'); assert.ok(!g.calls.some(([p]) => p.includes('/actions/runs?'))); });
test('latest removal prevents timestamp reuse', async () => { const f = fixture({ events: [[labeled, { ...labeled, event: 'unlabeled', created_at: '2026-01-04T00:00:00Z' }]] }); assert.equal(await f.invoke(), 'dispatched'); });
test('same-second label and removal dispatches conservatively', async () => { for (const events of [[labeled, { ...labeled, event: 'unlabeled' }], [{ ...labeled, event: 'unlabeled' }, labeled]]) { const f = fixture({ events: [events] }); assert.equal(await f.invoke(), 'dispatched'); } });
test('workflow retains trigger and fork condition and checks out the event merge commit', async () => { const y = await readFile(new URL('../.github/workflows/full-ci-label.yml', import.meta.url), 'utf8'); for (const s of ['types: [labeled]', "github.event.label.name == 'full-ci' && github.event.pull_request.head.repo.full_name == github.repository", 'actions: write', 'contents: read', 'pull-requests: read', 'ref: ${{ github.sha }}', 'persist-credentials: false', 'node-version: 22', 'node script/full-ci-label.mjs']) assert.ok(y.includes(s), s); });
test('helper CLI runs from an event-layout folder with gh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hd-full-ci-label-'));
  try {
    const eventCheckout = join(root, 'event'), bin = join(root, 'bin');
    await Promise.all([mkdir(join(eventCheckout, 'script'), { recursive: true }), mkdir(bin)]);
    await copyFile(new URL('./full-ci-label.mjs', import.meta.url), join(eventCheckout, 'script/full-ci-label.mjs'));
    const eventPath = join(root, 'event.json'), log = join(root, 'dispatch.json'), calls = join(root, 'calls.jsonl');
    await writeFile(eventPath, JSON.stringify(event));
    await writeFile(join(bin, 'gh'), `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.CALLS_LOG, JSON.stringify(args) + '\\n');\nif (args[0] === 'workflow') fs.writeFileSync(process.env.DISPATCH_LOG, JSON.stringify(args));\nelse if (args.at(-1).includes('/pulls/')) console.log(${JSON.stringify(JSON.stringify(current()))});\nelse if (args.at(-1).includes('/issues/')) console.log(${JSON.stringify(JSON.stringify([[labeled]]))});\nelse if (args.at(-1).includes('/actions/runs?')) console.log(${JSON.stringify(JSON.stringify([{ workflow_runs: [] }]))});\nelse process.exit(2);\n`, { mode: 0o755 });
    const output = execFileSync(process.execPath, ['script/full-ci-label.mjs'], { cwd: eventCheckout, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: repo, DISPATCH_LOG: log, CALLS_LOG: calls } });
    assert.equal(output.trim(), 'dispatched');
    assert.deepEqual(JSON.parse(await readFile(log, 'utf8')), ['workflow', 'run', 'ci.yml', '--repo', repo, '--ref', 'feature']);
    assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse), [
      ['api', `repos/${repo}/pulls/12`],
      ['api', '--paginate', '--slurp', `repos/${repo}/issues/12/events?per_page=100`],
      ['api', '--paginate', '--slurp', `repos/${repo}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100`],
      ['api', `repos/${repo}/pulls/12`],
      ['workflow', 'run', 'ci.yml', '--repo', repo, '--ref', 'feature'],
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
