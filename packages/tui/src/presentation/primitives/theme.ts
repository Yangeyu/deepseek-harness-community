/** Shared color roles for terminal presentation components. */
import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
} from '@earendil-works/pi-tui'
import { stripTerminalSequences } from '@earendil-works/pi-tui'

type Paint = (text: string) => string

/** Terminal presentation roles used by the renderer and dialogs. */
export interface TuiTheme {
  accent: Paint
  bold: Paint
  dim: Paint
  secondary: Paint
  diffAdded: Paint
  diffRemoved: Paint
  error: Paint
  focusRow: Paint
  hover: Paint
  imageReference: Paint
  reasoning: Paint
  success: Paint
  surfaceBorder: Paint
  tool: Paint
  underline: Paint
  user: Paint
  userBlock: Paint
  warning: Paint
  editor: EditorTheme
  markdown: MarkdownTheme
  select: SelectListTheme
}

function ansi(enabled: boolean, open: number, close: number): Paint {
  return enabled ? text => `\u001b[${open}m${text}\u001b[${close}m` : text => text
}

function ansiSequence(enabled: boolean, open: string, close: string): Paint {
  return enabled ? text => `\u001b[${open}m${text}\u001b[${close}m` : text => text
}

// oxlint-disable-next-line no-control-regex -- Terminal SGR sequences are the syntax being parsed.
const SGR_SEQUENCE = /\u001b\[[0-?]*[ -/]*m/gu

/** Keep a row-owned background active across nested styles and truncation resets. */
function ansiBackground(enabled: boolean, open: string): Paint {
  if (!enabled) return text => text
  const start = `\u001b[${open}m`
  return text => `${start}${text.replace(SGR_SEQUENCE, sequence => `${sequence}${start}`)}\u001b[49m`
}

/** Build the complete color-disabled or standard-ANSI theme. */
export function createTheme(enabled: boolean): TuiTheme {
  const accent = ansi(enabled, 36, 39)
  const bold = ansi(enabled, 1, 22)
  const diffAdded = ansiSequence(enabled, '48;2;12;48;28', '49')
  const diffRemoved = ansiSequence(enabled, '48;2;58;23;31', '49')
  const error = ansi(enabled, 31, 39)
  const focusRow = ansiBackground(enabled, '48;2;42;70;98')
  // Never delegate text contrast to terminal-specific SGR dim. Keep both
  // secondary levels explicit so their hierarchy is stable across terminals.
  const secondary = ansiSequence(enabled, '38;2;188;198;214', '39')
  const dim = ansiSequence(enabled, '38;2;148;163;184', '39')
  const structure = ansiSequence(enabled, '38;2;100;116;139', '39')
  const reasoning = secondary
  const success = ansi(enabled, 32, 39)
  // Tool titles need more luminance than standard ANSI blue on dark terminals.
  const tool = ansiSequence(enabled, '38;2;125;211;252', '39')
  const imageReference = tool
  const underline = ansi(enabled, 4, 24)
  const warning = ansi(enabled, 33, 39)
  const user = ansi(enabled, 97, 39)
  const userBlock = ansiSequence(enabled, '48;2;36;42;58', '49')
  const reverse = ansi(enabled, 7, 27)
  const hover = (text: string): string => bold(accent(text))
  const select: SelectListTheme = {
    selectedPrefix: accent,
    selectedText: reverse,
    description: dim,
    scrollInfo: dim,
    noMatch: warning,
  }
  return {
    accent,
    bold,
    dim,
    secondary,
    diffAdded,
    diffRemoved,
    error,
    focusRow,
    hover,
    imageReference,
    reasoning,
    success,
    surfaceBorder: structure,
    tool,
    underline,
    user,
    userBlock,
    warning,
    select,
    editor: {
      borderColor: structure,
      selectList: select,
    },
    markdown: {
      // pi-tui deliberately passes the literal marker for level 3+ headings
      // through the theme. Hide that marker so rendered Markdown never looks
      // like unparsed source while fenced code remains untouched.
      heading: text => /^#{3,6} $/u.test(stripTerminalSequences(text)) ? '' : bold(accent(text)),
      link: accent,
      linkUrl: dim,
      code: warning,
      codeBlock: warning,
      codeBlockBorder: text => {
        const language = text.startsWith('```') ? text.slice(3) : ''
        return language === '' ? '' : dim(`  ${language}`)
      },
      quote: dim,
      quoteBorder: structure,
      hr: structure,
      listBullet: accent,
      bold,
      italic: ansi(enabled, 3, 23),
      strikethrough: ansi(enabled, 9, 29),
      underline: ansi(enabled, 4, 24),
    },
  }
}
