import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
} from '@earendil-works/pi-tui'

type Paint = (text: string) => string

/** Terminal presentation roles used by the renderer and dialogs. */
export interface TuiTheme {
  accent: Paint
  assistant: Paint
  bold: Paint
  dim: Paint
  diffAdded: Paint
  diffRemoved: Paint
  error: Paint
  hover: Paint
  reasoning: Paint
  success: Paint
  underline: Paint
  user: Paint
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
  const assistant = ansi(enabled, 34, 39)
  const bold = ansi(enabled, 1, 22)
  const dim = ansi(enabled, 2, 22)
  const diffAdded = ansiSequence(enabled, '48;2;12;48;28', '49')
  const diffRemoved = ansiSequence(enabled, '48;2;58;23;31', '49')
  const error = ansi(enabled, 31, 39)
  const reasoning = ansi(enabled, 90, 39)
  const success = ansi(enabled, 32, 39)
  const underline = ansi(enabled, 4, 24)
  const warning = ansi(enabled, 33, 39)
  const user = (text: string): string => bold(warning(text))
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
    assistant,
    bold,
    dim,
    diffAdded,
    diffRemoved,
    error,
    hover,
    reasoning,
    success,
    underline,
    user,
    warning,
    select,
    editor: {
      borderColor: dim,
      selectList: select,
    },
    markdown: {
      heading: text => bold(accent(text)),
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
