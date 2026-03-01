// ── State ────────────────────────────────────────────────────────────────
let instances = [];
let currentTheme = 'dark';
let deleteTargetId = null;
let renamingId = null;
let autoLaunchExplained = localStorage.getItem('autolaunch-explained') === 'true';
let firstLaunchWarned = localStorage.getItem('first-launch-warned') === 'true';

// ── SVG Icons ───────────────────────────────────────────────────────────
const ICON = {
  star: (filled) => filled
    ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,
  rocket: (filled) => filled
    ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`,
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`
};

// ── Init ─────────────────────────────────────────────────────────────────
async function init() {
  currentTheme = await window.api.getTheme() || 'dark';
  applyTheme(currentTheme);

  // First launch warning
  if (!firstLaunchWarned) {
    firstLaunchWarned = true;
    localStorage.setItem('first-launch-warned', 'true');
    document.getElementById('warning-dialog').classList.add('open');
  }

  // Load instances
  instances = await window.api.getInstances();
  render();

  // Listen for live updates
  window.api.onInstanceUpdate((data) => {
    instances = data;
    render();
  });

  // Window controls
  document.getElementById('win-minimize').addEventListener('click', () => window.api.minimizeWindow());
  document.getElementById('win-maximize').addEventListener('click', () => window.api.maximizeWindow());
  document.getElementById('win-close').addEventListener('click', () => window.api.closeWindow());

  window.api.onMaximizeChange((isMaximized) => {
    const btn = document.getElementById('win-maximize');
    if (isMaximized) {
      btn.innerHTML = `<svg viewBox="0 0 12 12"><rect x="3.5" y="0.5" width="8" height="8" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="0.5" y="3.5" width="8" height="8" rx="0.5" fill="var(--header-bg)" stroke="currentColor" stroke-width="1.2"/></svg>`;
      btn.title = 'Restore';
    } else {
      btn.innerHTML = `<svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
      btn.title = 'Maximize';
    }
  });

  // Event listeners
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('btn-new-instance').addEventListener('click', openNewDialog);
  document.getElementById('btn-launch-all').addEventListener('click', () => window.api.launchAll());
  document.getElementById('btn-close-all').addEventListener('click', () => window.api.stopAll());

  // New instance dialog
  document.getElementById('new-cancel').addEventListener('click', closeNewDialog);
  document.getElementById('new-create').addEventListener('click', createInstance);
  document.getElementById('new-instance-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createInstance();
    if (e.key === 'Escape') closeNewDialog();
  });

  // Delete dialog
  document.getElementById('delete-cancel').addEventListener('click', closeDeleteDialog);
  document.getElementById('delete-confirm').addEventListener('click', confirmDelete);

  // Auto-launch explanation dialog
  document.getElementById('autolaunch-ok').addEventListener('click', closeAutoLaunchDialog);

  // First launch warning dialog
  document.getElementById('warning-ok').addEventListener('click', () => {
    document.getElementById('warning-dialog').classList.remove('open');
  });

  // Close dialogs on overlay click
  for (const overlay of document.querySelectorAll('.dialog-overlay')) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  }
}

// ── Theme ────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  currentTheme = theme;

  const toggle = document.getElementById('theme-toggle');
  const sunIcon = document.getElementById('sun-icon');
  const moonIcon = document.getElementById('moon-icon');

  if (theme === 'dark') {
    toggle.classList.add('checked');
    sunIcon.style.color = '#8b8980';
    moonIcon.style.color = '#ffffff';
  } else {
    toggle.classList.remove('checked');
    sunIcon.style.color = '#d97757';
    moonIcon.style.color = '#8b8980';
  }
}

async function toggleTheme() {
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(newTheme);
  await window.api.setTheme(newTheme);
}

// ── Render ───────────────────────────────────────────────────────────────
function render() {
  const container = document.getElementById('cards-container');

  if (instances.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No instances yet. Click <strong>+ New Instance</strong> to get started.</p>
      </div>
    `;
  } else {
    // Sort: favourites first (by favouriteOrder), then non-favourites by name
    const sorted = [...instances].sort((a, b) => {
      if (a.favourite && !b.favourite) return -1;
      if (!a.favourite && b.favourite) return 1;
      if (a.favourite && b.favourite) return (a.favouriteOrder || 0) - (b.favouriteOrder || 0);
      return (a.name || '').localeCompare(b.name || '');
    });

    container.innerHTML = sorted.map(inst => renderCard(inst)).join('');
    attachCardListeners();
  }

  updateFooter();
}

function renderCard(inst) {
  const isRunning = inst.status === 'running';
  const statusClass = isRunning ? 'running' : 'stopped';

  const statsHtml = isRunning
    ? `<div class="card-stats">
        <div>Running for ${inst.uptime || '0m'}</div>
        <div>${inst.memoryMB || 0} MB</div>
      </div>`
    : `<div class="card-stats">
        <div>${inst.lastActive || ''}</div>
      </div>`;

  const actionBtn = isRunning
    ? `<button class="btn btn-stop" data-action="stop" data-id="${inst.id}">${ICON.stop} Stop</button>`
    : `<button class="btn btn-accent" style="padding:4px 12px;font-size:12px;border-radius:6px" data-action="launch" data-id="${inst.id}">${ICON.play} Launch</button>`;

  return `
    <div class="card" data-instance-id="${inst.id}">
      <div class="card-icons">
        <div class="card-icon ${inst.favourite ? 'active' : ''}" data-action="toggle-fav" data-id="${inst.id}" title="Favourite">
          ${ICON.star(inst.favourite)}
        </div>
        <div class="card-icon ${inst.autoLaunch ? 'active' : ''}" data-action="toggle-auto" data-id="${inst.id}" title="Auto-launch">
          ${ICON.rocket(inst.autoLaunch)}
        </div>
      </div>
      <div class="status-dot ${statusClass}"></div>
      <div class="card-info">
        <div class="card-name" data-action="rename" data-id="${inst.id}">${escapeHtml(inst.name)}</div>
        ${inst.sessionTitle ? `<div class="card-session">${escapeHtml(inst.sessionTitle)}</div>` : ''}
      </div>
      ${statsHtml}
      <div class="card-actions">
        ${actionBtn}
        <div class="trash-btn" data-action="delete" data-id="${inst.id}" title="Delete">
          ${ICON.trash}
        </div>
      </div>
    </div>
  `;
}

function attachCardListeners() {
  // Use event delegation on the cards container
  const container = document.getElementById('cards-container');
  container.onclick = (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const id = parseInt(target.dataset.id, 10);

    switch (action) {
      case 'toggle-fav': {
        const inst = instances.find(i => i.id === id);
        if (inst) {
          inst.favourite = !inst.favourite;
          render();
          window.api.toggleFavourite(id).catch(() => { inst.favourite = !inst.favourite; render(); });
        }
        break;
      }
      case 'toggle-auto': {
        const inst = instances.find(i => i.id === id);
        if (inst) {
          inst.autoLaunch = !inst.autoLaunch;
          render();
          window.api.toggleAutoLaunch(id).catch(() => { inst.autoLaunch = !inst.autoLaunch; render(); });
          if (!autoLaunchExplained) {
            autoLaunchExplained = true;
            localStorage.setItem('autolaunch-explained', 'true');
            setTimeout(() => document.getElementById('autolaunch-dialog').classList.add('open'), 250);
          }
        }
        break;
      }
      case 'launch':
        window.api.launchInstance(id);
        break;
      case 'stop':
        window.api.stopInstance(id);
        break;
      case 'delete':
        openDeleteDialog(id);
        break;
      case 'rename':
        startRename(id, target);
        break;
    }
  };

  // Double-click to rename
  container.ondblclick = (e) => {
    const nameEl = e.target.closest('.card-name');
    if (nameEl) {
      const id = parseInt(nameEl.dataset.id, 10);
      startRename(id, nameEl);
    }
  };
}

// ── Inline rename ────────────────────────────────────────────────────────
function startRename(id, el) {
  if (renamingId === id) return;
  renamingId = id;

  const inst = instances.find(i => i.id === id);
  if (!inst) return;

  const input = document.createElement('input');
  input.className = 'card-name-input';
  input.value = inst.name;
  input.maxLength = 50;

  el.replaceWith(input);
  input.focus();
  input.select();

  const finish = async () => {
    const newName = input.value.trim();
    if (newName && newName !== inst.name) {
      await window.api.renameInstance(id, newName);
    }
    renamingId = null;
    // Re-render will replace the input
    instances = await window.api.getInstances();
    render();
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = inst.name;
      input.blur();
    }
  });
}

