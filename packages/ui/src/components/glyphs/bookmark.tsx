// Vendored from lucide-animated (`bookmark`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const BOOKMARK_VARIANTS: Variants = {
  normal: { scaleY: 1, scaleX: 1 },
  animate: {
    scaleY: [1, 1.3, 0.9, 1.05, 1],
    scaleX: [1, 0.9, 1.1, 0.95, 1],
    transition: {
      duration: 0.6,
      ease: 'easeOut',
    },
  },
}

export const BookmarkGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="bookmark" {...props}>
    <motion.path
      animate={controls}
      d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"
      style={{ originY: 0.5, originX: 0.5 }}
      variants={BOOKMARK_VARIANTS}
    />
  </Glyph>
)
