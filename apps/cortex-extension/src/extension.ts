import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'
import type { AntigravitySDK, Models } from 'antigravity-sdk'
import { getConfig, type CortexConfig } from './config.js'
import {
  asAgentSdk, observeConversation, openTaskConversation, showConversation, stopConversation, taskModelFor, type AgentSdk, type ModelTable,
} from './conversation.js'
import { maskKey, normaliseAgentId, type WindowAgent } from './identity.js'
import { hubUrlProblem } from './mcp-config.js'
import { ownStateDb, pointSdkAtStateDb } from './state-db.js'
import {
  USER_REPORTS, decide, isReviewTask, outcomeFor, revokeStopsConversation, sameRun, startTracking, taskPrompt, timingsFor,
  untrackedProgress, untrackedToast, type Outcome, type TaskTracking, type UserReport,
} from './task-tracker.js'
import { ConductorClient, type ConnectionState, type StopReason } from './ws-client.js'
import { CortexWebviewProvider, CortexPanel, type AgentStatus } from './webview/panel.js'
// hub-api.ts no longer needed — all data fetched via WS

// Antigravity SDK — only in the Antigravity IDE, and only once its initialize() has finished
let antigravitySdk: AgentSdk | null = null
/** The SDK's own Models table, loaded with it; cortexHub.taskModel picks from it. */
let sdkModels: ModelTable | null = null
/** Settles when the SDK is ready or has failed, so that a task arriving first waits for it. */
let sdkSettled: Promise<void> = Promise.resolve()

let client: ConductorClient | null = null
let statusBarItem: vscode.StatusBarItem
let sidebarProvider: CortexWebviewProvider | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null

const stateIcons: Record<ConnectionState, string> = {
  connected: '$(circle-filled)',
  connecting: '$(loading~spin)',
  disconnected: '$(circle-outline)',
}

const stateColors: Record<ConnectionState, vscode.ThemeColor | string> = {
  connected: new vscode.ThemeColor('statusBarItem.warningForeground'),
  connecting: new vscode.ThemeColor('statusBarItem.foreground'),
  disconnected: new vscode.ThemeColor('statusBarItem.errorForeground'),
}

function updateStatusBar(agentId: string, state: ConnectionState): void {
  statusBarItem.text = `${stateIcons[state]} Cortex: ${agentId}`
  statusBarItem.color = stateColors[state]
  statusBarItem.tooltip = `Cortex Hub: ${agentId} (${state})`
  statusBarItem.command = 'cortex.showPanel'
}

/** Forward a WS task message to the sidebar and panel webviews */
function forwardToWebview(type: 'newTask' | 'taskUpdate', payload: Record<string, unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message = { type, payload } as any
  sidebarProvider?.postMessage(message)
  CortexPanel.currentPanel?.postMessage(message)
}

// ── Tasks: one at a time, each in a new conversation of its own ────────────
// task-tracker.ts decides when a task is over; this section carries that out. A task ends when the
// hub says so (task.revoked, task.completed), when the user reports it, or at the hard timeout,
// which reports it failed. Nothing here completes a task because a conversation went quiet.

interface QueuedTask {
  taskId: string
  title: string
  description: string
  attempt?: number
}

/** The task this window runs; null while idle. Set before its conversation opens. */
let active: TaskTracking | null = null
const taskQueue: QueuedTask[] = []
let taskLoop: ReturnType<typeof setInterval> | null = null
let polling = false
/** How often the task's conversation is looked at. Each look reloads the IDE's diagnostics. */
const POLL_MS = 10_000
/** How long a task waits for the SDK to finish initializing. */
const SDK_WAIT_MS = 30_000

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The task in a `task.assigned`: the flat copy, and the attempt from the full one. */
function assignedTask(msg: Record<string, unknown>): QueuedTask {
  const full = (msg['task'] ?? {}) as Record<string, unknown>
  const taskId = String(msg['taskId'] ?? full['id'] ?? '')
  const title = String(msg['title'] ?? full['title'] ?? taskId)
  const description = String(msg['description'] || full['description'] || title)
  const attempt = typeof full['attempt'] === 'number' ? full['attempt'] : undefined
  return { taskId, title, description, attempt }
}

