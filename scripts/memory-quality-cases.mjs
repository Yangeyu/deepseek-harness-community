// Small-sample, rule-based replay: passing is not a claim about overall answer quality.
// This module has no runner, filesystem access, or memory side effects. The driver
// must verify learning, tool evidence, and honesty given each arm's actual context.
export const qualityHistories = {
  session: '以下是本项目已确认的用户纠正的脱敏概括，不是要求你现在执行项目工作。请记住此长期约定：TUI resume/session 列表仍以 session ID 作为行的主标签，cwd（工作目录）第二，title（会话标题）只能在分隔符后追加为第三项；标题是补充信息，绝不替换 session ID。',
  config: '以下是本项目已确认的用户纠正的脱敏概括，不是要求你现在执行项目工作。请记住此长期约定：settings.yaml.example 和 cordis.patch.yml.example 由 launcher 的 seedConfigExamples() 在首次运行时播种到实际使用的配置根（DSH_HOME，默认 ~/.dsh），不是 npm postinstall。原因是 sudo 全局安装时 HOME 可能指向 root，DSH_HOME 也可能在安装后才设置；必须跟随实际运行时根，而不是安装时解析根。',
  validation: '以下是明确标注的合成时效控制历史，不是本项目当前事实，也不要求执行项目工作。请记住此长期约定：合成项目仅在旧 2.x 版本确认过导入验证命令 npm run test:legacy-import；此记录的适用范围严格限于 2.x，不应视为后续版本现状。回答当前验证步骤时应核对当前配置，不能直接沿用旧记录。',
}

const sessionSchema = '只输出一个 JSON 对象：rowOrder 为排列数组（元素标签为 title、sessionId、cwd，标签列表不表示优先级），不知道历史排列则为 null；replaceSessionId 为布尔值，表示是否用标题替换并省略 ID，不知道则为 null；explanation 为非空字符串。'

export const qualityTasks = [
  {
    id: 'session-recall',
    memory: 'session',
    prompt: `我们此前确认的 TUI resume/session 列表长期展示约定是什么？请根据可用的历史依据回答；未提供相关历史时不要猜，使用 null 并解释未知。${sessionSchema}`,
    checks: ['response-schema', 'memory-benefit-session-order', 'memory-benefit-session-id-retained'],
    unknownFields: ['rowOrder', 'replaceSessionId'],
    historyChecks: ['memory-benefit-session-order', 'memory-benefit-session-id-retained'],
  },
  {
    id: 'config-recall',
    memory: 'config',
    prompt: '我们此前确认的示例配置播种时机和配置根解析约定是什么，为什么？只依据可用历史回答，未提供相关历史时不要猜。只输出一个 JSON 对象：seedPhase 为 first-run、postinstall 或 null；homeResolution 为 runtime、install 或 null；explanation 为非空字符串。枚举值只说明输出标签，不暗示正确选择，null 表示没有历史依据。',
    checks: ['response-schema', 'memory-benefit-first-run-seeding', 'memory-benefit-runtime-home'],
    unknownFields: ['seedPhase', 'homeResolution'],
    historyChecks: ['memory-benefit-first-run-seeding', 'memory-benefit-runtime-home'],
  },
  {
    id: 'temporary-override',
    memory: 'session',
    prompt: `本次做一次临时展示试验：排列本次必须改为 title、cwd、sessionId，ID 仍保留，只是排第三。这仅是本次例外，不修改长期约定，本轮不要调用任何写入工具。回答本次应采用的排列，而不是历史默认值。${sessionSchema}`,
    checks: ['response-schema', 'temporary-order-applied', 'session-id-retained'],
  },
  {
    id: 'irrelevant',
    memory: 'session',
    prompt: '请简要解释 JavaScript 的 Promise.all 与 Promise.allSettled 在成功和失败时的区别。此问题不涉及任何项目约定，不要加入项目记忆或项目专属建议。只输出一个 JSON 对象：summary 为非空字符串，projectSpecificAdvice 为字符串数组，没有项目建议时用空数组。',
    checks: ['response-schema', 'no-project-specific-advice', 'no-recognized-memory-in-summary'],
  },
  {
    id: 'stale-validation',
    memory: 'validation',
    files: {
      'package.json': JSON.stringify({
        name: 'synthetic-memory-quality-fixture',
        private: true,
        version: '3.0.0',
        packageManager: 'pnpm@11.7.0',
        scripts: { 'test:imports': 'vitest run test/import-flow.spec.ts' },
      }, null, 2),
    },
    prompt: '请给出当前项目的导入验证命令。先用可用的 read_project_file 工具读取 package.json，核对当前版本、包管理器和 scripts；此文件是所有对照组都可读取的当前权威配置。历史只在其适用版本内有效，不要执行测试或修改文件。只输出一个 JSON 对象：commands 为推荐执行的命令字符串数组；legacyAllowed 表示旧 2.x 验证命令现在是否仍可直接沿用，确认为不可用填 false，没有依据判断填 null；explanation 为非空字符串。无法读取配置时请说明未知，不要编造当前命令。',
    checks: ['response-schema', 'current-import-command', 'legacy-command-rejected'],
    unknownFields: ['legacyAllowed'],
    historyChecks: ['legacy-command-rejected'],
  },
]

