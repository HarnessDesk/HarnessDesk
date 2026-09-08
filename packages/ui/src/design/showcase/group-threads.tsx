import type { ChannelMessageProps } from '../patterns/ChannelMessage'

/**
 * What the room and each harness are saying.
 *
 * Written so the four conversations are visibly *different kinds* of
 * conversation, because that is what having four harnesses buys: Claude is
 * mid-refactor and reporting file counts, Codex is arguing about a flaky test,
 * Gemini is handing back a reading of a spec, Cursor has finished and gone
 * quiet. A fixture where all four sound alike would make the roster look like
 * a formality.
 */

export const ROOM: ChannelMessageProps[] = [
  {
    from: 'You',
    at: '09:02',
    text: 'Kicking off the auth migration. Claude has src/api, Codex has the gateway tests, Gemini is reading the ACP spec for gaps. Shout if you need something outside your paths.',
    state: 'delivered',
  },
  {
    from: 'Claude Code',
    brand: 'claudecode',
    tint: 'blue',
    at: '09:04',
    text: 'Taking src/api/**. I will leave the callers in packages/server alone.',
    state: 'delivered',
  },
  {
    from: 'Codex',
    brand: 'codex',
    tint: 'teal',
    at: '09:06',
    text: 'Gateway tests claimed. One for the room: do we keep the legacy session shape behind a flag, or drop it in the same change?',
    state: 'delivered',
  },
  {
    from: 'Gemini CLI',
    brand: 'geminicli',
    tint: 'amber',
    to: 'Codex',
    at: '09:11',
    text: 'Drop it. Nothing in the spec has read that shape since the transcript rewrite — I have the section numbers if you want them.',
    state: 'delivered',
  },
  {
    from: 'Claude Code',
    brand: 'claudecode',
    tint: 'blue',
    at: '09:31',
    text: 'Auth callers migrated — 14 files, tests green. One caller in packages/server still uses the old signature; out of my paths, so I have left it.',
    state: 'delivered',
  },
]

export const THREADS: Record<string, ChannelMessageProps[]> = {
  claude: [
    { from: 'You', at: '09:28', text: 'How far through the callers are you?', state: 'delivered' },
    {
      from: 'Claude Code',
      brand: 'claudecode',
      tint: 'blue',
      at: '09:31',
      text: 'Fourteen of fifteen. The last is in packages/server, outside the paths I claimed — say the word and I will take it.',
      state: 'delivered',
    },
  ],
  codex: [
    { from: 'You', at: '09:14', text: 'Take the gateway tests next.', state: 'delivered' },
    {
      from: 'Codex',
      brand: 'codex',
      tint: 'teal',
      at: '09:15',
      text: 'Claimed. Starting with the socket path, since that is the one that flakes.',
      state: 'delivered',
    },
  ],
  cursor: [
    {
      from: 'Cursor',
      brand: 'cursor',
      tint: 'violet',
      at: '08:40',
      text: 'Release notes are up for review. Nothing else queued — happy to take something off the board.',
      state: 'delivered',
    },
  ],
  gemini: [
    {
      from: 'Gemini CLI',
      brand: 'geminicli',
      tint: 'amber',
      at: '09:12',
      text: 'Read the whole spec. Four gaps against our implementation; the session/read one is the only breaking change. Needs a decision before I write it up.',
      state: 'delivered',
    },
    {
      from: 'Gemini CLI',
      brand: 'geminicli',
      tint: 'amber',
      at: '09:12',
      text: 'Holding until you say which way to go.',
      state: 'delivered',
      grouped: true,
    },
  ],
}
