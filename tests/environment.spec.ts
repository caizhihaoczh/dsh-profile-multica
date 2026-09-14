/** Task-token exemption over DSH's subprocess credential scrub. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exemptTaskTokenOn, installMulticaTerminalEnvironment, type ScrubModule } from '../src/environment.ts'

/** DSH's own credential-name matcher, cloned so a test never patches the real one. */
function scrubPattern(): RegExp {
  return /KEY|PASSWORD|SECRET|TOKEN/i
}

/** A module double whose scrub behaves like DSH's: drop every credential-shaped name. */
function scrubModule(pattern: RegExp): ScrubModule {
  return {
    SENSITIVE_ENV_PATTERN: pattern,
    scrubbedParentEnv: () => Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !pattern.test(key)),
    ) as Record<string, string | undefined>,
  }
}

afterEach(() => { vi.unstubAllEnvs() })

describe('exemptTaskTokenOn', () => {
  it('exempts the exact task token and nothing else', () => {
    const pattern = scrubPattern()
    const { patched } = exemptTaskTokenOn([pattern])
    expect(patched).toBe(1)
    expect(pattern.test('MULTICA_TOKEN')).toBe(false)
    expect(pattern.test('multica_token')).toBe(false)
    expect(pattern.test('MULTICA_OTHER_TOKEN')).toBe(true)
    expect(pattern.test('MULTICA_API_KEY')).toBe(true)
    expect(pattern.test('MULTICA_SECRET')).toBe(true)
    expect(pattern.test('DEEPSEEK_API_KEY')).toBe(true)
  })

  it('restores the matcher on dispose', () => {
    const pattern = scrubPattern()
    const { dispose } = exemptTaskTokenOn([pattern])
    expect(pattern.test('MULTICA_TOKEN')).toBe(false)
    dispose()
    expect(pattern.test('MULTICA_TOKEN')).toBe(true)
  })

  it('patches one matcher per instance and survives a second install', () => {
    const pattern = scrubPattern()
    const first = exemptTaskTokenOn([pattern, pattern])
    expect(first.patched).toBe(1)
    const second = exemptTaskTokenOn([pattern])
    expect(second.patched).toBe(1)
    second.dispose()
    // The first install still owns the matcher, so the token stays exempt.
    expect(pattern.test('MULTICA_TOKEN')).toBe(false)
    first.dispose()
    expect(pattern.test('MULTICA_TOKEN')).toBe(true)
  })
})

describe('installMulticaTerminalEnvironment', () => {
  const ctx = new Context()

  it('reports the token as forwarded once the scrub honours the exemption', async () => {
    vi.stubEnv('MULTICA_TOKEN', 'mat_task-token')
    const pattern = scrubPattern()
    const report = await installMulticaTerminalEnvironment(ctx, async () => scrubModule(pattern))
    expect(report?.patched).toBe(1)
    expect(report?.forwarded).toBe(true)
    report?.dispose()
  })

  it('reports not forwarded when the exemption landed on another instance', async () => {
    vi.stubEnv('MULTICA_TOKEN', 'mat_task-token')
    const exempted = scrubPattern()
    const module = scrubModule(scrubPattern())
    module.SENSITIVE_ENV_PATTERN = exempted
    const report = await installMulticaTerminalEnvironment(ctx, async () => module)
    expect(report?.patched).toBe(1)
    expect(report?.forwarded).toBe(false)
    report?.dispose()
  })

  it('returns undefined when no scrub module can be resolved', async () => {
    expect(await installMulticaTerminalEnvironment(ctx, async () => undefined)).toBeUndefined()
  })
})
