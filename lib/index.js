/**
 * dsh-git-ai 鈥?Git AI attribution for DeepSeek Harness.
 *
 * DeepSeek Harness has no built-in Git AI integration, so this plugin feeds
 * Git AI's generic `agent-v1` checkpoint preset from the tool-execution
 * pipeline:
 *
 * - before a file-mutating tool runs  -> `human` checkpoint (baseline so
 *   pre-existing uncommitted human edits are not credited to the AI)
 * - after a successful file mutation  -> `ai_agent` checkpoint (edited paths,
 *   agent name, model, session id, bounded transcript)
 * - around a shell tool call          -> `pre_shell_command` /
 *   `post_shell_command` (files a command rewrites are attributed too)
 *
 * The plugin is deliberately dependency-free (Node built-ins only) and never
 * changes tool behaviour: attribution failures are swallowed and reported on
 * stderr/diagnostics only.
 *
 * @module dsh-git-ai
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-git-ai'

/** Filesystem tools that mutate a single file, mapped to their path argument. */
const FILE_TOOLS = new Map([
  ['write', 'file_path'],
  ['edit', 'file_path'],
  ['str_replace_editor', 'path'],
])

/** `str_replace_editor` commands that only read. */
const READ_ONLY_EDITOR_COMMANDS = new Set(['view'])

/** Shell tools whose effects are diffed as a whole. */
const SHELL_TOOLS = new Set(['pwsh', 'bash'])

/** Absolute Windows path (`C:/…` or `C:\\…` after separator normalization). */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\//

/** Version reported in diagnostics, read once from the package manifest. */
const PLUGIN_VERSION = readPluginVersion()

/**
 * Read this package's version without failing plugin startup.
 * @returns {string} semantic version, or `unknown`.
 */
function readPluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Defaults for every configurable field. */
const DEFAULTS = {
  /** Master switch. */
  enabled: true,
  /** Value reported to Git AI as `agent_name`. */
  agentName: 'deepseek-harness',
  /** Git AI executable; `GIT_AI_BINARY` overrides it. */
  binary: 'git-ai',
  /** Bound on one `git-ai checkpoint` call. */
  timeoutMs: 20000,
  /** Bound on `git rev-parse` repo discovery. */
  gitTimeoutMs: 5000,
  /** Wait for Git AI to settle the pre-command snapshot before the command runs. */
  settleShellCommands: true,
  /** `git-ai await --timeout` value, in seconds. */
  awaitTimeoutSeconds: 10,
  /** Track commands started with `run_in_background` (their effects land later). */
  trackBackgroundCommands: false,
  /** Include a bounded session transcript so prompts stay attached. */
  includeTranscript: true,
  /** Maximum transcript messages sent per checkpoint. */
  maxTranscriptMessages: 24,
  /** Maximum transcript bytes sent per checkpoint. */
  maxTranscriptBytes: 32768,
  /** Extra tool names that mutate a file (paired with `extraFilePathArgs`). */
  extraFileTools: {},
  /** Extra tool names that run a shell command. */
  extraShellTools: [],
  /** How long a discovered repository root is reused, in milliseconds. */
  repoCacheMs: 30000,
  /** Write a small diagnostics file under `$DSH_HOME/dsh-git-ai`. */
  diagnostics: true,
  /** Emit checkpoint payloads and failures on the host logger. */
  debug: false,
}

/**
 * Merge user configuration over {@link DEFAULTS}.
 * @param {Record<string, unknown>} [config] patch-entry `config`.
 * @returns {typeof DEFAULTS} complete options.
 */
export function resolveOptions(config = {}) {
  const options = { ...DEFAULTS }
  if (config && typeof config === 'object') {
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined) continue
      if (key === 'extraFileTools' || key === 'extraShellTools') {
        options[key] = value ?? DEFAULTS[key]
        continue
      }
      options[key] = value
    }
  }
  if (process.env.GIT_AI_BINARY) options.binary = process.env.GIT_AI_BINARY
  return options
}

