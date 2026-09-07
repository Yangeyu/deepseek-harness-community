import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import { Config as BailianConfig, apply as applyBailian } from '../packages/llm-bailian/dist/index.js'
import Memory from '../packages/memory/dist/index.js'

const filename = fileURLToPath(import.meta.url)
const repository = resolve(dirname(filename), '..')
const require = createRequire(import.meta.url)
const base = createRequire(createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
  .resolve('@deepseek-ai/dsh-base/package.json'))
const loopEntry = base.resolve('@deepseek-ai/dsh-agent-loop')
const loopRequire = createRequire(loopEntry)
const runtime = async name => import(pathToFileURL(loopRequire.resolve(`@deepseek-ai/${name}`)).href)
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
const textOf = message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')

class SettingsSnapshot extends SettingsProvider {
  writable = false
  constructor(ctx, document) {
    super(ctx)
    this.documentSnapshot = document
    this.publish(document)
  }
  async load() { return this.documentSnapshot }
  async persist() { throw new Error('Live acceptance settings are read-only') }
}

async function configuration() {
  const readYaml = async path => parseDocument(await readFile(path, 'utf8'), { logLevel: 'silent' }).toJS()
  const patch = await readYaml(join(repository, 'packages/tui/cordis.patch.yml'))
  const composition = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'llm-bailian').config
  const settingsPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'settings.yaml')
  const document = await readYaml(settingsPath)
  const route = document['agent-default-model']
  assert.equal(route?.provider, 'bailian', 'This live acceptance runner requires a configured Bailian route')
  const ctx = new Context()
  try {
    const settings = new SettingsSnapshot(ctx, { 'llm-bailian': document['llm-bailian'] ?? {} })
    const config = settings.register('llm-bailian', BailianConfig, { base: composition }).get()
    assert.ok(process.env[config.apiKeyEnv], `Export the configured credential reference ${config.apiKeyEnv}`)
    assert.ok(config.models[route.model], 'The selected model must have declared capabilities')
    return { route, bailian: config }
  } finally {
    await ctx.fiber.dispose()
  }
}

