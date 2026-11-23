import type { SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { browserCommand, PlatformBrowserOpener } from '../../src/auth/browser.js'

const URL = 'https://app.example.test/auth?state=abc'

class FakeChild extends EventEmitter {
  unref = vi.fn()
}

function fakeSpawn(behaviour: 'spawn' | 'error' | 'exit0' | 'exit1'): {
  readonly calls: Array<{ args: readonly string[]; command: string; options: SpawnOptions }>
  readonly impl: typeof import('node:child_process').spawn
} {
  const calls: Array<{ args: readonly string[]; command: string; options: SpawnOptions }> = []
  const impl = ((command: string, args: readonly string[], options: SpawnOptions): EventEmitter => {
    calls.push({ args, command, options })
    const child = new FakeChild()
    process.nextTick(() => {
      if (behaviour === 'spawn') child.emit('spawn')
      else if (behaviour === 'error') child.emit('error', new Error('cannot open'))
      else child.emit('exit', behaviour === 'exit0' ? 0 : 1)
    })
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { calls, impl }
}

describe('browser opener', () => {
  it('maps each platform to a non-shell invocation with the URL as one argv item', () => {
    expect(browserCommand('win32', URL)).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', URL],
    })
    expect(browserCommand('darwin', URL)).toEqual({ command: 'open', args: [URL] })
    expect(browserCommand('linux', URL)).toEqual({ command: 'xdg-open', args: [URL] })
    expect(browserCommand('freebsd', URL)).toBeNull()
  })

  it('spawns without a shell and passes the URL verbatim', async () => {
    const { calls, impl } = fakeSpawn('spawn')
    const opener = new PlatformBrowserOpener({ platform: 'linux', spawnImpl: impl })
    await expect(opener.open(URL)).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options.shell).toBe(false)
    expect(calls[0]?.args).toEqual([URL])
    expect(calls[0]?.args.filter((value) => value === URL)).toHaveLength(1)
  })

  it('reports failure when the platform has no opener or the process errors', async () => {
    const unsupported = new PlatformBrowserOpener({ platform: 'freebsd' })
    await expect(unsupported.open(URL)).resolves.toBe(false)

    const { impl } = fakeSpawn('error')
    const opener = new PlatformBrowserOpener({ platform: 'darwin', spawnImpl: impl })
    await expect(opener.open(URL)).resolves.toBe(false)
  })

  it('rejects unsafe URLs without spawning', async () => {
    const { calls, impl } = fakeSpawn('spawn')
    const opener = new PlatformBrowserOpener({ platform: 'linux', spawnImpl: impl })
    await expect(opener.open('file:///etc/passwd')).resolves.toBe(false)
    await expect(opener.open('https://x.test/a\n--arg')).resolves.toBe(false)
    expect(calls).toHaveLength(0)
  })
})
