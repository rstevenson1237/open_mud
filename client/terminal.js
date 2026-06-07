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
      appendLine('<span class="system">Connected. Use /login username password to authenticate.</span>');
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

  // ── Status bar ─────────────────────────────────────────────────────────────
  function updateStatus(data) {
    setText('s-name',       data.name ?? '');
    setText('s-wounds',     data.wounds != null ? `WND:${data.wounds}` : '');
    setText('s-stress',     data.stress != null ? `STR:${data.stress}` : '');
    setText('s-hunger',     data.hunger != null ? `HNG:${data.hunger}` : '');
    setText('s-rest',       data.rest   != null ? `RST:${data.rest}`   : '');
    setText('s-location',   data.locationName ?? '');
    setText('s-zone',       data.zoneType ?? '');
    setText('s-conditions', (data.conditions ?? []).join(' · '));
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = text ? 'active' : '';
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

      // Local /login handling — never sent raw to server
      if (input.startsWith('/login ')) {
        const parts = input.split(' ');
        const username = parts[1];
        const password = parts[2];
        if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'AUTH', username, password }));
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

    // Basic autocomplete stub — Phase 2 populates command list
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
