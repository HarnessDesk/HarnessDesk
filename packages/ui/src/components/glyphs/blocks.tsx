// Vendored from lucide-animated (`blocks`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const VARIANTS: Variants = {
  normal: { translateX: 0, translateY: 0 },
  animate: { translateX: -4, translateY: 4 },
}

export const BlocksGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="blocks" {...props}>
    <path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3" />
    <motion.path
      animate={controls}
      d="M14 3h7v7h-7z"
      variants={VARIANTS}
    />
  </Glyph>
)
