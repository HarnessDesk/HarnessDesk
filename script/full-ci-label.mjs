import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const fail = (message) => { throw new Error(message); };
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const shaOk = (x) => typeof x === 'string' && /^[a-f0-9]{40}$/i.test(x);
const refOk = (x) => typeof x === 'string' && x.length > 0 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(x) && !x.startsWith('-') && !x.includes('..') && !x.includes('@{') && !x.endsWith('.') && !x.endsWith('/') && !x.includes('//');
const repoOk = (x) => typeof x === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(x);
const timestamp = (x) => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(x) && Number.isFinite(Date.parse(x)) ? Date.parse(x) : fail('Invalid timestamp');
const pages = (value, key) => {
  if (!Array.isArray(value) || value.length === 0) fail('Invalid paginated response');
  return value.flatMap((page) => {
    const entries = key ? object(page) && page[key] : page;
    if (!Array.isArray(entries)) fail('Invalid page');
    return entries;
  });
};

export async function run({ event, repository, api, dispatch }) {
  const pr = event?.pull_request;
  const number = event?.number;
  if (!repoOk(repository) || event?.action !== 'labeled' || event?.label?.name !== 'full-ci' || !Number.isSafeInteger(number) || number <= 0 || pr?.number !== number || !shaOk(pr?.head?.sha) || !refOk(pr?.head?.ref) || !refOk(pr?.base?.ref) || !repoOk(pr?.head?.repo?.full_name) || pr?.base?.repo?.full_name !== repository) fail('Invalid label event');
  if (pr.head.repo.full_name !== repository) return 'foreign repository';
  const prefix = `repos/${repository}`;
  const matches = (current) => {
    if (!object(current) || current.number !== number || !shaOk(current.head?.sha) || !refOk(current.head?.ref) || !repoOk(current.head?.repo?.full_name) || !refOk(current.base?.ref) || !repoOk(current.base?.repo?.full_name) || !Array.isArray(current.labels) || current.labels.some((l) => !object(l) || typeof l.name !== 'string')) fail('Invalid current PR');
    if (current.head.sha !== pr.head.sha || current.head.ref !== pr.head.ref || current.head.repo.full_name !== repository || current.base.ref !== pr.base.ref || current.base.repo.full_name !== repository) return 'head or repository changed';
    if (!current.labels.some((l) => l.name === 'full-ci')) return 'label removed';
    return null;
  };
  const initial = matches(await api(`${prefix}/pulls/${number}`));
  if (initial) return initial;
  const events = pages(await api(`${prefix}/issues/${number}/events?per_page=100`, true));
  let lastLabel = null;
  for (const item of events) {
    if (!object(item) || typeof item.event !== 'string') fail('Invalid issue event');
    if (item.event === 'labeled' || item.event === 'unlabeled') {
      if (!object(item.label) || typeof item.label.name !== 'string') fail('Invalid label event');
      if (item.label.name === 'full-ci') {
        const time = timestamp(item.created_at);
        if (!lastLabel || time > lastLabel.time || (time === lastLabel.time && item.event === 'unlabeled')) lastLabel = { time, event: item.event };
      }
    }
  }
  let reuse = false;
  if (lastLabel?.event === 'labeled') {
    const runs = pages(await api(`${prefix}/actions/runs?head_sha=${pr.head.sha}&event=pull_request&per_page=100`, true), 'workflow_runs');
    for (const candidate of runs) {
      if (!object(candidate) || !Number.isSafeInteger(candidate.id) || candidate.id <= 0 || typeof candidate.path !== 'string' || typeof candidate.event !== 'string' || !shaOk(candidate.head_sha) || !Array.isArray(candidate.pull_requests) || !object(candidate.repository) || !repoOk(candidate.repository.full_name)) fail('Invalid workflow run');
      if (candidate.pull_requests.some((p) => !object(p) || !Number.isSafeInteger(p.number) || p.number <= 0 || !shaOk(p.head?.sha) || !refOk(p.base?.ref))) fail('Invalid workflow run pull request');
      const created = timestamp(candidate.created_at);
      if (candidate.path !== '.github/workflows/ci.yml' || candidate.event !== 'pull_request' || candidate.head_sha !== pr.head.sha || candidate.repository.full_name !== repository || created < lastLabel.time || !candidate.pull_requests.some((p) => p?.number === number && p?.head?.sha === pr.head.sha && p?.base?.ref === pr.base.ref)) continue;
      const jobs = pages(await api(`${prefix}/actions/runs/${candidate.id}/jobs?per_page=100`, true), 'jobs');
      for (const job of jobs) if (!object(job) || !Number.isSafeInteger(job.id) || !Number.isSafeInteger(job.run_id) || !shaOk(job.head_sha) || typeof job.name !== 'string' || typeof job.status !== 'string' || !(job.conclusion === null || typeof job.conclusion === 'string')) fail('Invalid workflow job');
      const markers = jobs.filter((j) => j.run_id === candidate.id && j.head_sha === pr.head.sha && j.name.startsWith('CI tier: ')).sort((a, b) => b.id - a.id);
      if (markers[0]?.name === 'CI tier: full' && markers[0].status === 'completed' && markers[0].conclusion === 'success') { reuse = true; break; }
    }
  }
  const final = matches(await api(`${prefix}/pulls/${number}`));
  if (final) return final;
  if (reuse) return 'existing full-tier run';
  await dispatch(repository, pr.head.ref);
  return 'dispatched';
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const api = async (endpoint, paginate = false) => JSON.parse(execFileSync('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), endpoint], { encoding: 'utf8' }));
  const dispatch = async (repository, branch) => { execFileSync('gh', ['workflow', 'run', 'ci.yml', '--repo', repository, '--ref', branch], { stdio: ['ignore', 'ignore', 'pipe'] }); };
  console.log(await run({ event, repository: process.env.GITHUB_REPOSITORY, api, dispatch }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
