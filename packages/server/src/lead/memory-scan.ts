import { leadDataContainsCredential } from '@harnessdesk/lead'
import { LEAD_MEMORY_LIMITS, type LeadMemoryRefusal } from '@harnessdesk/protocol'

/**
 * What the desk checks before a proposal reaches the person's inbox. The text is the model's, or a line it wrote in a
 * reply, so it is read the way an attacker would spell it: line terminators and invisible characters are taken out
 * before anything is matched, compatibility forms are folded, and only then are its structure and words checked.
 */
const INVISIBLE = /[\p{Cf}\u115f\u1160\u180e\u2800\u3164\uffa0]/gu
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
/** Every line terminator becomes one newline, then control and invisible characters go, and lines lose their edges. */
export const leadMemoryCleanLines = (text: string): string[] => text.replace(/\r\n|[\r\v\f\u0085\u2028\u2029]/g, '\n')
  .replace(CONTROLS, '').replace(INVISIBLE, '').split('\n').map(line => line.trim())
/** The entry as kept: one line, single-spaced. */
export const leadMemoryFold = (text: string): string => leadMemoryCleanLines(text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
/** For matching only: compatibility forms folded and lower-cased, so full-width or styled letters read as plain ones. */
const reading = (text: string): string => text.normalize('NFKC').toLowerCase()

const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or',
  'that', 'the', 'this', 'to', 'was', 'were', 'will', 'with'])
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
/** Words for matching and search: letters and digits, common English glue words left out, and runs of CJK characters
 * read as overlapping pairs, since they carry no spaces. */
export const leadMemoryTokens = (text: string): string[] => {
  const out: string[] = []
  for (const run of reading(text).match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (CJK.test(run)) {
      const chars = [...run]
      if (chars.length === 1) out.push(run)
      for (let at = 0; at + 1 < chars.length; at++) out.push(chars[at]! + chars[at + 1]!)
    } else if (!STOPWORDS.has(run)) out.push(run)
  }
  return out
}
/** The same entry however it is spaced, cased or punctuated. */
export const leadMemoryKey = (text: string): string => leadMemoryTokens(text).join(' ')
/** Two entries say the same thing: equal once normalised, or sharing at least 80% of their words. */
export const leadMemoryNear = (a: string, b: string): boolean => {
  const left = new Set(leadMemoryTokens(a)), right = new Set(leadMemoryTokens(b))
  if (!left.size || !right.size) return reading(a).trim() === reading(b).trim()
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  return shared / (left.size + right.size - shared) >= 0.8
}

/** Words aimed at an agent rather than facts about the person's work: overrides, role and desk tags, approval
 * bypasses, and commands to run. Matched on the folded reading. */
