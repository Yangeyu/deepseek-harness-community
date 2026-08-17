import { describe, expect, it } from 'vitest'
import { Text, visibleWidth } from '@earendil-works/pi-tui'
import { ComposerAnchoredLayout } from '../../src/presentation/layout.ts'

describe('ComposerAnchoredLayout', () => {
  it('pins the composer to the bottom of a short viewport', () => {
    const layout = new ComposerAnchoredLayout(
      new Text('header', 0, 0),
      new Text('message', 0, 0),
      new Text('status', 0, 0),
      new Text('editor', 0, 0),
      new Text('footer', 0, 0),
      () => 8,
    )
    const lines = layout.render(80)

    expect(lines).toHaveLength(8)
    expect(lines[0]?.trimEnd()).toBe('header')
    expect(lines[2]?.trimEnd()).toBe('message')
    expect(lines[4]).toBe('')
    expect(lines.slice(-3).map(line => line.trim())).toEqual(['status', 'editor', 'footer'])
  })

  it('temporarily replaces and restores the current active surface', () => {
    const layout = new ComposerAnchoredLayout(
      new Text('header', 0, 0),
      new Text('message', 0, 0),
      new Text('status', 0, 0),
      new Text('editor', 0, 0),
      new Text('footer', 0, 0),
      () => 8,
    )
    const trajectory = new Text('trajectory', 0, 0)
    const approval = new Text('approval', 0, 0)
    layout.setActiveSurface({ kind: 'workspace', component: trajectory })

    const restore = layout.pushActiveSurface({ kind: 'readable', component: approval })
    expect(layout.render(80).at(-1)?.trim()).toContain('approval')

    expect(restore()).toBe(true)
    expect(layout.render(80).join('\n')).toContain('trajectory')
    expect(restore()).toBe(false)
    expect(layout.render(80).join('\n')).toContain('trajectory')
  })

  it('does not overwrite an active surface that replaced a temporary surface', () => {
    const layout = new ComposerAnchoredLayout(
      new Text('header', 0, 0),
      new Text('message', 0, 0),
      new Text('status', 0, 0),
      new Text('editor', 0, 0),
      new Text('footer', 0, 0),
      () => 8,
    )
    const restore = layout.pushActiveSurface({
      kind: 'readable',
      component: new Text('approval', 0, 0),
    })
    layout.setActiveSurface({ kind: 'readable', component: new Text('new surface', 0, 0) })

    expect(restore()).toBe(false)
    expect(layout.render(80).at(-1)?.trim()).toContain('new surface')
  })

  it('frames a readable surface as a distinct bottom dock without adding rows', () => {
    const layout = new ComposerAnchoredLayout(
      new Text('header', 0, 0),
      new Text('message', 0, 0),
      new Text('status', 0, 0),
      new Text('editor', 0, 0),
      new Text('footer', 0, 0),
      () => 8,
    )
    layout.setActiveSurface({
      kind: 'readable',
      component: new Text('Permission required\nReason\n\nAllow once\nEsc cancel', 0, 0),
    })

    const lines = layout.render(80)
    const surface = lines.slice(-5)
    expect(lines).toHaveLength(8)
    expect(surface[0]).toMatch(/^╭─ Permission required ─+$/u)
    expect(surface.slice(1, -1).every(line => line.startsWith('│  '))).toBe(true)
    expect(surface.at(-1)).toMatch(/^╰─ Esc cancel ─+$/u)
    expect(visibleWidth(surface[0] ?? '')).toBe(80)
    expect(visibleWidth(surface.at(-1) ?? '')).toBe(80)
  })

  it('bounds readable content width while extending its boundary across the viewport', () => {
    let renderedWidth = 0
    const surface = {
      render: (width: number): string[] => {
        renderedWidth = width
        return ['Panel', 'content', 'Esc close']
      },
      invalidate: () => {},
    }
    const layout = new ComposerAnchoredLayout(
      new Text('header', 0, 0),
      new Text('message', 0, 0),
      new Text('status', 0, 0),
      new Text('editor', 0, 0),
      new Text('footer', 0, 0),
      () => 8,
    )
    layout.setActiveSurface({ kind: 'readable', component: surface })

    const lines = layout.render(180)
    expect(renderedWidth).toBe(100)
    expect(visibleWidth(lines.at(-3) ?? '')).toBe(180)
    expect(visibleWidth(lines.at(-1) ?? '')).toBe(180)
  })

  it('gives a workspace surface the full viewport and available content width', () => {
    let renderedWidth = 0
    const surface = {
      render: (width: number): string[] => {
        renderedWidth = width
        return ['Workspace', 'content', 'Esc close']
      },
      invalidate: () => {},
    }
    const layout = new ComposerAnchoredLayout(
      new Text('header', 0, 0),
      new Text('message', 0, 0),
      new Text('status', 0, 0),
      new Text('editor', 0, 0),
      new Text('footer', 0, 0),
      () => 8,
    )
    layout.setActiveSurface({ kind: 'workspace', component: surface })

    const lines = layout.render(180)
    expect(renderedWidth).toBe(177)
    expect(lines).toHaveLength(8)
    expect(visibleWidth(lines[0] ?? '')).toBe(180)
    expect(visibleWidth(lines[2] ?? '')).toBe(180)
    expect(lines.slice(3)).toEqual(Array<string>(5).fill(''))
  })

  it('follows the conversation tail and scrolls through the non-fixed header', () => {
    const transcript = new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n'), 0, 0)
    const layout = new ComposerAnchoredLayout(
      new Text('header', 0, 0),
      transcript,
      new Text('', 0, 0),
      new Text('editor', 0, 0),
      new Text('footer', 0, 0),
      () => 8,
    )

    const tail = layout.render(80)
    expect(tail.slice(0, 5).map(line => line.trim()))
      .toEqual(['line 8', 'line 9', 'line 10', 'line 11', 'line 12'])
    expect(tail[5]).toBe('')
    expect(tail.slice(-2).map(line => line.trim())).toEqual(['editor', 'footer'])
    expect(layout.followsTranscriptTail).toBe(true)

    expect(layout.scrollTranscript(-3)).toBe(true)
    expect(layout.render(80).slice(0, 5).map(line => line.trim()))
      .toEqual(['line 5', 'line 6', 'line 7', 'line 8', 'line 9'])
    expect(layout.followsTranscriptTail).toBe(false)

    transcript.setText(`${transcript.render(80).join('\n')}\nline 13`)
    expect(layout.render(80).slice(0, 5).map(line => line.trim()))
      .toEqual(['line 5', 'line 6', 'line 7', 'line 8', 'line 9'])

    expect(layout.followTranscript()).toBe(true)
    expect(layout.render(80).slice(0, 5).map(line => line.trim()))
      .toEqual(['line 9', 'line 10', 'line 11', 'line 12', 'line 13'])

    expect(layout.scrollTranscript(-99)).toBe(true)
    expect(layout.render(80).slice(0, 3).map(line => line.trim()))
      .toEqual(['header', '', 'line 1'])
  })

  it('pages the transcript and maps screen rows to full transcript lines', () => {
    const layout = new ComposerAnchoredLayout(
      new Text('header\ncontext', 0, 0),
      new Text('one\ntwo\nthree\nfour\nfive', 0, 0),
      new Text('', 0, 0),
      new Text('editor', 0, 0),
      new Text('footer', 0, 0),
      () => 8,
    )

    layout.render(80)
    expect(layout.transcriptRowAt(0, 0)).toBe(0)
    expect(layout.transcriptRowAt(3, 0)).toBe(3)
    expect(layout.transcriptRowAt(5, 0)).toBe(-1)

    expect(layout.pageTranscript(-1)).toBe(true)
    layout.render(80)
    expect(layout.transcriptRowAt(3, 0)).toBe(0)
  })
})
