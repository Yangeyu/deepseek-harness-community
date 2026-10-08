export interface CursorCommand {
  phase: 'show' | 'click' | 'finish' | 'hide'
  token?: string
  expiresAt?: number
}

/** Serialized into the page by evaluate_script; keep this function self-contained. */
function pageCursor(command: CursorCommand, target?: Element): void {
  type CursorHost = HTMLElement & {
    cursor: { token: string | undefined; dispose(): void; finish(click: boolean): void }
  }
  const previous = document.querySelector<CursorHost>('[data-dsh-ai-cursor]')
  if (command.phase !== 'show') {
    if (!previous || (command.token && previous.cursor.token !== command.token)) return
    if (command.phase === 'hide') previous.cursor.dispose()
    else previous.cursor.finish(command.phase === 'click')
    return
  }

  // UID evaluation runs in the element's frame. Only draw where page-level cleanup
  // and screenshots can reach the overlay without crossing an origin boundary.
  if (window !== window.top || !target || Date.now() > command.expiresAt!) return
  previous?.cursor.dispose()
  const host = document.createElement('div')
  host.setAttribute('data-dsh-ai-cursor', '')
  host.setAttribute('aria-hidden', 'true')
  host.inert = true
  host.style.cssText = 'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;'
  const shadow = host.attachShadow({ mode: 'closed' })
  shadow.innerHTML = `
    <style>
      :host { pointer-events: none; }
      .pointer { position:absolute;left:-2px;top:-2px;transform-origin:2px 2px;
        filter:drop-shadow(0 0 6px #339cffe6) drop-shadow(0 0 15px #339cff7a); }
      :host([data-phase]) .pointer { animation:fade 500ms forwards; }
      :host([data-phase="click"]) .pointer { animation:press 180ms ease-out,fade 500ms forwards; }
      @keyframes press { 0%,100% { transform:scale(1); } 40% { transform:scale(.86); } }
      @keyframes fade { 0%,60% { opacity:1; } 100% { opacity:0; } }
      @media (prefers-reduced-motion:reduce) {
        :host([data-phase="click"]) .pointer { animation:fade 500ms forwards; }
      }
    </style>
    <svg class="pointer" width="23" height="24" viewBox="0 0 23 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M3.1 2.2C2.1 1.8 1.5 2.5 1.9 3.5L8.3 21.1C8.7 22.2 9.6 22.2 10.1 21.1L13.3 14C13.4 13.7 13.7 13.4 14 13.3L21 10.1C22.2 9.6 22.1 8.7 21 8.3Z" fill="#0d0d0d" stroke="white" stroke-width="2" stroke-linejoin="round"/>
    </svg>`

  let frame = 0
  let timer = window.setTimeout(dispose, 5000)
  function dispose(): void {
    cancelAnimationFrame(frame)
    clearTimeout(timer)
    host.remove()
  }
  function position(): void {
    if (!target!.isConnected) return dispose()
    const rect = target!.getBoundingClientRect()
    const left = Math.max(0, rect.left)
    const right = Math.min(innerWidth, rect.right)
    const top = Math.max(0, rect.top)
    const bottom = Math.min(innerHeight, rect.bottom)
    host.style.setProperty('visibility', right > left && bottom > top ? 'visible' : 'hidden', 'important')
    host.style.setProperty('transform', `translate(${(left + right) / 2}px, ${(top + bottom) / 2}px)`, 'important')
    frame = requestAnimationFrame(position)
  }
  Object.assign(host, { cursor: {
    token: command.token,
    dispose,
    finish(click: boolean) {
      host.dataset.phase = click ? 'click' : 'finish'
      clearTimeout(timer)
      timer = window.setTimeout(dispose, 520)
    },
  } })
  document.documentElement.append(host)
  position()
}

export function cursorScript(command: CursorCommand): string {
  return `(target) => (${pageCursor.toString()})(${JSON.stringify(command)}, target)`
}
