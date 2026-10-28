import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import { stringify } from 'yaml'

/** Exercise shipped configuration, model requests, tools and persistence without cloud credentials. */
export async function verifyTuiRuntime({ executable, args = [], packageDirectory, temporaryRoot }) {
  const requirePackage = createRequire(join(packageDirectory, 'package.json'))
  const requireDsh = createRequire(requirePackage.resolve('@deepseek-ai/dsh/package.json'))
  const pty = requireDsh('node-pty')
  const home = join(temporaryRoot, 'smoke-home')
  await mkdir(home)
  await mkdir(join(temporaryRoot, 'smoke-workspace'))
  const workspace = await realpath(join(temporaryRoot, 'smoke-workspace'))
  const target = join(workspace, 'smoke.txt')
  const requests = []
  const server = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      requests.push(input)
      const step = requests.length
      const call = step === 1
        ? { id: 'smoke_write', name: 'write', args: { file_path: target, content: 'TUI_TOOL_OK' } }
        : step === 2 ? { id: 'smoke_read', name: 'read', args: { file_path: target } } : undefined
      const delta = call === undefined
        ? { role: 'assistant', content: step === 3 ? 'TUI_TURN_OK' : 'TUI_RESUME_OK' }
        : { role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const base = { id: `smoke-${step}`, object: 'chat.completion.chunk', created: 1, model: 'smoke' }
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call === undefined ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    } catch (error) {
      response.writeHead(500)
      response.end(String(error))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const patch = join(home, 'smoke.patch.yml')
  const env = {
    PATH: process.env.PATH ?? '', HOME: home, USER: process.env.USER ?? 'dscode-smoke',
    SHELL: process.env.SHELL ?? '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1',
    DSH_HOME: join(home, '.dsh'), DSH_TUI_PROFILE: 'release-smoke', DSH_SMOKE_KEY: 'local-fixture',
    NO_PROXY: '*', no_proxy: '*',
  }

  async function runSession(command, marker, logName) {
    const terminal = pty.spawn(executable, [...args, ...command, '--patch', patch], { cols: 80, rows: 24, cwd: workspace, env })
    let output = '', exit
    terminal.onData(data => { output += stripVTControlCharacters(data) })
    terminal.onExit(result => { exit = result })
    async function until(predicate, label, timeout = 60_000) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (predicate()) return
        if (exit !== undefined) throw new Error(`${label}: exited ${exit.exitCode}`)
        if (/skipping profile bundle|entry did not activate|unknown prompt variable/u.test(output)) throw new Error('Host activation or prompt assembly failed')
        await delay(50)
      }
      throw new Error(`Timed out waiting for ${label}`)
    }
    try {
      await until(() => output.includes('Ready'), 'Ready')
      terminal.write('Run the local acceptance check.\r')
      await until(() => output.includes(marker), marker)
      terminal.write('\u0003')
      await until(() => exit !== undefined, 'clean exit', 10_000)
      assert.equal(exit.exitCode, 0)
    } catch (error) {
      throw new Error(`${error}\n${output.slice(-4000)}`, { cause: error })
    } finally {
      if (exit === undefined) terminal.kill()
      await writeFile(join(temporaryRoot, logName), output)
    }
  }

  try {
    await writeFile(patch, stringify([
      { id: 'agent-default-model', config: { provider: 'bailian', model: 'smoke' } },
      { id: 'llm-bailian', config: {
        apiKeyEnv: 'DSH_SMOKE_KEY', baseURL: `http://127.0.0.1:${server.address().port}/v1`,
        models: { smoke: { contextWindow: 131072, maxOutputTokens: 8192, maxTokensField: 'max_tokens', input: ['text'] } },
      } },
      { id: 'session-title-llm', disabled: true },
    ]))
    await runSession([], 'TUI_TURN_OK', 'tui-turn.txt')
    assert.equal(await readFile(target, 'utf8'), 'TUI_TOOL_OK')
    assert.equal(requests.length, 3)
    const [first, , completed] = requests
    assert.ok(first.messages.some(message => message.role === 'system' && message.content.includes('You are a coding agent powered by the smoke model.')))
    assert.ok(JSON.stringify(first.messages).includes('Current working directory:'))
    assert.ok(JSON.stringify(first.messages).includes(workspace))
    assert.ok(completed.messages.some(message => message.role === 'tool' && message.tool_call_id === 'smoke_read' && JSON.stringify(message.content).includes('TUI_TOOL_OK')))
    await runSession(['resume', '--last'], 'TUI_RESUME_OK', 'tui-resume.txt')
    assert.equal(requests.length, 4)
    assert.ok(requests[3].messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('TUI_TURN_OK')))
    assert.ok(requests[3].messages.some(message => message.role === 'tool' && message.tool_call_id === 'smoke_read'))
    console.log('TUI PTY acceptance passed: prompt -> write/read tools -> response -> restart/resume -> response -> clean exit')
  } finally {
    await writeFile(join(temporaryRoot, 'tui-requests.json'), JSON.stringify(requests, null, 2))
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
