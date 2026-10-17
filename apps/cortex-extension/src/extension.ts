import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { getConfig, type CortexConfig } from './config.js'
import { maskKey, normaliseAgentId, type WindowAgent } from './identity.js'
import { hubUrlProblem } from './mcp-config.js'
import { ConductorClient, type ConnectionState, type StopReason } from './ws-client.js'
import { CortexWebviewProvider, CortexPanel, type AgentStatus } from './webview/panel.js'
// hub-api.ts no longer needed — all data fetched via WS

// Antigravity SDK — optional, only available in Antigravity IDE
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let antigravitySdk: any = null

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

// Track active tasks waiting for review
const pendingReviews = new Map<string, { taskId: string; plan: string; stopAcceptor: () => void }>()

// Task execution state — prevents hanging when new task arrives after conversation finishes
interface QueuedTask {
  taskId: string
  title: string
  description: string
  rawMsg: Record<string, unknown>
  isSubtask?: boolean
}

let currentTaskId: string | null = null
let conversationDone = false // true when current conversation has finished
const taskQueue: QueuedTask[] = []
let completionMonitorStop: (() => void) | null = null

/** Auto-accept Antigravity steps (file edits, terminal commands) for autonomous task execution */
function startAutoAcceptor(taskId: string, logFn: (msg: string) => void): () => void {
  if (!antigravitySdk) return () => {}

  let running = true
  const poll = async () => {
    while (running) {
      try {
        await antigravitySdk.cascade.acceptStep().catch(() => {})
        await antigravitySdk.cascade.acceptTerminalCommand().catch(() => {})
        await antigravitySdk.cascade.acceptCommand().catch(() => {})
      } catch {
        // no pending steps
      }
      await new Promise(r => setTimeout(r, 1500))
    }
  }

  logFn(`Auto-acceptor started for task ${taskId}`)
  poll()
  return () => { running = false }
}

/** Track session IDs that have already been reviewed to prevent duplicate reviews */
const reviewedSessions = new Set<string>()

/** Monitor Antigravity for plan output, then submit for review before proceeding */
function startPlanMonitor(taskId: string, logFn: (msg: string) => void): () => void {
  if (!antigravitySdk) return () => {}

  let running = true
  let planDetected = false

  const poll = async () => {
    while (running && !planDetected) {
      try {
        // Check if step requires input (plan approval)
        const sessions = await antigravitySdk.cascade.getSessions()
        if (sessions && sessions.length > 0) {
          const latest = sessions[0]
          const sessionKey = `${latest.id ?? latest.title}:${latest.stepCount}`

          // Skip if this session+stepCount combo was already reviewed
          if (reviewedSessions.has(sessionKey)) {
            await new Promise(r => setTimeout(r, 3000))
            continue
          }

          // Detect plan by checking step count changes or title patterns
          if (latest.stepCount > 0 && latest.title) {
            const prevCount = latest.stepCount
            await new Promise(r => setTimeout(r, 5000))
            if (!running) break
            const refreshed = (await antigravitySdk.cascade.getSessions())?.[0]
            if (refreshed && refreshed.stepCount === prevCount && prevCount > 0) {
              // Agent stopped — plan is ready, submit for review
              planDetected = true
              reviewedSessions.add(sessionKey)
              logFn(`Plan detected for task ${taskId} (${prevCount} steps). Submitting for review...`)

              const planSummary = `[Plan Review Request]\nTask: ${taskId}\nAgent: Anti-01\nSteps: ${prevCount}\nSession: ${latest.title}`

              // Create review sub-task for codex-review via WS
              client?.send({
                type: 'task.create',
                title: `[Review] ${latest.title || taskId}`,
                description: planSummary,
                assignTo: 'codex-review',
                parentTaskId: taskId,
                priority: 1,
                context: JSON.stringify({ reviewType: 'plan', originalTaskId: taskId, autoReview: false }),
              })

              // Store pending review so we can proceed when approved
              pendingReviews.set(taskId, {
                taskId,
                plan: planSummary,
                stopAcceptor: () => {},
              })

              logFn(`Review task created for codex-review — waiting for approval`)
            }
          }
        }
      } catch {
        // ignore monitor errors
      }
      await new Promise(r => setTimeout(r, 3000))
    }
  }

  logFn(`Plan monitor started for task ${taskId}`)
  poll()
  return () => { running = false }
}