/** Starts a task in a new conversation of its own, or hands it to the user when none can be opened. */
async function startTask(task: QueuedTask, log: (msg: string) => void): Promise<void> {
  // Untracked until a conversation is open, so that a revoke meanwhile still finds the task.
  const starting = startTracking({ ...task, mode: 'untracked' }, Date.now())
  active = starting
  client?.updateStatus('busy')
  log(`Starting task ${task.taskId}: ${task.title}`)

  const prompt = taskPrompt(task.taskId, task.description)
  // A task that arrives during start-up waits for the SDK, but not forever: then it goes to the clipboard.
  await Promise.race([sdkSettled, new Promise((resolve) => setTimeout(resolve, SDK_WAIT_MS))])
  const sdk = antigravitySdk
  const settings = vscode.workspace.getConfiguration('cortexHub')
  const focus = settings.get<boolean>('focusOnAssign', false)
  const model = sdkModels ? taskModelFor(settings.get('taskModel'), sdkModels) : null
  const opened = sdk && model
    ? await openTaskConversation(sdk, prompt, { focus, title: `Cortex: ${task.title}`, model }, log)
    : { mode: 'none' as const, why: 'this window has no agent API (the Antigravity SDK is not active)' }

  if (!sameRun(active, starting)) {
    log(`Task ${task.taskId} ended while its conversation was opening`)
    if (opened.mode === 'tracked' && sdk) await stopConversation(sdk, opened.conversationId).catch(() => {})
    return
  }

  if (opened.mode === 'tracked') {
    active = startTracking({ ...task, mode: 'tracked', conversationId: opened.conversationId }, starting.startedAt)
    const how = `${opened.via}, ${opened.via === 'ls.createCascade' ? model?.name : "the IDE's selected model"}`
    log(`Task ${task.taskId} runs in its own conversation ${opened.conversationId} (${how})`)
    client?.reportProgress(task.taskId, `Started in its own conversation ${opened.conversationId} (${how})`)
    return
  }

  // Not followed automatically: say so to the hub and to the user, with buttons to report the result.
  const mode = opened.mode === 'untracked' ? 'untracked' : 'manual'
  active = startTracking({ ...task, mode }, starting.startedAt)
  client?.reportProgress(task.taskId, untrackedProgress(mode))
  if (opened.mode === 'none') {
    log(`No new conversation for task ${task.taskId} (${opened.why}); the prompt goes to the clipboard`)
    try { await vscode.env.clipboard.writeText(prompt) } catch (e) { log(`Could not copy the prompt for ${task.taskId}: ${messageOf(e)}`) }
    try { await vscode.commands.executeCommand('workbench.action.chat.open') } catch { /* no chat panel in this IDE */ }
  } else {
    log(`Task ${task.taskId} went to a new conversation whose id was not detected; it is not followed`)
  }
  offerReport(active, untrackedToast(task.title, mode, process.platform), false, log)
}

/** A toast with the result buttons for run `t`. A button pressed after that run ended does nothing. */
function offerReport(t: TaskTracking, text: string, warn: boolean, log: (msg: string) => void): void {
  const buttons: string[] = t.mode === 'tracked' ? ['Show conversation', ...USER_REPORTS] : [...USER_REPORTS]
  const shown = warn ? vscode.window.showWarningMessage(text, ...buttons) : vscode.window.showInformationMessage(text, ...buttons)
  void shown.then(async (pick) => {
    if (!pick) return
    if (!sameRun(active, t)) {
      void vscode.window.showInformationMessage(`Cortex: "${t.title}" is no longer running in this window`)
      return
    }
    if (pick === 'Show conversation') {
      if (antigravitySdk && t.conversationId) {
        await showConversation(antigravitySdk, t.conversationId).catch((e: unknown) => log(`Could not show conversation ${t.conversationId}: ${messageOf(e)}`))
      }
      offerReport(t, `Cortex: report the result of "${t.title}" when the agent has finished.`, false, log)
      return
    }
    endTask(t, outcomeFor(pick as UserReport), log)
  })
}

/** How a run ends: an outcome this window reports, or one the hub already knows. */
type Ending = Outcome | { kind: 'hub'; why: string; stopConversation: boolean }

/** Ends run `t` once: tells the hub unless the hub told us, stops its conversation if needed, starts the next task. */
function endTask(t: TaskTracking, ending: Ending, log: (msg: string) => void): void {
  if (!sameRun(active, t)) return
  active = null
  let stop: boolean
  switch (ending.kind) {
    case 'complete':
      client?.completeTask(t.taskId, ending.result, { status: ending.status, attempt: t.attempt })
      log(`Task ${t.taskId} reported ${ending.status}: ${ending.result.summary}`)
      stop = ending.status === 'failed'
      break
    case 'decline':
      client?.declineTask(t.taskId, ending.reason, t.attempt)
      log(`Task ${t.taskId} handed back: ${ending.reason}`)
      stop = true
      break
    case 'hub':
      log(`Task ${t.taskId} ended by the hub: ${ending.why}`)
      stop = ending.stopConversation
      break
  }
  // A task that failed or went elsewhere may be run again; its old conversation must not keep working on it.
  const sdk = antigravitySdk
  if (stop && sdk && t.conversationId) {
    const id = t.conversationId
    void stopConversation(sdk, id).then(() => log(`Stopped conversation ${id}`), (e: unknown) => log(`Could not stop conversation ${id}: ${messageOf(e)}`))
  }
  nextTask(log)
}

