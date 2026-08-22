import type {
  CliHelpTopic,
  CliUsageError,
  CompletionShell,
} from './cli.ts'

const ROOT_HELP = `Usage:
  dscode [options] [prompt...]
  dscode resume <session-id> [options] [prompt...]
  dscode resume --last [options] [prompt...]
  dscode <command> [options]

Commands:
  resume       Resume a session and optionally submit a prompt
  sessions     List persisted sessions and their status
  exec         Run one non-interactive task through the Harness headless profile
  doctor       Inspect the local launcher without changing its profile
  completion   Generate shell completion
  config       Print the effective or default TUI profile composition
  plugin       Manage plugins in the TUI profile through pnpm
  help         Show command-specific help

Interactive options:
  -C, --cwd <path>             Start in this working directory
  -i, --image <path>           Attach an image at startup (repeatable)
  -m, --model <model>          Select a unique model id or provider/model route
      --effort <level>         Select reasoning effort for the startup model
      --permission-mode <id>  Select a Harness permission preset
      --plan                   Enter Plan Mode before submitting the initial prompt
      --no-color               Disable ANSI color in the TUI

Launcher options:
      --patch <path>           Apply a profile overlay (repeatable)
  -v, -V, --version            Show the dscode version
  -h, --help                   Show help

Examples:
  dscode "explain this repository"
  dscode resume --last "continue the unfinished task"
  dscode sessions --json
  dscode exec -C ./project "run the tests"
  dscode doctor
`

const TOPIC_HELP: Record<CliHelpTopic, string> = {
  resume: `Usage:
  dscode resume <session-id> [options] [prompt...]
  dscode resume --last [options] [prompt...]

Resume an exact persisted session or the latest non-blank root session. Interactive
options such as --image, --model, --effort, --permission-mode, and
--plan remain available. A trailing prompt is submitted after startup settings
and attachments are ready.
`,
  sessions: `Usage:
  dscode sessions [list] [--json] [--patch <path>]

List persisted sessions without entering raw terminal mode. The default output
is tabular; --json emits stable machine-readable rows.
`,
  exec: `Usage:
  dscode exec [-C <path>] [--patch <path>] [prompt...]

Run one task through the Harness headless profile, print the final assistant
message, and exit. When prompt is omitted, non-interactive stdin is used.
`,
  doctor: `Usage:
  dscode doctor [--json]

Check Node.js, packaged executables, workspace access, terminal/clipboard
adapters, and TUI profile state. Doctor is read-only and never initializes or
repairs the profile.
`,
  completion: `Usage:
  dscode completion <bash|zsh|fish|powershell>

Print a shell completion script to stdout.
`,
  config: `Usage:
  dscode config [show] [--patch <path>]
  dscode config default

Print the effective TUI profile composition, or its bundle defaults without
user layers. Profile overlays apply only to the effective view.
`,
  plugin: `Usage:
  dscode plugin <pnpm-args...>

Forward plugin management to pnpm in the TUI profile. Examples:
  dscode plugin list
  dscode plugin add <package>
  dscode plugin remove <package>
`,
}

export function renderCliHelp(topic?: CliHelpTopic): string {
  return topic === undefined ? ROOT_HELP : TOPIC_HELP[topic]
}

export function renderCliVersion(version: string): string {
  return `dscode ${version}\n`
}

const COMPLETION_WORDS = [
  'resume',
  'sessions',
  'exec',
  'doctor',
  'completion',
  'config',
  'plugin',
  'help',
  '-v',
  '-V',
  '--version',
  '-h',
  '--help',
  '-C',
  '--cwd',
  '-i',
  '--image',
  '-m',
  '--model',
  '--effort',
  '--permission-mode',
  '--plan',
  '--last',
  '--no-color',
  '--patch',
  '--json',
  'show',
  'default',
]

export function renderCompletion(shell: CompletionShell): string {
  const words = COMPLETION_WORDS.join(' ')
  if (shell === 'bash') return [
    '_dscode() {',
    '  local cur="${COMP_WORDS[COMP_CWORD]}"',
    `  COMPREPLY=($(compgen -W "${words}" -- "$cur"))`,
    '}',
    'complete -F _dscode dscode',
    '',
  ].join('\n')
  if (shell === 'zsh') return [
    '#compdef dscode',
    `_dscode() { compadd -- ${words} }`,
    'compdef _dscode dscode',
    '',
  ].join('\n')
  if (shell === 'fish') return [
    'complete -c dscode -f',
    ...COMPLETION_WORDS.map(word => `complete -c dscode -a '${word}'`),
    '',
  ].join('\n')
  return [
    'Register-ArgumentCompleter -Native -CommandName dscode -ScriptBlock {',
    '  param($wordToComplete)',
    `  '${COMPLETION_WORDS.join("','")}' -split ',' | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {`,
    '    [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_)',
    '  }',
    '}',
    '',
  ].join('\n')
}

/** Stable usage-error text shared by the launcher and direct profile boot. */
export function formatCliError(error: CliUsageError): string {
  return [
    `dscode: ${error.message}`,
    ...(error.suggestion === undefined ? [] : [error.suggestion]),
    'Run "dscode --help" for usage.',
    '',
  ].join('\n')
}
