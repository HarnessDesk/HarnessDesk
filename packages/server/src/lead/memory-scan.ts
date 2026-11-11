import { leadDataContainsCredential } from '@harnessdesk/lead'
import { LEAD_MEMORY_LIMITS, type LeadMemoryRefusal } from '@harnessdesk/protocol'

/**
 * What the desk checks before a proposal reaches the person's inbox. The text is the model's, or a line it wrote in a
 * reply, so it is read the way an attacker would spell it: line terminators and invisible characters are taken out
 * before anything is matched, compatibility forms are folded, and only then are its structure and words checked.
 */
const INVISIBLE = /[\p{Cf}\u115f\u1160\u180e\u2800\u3164\uffa0]/gu
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const TERMINATORS = /\r\n|[\r\v\f\u0085\u2028\u2029]/g
/** Every line terminator becomes one newline, compatibility forms fold to their plain letters, then control and
 * invisible characters go, and lines lose their edges: the steps the Lead's own reading of an entry takes. */
export const leadMemoryCleanLines = (text: string): string[] => text.replace(TERMINATORS, '\n').normalize('NFKC').replace(TERMINATORS, '\n')
  .replace(CONTROLS, '').replace(INVISIBLE, '').split('\n').map(line => line.trim())
/** The entry as kept: one line, single-spaced. */
export const leadMemoryFold = (text: string): string => leadMemoryCleanLines(text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
/** For matching only: compatibility forms folded and lower-cased, so full-width or styled letters read as plain ones. */
const reading = (text: string): string => text.normalize('NFKC').toLowerCase()
/** Lower-case Cyrillic and Greek letters drawn like Latin ones, by the Latin letter they pass for. */
const LOOKALIKES: Readonly<Record<string, string>> = {
  '\u0430': 'a', '\u0432': 'b', '\u0435': 'e', '\u0451': 'e', '\u0437': '3', '\u0456': 'i', '\u0457': 'i', '\u0458': 'j', '\u043a': 'k', '\u043c': 'm', '\u043d': 'h',
  '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0442': 't', '\u0443': 'y', '\u0445': 'x', '\u0455': 's', '\u0501': 'd', '\u051b': 'q', '\u051d': 'w', '\u04bb': 'h',
  '\u0261': 'g', '\u03b1': 'a', '\u03b2': 'b', '\u03b5': 'e', '\u03b7': 'n', '\u03b9': 'i', '\u03ba': 'k', '\u03bd': 'v', '\u03bf': 'o', '\u03c1': 'p', '\u03c4': 't',
  '\u03c5': 'u', '\u03c7': 'x', '\u03b3': 'y', '\u03c9': 'w', '\u03c3': 'o', '\u03c2': 'c', '\u03bc': 'u',
}
const LOOKALIKE = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'g')
/** The reading the instruction patterns match: lookalike letters from other scripts taken as the Latin ones they
 * imitate, so a word spelled with a Cyrillic o still reads as the word. Never shown and never stored. */
const skeleton = (text: string): string => reading(text).replace(LOOKALIKE, letter => LOOKALIKES[letter] ?? letter)

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
/** "Don't", "do not", "never", "no", 不, 别, ない: a note and its negation share nearly every word, so near-matching
 * reads whether each side is negated apart from its words, and two sides that differ are never the same note. Works on
 * a note and on its key (where "don't" reads "don t"). Only words that negate count: in "no-op", "do nothing",
 * "without", 不错 ("not bad") and 非常 ("very") nothing is negated, so they are words like any other, and a "don't" in
 * front of such a note still reads as its opposite. 无法 is "cannot" and still counts. A tidy's merge is the observer
 * model's judgement and does not pass through this check. */