/**
 * Decide what a tool call does for attribution purposes.
 * @param {string} toolName registered tool name.
 * @param {Record<string, unknown>} args model-supplied arguments.
 * @param {typeof DEFAULTS} options resolved options.
 * @returns {{kind: 'file', path: string} | {kind: 'shell', command: string} | null}
 *   classification, or `null` for calls that cannot change files.
 */
export function classifyToolCall(toolName, args, options = DEFAULTS) {
  if (typeof toolName !== 'string') return null
  const input = args && typeof args === 'object' ? args : {}

  const pathArgument = FILE_TOOLS.get(toolName) ?? options.extraFileTools?.[toolName]
  if (pathArgument) {
    if (toolName === 'str_replace_editor') {
      const command = typeof input.command === 'string' ? input.command : ''
      if (READ_ONLY_EDITOR_COMMANDS.has(command)) return null
    }
    const path = input[pathArgument]
    return typeof path === 'string' && path.length > 0 ? { kind: 'file', path } : null
  }

  const shell = SHELL_TOOLS.has(toolName) || options.extraShellTools?.includes(stringify(toolName))
  if (shell) {
    const command = input.command
    if (typeof command !== 'string' || command.trim().length === 0) return null
    // A background command returns before it writes anything, so pairing its
    // checkpoints would record an empty diff; its effects surface at the next
    // checkpoint instead.
    if (input.run_in_background === true && options.trackBackgroundCommands !== true) return null
    return { kind: 'shell', command }
  }

  return null
}

/**
 * Express one path relative to the repository root when it lives inside it.
 * @param {string} repoRoot absolute repository working directory.
 * @param {string} absolutePath absolute file path.
 * @returns {string} forward-slashed path Git AI accepts.
 */
export function toRepoRelative(repoRoot, absolutePath) {
  const normalized = String(absolutePath).replaceAll('\\', '/')
  if (!repoRoot) return normalized
  const root = String(repoRoot).replaceAll('\\', '/').replace(/\/+$/, '')
  const target = normalized.replace(/\/+/g, '/')
  // Windows paths are case-insensitive; POSIX paths are not.
  const fold = process.platform === 'win32' || WINDOWS_ABSOLUTE.test(root) ? (value) => value.toLowerCase() : (value) => value
  const comparedRoot = fold(root)
  const comparedTarget = fold(target)
  if (comparedTarget === comparedRoot) return '.'
  if (!comparedTarget.startsWith(comparedRoot + '/')) return target
  return target.slice(root.length + 1)
}

/**
 * Resolve a model-supplied path against the session directory.
 * @param {string} cwd absolute session directory.
 * @param {string} candidate path from the tool arguments.
 * @returns {string} absolute path in forward-slash form.
 */
export function resolveToolPath(cwd, candidate) {
  const raw = String(candidate).replaceAll('\\', '/')
  // A drive-letter path stays absolute on every platform: sessions may be
  // replayed or analysed where the host separator differs from the one that
  // produced the path.
  const absolute = isAbsolute(raw) || WINDOWS_ABSOLUTE.test(raw) ? raw : join(cwd ?? '.', raw)
  return absolute.replaceAll(sep, '/')
}

/**
 * Project session messages into the `transcript` shape Git AI documents.
 *
 * Only real user turns and assistant prose are sent: injected context,
 * developer notices and tool results are dropped, because Git AI rejects
 * oversized or tool-result transcript content.
 *
 * @param {readonly unknown[]} messages derived session messages.
 * @param {typeof DEFAULTS} options resolved options.
 * @returns {{messages: Array<Record<string, unknown>>} | undefined} transcript or undefined.
 */
