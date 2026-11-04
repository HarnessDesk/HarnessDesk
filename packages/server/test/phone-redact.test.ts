import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scrub, scrubProjectText, scrubText } from '../src/phone-redact.js'

const cwd = '/Users/jane/proj'

test('credentialed URLs redact userinfo for every scheme before shortening', () => {
  for (const scheme of ['postgres', 'redis', 'ftp', 'https']) {
    const shown = scrubProjectText(`${scheme}://demo:placeholder@db:5432/x`, cwd)
    assert.ok(shown.startsWith(`${scheme}://…@db:5432`), shown)
    assert.ok(!shown.includes('demo:placeholder'), shown)
  }
})

test('secret assignments preserve keys and redact short, quoted and prefixed values', () => {
  for (const key of ['PASSWORD', 'passwd', 'pass', 'DB_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'secret', 'token', 'api_key', 'Api-Key', 'api key', 'access-key', 'private_key', 'authorization', 'bearer', 'credential', 'db-credentials']) {
    for (const separator of ['=', ': ']) {
      const text = `${key}${separator}placeholder123`
      assert.equal(scrubProjectText(text, cwd), `${key}${separator}…`, text)
    }
  }
  for (const text of ['PASSWORD="two placeholder words"', "DB_PASS='two placeholder words'", 'Authorization: Bearer abc123', 'DATABASE_URL=postgres://u:pw@db:5432/x']) {
    const shown = scrubProjectText(text, cwd)
    assert.ok(!/placeholder|abc123|u:pw/.test(shown), shown)
  }
  assert.equal(scrubProjectText('count=7 monkey: banana', cwd), 'count=7 monkey: banana')
  assert.equal(scrub('PASSWORD=placeholder'), 'PASSWORD=…')
  assert.equal(scrubText('TOKEN: placeholder'), 'TOKEN: …')
  assert.equal(scrubProjectText('PASSWORD=shortplaceholder', cwd, 16), 'PASSWORD=…')
})

test('project line scrubbing preserves comments, regex literals, slash runs and URL paths', () => {
  for (const text of ['// TODO fix', '/// docs', '/', '////', 's.replace(/\\d+/g, 1)', 's.replace(/word/g, 1)', 'https://example.com/docs/page']) assert.equal(scrubProjectText(text, cwd), text)
  assert.equal(scrubProjectText('/Users/jane/proj/src/a.ts', cwd), 'src/a.ts')
  assert.equal(scrubProjectText('~/notes.txt', cwd), 'notes.txt')
  assert.equal(scrubProjectText('/etc/config/app.conf', cwd), 'app.conf')
})

test('quoted secret keys and values are redacted in structured output', () => {
  assert.equal(scrubProjectText('{"password": "placeholder", "DB_TOKEN": "short"}', cwd), '{"password": …, "DB_TOKEN": …}')
})

test('an ordinary absolute path ending in a regex flag is still a path', () => {
  assert.equal(scrubProjectText('/tmp/g', cwd), 'g')
  assert.equal(scrubProjectText('/tmp', cwd), '/tmp')
  assert.equal(scrubProjectText('s.replace(/word/g, 1)', cwd), 's.replace(/word/g, 1)')
})

test('credentialed URLs keep their host when schemes or usernames resemble secret keys', () => {
  for (const text of ['token://demo:placeholder@db/x', 'postgres://password:placeholder@db/x']) {
    assert.match(scrubProjectText(text, cwd), /^[a-z]+:\/\/…@db\/x$/)
  }
})

test('URL authorities cannot bypass key-shaped string redaction', () => {
  for (const text of ['https://sk-abcdefghijklmnop.example.com/docs', 'redis://ghp_abcdefghijklmnop:6379/x', `https://${'a'.repeat(40)}.example.com/docs`]) {
    const shown = scrubProjectText(text, cwd)
    assert.ok(!/sk-abcdefghijklmnop|ghp_abcdefghijklmnop|a{40}/.test(shown), shown)
    assert.ok(shown.startsWith(text.split('://')[0]! + '://'), shown)
  }
})

test('camelCase secret key names are redacted without changing ordinary assignments', () => {
  for (const key of ['accessToken', 'refreshToken', 'clientSecret', 'dbPassword']) assert.equal(scrubProjectText(`{"${key}":"shortplaceholder"}`, cwd), `{"${key}":…}`)
  assert.equal(scrubProjectText('compass=north tokenizer=plain', cwd), 'compass=north tokenizer=plain')
})

test('ordinary assignments cannot hide nested secret assignments or URL query tokens', () => {
  assert.equal(scrubProjectText('https://example.com/docs?foo=1&token=shortplaceholder', cwd), 'https://example.com/docs?foo=1&token=…')
  assert.equal(scrubProjectText('message="PASSWORD=shortplaceholder"', cwd), 'message="PASSWORD=…"')
})
