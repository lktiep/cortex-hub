import * as vscode from 'vscode';

interface AgentStatus {
  agentId: string;
  capabilities: string[];
  connectionStatus: 'connected' | 'disconnected' | 'connecting' | 'reconnecting';
  uptime: number;
}

interface Task {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  assignedAgent: string;
  createdBy: string;
  assignedTo: string;
  createdAt: string;
  parentId?: string;
}

interface Stats {
  tasksCompleted: number;
  averageTime: number;
  successRate: number;
}

type WebviewMessage =
  | { type: 'updateAgent'; payload: AgentStatus }
  | { type: 'updateTasks'; payload: Task[] }
  | { type: 'updateStats'; payload: Stats }
  | { type: 'newTask'; payload: Task }
  | { type: 'taskUpdate'; payload: Task }
  | { type: 'toast'; payload: { message: string; level: 'info' | 'success' | 'warning' | 'error' } };

type ExtensionMessage =
  | { type: 'refreshTasks' }
  | { type: 'webviewReady' }
  | { type: 'pickupTask'; taskId: string }
  | { type: 'viewTask'; taskId: string }
  | { type: 'renameAgent'; newName: string }
  | { type: 'updateCapabilities'; capabilities: string[] };

/** Build HTML for the webview (shared between sidebar + panel) */
function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'media', 'styles.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'media', 'main.js'));
  const nonce = getNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${styleUri}">
<title>Cortex Agent</title>
</head>
<body>
<section class="card agent-card" id="agent-status">
  <div class="card-header"><h2>Agent Status</h2><div class="card-header-actions"><button class="icon-btn edit-toggle" id="edit-toggle" title="Edit agent">&#x270E;</button><span class="connection-dot" id="connection-dot"></span></div></div>
  <div class="agent-info">
    <div class="agent-id">
      <span class="label">Agent</span>
      <span class="value" id="agent-id">--</span>
      <input class="edit-input agent-name-input" id="agent-name-input" type="text" placeholder="Agent name" style="display:none" />
    </div>
    <div class="agent-uptime"><span class="label">Uptime</span><span class="value mono" id="agent-uptime">0s</span></div>
  </div>
  <div class="capabilities" id="capabilities"></div>
  <div class="capability-add" id="capability-add" style="display:none">
    <select class="cap-select" id="cap-select">
      <option value="">+ Add capability</option>
      <option value="plan">plan</option>
      <option value="orchestrate">orchestrate</option>
      <option value="backend">backend</option>
      <option value="frontend">frontend</option>
      <option value="design">design</option>
      <option value="review">review</option>
      <option value="database">database</option>
      <option value="devops">devops</option>
      <option value="security">security</option>
      <option value="testing">testing</option>
      <option value="docker">docker</option>
      <option value="deploy">deploy</option>
    </select>
  </div>
  <div class="edit-actions" id="edit-actions" style="display:none">
    <button class="btn-save" id="edit-save">Save</button>
    <button class="btn-cancel" id="edit-cancel">Cancel</button>
  </div>
  <div class="connection-status" id="connection-status">Disconnected</div>
</section>
<section class="card stats-card" id="stats-section">
  <div class="card-header"><h2>Performance</h2></div>
  <div class="stats-grid">
    <div class="stat"><span class="stat-value counter" id="stat-completed" data-target="0">0</span><span class="stat-label">Completed</span></div>
    <div class="stat"><span class="stat-value counter" id="stat-avg-time" data-target="0">0s</span><span class="stat-label">Avg Time</span></div>
    <div class="stat"><span class="stat-value counter" id="stat-success" data-target="0">0%</span><span class="stat-label">Success</span></div>
  </div>
</section>
<section class="card pipeline-card" id="pipeline-section">
  <div class="card-header"><h2>Pipeline</h2></div>
  <div class="pipeline-tree" id="pipeline-tree"><div class="empty-state">No active pipelines</div></div>
</section>
<section class="card tasks-card" id="task-feed">
  <div class="card-header"><h2>Task Feed</h2><button class="icon-btn" id="refresh-tasks" title="Refresh">&#x21bb;</button></div>
  <div class="task-list" id="task-list"><div class="empty-state">No tasks yet</div></div>
</section>
<div class="toast-container" id="toast-container"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export class CortexWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cortex.agentPanel';

  private view?: vscode.WebviewView;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'media'),
      ],
    };

    webviewView.webview.html = buildWebviewHtml(webviewView.webview, this.extensionUri);

    webviewView.webview.onDidReceiveMessage((message: ExtensionMessage) => {
      this.handleMessage(message);
    });
  }

  public postMessage(message: WebviewMessage): void {
    this.view?.webview.postMessage(message);
  }

  private handleMessage(message: ExtensionMessage): void {
    switch (message.type) {
      case 'refreshTasks':
      case 'webviewReady':
        vscode.commands.executeCommand('cortex.refreshData');
        break;
      case 'pickupTask':
        vscode.commands.executeCommand('cortex.pickupTask', message.taskId);
        break;
      case 'viewTask':
        vscode.commands.executeCommand('cortex.viewTask', message.taskId);
        break;
      case 'renameAgent':
        vscode.commands.executeCommand('cortex.renameAgent', message.newName);
        break;
      case 'updateCapabilities':
        vscode.commands.executeCommand('cortex.updateCapabilities', message.capabilities);
        break;
    }
  }
}

/** Panel variant — opens as a full editor tab instead of sidebar */
export class CortexPanel {
  public static currentPanel: CortexPanel | undefined;
  private static readonly viewType = 'cortex.panel';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.update();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: ExtensionMessage) => this.handleMessage(message),
      null,
      this.disposables
    );
  }

  public static createOrShow(extensionUri: vscode.Uri): CortexPanel {
    const column = vscode.ViewColumn.Beside;

    if (CortexPanel.currentPanel) {
      CortexPanel.currentPanel.panel.reveal(column);
      return CortexPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      CortexPanel.viewType,
      'Cortex Agent',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'media'),
        ],
      }
    );

    CortexPanel.currentPanel = new CortexPanel(panel, extensionUri);
    return CortexPanel.currentPanel;
  }

  public postMessage(message: WebviewMessage): void {
    this.panel.webview.postMessage(message);
  }

  private handleMessage(message: ExtensionMessage): void {
    switch (message.type) {
      case 'refreshTasks':
      case 'webviewReady':
        vscode.commands.executeCommand('cortex.refreshData');
        break;
      case 'pickupTask':
        vscode.commands.executeCommand('cortex.pickupTask', message.taskId);
        break;
      case 'viewTask':
        vscode.commands.executeCommand('cortex.viewTask', message.taskId);
        break;
      case 'renameAgent':
        vscode.commands.executeCommand('cortex.renameAgent', message.newName);
        break;
      case 'updateCapabilities':
        vscode.commands.executeCommand('cortex.updateCapabilities', message.capabilities);
        break;
    }
  }

  private update(): void {
    const webview = this.panel.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'media'),
      ],
    };

    webview.html = buildWebviewHtml(webview, this.extensionUri);
  }

  private dispose(): void {
    CortexPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