async function worker(specPath) {
  const spec = await readJson(specPath)
  const [{ default: AgentLoop }, { default: AgentRegistry }, { default: ToolRuntime },
    { default: SessionStore, SessionId }, { default: SessionProjectionRegistry },
    { default: SystemPrompt }, { default: LlmRuntime, createUserMessage }] = await Promise.all([
    import(pathToFileURL(loopEntry).href), runtime('dsh-agent'), runtime('dsh-tools'),
    runtime('dsh-session'), runtime('dsh-session-projection'), runtime('dsh-system-prompt'), runtime('dsh-llm'),
  ])
  const ctx = new Context()
  const result = { name: spec.name, pid: process.pid, sessionId: spec.sessionId, requests: [], wire: [], events: [], mutations: [], activities: [], disposed: [], errors: [] }
  const fetch = globalThis.fetch
  const wireBodies = []
  globalThis.fetch = async (...args) => {
    const response = await fetch(...args)
    const wire = { status: response.status }
    result.wire.push(wire)
    if (!response.ok || !response.body) return response
    const captured = { wire, body: '' }
    wireBodies.push(captured)
    const decoder = new TextDecoder()
    return new Response(response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        captured.body += decoder.decode(chunk, { stream: true })
        controller.enqueue(chunk)
      },
    })), response)
  }
  let handle
  let timer
  let disabling
  try {
    new SessionStore(ctx)
    new SessionProjectionRegistry(ctx)
    new AgentRegistry(ctx)
    new SystemPrompt(ctx, {})
    new ToolRuntime(ctx)
    new LlmRuntime(ctx)
    applyBailian(ctx, spec.bailian)
    new AgentLoop(ctx, { agents: [] })
    const memory = new Memory(ctx, { root: spec.memoryRoot, idleDelayMs: 0 })
    memory.onMutation(mutation => result.mutations.push(mutation))
    memory.onActivity(activity => result.activities.push(activity))
    ctx.on('agent/disposed', ({ agent }) => result.disposed.push(String(agent.id)))
    ctx.on('agent/error', ({ agent, error }) => result.errors.push({ sessionId: String(agent.id), message: String(error) }))
    ctx.on('session/event', (session, event) => {
      if (['user/message', 'assistant/message', 'tool/result', 'turn/end'].includes(event.type)) {
        result.events.push({ sessionId: String(session.id), origin: session.header.origin, type: event.type, data: event.data })
      }
    })
    ctx.on('llm/stream', async function* (options, next) {
      assert.ok(result.requests.length < spec.requestLimit, 'Live model request budget exhausted')
      const request = {
        sessionId: String(options.sessionId), model: options.model, reasoningEffort: options.reasoningEffort,
        maxTokens: options.maxTokens, messages: options.messages, system: options.system,
        tools: options.tools?.map(tool => tool.name),
      }
      result.requests.push(request)
      for await (const chunk of next()) {
        if (chunk.type === 'usage') request.usage = chunk.usage
        if (chunk.type === 'finish') request.finish = chunk.reason
        if (spec.disableDuringLearning && request.sessionId !== spec.sessionId && disabling === undefined) {
          disabling = memory.setPolicy(spec.sessionId, { generateMemories: false }).then(policy => {
            result.disabledPolicy = policy
            result.childDisposedBeforeAcknowledgment = result.disposed.includes(request.sessionId)
            result.requestsAtDisable = result.requests.length
          })
          void disabling.catch(() => {})
        }
        yield chunk
      }
    })
    if (spec.policy) await memory.setPolicy(spec.sessionId, spec.policy)
    result.policy = await memory.policy(spec.sessionId)
    handle = await ctx.agents.create({
      sessionId: SessionId(spec.sessionId), meta: { cwd: spec.workspace },
      agentOptions: { ...spec.route, maxTokens: 2000 },
    })
    const completed = (async () => {
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: spec.prompt }] }))
      await handle.agent.whenIdle()
      await memory.settle(spec.sessionId)
      if (spec.disableDuringLearning) {
        assert.ok(disabling, 'Cancellation must occur during a real child response')
        await disabling
        handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: spec.prompt }] }))
        await handle.agent.whenIdle()
        await memory.settle(spec.sessionId)
      }
    })()
    await Promise.race([completed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Live scenario exceeded 150 seconds')), 150_000)
    })])
    result.document = await memory.read(spec.workspace, 'project')
    result.documents = await memory.store.list(spec.workspace)
    result.answer = result.events.filter(event => event.sessionId === spec.sessionId && event.type === 'assistant/message')
      .map(event => textOf(event.data.message)).filter(Boolean).join('\n')
    assert.deepEqual(result.errors, [], 'A real agent reported a failure')
  } catch (error) {
    result.failure = String(error)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
    try {
      await handle?.dispose()
      await ctx.fiber.dispose()
    } catch (error) {
      result.errors.push({ message: `Disposal failed: ${String(error)}` })
      process.exitCode = 1
    }
    globalThis.fetch = fetch
    for (const { wire, body } of wireBodies) {
      const chunks = body.split('\n').slice(0, -1)
        .filter(line => line.startsWith('data: ') && line.trim() !== 'data: [DONE]')
        .map(line => JSON.parse(line.slice(6)))
      const choices = chunks.flatMap(chunk => chunk.choices ?? []).filter(choice => choice.index === 0)
      wire.text = choices.map(choice => choice.delta?.content ?? '').join('')
      wire.finish = choices.findLast(choice => choice.finish_reason)?.finish_reason
    }
    await writeJson(spec.resultPath, result)
  }
}

function toolsCalled(result, sessionId) {
  return result.events.filter(event => event.sessionId === sessionId && event.type === 'assistant/message')
    .flatMap(event => event.data.message.content).filter(block => block.type === 'tool-call').map(block => block.name)
}

