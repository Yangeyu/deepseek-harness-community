import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus, totalmem, platform, release, arch } from 'node:os'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { HistoryEntry } from '../../src/runtime/session/contracts.ts'
import type { ExecutionKey } from '../../src/runtime/execution/projection/types.ts'
import type { ModelRequest } from '../../src/runtime/execution/projection/model-call.ts'

// The original baseline returns canonical JSON directly; the new API returns a lazy descriptor.
// Keep this one compatibility boundary in the benchmark, not in production sources.
type ResolveRequest = typeof import('../../src/runtime/execution/projection/model-call.ts').resolveModelRequest
type RequestModule = { resolveModelRequest(...args: Parameters<ResolveRequest>): ReturnType<ResolveRequest> | ModelRequest | undefined }

/**
 * Opt-in, generated-data component benchmark; no model/network calls or file writes.
 * Run FROM THE WORKTREE (Vite's cache, if enabled, must not land in the baseline):
 * DSH_TUI_BENCH=1 DSH_TUI_BENCH_ROOT="$BASELINE_ROOT" pnpm exec vitest run \
 *   packages/tui/tests/performance/rendering.spec.ts --no-cache --maxWorkers=1
 * Omit ROOT to measure this worktree only after its sources are stable.
 * Defaults: warm=5, samples=30, viewport=120x40. Optional environment variables:
 * DSH_TUI_BENCH_WARM=1 DSH_TUI_BENCH_SAMPLES=3 (report these reductions honestly)
 * DSH_TUI_BENCH_VIEWPORTS=80x24,120x40
 * DSH_TUI_BENCH_EVENTS=1000,10000,50000 DSH_TUI_BENCH_BYTES=102400,1048576,10485760
 * DSH_TUI_BENCH_SCENARIOS=history,request (choose either to run a subset).
 * DSH_TUI_BENCH_MEASURES=trajectory.request.hot-scroll (comma-separated exact names)
 * DSH_TUI_BENCH_SHAPES=single-large,many-short
 * DSH_TUI_BENCH_REQUEST_FORMAT=json (default) | structured (unsupported on old baseline)
 * Request cold includes asynchronous preparation and explicit JSON selection, not just
 * the preparing frame. Hot starts only after ready; cleanup/verification are untimed.
 * For heavy isolated cases use an EXTERNAL process timeout (e.g. harness bash timeoutMs
 * 90000); the Vitest/JS timeout cannot preempt synchronous rendering.
 * Each stdout JSON line is independently consumable; no timing thresholds.
 * "Cold" means fresh component/request, NOT a cold process/JIT/filesystem cache.
 * No shell compositor/terminal write, input-to-frame, event-loop long-task, GC,
 * memory-budget, mixed-content, search, prepend or live-model acceptance is claimed.
 */
const enabled = process.env.DSH_TUI_BENCH === '1'
const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const root = resolve(process.env.DSH_TUI_BENCH_ROOT ?? ownRoot)
const dataVersion = 'rendering-generated-v1-ascii-user96-request-ascii-x'
const measureNames = [
  'trajectory.history.cold', 'trajectory.history.hot-scroll', 'transcript.history.cold',
  'transcript.history.hot-document', 'transcript.history.invalidate-render',
  'request.reconstruct', 'request.serialize', 'trajectory.request.cold', 'trajectory.request.hot-scroll',
]

function emit(value: unknown): void {
  // Bypass Vitest's console interception so completed scenarios survive a later timeout.
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function integer(name: string, fallback: number, minimum = 1): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`)
  return value
}

function sizes(name: string, fallback: string): number[] {
  const values = (process.env[name] ?? fallback).split(',').map(Number)
  if (values.some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error(`Invalid ${name}`)
  return values
}

function user(seq: number, text: string): HistoryEntry {
  return { event: {
    type: 'user/message', seq, time: 1_700_000_000_000 + seq,
    surfaceOp: 'append', data: {
      id: `bench-user-${String(seq).padStart(6, '0')}`, role: 'user',
      source: { kind: 'user' }, content: [{ type: 'text', text }],
    },
  } } as HistoryEntry
}

function packageVersion(name: string): string {
  const require = createRequire(resolve(root, 'packages/tui/package.json'))
  let directory = dirname(require.resolve(name))
  for (;;) {
    try {
      const value = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (value.name === name && value.version !== undefined) return value.version
    } catch { /* An entry point can live below its package manifest. */ }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Cannot locate version of ${name}`)
    directory = parent
  }
}