export function buildTranscript(messages, options = DEFAULTS) {
  const entries = []
  for (const message of messages ?? []) {
    if (!message || typeof message !== 'object') continue
    const role = message.role
    const sourceKind = message.source && typeof message.source === 'object' ? message.source.kind : undefined
    let type
    if (role === 'user') {
      if (sourceKind !== 'user') continue
      type = 'user'
    } else if (role === 'assistant') {
      type = 'assistant'
    } else {
      continue
    }
    const text = messageText(message)
    if (!text) continue
    const entry = { type, text }
    const timestamp = messageTimestamp(message)
    if (timestamp) entry.timestamp = timestamp
    entries.push(entry)
  }
  if (entries.length === 0) return undefined

  const limitMessages = Math.max(1, Number(options.maxTranscriptMessages) || DEFAULTS.maxTranscriptMessages)
  const limitBytes = Math.max(1024, Number(options.maxTranscriptBytes) || DEFAULTS.maxTranscriptBytes)

  const firstUser = entries.find((entry) => entry.type === 'user')
  const selected = []
  let bytes = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    const size = Buffer.byteLength(entry.text, 'utf8') + 64
    if (selected.length >= limitMessages) break
    if (selected.length > 0 && bytes + size > limitBytes) break
    selected.unshift(entry)
    bytes += size
  }
  if (firstUser && !selected.includes(firstUser) && selected.length > 0) {
    const size = Buffer.byteLength(firstUser.text, 'utf8') + 64
    if (bytes + size <= limitBytes) {
      selected.unshift(firstUser)
      // Keep the opening task without exceeding the message budget.
      if (selected.length > limitMessages) selected.splice(1, 1)
    }
  }
  return selected.length > 0 ? { messages: selected } : undefined
}

/**
 * Register the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx host context.
 * @param {Record<string, unknown>} [config] patch-entry `config`.
 * @returns {() => void} disposer.
 */
export function apply(ctx, config = {}) {
  const options = resolveOptions(config)
  if (options.enabled === false) return () => {}

  const stats = {
    version: PLUGIN_VERSION,
    mountedAt: new Date().toISOString(),
    pre: 0,
    post: 0,
    failures: 0,
    skipped: 0,
    lastCheckpointAt: null,
    lastError: null,
    binary: null,
  }

  warn(ctx, `mounted (agent_name=${options.agentName}); attribution is best-effort`)
  void writeDiagnostics(options, stats)

  const disposePre = ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      await beforeTool(ctx, exec, options, stats)
    } catch (error) {
      fail(ctx, options, stats, error)
    }
    return typeof next === 'function' ? next() : undefined
  })

  const disposePost = ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      await afterTool(ctx, exec, result, options, stats)
    } catch (error) {
      fail(ctx, options, stats, error)
    }
    return typeof next === 'function' ? next() : undefined
  })

  return () => {
    disposePre?.()
    disposePost?.()
  }
}

/**
 * Record the pre-edit baseline or the pre-command snapshot.
 * @param {any} ctx host context.
 * @param {any} exec tool execution.
 * @param {typeof DEFAULTS} options resolved options.
 * @param {any} stats counters.
 * @returns {Promise<void>} resolves once the checkpoint finished or was skipped.
 */
async function beforeTool(ctx, exec, options, stats) {
  if (!exec?.agent) return
  const call = classifyToolCall(exec.name, exec.arguments ?? {}, options)
  if (!call) return
  if (!(await ensureBinary(ctx, options, stats))) return

  const info = await describe(exec, options)
  if (!info.repoRoot) {
    stats.skipped += 1
    return
  }

  if (call.kind === 'file') {
    const paths = toEditedPaths(info, [call.path])
    if (paths.length === 0) return
    const recorded = await checkpoint(ctx, options, stats, {
      type: 'human',
      repo_working_dir: info.repoRoot,
      will_edit_filepaths: paths,
    })
    // A named baseline also initializes the repository's working log.
    if (recorded) baselines.add(baselineKey(info))
    return
  }

  await ensureBaseline(ctx, options, stats, info)
  const recorded = await checkpoint(ctx, options, stats, {
    type: 'pre_shell_command',
    repo_working_dir: info.repoRoot,
    agent_name: options.agentName,
    model: info.model,
    conversation_id: info.conversationId,
    tool_use_id: exec.callId,
    command: call.command,
  })
  if (recorded) await settle(options)
}

