// Vendored from lucide-animated (`search`); ./index.ts says what changed.

import { MotionGlyph, type GlyphProps } from './glyph'

export const SearchGlyph = ({ controls, ...props }: GlyphProps) => (
  <MotionGlyph
    name="search"
    animate={controls}
    transition={{
      duration: 1,
      bounce: 0.3,
    }}
    variants={{
      normal: { x: 0, y: 0 },
      animate: {
        x: [0, 0, -3, 0],
        y: [0, -4, 0, 0],
      },
    }}
    {...props}
  >
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </MotionGlyph>
)
