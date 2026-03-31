// @ts-check
/// <reference lib="dom" />

/** @type {ReturnType<typeof acquireVsCodeApi>} */
const vscode = acquireVsCodeApi();

// ── State ──────────────────────────────────────────────────────────────────
/** @type {Map<string, any>} */
const taskMap = new Map();
let editMode = false;
/** @type {string[]} */
let currentCapabilities = [];
/** @type {string} */
let currentAgentId = '--';

// ── DOM Refs ───────────────────────────────────────────────────────────────
const dom = {
  agentId: /** @type {HTMLElement} */ (document.getElementById('agent-id')),
  agentUptime: /** @type {HTMLElement} */ (document.getElementById('agent-uptime')),
  capabilities: /** @type {HTMLElement} */ (document.getElementById('capabilities')),
  connectionDot: /** @type {HTMLElement} */ (document.getElementById('connection-dot')),
  connectionStatus: /** @type {HTMLElement} */ (document.getElementById('connection-status')),
  statCompleted: /** @type {HTMLElement} */ (document.getElementById('stat-completed')),
  statAvgTime: /** @type {HTMLElement} */ (document.getElementById('stat-avg-time')),
  statSuccess: /** @type {HTMLElement} */ (document.getElementById('stat-success')),
  taskList: /** @type {HTMLElement} */ (document.getElementById('task-list')),
  pipelineTree: /** @type {HTMLElement} */ (document.getElementById('pipeline-tree')),
  refreshBtn: /** @type {HTMLElement} */ (document.getElementById('refresh-tasks')),
  toastContainer: /** @type {HTMLElement} */ (document.getElementById('toast-container')),
  editToggle: /** @type {HTMLElement} */ (document.getElementById('edit-toggle')),
  agentNameInput: /** @type {HTMLInputElement} */ (document.getElementById('agent-name-input')),
  capabilityAdd: /** @type {HTMLElement} */ (document.getElementById('capability-add')),
  capSelect: /** @type {HTMLSelectElement} */ (document.getElementById('cap-select')),
  editActions: /** @type {HTMLElement} */ (document.getElementById('edit-actions')),
  editSave: /** @type {HTMLElement} */ (document.getElementById('edit-save')),
  editCancel: /** @type {HTMLElement} */ (document.getElementById('edit-cancel')),
};

// ── Message Handler ────────────────────────────────────────────────────────
window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'updateAgent':
      renderAgent(message.payload);
      break;
    case 'updateTasks':
      renderTaskList(message.payload);
      break;
    case 'updateStats':
      renderStats(message.payload);
      break;
    case 'newTask':
      addTask(message.payload);
      showToast(`New task: ${message.payload.title}`, 'info');
      break;
    case 'taskUpdate':
      updateTask(message.payload);
      break;
    case 'toast':
      showToast(message.payload.message, message.payload.level);
      break;
  }
});

// ── Agent Status ───────────────────────────────────────────────────────────
/**
 * @param {{ agentId: string; capabilities: string[]; connectionStatus: string; uptime: number }} agent
 */
function renderAgent(agent) {
  currentAgentId = agent.agentId;
  currentCapabilities = [...agent.capabilities];

  dom.agentId.textContent = agent.agentId;
  dom.agentUptime.textContent = formatUptime(agent.uptime);

  // Connection dot
  dom.connectionDot.className = 'connection-dot ' + agent.connectionStatus;
  dom.connectionStatus.textContent = capitalize(agent.connectionStatus);
  dom.connectionStatus.className = 'connection-status ' + agent.connectionStatus;

  renderCapabilityBadges();
}

function renderCapabilityBadges() {
  dom.capabilities.innerHTML = '';
  for (const cap of currentCapabilities) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = cap;

    if (editMode) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'badge-remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.title = 'Remove ' + cap;
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        currentCapabilities = currentCapabilities.filter((c) => c !== cap);
        renderCapabilityBadges();
      });
      badge.appendChild(removeBtn);
      badge.classList.add('badge-editable');
    }

    dom.capabilities.appendChild(badge);
  }
}

/** @param {number} seconds */
function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/** @param {string} s */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Stats with Animated Counters ───────────────────────────────────────────
/**
 * @param {{ tasksCompleted: number; averageTime: number; successRate: number }} stats
 */
function renderStats(stats) {
  animateCounter(dom.statCompleted, stats.tasksCompleted, '', 0);
  animateCounter(dom.statAvgTime, stats.averageTime, 's', 1);
  animateCounter(dom.statSuccess, stats.successRate, '%', 1);
}