/** Starts the next queued task, or tells the hub this window is idle. */
function nextTask(log: (msg: string) => void): void {
  const next = taskQueue.shift()
  if (!next) {
    log('Task queue empty — agent idle')
    client?.updateStatus('idle')
    return
  }
  vscode.window.showInformationMessage(`Cortex: Starting next task "${next.title}"`)
  startTask(next, log).catch((e: unknown) => log(`Task ${next.taskId} could not start: ${messageOf(e)}`))
}

/** One look at the running task, and whatever task-tracker decides about it. */
async function pollTask(log: (msg: string) => void): Promise<void> {
  if (polling) return
  if (!active) {
    if (taskQueue.length > 0) nextTask(log)
    return
  }
  polling = true
  try {
    const t = active
    const sdk = antigravitySdk
    const seen = t.mode === 'tracked' && t.conversationId && sdk
      ? await observeConversation(sdk, t.conversationId)
      : { kind: 'unknown' as const }
    // The run may have ended, or got its conversation, while the poll was out.
    const current = active
    if (current === null || !sameRun(current, t)) return
    const minutes = vscode.workspace.getConfiguration('cortexHub').get<number>('taskTimeoutMinutes')
    const { next, decision } = decide(current, current.conversationId === t.conversationId ? seen : { kind: 'unknown' }, Date.now(), timingsFor(minutes))
    active = next
    switch (decision.kind) {
      case 'wait':
        break
      case 'progress':
        client?.reportProgress(t.taskId, decision.message)
        break
      case 'attention':
        log(`Task ${t.taskId}: ${decision.message}`)
        client?.reportProgress(t.taskId, decision.message)
        offerReport(next, `Cortex: "${t.title}" needs attention. ${decision.message}`, true, log)
        break
      case 'timeout':
        log(`Task ${t.taskId}: ${decision.message}`)
        void vscode.window.showWarningMessage(`Cortex: "${t.title}" was reported failed. ${decision.message}`)
        endTask(next, { kind: 'complete', status: 'failed', result: { summary: decision.message, error: decision.message } }, log)
        break
    }
  } finally {
    polling = false
  }
}

function startTaskLoop(log: (msg: string) => void): void {
  if (taskLoop) return
  taskLoop = setInterval(() => {
    pollTask(log).catch((e: unknown) => log(`Task poll failed: ${messageOf(e)}`))
  }, POLL_MS)
}

/** Request data via WS — server responds with data.response */
function refreshHubData(): void {
  client?.send({ type: 'request.data' })
}

// ── This window's agent ────────────────────────────────────────────────────
// The Agent Panel's choices for one window. Name and capabilities live in workspaceState; the key
// lives in SecretStorage (the OS keychain) under a random slot id kept in workspaceState, so each
// workspace window can be its own agent with its own key, and no key lands in settings.json.
const WINDOW_AGENT_ID = 'cortexHub.window.agentId'
const WINDOW_CAPABILITIES = 'cortexHub.window.capabilities'
const WINDOW_SLOT = 'cortexHub.window.slot'
const SECRET_PREFIX = 'cortexHub.apiKey.'

