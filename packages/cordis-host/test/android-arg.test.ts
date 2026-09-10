import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import test from 'node:test'

import { deviceArg } from '../src/android.js'

/**
 * What reaches the shell **on the device**.
 *
 * `adb shell a b c` does not pass three arguments. It joins them into a line
 * and hands that line to the device's own shell, so every value a caller
 * supplies is shell source over there. `AndroidService.text` passed its
 * argument through with only spaces replaced, which meant a `;` or a `$(…)`
 * in text an agent had read off a page ran as a command on the phone.
 *
 * These run the quoting through a real `/bin/sh` rather than asserting on the
 * quoted string, because the property being claimed is about a shell and
 * only a shell can settle it. A test that compared strings would be checking
 * my model of the shell against itself.
 */

/**
 * What `sh` actually receives as argument one, after parsing the line.
 *
 * `/bin/sh` is hardcoded here on purpose and the file skips itself where
 * there is none — which is not the assumption this change is about. The
 * *device* is Android and its shell is `mksh` or `toybox sh`, so a POSIX
 * shell is the only stand-in available; running these on a machine that has
 * none would be checking nothing. Review flagged the literal path in a change
 * about POSIX assumptions, which is fair, so it says out loud which of the
 * two shells it is standing in for.
 */
const SH = '/bin/sh'
const posixShell = existsSync(SH)

const throughShell = (quoted: string): string =>
  execFileSync(SH, ['-c', `printf %s ${quoted}`], { encoding: 'utf8' })

const survives = (raw: string): void => {
  assert.equal(throughShell(deviceArg(raw)), raw, `«${raw}» did not survive the shell intact`)
}

test('a command separator is text, not a command', { skip: !posixShell }, () => {
  survives('hello; rm -rf /tmp/nothing')
  survives('a && b')
  survives('a || b')
  survives('a | b')
  survives('a & b')
})

test('substitution is text, not substitution', { skip: !posixShell }, () => {
  /* The dangerous pair. If either of these came back as a user id, the shell
     had run it — which is the whole defect, on somebody's phone. */
  survives('$(id)')
  survives('`id`')
  survives('${HOME}')
  survives('$HOME')
})

test('quotes and backslashes survive, including the one that cannot be quoted', { skip: !posixShell }, () => {
  // A single quote is the only character single-quoting cannot contain, so it
  // is the one the escaping exists for.
  survives("it's")
  survives("'")
  survives("''")
  survives('a"b')
  survives('back\\slash')
  survives("mixed '\"` \\ $")
})

test('the ordinary case is unchanged text', { skip: !posixShell }, () => {
  survives('hello%sworld')
  survives('KEYCODE_ENTER')
  survives('com.example/.MainActivity')
  survives('')
})

test('the shell rig itself can catch an injection', { skip: !posixShell }, () => {
  /* The control. Without it every assertion above could be passing because
     `throughShell` never runs anything, and a test that cannot fail is not
     evidence. Unquoted, `$(printf pwned)` becomes `pwned`. */
  assert.equal(throughShell('$(printf pwned)'), 'pwned')
  assert.notEqual(throughShell('$(printf pwned)'), '$(printf pwned)')
})
