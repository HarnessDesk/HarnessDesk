import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifySkillFiles as classify } from '../src/index.js'

type File = { path: string; bytes: Uint8Array; mode?: number }
const file = (path: string, bytes = Buffer.from('plain text'), mode?: number): File => ({ path, bytes, ...(mode === undefined ? {} : { mode }) })

test('classification keeps input order, byte counts and plain references', () => {
  assert.deepEqual(classify([file('SKILL.md'), file('references/note.md'), file('z.txt'), file('a.txt')]),
    ['SKILL.md', 'references/note.md', 'z.txt', 'a.txt'].map(path => ({ path, bytes: 10, runnable: false, binary: false, reason: null })))
})

test('runnable reasons follow executable bit, shebang, header, extension, directory order', () => {
  const cases: [File, string][] = [
    [file('scripts/run.py', Buffer.from('#!/bin/sh'), 0o100), 'executable file'],
    [file('scripts/run.py', Buffer.from('#!/bin/sh')), 'starts with #!'],
    [file('scripts/run.py', Buffer.from([0x4d, 0x5a])), 'executable program'],
    [file('scripts/run.py'), 'script (.py)'],
    [file('scripts/note.md'), 'in scripts/'],
    [file('bin/tool'), 'in scripts/'], [file('hooks/start'), 'in scripts/'],
    [file('SKILL.md', Buffer.from('text'), 0o001), 'executable file'],
  ]
  for (const [input, reason] of cases) {
    const result = classify([input])[0]!
    assert.equal(result.runnable, true, input.path)
    assert.equal(result.reason, reason, input.path)
  }
  for (const extension of 'sh bash zsh fish py rb pl php js mjs cjs ts lua ps1 bat cmd command jar'.split(' ')) {
    assert.equal(classify([file(`run.${extension.toUpperCase()}`)])[0]!.reason, `script (.${extension})`)
  }
  for (const hex of ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', '4d5a']) {
    assert.equal(classify([file('program', Buffer.from(hex, 'hex'))])[0]!.reason, 'executable program', hex)
  }
  for (const path of ['run.md', 'references/note.md', 'references/scripts/tool', 'scripts.txt']) {
    assert.equal(classify([file(path)])[0]!.runnable, false, path)
  }
})

test('binary detection samples the first 8 KB for NUL and invalid UTF-8', () => {
  for (const bytes of [Buffer.from('a\0b'), Buffer.from([0xc3, 0x28]), Buffer.from([0xff])]) {
    assert.deepEqual(classify([file('data', bytes)])[0], { path: 'data', bytes: bytes.length, runnable: false, binary: true, reason: null })
  }
  assert.equal(classify([file('text', Buffer.from('é😀'))])[0]!.binary, false)
  assert.equal(classify([file('large', Buffer.concat([Buffer.alloc(8192, 97), Buffer.from([0, 255])]))])[0]!.binary, false)
  assert.equal(classify([file('program', Buffer.from('7f454c4600', 'hex'))])[0]!.binary, true)
  assert.equal(classify([file('empty', Buffer.alloc(0))])[0]!.binary, false)
})

test('binary sampling allows a UTF-8 character split by the sample, but not incomplete EOF or malformed bytes', () => {
  for (const character of ['é', '€', '😀']) {
    const encoded = Buffer.from(character)
    for (let split = 1; split < encoded.length; split++) {
      const prefix = Buffer.alloc(8192 - split, 97)
      const complete = Buffer.concat([prefix, encoded, Buffer.from('tail')])
      assert.equal(classify([file('text', complete)])[0]!.binary, false, `${character}: split after ${split} bytes`)
      for (const padding of [Buffer.alloc(0), prefix]) {
        const incomplete = Buffer.concat([padding, encoded.subarray(0, split)])
        assert.equal(classify([file('text', incomplete)])[0]!.binary, true, `${character}: incomplete EOF`)
      }
    }
  }
  for (const malformed of [[0xc3, 0x28], [0xe0, 0x80], [0xed, 0xa0], [0xf4, 0x90], [0xff]]) {
    const bytes = Buffer.concat([Buffer.alloc(8192 - malformed.length, 97), Buffer.from(malformed), Buffer.from('tail')])
    assert.equal(classify([file('data', bytes)])[0]!.binary, true, `malformed: ${malformed}`)
  }
})