async function readWindowAgent(context: vscode.ExtensionContext, log: (msg: string) => void): Promise<WindowAgent> {
  const slot = context.workspaceState.get<string>(WINDOW_SLOT)
  let apiKey: string | undefined
  if (slot) {
    try {
      apiKey = await context.secrets.get(SECRET_PREFIX + slot)
    } catch (e) {
      log(`Could not read this window's key from the OS keychain: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return {
    agentId: context.workspaceState.get<string>(WINDOW_AGENT_ID),
    capabilities: context.workspaceState.get<string[]>(WINDOW_CAPABILITIES),
    apiKey,
  }
}

/** A key source for display: a config path with the home directory as `~`. */
function displaySource(source: string): string {
  const home = homedir()
  return home && source.startsWith(home) ? '~' + source.slice(home.length) : source
}

/** What the webview shows: the key only as a hint, never the key. */
function agentPayload(cfg: CortexConfig, connectionStatus: ConnectionState, note?: string): AgentStatus {
  return {
    agentId: cfg.agentId,
    capabilities: cfg.capabilities,
    connectionStatus,
    uptime: 0,
    keyHint: maskKey(cfg.apiKey),
    keySource: displaySource(cfg.keySource),
    hubUrl: cfg.hubUrl,
    hubSource: displaySource(cfg.hubSource),
    note,
  }
}

/** The hub, name and key a connection dials. A config with the same target can keep the connection. */
function connectionTarget(cfg: CortexConfig): string {
  return JSON.stringify([cfg.hubUrl, cfg.agentId, cfg.apiKey])
}

function postAgent(status: AgentStatus): void {
  const message = { type: 'updateAgent' as const, payload: status }
  sidebarProvider?.postMessage(message)
  CortexPanel.currentPanel?.postMessage(message)
}

function toast(message: string, level: 'info' | 'success' | 'warning' | 'error'): void {
  const msg = { type: 'toast' as const, payload: { message, level } }
  sidebarProvider?.postMessage(msg)
  CortexPanel.currentPanel?.postMessage(msg)
}

/** Why the hub closed this window's connection on purpose, in words the panel and a warning can show. */
function stopNote(reason: StopReason, cfg: CortexConfig, text: string): string {
  switch (reason) {
    case 'replaced':
      return `Another window on this machine connected as "${cfg.agentId}", so this one stopped. Give this window its own name.`
    case 'agent-in-use':
      return `"${cfg.agentId}" is already connected from another machine${text ? ` (${text})` : ''}. Give this window its own name.`
    case 'bad-key':
      return `The hub refused the key (${displaySource(cfg.keySource)}): wrong, revoked or for another project.`
    case 'missing-key':
      return 'The hub got no key or no agent id.'
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Output channel for logs — first, so reading this window's key can report a failure
  const output = vscode.window.createOutputChannel('Cortex Agent')
  context.subscriptions.push(output)

  function log(msg: string): void {
    output.appendLine(`[${new Date().toISOString()}] ${msg}`)
  }

  /** The settings, env and MCP configs, with this window's own agent on top. */
  const loadConfig = async (): Promise<CortexConfig> => getConfig(await readWindowAgent(context, log))
  /** Who this window is now. The live client always runs with this config. */
  let current = await loadConfig()
  /** Why the hub last closed the connection on purpose; cleared when a connection starts. */
  let stoppedNote: string | undefined
  /** connectionTarget() of the live client. */
  let clientTarget: string | undefined
  /** A hub answered since activation, so a missing hub URL is not what is wrong. */
  let reachedHub = false
  let hubUrlWarned = false

  /** Ask for the hub's MCP URL and save it for every window on this machine. */
  async function promptHubUrl(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: 'Cortex: hub URL',
      prompt: 'The MCP URL from the dashboard (Home, Quick Connect). Saved for every window on this machine.',
      placeHolder: 'https://<your-mcp-host>/mcp',
      value: vscode.workspace.getConfiguration('cortexHub').get<string>('hubUrl', ''),
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? hubUrlProblem(v) ?? null : null),
    })
    if (value && !hubUrlProblem(value)) await vscode.commands.executeCommand('cortex.saveAgent', { hubUrl: value })
  }

  /** Nothing names a hub and localhost did not answer: say so once, with the fix. */
  function warnNoHubUrl(): void {
    hubUrlWarned = true
    log(`No hub URL in the cortexHub.hubUrl setting, env or MCP configs, and nothing answers at ${current.hubUrl}.`)
    void vscode.window
      .showWarningMessage(`Cortex: no hub URL is set, and nothing answers at ${current.hubUrl}. Paste the MCP URL from the dashboard.`, 'Set hub URL')
      .then((pick) => {
        if (pick === 'Set hub URL') void promptHubUrl()
      })
  }

  // Initialize Antigravity SDK if running in Antigravity IDE. Without it each task goes to the
  // clipboard and the user reports its result.
  if (current.ide === 'antigravity') {
    try {
      // Loaded on demand: it touches Antigravity-only commands, and plain VS Code never needs it
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AntigravitySDK: Sdk, Models: models } = require('antigravity-sdk') as { AntigravitySDK: typeof AntigravitySDK; Models: typeof Models }
      const sdk = new Sdk(context)
      // Open this IDE's own state database: the SDK's guess misses the "Antigravity IDE" folder
      const stateDb = ownStateDb(context.globalStorageUri.fsPath)
      if (!stateDb) log('No state database beside this extension\'s storage, so the Antigravity SDK looks for one itself')
      else if (pointSdkAtStateDb(sdk, stateDb)) log(`Antigravity SDK reads this IDE's state database (${basename(dirname(dirname(dirname(stateDb))))})`)
      else log('This Antigravity SDK has no state database lookup to point at this IDE, so it looks for one itself')
      sdkSettled = sdk.initialize().then(() => {
        antigravitySdk = asAgentSdk(sdk)
        sdkModels = models
        context.subscriptions.push(sdk)
        log(`Antigravity SDK ready (language server ${sdk.ls.isReady ? 'ready' : 'not ready'}): each task gets a conversation of its own`)
        vscode.window.showInformationMessage('Cortex: Antigravity SDK ready — each task runs in a new conversation')
      }, (err: unknown) => {
        log(`Antigravity SDK init failed, so tasks go to the clipboard: ${messageOf(err)}`)
      })
    } catch (e) {
      log(`Antigravity SDK not loaded, so tasks go to the clipboard: ${messageOf(e)}`)
    }
  }
  startTaskLoop(log)

  // Status bar — shows agent ID + connection state
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  updateStatusBar(current.agentId, 'disconnected')
  statusBarItem.show()
  context.subscriptions.push(statusBarItem)

  // Register CortexPanel sidebar webview provider
  sidebarProvider = new CortexWebviewProvider(context.extensionUri)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CortexWebviewProvider.viewType,
      sidebarProvider,
    ),
  )

  // Connect as `current`. Disposing the old client drops its listeners, so the handlers below
  // always describe the live connection.
  function initClient(): void {
    if (client) {
      client.dispose()
    }

    stoppedNote = undefined
    client = new ConductorClient(current)
    clientTarget = connectionTarget(current)

    client.on('stateChange', (state: ConnectionState) => {
      updateStatusBar(current.agentId, state)
      log(`Connection state: ${state}`)
    })

    client.on('connected', () => {
      reachedHub = true
      vscode.window.showInformationMessage(`Cortex: Connected as ${current.agentId}`)
      postAgent(agentPayload(current, 'connected'))
      // A reconnect mid-task must not read as idle, or the hub hands this window a second task.
      if (active) client?.updateStatus('busy')

      // Fetch and push Hub data
      refreshHubData()
      // Refresh every 15s
      if (refreshTimer) clearInterval(refreshTimer)
      refreshTimer = setInterval(() => refreshHubData(), 15000)
    })

    client.on('disconnected', (code: number, reason: string) => {
      log(`Disconnected: code=${code} reason=${reason}`)
      postAgent(agentPayload(current, 'disconnected'))
      // The localhost fallback suits a hub on this machine. When nothing answers there either, the
      // URL is what is missing, not a key or a name.
      if (current.hubSource === 'default' && !reachedHub && !hubUrlWarned) warnNoHubUrl()
    })

    // The hub closed on purpose (replaced, id in use, key refused). Reconnecting would only fight
    // the other window for the id, so say why and offer the fix instead.
    client.on('stopped', (reason: StopReason, code: number, text: string) => {
      const cfg = current
      stoppedNote = stopNote(reason, cfg, text)
      log(`Stopped reconnecting: ${reason} (code=${code}${text ? `, ${text}` : ''})`)
      postAgent(agentPayload(cfg, 'disconnected', stoppedNote))
      const fix = reason === 'replaced' || reason === 'agent-in-use' ? 'Rename this window' : 'Set key for this window'
      void vscode.window.showWarningMessage(`Cortex: ${stoppedNote}`, fix, 'Reconnect').then(async (pick) => {
        if (pick === 'Reconnect') {
          await vscode.commands.executeCommand('cortex.connect')
        } else if (pick === 'Rename this window') {
          const agentId = await vscode.window.showInputBox({
            title: 'Cortex: agent name for this window',
            value: cfg.agentId,
            validateInput: (v) => (normaliseAgentId(v) ? null : '1 to 64 characters, no control characters'),
          })
          if (agentId) await vscode.commands.executeCommand('cortex.saveAgent', { agentId })
        } else if (pick === 'Set key for this window') {
          const apiKey = await vscode.window.showInputBox({
            title: 'Cortex: API key for this window',
            prompt: 'Stored in the OS keychain for this window only',
            password: true,
            ignoreFocusOut: true,
          })
          if (apiKey?.trim()) await vscode.commands.executeCommand('cortex.saveAgent', { apiKey })
        }
      })
    })

    client.on('error', (err: Error) => {
      log(`Error: ${err.message}`)
    })

    client.on('welcome', (msg: Record<string, unknown>) => {
      const agents = msg['onlineAgents'] as unknown[]
      log(`Welcome — ${agents?.length ?? 0} agent(s) online`)
    })

    // A task for this window: run it now in a conversation of its own, or queue it behind the current one
    client.on('task.assigned', (msg: Record<string, unknown>) => {
      const task = assignedTask(msg)
      if (!task.taskId) return
      log(`Task assigned: ${task.taskId} — ${task.title}`)
      forwardToWebview('newTask', msg)

      // Reviews go to a reviewer agent. Hand the task back rather than report a review that never ran.
      if (isReviewTask(task.title)) {
        log(`Declining review task ${task.taskId}: this window does not run reviews`)
        client?.declineTask(task.taskId, 'This IDE window does not run review tasks', task.attempt)
        return
      }

      client?.acceptTask(task.taskId)
      // The hub sends a task again after a reconnect or a retry: keep the one run, with its newest attempt.
      if (active?.taskId === task.taskId) {
        if (task.attempt !== undefined) active = { ...active, attempt: task.attempt }
        log(`Task ${task.taskId} is already running here`)
        return
      }
      const queued = taskQueue.find((q) => q.taskId === task.taskId)
      if (queued) {
        if (task.attempt !== undefined) queued.attempt = task.attempt
        log(`Task ${task.taskId} is already queued`)
        return
      }

      if (active) {
        taskQueue.push(task)
        log(`Agent busy (task ${active.taskId}) — queued task ${task.taskId} (queue size: ${taskQueue.length})`)
        vscode.window.showInformationMessage(`Cortex: Task "${task.title}" queued (${taskQueue.length} in queue)`)
        return
      }
      vscode.window.showInformationMessage(`Cortex: Executing "${task.title}"`)
      startTask(task, log).catch((e: unknown) => log(`Task ${task.taskId} could not start: ${messageOf(e)}`))
    })

    // The hub took a task back: its agent reported through cortex_task_update, or it was cancelled,
    // deleted or moved. Stop following it, and stop its conversation unless the agent finished it.
    client.on('task.revoked', (msg: Record<string, unknown>) => {
      const taskId = String(msg['taskId'] ?? '')
      const reason = String(msg['reason'] ?? 'revoked')
      log(`Task revoked: ${taskId} (${reason})`)
      forwardToWebview('taskUpdate', msg)
      const at = taskQueue.findIndex((q) => q.taskId === taskId)
      if (at >= 0) {
        const [dropped] = taskQueue.splice(at, 1)
        log(`Dropped queued task ${taskId}`)
        void vscode.window.showInformationMessage(`Cortex: "${dropped?.title ?? taskId}" was taken off this window's queue (${reason})`)
        return
      }
      if (active?.taskId === taskId) {
        const t = active
        void vscode.window.showInformationMessage(`Cortex: "${t.title}" ended on the hub (${reason})`)
        endTask(t, { kind: 'hub', why: reason, stopConversation: revokeStopsConversation(reason) }, log)
      }
    })

    // A task finished on the hub. If it is this window's own, the hub already knows: just move on.
    client.on('task.completed', (msg: Record<string, unknown>) => {
      const taskId = String(msg['taskId'] ?? '')
      log(`Task completed: ${taskId} by ${String(msg['agentId'] ?? 'unknown')}`)
      forwardToWebview('taskUpdate', msg)
      const at = taskQueue.findIndex((q) => q.taskId === taskId)
      if (at >= 0) taskQueue.splice(at, 1)
      if (active?.taskId === taskId) endTask(active, { kind: 'hub', why: 'completed', stopConversation: false }, log)
    })

    client.on('task.progress', (msg: Record<string, unknown>) => {
      log(`Task progress: ${msg['taskId']} — ${msg['message']} (${msg['percent'] ?? '?'}%)`)
      forwardToWebview('taskUpdate', msg)
    })

    // A direct message from another agent or the dashboard
    client.on('agent.message', (msg: Record<string, unknown>) => {
      const from = String(msg['from'] ?? 'unknown')
      const raw = msg['content']
      const content = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
      log(`Message from ${from}: ${content}`)
      const short = content.length > 200 ? `${content.slice(0, 200)}…` : content
      void vscode.window.showInformationMessage(`Cortex: message from ${from}: ${short}`)
    })

    client.on('agent.online', (msg: Record<string, unknown>) => {
      log(`Agent online: ${msg['agentId']}`)
    })

    client.on('agent.offline', (msg: Record<string, unknown>) => {
      log(`Agent offline: ${msg['agentId']}`)
    })

    // Handle data.response — project data from Hub via WS
    client.on('data.response', (msg: Record<string, unknown>) => {
      log(`Data received: ${(msg['tasks'] as unknown[])?.length ?? 0} tasks, ${(msg['agents'] as unknown[])?.length ?? 0} agents`)
      const hubData = { type: 'hubData' as const, payload: msg }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sidebarProvider?.postMessage(hubData as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      CortexPanel.currentPanel?.postMessage(hubData as any)
      // Also push tasks for task feed
      const tasks = msg['tasks'] as Record<string, unknown>[] | undefined
      if (tasks && tasks.length > 0) {
        const taskMsg = {
          type: 'updateTasks' as const,
          payload: tasks.map(t => ({
            id: t['id'], title: t['title'], status: t['status'],
            assignedAgent: t['assigned_to_agent'] ?? 'any',
            createdBy: t['created_by_agent'] ?? 'unknown',
            assignedTo: t['assigned_to_agent'] ?? 'unassigned',
            createdAt: t['created_at'], parentId: t['parent_task_id'] ?? undefined,
          })),
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sidebarProvider?.postMessage(taskMsg as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        CortexPanel.currentPanel?.postMessage(taskMsg as any)
      }
    })

    client.connect()
  }

  // Connect command
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.connect', async () => {
      current = await loadConfig()
      if (!current.apiKey) {
        vscode.window.showErrorMessage(
          'Cortex: No API key found. Set one for this window in the Agent Panel (pencil icon), or set cortexHub.apiKey or CORTEX_API_KEY.',
        )
        return
      }
      initClient()
    }),
  )

  // Disconnect command
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.disconnect', () => {
      if (client) {
        client.dispose()
        client = null
        updateStatusBar(current.agentId, 'disconnected')
        vscode.window.showInformationMessage('Cortex: Disconnected')
      }
    }),
  )

  // Show status command
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.showStatus', () => {
      if (!client) {
        vscode.window.showInformationMessage('Cortex: Not connected')
        return
      }
      vscode.window.showInformationMessage(
        `Cortex: ${client.state} | Agent: ${current.agentId} | Capabilities: ${current.capabilities.join(', ')}`,
      )
    }),
  )

  // Refresh data command — triggered by webview on ready or refresh button
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.refreshData', () => {
      // Push current agent status
      postAgent(agentPayload(current, client?.state ?? 'disconnected', stoppedNote))
      // Fetch hub data
      if (current.apiKey) refreshHubData()
    }),
  )

  // cortex.showPanel command — opens CortexPanel in an editor tab
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.showPanel', () => {
      CortexPanel.createOrShow(context.extensionUri)
    }),
  )

  // cortex.reportTask — the result buttons for the running task, for when its toast is gone
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.reportTask', () => {
      if (!active) {
        void vscode.window.showInformationMessage('Cortex: no task is running in this window')
        return
      }
      offerReport(active, `Cortex: report the result of "${active.title}".`, false, log)
    }),
  )

  // cortex.viewTask — a task card in the panel was clicked
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.viewTask', (taskId?: unknown) => {
      const id = typeof taskId === 'string' ? taskId : ''
      if (active && active.taskId === id) {
        offerReport(active, `Cortex: "${active.title}" is running in this window.`, false, log)
        return
      }
      const at = taskQueue.findIndex((q) => q.taskId === id)
      if (at >= 0) {
        void vscode.window.showInformationMessage(`Cortex: "${taskQueue[at]?.title}" is queued in this window (${at + 1} of ${taskQueue.length})`)
        return
      }
      void vscode.window.showInformationMessage('Cortex: that task is not running in this window. Open the dashboard for its details.')
    }),
  )

  /**
   * Re-read who this window is and act on it: reconnect once if the hub, name or key changed.
   * `retryStopped` also restarts a connection the hub stopped, for a Save the user just made.
   * Saving a hub URL changes the settings too, so this can run twice for one Save; whichever run
   * comes second finds the client already dialing the new target and leaves it alone.
   */
  async function applyWindowAgent(retryStopped = true): Promise<void> {
    current = await loadConfig()
    log(`This window: agentId=${current.agentId} capabilities=${current.capabilities.join(',')} hubUrl=${current.hubUrl} hubSource=${current.hubSource} apiKey=${maskKey(current.apiKey) || 'NONE'} keySource=${current.keySource}`)
    const keep = client !== null && clientTarget === connectionTarget(current) && !(retryStopped && stoppedNote)
    if (client && keep) {
      client.updateConfig(current)
      if (client.state === 'connected') client.sendCapabilitiesUpdate(current.capabilities)
    } else if (current.apiKey) {
      initClient()
    } else {
      client?.dispose()
      client = null
    }
    updateStatusBar(current.agentId, client?.state ?? 'disconnected')
    postAgent(agentPayload(current, client?.state ?? 'disconnected', stoppedNote))
  }

  // cortex.saveAgent — the Agent Panel's Save: name, capabilities and key for this window only, and
  // the hub URL for every window. A field left out keeps its current value, as does an empty key or URL.
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.saveAgent', async (input?: { agentId?: string; capabilities?: string[]; apiKey?: string; hubUrl?: string }) => {
      const state = context.workspaceState
      const hubUrl = input?.hubUrl?.trim()
      const hubProblem = hubUrl ? hubUrlProblem(hubUrl) : undefined
      if (hubProblem) {
        toast(hubProblem, 'error')
        return
      }
      if (input?.agentId !== undefined) {
        const agentId = normaliseAgentId(input.agentId)
        if (!agentId) {
          toast('Agent name must be 1 to 64 characters, without control characters', 'error')
          return
        }
        await state.update(WINDOW_AGENT_ID, agentId)
      }
      if (Array.isArray(input?.capabilities)) {
        await state.update(WINDOW_CAPABILITIES, input.capabilities.filter((c) => typeof c === 'string' && c.trim() !== ''))
      }
      const apiKey = input?.apiKey?.trim()
      if (apiKey) {
        let slot = state.get<string>(WINDOW_SLOT)
        if (!slot) {
          slot = randomUUID()
          await state.update(WINDOW_SLOT, slot)
        }
        try {
          await context.secrets.store(SECRET_PREFIX + slot, apiKey)
        } catch (e) {
          log(`Could not store the key in the OS keychain: ${e instanceof Error ? e.message : String(e)}`)
          toast('Could not store the key in the OS keychain. See Output > Cortex Agent.', 'error')
          return
        }
      }
      if (hubUrl) {
        // Every window on a machine talks to the same hub, so the URL is a user setting, not window state.
        const settings = vscode.workspace.getConfiguration('cortexHub')
        try {
          await settings.update('hubUrl', hubUrl, vscode.ConfigurationTarget.Global)
        } catch (e) {
          log(`Could not save cortexHub.hubUrl: ${e instanceof Error ? e.message : String(e)}`)
          toast('Could not save the hub URL to settings. See Output > Cortex Agent.', 'error')
          return
        }
        const scoped = settings.inspect<string>('hubUrl')
        if (scoped?.workspaceValue || scoped?.workspaceFolderValue) {
          void vscode.window.showWarningMessage("Cortex: this workspace's own cortexHub.hubUrl setting still applies in this window.")
        }
      }
      await applyWindowAgent()
      toast(hubUrl ? 'Saved. The hub URL applies to every window on this machine' : 'Saved for this window', 'success')
    }),
  )

  context.subscriptions.push(vscode.commands.registerCommand('cortex.setHubUrl', promptHubUrl))

  // cortex.resetWindow — forget this window's own agent and key; the cortexHub settings apply again
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.resetWindow', async () => {
      const state = context.workspaceState
      const slot = state.get<string>(WINDOW_SLOT)
      if (slot) {
        try {
          await context.secrets.delete(SECRET_PREFIX + slot)
        } catch (e) {
          log(`Could not delete this window's key from the OS keychain: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      await state.update(WINDOW_AGENT_ID, undefined)
      await state.update(WINDOW_CAPABILITIES, undefined)
      await applyWindowAgent()
      toast('This window uses the cortexHub settings again', 'info')
    }),
  )

  // Re-read config on settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('cortexHub')) return
      if (client) {
        // A new hub URL, name or key needs a new connection; anything else is picked up in place.
        log('Config updated from settings')
        await applyWindowAgent(false)
      } else {
        current = await loadConfig()
        updateStatusBar(current.agentId, 'disconnected')
        postAgent(agentPayload(current, 'disconnected', stoppedNote))
      }
    }),
  )

  // Auto-connect on activation
  log(`Config loaded: agentId=${current.agentId} hubUrl=${current.hubUrl} hubSource=${current.hubSource} apiKey=${maskKey(current.apiKey) || 'NONE'} keySource=${current.keySource} autoConnect=${current.autoConnect}`)
  if (current.autoConnect && current.apiKey) {
    log('Auto-connecting to Hub...')
    initClient()
  } else if (!current.apiKey) {
    log('No API key found. Set one for this window in the Agent Panel (pencil icon), set cortexHub.apiKey, or configure MCP; then run "Cortex: Connect to Hub".')
    if (current.hubSource === 'default') {
      hubUrlWarned = true
      log(`No hub URL found either, so the default ${current.hubUrl} applies.`)
      void vscode.window
        .showWarningMessage(
          'Cortex Agent: no hub URL or API key found. Click the pencil in the Agent Panel and paste both from the dashboard.',
          'Open Agent Panel',
        )
        .then((pick) => {
          if (pick === 'Open Agent Panel') void vscode.commands.executeCommand('cortex.showPanel')
        })
    } else {
      vscode.window.showWarningMessage('Cortex Agent: No API key detected. Check Output > Cortex Agent for details.')
    }
  }
}

export function deactivate(): void {
  if (taskLoop) { clearInterval(taskLoop); taskLoop = null }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  if (client) { client.dispose(); client = null }
}
