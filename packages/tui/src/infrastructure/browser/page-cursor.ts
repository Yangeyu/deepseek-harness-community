export interface CursorCommand {
  phase: 'show' | 'suspend' | 'resume'
  owner: string
  expiresAt: number
}

/** Serialized into the page by Playwright evaluate; keep this function self-contained. */
function pageCursor(command: CursorCommand): void {
  type CursorHost = HTMLElement & {
    cursor: { owner: string; update(command: CursorCommand): void; move(x: number, y: number, animate?: boolean): Promise<void>; renew(): void; dispose(): void }
  }
  if (window !== window.top || Date.now() > command.expiresAt) return
  const previous = document.querySelector<CursorHost>('[data-dsh-ai-cursor]')
  if (previous?.cursor.owner === command.owner) return previous.cursor.update(command)
  // Only a new task may replace the current presentation owner.
  if (command.phase !== 'show') return
  previous?.cursor.dispose()

  const host = document.createElement('div')
  host.setAttribute('data-dsh-ai-cursor', command.owner)
  host.setAttribute('aria-hidden', 'true')
  host.inert = true
  host.style.cssText = 'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;'
  const shadow = host.attachShadow({ mode: 'closed' })
  // Desktop browser-agent-cursor: 46x48 source at 23x24 CSS pixels; the two
  // rotations preserve its resting direction while positioning its hotspot.
  shadow.innerHTML = `
    <style>
      :host { pointer-events:none; }
      .cursor { position:absolute;left:-12px;top:-12px;width:24px;height:24px;
        transform:rotate(-44deg);transform-origin:12px 12px; }
      .offset { transform:translate3d(12px,-2.5px,0); }
      .pointer { display:block;width:23px;height:24px;transform:rotate(44deg);transform-origin:0 0;
        --glow:#0285ff;
        filter:drop-shadow(0 0 6px color-mix(in srgb,var(--glow) 90%,transparent))
          drop-shadow(0 0 15px color-mix(in srgb,var(--glow) 48%,transparent)); }
      @media(prefers-color-scheme:dark) { .pointer { --glow:#339cff; } }
    </style>
    <div class="cursor"><div class="offset"><img class="pointer" alt="" draggable="false"
      width="23" height="24" src="data:image/png;base64,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"/></div></div>`

  const pointer = shadow.querySelector<HTMLElement>('.cursor')!
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
  let timer = 0
  let frame = 0
  let deadline = 0
  let disposed = false
  let x = Math.round(innerWidth * .58)
  let y = Math.round(innerHeight * .55)
  let angle = -44
  let settle: (() => void) | undefined

  function render(rotation = -44, stretch = 1): void {
    angle = rotation
    host.style.setProperty('transform', `translate(${x}px, ${y}px)`, 'important')
    pointer.style.transform = `rotate(${rotation}deg) scale(${stretch},1)`
  }

  function stop(): void {
    cancelAnimationFrame(frame)
    clearTimeout(deadline)
    frame = 0
    const resolve = settle
    settle = undefined
    resolve?.()
  }

  function dispose(): void {
    disposed = true
    stop()
    clearTimeout(timer)
    host.remove()
  }

  function move(nextX: number, nextY: number, animate = true): Promise<void> {
    stop()
    if (disposed || !Number.isFinite(nextX) || !Number.isFinite(nextY)) return Promise.resolve()
    const endX = Math.max(0, Math.min(innerWidth, nextX))
    const endY = Math.max(0, Math.min(innerHeight, nextY))
    const startX = x
    const startY = y
    const startAngle = angle
    const dx = endX - x
    const dy = endY - y
    const distance = Math.hypot(dx, dy)
    if (!animate || reduceMotion.matches || document.hidden || distance < 1) {
      x = endX
      y = endY
      render()
      return Promise.resolve()
    }

    const curved = distance > 196
    // A bounded cubic arc; its control points stay inside the current viewport.
    const bend = Math.min(120, distance * .2)
    const side = dx * dy >= 0 ? -1 : 1
    const controlX = (fraction: number) => Math.max(0, Math.min(innerWidth, startX + dx * fraction - dy / distance * bend * side))
    const controlY = (fraction: number) => Math.max(0, Math.min(innerHeight, startY + dy * fraction + dx / distance * bend * side))
    const c1x = controlX(.3)
    const c1y = controlY(.3)
    const c2x = controlX(.7)
    const c2y = controlY(.7)
    const response = curved ? .32 : .19
    const damping = .86
    const frequency = 2 * Math.PI / response
    const damped = frequency * Math.sqrt(1 - damping * damping)
    const duration = curved ? 650 : 420
    const started = performance.now()

    return new Promise<void>(resolve => {
      settle = resolve
      const finish = () => {
        x = endX
        y = endY
        render()
        stop()
      }
      const tick = (now: number) => {
        if (disposed || !host.isConnected) { dispose(); return }
        const elapsed = now - started
        if (elapsed >= duration || document.hidden || reduceMotion.matches) { finish(); return }
        const t = Math.max(0, elapsed) / 1000
        // Analytic damped spring keeps speed independent of frame rate and tab throttling.
        const progress = Math.min(1, Math.max(0, 1 - Math.exp(-damping * frequency * t)
          * (Math.cos(damped * t) + damping / Math.sqrt(1 - damping * damping) * Math.sin(damped * t))))
        if (progress >= .999) { finish(); return }
        const inverse = 1 - progress
        let rotation: number
        if (curved) {
          x = inverse ** 3 * startX + 3 * inverse ** 2 * progress * c1x + 3 * inverse * progress ** 2 * c2x + progress ** 3 * endX
          y = inverse ** 3 * startY + 3 * inverse ** 2 * progress * c1y + 3 * inverse * progress ** 2 * c2y + progress ** 3 * endY
          const tangentX = inverse ** 2 * (c1x - startX) + 2 * inverse * progress * (c2x - c1x) + progress ** 2 * (endX - c2x)
          const tangentY = inverse ** 2 * (c1y - startY) + 2 * inverse * progress * (c2y - c1y) + progress ** 2 * (endY - c2y)
          const heading = Math.atan2(tangentY, tangentX) * 180 / Math.PI + 90
          const delta = ((heading - startAngle + 540) % 360) - 180
          const turn = startAngle + delta * Math.min(1, progress * 5)
          const rest = Math.max(0, (progress - .8) / .2)
          rotation = turn + (((-44 - turn + 540) % 360) - 180) * rest
        } else {
          x = startX + dx * progress
          y = startY + dy * progress
          rotation = startAngle + (-44 - startAngle) * progress + Math.sin(progress * Math.PI) * 10 * dx / distance
        }
        render(rotation, 1 - .12 * Math.sin(progress * Math.PI))
        frame = requestAnimationFrame(tick)
      }
      // Background tabs can stop producing frames. Never wait indefinitely for a visual.
      deadline = window.setTimeout(finish, duration)
      frame = requestAnimationFrame(tick)
    })
  }

  function renew(): void {
    clearTimeout(timer)
    timer = window.setTimeout(dispose, 15000)
  }

  function update(next: CursorCommand): void {
    renew()
    if (next.phase === 'suspend' || next.phase === 'resume') {
      host.style.setProperty('visibility', next.phase === 'suspend' ? 'hidden' : 'visible', 'important')
    }
  }
  Object.assign(host, { cursor: { owner: command.owner, update, move, renew, dispose } })
  document.documentElement.append(host)
  render()
  update(command)
}

export function cursorScript(command: CursorCommand): string {
  return `() => (${pageCursor.toString()})(${JSON.stringify(command)})`
}
