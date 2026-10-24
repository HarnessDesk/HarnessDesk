import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseGitWrite, parseGitCommand } from '../src/git-steer.js'

test('git push argv maps only a single branch push', () => {
  for (const args of [['push'], ['push', '-u', 'origin', 'x'], ['push', 'origin', 'HEAD:x'], ['push', '--force-with-lease', 'origin', 'x'], ['push', 'origin', 'HEAD:refs/heads/x']]) assert.equal(parseGitWrite('git', args)?.kind, 'push')
  for (const args of [['push', '--delete', 'origin', 'x'], ['push', '--tags'], ['push', 'origin', 'x', 'y'], ['push', '--mirror'], ['push', 'origin', ':x'], ['-c', 'alias.x=push', 'push'], ['push', '--receive-pack=evil']]) assert.equal(parseGitWrite('git', args)?.kind, 'unmappable')
  assert.equal(parseGitWrite('git', ['status']), null)
  assert.equal(parseGitWrite('git', ['log', '--grep', 'push']), null)
  assert.equal(parseGitWrite('gh', ['pr', 'view']), null)
})
test('forge argv preserves body text and maps supported options', () => {
  assert.deepEqual(parseGitWrite('gh', ['pr', 'create', '--title=T', '--body', 'two words', '--base', 'development', '--draft']), { kind: 'forge', tool: 'pr_create', args: { title: 'T', body: 'two words', base: 'development', draft: true } })
  assert.equal(parseGitWrite('gh', ['pr', 'create', '--fill'])?.kind, 'forge')
  assert.equal(parseGitWrite('gh', ['pr', 'merge', '42', '--squash', '--match-head-commit', 'a'.repeat(40)])?.kind, 'forge')
  assert.equal(parseGitWrite('gh', ['issue', 'comment', '42', '--body-file', 'body.txt'])?.kind, 'forge')
  assert.equal(parseGitWrite('gh', ['pr', 'edit', '--web'])?.kind, 'unmappable')
})
test('shell inspection catches absolute binaries, quoting and compound writes', () => {
  assert.equal(parseGitCommand('/usr/bin/git push -u origin x')?.kind, 'push')
  assert.equal(parseGitCommand('gh pr create --title "two words" --body \'hello\'')?.kind, 'forge')
  for (const command of ['git status; /usr/bin/git push', 'git push | cat', 'env X=1 git push', 'git push $(branch)']) assert.equal(parseGitCommand(command)?.kind, 'unmappable')
  assert.equal(parseGitCommand('echo "git push"'), null)
  assert.deepEqual(parseGitCommand("gh pr create --title Title --body ''"), { kind: 'forge', tool: 'pr_create', args: { title: 'Title', body: '' } })
})

test('R3 login shells unwrap recursively and read commands never become writes', () => {
  for (const command of ["/bin/zsh -lc 'git push origin x'", 'bash -lc "git push -u origin x"', "bash -c 'git push'", 'cd /repo && git push origin x']) assert.equal(parseGitCommand(command)?.kind, 'push', command)
  for (const command of ['echo git push', 'man git push', '/usr/bin/git push --help', 'git push --dry-run', 'git push -n', 'git -C dir log push']) assert.equal(parseGitCommand(command), null, command)
})
test('R3 aliases, alternate transports and forge mutations fail closed', () => {
  for (const args of [['p', 'origin', 'x'], ['-c', 'alias.p=push', 'p'], ['subtree', 'push', '--prefix=a', 'origin', 'x'], ['send-pack', 'origin', 'x'], ['http-push'], ['lfs', 'push']]) assert.equal(parseGitWrite('git', args)?.kind, 'unmappable', args.join(' '))
  for (const args of [['api', '-X', 'POST', 'repos/acme/widgets/pulls/1/merge'], ['api', 'repos/acme/widgets', '-f', 'a=b'], ['pr', 'close', '5'], ['pr', 'ready', '5'], ['issue', 'create'], ['pc'], ['alias', 'set', 'pc', 'pr create'], ['release', 'create'], ['repo', 'delete']]) assert.equal(parseGitWrite('gh', args)?.kind, 'unmappable', args.join(' '))
  assert.equal(parseGitWrite('gh', ['api', '-X', 'GET', 'repos/acme/widgets']), null)
})
