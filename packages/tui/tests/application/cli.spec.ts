import { describe, expect, it } from 'vitest'
import {
  CliUsageError,
  parseCliArgs,
  renderCliHelp,
  renderCompletion,
  tuiAppArgs,
} from '../../src/application/cli.ts'

describe('public command line contract', () => {
  it('parses one interactive startup intent without storing it in plugin config', () => {
    const parsed = parseCliArgs([
      '--patch', 'team.yml',
      '-C', '/workspace',
      '-i', 'first.png',
      '--image=second.webp',
      '-m', 'deepseek/chat',
      '--effort', 'high',
      '--permission-mode', 'workspace-write',
      '--plan',
      '--no-color',
      '--',
      'continue --carefully',
    ], { title: 'Terminal' })

    expect(parsed.kind).toBe('interactive')
    if (parsed.kind !== 'interactive') return
    expect(parsed.config).toEqual({ title: 'Terminal', cwd: '/workspace', color: false })
    expect(parsed.patches).toEqual(['team.yml'])
    expect(parsed.startup).toEqual({
      prompt: 'continue --carefully',
      imagePaths: ['first.png', 'second.webp'],
      model: 'deepseek/chat',
      reasoningEffort: 'high',
      permissionMode: 'workspace-write',
      plan: true,
    })
  })

  it('supports canonical exact and latest-session resume forms', () => {
    const exact = parseCliArgs(['resume', 'session-2', 'continue', 'working'])
    const latest = parseCliArgs(['resume', '--last', '--image', 'context.png', 'inspect'])

    expect(exact).toMatchObject({
      kind: 'interactive',
      startup: { resume: { kind: 'session', sessionId: 'session-2' }, prompt: 'continue working' },
    })
    expect(latest).toMatchObject({
      kind: 'interactive',
      startup: { resume: { kind: 'last' }, prompt: 'inspect', imagePaths: ['context.png'] },
    })
  })

  it('keeps a configured session as a startup default without copying CLI state into config', () => {
    const parsed = parseCliArgs([], { sessionId: 'configured-session', cwd: '/workspace' })
    expect(parsed).toMatchObject({
      kind: 'interactive',
      config: { sessionId: 'configured-session', cwd: '/workspace' },
      startup: { resume: { kind: 'session', sessionId: 'configured-session' } },
    })
  })

  it('parses profile-backed and launcher-only commands as distinct actions', () => {
    expect(parseCliArgs(['sessions', 'list', '--json', '--patch', 'extra.yml'])).toEqual({
      kind: 'sessions',
      json: true,
      patches: ['extra.yml'],
    })
    expect(parseCliArgs(['doctor', '--json'])).toEqual({ kind: 'doctor', json: true })
    expect(parseCliArgs(['completion', 'zsh'])).toEqual({ kind: 'completion', shell: 'zsh' })
    expect(parseCliArgs(['config', 'show', '--patch', 'extra.yml'])).toEqual({
      kind: 'config',
      defaults: false,
      patches: ['extra.yml'],
    })
    expect(parseCliArgs(['config', 'default'])).toEqual({ kind: 'config', defaults: true, patches: [] })
    expect(parseCliArgs(['plugin', 'list', '--depth', '0'])).toEqual({
      kind: 'plugin',
      args: ['list', '--depth', '0'],
    })
    expect(parseCliArgs(['exec', '-C', './project', '--patch', 'ci.yml', 'run', 'tests'])).toEqual({
      kind: 'exec',
      cwd: './project',
      prompt: 'run tests',
      patches: ['ci.yml'],
    })
  })

  it('serializes only app-owned arguments after launcher overlays are consumed', () => {
    const parsed = parseCliArgs(['--patch', 'extra.yml', 'resume', '--last', '--plan', 'finish'])
    expect(parsed.kind).toBe('interactive')
    if (parsed.kind !== 'interactive') return
    expect(tuiAppArgs(parsed)).toEqual(['resume', '--last', '--plan', '--', 'finish'])

    const exact = parseCliArgs(['resume', 'session-2'])
    expect(exact.kind).toBe('interactive')
    if (exact.kind === 'interactive') expect(tuiAppArgs(exact)).toEqual(['resume', 'session-2'])
  })

  it('rejects missing, conflicting, and misspelled options with usage errors', () => {
    expect(() => parseCliArgs(['--image', '--no-color'])).toThrow('--image requires a value')
    expect(() => parseCliArgs(['resume'])).toThrow('session id or --last')
    expect(() => parseCliArgs(['resume', 'one', '--cwd', '/other'])).toThrow('keeps its original workspace')
    expect(() => parseCliArgs(['--resum', 'one'])).toThrow(CliUsageError)
  })

  it('supports all version aliases as one informational action', () => {
    for (const flag of ['-v', '-V', '--version']) {
      expect(parseCliArgs([flag])).toEqual({ kind: 'version' })
      expect(renderCliHelp()).toContain(flag)
      expect(renderCompletion('bash')).toContain(flag)
    }
    expect(() => parseCliArgs(['--version', 'extra'])).toThrow('cannot be combined')
  })

  it('renders command-specific help from the same command catalog', () => {
    expect(parseCliArgs(['resume', '--help'])).toEqual({ kind: 'help', topic: 'resume' })
    expect(parseCliArgs(['help', 'doctor'])).toEqual({ kind: 'help', topic: 'doctor' })
    expect(renderCliHelp('sessions')).toContain('sessions [list] [--json]')
  })
})