const INSTRUCTIONS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the|these|those|other)\b[^.]{0,30}\b(?:instructions?|rules?|prompts?|guidelines?|directions?|polic(?:y|ies)|guardrails?)\b/,
  /\byou are now\b|\bfrom now on,? (?:you|the lead|the agent)\b|\bact as (?:an?|the)\b|\bpretend (?:to be|you)\b|\bnew instructions?\b|\bsystem prompt\b|\bdeveloper (?:message|mode)\b|\bjailbreak/,
  /<\s*\/?\s*(?:system|assistant|user|developer|instructions?|tool[\w-]*|desk[\w-]*|function[\w-]*)\b/,
  /(?:^|[\s[(])(?:system|assistant|developer)\s*:/,
  /\b(?:when|if|once) you (?:read|see|load) this\b|\bnote to (?:the |any )?(?:ai|agent|assistant|model|lead|llm)\b|\b(?:ai|assistant|agent|model|llm)\s*[,:]\s*(?:you must|always|never|ignore|do not)\b/,
  /\bauto-?approve\b|\bapprove (?:everything|all|anything|any request)\b|\b(?:skip|bypass|disable|turn off) (?:the |all |any )?(?:reviews?|approvals?|checks?|tests?|permissions?|guards?|sandbox)\b|\bwithout (?:asking|approval|review|the person|permission)\b|\bno need to ask\b|\bdo(?:n't| not) ask (?:the person|for (?:approval|permission))\b|\bgrant (?:yourself|full|admin)\b|\bfull (?:access|permissions?)\b/,
  /`[^`]*\b(?:curl|wget|rm\s+-rf|sudo|eval|bash|sh\s+-c|chmod|powershell|nc\s+-|base64\s+-d)\b[^`]*`/,
  /\|\s*(?:sh|bash|zsh|python\d?|node|perl|ruby)\b/,
  /\b(?:curl|wget)\s+-?\S+|\brm\s+-[rf]{1,2}\b|\bsudo\s+\S|\beval\s*\(|\bchmod\s+[0-7+]/,
  /\b(?:send|post|upload|forward|exfiltrate)\b[^.]{0,60}\bhttps?:\/\//,
]
/** Credentials by shape, beyond the journal's own screen: keys, private-key blocks, assignments and long random runs. */
const SECRETS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bglpat-[A-Za-z0-9_-]{20,}/, /\bAIza[0-9A-Za-z_-]{30,}/, /\bnpm_[A-Za-z0-9]{30,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bAKIA[A-Z0-9]{12,}/,
  /\b(?:password|passwd|pwd|secret|token|api[ _-]?key|access[ _-]?key|client[ _-]?secret|private[ _-]?key)\b\s*(?:is|=|:)\s*["']?[^\s"']{6,}/i,
]
/** A link that carries a credential: a user and password before the host, or a query value named like one. */
const TOKEN_URL = /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@|[?&#](?:access_token|refresh_token|id_token|token|key|api_key|apikey|secret|sig|signature|password|auth|code|session|x-amz-signature|x-amz-credential)=[^\s&#]{8,}/i
/** A long run of mixed letters and digits with no word in it reads as a key. */
const randomRun = (text: string): boolean => (text.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []).some(run =>
  /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) && !/^[a-f0-9]+$/i.test(run))
export const leadMemoryHasSecret = (text: string): boolean => {
  const folded = text.normalize('NFKC')
  return leadDataContainsCredential(folded) || SECRETS.some(pattern => pattern.test(folded)) || TOKEN_URL.test(folded) || randomRun(folded)
}
/** The same text with whatever reads as a credential replaced, for anything that has to show or record a refusal. */
export const leadMemoryRedact = (text: string): string => {
  let out = text.normalize('NFKC')
  for (const pattern of [...SECRETS, TOKEN_URL]) out = out.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), '[redacted]')
  return out.replace(/[A-Za-z0-9+/_=-]{32,}/g, run => /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) ? '[redacted]' : run)
}
/** Output pasted in rather than a sentence: a fenced block, more than three lines, quoted lines, or a long quoted span. */
const quotedOutput = (lines: readonly string[]): boolean => {
  const filled = lines.filter(Boolean)
  return filled.length > 3 || filled.some(line => /^(?:```|~~~|>)/.test(line)) ||
    /["\u201c\u201d\u00ab\u00bb'`][^"\u201c\u201d\u00ab\u00bb'`]{160,}["\u201c\u201d\u00ab\u00bb'`]/.test(filled.join(' '))
}

export type LeadMemoryScan = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: LeadMemoryRefusal }
/**
 * The scan every proposal passes before it reaches the inbox, in a fixed order: cleaned, then checked for credentials,
 * words aimed at an agent and pasted output, then for length once it is one line. Repeats and declined lines are the
 * store's to check, against what it holds.
 */
export const leadMemoryScan = (raw: string): LeadMemoryScan => {
  const lines = leadMemoryCleanLines(raw), text = leadMemoryFold(raw)
  if (!text) return { ok: false, reason: 'empty' }
  if (leadMemoryHasSecret(lines.join('\n'))) return { ok: false, reason: 'secret' }
  const read = reading(lines.join('\n'))
  if (INSTRUCTIONS.some(pattern => pattern.test(read))) return { ok: false, reason: 'instruction' }
  if (quotedOutput(lines)) return { ok: false, reason: 'quoted-output' }
  if (text.length > LEAD_MEMORY_LIMITS.textChars) return { ok: false, reason: 'too-long' }
  return { ok: true, text }
}