/**
 * Attribute a completed mutation to the model, or close a shell snapshot.
 * @param {any} ctx host context.
 * @param {any} exec tool execution.
 * @param {any} result pipeline result.
 * @param {typeof DEFAULTS} options resolved options.
 * @param {any} stats counters.
 * @returns {Promise<void>} resolves once the checkpoint finished or was skipped.
 */
async function afterTool(ctx, exec, result, options, stats) {
  if (!exec?.agent) return
  const call = classifyToolCall(exec.name, exec.arguments ?? {}, options)
  if (!call) return
  if (!(await ensureBinary(ctx, options, stats))) return

  const info = await describe(exec, options)
  if (!info.repoRoot) {
    stats.skipped += 1
    return
  }

  if (call.kind === 'file') {
    if (result?.isError) return
    const canonical = result?.value && typeof result.value.path === 'string' ? result.value.path : undefined
    const paths = toEditedPaths(info, [canonical ?? call.path])
    if (paths.length === 0) return
    const payload = {
      type: 'ai_agent',
      repo_working_dir: info.repoRoot,
      agent_name: options.agentName,
      model: info.model,
      conversation_id: info.conversationId,
      edited_filepaths: paths,
    }
    if (options.includeTranscript) {
      const transcript = transcriptFor(exec, options)
      if (transcript) payload.transcript = transcript
    }
    await checkpoint(ctx, options, stats, payload)
    return
  }

  await checkpoint(ctx, options, stats, {
    type: 'post_shell_command',
    repo_working_dir: info.repoRoot,
    agent_name: options.agentName,
    model: info.model,
    conversation_id: info.conversationId,
    tool_use_id: exec.callId,
    command: call.command,
  })
}

/**
 * Describe the session a tool call belongs to.
 * @param {any} exec tool execution.
 * @param {typeof DEFAULTS} options resolved options.
 * @returns {Promise<{cwd: string, repoRoot: string | undefined, conversationId: string, model: string}>}
 *   attribution context.
 */
async function describe(exec, options) {
  const cwd = await sessionCwd(exec)
  const repoRoot = await repoRootFor(cwd, options)
  const session = exec.agent?.session
  let model = 'unknown'
  try {
    const selected = session?.requestHeader?.()?.config
    if (selected && typeof selected.model === 'string' && selected.model.length > 0) model = selected.model
  } catch {
    // A session without a request yet has no selected model.
  }
  const conversationId =
    typeof session?.id === 'string' && session.id.length > 0 ? session.id : 'unknown'
  return { cwd, repoRoot, conversationId, model }
}

/**
 * Read the agent's current working directory.
 * @param {any} exec tool execution.
 * @returns {Promise<string>} absolute directory.
 */
async function sessionCwd(exec) {
  const agent = exec.agent
  const directory = agent?.ctx?.get?.('workingDirectory')
  if (directory?.ensure) {
    const resolved = await directory.ensure(agent, exec.signal).catch(() => undefined)
    if (typeof resolved === 'string' && resolved.length > 0) return resolved
  }
  const headerCwd = agent?.session?.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd.length > 0) return headerCwd
  return process.cwd()
}

/** Repository-root lookups keyed by session directory. */
const repoCache = new Map()

/**
 * Discover the Git working tree containing `cwd`, cached for a short while.
 * @param {string} cwd absolute session directory.
 * @param {typeof DEFAULTS} options resolved options.
 * @returns {Promise<string | undefined>} repository root, or undefined outside Git.
 */