function checkRecall(result, marker, expected) {
  const first = result.requests[0]
  const suppliedByUser = first.messages.filter(message => message.role === 'user' && message.source?.kind === 'user').map(textOf).join('\n')
  assert.ok(!suppliedByUser.includes(marker), 'Recall prompts must not disclose the marker')
  const snapshot = first.messages.filter(message => message.source?.sections?.some(section => section.name === 'memory')).map(textOf).join('\n')
  assert.equal(snapshot.includes(marker), expected, 'Memory injection must agree with the policy and file state')
  assert.equal(result.answer.includes(marker), expected, 'The real answer must agree with available memory')
  assert.ok(result.answer.trim(), 'The real model must produce a user-visible answer')
  if (expected) assert.equal(result.answer.trim().split('\n')[0], marker, 'The recalled rule must be followed exactly')
}

function storedText(result) {
  return result.documents.map(document => document.content).join('\n')
}

async function run() {
  assert.ok(process.argv.includes('--live'), 'Use --live to opt into bounded, billable model calls')
  const config = await configuration()
  const runId = `memory-e2e-${new Date().toISOString().replaceAll(':', '-')}`
  const artifactRoot = join(repository, 'artifacts', runId)
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-memory-live-'))
  const workspace = join(temporary, 'workspace')
  await Promise.all([mkdir(artifactRoot, { recursive: true }), mkdir(workspace)])
  const marker = `MEM-${randomUUID().slice(0, 12)}`
  const updated = `MEM-${randomUUID().slice(0, 12)}`
  const learned = `AUTO-${randomUUID().slice(0, 12)}`
  const report = { runId, route: config.route, artifactRoot, marker, updated, learned, cases: [], requestCount: 0, passed: false }
  const recallPrompt = '请为这个项目写一份极简发布说明：本次只修复了日期显示问题。直接输出发布说明，不调用工具。'
  const scenario = async (name, prompt, { policy = { useMemories: true, generateMemories: false }, memory = 'explicit', sessionId = `${name}-${randomUUID()}`, disableDuringLearning = false } = {}) => {
    assert.ok(report.requestCount < 36, 'Live run request budget exhausted')
    const spec = {
      ...config, name, sessionId, workspace, memoryRoot: join(temporary, memory), prompt, policy, disableDuringLearning,
      requestLimit: Math.min(7, 36 - report.requestCount), resultPath: join(artifactRoot, `${name}.json`),
    }
    const specPath = join(temporary, 'scenario.json')
    await writeJson(specPath, spec)
    console.log(`Running ${name}`)
    const code = await new Promise((resolveCode, reject) => {
      const child = spawn(process.execPath, [filename, '--worker', specPath], { stdio: 'inherit', timeout: 180_000 })
      child.on('error', reject)
      child.on('close', resolveCode)
    })
    const result = await readJson(spec.resultPath)
    report.requestCount += result.requests.length
    report.cases.push({ name, pid: result.pid, sessionId, requestCount: result.requests.length, resultPath: spec.resultPath })
    assert.equal(code, 0, `${name}: ${result.failure ?? JSON.stringify(result.errors)}`)
    return result
  }
  try {
    const remembered = await scenario('remember', `请记住这个项目的长期发布约定：每份发布说明的第一行必须单独写 ${marker}。请保存为项目记忆，以便后续新会话遵守。`)
    assert.ok(toolsCalled(remembered, remembered.sessionId).includes('memory_write'), 'The real main agent must execute memory_write')
    assert.ok(remembered.document.content.includes(marker), 'The tool must persist the rule')
    checkRecall(await scenario('recall-after-restart', recallPrompt), marker, true)
    const override = await scenario('current-request-overrides-memory', '请写极简发布说明，内容是修复日期显示问题。本次第一行必须是“# 发布说明”，不使用其他标识。不调用工具。')
    assert.ok(JSON.stringify(override.requests[0].messages).includes(marker), 'The override must be tested with memory present')
    assert.equal(override.answer.trim().split('\n')[0], '# 发布说明')
    assert.ok(!override.answer.includes(marker))
    const disabled = await scenario('use-disabled', recallPrompt, { policy: { useMemories: false, generateMemories: false } })
    checkRecall(disabled, marker, false)
    const restored = await scenario('disabled-policy-after-restart', recallPrompt, { sessionId: disabled.sessionId, policy: null })
    assert.deepEqual(restored.policy, { useMemories: false, generateMemories: false })
    checkRecall(restored, marker, false)
    const corrected = await scenario('update', `项目发布约定已正式修改：每份发布说明的第一行改为 ${updated}，旧标识 ${marker} 作废。请更新项目记忆，移除过时约定，仅保留新的有效规则。`)
    assert.ok(corrected.document.content.includes(updated) && !corrected.document.content.includes(marker))
    const retired = corrected.mutations.filter(mutation => mutation.operation === 'forget').map(mutation => mutation.summary)
    assert.ok(retired.length > 0, 'Updating must retire the previous entry')
    assert.ok(retired.every(summary => !storedText(corrected).split('\n').some(line => line.startsWith(`- ${summary}`))), 'Retired entries must be removed from index and topic files')
    checkRecall(await scenario('recall-updated', recallPrompt), updated, true)
    const forgotten = await scenario('forget', '请遗忘这个项目的发布说明首行标识约定，不再保留任何相关项目记忆。')
    assert.ok(toolsCalled(forgotten, forgotten.sessionId).includes('memory_forget'))
    assert.ok(!storedText(forgotten).includes(updated) && !storedText(forgotten).includes(marker), 'Forgetting must remove index and topic content')
    checkRecall(await scenario('recall-after-forget', recallPrompt), updated, false)
    const backgroundPrompt = `纠正一下，以后这个项目每份发布说明的第一行都必须单独写 ${learned}，这是长期规则。本轮不要调用任何工具，只回复“收到”。`
    const noLearning = await scenario('learning-disabled', backgroundPrompt, { memory: 'background-disabled' })
    assert.equal(noLearning.mutations.length, 0)
    assert.ok(noLearning.requests.every(request => request.sessionId === noLearning.sessionId))
    const background = await scenario('background-learning', backgroundPrompt, {
      memory: 'background', policy: { useMemories: true, generateMemories: true },
    })
    assert.deepEqual(toolsCalled(background, background.sessionId), [], 'This case must be learned in the background')
    assert.ok(background.mutations.some(mutation => mutation.sourceSessionId === background.sessionId && mutation.sourceTurn === 1))
    assert.ok(background.requests.some(request => request.sessionId !== background.sessionId))
    assert.ok(background.document.content.includes(learned), 'Background learning must persist the rule')
    checkRecall(await scenario('recall-background', recallPrompt, { memory: 'background' }), learned, true)
    const canceled = await scenario('disable-active-learning', backgroundPrompt, {
      memory: 'cancellation', policy: { useMemories: true, generateMemories: true }, disableDuringLearning: true,
    })
    assert.equal(canceled.childDisposedBeforeAcknowledgment, true)
    assert.equal(canceled.disabledPolicy.generateMemories, false)
    assert.equal(canceled.mutations.length, 0)
    assert.ok(canceled.requests.slice(canceled.requestsAtDisable).every(request => request.sessionId === canceled.sessionId))
    assert.equal(new Set(report.cases.map(item => item.pid)).size, report.cases.length, 'Each scenario must boot a separate process')
    report.passed = true
  } catch (error) {
    report.failure = String(error)
    process.exitCode = 1
  } finally {
    await writeJson(join(artifactRoot, 'report.json'), report)
    await rm(temporary, { recursive: true, force: true })
    console.log(JSON.stringify({ passed: report.passed, requestCount: report.requestCount, failure: report.failure, artifactRoot }))
  }
}

if (process.argv[2] === '--worker') await worker(process.argv[3])
else await run()