// ── Footer ───────────────────────────────────────────────────────────────
function updateFooter() {
  const running = instances.filter(i => i.status === 'running');
  const totalMem = running.reduce((sum, i) => sum + (i.memoryMB || 0), 0);
  const summary = document.getElementById('footer-summary');

  if (running.length === 0) {
    summary.textContent = '0 running';
  } else {
    summary.textContent = `${running.length} running \u00B7 ${totalMem} MB`;
  }
}

// ── New Instance Dialog ──────────────────────────────────────────────────
function getNextInstanceName() {
  const taken = new Set(instances.map(i => i.name));
  let n = 1;
  while (taken.has(`Instance ${n}`)) n++;
  return `Instance ${n}`;
}

function openNewDialog() {
  const input = document.getElementById('new-instance-name');
  input.value = '';
  input.placeholder = getNextInstanceName();
  document.getElementById('new-create').disabled = false;
  document.getElementById('new-dialog').classList.add('open');
  setTimeout(() => input.focus(), 50);
}

function closeNewDialog() {
  document.getElementById('new-dialog').classList.remove('open');
}

async function createInstance() {
  const input = document.getElementById('new-instance-name');
  const name = input.value.trim() || input.placeholder;
  closeNewDialog();
  await window.api.createInstance(name);
  instances = await window.api.getInstances();
  render();
}

// ── Auto-launch Dialog ───────────────────────────────────────────────────
function closeAutoLaunchDialog() {
  document.getElementById('autolaunch-dialog').classList.remove('open');
}

// ── Delete Dialog ────────────────────────────────────────────────────────
function openDeleteDialog(id) {
  deleteTargetId = id;
  const inst = instances.find(i => i.id === id);
  document.getElementById('delete-name').textContent = inst ? inst.name : `Instance ${id}`;
  document.getElementById('delete-dialog').classList.add('open');
}

function closeDeleteDialog() {
  document.getElementById('delete-dialog').classList.remove('open');
  deleteTargetId = null;
}

function confirmDelete() {
  if (deleteTargetId !== null) {
    const id = deleteTargetId;

    // Optimistic: remove from UI immediately
    instances = instances.filter(i => i.id !== id);
    closeDeleteDialog();
    render();

    // Fire and forget — don't await
    window.api.deleteInstance(id).catch(() => {});
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Start ────────────────────────────────────────────────────────────────
init();