const NEGATION_AUX = /\b(?:do|does|did|is|are|was|were|wo|ca|should|would|could|must|have|has|had|need)n(?:['\u2019]|\s)t\b|\b(?:do|does|did)\s+not\b/g
const NEGATION_WORD = /\b(?:not|never|no(?!-)|none|nobody|nowhere|neither|nor|cannot)\b/g
const NEGATION_CJK = /不(?![错錯])|非(?!常)|[别別没沒勿无無莫]|ない|ません/g
const polarity = (text: string): { readonly negative: boolean; readonly rest: string } => {
  const read = reading(text).replace(NEGATION_AUX, ' not ')
  const rest = read.replace(NEGATION_WORD, ' ').replace(NEGATION_CJK, ' ')
  return { negative: rest !== read, rest }
}
/** Two entries say the same thing: equal once normalised, or sharing at least 80% of their words, negated alike. */
export const leadMemoryNear = (a: string, b: string): boolean => {
  const one = polarity(a), two = polarity(b)
  if (one.negative !== two.negative) return false
  const left = new Set(leadMemoryTokens(one.rest)), right = new Set(leadMemoryTokens(two.rest))
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
  // The same, in Chinese: overriding earlier words, skipping review or approval, and acting without the person.
  /(?:忽略|无视|無視|不要理会|不要理會|忘记|忘記|忘掉|覆盖|覆蓋)[^。.]{0,20}(?:指令|指示|命令|规则|規則|提示词|提示詞|要求|设定|設定)/u,
  /(?:不需要|不用|无需|無需|不必|跳过|跳過|绕过|繞過|省略|免去)[^。.]{0,12}(?:review|审查|審查|审核|審核|审批|審批|批准|确认|確認|测试|測試|检查|檢查|同意)/u,
  /(?:直接|自动|自動|悄悄|默默)[^。.]{0,4}(?:合并|合併|merge|批准|通过|通過|推送|push|发布|發布|部署|删除|刪除)/u,
  /(?:你现在是|你現在是|从现在起你|從現在起你|从现在开始你|從現在開始你|假装你是|假裝你是|扮演)/u,
  // Merging without anyone looking, never asking the person, and a new rule that puts itself over the person: the
  // Lead's own ("your new rule"), or one handed to it ("New rule: …", "a new rule for you"). A rule someone else follows
  // ("the team uses a new rule: …") or where the rules live is a fact.
  /\b(?:merges?|prs?|pull requests?|changes?)\b[^.]{0,30}\b(?:never|don'?t|do not|doesn'?t|does not|no longer|won'?t)\b[^.]{0,12}\b(?:needs?|requires?|gets?)\b[^.]{0,12}\b(?:reviews?|approvals?|sign-?offs?)\b/,
  /\bnever (?:ask|check with|confirm with|wait for|consult)\b|\b(?:stop|no more) asking\b|\byour new rules?\b|\bnew rules? for you\b|(?:^|[.;!?\n]\s*)(?:(?:ok|okay|so|and|here'?s|here is)[\s,]+)?(?:(?:a|the|my|one)\s+)?new rules?\s*:/,
  /(?:绿了|綠了|过了|過了|通过了?|通過了?|green)[^。.]{0,8}(?:就|直接)+(?:合|merge)/u,
  /不(?:用|必|需要)等(?:人|我|别人|別人|人家)?(?:看|审|審|review|确认|確認|同意|批)/u,
  /(?:永远|永遠|从不|從不|再也不|不要再|别再|別再)[^。.]{0,4}(?:问|問|请示|請示|确认|確認)/u,
  /(?:新规则|新規則|新的规则|新的規則|新指令|新的指令)/u,
  // And in Japanese.
  /(?:無視|忘れ)[^。.]{0,4}(?:て|ろ|なさい|ください)|(?:指示|命令|ルール|プロンプト)を(?:無視|忘れ)/u,
  /(?:レビュー|承認|確認|テスト|審査)(?:は|を|も)?(?:不要|いらない|要らない|なしで|無しで|スキップ|飛ばして|省略)/u,
  /(?:そのまま|直接|勝手に|自動で?)(?:マージ|承認|プッシュ|デプロイ|削除)/u,
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
/** Keys by their fixed prefix, matched again with the spaces and line breaks between pieces taken out, so a key broken
 * across lines still reads as one. A piece starts where a word starts, and the pieces after it hold no punctuation. */
const SPLIT_SECRETS: readonly RegExp[] = [
  /^sk-(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{20,}/, /^glpat-(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{20,}/, /^AIza[0-9A-Za-z_-]{30,}/, /^npm_[A-Za-z0-9]{30,}/,
  /^xox[abposr]-(?=[A-Za-z-]*\d)[A-Za-z0-9-]{10,}/, /^gh[pousr]_[A-Za-z0-9]{20,}/, /^github_pat_[A-Za-z0-9_]{20,}/, /^AKIA[A-Z0-9]{12,}/,
  /^-----BEGIN[A-Z]*PRIVATEKEY-----/,
]
const splitSecret = (text: string): boolean => {
  const pieces = text.normalize('NFKC').split(/\s+/u).filter(Boolean)
  return pieces.some((piece, at) => {
    let joined = piece.replace(/^["'`(\[<]+/, '')
    for (let next = at + 1; next < Math.min(pieces.length, at + 8) && /^[A-Za-z0-9_-]+[.,;:!?)"'`\]]*$/.test(pieces[next]!); next++) {
      joined += pieces[next]
      if (SPLIT_SECRETS.some(pattern => pattern.test(joined))) return true
    }
    return false
  })
}
export const leadMemoryHasSecret = (text: string): boolean => {
  const folded = text.normalize('NFKC')
  return leadDataContainsCredential(folded) || SECRETS.some(pattern => pattern.test(folded)) || TOKEN_URL.test(folded) || randomRun(folded) || splitSecret(folded)
}
/** The same text with whatever reads as a credential replaced, for anything that has to show or record a refusal. */
export const leadMemoryRedact = (text: string): string => {
  let out = text.normalize('NFKC')
  for (const pattern of [...SECRETS, TOKEN_URL]) out = out.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), '[redacted]')
  out = out.replace(/[A-Za-z0-9+/_=-]{32,}/g, run => /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) ? '[redacted]' : run)
  // A key broken across lines leaves no single piece to cut out, so nothing of the text is shown.
  return splitSecret(out) ? '[redacted]' : out
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
  const read = skeleton(lines.join('\n'))
  if (INSTRUCTIONS.some(pattern => pattern.test(read))) return { ok: false, reason: 'instruction' }
  if (quotedOutput(lines)) return { ok: false, reason: 'quoted-output' }
  if (text.length > LEAD_MEMORY_LIMITS.textChars) return { ok: false, reason: 'too-long' }
  return { ok: true, text }
}

/** The verb that asks the Lead to keep something, at the very start once any address or "ok" before it is set aside. */
const REMEMBER: readonly RegExp[] = [
  /^(?:请|請|帮我|幫我|你)?(?:以后|以後|今后|今後)?(?:都|也|要|一定要)?(?:记住|記住|记下|記下|记一下|記一下|记得|記得|记着|記著)(?:以后|以後|今后|今後)?(?:这条|這條|这个|這個|这句|這句|一下|下来|下來)?[\s:,、]*([\s\S]+)$/u,
  /^(?:これを|これ)?(?:覚えて(?:おいて|ください|おいてください)?|メモして|記憶して)[\s:,、]*([\s\S]+)$/u,
  /^(?:(?:please|pls|kindly|can you|could you|would you|will you|i want you to|i need you to|from now on|going forward|always)[\s,]+)*(?:remember|memori[sz]e|keep in mind|note down|make a note(?: of)?)\b(?:\s+(?:this|that))?\s*[:,\-–—]\s*([\s\S]+)$/iu,
  // "Remember when / the time / how…" looks back at a moment; it is a question, not words to keep.
  /^(?:(?:please|from now on|going forward)\s+)?(?:remember|memori[sz]e|keep in mind|note down|make a note(?: of)?)\b(?!\s+(?:when|the time|how)\b)(?:\s+(?:this|that))?\s+([\s\S]+)$/iu,
]
/** What may come before the verb: up to three short words of address or a yes ("Hey Dex,", "好的，Dex，", "@Dex",
 * "嗯嗯"), each at most 16 characters. */
const ADDRESS = /^(?:@?[\p{L}\p{N}_.'\u2019-]{1,16}[\s,、:;!~]*){1,3}$/u
const STARTS_CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
/** Where the address ends, it must say so: a comma or colon after it, an `@` name, or, before a Chinese or Japanese verb,
 * a space or a name in Latin letters ("嗯嗯 记住", "Dex记住"). "I will remember to…" and "我不记得了" are not requests. */
const addressed = (address: string, rest: string): boolean =>
  /[,、:;!~]\s*$/.test(address) || address.startsWith('@') || STARTS_CJK.test(rest) && (/\s$/.test(address) || /^[A-Za-z0-9_.-]+$/.test(address))
/**
 * The words a person's message asks the Lead to keep, when it opens by asking that ("记住这条：…", "Hey Dex, remember:
 * …"); null for any other message. The text is cleaned first, as a memory entry is, so an invisible character cannot
 * hide the verb. Only the opening is read, past at most three words of address: a message that mentions remembering
 * somewhere later is just a message.
 */
export const leadRememberRequest = (text: string): string | null => {
  const opening = leadMemoryCleanLines(text).join('\n').trim()
  for (let at = 0; at <= Math.min(opening.length - 1, 60); at++) {
    const address = opening.slice(0, at), rest = opening.slice(at)
    if (at > 0 && (!ADDRESS.test(address) || !addressed(address, rest))) continue
    for (const pattern of REMEMBER) {
      const words = pattern.exec(rest)?.[1]?.trim()
      // "你记得吗" asks whether the Lead remembers; a particle alone is not words to keep.
      if (words && !/^[吗嗎呢么麼了吧?？!！。.\s]*$/u.test(words)) return words
    }
  }
  return null
}
