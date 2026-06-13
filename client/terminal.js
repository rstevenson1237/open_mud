(function() {
  const output   = document.getElementById('output');
  const cmdInput = document.getElementById('cmd');
  const history  = [];
  let histIdx    = -1;
  let userScrolled = false;
  let ws         = null;

  // ── WebSocket ──────────────────────────────────────────────────────────────
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
      appendLine('<span class="system">Connected.</span>');
      appendLine('<span class="dim">  /login username password  — sign in</span>');
      appendLine('<span class="dim">  /register username password  — create account</span>');
    };

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'OUTPUT')    appendLine(msg.html);
      if (msg.type === 'AUTH_OK')   appendLine(msg.message);
      if (msg.type === 'AUTH_FAIL') appendLine(`<span class="c-red">${msg.message}</span>`);
      if (msg.type === 'ERROR')     appendLine(`<span class="c-red">${msg.message}</span>`);
      if (msg.type === 'STATUS')    updateStatus(msg.data);
      if (msg.type === 'PANEL')     openPanel(msg.panel);
    };

    ws.onclose = () => {
      appendLine('<span class="c-red">Disconnected. Reconnecting in 5s...</span>');
      setTimeout(connect, 5000);
    };

    ws.onerror = () => ws.close();
  }

  // ── Output ─────────────────────────────────────────────────────────────────
  function appendLine(html) {
    const div = document.createElement('div');
    div.innerHTML = html; // already sanitized server-side
    output.appendChild(div);
    if (!userScrolled) output.scrollTop = output.scrollHeight;
  }

  output.addEventListener('scroll', () => {
    userScrolled = output.scrollTop + output.clientHeight < output.scrollHeight - 10;
  });

  // ── Status panel ───────────────────────────────────────────────────────────

  const STAT_KEYS = [
    'phy_for','phy_pre','phy_res',
    'men_for','men_pre','men_res',
    'soc_for','soc_pre','soc_res',
  ];

  function updateStatus(data) {
    // Header: name / location / zone
    setEl('sp-name',     data.name ?? '');
    setEl('sp-location', data.locationName ? `@ ${data.locationName}` : '');
    setEl('sp-zone',     data.zoneType ?? '');

    // Vitals
    _setTrack('sp-wounds', 'WND',    data.wounds,  data.woundMax  ?? 3,  data.woundMax  ?? 3);
    _setTrack('sp-sanity', 'SAN',    data.sanity,  data.sanityMax ?? 3,  data.sanityMax ?? 3);
    _setTrack('sp-stress', 'STR',    data.stress,  null,                 20);
    _setTrack('sp-hunger', 'HNG',    data.hunger,  null,                 100);
    _setTrack('sp-rest',   'RST',    data.rest,    null,                 100);

    // Stats 3×3 grid
    if (data.stats) {
      for (const k of STAT_KEYS) {
        const el = document.getElementById(`sp-${k}`);
        if (el) el.textContent = data.stats[k] ?? '—';
      }
    }

    // Conditions
    const condEl = document.getElementById('sp-conditions');
    if (condEl) {
      const conds = data.conditions ?? [];
      condEl.textContent = conds.length ? conds.join('\n') : '—';
      condEl.className = conds.length ? 'has-conditions' : '';
    }
  }

  function _setTrack(id, label, value, max, warnAt) {
    const el = document.getElementById(id);
    if (!el) return;
    if (value == null) { el.textContent = ''; el.className = 'sp-track'; return; }
    const display = max != null ? `${label}: ${value}/${max}` : `${label}: ${value}`;
    el.textContent = display;
    el.className = 'sp-track' + (value >= warnAt ? ' danger' : value >= warnAt * 0.6 ? ' warn' : '');
  }

  function setEl(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // ── Panel state ────────────────────────────────────────────────────────────
  let activePanel      = null;
  let queuedPanel      = null;
  const panelOverlay   = document.getElementById('panel-overlay');
  const panelTitle     = document.getElementById('panel-title');
  const panelDesc      = document.getElementById('panel-description');
  const panelError     = document.getElementById('panel-error');
  const panelBody      = document.getElementById('panel-body');
  const panelCancelBtn = document.getElementById('panel-cancel-btn');
  const panelConfirmBtn= document.getElementById('panel-confirm-btn');
  const inputRow       = document.getElementById('input-row');

  panelCancelBtn.addEventListener('click', () => submitPanel(true));
  panelConfirmBtn.addEventListener('click', () => submitPanel(false));

  function openPanel(descriptor) {
    if (activePanel) {
      queuedPanel = descriptor;
      return;
    }
    activePanel = descriptor;
    panelTitle.textContent = descriptor.title ?? '';
    if (descriptor.description) {
      panelDesc.textContent = descriptor.description;
      panelDesc.hidden = false;
    } else {
      panelDesc.hidden = true;
    }
    if (descriptor.error) {
      panelError.textContent = descriptor.error;
      panelError.hidden = false;
    } else {
      panelError.hidden = true;
    }
    panelBody.innerHTML = '';
    for (const field of descriptor.fields ?? []) {
      panelBody.appendChild(renderField(field));
    }
    panelOverlay.hidden = false;
    inputRow.classList.add('panel-active');
    cmdInput.disabled = true;
    const firstInput = panelBody.querySelector('input:not([disabled]), select, textarea');
    if (firstInput) firstInput.focus();
    validatePanel();
  }

  function closePanel() {
    activePanel = null;
    panelOverlay.hidden = true;
    inputRow.classList.remove('panel-active');
    cmdInput.disabled = false;
    cmdInput.focus();
    if (queuedPanel) {
      const next = queuedPanel;
      queuedPanel = null;
      openPanel(next);
    }
  }

  function submitPanel(cancel) {
    if (!activePanel) return;
    const panelId = activePanel.id;
    if (cancel) {
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ type: 'CMD', input: `__panel_cancel__ ${panelId}` }));
      }
      closePanel();
      return;
    }
    const payload = {};
    let valid = true;
    for (const field of activePanel.fields ?? []) {
      const value = collectField(field);
      if (value === null && field.required !== false) {
        valid = false;
      }
      payload[field.key] = value;
    }
    if (!valid) return;
    const jsonStr = JSON.stringify(payload);
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: 'CMD', input: `__panel_submit__ ${panelId} ${jsonStr}` }));
    }
    closePanel();
  }

  document.addEventListener('keydown', (e) => {
    if (!activePanel) return;
    if (e.key === 'Escape') { submitPanel(true); e.preventDefault(); }
  });

  function validatePanel() {
    let ok = true;
    for (const field of activePanel?.fields ?? []) {
      if (!isFieldValid(field)) { ok = false; break; }
    }
    panelConfirmBtn.disabled = !ok;
  }

  // ── Field renderers ─────────────────────────────────────────────────────────

  function renderField(field) {
    const wrapper = document.createElement('div');
    wrapper.className = 'panel-field';
    wrapper.dataset.fieldKey = field.key;
    const label = document.createElement('div');
    label.className = 'panel-label' + (field.locked ? ' locked' : '');
    label.textContent = field.label;
    wrapper.appendChild(label);
    let control;
    switch (field.type) {
      case 'text':          control = renderText(field);          break;
      case 'number':        control = renderNumber(field);        break;
      case 'select':        control = renderSelect(field);        break;
      case 'textarea':      control = renderTextarea(field);      break;
      case 'checkbox':      control = renderCheckbox(field);      break;
      case 'range':         control = renderRange(field);         break;
      case 'stat-allocator':control = renderStatAllocator(field); break;
      case 'keyvalue-list': control = renderKeyValueList(field);  break;
      default:
        control = document.createElement('span');
        control.textContent = `[unknown field type: ${field.type}]`;
    }
    wrapper.appendChild(control);
    if (field.helpText) {
      const help = document.createElement('div');
      help.className = 'panel-help';
      help.textContent = field.helpText;
      wrapper.appendChild(help);
    }
    return wrapper;
  }

  function renderText(field) {
    const el = document.createElement('input');
    el.type = 'text';
    el.className = 'panel-input' + (field.locked ? ' locked' : '');
    el.value = field.default ?? '';
    if (field.locked) el.readOnly = true;
    if (field.maxLength) el.maxLength = field.maxLength;
    if (field.placeholder) el.placeholder = field.placeholder;
    el.addEventListener('input', validatePanel);
    return el;
  }

  function renderNumber(field) {
    const el = document.createElement('input');
    el.type = 'number';
    el.className = 'panel-input' + (field.locked ? ' locked' : '');
    el.value = field.default ?? '';
    if (field.min  != null) el.min  = field.min;
    if (field.max  != null) el.max  = field.max;
    if (field.step != null) el.step = field.step;
    if (field.locked) el.readOnly = true;
    el.addEventListener('input', validatePanel);
    return el;
  }

  function renderSelect(field) {
    const el = document.createElement('select');
    el.className = 'panel-select' + (field.locked ? ' locked' : '');
    for (const opt of field.options ?? []) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === (field.default ?? field.options[0]?.value)) o.selected = true;
      el.appendChild(o);
    }
    if (field.locked) el.disabled = true;
    el.addEventListener('change', validatePanel);
    return el;
  }

  function renderTextarea(field) {
    const el = document.createElement('textarea');
    el.className = 'panel-textarea';
    el.rows = field.rows ?? 8;
    el.value = field.default ?? '';
    if (field.placeholder) el.placeholder = field.placeholder;
    el.addEventListener('input', validatePanel);
    return el;
  }

  function renderCheckbox(field) {
    const row = document.createElement('div');
    row.className = 'panel-checkbox-row';
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.checked = field.default ?? false;
    if (field.locked) el.disabled = true;
    const lbl = document.createElement('label');
    lbl.textContent = field.label;
    row.appendChild(el);
    row.appendChild(lbl);
    el.addEventListener('change', validatePanel);
    return row;
  }

  function renderRange(field) {
    const row = document.createElement('div');
    row.className = 'panel-range-row';
    const el = document.createElement('input');
    el.type = 'range';
    el.min  = field.min  ?? 0;
    el.max  = field.max  ?? 100;
    el.step = field.step ?? 1;
    el.value = field.default ?? field.min ?? 0;
    const readout = document.createElement('span');
    readout.className = 'panel-range-value';
    const fmt = field.displayFormat ?? '{value}';
    readout.textContent = fmt.replace('{value}', el.value);
    el.addEventListener('input', () => {
      readout.textContent = fmt.replace('{value}', el.value);
      validatePanel();
    });
    row.appendChild(el);
    row.appendChild(readout);
    return row;
  }

  function renderStatAllocator(field) {
    const container = document.createElement('div');
    const budget = document.createElement('div');
    budget.className = 'stat-allocator-budget';
    container.appendChild(budget);
    const table = document.createElement('table');
    table.className = 'stat-grid';
    const thead = table.createTHead();
    const hr = thead.insertRow();
    ['', 'FOR', 'PRE', 'RES'].forEach(h => {
      const th = document.createElement('th');
      th.textContent = h;
      hr.appendChild(th);
    });
    const MAJORS   = ['PHY', 'MEN', 'SOC'];
    const MINORS   = ['for', 'pre', 'res'];
    const DEFAULT_VAL = 20;
    const inputs   = {};
    const tbody = table.createTBody();
    MAJORS.forEach(major => {
      const row = tbody.insertRow();
      const labelCell = document.createElement('td');
      labelCell.className = 'major-label';
      labelCell.textContent = major;
      row.appendChild(labelCell);
      MINORS.forEach(minor => {
        const key  = `${major.toLowerCase()}_${minor}`;
        const cell = row.insertCell();
        const el   = document.createElement('input');
        el.type  = 'number';
        el.min   = field.statMin ?? 10;
        el.max   = field.statMax ?? 40;
        el.step  = 1;
        el.value = (field.defaults && field.defaults[key]) ?? DEFAULT_VAL;
        cell.appendChild(el);
        inputs[key] = el;
        el.addEventListener('input', updateBudget);
      });
    });
    container.appendChild(table);
    function updateBudget() {
      const majorBudget = field.majorBudget ?? 30;
      const statMin = field.statMin ?? 10;
      const statMax = field.statMax ?? 40;
      let spent = 0;
      let overRange = false;
      Object.entries(inputs).forEach(([, el]) => {
        const v = parseInt(el.value) || DEFAULT_VAL;
        if (v < statMin || v > statMax) overRange = true;
        if (v > DEFAULT_VAL) spent += (v - DEFAULT_VAL);
        el.classList.toggle('over-budget', v > statMax || v < statMin);
      });
      const remaining = majorBudget - spent;
      const over = remaining < 0 || overRange;
      budget.textContent = over
        ? `Budget: OVER by ${-remaining} pts`
        : `Budget remaining: ${remaining} pts`;
      budget.className = 'stat-allocator-budget' + (over ? ' over' : '');
      panelConfirmBtn.disabled = over;
    }
    updateBudget();
    return container;
  }

  function renderKeyValueList(field) {
    const container = document.createElement('div');
    const table = document.createElement('table');
    table.className = 'kv-table';
    const thead = table.createTHead();
    const hr = thead.insertRow();
    (field.columns ?? []).forEach(col => {
      const th = document.createElement('th');
      th.textContent = col.label;
      hr.appendChild(th);
    });
    const thDel = document.createElement('th');
    hr.appendChild(thDel);
    const tbody = table.createTBody();
    function addRow(defaults = {}) {
      const row = tbody.insertRow();
      (field.columns ?? []).forEach(col => {
        const cell = row.insertCell();
        const el = document.createElement('input');
        el.type = col.type === 'number' ? 'number' : 'text';
        el.value = defaults[col.key] ?? col.default ?? '';
        if (col.min != null) el.min = col.min;
        if (col.max != null) el.max = col.max;
        cell.appendChild(el);
      });
      const delCell = row.insertCell();
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'kv-remove-btn';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => { tbody.removeChild(row); validatePanel(); });
      delCell.appendChild(delBtn);
    }
    (field.default ?? []).forEach(row => addRow(row));
    container.appendChild(table);
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'kv-add-btn';
    addBtn.textContent = '+ Add Row';
    addBtn.addEventListener('click', () => { addRow(); validatePanel(); });
    container.appendChild(addBtn);
    return container;
  }

  // ── Field value collectors ──────────────────────────────────────────────────

  function collectField(field) {
    const wrapper = panelBody.querySelector(`[data-field-key="${field.key}"]`);
    if (!wrapper) return null;
    switch (field.type) {
      case 'text': {
        const el = wrapper.querySelector('input');
        return el ? el.value.trim() : null;
      }
      case 'number': {
        const el = wrapper.querySelector('input');
        return el ? (parseFloat(el.value) || 0) : null;
      }
      case 'select': {
        const el = wrapper.querySelector('select');
        return el ? el.value : null;
      }
      case 'textarea': {
        const el = wrapper.querySelector('textarea');
        return el ? el.value : null;
      }
      case 'checkbox': {
        const el = wrapper.querySelector('input[type=checkbox]');
        return el ? el.checked : false;
      }
      case 'range': {
        const el = wrapper.querySelector('input[type=range]');
        return el ? parseFloat(el.value) : null;
      }
      case 'stat-allocator': {
        const result = {};
        const STAT_KEYS_ORDER = ['phy_for','phy_pre','phy_res','men_for','men_pre','men_res','soc_for','soc_pre','soc_res'];
        const allInputs = wrapper.querySelectorAll('table input[type=number]');
        STAT_KEYS_ORDER.forEach((k, i) => { result[k] = parseInt(allInputs[i]?.value) || 20; });
        return result;
      }
      case 'keyvalue-list': {
        const rows = [];
        wrapper.querySelectorAll('tbody tr').forEach(row => {
          const rowData = {};
          const cells = row.querySelectorAll('input');
          (field.columns ?? []).forEach((col, i) => {
            const v = cells[i]?.value ?? '';
            rowData[col.key] = col.type === 'number' ? (parseFloat(v) || 0) : v;
          });
          rows.push(rowData);
        });
        return rows;
      }
      default: return null;
    }
  }

  function isFieldValid(field) {
    const wrapper = panelBody?.querySelector(`[data-field-key="${field.key}"]`);
    if (!wrapper) return true;
    if (field.required === false) return true;
    switch (field.type) {
      case 'text': {
        const v = wrapper.querySelector('input')?.value.trim() ?? '';
        if (!v) return false;
        if (field.minLength && v.length < field.minLength) return false;
        if (field.maxLength && v.length > field.maxLength) return false;
        if (field.pattern && !new RegExp(field.pattern).test(v)) return false;
        return true;
      }
      case 'number': {
        const v = parseFloat(wrapper.querySelector('input')?.value);
        if (isNaN(v)) return false;
        if (field.min != null && v < field.min) return false;
        if (field.max != null && v > field.max) return false;
        return true;
      }
      case 'stat-allocator':
        return !panelConfirmBtn.disabled;
      default: return true;
    }
  }

  // ── Command input ──────────────────────────────────────────────────────────
  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const input = cmdInput.value.trim();
      if (!input) return;
      history.unshift(input);
      if (history.length > 50) history.pop();
      histIdx = -1;
      cmdInput.value = '';

      // Local auth handling — never sent raw to server
      if (input.startsWith('/login ')) {
        const parts = input.split(' ');
        if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'AUTH', username: parts[1], password: parts[2] }));
        return;
      }
      if (input.startsWith('/register ')) {
        const parts = input.split(' ');
        if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'REGISTER', username: parts[1], password: parts[2] }));
        return;
      }

      appendLine(`<span class="dim">&gt; ${escapeHtml(input)}</span>`);
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'CMD', input }));
    }

    if (e.key === 'ArrowUp') {
      histIdx = Math.min(histIdx + 1, history.length - 1);
      cmdInput.value = history[histIdx] ?? '';
      e.preventDefault();
    }
    if (e.key === 'ArrowDown') {
      histIdx = Math.max(histIdx - 1, -1);
      cmdInput.value = histIdx >= 0 ? history[histIdx] : '';
      e.preventDefault();
    }

    if (e.key === 'Tab') {
      e.preventDefault();
    }
  });

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  connect();
  cmdInput.focus();
})();
