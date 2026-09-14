/** Multica JSONL gateway over the core DSH Agent and Session services. */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import {
  encodeMulticaFrame,
  MULTICA_PROTOCOL_VERSION,
  MulticaProtocolError,
  multicaModelId,
  parseMulticaCommand,
  type MulticaExecuteCommand,
  type MulticaMcpServer,
} from './protocol.ts'
import type { MulticaMode } from './startup.ts'

/** Stable Cordis plugin name. */
export const name = 'multica-runner'
/** Core services required by every bridge mode. */
export const inject = ['agentDefaultModel', 'agents', 'llm', 'sessions']

/** Runner config resolved from the startup provider. */
export interface Config {
  mode: MulticaMode
}

/** Runtime validation for user-overridable Loader config. */
export const Config: z<Config> = z.object({
  mode: z.union(['probe', 'list-models', 'stdio'] as const).required(),
})

interface BridgeIo {
  stdin: Readable
  stdout: Pick<Writable, 'write'>
  stderr: Pick<Writable, 'write'>
  exit(code: number): void
  armForcedExit(code: number): void
}

/** Process effects replaced by focused tests. */
export const internals: Omit<BridgeIo, 'exit'> = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  armForcedExit: (code) => {
    // appExit begins graceful tree disposal. This final ceiling prevents a
    // late inherited watcher from retaining a process-per-task invocation.
    const timer = setTimeout(() => { process.exit(code) }, 250)
    timer.unref()
  },
}

function version(): string {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    version?: unknown
  }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

function frame(io: BridgeIo, value: Record<string, unknown>): void {
  io.stdout.write(encodeMulticaFrame(value))
}

function diagnostic(io: BridgeIo, error: unknown): void {
  io.stderr.write(`dsh multica: ${error instanceof Error ? error.message : String(error)}\n`)
}

function protocolError(io: BridgeIo, error: MulticaProtocolError, requestId?: string): void {
  frame(io, {
    v: MULTICA_PROTOCOL_VERSION,
    type: 'protocol_error',
    ...requestId === undefined ? {} : { request_id: requestId },
    code: error.code,
    message: error.message,
  })
}

function selection(ctx: Context, command: MulticaExecuteCommand): ModelSelection {
  const fallback = ctx.agentDefaultModel.currentSelection()
  const requested = command.model
  const effort = requested?.reasoning_effort ?? command.reasoning_effort ?? fallback.reasoningEffort
  return {
    provider: requested?.provider ?? fallback.provider,
    model: requested?.id ?? fallback.model,
    ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
  }
}

function mcpConfig(server: MulticaMcpServer, cwd: string): McpClient.Config {
  const toolCallTimeoutMs = server.tool_call_timeout_ms ?? 60_000
  if (server.transport === 'stdio') {
    return {
      transport: 'stdio',
      serverName: server.name,
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd ?? cwd,
      toolCallTimeoutMs,
      failOnStartupError: true,
    }
  }
  return {
    transport: 'streamable-http',
    serverName: server.name,
    url: server.url,
    headers: server.headers,
    toolCallTimeoutMs,
    failOnStartupError: true,
  }
}

async function setupAgent(agentCtx: Context, chosen: ModelSelection, command: MulticaExecuteCommand): Promise<void> {
  const selected: ModelSelectionRef = { current: chosen, assembled: undefined }
  installModelSelection(agentCtx, selected)
  for (const server of command.mcp_servers) {
    await agentCtx.plugin(McpClient, mcpConfig(server, command.cwd))
  }
}

function contentText(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        return block.text
      case 'image':
        return `[image:${block.attachment.attachmentId}]`
      case 'tool-call':
        return `${block.name}(${block.arguments})`
      case 'tool-result':
        return contentText(block.content)
      default:
        // ContentBlockMap is merge-extensible. Unknown plugin blocks have no
        // representation in Multica's text-only tool-result frame.
        return ''
    }
  }).join('')
}

interface ObservedTurn {
  output: string
  reason?: TurnEndReason
}

