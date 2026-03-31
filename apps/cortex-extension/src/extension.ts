import * as vscode from 'vscode'
import { getConfig } from './config.js'
import { ConductorClient, type ConnectionState } from './ws-client.js'
import { CortexWebviewProvider, CortexPanel } from './webview/panel.js'
// hub-api.ts no longer needed — all data fetched via WS

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
  const message = { type, payload } as any
  sidebarProvider?.postMessage(message)
  CortexPanel.currentPanel?.postMessage(message)
}

/** Execute a task by sending prompt to IDE's built-in AI (Language Model API) */
async function executeTaskInChat(prompt: string, taskId: string): Promise<void> {
  try {
    // Try VS Code Language Model API (works in VS Code 1.90+, Antigravity, Cursor)
    const output = vscode.window.createOutputChannel('Cortex Agent')
    output.appendLine(`[executeTask] Querying available LM models...`)
    const models = await vscode.lm.selectChatModels()
    output.appendLine(`[executeTask] Found ${models.length} model(s): ${models.map(m => m.id).join(', ')}`)
    if (models.length > 0) {
      const model = models[0]
      output.appendLine(`[executeTask] Using model: ${model.id}`)
      output.appendLine(`[executeTask] Sending prompt (${prompt.length} chars)...`)
      const messages = [vscode.LanguageModelChatMessage.User(prompt)]
      const response = await model.sendRequest(messages)

      let result = ''
      for await (const chunk of response.text) {
        result += chunk
        output.append(chunk)
      }
      output.appendLine(`\n[executeTask] Done — ${result.length} chars response`)

      // Report completion
      client?.completeTask(taskId, result.slice(0, 2000))
      vscode.window.showInformationMessage(`Cortex: Task ${taskId.slice(-8)} completed via ${model.id}`)
      return
    }
    output.appendLine(`[executeTask] No LM models available, falling back to clipboard`)
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e)
    const output = vscode.window.createOutputChannel('Cortex Agent')
    output.appendLine(`[executeTask] LM API error: ${err}`)
  }

  // Fallback: copy prompt to clipboard + open chat panel
  await vscode.env.clipboard.writeText(prompt)
  // Try common chat commands
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open')
  } catch {
    try {
      await vscode.commands.executeCommand('antigravity.openChat')
    } catch {
      // ignore
    }
  }
  vscode.window.showInformationMessage('Cortex: Task prompt copied to clipboard. Paste into AI chat to execute.')
}

/** Request data via WS — server responds with data.response */
function refreshHubData(): void {
  client?.send({ type: 'request.data' })
}

export function activate(context: vscode.ExtensionContext): void {
  const config = getConfig()

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
    })

    // Forward task.assigned to webview
    client.on('task.assigned', (msg: Record<string, unknown>) => {
      const taskId = msg['taskId'] as string
      const title = msg['title'] as string
      const description = (msg['description'] as string) || title
      log(`Task assigned: ${taskId} — ${title}`)

      forwardToWebview('newTask', msg)

      // Auto-accept and execute — no manual intervention needed
      client?.acceptTask(taskId)
      log(`Task auto-accepted: ${taskId}`)
      vscode.window.showInformationMessage(`Cortex: Executing "${title}"`)

      const prompt = `[Cortex Task ${taskId}]\n\n${description}`
      executeTaskInChat(prompt, taskId).catch((e) => {
        log(`Task execution error: ${e instanceof Error ? e.message : String(e)}`)
      })
    })

    // Forward task.completed to webview
    client.on('task.completed', (msg: Record<string, unknown>) => {
      log(`Task completed: ${msg['taskId']} by ${msg['agentId']}`)
      forwardToWebview('taskUpdate', msg)
    })

    // Forward task.progress to webview
    client.on('task.progress', (msg: Record<string, unknown>) => {
      log(`Task progress: ${msg['taskId']} — ${msg['message']} (${msg['percent'] ?? '?'}%)`)
      forwardToWebview('taskUpdate', msg)
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
      sidebarProvider?.postMessage(hubData as any)
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
        sidebarProvider?.postMessage(taskMsg as any)
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
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  if (client) { client.dispose(); client = null }
}