/**
 * @param {HTMLElement} el
 * @param {number} target
 * @param {string} suffix
 * @param {number} decimals
 */
function animateCounter(el, target, suffix, decimals) {
  const current = parseFloat(el.textContent || '0');
  const duration = 800;
  const startTime = performance.now();

  function tick(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = current + (target - current) * eased;

    el.textContent = (decimals > 0 ? value.toFixed(decimals) : Math.round(value).toString()) + suffix;

    if (progress < 1) {
      requestAnimationFrame(tick);
    }
  }

  requestAnimationFrame(tick);
}

// ── Task Feed ──────────────────────────────────────────────────────────────
const STATUS_CLASSES = {
  pending: 'status-pending',
  in_progress: 'status-in-progress',
  completed: 'status-completed',
  failed: 'status-failed',
};

/**
 * @param {Array<{id: string; title: string; status: string; assignedAgent: string; createdBy: string; assignedTo: string; createdAt: string; parentId?: string}>} tasks
 */
function renderTaskList(tasks) {
  taskMap.clear();
  dom.taskList.innerHTML = '';

  if (!tasks.length) {
    dom.taskList.innerHTML = '<div class="empty-state">No tasks yet</div>';
    renderPipeline(tasks);
    return;
  }

  for (const task of tasks) {
    taskMap.set(task.id, task);
    dom.taskList.appendChild(createTaskEl(task));
  }

  // Stagger animation
  const items = dom.taskList.querySelectorAll('.task-item');
  items.forEach((item, i) => {
    /** @type {HTMLElement} */ (item).style.animationDelay = `${i * 60}ms`;
  });

  renderPipeline(tasks);
}

/**
 * @param {{ id: string; title: string; status: string; assignedAgent: string; createdBy: string; assignedTo: string }} task
 * @returns {HTMLElement}
 */
function createTaskEl(task) {
  const el = document.createElement('div');
  el.className = 'task-item fade-in';
  el.dataset.taskId = task.id;

  el.innerHTML = `
    <div class="task-header">
      <span class="task-title">${escapeHtml(task.title)}</span>
      <span class="status-badge ${STATUS_CLASSES[task.status] || ''}">${escapeHtml(task.status.replace('_', ' '))}</span>
    </div>
    <div class="task-meta">
      <span class="task-agent">${escapeHtml(task.assignedAgent)}</span>
      <span class="task-flow">${escapeHtml(task.createdBy)} &rarr; ${escapeHtml(task.assignedTo)}</span>
    </div>
  `;

  el.addEventListener('click', () => {
    vscode.postMessage({ type: 'viewTask', taskId: task.id });
  });

  return el;
}

/** @param {any} task */
function addTask(task) {
  taskMap.set(task.id, task);

  // Remove empty state
  const empty = dom.taskList.querySelector('.empty-state');
  if (empty) empty.remove();

  const el = createTaskEl(task);
  el.classList.add('slide-in');
  dom.taskList.prepend(el);

  renderPipeline(Array.from(taskMap.values()));
}

/** @param {any} task */
function updateTask(task) {
  taskMap.set(task.id, task);

  const existing = dom.taskList.querySelector(`[data-task-id="${task.id}"]`);
  if (existing) {
    const newEl = createTaskEl(task);
    newEl.classList.add('flash');
    existing.replaceWith(newEl);
  }

  renderPipeline(Array.from(taskMap.values()));
}

// ── Mini Pipeline View ─────────────────────────────────────────────────────
/**
 * @param {Array<{id: string; title: string; status: string; parentId?: string}>} tasks
 */
function renderPipeline(tasks) {
  dom.pipelineTree.innerHTML = '';

  // Find root tasks (no parent)
  const roots = tasks.filter((t) => !t.parentId);
  const childMap = new Map();

  for (const task of tasks) {
    if (task.parentId) {
      if (!childMap.has(task.parentId)) childMap.set(task.parentId, []);
      childMap.get(task.parentId).push(task);
    }
  }

  if (!roots.length) {
    dom.pipelineTree.innerHTML = '<div class="empty-state">No active pipelines</div>';
    return;
  }

  for (const root of roots) {
    const node = createPipelineNode(root, childMap);
    dom.pipelineTree.appendChild(node);
  }
}

/**
 * @param {any} task
 * @param {Map<string, any[]>} childMap
 * @returns {HTMLElement}
 */
