import { spawn } from 'node:child_process'

/** Open an authorization URL without interpreting it as shell code. */
export function openAuthorizationUrl(value: string): Promise<void> {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('Expected an HTTPS authorization URL')
  const [command, args] = process.platform === 'darwin'
    ? ['open', [value]] as const
    : process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', value]] as const
      : ['xdg-open', [value]] as const
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Could not open the browser')))
  })
}