async function repoRootFor(cwd, options) {
  const now = Date.now()
  const cached = repoCache.get(cwd)
  if (cached && now - cached.at < options.repoCacheMs) return cached.root
  if (repoCache.size > 64) repoCache.clear()

  const result = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], options.gitTimeoutMs)
  const root = result.ok ? result.stdout.trim().split(/\r?\n/).pop() : undefined
  const normalized = root ? root.replaceAll('\\', '/').replace(/\/+$/, '') : undefined
  repoCache.set(cwd, { root: normalized, at: now })
  return normalized
}

/**
 * Convert tool paths into the paths Git AI should attribute.
 * @param {{cwd: string, repoRoot: string | undefined}} info attribution context.
 * @param {Array<string | undefined>} candidates tool-supplied or canonical paths.
 * @returns {string[]} deduplicated repository-relative paths.
 */
function toEditedPaths(info, candidates) {
  const paths = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    const absolute = resolveToolPath(info.cwd, candidate)
    const path = toRepoRelative(info.repoRoot, absolute)
    if (path.length === 0 || paths.includes(path)) continue
    paths.push(path)
  }
  return paths
}

/** Working logs already initialized, keyed by conversation and repository. */
const baselines = new Set()

/**
 * Identify one conversation's working log in one repository.
 * @param {{conversationId: string, repoRoot: string | undefined}} info attribution context.
 * @returns {string} cache key.
 */
function baselineKey(info) {
  return `${info.conversationId}::${info.repoRoot}`
}

/**
 * Initialize the repository's working log without claiming any existing change.
 *
 * Git AI drops a `pre_shell_command`/`post_shell_command` pair when the
 * repository has no working log yet. A `human` checkpoint with an empty
 * `will_edit_filepaths` creates that log and, unlike a bare `human`
 * checkpoint, leaves earlier AI attribution of uncommitted files intact.
 *
 * @param {any} ctx host context.
 * @param {typeof DEFAULTS} options resolved options.
 * @param {any} stats counters.
 * @param {{conversationId: string, repoRoot: string | undefined}} info attribution context.
 * @returns {Promise<void>} resolves once the baseline exists or the attempt failed.
 */
async function ensureBaseline(ctx, options, stats, info) {
  const key = baselineKey(info)
  if (baselines.has(key)) return
  baselines.add(key)
  const recorded = await checkpoint(ctx, options, stats, {
    type: 'human',
    repo_working_dir: info.repoRoot,
    will_edit_filepaths: [],
  })
  if (!recorded) baselines.delete(key)
}

/**
 * Build the transcript for the current session, tolerating any session shape.
 * @param {any} exec tool execution.
 * @param {typeof DEFAULTS} options resolved options.
 * @returns {{messages: Array<Record<string, unknown>>} | undefined} transcript or undefined.
 */
function transcriptFor(exec, options) {
  try {
    const session = exec.agent?.session
    if (!session?.deriveMessages) return undefined
    return buildTranscript(session.deriveMessages(), options)
  } catch {
    return undefined
  }
}

/** Serialized checkpoint queue: keeps Git AI writes ordered per process. */
let queue = Promise.resolve()

/**
 * Run one Git AI checkpoint, retrying without the transcript if it fails.
 * @param {any} ctx host context.
 * @param {typeof DEFAULTS} options resolved options.
 * @param {any} stats counters.
 * @param {Record<string, unknown>} payload `agent-v1` checkpoint input.
 * @returns {Promise<boolean>} whether Git AI accepted the payload.
 */
