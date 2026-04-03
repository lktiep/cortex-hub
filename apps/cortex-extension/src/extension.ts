import * as vscode from 'vscode'
import { getConfig } from './config.js'
import { ConductorClient, type ConnectionState } from './ws-client.js'
import { CortexWebviewProvider, CortexPanel } from './webview/panel.js'
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
        await antigravitySdk.ls.focusCascade(cascadeId)
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
        await antigravitySdk.ls.focusCascade(cascadeId)
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

export function activate(context: vscode.ExtensionContext): void {
  const config = getConfig()

  // Initialize Antigravity SDK if running in Antigravity IDE
  if (config.ide === 'antigravity') {
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
  updateStatusBar(config.agentId, 'disconnected')
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

  // Output channel for logs
  const output = vscode.window.createOutputChannel('Cortex Agent')
  context.subscriptions.push(output)

  function log(msg: string): void {
    output.appendLine(`[${new Date().toISOString()}] ${msg}`)
  }

  // Initialize WsClient with config on activation
  function initClient(cfg: ReturnType<typeof getConfig>): void {
    if (client) {
      client.dispose()
    }

    client = new ConductorClient(cfg)

    client.on('stateChange', (state: ConnectionState) => {
      updateStatusBar(cfg.agentId, state)
      log(`Connection state: ${state}`)
    })

    client.on('connected', () => {
      vscode.window.showInformationMessage(`Cortex: Connected as ${cfg.agentId}`)
      // Push agent status to webview
      const agentStatus = {
        type: 'updateAgent' as const,
        payload: {
          agentId: cfg.agentId,
          capabilities: cfg.capabilities,
          connectionStatus: 'connected' as const,
          uptime: 0,
        },
      }
      sidebarProvider?.postMessage(agentStatus)
      CortexPanel.currentPanel?.postMessage(agentStatus)

      // Fetch and push Hub data
      refreshHubData()
      // Refresh every 15s
      if (refreshTimer) clearInterval(refreshTimer)
      refreshTimer = setInterval(() => refreshHubData(), 15000)
    })

    client.on('disconnected', (code: number, reason: string) => {
      log(`Disconnected: code=${code} reason=${reason}`)
      const msg = {
        type: 'updateAgent' as const,
        payload: { agentId: cfg.agentId, capabilities: cfg.capabilities, connectionStatus: 'disconnected' as const, uptime: 0 },
      }
      sidebarProvider?.postMessage(msg)
      CortexPanel.currentPanel?.postMessage(msg)
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
    vscode.commands.registerCommand('cortex.connect', () => {
      const cfg = getConfig()
      if (!cfg.apiKey) {
        vscode.window.showErrorMessage(
          'Cortex: No API key found. Set cortex.apiKey in settings or CORTEX_API_KEY env variable.',
        )
        return
      }
      initClient(cfg)
    }),
  )

  // Disconnect command
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.disconnect', () => {
      if (client) {
        client.dispose()
        client = null
        updateStatusBar(config.agentId, 'disconnected')
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
      const cfg = getConfig()
      vscode.window.showInformationMessage(
        `Cortex: ${client.state} | Agent: ${cfg.agentId} | Capabilities: ${cfg.capabilities.join(', ')}`,
      )
    }),
  )

  // Refresh data command — triggered by webview on ready or refresh button
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.refreshData', () => {
      const cfg = getConfig()
      // Push current agent status
      const state = client?.state ?? 'disconnected'
      const agentMsg = {
        type: 'updateAgent' as const,
        payload: { agentId: cfg.agentId, capabilities: cfg.capabilities, connectionStatus: state, uptime: 0 },
      }
      sidebarProvider?.postMessage(agentMsg)
      CortexPanel.currentPanel?.postMessage(agentMsg)
      // Fetch hub data
      if (cfg.apiKey) refreshHubData()
    }),
  )

  // cortex.showPanel command — opens CortexPanel in an editor tab
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.showPanel', () => {
      CortexPanel.createOrShow(context.extensionUri)
    }),
  )

  // cortex.renameAgent — update agentId setting, reconnect WS with new name
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.renameAgent', async (newName: string) => {
      if (!newName || typeof newName !== 'string') return
      const settings = vscode.workspace.getConfiguration('cortexHub')
      await settings.update('agentId', newName, vscode.ConfigurationTarget.Global)
      log(`Agent renamed to: ${newName}`)

      // Reconnect WS with updated config so server sees new identity
      if (client) {
        const cfg = getConfig()
        client.updateConfig(cfg)
        client.reconnect()
        updateStatusBar(cfg.agentId, 'connecting')
      }

      vscode.window.showInformationMessage(`Cortex: Agent renamed to "${newName}"`)
    }),
  )

  // cortex.updateCapabilities — update capabilities setting, send via WS
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.updateCapabilities', async (capabilities: string[]) => {
      if (!Array.isArray(capabilities)) return
      const settings = vscode.workspace.getConfiguration('cortexHub')
      await settings.update('capabilities', capabilities, vscode.ConfigurationTarget.Global)
      log(`Capabilities updated: ${capabilities.join(', ')}`)

      // Send capabilities update over existing WS connection
      if (client) {
        const cfg = getConfig()
        client.updateConfig(cfg)
        client.sendCapabilitiesUpdate(capabilities)

        // Update webview with new agent status
        const agentMsg = {
          type: 'updateAgent' as const,
          payload: { agentId: cfg.agentId, capabilities, connectionStatus: client.state, uptime: 0 },
        }
        sidebarProvider?.postMessage(agentMsg)
        CortexPanel.currentPanel?.postMessage(agentMsg)
      }
    }),
  )

  // Re-read config on settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cortex')) {
        const cfg = getConfig()
        if (client) {
          client.updateConfig(cfg)
          log('Config updated from settings')
        }
        updateStatusBar(cfg.agentId, client?.state ?? 'disconnected')
      }
    }),
  )

  // Auto-connect on activation
  log(`Config loaded: agentId=${config.agentId} hubUrl=${config.hubUrl} apiKey=${config.apiKey ? '***' + config.apiKey.slice(-8) : 'NONE'} autoConnect=${config.autoConnect}`)
  if (config.autoConnect && config.apiKey) {
    log('Auto-connecting to Hub...')
    initClient(config)
  } else if (!config.apiKey) {
    log('No API key found. Run "Cortex: Connect to Hub" after setting cortexHub.apiKey or configuring MCP.')
    vscode.window.showWarningMessage('Cortex Agent: No API key detected. Check Output > Cortex Agent for details.')
  }
}

export function deactivate(): void {
  if (completionMonitorStop) { completionMonitorStop(); completionMonitorStop = null }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  if (client) { client.dispose(); client = null }
}