it.skipIf(!enabled)('reports generated rendering baselines as JSON (DSH_TUI_BENCH=1)', async () => {
  // Runtime imports deliberately all target ROOT, never mix baseline and changed views.
  const [trajectory, transcript, fixtures, requests, text, themeModule] = await Promise.all([
    import(/* @vite-ignore */ `${root}/packages/tui/src/modules/trajectory/view.ts`) as Promise<typeof import('../../src/modules/trajectory/view.ts')>,
    import(/* @vite-ignore */ `${root}/packages/tui/src/modules/transcript/view.ts`) as Promise<typeof import('../../src/modules/transcript/view.ts')>,
    import(/* @vite-ignore */ `${root}/packages/tui/tests/modules/trajectory/fixtures.ts`) as Promise<typeof import('../modules/trajectory/fixtures.ts')>,
    import(/* @vite-ignore */ `${root}/packages/tui/src/runtime/execution/projection/model-call.ts`) as Promise<RequestModule>,
    import(/* @vite-ignore */ `${root}/packages/tui/src/presentation/primitives/text.ts`) as Promise<typeof import('../../src/presentation/primitives/text.ts')>,
    import(/* @vite-ignore */ `${root}/packages/tui/src/presentation/primitives/theme.ts`) as Promise<typeof import('../../src/presentation/primitives/theme.ts')>,
  ])
  const warm = integer('DSH_TUI_BENCH_WARM', 5, 0)
  const samples = integer('DSH_TUI_BENCH_SAMPLES', 30)
  const viewports = (process.env.DSH_TUI_BENCH_VIEWPORTS ?? '120x40').split(',').map(value => {
    const match = /^(\d+)x(\d+)$/.exec(value)
    if (match === null || Number(match[1]) < 20 || Number(match[2]) < 8) throw new Error('Invalid viewport')
    return { columns: Number(match[1]), rows: Number(match[2]) }
  })
  const scenarios = (process.env.DSH_TUI_BENCH_SCENARIOS ?? 'history,request').split(',')
  if (scenarios.some(value => value !== 'history' && value !== 'request')) throw new Error('Invalid scenarios')
  const measures = (process.env.DSH_TUI_BENCH_MEASURES ?? measureNames.join(',')).split(',')
  if (measures.some(value => !measureNames.includes(value))) throw new Error('Invalid measures')
  const shapes = (process.env.DSH_TUI_BENCH_SHAPES ?? 'single-large,many-short').split(',')
  if (shapes.some(value => value !== 'single-large' && value !== 'many-short')) throw new Error('Invalid shapes')
  const requestFormat = process.env.DSH_TUI_BENCH_REQUEST_FORMAT ?? 'json'
  if (requestFormat !== 'json' && requestFormat !== 'structured') throw new Error('Invalid request format')
  const asynchronousRequest = 'requestPhase' in trajectory.TrajectoryView.prototype
  const wants = (name: string) => measures.includes(name)
  const eventSizes = sizes('DSH_TUI_BENCH_EVENTS', '1000,10000,50000')
  const requestSizes = sizes('DSH_TUI_BENCH_BYTES', '102400,1048576,10485760')
  const sourceFiles = [
    'modules/trajectory/view.ts', 'modules/trajectory/model.ts', 'modules/trajectory/records.ts',
    'modules/trajectory/request-browser.ts', 'modules/trajectory/request-inspection.ts',
    'modules/trajectory/request-document.ts', 'modules/trajectory/request-search.ts',
    'modules/transcript/view.ts', 'modules/transcript/model.ts',
    'runtime/execution/projection/model-call.ts', 'runtime/execution/projection/index.ts',
    'runtime/execution/projection/snapshot.ts', 'presentation/primitives/text.ts',
    'presentation/primitives/text-document.ts',
  ]
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
  const metadata = {
    kind: 'metadata', schemaVersion: 2, dataVersion, root,
    measurementVersion: 'request-ready-explicit-format-v2', requestFormat, asynchronousRequest,
    gitRevision: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    gitDirty: execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim() !== '',
    sourceSha256: Object.fromEntries(sourceFiles.map(path => {
      const absolute = resolve(root, 'packages/tui/src', path)
      return [path, existsSync(absolute) ? sha256(readFileSync(absolute, 'utf8')) : 'absent']
    })),
    fixtureSha256: sha256(readFileSync(resolve(root, 'packages/tui/tests/modules/trajectory/fixtures.ts'), 'utf8')),
    harnessSha256: sha256(readFileSync(fileURLToPath(import.meta.url), 'utf8')),
    node: process.version, v8: process.versions.v8, piTui: packageVersion('@earendil-works/pi-tui'),
    sessionPackage: packageVersion('@deepseek-ai/dsh-session'),
    hardware: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramBytes: totalmem(), platform: platform(), release: release(), arch: arch() },
    warm, samples, viewports, eventSizes, requestSizes, scenarios, measures, shapes,
    sampling: 'sequential wall-clock performance.now; nearest-rank p50/p95; no forced GC; warm iterations excluded; CPU process user+system per sample (async samples include scheduler wait in wall time); validation/dispose excluded',
    exclusions: 'No real model, runtime snapshot projection, shell layout/diff/terminal write, input-to-frame or event-loop long-task acceptance. Setup/verification excluded unless segment explicitly includes it.',
  }
  emit(metadata)
  const theme = themeModule.createTheme(false)
  const noop = () => {}
  let checksum = 0
  type Snapshot = ReturnType<typeof fixtures.state>
  const makeTrajectory = (snapshot: Snapshot, rows: number) => new trajectory.TrajectoryView(snapshot, () => rows, theme, async () => false, noop, noop, noop)
  const consume = (lines: string[]) => { checksum = (checksum + lines.length + (lines[0]?.length ?? 0)) >>> 0 }
  async function measure(name: string, dimensions: object, measuredSegment: string,
    operation: () => void | Promise<void>, afterEach?: () => void | Promise<void>): Promise<void> {
    if (!wants(name)) return
    emit({ kind: 'start-measurement', name, ...dimensions, warm, samples })
    const wallMs: number[] = []
    const cpuMs: number[] = []
    for (let index = -warm; index < samples; index++) {
      const cpu = process.cpuUsage()
      const start = performance.now()
      try {
        const pending = operation() // Always execute sync operations; await only actual promises.
        if (pending !== undefined) await pending
        const wall = performance.now() - start
        const elapsedCpu = process.cpuUsage(cpu)
        if (index >= 0) {
          wallMs.push(wall)
          cpuMs.push((elapsedCpu.user + elapsedCpu.system) / 1000)
        }
      } finally {
        await afterEach?.() // All validation/disposal happens after timing, including failed samples.
      }
    }
    const percentiles = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b)
      return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] }
    }
    emit({ kind: 'measurement', dataVersion, name, ...dimensions, measuredSegment, warm, samples,
      wallMs: { ...percentiles(wallMs), samples: wallMs }, cpuMs: { ...percentiles(cpuMs), samples: cpuMs }, checksum })
  }

  if (scenarios.includes('history') && measures.some(name => name.includes('.history.'))) for (const count of eventSizes) {
    const events = Array.from({ length: count }, (_, index) => user(index, `user ${String(index).padStart(6, '0')} ` + 'x'.repeat(84)))
    const snapshot = fixtures.state(events) // runtime projection intentionally outside render timing
    for (const viewport of viewports) {
      const dimensions = { durableEvents: count, semanticUserBlocks: count, bodyBytes: count * 96, viewport }
      let coldView: ReturnType<typeof makeTrajectory> | undefined
      await measure('trajectory.history.cold', dimensions, 'new TrajectoryView(prebuilt snapshot) + first render(width); includes record/model construction; excludes runtime projection', () => {
        coldView = makeTrajectory(snapshot, viewport.rows)
        consume(coldView.render(viewport.columns))
      }, async () => {
        await coldView?.dispose?.()
        coldView = undefined
      })
      if (wants('trajectory.history.hot-scroll')) {
        const view = makeTrajectory(snapshot, viewport.rows)
        try {
          consume(view.render(viewport.columns))
          // Navigate backward, reversing every viewport.rows actions; default corpus never loads history.
          let move = 0
          await measure('trajectory.history.hot-scroll', dimensions, 'one surface.previous/next ledger action + render(width), retained view; no shell/terminal frame', () => {
            view.handleAction(Math.floor(move++ / viewport.rows) % 2 === 0 ? 'surface.previous' : 'surface.next')
            consume(view.render(viewport.columns))
          })
        } finally { await view.dispose?.() }
      }
      await measure('transcript.history.cold', dimensions, 'new TranscriptComponent(prebuilt snapshot) + full-document render(width); height is NOT applied by TranscriptComponent', () => {
        consume(new transcript.TranscriptComponent(snapshot, theme, true, 8).render(viewport.columns))
      })
      if (wants('transcript.history.hot-document') || wants('transcript.history.invalidate-render')) {
        const component = new transcript.TranscriptComponent(snapshot, theme, true, 8)
        const document = component.render(viewport.columns)
        expect(document.length).toBeGreaterThan(count)
        await measure('transcript.history.hot-document', { ...dimensions, renderedLines: document.length }, 'retained TranscriptComponent.render(width), unchanged state/document cache; NOT viewport scrolling', () => consume(component.render(viewport.columns)))
        await measure('transcript.history.invalidate-render', { ...dimensions, renderedLines: document.length }, 'invalidate() + full-document render(width); block caches retained; NOT runtime history reprojection or scrolling', () => {
          component.invalidate()
          consume(component.render(viewport.columns))
        })
      }
    }
  }

  if (scenarios.includes('request') && measures.some(name => name.includes('request.'))) for (const bytes of requestSizes) for (const shape of shapes) {
    const messageBytes = shape === 'single-large' ? bytes : 1024
    const count = Math.ceil(bytes / messageBytes)
    const events: HistoryEntry[] = Array.from({ length: count }, (_, index) => user(index, 'x'.repeat(Math.min(messageBytes, bytes - index * messageBytes))))
    const header = { config: { provider: 'deepseek', model: 'benchmark-no-network' } }
    events.push(
      { event: { type: 'turn/start', seq: count, time: 1_700_000_100_000, data: { turn: 1 } } } as HistoryEntry,
      { event: { type: 'step/start', seq: count + 1, time: 1_700_000_100_001, data: { turn: 1, step: 1 } } } as HistoryEntry,
      { event: { type: 'request/header', seq: count + 2, time: 1_700_000_100_002, data: { reason: 'resume', header } } } as HistoryEntry,
    )
    const boundary = { throughSeq: count + 2, header, version: Symbol('benchmark-input') }
    const resolveRequest = () => requests.resolveModelRequest(events, boundary,
      { sessionId: 'session-trajectory', epoch: 0, stepKey: 'step:1:1' as ExecutionKey }, events.length)
    const initial = resolveRequest()
    const requestAPI = initial !== undefined && 'status' in initial ? 'lazy-descriptor.read().request' : 'legacy-direct'
    const reconstruct = () => {
      const value = resolveRequest()
      if (value === undefined) throw new Error('Request unavailable')
      if (!('status' in value)) return value
      if (value.status !== 'available') throw new Error(`Request ${value.status}`)
      return value.read().request
    }
    const request = reconstruct()
    expect(request.messages).toHaveLength(count)
    const json = text.displayUnknown(request)
    expect(JSON.parse(json).messages).toHaveLength(count)
    const dimensions = { shape, requestAPI, durableEvents: events.length, messages: count, requestTextBytes: bytes, serializedBytes: Buffer.byteLength(json) }
    await measure('request.reconstruct', dimensions, 'resolveModelRequest + descriptor.read() if lazy: SurfaceManager replay + deriveEventMessage, plus version-specific lookup/provenance; excludes execution snapshot build and JSON', () => {
      checksum = (checksum + reconstruct().messages.length) >>> 0
    })
    await measure('request.serialize', dimensions, 'displayUnknown(prebuilt request): JSON.stringify(value, null, 2) + sanitizeTerminalText; excludes reconstruction, split and wrapping', () => {
      checksum = (checksum + text.displayUnknown(request).length) >>> 0
    })
    if (!wants('trajectory.request.cold') && !wants('trajectory.request.hot-scroll')) continue
    if (requestFormat === 'structured' && !asynchronousRequest) {
      emit({ kind: 'unsupported', ...dimensions, requestFormat,
        measures: measures.filter(name => name.startsWith('trajectory.request.')),
        reason: 'Baseline has no structured Request browser; JSON is not a structured substitute.' })
      continue
    }
    const snapshot = fixtures.state(events)
    for (const viewport of viewports) {
      const viewDimensions = { ...dimensions, viewport, requestFormat, asynchronousRequest }
      const makeRequestView = () => {
        const view = makeTrajectory(snapshot, viewport.rows)
        view.handleAction('surface.confirm')
        view.handleAction('surface.tab-next')
        return view
      }
      const prepareRequest = async (view: ReturnType<typeof makeTrajectory>): Promise<string[]> => {
        if (asynchronousRequest) {
          consume(view.render(viewport.columns)) // preparing frame; baseline must NOT render twice
          const deadline = performance.now() + 30_000
          while (view.requestPhase === 'preparing') {
            if (performance.now() > deadline) throw new Error('Timed out awaiting Request ready (external timeout still required)')
            await new Promise<void>(resolve => setImmediate(resolve))
          }
          if (view.requestPhase !== 'ready') throw new Error(`Request preparation ended in ${view.requestPhase}`)
          if (requestFormat === 'json') view.handleAction('surface.request-format')
        }
        return view.render(viewport.columns)
      }
      const verifyReady = (view: ReturnType<typeof makeTrajectory>, lines: string[]) => {
        if (asynchronousRequest) expect(view.requestPhase).toBe('ready')
        const frame = lines.join('\n')
        expect(frame).not.toContain('Preparing canonical Request')
        if (requestFormat === 'json') {
          expect(frame).toContain('"provider"')
          expect(frame).toContain('"messages"') // verify real JSON content, not just the Request tab title
        } else expect(frame).toContain('Structure')
      }
      let coldView: ReturnType<typeof makeTrajectory> | undefined
      let coldLines: string[] | undefined
      await measure('trajectory.request.cold', viewDimensions,
        asynchronousRequest
          ? `new TrajectoryView + select Request + preparing frame + await phase ready + ${requestFormat === 'json' ? 'explicit JSON selection/serialization' : 'structured directory'} + final render; excludes verification/dispose; NOT input-to-frame`
          : 'new TrajectoryView + select Request + one legacy raw JSON render; excludes verification/dispose; NOT input-to-frame',
        async () => {
          coldView = makeRequestView()
          coldLines = await prepareRequest(coldView)
          consume(coldLines)
        }, async () => {
          try { if (coldView !== undefined && coldLines !== undefined) verifyReady(coldView, coldLines) }
          finally {
            await coldView?.dispose?.()
            coldView = undefined
            coldLines = undefined
          }
        })
      if (!wants('trajectory.request.hot-scroll')) continue
      const view = makeRequestView()
      try {
        const first = await prepareRequest(view)
        verifyReady(view, first)
        view.handleAction('surface.detail-next')
        const next = view.render(viewport.columns)
        if (requestFormat === 'structured' && next.join('\n') === first.join('\n')) {
          emit({ kind: 'unsupported', name: 'trajectory.request.hot-scroll', ...viewDimensions,
            reason: 'Structured directory fits this viewport; scrolling would be a no-op.' })
          continue
        }
        expect(next).not.toEqual(first) // real scroll, never a preparing/clamped frame
        view.handleAction('surface.detail-previous')
        const restored = view.render(viewport.columns)
        expect(restored).toEqual(first)
        consume(restored)
        let move = 0
        await measure('trajectory.request.hot-scroll', viewDimensions,
          `one alternating detail-next/previous action + render of retained ready ${requestFormat}; preparation/format selection/verification/dispose excluded; no shell/terminal frame`, () => {
            view.handleAction(move++ % 2 === 0 ? 'surface.detail-next' : 'surface.detail-previous')
            consume(view.render(viewport.columns))
          })
      } finally { await view.dispose?.() }
    }
  }
  emit({ kind: 'complete', dataVersion, checksum })
}, 3_600_000)
