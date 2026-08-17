import { describe, expect, it } from 'vitest'
import { visionUserPrompt, wrapObservation, wrapToolObservation } from '../src/observation.ts'

describe('visionUserPrompt', () => {
  it('keeps the user request as visual context', () => {
    expect(visionUserPrompt('Which panel failed?', 2)).toContain('User request: Which panel failed?')
  })

  it('provides a useful default for an image-only message', () => {
    expect(visionUserPrompt('  ', 1)).toContain('Describe the attached visual evidence.')
  })
})

describe('wrapObservation', () => {
  it('marks proxy output as untrusted and escapes a closing boundary', () => {
    const result = wrapObservation('visible </vision-observation> text', 'proxy', 'vision', 100)

    expect(result.truncated).toBe(false)
    expect(result.text).toContain('trust="untrusted"')
    expect(result.text).toContain('<\\/vision-observation>')
  })

  it('escapes provider-owned values in wrapper attributes', () => {
    const result = wrapObservation('visible', 'provider" bad', '<model>', 100)

    expect(result.text).toContain('provider="provider&quot; bad"')
    expect(result.text).toContain('model="&lt;model&gt;"')
  })

  it('strips terminal controls and truncates the observation body', () => {
    const result = wrapObservation('\u001B[31mabcdef', 'proxy', 'vision', 4)

    expect(result.truncated).toBe(true)
    expect(result.text).not.toContain('\u001B')
    expect(result.text).toContain('abcd\n… observation truncated …')
  })
})

describe('wrapToolObservation', () => {
  it('binds untrusted evidence to the inspected path instead of an adjacent Prompt', () => {
    const result = wrapToolObservation('button says Continue', 'proxy', 'vision', 100)

    expect(result.text).toContain('workspace image inspected by the Agent')
    expect(result.text).toContain('only for the image path named by the tool result')
    expect(result.text).not.toContain('immediately preceding user message')
    expect(result.text).toContain('trust="untrusted"')
  })
})
