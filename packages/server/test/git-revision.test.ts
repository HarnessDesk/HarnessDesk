import assert from 'node:assert/strict'
import test from 'node:test'

import { isRevisionName, isSha } from '../src/git-revision.js'

/**
 * What this host will hand to git as a single revision.
 *
 * The gate is real and has to stay real — a value arriving over the wire must
 * not be able to read as an option, and must not be a *range* when the caller
 * wants one commit. It was also refusing `HEAD~1` and `HEAD^`, which are
 * ordinary revision syntax, so reset, rebase, merge, diff-range and
 * worktree-add all answered `"HEAD~1" is not a usable revision name`.
 */

test('relative revisions are revisions', () => {
  for (const ref of ['HEAD~1', 'HEAD^', 'HEAD^^', 'main~2', 'v1.0.0~3', 'HEAD~1^', 'origin/main~1']) {
    assert.equal(isRevisionName(ref), true, ref)
  }
})

test('the ordinary names still pass, as they always did', () => {
  for (const ref of ['main', 'HEAD', 'origin/main', 'v1.0.0', 'feature/thing', 'a1b2c3d', 'main@{yesterday}']) {
    assert.equal(isRevisionName(ref), true, ref)
  }
})

test('a name that opens with @ is refused, and always was', () => {
  /* `@{u}` and `@{-1}` are legitimate revisions and this gate has never taken
     them, because the first character must be a word character — which is the
     anchor that keeps a leading `-` out. Pinned rather than changed: widening
     the opening character is a separate decision from admitting `~` and `^`,
     which cannot appear first anyway.
     This assertion started life the other way round, asserting `@{u}` passed;
     it never did. */
  for (const ref of ['@{u}', '@{-1}', '@']) {
    assert.equal(isRevisionName(ref), false, ref)
  }
  // The same idea, spelled from a branch, is accepted — and is what callers use.
  assert.equal(isRevisionName('main@{u}'), true)
})

test('a range is not a revision', () => {
  // Every caller wants one commit; `a..b` and `a...b` name a span.
  for (const ref of ['main..HEAD', 'a...b', '..HEAD', 'HEAD..']) {
    assert.equal(isRevisionName(ref), false, ref)
  }
})

test('nothing that could read as an option gets through', () => {
  /* The reason the gate exists. Adding `~` and `^` must not open this: a
     value still has to *start* with a word character, so `^HEAD` — which
     means "exclude" to rev-list — is refused exactly as before. */
  for (const ref of ['-f', '--force', '^HEAD', '-HEAD', '--upload-pack=touch /tmp/x']) {
    assert.equal(isRevisionName(ref), false, ref)
  }
})

test('and nothing that could reach a shell or a second argument', () => {
  for (const ref of ['main; rm -rf /', 'main && echo', 'main | cat', '$(id)', '`id`', 'main HEAD', "main'", 'main"']) {
    assert.equal(isRevisionName(ref), false, ref)
  }
})

test('empty is not a name', () => {
  assert.equal(isRevisionName(''), false)
})

test('the ^ suffixes that name more than one revision are refused', () => {
  /* Admitting `^` admitted these two. `HEAD^-1` is shorthand for the range
     `HEAD ^HEAD^1`, and `HEAD^@` is every parent — a set. The callers run
     `rev-parse --verify`, which happens to reject both today, but a gate whose
     contract holds only because of what its callers do next is not a gate.
     Raised in review. */
  for (const ref of ['HEAD^-1', 'HEAD^-', 'main^-2', 'HEAD^@', 'main^@']) {
    assert.equal(isRevisionName(ref), false, ref)
  }
})

test('the ^ suffixes that do name one revision still pass', () => {
  // The control: peeling, a numbered parent, and a parent of an ancestor.
  for (const ref of ['HEAD^{commit}', 'v1.0.0^{}', 'HEAD^2', 'HEAD^0', 'HEAD~2^2']) {
    assert.equal(isRevisionName(ref), true, ref)
  }
})

test('a commit id is 4 to 64 hex characters: SHA-1, SHA-256, and the abbreviations between', () => {
  // #67: a SHA-256 repository names every commit in 64, and 40 was the ceiling.
  assert.equal(isSha('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'), true)
  assert.equal(isSha('da39a3ee5e6b4b0d3255bfef95601890afd80709'), true)
  assert.equal(isSha('abcd'), true)
  assert.equal(isSha('abc'), false, 'shorter than git abbreviates')
  assert.equal(isSha('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8550'), false, '65')
  assert.equal(isSha('HEAD'), false)
  assert.equal(isSha('--not-a-sha'), false)
})