function observe(io: BridgeIo, requestId: string, agent: Agent): { outcome: ObservedTurn; dispose(): void } {
  const outcome: ObservedTurn = { output: '' }
  // DSH session format v2 (the 0.1.3 line) stopped recording per-delta
  // `assistant/chunk` events: an assistant stream is aggregated per attempt into
  // the durable `assistant/message` settlement, and live deltas now reach only
  // the Web client's own channel. Against such a DSH this observer produced no
  // `text`/`thinking` frame at all, so Multica showed the tool activity and
  // never the final answer, while the text sat in the terminal result frame.
  // Publish the committed message's blocks instead, skipping the ones a live
  // delta already delivered.
  let liveTextSeen = false
  let liveThinkingSeen = false
  const dispose = agent.ctx.on('session/event', (session, event: SessionEvent) => {
    if (session.id !== agent.session.id) return
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta') {
        liveTextSeen = true
        frame(io, { v: 1, type: 'text', request_id: requestId, content: chunk.text })
      }
      if (chunk.type === 'reasoning-delta') {
        liveThinkingSeen = true
        frame(io, { v: 1, type: 'thinking', request_id: requestId, content: chunk.text })
      }
      return
    }
    if (event.type === 'assistant/message') {
      const content = event.data.message.content
      outcome.output = content.filter(block => block.type === 'text').map(block => block.text).join('')
      // Block order is the message's own order, so reasoning reaches Multica
      // before the answer it belongs to, exactly as a live stream would.
      for (const block of content) {
        if (block.type === 'text' && block.text !== '' && !liveTextSeen) {
          frame(io, { v: 1, type: 'text', request_id: requestId, content: block.text })
        }
        if (block.type === 'reasoning' && block.text !== '' && !liveThinkingSeen) {
          frame(io, { v: 1, type: 'thinking', request_id: requestId, content: block.text })
        }
      }
      liveTextSeen = false
      liveThinkingSeen = false
      const usage = event.data.usage
      if (usage !== undefined) {
        frame(io, {
          v: 1,
          type: 'usage',
          request_id: requestId,
          provider: event.data.message.source.provider,
          model: event.data.message.source.model,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_tokens: usage.cacheReadTokens ?? 0,
          cache_write_tokens: usage.cacheWriteTokens ?? 0,
        })
      }
      return
    }
    if (event.type === 'tool/call') {
      frame(io, {
        v: 1,
        type: 'tool_call',
        request_id: requestId,
        call_id: event.data.callId,
        name: event.data.name,
        arguments: event.data.arguments,
      })
      return
    }
    if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      frame(io, {
        v: 1,
        type: 'tool_result',
        request_id: requestId,
        call_id: event.data.message.source.callId,
        name: event.data.error?.name ?? '',
        output: contentText(block.content),
        is_error: block.isError ?? false,
      })
      return
    }
    if (event.type === 'turn/end') outcome.reason = event.data.reason
  })
  return { outcome, dispose }
}

function resultFrame(requestId: string, sessionId: string, outcome: ObservedTurn): Record<string, unknown> {
  const reason = outcome.reason
  if (reason?.kind === 'completed' || reason?.kind === 'max-tokens') {
    return {
      v: 1,
      type: 'result',
      request_id: requestId,
      status: 'completed',
      stop_reason: reason.kind,
      session_id: sessionId,
      output: outcome.output,
    }
  }
  if (reason?.kind === 'aborted') {
    return {
      v: 1,
      type: 'result',
      request_id: requestId,
      status: 'cancelled',
      stop_reason: 'cancelled',
      session_id: sessionId,
      output: outcome.output,
    }
  }
  const error = reason?.kind === 'error'
    ? reason.error
    : { code: reason?.kind === 'blocked' ? 'BLOCKED' : 'INCOMPLETE', message: `turn ended with ${reason?.kind ?? 'no result'}` }
  return {
    v: 1,
    type: 'result',
    request_id: requestId,
    status: 'failed',
    stop_reason: reason?.kind ?? 'unknown',
    session_id: sessionId,
    output: outcome.output,
    error: { code: error.code, message: error.message },
  }
}

async function models(ctx: Context, io: BridgeIo): Promise<void> {
  const fallback = ctx.agentDefaultModel.currentSelection()
  const entries = []
  for (const provider of ctx.llm.listProviders()) {
    try {
      for (const model of await ctx.llm.listModels(provider.id)) {
        const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)
        entries.push({
          id: multicaModelId(provider.id, model.id),
          label: model.name,
          provider: provider.name,
          default: provider.id === fallback.provider && model.id === fallback.model,
          ...resolved.reasoning === undefined
            ? {}
            : {
              thinking: {
                supported_levels: resolved.reasoning.efforts.map(effort => ({
                  value: String(effort.id),
                  label: effort.name,
                  ...effort.description === undefined ? {} : { description: effort.description },
                })),
                ...resolved.reasoning.defaultEffort === undefined
                  ? {}
                  : { default_level: String(resolved.reasoning.defaultEffort) },
              },
            },
        })
      }
    } catch (error) {
      diagnostic(io, new Error(`could not list provider ${provider.id}`, { cause: error }))
    }
  }
  frame(io, { v: 1, type: 'models', models: entries })
}

interface ActiveRun {
  requestId: string
  controller: AbortController
  agent?: Agent
}

