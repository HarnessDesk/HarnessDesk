// Vendored from lucide-animated (`folder-input`); ./index.ts says what changed.

import { motion, type Transition, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const ARROW_VARIANTS: Variants = {
  normal: { x: 0 },
  animate: { x: [0, 2, 0] },
}

const ARROW_TRANSITION: Transition = {
  times: [0, 0.4, 1],
  duration: 0.5,
}

export const FolderInputGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="folder-input" {...props}>
    <path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1" />
    <motion.g
      animate={controls}
      initial="normal"
      transition={ARROW_TRANSITION}
      variants={ARROW_VARIANTS}
    >
      <path d="M2 13h10" />
      <path d="m9 16 3-3-3-3" />
    </motion.g>
  </Glyph>
)
