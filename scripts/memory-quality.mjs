import { createHash } from 'node:crypto'
import { assessQuality, qualityHistories, qualityTasks, satisfiesQuality } from './memory-quality-cases.mjs'

const digest = result => createHash('sha256').update(JSON.stringify(result.documents
  .map(({ scope, topic, content }) => [scope, topic ?? '', content])
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex')
const check = (name, passed) => ({ name, passed })
const allPass = checks => checks.every(item => item.passed)

export function hasSuccessfulFixtureRead(result, expectedContent) {
  const events = result.events.filter(event => event.sessionId === result.sessionId)
  const calls = new Set(events.filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message.content)
    .filter(block => block.type === 'tool-call' && block.name === 'read_project_file').map(block => block.id))
  return events.filter(event => event.type === 'tool/result').flatMap(event => event.data.message.content)
    .some(block => block.type === 'tool-result' && calls.has(block.toolCallId) && !block.isError
      && block.content.some(part => part.type === 'text' && part.text === expectedContent))
}

function snapshotText(result) {
  return result.requests[0].messages
    .filter(message => message.source?.sections?.some(section => section.name === 'memory'))
    .flatMap(message => message.content ?? []).filter(block => block.type === 'text')
    .map(block => block.text).join('\n')
}

// Each worker is a fresh real Agent process. Corpus content comes exclusively
// from prior model tool calls; copying it freezes evidence, not a hand-written oracle.
export async function runQuality({ scenario, toolsCalled, copyMemory, report }) {
  Object.assign(report, {
    rubricVersion: 2,
    provenance: 'session/config are de-identified summaries of confirmed project feedback; validation and follow-up tasks are constructed controls, not raw production conversations',
    limitation: 'One fixed-route run with field-based checks; not a statistical or general answer-quality benchmark.',
    learning: [], comparisons: [], controls: [], passed: false,
  })
  const seeds = new Map()
  for (const [name, prompt] of Object.entries(qualityHistories)) {
    const result = await scenario(`learn-${name}`, prompt, { memory: `seed-${name}` })
    const checks = [
      check('model-created-memory', toolsCalled(result, result.sessionId).includes('memory_write')
        && result.mutations.some(mutation => mutation.operation === 'write' && mutation.files.length > 0)),
      check('source-attributed', result.mutations.every(mutation => mutation.sourceSessionId === result.sessionId && mutation.sourceTurn === 1)),
      check('nonempty-index', result.document.content.trim() !== ''),
    ]
    seeds.set(name, digest(result))
    report.learning.push({ name, checks, corpusDigest: digest(result), requestCount: result.requests.length })
  }

  for (const task of qualityTasks) {
    const comparison = { task: task.id, arms: [] }
    report.comparisons.push(comparison)
    for (const arm of ['memory', 'none']) {
      const memory = `${task.id}-${arm}`
      await copyMemory(`seed-${task.memory}`, memory)
      const result = await scenario(memory, task.prompt, {
        memory, files: task.files,
        policy: { useMemories: arm === 'memory', generateMemories: false },
        allowedTools: [...arm === 'memory' ? ['memory_read'] : [], ...task.files ? ['read_project_file'] : []],
      })
      const assessment = assessQuality(task.id, result.answer)
      const calls = toolsCalled(result, result.sessionId)
      const snapshot = snapshotText(result)
      const hasIndex = result.document.content.trim() !== '' && snapshot.includes(result.document.content.trim())
      const controls = [
        check('frozen-corpus', digest(result) === seeds.get(task.memory) && result.mutations.length === 0),
        check('no-evaluation-learning', result.requests.every(request => request.sessionId === result.sessionId)),
        check('correct-injection', arm === 'memory' ? hasIndex : !hasIndex),
        check('no-control-memory-access', arm === 'memory' || (!calls.some(name => name.startsWith('memory_'))
          && result.requests.every(request => !(request.tools ?? []).some(name => name.startsWith('memory_'))))),
      ]
      if (task.files) controls.push(check('current-source-read', hasSuccessfulFixtureRead(result, task.files['package.json'])))
      if (arm === 'none' && task.unknownFields) {
        controls.push(check('honest-unknown-without-history', task.unknownFields.every(field => assessment.response?.[field] === null)))
      }
      comparison.arms.push({
        arm, assessment, expectedOutcomeSatisfied: satisfiesQuality(task.id, arm, assessment), controls, requestCount: result.requests.length,
        snapshotBytes: Buffer.byteLength(snapshot), memoryReadCount: calls.filter(name => name === 'memory_read').length,
      })
    }
  }

  // Unlike read-only evaluation, this branch really enables background learning.
  // A one-off exception must neither mutate the corpus nor survive a fresh session.
  await copyMemory('seed-session', 'temporary-learning')
  const temporaryTask = qualityTasks.find(task => task.id === 'temporary-override')
  const temporary = await scenario('temporary-learning', temporaryTask.prompt, {
    memory: 'temporary-learning', policy: { useMemories: true, generateMemories: true },
  })
  report.controls.push(
    check('temporary-answer-applied', assessQuality(temporaryTask.id, temporary.answer).passed),
    check('temporary-learner-exercised', temporary.requests.some(request => request.sessionId !== temporary.sessionId)),
    check('temporary-not-persisted', temporary.mutations.length === 0 && digest(temporary) === seeds.get('session')),
  )
  const recall = qualityTasks.find(task => task.id === 'session-recall')
  const restored = await scenario('default-after-temporary', recall.prompt, {
    memory: 'temporary-learning', allowedTools: ['memory_read'],
  })
  report.controls.push(check('default-restored-after-restart', assessQuality(recall.id, restored.answer).passed))
  report.passed = report.learning.every(item => allPass(item.checks)) && allPass(report.controls)
    && report.comparisons.every(item => item.arms.every(({ expectedOutcomeSatisfied, controls }) => allPass(controls) && expectedOutcomeSatisfied))
  return report
}