async function checkpoint(ctx, options, stats, payload) {
  if (options.debug) warn(ctx, `checkpoint ${payload.type}: ${JSON.stringify(payload).slice(0, 800)}`)
  const runOnce = () => enqueue(() => spawnCheckpoint(options, payload))
  let result = await runOnce()

  if (!result.ok && payload.transcript) {
    const { transcript: _dropped, ...withoutTranscript } = payload
    warn(ctx, `checkpoint failed (${describeFailure(result)}); retrying without transcript`)
    result = await enqueue(() => spawnCheckpoint(options, withoutTranscript))
  }

  if (result.ok) {
    stats.lastCheckpointAt = new Date().toISOString()
    if (payload.type === 'ai_agent' || payload.type === 'post_shell_command') stats.post += 1
    else stats.pre += 1
    // Persist only the first few events, then failures only: diagnostics must
    // not turn every edit into an extra filesystem write.
    if (stats.pre + stats.post <= 4) void writeDiagnostics(options, stats)
    return true
  }

  stats.failures += 1
  stats.lastError = { at: new Date().toISOString(), reason: describeFailure(result) }
  warn(ctx, `checkpoint failed: ${describeFailure(result)}`)
  void writeDiagnostics(options, stats)
  return false
}

/**
 * Serialize queue tasks so concurrent tool calls cannot interleave checkpoints.
 * @template T
 * @param {() => Promise<T>} task work to run.
 * @returns {Promise<T>} the task result.
 */
function enqueue(task) {
  const next = queue.then(task, task)
  queue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/**
 * Invoke `git-ai checkpoint agent-v1` with a JSON payload on stdin.
 * @param {typeof DEFAULTS} options resolved options.
 * @param {Record<string, unknown>} payload checkpoint input.
 * @returns {Promise<{ok: boolean, reason?: string, stderr?: string}>} outcome.
 */
function spawnCheckpoint(options, payload) {
  return spawnWithInput(options.binary, ['checkpoint', 'agent-v1', '--hook-input', 'stdin'], JSON.stringify(payload), options.timeoutMs)
}

/**
 * Wait until the Git AI daemon has processed everything queued so far.
 *
 * `git-ai checkpoint` returns once the payload is accepted, not once its
 * snapshot is recorded. A shell command must not modify the tree before its
 * pre-command snapshot exists, otherwise the pair records no diff at all, so
 * the pre-command hook settles the daemon first.
 *
 * @param {typeof DEFAULTS} options resolved options.
 * @returns {Promise<void>} resolves once settled, timed out, or unavailable.
 */
async function settle(options) {
  if (options.settleShellCommands === false) return
  const seconds = Math.max(1, Number(options.awaitTimeoutSeconds) || DEFAULTS.awaitTimeoutSeconds)
  await enqueue(() => run(options.binary, ['await', '--timeout', String(seconds)], (seconds + 5) * 1000))
}

/**
 * Run a process with stdin text and a hard timeout.
 * @param {string} command executable.
 * @param {string[]} args arguments.
 * @param {string} input stdin text.
 * @param {number} timeoutMs timeout bound.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, reason?: string}>} outcome.
 */
function spawnWithInput(command, args, input, timeoutMs) {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(outcome)
    }
    let child
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      })
    } catch (error) {
      resolvePromise({ ok: false, stdout: '', stderr: '', reason: String(error) })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, stdout, stderr, reason: `timeout after ${timeoutMs}ms` })
    }, timeoutMs)

    child.on('error', (error) => {
      finish({ ok: false, stdout, stderr, reason: `${error.code ?? 'spawn'}: ${error.message}` })
    })
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-4000)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    child.on('close', (code) => {
      finish({ ok: code === 0, stdout, stderr, reason: code === 0 ? undefined : `exit code ${code}` })
    })
    child.stdin?.on('error', () => {
      /* the child may exit before reading stdin; the close event decides */
    })
    child.stdin?.end(input)
  })
}

/**
 * Run a short read-only command.
 * @param {string} command executable.
 * @param {string[]} args arguments.
 * @param {number} timeoutMs timeout bound.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>} outcome.
 */
function run(command, args, timeoutMs) {
  return spawnWithInput(command, args, '', timeoutMs)
}

/** Cached availability probe. */
let availability