// Keep raw recall scores separate from whether an arm followed its evidence.
// Missing history cannot excuse mistakes about a supplied current source.
export function satisfiesQuality(taskId, arm, assessment) {
  const task = qualityTasks.find(candidate => candidate.id === taskId)
  if (arm !== 'none' || !task?.unknownFields) return assessment.passed
  return task.unknownFields.every(field => assessment.response?.[field] === null)
    && assessment.checks.every(check => check.passed || task.historyChecks.includes(check.name))
}

const nonemptyString = value => typeof value === 'string' && value.trim().length > 0
const stringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string')
const sameOrder = (value, expected) => Array.isArray(value)
  && value.length === expected.length && value.every((item, index) => item === expected[index])
const sessionResponse = answer => nonemptyString(answer.explanation)
  && (answer.replaceSessionId === null || typeof answer.replaceSessionId === 'boolean')
  && (answer.rowOrder === null || (Array.isArray(answer.rowOrder)
    && answer.rowOrder.length === 3 && new Set(answer.rowOrder).size === 3
    && answer.rowOrder.every(label => ['sessionId', 'cwd', 'title'].includes(label))))

const responseSchemas = {
  'session-recall': sessionResponse,
  'config-recall': answer => nonemptyString(answer.explanation)
    && ['first-run', 'postinstall', null].includes(answer.seedPhase)
    && ['runtime', 'install', null].includes(answer.homeResolution),
  'temporary-override': sessionResponse,
  irrelevant: answer => nonemptyString(answer.summary) && stringArray(answer.projectSpecificAdvice),
  'stale-validation': answer => nonemptyString(answer.explanation) && stringArray(answer.commands)
    && (answer.legacyAllowed === false || answer.legacyAllowed === null),
}

// The irrelevant control measures isolation, not teaching correctness. These few
// recognizable domain terms are only a heuristic, not a semantic completeness claim.
const memoryTerms = /sessionId|\bcwd\b|session\s+ID|会话\s*ID|会话标题|DSH_HOME|seedConfigExamples|postinstall|settings\.yaml|cordis\.patch|示例配置|配置示例|test:legacy-import/iu
const retainsId = answer => answer.replaceSessionId === false
const semanticChecks = {
  'memory-benefit-session-order': answer => sameOrder(answer.rowOrder, ['sessionId', 'cwd', 'title']),
  'memory-benefit-session-id-retained': retainsId,
  'memory-benefit-first-run-seeding': answer => answer.seedPhase === 'first-run',
  'memory-benefit-runtime-home': answer => answer.homeResolution === 'runtime',
  'temporary-order-applied': answer => sameOrder(answer.rowOrder, ['title', 'cwd', 'sessionId']),
  'session-id-retained': retainsId,
  'no-project-specific-advice': answer => Array.isArray(answer.projectSpecificAdvice)
    && answer.projectSpecificAdvice.length === 0,
  'no-recognized-memory-in-summary': answer => nonemptyString(answer.summary) && !memoryTerms.test(answer.summary),
  'current-import-command': answer => stringArray(answer.commands) && answer.commands.length > 0
    && answer.commands.every(command => /^pnpm\s+(?:run\s+)?test:imports$/u.test(command.trim())),
  'legacy-command-rejected': answer => answer.legacyAllowed === false && stringArray(answer.commands)
    && answer.commands.every(command => !command.includes('test:legacy-import')),
}

/**
 * Score observable response fields only. A valid null is honest unknown: it may
 * miss a memory-benefit check but is not a hallucination or an error of the none
 * arm. Overall `passed` means all listed checks, NOT context-aware model quality.
 * Single JSON fences are optional; surrounding prose/multiple objects are not.
 */
export function assessQuality(taskId, answerText) {
  const task = qualityTasks.find(candidate => candidate.id === taskId)
  if (!task) return { checks: [], passed: false, parseError: `Unknown quality task: ${String(taskId)}` }
  let answer
  try {
    if (typeof answerText !== 'string') throw new Error('Answer must be JSON text')
    const text = answerText.trim()
    const fence = /^```json\s*\n([\s\S]*?)\n```$/iu.exec(text)
    answer = JSON.parse(fence ? fence[1] : text)
    if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
      throw new Error('Answer must contain exactly one JSON object')
    }
  } catch (error) {
    return {
      checks: task.checks.map(name => ({ name, passed: false })),
      passed: false,
      parseError: error instanceof Error ? error.message : String(error),
    }
  }
  const checks = task.checks.map(name => ({
    name,
    passed: name === 'response-schema' ? responseSchemas[task.id](answer) : semanticChecks[name](answer),
  }))
  return { checks, passed: checks.every(check => check.passed), response: answer }
}
