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
  hover: Paint
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

/** Build the complete color-disabled or standard-ANSI theme. */
export function createTheme(enabled: boolean): TuiTheme {
  const accent = ansi(enabled, 36, 39)
  const bold = ansi(enabled, 1, 22)
  const dim = ansi(enabled, 2, 22)
  const diffAdded = ansiSequence(enabled, '48;2;12;48;28', '49')
  const diffRemoved = ansiSequence(enabled, '48;2;58;23;31', '49')
  const error = ansi(enabled, 31, 39)
  // SGR dim delegates contrast to the terminal and can make persistent chrome
  // nearly invisible. Use a stable, high-luminance secondary foreground for
  // information that is subordinate but still needs to remain readable.
  const secondary = ansiSequence(enabled, '38;2;148;163;184', '39')
  const reasoning = secondary
  const success = ansi(enabled, 32, 39)
  // Tool titles need more luminance than standard ANSI blue on dark terminals.
  const tool = ansiSequence(enabled, '38;2;125;211;252', '39')
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
    hover,
    reasoning,
    success,
    surfaceBorder: secondary,
    tool,
    underline,
    user,
    userBlock,
    warning,
    select,
    editor: {
      borderColor: dim,
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
      quoteBorder: dim,
      hr: dim,
      listBullet: accent,
      bold,
      italic: ansi(enabled, 3, 23),
      strikethrough: ansi(enabled, 9, 29),
      underline: ansi(enabled, 4, 24),
    },
  }
}