function createPipelineNode(task, childMap) {
  const node = document.createElement('div');
  node.className = 'pipeline-node';

  const dot = document.createElement('span');
  dot.className = `pipeline-dot ${STATUS_CLASSES[task.status] || ''}`;

  const label = document.createElement('span');
  label.className = 'pipeline-label';
  label.textContent = task.title;

  const row = document.createElement('div');
  row.className = 'pipeline-row';
  row.appendChild(dot);
  row.appendChild(label);
  node.appendChild(row);

  const children = childMap.get(task.id);
  if (children && children.length) {
    const subtree = document.createElement('div');
    subtree.className = 'pipeline-subtree';
    for (const child of children) {
      subtree.appendChild(createPipelineNode(child, childMap));
    }
    node.appendChild(subtree);
  }

  return node;
}

// ── Toast Notifications ────────────────────────────────────────────────────
/**
 * @param {string} message
 * @param {'info' | 'success' | 'warning' | 'error'} level
 */
function showToast(message, level) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${level} slide-in`;
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove());
  }, 4000);
}

// ── Helpers ────────────────────────────────────────────────────────────────
/** @param {string} str */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Handle hubData (overview + tasks + sessions) ──────────────────────────
window.addEventListener('message', (event) => {
  if (event.data.type === 'hubData') {
    const { taskStats, tasks, quality } = event.data.payload;
    // Performance stats
    if (taskStats) {
      const total = taskStats.completed + taskStats.failed;
      const successRate = total > 0 ? Math.round((taskStats.completed / total) * 100) : 0;
      renderStats({
        tasksCompleted: taskStats.completed || 0,
        averageTime: quality?.avgScore || 0,
        successRate: successRate,
      });
    }
    // Tasks → task feed + pipeline
    if (tasks && tasks.length) {
      renderTaskList(tasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        assignedAgent: t.assigned_to_agent || 'any',
        createdBy: t.created_by_agent || 'unknown',
        assignedTo: t.assigned_to_agent || 'unassigned',
        createdAt: t.created_at,
        parentId: t.parent_task_id || undefined,
      })));
    }
  }
});

// ── Event Listeners ────────────────────────────────────────────────────────
dom.refreshBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'refreshTasks' });
  dom.refreshBtn.classList.add('spin');
  setTimeout(() => dom.refreshBtn.classList.remove('spin'), 600);
});

// ── Edit Mode ─────────────────────────────────────────────────────────────
function enterEditMode() {
  editMode = true;
  dom.agentId.style.display = 'none';
  dom.agentNameInput.style.display = '';
  dom.agentNameInput.value = currentAgentId;
  dom.capabilityAdd.style.display = '';
  dom.editActions.style.display = '';
  dom.editToggle.classList.add('active');
  renderCapabilityBadges();
  dom.agentNameInput.focus();
}

function exitEditMode() {
  editMode = false;
  dom.agentId.style.display = '';
  dom.agentNameInput.style.display = 'none';
  dom.capabilityAdd.style.display = 'none';
  dom.editActions.style.display = 'none';
  dom.editToggle.classList.remove('active');
  dom.capSelect.value = '';
  renderCapabilityBadges();
}

function saveEdits() {
  const newName = dom.agentNameInput.value.trim();
  if (newName && newName !== currentAgentId) {
    vscode.postMessage({ type: 'renameAgent', newName });
    currentAgentId = newName;
    dom.agentId.textContent = newName;
  }
  vscode.postMessage({ type: 'updateCapabilities', capabilities: [...currentCapabilities] });
  exitEditMode();
  showToast('Agent settings saved', 'success');
}

dom.editToggle.addEventListener('click', () => {
  if (editMode) {
    exitEditMode();
  } else {
    enterEditMode();
  }
});

dom.editSave.addEventListener('click', saveEdits);
dom.editCancel.addEventListener('click', () => {
  // Reset capabilities to what was last known
  vscode.postMessage({ type: 'refreshTasks' });
  exitEditMode();
});

dom.agentNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    saveEdits();
  } else if (e.key === 'Escape') {
    exitEditMode();
  }
});

dom.capSelect.addEventListener('change', () => {
  const val = dom.capSelect.value;
  if (val && !currentCapabilities.includes(val)) {
    currentCapabilities.push(val);
    renderCapabilityBadges();
  }
  dom.capSelect.value = '';
});

// ── Tell extension we're ready ────────────────────────────────────────────
vscode.postMessage({ type: 'webviewReady' });
