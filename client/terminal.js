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
