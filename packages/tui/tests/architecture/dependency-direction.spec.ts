import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = resolve(import.meta.dirname, '../../src')

function sourceFiles(directory = sourceRoot): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name)
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : path.endsWith('.ts') ? [path] : []
  })
}

function sourcePath(path: string): string {
  return relative(sourceRoot, path).split(sep).join('/')
}

function importsOf(path: string): string[] {
  const source = readFileSync(path, 'utf8')
  const imports: string[] = []
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gu
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) imports.push(match[1])
  }
  return imports
}

function internalTarget(source: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  return sourcePath(resolve(dirname(source), specifier))
}

function topLevel(path: string): string {
  return path.split('/')[0] ?? ''
}

const crossModuleAllowlist = new Set([
  'rewind->composer/attachments/drafts.ts',
  'rewind->composer/image-reference.ts',
  'rewind->composer/input.ts',
  'rewind->composer/prompt-document.ts',
  'transcript->composer/image-reference-presentation.ts',
])

describe('TUI dependency direction', () => {
  it('keeps runtime, primitives, shell, modules, and adapters in their declared direction', () => {
    const violations: string[] = []
    for (const source of sourceFiles()) {
      const from = sourcePath(source)
      const fromParts = from.split('/')
      const contents = readFileSync(source, 'utf8')
      for (const specifier of importsOf(source)) {
        const target = internalTarget(source, specifier)
        if (target === undefined) {
          if ((from.startsWith('runtime/') || from.startsWith('presentation/'))
            && specifier === '@deepseek-ai/dsh-api-session-controller'
            && /\bSessionController\b/u.test(contents)) {
            violations.push(`${from} imports concrete Host service ${specifier}`)
          }
          continue
        }
        const targetLayer = topLevel(target)
        if (from.startsWith('runtime/')
          && ['application', 'infrastructure', 'modules', 'presentation'].includes(targetLayer)) {
          violations.push(`${from} -> ${target}`)
        }
        if (from.startsWith('presentation/primitives/')
          && targetLayer !== 'presentation') {
          violations.push(`${from} -> ${target}`)
        }
        if (from.startsWith('presentation/primitives/')
          && target.startsWith('presentation/')
          && !target.startsWith('presentation/primitives/')) {
          violations.push(`${from} -> ${target}`)
        }
        if (from.startsWith('presentation/shell/')
          && ['application', 'infrastructure'].includes(targetLayer)) {
          violations.push(`${from} -> ${target}`)
        }
        if (from.startsWith('presentation/shell/') && target.startsWith('modules/')) {
          const allowed = new Set([
            'modules/composer/execution-activity.ts',
            'modules/configuration/model.ts',
            'modules/task/model.ts',
          ])
          if (!allowed.has(target)) violations.push(`${from} -> ${target}`)
        }
        if (from.startsWith('modules/')
          && (targetLayer === 'application'
            || targetLayer === 'infrastructure'
            || target.startsWith('presentation/shell/'))) {
          violations.push(`${from} -> ${target}`)
        }
        if (fromParts[0] === 'modules' && target.startsWith('modules/')) {
          const sourceModule = fromParts[1]
          const targetParts = target.split('/')
          const targetModule = targetParts[1]
          if (sourceModule !== targetModule) {
            const edge = `${sourceModule}->${targetParts.slice(1).join('/')}`
            if (!crossModuleAllowlist.has(edge)) violations.push(`${from} -> ${target}`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps public entry points and retired implementation paths explicit', () => {
    const rootFiles = sourceFiles()
      .map(sourcePath)
      .filter(path => !path.includes('/'))
      .sort()
    expect(rootFiles).toEqual(['bailian.ts', 'index.ts', 'memory.ts', 'vision.ts', 'web.ts'])

    const retired = [
      'input/keymap.ts',
      'presentation/dialogs.ts',
      'presentation/layout.ts',
      'presentation/mouse.ts',
      'presentation/transcript.ts',
      'modules/composer/view/reference-editor.ts',
      'modules/composer/view/reference-rendering.ts',
      'runtime/controller.ts',
      'runtime/event-window.ts',
      'runtime/lifecycle/reducer.ts',
      'runtime/submission.ts',
      'trajectory/view.ts',
    ]
    const files = new Set(sourceFiles().map(sourcePath))
    expect(retired.filter(path => files.has(path))).toEqual([])
  })

  it('has one concrete render request and one raw terminal decoder boundary', () => {
    const requestRenderOwners: string[] = []
    const rawKeyOwners: string[] = []
    for (const source of sourceFiles()) {
      const path = sourcePath(source)
      const contents = readFileSync(source, 'utf8')
      if (contents.includes('.requestRender(')) requestRenderOwners.push(path)
      if (contents.includes('matchesKey(') || contents.includes('getKeybindings(')) rawKeyOwners.push(path)
    }
    expect(requestRenderOwners).toEqual(['application/create-application.ts'])
    expect(rawKeyOwners.every(path => path.startsWith('infrastructure/terminal/'))).toBe(true)
    expect(rawKeyOwners.sort()).toEqual([
      'infrastructure/terminal/decode-input.ts',
      'infrastructure/terminal/inline-reference-editor.ts',
    ])
  })

  it('keeps Session feature construction and Surface placement at their lifecycle owners', () => {
    const sessionConstructors = [
      'new ComposerProcess(',
      'new InteractionProcess(',
      'new SkillsProcess(',
      'new TaskProcess(',
      'new TrajectoryProcess(',
      'new TranscriptProcess(',
    ]
    for (const constructor of sessionConstructors) {
      const owners = sourceFiles()
        .filter(path => readFileSync(path, 'utf8').includes(constructor))
        .map(sourcePath)
      expect(owners, constructor).toEqual(['application/create-session-features.ts'])
    }

    const placementOwners = sourceFiles()
      .filter(path => readFileSync(path, 'utf8').includes('.setActiveSurface('))
      .map(sourcePath)
      .sort()
    expect(placementOwners).toEqual(['presentation/shell/surfaces/surface-host.ts'])

    const facade = readFileSync(resolve(sourceRoot, 'application/app.ts'), 'utf8')
    expect(facade).not.toMatch(/modules\/|presentation\/|infrastructure\//u)
    expect(sourceFiles().map(sourcePath)).toContain('application/snapshot.ts')
  })
})