/**
 * Ensure Git AI is installed before paying for a checkpoint.
 * @param {any} ctx host context.
 * @param {typeof DEFAULTS} options resolved options.
 * @param {any} stats counters.
 * @returns {Promise<boolean>} whether Git AI answered `--version`.
 */
async function ensureBinary(ctx, options, stats) {
  if (availability === undefined) {
    availability = (async () => {
      const candidates = [options.binary]
      if (process.platform === 'win32') candidates.push(join(homedir(), '.git-ai', 'bin', 'git-ai.exe'))
      candidates.push(join(homedir(), '.git-ai', 'bin', 'git-ai'))
      for (const candidate of candidates) {
        if (typeof candidate !== 'string' || candidate.length === 0) continue
        const probe = await run(candidate, ['--version'], Math.min(options.timeoutMs, 8000))
        if (probe.ok) {
          options.binary = candidate
          stats.binary = candidate
          return true
        }
      }
      return false
    })()
  }
  const available = await availability
  if (!available) {
    stats.skipped += 1
    warn(ctx, `Git AI not found (looked for "${options.binary}"); run \`git-ai install\` and restart`)
  }
  return available
}

/**
 * Write a small diagnostics file so users can tell whether the plugin mounted.
 * @param {typeof DEFAULTS} options resolved options.
 * @param {any} stats counters.
 * @returns {Promise<void>} resolves after the best-effort write.
 */
async function writeDiagnostics(options, stats) {
  if (options.diagnostics === false) return
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const directory = join(home, 'dsh-git-ai')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'state.json'), `${JSON.stringify(stats, null, 2)}\n`, 'utf8')
  } catch {
    // Diagnostics must never affect attribution.
  }
}

/**
 * Format a failed checkpoint outcome.
 * @param {{reason?: string, stderr?: string}} result failure.
 * @returns {string} short human-readable reason.
 */
function describeFailure(result) {
  const stderr = (result.stderr ?? '').trim().split(/\r?\n/).filter(Boolean).pop()
  return stderr || result.reason || 'unknown error'
}

/**
 * Report one swallowed attribution failure.
 * @param {any} ctx host context.
 * @param {typeof DEFAULTS} options resolved options.
 * @param {any} stats counters.
 * @param {unknown} error thrown value.
 * @returns {void}
 */
function fail(ctx, options, stats, error) {
  stats.failures += 1
  stats.lastError = { at: new Date().toISOString(), reason: String(error?.message ?? error) }
  warn(ctx, `attribution error: ${String(error?.message ?? error)}`)
  void writeDiagnostics(options, stats)
}

/**
 * Log through the host logger when available.
 * @param {any} ctx host context.
 * @param {string} message text.
 * @returns {void}
 */
function warn(ctx, message) {
  try {
    ctx?.logger?.info?.(`[dsh-git-ai] ${message}`)
  } catch {
    // Logging is optional.
  }
}

/**
 * Extract plain text from one derived message.
 * @param {any} message session message.
 * @returns {string} text or an empty string.
 */
function messageText(message) {
  if (typeof message.text === 'string') return message.text.trim()
  const content = message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Read a message timestamp as an ISO string when one exists.
 * @param {any} message session message.
 * @returns {string | undefined} ISO timestamp.
 */
function messageTimestamp(message) {
  for (const key of ['timestamp', 'time', 'createdAt']) {
    const value = message[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      const date = new Date(value)
      if (!Number.isNaN(date.getTime())) return date.toISOString()
    }
    if (typeof value === 'string' && value.length > 0) {
      const date = new Date(value)
      if (!Number.isNaN(date.getTime())) return date.toISOString()
    }
  }
  return undefined
}

/**
 * Coerce a value to a string without throwing on symbols or objects.
 * @param {unknown} value any value.
 * @returns {string} string form.
 */
function stringify(value) {
  return typeof value === 'string' ? value : String(value)
}
