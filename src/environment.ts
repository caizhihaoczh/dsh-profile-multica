/** Forward Multica's task token through DSH's subprocess credential scrub. */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/** The one credential name Multica forwards through DSH's scrub. */
const TASK_TOKEN_KEY = 'MULTICA_TOKEN'

/** Marker on the patched matcher, so installing twice stays idempotent. */
const MATCHER_NAME = 'exemptMulticaTaskToken'

/**
 * The slice of `@deepseek-ai/dsh-subprocess` this module patches and probes.
 *
 * Resolved at runtime rather than imported statically: the launcher's module
 * graph is the one the shell tools spawn through, and a deployment that links
 * this bridge differently must not fail to load over a missing peer.
 */
export interface ScrubModule {
  SENSITIVE_ENV_PATTERN?: unknown
  scrubbedParentEnv?: () => Record<string, string | undefined>
}

/** What {@link installMulticaTerminalEnvironment} achieved. */
export interface TerminalEnvironmentReport {
  /** How many distinct scrub matchers now exempt the task token. */
  patched: number
  /** Whether the task token survives the scrub DSH is going to apply. */
  forwarded: boolean
  /** Restores every patched matcher. */
  dispose: () => void
}

/**
 * Resolves the scrub module for one candidate entrypoint.
 * @param entrypoint - path or file URL of a module inside the launcher's graph.
 * @returns the module exports, or undefined when it cannot be reached.
 */
export type ScrubLoader = (entrypoint: string) => Promise<ScrubModule | undefined>

/**
 * Exempt the exact task-token name from one scrub matcher.
 *
 * DSH deliberately removes credential-shaped ambient variables from every
 * model-spawned subprocess, and `MULTICA_TOKEN` is the one name that must get
 * through: the `multica` CLI refuses agent reads and writes without the
 * server-minted `mat_` credential, so a scrubbed token turns every in-task CLI
 * call into an opaque refusal. Every other `*TOKEN*`, `*KEY*`, `*SECRET*` and
 * `*PASSWORD*` name stays scrubbed.
 * @param pattern - one loaded `SENSITIVE_ENV_PATTERN`.
 * @returns the disposer restoring the untouched matcher.
 */
function exemptTaskToken(pattern: RegExp): () => void {
  if (pattern.test.name === MATCHER_NAME) return () => {}
  const originalTest = pattern.test
  const patchedTest = function (this: RegExp, value: string): boolean {
    if (String(value).toUpperCase() === TASK_TOKEN_KEY) return false
    return originalTest.call(this, value)
  }
  Object.defineProperty(patchedTest, 'name', { value: MATCHER_NAME })
  pattern.test = patchedTest
  return () => {
    if (pattern.test === patchedTest) pattern.test = originalTest
  }
}

/**
 * Exempt the task token on every matcher supplied, deduplicated by identity.
 *
 * Patching a matcher only affects the module instance that matcher belongs to,
 * and a deployment can load the scrub through more than one graph, so the
 * plural is the unit of meaning rather than an optimization.
 * @param patterns - scrub matchers to exempt.
 * @returns the instance count and a disposer restoring all of them.
 */
export function exemptTaskTokenOn(patterns: Iterable<RegExp>): { patched: number, dispose: () => void } {
  const disposers = [...new Set(patterns)].map(exemptTaskToken)
  return {
    patched: disposers.length,
    dispose: () => { for (const dispose of disposers) dispose() },
  }
}

/** The matchers a loaded module exposes, or nothing when it exposes none. */
function matchersOf(module: ScrubModule | undefined): RegExp[] {
  return module?.SENSITIVE_ENV_PATTERN instanceof RegExp ? [module.SENSITIVE_ENV_PATTERN] : []
}

/**
 * Whether a patched module would now hand the task token to a child process.
 * The probe asks the module itself, so it observes the same scrub the shells use.
 * @param modules - every module this install reached.
 * @returns true when at least one module forwards the token.
 */
function forwardsTaskToken(modules: readonly ScrubModule[]): boolean {
  return modules.some((module) => {
    if (module.scrubbedParentEnv === undefined) return false
    try {
      return module.scrubbedParentEnv()[TASK_TOKEN_KEY] !== undefined
    } catch {
      return false
    }
  })
}

/**
 * Resolve a module inside the running launcher's graph, the way the harness
 * itself resolves its own packages.
 * @param entrypoint - path or file URL of the launcher or a module it loaded.
 * @returns the module exports, or undefined when resolution or import fails.
 */
const loadFromLauncher: ScrubLoader = async (entrypoint) => {
  try {
    const require = createRequire(entrypoint)
    return await import(require.resolve('@deepseek-ai/dsh-subprocess')) as ScrubModule
  } catch {
    return undefined
  }
}

/**
 * Candidate graphs to patch, closest to the launcher first.
 *
 * `process.argv[1]` is the launcher the daemon spawned, which is also the graph
 * the shell tools resolve their subprocess provider from. The profile's own
 * base URL is the fallback for launchers that cannot be reached by path.
 * @param ctx - plugin context; its `baseUrl` is the profile directory.
 * @returns resolvable entrypoints, without duplicates.
 */
function entrypoints(ctx: Context): string[] {
  const base = (ctx as { baseUrl?: unknown }).baseUrl
  const candidates = [
    process.argv[1],
    typeof base === 'string' ? base : base instanceof URL ? fileURLToPath(base) : undefined,
  ]
  return [...new Set(candidates.filter((value): value is string => typeof value === 'string' && value.trim() !== ''))]
}

/**
 * Install the task-token exemption on the scrub the agent shells spawn through.
 *
 * Returns undefined when no scrub module could be reached, which means this
 * deployment differs from every layout the resolver knows; the caller reports
 * that as a boot diagnostic rather than letting the agent discover it through
 * a refused `multica` call.
 * @param ctx - plugin context carrying the launcher's graph.
 * @param load - module resolver, overridden only by focused tests.
 * @returns how many matchers were patched and whether the token now survives.
 */
export async function installMulticaTerminalEnvironment(
  ctx: Context,
  load: ScrubLoader = loadFromLauncher,
): Promise<TerminalEnvironmentReport | undefined> {
  const modules: ScrubModule[] = []
  for (const entrypoint of entrypoints(ctx)) {
    const module = await load(entrypoint)
    if (module !== undefined) modules.push(module)
  }
  const patterns = modules.flatMap(matchersOf)
  if (patterns.length === 0) return undefined
  const { patched, dispose } = exemptTaskTokenOn(patterns)
  return { patched, forwarded: forwardsTaskToken(modules), dispose }
}