/** Proceed with plan after reviewer approves — auto-click Proceed via SDK */
async function proceedAfterApproval(taskId: string, logFn: (msg: string) => void): Promise<void> {
  if (!antigravitySdk) return

  logFn(`Review approved for task ${taskId} — auto-proceeding via SDK`)

  try {
    // Accept the plan step (clicks "Proceed")
    await antigravitySdk.cascade.acceptStep()
    logFn(`Plan accepted via SDK for task ${taskId}`)

    // Start auto-acceptor for implementation phase
    const stop = startAutoAcceptor(taskId, logFn)
    const pending = pendingReviews.get(taskId)
    if (pending) {
      pending.stopAcceptor = stop
    }
  } catch (e) {
    logFn(`Failed to proceed: ${e instanceof Error ? e.message : String(e)}`)
    // Fallback: try sendPrompt to continue
    try {
      await antigravitySdk.cascade.sendPrompt('Proceed with the implementation plan.')
      startAutoAcceptor(taskId, logFn)
    } catch {
      logFn(`Fallback sendPrompt also failed`)
    }
  }
}

/** Send reviewer feedback back to Antigravity chat for plan revision */
async function sendReviewFeedback(taskId: string, feedback: string, logFn: (msg: string) => void): Promise<void> {
  if (!antigravitySdk) return

  logFn(`Sending reviewer feedback for task ${taskId}`)
  try {
    await antigravitySdk.cascade.sendPrompt(
      `[Reviewer Feedback]\n\n${feedback}\n\nPlease revise your plan based on this feedback.`
    )
    logFn(`Feedback sent to Antigravity — waiting for revised plan`)
    // Restart plan monitor for the revised plan
    startPlanMonitor(taskId, logFn)
  } catch (e) {
    logFn(`Failed to send feedback: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Monitor Antigravity sessions to detect when a conversation finishes */
function startCompletionMonitor(taskId: string, logFn: (msg: string) => void): () => void {
  if (!antigravitySdk) return () => {}

  let running = true
  let lastStepCount = 0
  let stableChecks = 0

  const poll = async () => {
    while (running) {
      try {
        const sessions = await antigravitySdk.cascade.getSessions()
        if (sessions && sessions.length > 0) {
          const latest = sessions[0]
          const currentSteps = latest.stepCount ?? 0

          if (currentSteps > 0 && currentSteps === lastStepCount) {
            stableChecks++
            // If step count unchanged for ~15s (3 checks x 5s), conversation is likely done
            if (stableChecks >= 3 && !conversationDone) {
              conversationDone = true
              logFn(`Conversation completed for task ${taskId} (stable at ${currentSteps} steps)`)
              // Send task.complete to hub so pipeline can continue
              client?.send({
                type: 'task.complete',
                taskId,
                result: { completedBy: 'extension-auto-detect', steps: currentSteps },
              })
              logFn(`Sent task.complete for ${taskId}`)
              client?.updateStatus('idle')
              // Process next queued task if any
              drainTaskQueue(logFn)
            }
          } else {
            stableChecks = 0
            lastStepCount = currentSteps
          }
        }
      } catch {
        // ignore monitor errors
      }
      await new Promise(r => setTimeout(r, 5000))
    }
  }

  logFn(`Completion monitor started for task ${taskId}`)
  poll()
  return () => { running = false }
}

/** Idle watchdog — if agent is idle with tasks in queue, auto-drain */
let idleWatchdog: ReturnType<typeof setInterval> | null = null

function startIdleWatchdog(logFn: (msg: string) => void): void {
  if (idleWatchdog) return
  idleWatchdog = setInterval(() => {
    // If conversation is done (or no active task) and queue has items, drain
    if ((conversationDone || !currentTaskId) && taskQueue.length > 0) {
      logFn(`Idle watchdog: conversation done=${conversationDone}, queue=${taskQueue.length} — draining`)
      drainTaskQueue(logFn)
    }
    // Also check: if current task is completed on server but extension didn't notice
    if (currentTaskId && !conversationDone && taskQueue.length > 0) {
      // Check via Antigravity SDK if conversation is idle
      if (antigravitySdk) {
        antigravitySdk.cascade.getSessions().then((sessions: { stepCount: number }[]) => {
          if (!sessions || sessions.length === 0) return
          const latest = sessions[0]
          // If agent hasn't produced new steps in the check interval, consider done
          if (latest && latest.stepCount > 0 && lastDetectedStepCount === latest.stepCount) {
            idleCheckCount++
            if (idleCheckCount >= 2) { // 2 checks × 10s = 20s idle
              logFn(`Idle watchdog: agent idle for 20s (steps stable at ${latest.stepCount}) — completing task ${currentTaskId}`)
              // Send task.complete and drain
              client?.send({ type: 'task.complete', taskId: currentTaskId, result: { completedBy: 'idle-watchdog' } })
              conversationDone = true
              if (completionMonitorStop) { completionMonitorStop(); completionMonitorStop = null }
              client?.updateStatus('idle')
              drainTaskQueue(logFn)
            }
          } else {
            lastDetectedStepCount = latest?.stepCount ?? 0
            idleCheckCount = 0
          }
        }).catch(() => {})
      }
    }
  }, 10000)
}

let lastDetectedStepCount = 0
let idleCheckCount = 0

/** Process next task in the queue — starts a fresh conversation */
function drainTaskQueue(logFn: (msg: string) => void): void {
  if (taskQueue.length === 0) {
    logFn('Task queue empty — agent idle')
    currentTaskId = null
    return
  }

  // Reset idle detection for new task
  lastDetectedStepCount = 0
  idleCheckCount = 0

  const next = taskQueue.shift()!
  logFn(`Draining queue — starting task ${next.taskId}: ${next.title}`)
  vscode.window.showInformationMessage(`Cortex: Starting next task "${next.title}"`)

  const prompt = `[Cortex Task ${next.taskId}]\n\n${next.description}`
  // Always create new conversation for queued tasks
  executeTaskInChat(prompt, next.taskId, logFn, true, next.isSubtask).catch((e) => {
    logFn(`Queued task execution error: ${e instanceof Error ? e.message : String(e)}`)
  })
}

/** Execute a task by injecting prompt into IDE's AI chat.
 *  @param forceNewConversation — if true, always create a new cascade/chat instead of sending to existing
 *  @param isSubtask — if true, skip plan monitor (subtasks don't need review) */
async function executeTaskInChat(prompt: string, taskId: string, logFn: (msg: string) => void, forceNewConversation = false, isSubtask = false): Promise<void> {
  logFn(`Executing task ${taskId} via IDE chat... (newConversation=${forceNewConversation}, subtask=${isSubtask})`)

  // Update tracking state
  currentTaskId = taskId
  conversationDone = false
  if (completionMonitorStop) { completionMonitorStop(); completionMonitorStop = null }
  client?.updateStatus('busy')

  // Strategy 1: Antigravity SDK — direct prompt injection via Language Server
  if (antigravitySdk) {
    // If forcing new conversation (previous one is done), always use createCascade
    if (forceNewConversation) {
      try {
        const cascadeId = await antigravitySdk.ls.createCascade({ text: prompt })
        const focusOnAssign = vscode.workspace.getConfiguration('cortexHub').get<boolean>('focusOnAssign', false)
        if (focusOnAssign) {
          await antigravitySdk.ls.focusCascade(cascadeId)
        }
        logFn(`New conversation created via createCascade — cascade ${cascadeId}`)
        // Only monitor plans for top-level tasks — subtasks execute directly
        if (!isSubtask) startPlanMonitor(taskId, logFn)
        completionMonitorStop = startCompletionMonitor(taskId, logFn)
        return
      } catch (e) {
        logFn(`createCascade failed: ${e instanceof Error ? e.message : String(e)}`)
        // Fall through to sendPrompt
      }
    }

    try {
      await antigravitySdk.cascade.sendPrompt(prompt)
      logFn(`Task prompt sent via Antigravity SDK (cascade.sendPrompt)`)
      if (!isSubtask) startPlanMonitor(taskId, logFn)
      completionMonitorStop = startCompletionMonitor(taskId, logFn)
      return
    } catch (e) {
      logFn(`Antigravity SDK sendPrompt failed: ${e instanceof Error ? e.message : String(e)}`)
      try {
        const cascadeId = await antigravitySdk.ls.createCascade({ text: prompt })
        const focusOnAssign = vscode.workspace.getConfiguration('cortexHub').get<boolean>('focusOnAssign', false)
        if (focusOnAssign) {
          await antigravitySdk.ls.focusCascade(cascadeId)
        }
        logFn(`Task prompt sent via Antigravity SDK (ls.createCascade) — cascade ${cascadeId}`)
        if (!isSubtask) startPlanMonitor(taskId, logFn)
        completionMonitorStop = startCompletionMonitor(taskId, logFn)
        return
      } catch (e2) {
        logFn(`Antigravity SDK createCascade failed: ${e2 instanceof Error ? e2.message : String(e2)}`)
      }
    }
  }

  // Strategy 2: VS Code chat commands
  const chatCommands = ['workbench.action.chat.open', 'agent.openChat']
  for (const cmd of chatCommands) {
    try {
      await vscode.commands.executeCommand(cmd, { query: prompt, isPartialQuery: false })
      logFn(`Task prompt sent via ${cmd}`)
      return
    } catch {
      // Try next
    }
  }

  // Strategy 3: Clipboard fallback
  logFn('All chat injection methods failed, using clipboard fallback')
  await vscode.env.clipboard.writeText(prompt)
  try { await vscode.commands.executeCommand('workbench.action.chat.open') } catch { /* ignore */ }
  vscode.window.showInformationMessage('Cortex: Task prompt copied — paste into AI chat (Cmd+V)')
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

  // Initialize Antigravity SDK if running in Antigravity IDE
  if (current.ide === 'antigravity') {
    try {
      // Dynamic import — antigravity-sdk is optional peer dependency
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
      const { AntigravitySDK } = require('antigravity-sdk') as { AntigravitySDK: any }
      const sdk = new AntigravitySDK(context)
      sdk.initialize().then(() => {
        antigravitySdk = sdk
        context.subscriptions.push(sdk)
        vscode.window.showInformationMessage('Cortex: Antigravity SDK initialized — auto-prompt enabled')
      }).catch((err: Error) => {
        // SDK not available — fall back to command-based approach
        const out = vscode.window.createOutputChannel('Cortex Agent')
        out.appendLine(`[Antigravity SDK] Init failed: ${err.message}`)
      })
    } catch {
      // antigravity-sdk not installed — silent fallback
    }
  }

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
      startIdleWatchdog(log)
    })

    // Forward task.assigned to webview
    client.on('task.assigned', (msg: Record<string, unknown>) => {
      const taskId = msg['taskId'] as string
      const title = msg['title'] as string
      const description = (msg['description'] as string) || title
      log(`Task assigned: ${taskId} — ${title}`)

      forwardToWebview('newTask', msg)

      // Skip review/sub-tasks to prevent recursive loop
      const titleLower = title.toLowerCase()
      const isReviewLike = titleLower.includes('review') || titleLower.includes('plan review')
      if (isReviewLike) {
        log(`Skipping review task ${taskId} — not executing to prevent loop`)
        client?.acceptTask(taskId)
        // Complete immediately with acknowledgment
        client?.send({ type: 'task.complete', taskId, result: { skipped: true, reason: 'Review tasks handled by dedicated reviewer agent' } })
        return
      }

      // Auto-accept always
      client?.acceptTask(taskId)
      log(`Task auto-accepted: ${taskId}`)

      // Detect subtasks — they have Role/Parent in description or parentTaskId in msg
      const isSubtask = !!(msg['parentTaskId'] || description.includes('Parent task:') || description.includes('Role:'))

      // If agent is busy with an active task — always queue (never interrupt)
      if (currentTaskId && !conversationDone) {
        taskQueue.push({ taskId, title, description, rawMsg: msg, isSubtask })
        log(`Agent busy (task ${currentTaskId}) — queued task ${taskId} (queue size: ${taskQueue.length})`)
        vscode.window.showInformationMessage(`Cortex: Task "${title}" queued (${taskQueue.length} in queue)`)
        return
      }

      const needsNewConversation = conversationDone && currentTaskId !== null
      if (needsNewConversation) {
        log(`Previous conversation done — starting fresh for task ${taskId}`)
      }
      vscode.window.showInformationMessage(`Cortex: Executing "${title}"`)

      const prompt = `[Cortex Task ${taskId}]\n\n${description}`
      executeTaskInChat(prompt, taskId, log, needsNewConversation, isSubtask).catch((e) => {
        log(`Task execution error: ${e instanceof Error ? e.message : String(e)}`)
      })
    })

    // Forward task.completed to webview + handle review approvals + drain queue
    client.on('task.completed', (msg: Record<string, unknown>) => {
      const completedTaskId = msg['taskId'] as string
      const completedBy = msg['agentId'] as string
      const result = msg['result'] as Record<string, unknown> | undefined
      log(`Task completed: ${completedTaskId} by ${completedBy}`)
      forwardToWebview('taskUpdate', msg)

      // If our current task was completed (e.g. server marked it done), drain queue
      if (completedTaskId === currentTaskId) {
        log(`Current task ${completedTaskId} completed — marking conversation done`)
        conversationDone = true
        if (completionMonitorStop) { completionMonitorStop(); completionMonitorStop = null }
        client?.updateStatus('idle')
        drainTaskQueue(log)
      }

      // Check if this is a review task completion → approve/reject the parent
      const parentTaskId = (msg['parentTaskId'] as string) ?? (result?.['originalTaskId'] as string)
      const reviewResult = (result?.['verdict'] as string) ?? (result?.['status'] as string) ?? 'approved'
      const feedback = (result?.['feedback'] as string) ?? (result?.['message'] as string) ?? ''

      if (parentTaskId && pendingReviews.has(parentTaskId)) {
        if (reviewResult === 'approved' || reviewResult === 'approve') {
          log(`Review APPROVED for task ${parentTaskId} by ${completedBy}`)
          vscode.window.showInformationMessage(`Cortex: Review approved by ${completedBy} — proceeding with plan`)
          proceedAfterApproval(parentTaskId, log)
          pendingReviews.delete(parentTaskId)
        } else {
          log(`Review REJECTED for task ${parentTaskId}: ${feedback}`)
          vscode.window.showWarningMessage(`Cortex: Review rejected by ${completedBy} — sending feedback`)
          sendReviewFeedback(parentTaskId, feedback || 'Reviewer requested changes. Please revise.', log)
        }
      }
    })

    // Forward task.progress to webview + handle review feedback
    client.on('task.progress', (msg: Record<string, unknown>) => {
      log(`Task progress: ${msg['taskId']} — ${msg['message']} (${msg['percent'] ?? '?'}%)`)
      forwardToWebview('taskUpdate', msg)

      // Check for review feedback mid-progress (reviewer sends inline feedback)
      const progressMsg = msg['message'] as string
      const parentTaskId = msg['parentTaskId'] as string
      if (parentTaskId && pendingReviews.has(parentTaskId) && progressMsg?.includes('[feedback]')) {
        const feedback = progressMsg.replace('[feedback]', '').trim()
        log(`Inline review feedback for ${parentTaskId}: ${feedback}`)
        sendReviewFeedback(parentTaskId, feedback, log)
      }
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
  if (completionMonitorStop) { completionMonitorStop(); completionMonitorStop = null }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  if (client) { client.dispose(); client = null }
}
