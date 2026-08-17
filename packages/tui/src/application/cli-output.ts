import type {
  CliHelpTopic,
  CliUsageError,
  CompletionShell,
} from './cli.ts'

const ROOT_HELP = `Usage:
  dsh-tui [options] [prompt...]
  dsh-tui resume <session-id> [options] [prompt...]
  dsh-tui resume --last [options] [prompt...]
  dsh-tui <command> [options]

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
      --resume <session-id>    Resume a session (compatibility form)
      --no-color               Disable ANSI color in the TUI

Launcher options:
      --patch <path>           Apply a profile overlay (repeatable)
  -v, -V, --version            Show the dsh-tui version
  -h, --help                   Show help

Examples:
  dsh-tui "explain this repository"
  dsh-tui resume --last "continue the unfinished task"
  dsh-tui sessions --json
  dsh-tui exec -C ./project "run the tests"
  dsh-tui doctor
`

const TOPIC_HELP: Record<CliHelpTopic, string> = {
  resume: `Usage:
  dsh-tui resume <session-id> [options] [prompt...]
  dsh-tui resume --last [options] [prompt...]

Resume an exact persisted session or the latest non-blank root session. Interactive
options such as --image, --model, --effort, --permission-mode, and
--plan remain available. A trailing prompt is submitted after startup settings
and attachments are ready.
`,
  sessions: `Usage:
  dsh-tui sessions [list] [--json] [--patch <path>]

List persisted sessions without entering raw terminal mode. The default output
is tabular; --json emits stable machine-readable rows.
`,
  exec: `Usage:
  dsh-tui exec [-C <path>] [--patch <path>] [prompt...]

Run one task through the Harness headless profile, print the final assistant
message, and exit. When prompt is omitted, non-interactive stdin is used.
`,
  doctor: `Usage:
  dsh-tui doctor [--json]

Check Node.js, packaged executables, workspace access, terminal/clipboard
adapters, and TUI profile state. Doctor is read-only and never initializes or
repairs the profile.
`,
  completion: `Usage:
  dsh-tui completion <bash|zsh|fish|powershell>

Print a shell completion script to stdout.
`,
  config: `Usage:
  dsh-tui config [show] [--patch <path>]
  dsh-tui config default

Print the effective TUI profile composition, or its bundle defaults without
user layers. Profile overlays apply only to the effective view.
`,
  plugin: `Usage:
  dsh-tui plugin <pnpm-args...>

Forward plugin management to pnpm in the TUI profile. Examples:
  dsh-tui plugin list
  dsh-tui plugin add <package>
  dsh-tui plugin remove <package>
`,
}

export function renderCliHelp(topic?: CliHelpTopic): string {
  return topic === undefined ? ROOT_HELP : TOPIC_HELP[topic]
}

export function renderCliVersion(version: string): string {
  return `dsh-tui ${version}\n`
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
  '--resume',
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
    '_dsh_tui() {',
    '  local cur="${COMP_WORDS[COMP_CWORD]}"',
    `  COMPREPLY=($(compgen -W "${words}" -- "$cur"))`,
    '}',
    'complete -F _dsh_tui dsh-tui',
    '',
  ].join('\n')
  if (shell === 'zsh') return [
    '#compdef dsh-tui',
    `_dsh_tui() { compadd -- ${words} }`,
    'compdef _dsh_tui dsh-tui',
    '',
  ].join('\n')
  if (shell === 'fish') return [
    'complete -c dsh-tui -f',
    ...COMPLETION_WORDS.map(word => `complete -c dsh-tui -a '${word}'`),
    '',
  ].join('\n')
  return [
    'Register-ArgumentCompleter -Native -CommandName dsh-tui -ScriptBlock {',
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
    `dsh-tui: ${error.message}`,
    ...(error.suggestion === undefined ? [] : [error.suggestion]),
    'Run "dsh-tui --help" for usage.',
    '',
  ].join('\n')
}
