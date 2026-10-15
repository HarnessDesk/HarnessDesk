// Vendored from lucide-animated (`folder-open`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: [0, -8, 6, -4, 0],
    transition: {
      ease: 'easeInOut',
      rotate: {
        duration: 0.6,
      },
    },
  },
}

export const FolderOpenGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="folder-open" {...props}>
    <motion.path
      animate={controls}
      d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
      initial="normal"
      style={{ transformOrigin: '12px 12px' }}
      variants={VARIANTS}
    />
  </Glyph>
)
