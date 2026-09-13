import { describe, expect, it } from 'vitest'
import { assessQuality, qualityHistories, qualityTasks, satisfiesQuality } from '../scripts/memory-quality-cases.mjs'
import { hasSuccessfulFixtureRead } from '../scripts/memory-quality.mjs'

const score = (taskId, answer) => assessQuality(taskId, JSON.stringify(answer))
const sessionDefault = {
  rowOrder: ['sessionId', 'cwd', 'title'],
  replaceSessionId: false,
  explanation: 'ID 为主标签，目录第二，标题只在分隔符后追加。',
}

// These are replay-scoring intents, not evidence of real memory learning
// or a representative benchmark of overall answer quality.
describe('memory quality response scoring', () => {
  it('accepts project-specific recalled decisions and an isolated unrelated answer', () => {
    expect(Object.keys(qualityHistories)).toEqual(['session', 'config', 'validation'])
    expect(Object.values(qualityHistories).every(history => history.includes('请记住此长期约定'))).toBe(true)
    expect(qualityTasks).toHaveLength(5)
    const answers = {
      'session-recall': sessionDefault,
      'config-recall': {
        seedPhase: 'first-run',
        homeResolution: 'runtime',
        explanation: 'sudo 安装的 HOME 可能属于 root，DSH_HOME 可在安装后设置，所以跟随 launcher 实际运行时根。',
      },
      irrelevant: {
        summary: 'Promise.all 在全部成功时返回按输入顺序排列的值，任一拒绝就拒绝；allSettled 等全部完成并按输入顺序返回各项的状态和结果。两者都不会自动取消其他任务。',
        projectSpecificAdvice: [],
      },
    }
    for (const [taskId, answer] of Object.entries(answers)) {
      const result = score(taskId, answer)
      expect(result.passed).toBe(true)
      expect(result.checks.map(check => check.name)).toEqual(qualityTasks.find(task => task.id === taskId).checks)
    }
    expect(score('irrelevant', {
      ...answers.irrelevant,
      projectSpecificAdvice: ['本项目仍以 session ID 为主标签。'],
    }).passed).toBe(false)
    expect(score('irrelevant', {
      ...answers.irrelevant,
      summary: `${answers.irrelevant.summary} 本项目 cwd 第二。`,
    }).passed).toBe(false)
  })

  it('parses honest unknowns without crediting unavailable memory reuse', () => {
    for (const [taskId, answer] of Object.entries({
      'session-recall': { rowOrder: null, replaceSessionId: null, explanation: '未提供历史，无法确认。' },
      'config-recall': { seedPhase: null, homeResolution: null, explanation: '没有历史依据，不能猜测。' },
      'stale-validation': { commands: ['pnpm run test:imports'], legacyAllowed: null, explanation: '当前命令已从配置确认，但未提供旧命令，无法判断旧命令是否还能用。' },
    })) {
      const result = score(taskId, answer)
      expect(result.parseError).toBeUndefined()
      expect(result.checks.find(check => check.name === 'response-schema').passed).toBe(true)
      const task = qualityTasks.find(task => task.id === taskId)
      expect(result.checks.filter(check => task.historyChecks.includes(check.name))
        .every(check => !check.passed)).toBe(true)
      expect(result.passed).toBe(false)
      expect(satisfiesQuality(taskId, 'none', result)).toBe(true)
      expect(satisfiesQuality(taskId, 'memory', result)).toBe(false)
    }
  })

  it('applies a temporary order rather than the remembered default while retaining the ID', () => {
    const temporary = { ...sessionDefault, rowOrder: ['title', 'cwd', 'sessionId'], explanation: '仅本次例外，长期约定不变，不写入记忆。' }
    expect(score('temporary-override', temporary).passed).toBe(true)
    expect(score('temporary-override', sessionDefault).passed).toBe(false)
    expect(score('session-recall', temporary).passed).toBe(false)
    expect(score('temporary-override', { ...temporary, replaceSessionId: true }).passed).toBe(false)
  })

  it('accepts the current fixture command and rejects reuse of the obsolete command', () => {
    const task = qualityTasks.find(candidate => candidate.id === 'stale-validation')
    const config = JSON.parse(task.files['package.json'])
    expect(config).toMatchObject({
      version: '3.0.0', packageManager: 'pnpm@11.7.0',
      scripts: { 'test:imports': 'vitest run test/import-flow.spec.ts' },
    })
    const current = { commands: ['pnpm run test:imports'], legacyAllowed: false, explanation: '当前 3.x 的 package.json 优先；旧记录仅适用于 2.x。' }
    expect(score(task.id, current).passed).toBe(true)
    expect(score(task.id, { ...current, commands: ['pnpm test:imports'] }).passed).toBe(true)
    const obsolete = score(task.id, {
      ...current, commands: ['pnpm run test:imports', 'npm run test:legacy-import'], legacyAllowed: true,
    })
    expect(obsolete.checks.find(check => check.name === 'legacy-command-rejected').passed).toBe(false)
    expect(obsolete.passed).toBe(false)
    expect(satisfiesQuality(task.id, 'none', score(task.id, {
      ...current, commands: ['npm run test:legacy-import'], legacyAllowed: null,
    }))).toBe(false)
  })

  it('requires a successful matching tool result, not merely an attempted file read', () => {
    const result = { sessionId: 'answer', events: [
      { sessionId: 'answer', type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'read-1', name: 'read_project_file' }] } } },
      { sessionId: 'answer', type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'read-1', isError: false, content: [{ type: 'text', text: 'current config' }] }] } } },
    ] }
    expect(hasSuccessfulFixtureRead(result, 'current config')).toBe(true)
    result.events[1].data.message.content[0].isError = true
    expect(hasSuccessfulFixtureRead(result, 'current config')).toBe(false)
    result.events.pop()
    expect(hasSuccessfulFixtureRead(result, 'current config')).toBe(false)
  })

  it('accepts a single JSON fence and diagnoses invalid formats without stopping the matrix', () => {
    const json = JSON.stringify(sessionDefault)
    expect(assessQuality('session-recall', `\`\`\`json\n${json}\n\`\`\``).passed).toBe(true)
    for (const text of ['{broken', `说明：${json}`, `${json}\n完成`, `${json}\n${json}`]) {
      const result = assessQuality('session-recall', text)
      expect(result.passed).toBe(false)
      expect(result.parseError).toEqual(expect.any(String))
      expect(result.checks.every(check => !check.passed)).toBe(true)
    }
    expect(assessQuality('session-recall', json).passed).toBe(true)
  })
})
