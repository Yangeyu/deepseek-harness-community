import { Text, type Terminal } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { SelectableMainScreen } from '../../src/presentation/selectable-main-screen.ts'
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
} from '../../src/presentation/mouse.ts'

function terminal(): Terminal {
  return {
    columns: 10,
    rows: 2,
    start: vi.fn(),
    stop: vi.fn(),
    write: vi.fn(),
    hideCursor: vi.fn(),
    showCursor: vi.fn(),
  } as unknown as Terminal
}

describe('SelectableMainScreen', () => {
  it('selects from raw rendered lines while decorating the visible screen', () => {
    const screen = new SelectableMainScreen(terminal(), false)
    screen.addChild(new Text('hello', 0, 0))
    screen.render(10)

    screen.beginTextSelection(0, 0)
    screen.updateTextSelection(4, 0)
    expect(screen.render(10)[0]).toContain('\u001b[7m')
    expect(screen.finishTextSelection(4, 0)).toEqual({
      kind: 'selection',
      changed: false,
      text: 'hello',
    })
  })

  it('owns mouse tracking for every terminal start and stop path', () => {
    const output = terminal()
    const screen = new SelectableMainScreen(output, false)

    screen.start()
    screen.stop({ preserveScreen: true })

    expect(output.write).toHaveBeenCalledWith(ENABLE_MOUSE_TRACKING)
    expect(output.write).toHaveBeenCalledWith(DISABLE_MOUSE_TRACKING)
  })
})
