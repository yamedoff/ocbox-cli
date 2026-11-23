import { type SpawnOptions, spawn } from 'node:child_process'
import type { BrowserOpenerPort } from './ports.js'

export interface BrowserCommand {
  readonly command: string
  readonly args: readonly string[]
}

const BROWSER_URL_PATTERN = /^https?:\/\/[^\s"'`<>\\]+$/i

/**
 * Maps a host platform to a browser-open invocation that receives the URL as a
 * single argument and is always executed with `shell: false`.
 */
export function browserCommand(platform: NodeJS.Platform, url: string): BrowserCommand | null {
  switch (platform) {
    case 'win32':
      // rundll32 receives the handler token and the URL as separate argv items.
      return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
    case 'darwin':
      return { command: 'open', args: [url] }
    case 'linux':
      return { command: 'xdg-open', args: [url] }
    default:
      return null
  }
}

export interface PlatformBrowserOpenerOptions {
  readonly platform?: NodeJS.Platform
  readonly spawnImpl?: typeof spawn
  readonly timeoutMilliseconds?: number
}

export class PlatformBrowserOpener implements BrowserOpenerPort {
  readonly #platform: NodeJS.Platform
  readonly #spawn: typeof spawn
  readonly #timeoutMilliseconds: number

  constructor(options: PlatformBrowserOpenerOptions = {}) {
    this.#platform = options.platform ?? process.platform
    this.#spawn = options.spawnImpl ?? spawn
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 5_000
  }

  open(url: string): Promise<boolean> {
    if (!BROWSER_URL_PATTERN.test(url)) return Promise.resolve(false)
    const spec = browserCommand(this.#platform, url)
    if (spec === null) return Promise.resolve(false)
    const options: SpawnOptions = { shell: false, stdio: 'ignore', windowsHide: true }
    return new Promise<boolean>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        resolve(value)
      }
      timer = setTimeout(() => finish(false), this.#timeoutMilliseconds)
      timer.unref?.()
      let child: ReturnType<typeof spawn>
      try {
        child = this.#spawn(spec.command, [...spec.args], options)
      } catch {
        finish(false)
        return
      }
      child.once('error', () => finish(false))
      child.once('spawn', () => {
        child.unref()
        finish(true)
      })
      child.once('exit', (code) => finish(code === 0))
    })
  }
}