async function execute(ctx: Context, io: BridgeIo, command: MulticaExecuteCommand, active: ActiveRun): Promise<void> {
  let handle: AgentHandle | undefined
  let observed: ReturnType<typeof observe> | undefined
  try {
    const chosen = selection(ctx, command)
    const create = {
      agentOptions: { provider: chosen.provider, model: chosen.model },
      signal: active.controller.signal,
      setup: (agentCtx: Context) => setupAgent(agentCtx, chosen, command),
    }
    try {
      handle = command.resume_session_id === undefined
        ? await ctx.agents.create({
          ...create,
          sessionId: SessionId(`multica-${randomUUID()}`),
          meta: { cwd: command.cwd },
        })
        : await ctx.agents.resume({ ...create, resumeSessionId: SessionId(command.resume_session_id) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      frame(io, {
        v: 1,
        type: 'result',
        request_id: command.request_id,
        status: active.controller.signal.aborted ? 'cancelled' : 'failed',
        stop_reason: active.controller.signal.aborted ? 'cancelled' : 'startup-error',
        resume_rejected: command.resume_session_id !== undefined && /not found/i.test(message),
        error: { code: 'AGENT_START_FAILED', message },
      })
      return
    }
    active.agent = handle.agent
    observed = observe(io, command.request_id, handle.agent)
    frame(io, {
      v: 1,
      type: 'session',
      request_id: command.request_id,
      session_id: handle.agent.session.id,
      resumed: command.resume_session_id !== undefined,
    })
    if (active.controller.signal.aborted) {
      frame(io, {
        v: 1,
        type: 'result',
        request_id: command.request_id,
        status: 'cancelled',
        stop_reason: 'cancelled',
        session_id: handle.agent.session.id,
        output: '',
      })
      return
    }
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: command.prompt }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    await ctx.sessions.flush(handle.agent.session)
    frame(io, resultFrame(command.request_id, handle.agent.session.id, observed.outcome))
  } catch (error) {
    diagnostic(io, error)
    frame(io, {
      v: 1,
      type: 'result',
      request_id: command.request_id,
      status: active.controller.signal.aborted ? 'cancelled' : 'failed',
      stop_reason: active.controller.signal.aborted ? 'cancelled' : 'bridge-error',
      ...handle === undefined ? {} : { session_id: handle.agent.session.id },
      error: { code: 'BRIDGE_ERROR', message: error instanceof Error ? error.message : String(error) },
    })
  } finally {
    observed?.dispose()
    await handle?.dispose()
  }
}

function stdio(ctx: Context, io: BridgeIo): void {
  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity })
  let active: ActiveRun | undefined
  let exiting = false
  const finish = (code: number): void => {
    if (exiting) return
    exiting = true
    lines.close()
    io.stdin.pause()
    io.stdin.destroy()
    io.exit(code)
    io.armForcedExit(code)
  }
  lines.on('line', (line) => {
    let command
    try {
      command = parseMulticaCommand(line)
    } catch (error) {
      protocolError(io, error instanceof MulticaProtocolError
        ? error
        : new MulticaProtocolError('INVALID_REQUEST', String(error)))
      active?.controller.abort()
      active?.agent?.cancel({ kind: 'user' })
      finish(1)
      return
    }
    if (command.type === 'cancel') {
      if (active === undefined || active.requestId !== command.request_id) {
        protocolError(io, new MulticaProtocolError('REQUEST_NOT_ACTIVE', 'request is not active'), command.request_id)
        return
      }
      active.controller.abort()
      active.agent?.cancel({ kind: 'user' })
      return
    }
    if (active !== undefined) {
      protocolError(io, new MulticaProtocolError('REQUEST_ACTIVE', 'this process already has an active request'), command.request_id)
      return
    }
    const current: ActiveRun = { requestId: command.request_id, controller: new AbortController() }
    active = current
    void execute(ctx, io, command, current).then(
      () => { finish(0) },
      () => { finish(1) },
    )
  })
  lines.on('close', () => {
    if (exiting) return
    active?.controller.abort()
    active?.agent?.cancel({ kind: 'user' })
    if (active === undefined) finish(0)
  })
  frame(io, {
    v: 1,
    type: 'ready',
    runtime: 'dsh',
    plugin_version: version(),
    capabilities: { cancel: true, resume: true, mcp: ['stdio', 'streamable-http'] },
  })
}

async function run(ctx: Context, mode: MulticaMode, io: BridgeIo): Promise<void> {
  await ctx.get('loader')?.await()
  if (ctx.get('agents') === undefined || ctx.get('agentDefaultModel') === undefined
    || ctx.get('llm') === undefined || ctx.get('sessions') === undefined) return
  if (mode === 'probe') {
    frame(io, {
      v: 1,
      type: 'probe',
      runtime: 'dsh',
      plugin_version: version(),
      protocol_version: MULTICA_PROTOCOL_VERSION,
    })
    io.exit(0)
    return
  }
  if (mode === 'list-models') {
    await models(ctx, io)
    io.exit(0)
    return
  }
  stdio(ctx, io)
}

/**
 * Mount the selected Multica bridge operation.
 * @param ctx - plugin context carrying DSH services and launcher exit control.
 * @param config - validated bridge mode.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('multica-runner: the launcher must provide ctx.appExit before the tree mounts')
  const io: BridgeIo = { ...internals, exit }
  void run(ctx, config.mode, io).catch((error: unknown) => {
    diagnostic(io, error)
    io.exit(1)
  })
}
