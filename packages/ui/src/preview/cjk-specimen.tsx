import { Button, Chip, Input, Text } from '../design'

/** The typography review's samples, plus Traditional Chinese. Fixture text only. */
const SAMPLES = [
  { lang: 'zh-Hans', label: 'Simplified Chinese', text: '你好，世界' },
  { lang: 'zh-Hant', label: 'Traditional Chinese', text: '你好，世界' },
  { lang: 'ja', label: 'Japanese', text: 'こんにちは世界' },
  { lang: 'ko', label: 'Korean', text: '안녕하세요 세계' },
] as const

/** Real reading text and controls: no face, size, weight or line overrides. */
export const CjkSpecimen = () => (
  <div data-testid="cjk-specimen" className="grid gap-4 p-4">
    <Text role="prose" data-cjk-latin="">HarnessDesk Hxgj</Text>
    {SAMPLES.map(({ lang, label, text }) => (
      <div key={lang} lang={lang} data-cjk-language={lang} className="grid gap-2">
        <Text role="meta">{label}</Text>
        <Text role="prose" data-cjk-sample="">
          {[...text].map((glyph, index) => <span key={index} data-cjk-glyph={index}>{glyph}</span>)}
        </Text>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline">{text}</Button>
          <Chip tone="neutral">{text}</Chip>
          <Input aria-label={`${label} sample`} defaultValue={text} className="w-48" />
        </div>
      </div>
    ))}
  </div>
)
