'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const activeStates = new Set(['inspecting', 'starting', 'running', 'routing', 'fanout', 'optimizing', 'stopping', 'loading']);
  const terminalStates = new Set(['completed', 'stopped', 'timed_out', 'error', 'failed']);
  const palette = ['#df9676', '#73c7c2', '#c1ab69', '#a394d3', '#83b76e', '#be86a6', '#73a0d0', '#a5b4bf'];
  const nativeEngine = globalThis.RamenNative;
  let currentState = null;
  let connected = false;
  let busy = false;
  let board = null;
  let boardKey = '';
  let fetchingBoard = false;
  let lastJobId = null;
  let lastLogs = '';
  let pollFailures = 0;
  let toastTimer;
  let stoppingSince = null;
  let forcedStop = false;
  let dismissedSuggestionJobId = null;
  let announcedSuggestionJobId = null;
  const visibleLayers = new Map();
  let layerColors = new Map();
  const canvas = $('boardCanvas');
  const ctx = canvas.getContext('2d');
  const view = { scale: 1, fitScale: 1, x: 0, y: 0, width: 1, height: 1, dragging: false, moved: false };
  let drawQueued = false;

  const icons = { ready: '○', completed: '✓', stopped: 'Ⅱ', timed_out: '◷', error: '!', failed: '!' };
  const labels = { ready: 'Board ready', inspecting: 'Reading your board', starting: 'Starting engine', running: 'Routing in progress', routing: 'Routing in progress', fanout: 'Fanout in progress', optimizing: 'Refining routes', stopping: 'Stopping safely', completed: 'Job complete', stopped: 'Job stopped', timed_out: 'Time limit reached', error: 'Job needs attention', failed: 'Job needs attention', idle: 'Ready when you are' };

  function toast(message, error = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').classList.toggle('error', error);
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 4500);
  }

  async function api(path, options = {}) {
    if (!nativeEngine || typeof nativeEngine.request !== 'function') throw new Error('The browser engine did not load. Keep all folder files together and reopen index.html.');
    return await nativeEngine.request(path, options);
  }

  async function post(path, data) {
    const options = { method: 'POST' };
    if (data !== undefined) { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(data); }
    const result = await api(path, options);
    if (result && ('job' in result || 'engineVersion' in result)) applyState(result);
    return result;
  }

  function setConnection(value) {
    connected = value;
    $('connection').className = `connection ${value ? 'connected' : 'disconnected'}`;
    $('connectionText').textContent = value ? 'Runs entirely offline' : 'Browser engine unavailable';
    $('disconnectBanner').hidden = value;
    updateControls();
  }

  function number(value, maximumFractionDigits = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits }) : '—';
  }

  function seconds(value) {
    if (!Number.isFinite(Number(value)) || value === null || value === undefined) return '—';
    const n = Math.max(0, Math.floor(Number(value)));
    if (n >= 3600) return `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  }

  function phaseName(phase) { return ({ deep_search: 'Smart search', pad_escape: 'Pad-via escape' })[phase] || phase; }

  function isActive() { return Boolean(currentState?.job && activeStates.has(currentState.job.state)); }

  function outputAvailable(type) {
    const output = currentState?.job?.hasOutput;
    if (typeof output === 'object' && output !== null) return Boolean(output[type]);
    return Boolean(output);
  }

  function updateControls() {
    const job = currentState?.job;
    const active = isActive();
    const available = connected && !busy;
    const stopping = job?.state === 'stopping';
    $('runButton').hidden = active;
    $('stopButton').hidden = !active;
    $('runButton').disabled = !available || !job || job.state === 'idle' || active;
    $('stopButton').disabled = !available || stopping;
    $('stopButton').lastChild.textContent = stopping ? ' Stopping…' : 'Stop job';
    $('forceStopButton').hidden = !stopping || !stoppingSince || Date.now() - stoppingSince < 5000;
    $('forceStopButton').disabled = !available || forcedStop;
    for (const id of ['dropzone', 'replaceButton', 'demoButton']) $(id).disabled = !available || active;
    for (const control of $('settingsForm').elements) control.disabled = !available || active;
    if (available && !active) {
      const fanoutOnly = $('fanout').checked && $('fanoutOnly').checked;
      $('optimize').disabled = fanoutOnly; $('deepSearch').disabled = fanoutOnly;
    }
    $('fanoutOnlyRow').hidden = !$('fanout').checked;
    const fanoutOnlyMode = $('fanout').checked && $('fanoutOnly').checked;
    const smartMode = $('deepSearch').checked && !fanoutOnlyMode;
    $('routingModeName').textContent = fanoutOnlyMode ? 'Ramen SMD escape' : (smartMode ? 'Ramen smart routing' : 'Ramen direct routing');
    $('routingModeDetail').textContent = fanoutOnlyMode ? 'Prepare pad escapes without routing.' : (smartMode ? 'Search across multiple routing attempts.' : 'A single routing attempt in your browser.');
    $('routingModeTag').textContent = fanoutOnlyMode ? 'FANOUT' : (smartMode ? 'SMART' : 'DIRECT');
    $('downloadSes').disabled = !connected || !outputAvailable('ses') || active;
    $('downloadDsn').disabled = !connected || !outputAvailable('dsn') || active;
    $('downloadChecks').disabled = !connected || !outputAvailable('report') || active;
    $('downloadLog').disabled = !connected || !job;
    $('copyLog').disabled = !lastLogs;
    $('runLabel').textContent = $('fanout').checked && $('fanoutOnly').checked ? 'Run SMD escape' : (job && terminalStates.has(job.state) ? 'Route again' : 'Start routing');
    let hint = !job ? 'Load a board to begin.' : (active ? 'Routing in a local browser worker.' : 'Runs from the original input board.');
    if (busy) hint = 'Preparing your board…';
    if (stopping) hint = forcedStop ? 'Force stop requested.' : 'Finishing the current operation…';
    if (!connected) hint = 'Waiting for the browser engine.';
    $('runHint').textContent = hint;
    updateViaSuggestion();
  }

  function canSuggestViaInPad() {
    const job = currentState?.job;
    return Boolean(job?.state === 'completed' && job.hasOutput && job.stats?.unrouted > 0 &&
      job.suggestions?.viaInPad && !job.settings?.viaInPad && !job.settings?.fanoutOnly &&
      !($('fanout').checked && $('fanoutOnly').checked) && job.id !== dismissedSuggestionJobId);
  }

  function updateViaSuggestion() {
    const show = canSuggestViaInPad();
    $('viaSuggestion').hidden = !show;
    $('enableViaRetry').disabled = !show || busy || !connected || isActive();
    $('dismissViaSuggestion').disabled = busy;
    if (!show) return;
    const job = currentState.job, count = job.stats.unrouted;
    $('viaSuggestionDetail').textContent = `${number(count)} ${count === 1 ? 'connection remains' : 'connections remain'}. Vias in surface-mount pads may offer another path.`;
    if (announcedSuggestionJobId !== job.id) {
      announcedSuggestionJobId = job.id;
      requestAnimationFrame(() => { if (!$('viaSuggestion').hidden) $('viaSuggestion').scrollIntoView({ block: 'nearest' }); });
    }
  }

  function stat(id, value, initial, unit = '') {
    const digits = unit === 'mm' ? 1 : 0;
    $(id + 'Value').textContent = number(value, digits);
    const detail = $(id + 'Change');
    detail.classList.remove('improved');
    if (typeof value !== 'number') detail.textContent = currentState?.job ? 'Awaiting engine' : 'No board loaded';
    else if (typeof initial === 'number' && initial !== value) {
      const difference = value - initial;
      detail.textContent = `${difference > 0 ? '+' : '−'}${number(Math.abs(difference), digits)}${unit ? ' ' + unit : ''} from input`;
      detail.classList.toggle('improved', difference < 0);
    } else detail.textContent = 'From board data';
  }

  function applyStats(job) {
    const stats = job?.stats || {};
    const initial = job?.initialStats || {};
    stat('unrouted', stats.unrouted ?? stats.incomplete, initial.unrouted ?? initial.incomplete);
    stat('vias', stats.viaCount ?? stats.vias, initial.viaCount ?? initial.vias);
    stat('traces', stats.traceLengthMm, initial.traceLengthMm, 'mm');
    const clearances = stats.totalViolations ?? stats.clearanceViolations;
    $('connectionsValue').textContent = number(Array.isArray(clearances) ? clearances.length : clearances);
    $('connectionsChange').textContent = clearances === null || clearances === undefined ? 'Final check pending' : (stats.drcChecked ? 'Clearance + placement checks' : 'Engine reported');
    $('connectionsChange').classList.toggle('improved', clearances === 0 && stats.drcChecked);
    $('widthValue').textContent = number(stats.belowNominalWidthTraceCount);
    $('widthValue').classList.toggle('width-warning', stats.belowNominalWidthTraceCount > 0);
    $('widthDetail').textContent = stats.widthRulesChecked ? 'Trace items · per-net width check' : 'Check pending';
  }

  function updatePhases(job) {
    const phase = String(job?.phase || job?.state || '').toLowerCase();
    const settings = job?.settings || {};
    let stage = -1;
    if (job) stage = 0;
    if (phase.includes('fanout')) stage = 1;
    else if (phase.includes('optimiz')) stage = 3;
    else if (phase.includes('rout') || (phase === 'deep_search' || phase === 'pad_escape') || job?.state === 'running') stage = 2;
    if (job?.state === 'completed') stage = 4;
    for (const [i, node] of [...$('phaseTrack').children].entries()) {
      node.className = i < stage ? 'complete' : i === stage ? 'current' : '';
      if ((i === 1 && !settings.fanout) || (i === 3 && !settings.optimize) || ((i === 2 || i === 3) && settings.fanoutOnly)) node.className = 'skipped';
    }
    $('phaseCaption').textContent = job ? (phaseName(job.phase) || labels[job.state] || job.state) : 'Waiting for a board';
    const pass = job?.pass ?? job?.stats?.pass;
    $('passLabel').textContent = pass ? `ATTEMPT ${pass}` : '';
  }

  function applyState(state) {
    const firstState = currentState === null;
    currentState = state;
    if (state.appVersion) $('appVersion').textContent = state.appVersion;
    if (state.engineVersion) $('engineVersion').textContent = state.engineVersion;
    const job = state.job;
    const hasJob = Boolean(job && job.state !== 'idle');
    const active = isActive();
    if (job?.settings && job.state !== 'ready' && job.state !== 'inspecting' && (firstState || job.id !== lastJobId)) {
      for (const key of ['fanout', 'fanoutOnly', 'optimize', 'deepSearch', 'viaInPad']) if (typeof job.settings[key] === 'boolean') $(key).checked = job.settings[key];
      for (const key of ['maxPasses', 'timeoutMinutes']) if (typeof job.settings[key] === 'number') $(key).value = job.settings[key];
    }
    if (job?.state === 'stopping') stoppingSince ??= Date.now();
    else { stoppingSince = null; forcedStop = false; }
    $('dropzone').hidden = hasJob;
    $('fileCard').hidden = !hasJob;
    $('demoButton').hidden = hasJob;
    if (hasJob) {
      $('fileName').textContent = job.name || 'Untitled board';
      $('fileName').title = job.name || 'Untitled board';
      $('fileDetail').textContent = job.state === 'inspecting' ? 'Reading design…' : 'Original DSN loaded';
      document.title = `${job.name || 'Board'} · RamenRouter`;
    }
    $('stateTitle').textContent = job?.state === 'completed' && job.stats?.unrouted > 0 ? 'Connections remain' : (labels[job?.state] || (job?.state ? job.state : 'Ready when you are'));
    $('phaseLabel').textContent = phaseName(job?.phase) || (hasJob ? 'Choose settings and start routing' : 'No active job');
    $('jobStateIcon').textContent = active ? '⤳' : (icons[job?.state] || '○');
    $('jobState').className = `job-state ${active ? 'running' : (job?.state === 'error' ? 'failed' : job?.state || '')}`;
    $('elapsedValue').textContent = seconds(job?.elapsedSeconds);
    $('jobError').hidden = !job?.error;
    $('jobError').textContent = job?.error ? String(job.error) : '';
    $('canvasLabelText').textContent = active ? 'Engine snapshot' : (job?.state === 'ready' ? 'Input board' : (hasJob ? 'Latest board snapshot' : ''));
    applyStats(job);
    updatePhases(job);
    const logs = Array.isArray(job?.log) ? job.log.map(line => typeof line === 'string' ? line : JSON.stringify(line)) : [];
    const text = logs.join('\n');
    if (text !== lastLogs) {
      lastLogs = text;
      $('logText').textContent = text;
      $('logCount').textContent = number(logs.length);
      $('logPlaceholder').hidden = logs.length > 0;
      if ($('autoScroll').checked) $('logScroll').scrollTop = $('logScroll').scrollHeight;
    }
    if (hasJob && job.id !== lastJobId) {
      lastJobId = job.id;
      boardKey = '';
      board = null;
      visibleLayers.clear();
      $('emptyBoard').hidden = true;
      draw();
    }
    updateControls();
    if (hasJob) {
      const nextKey = `${job.id}|${state.boardRevision ?? job.revision ?? ''}|${job.state}|${job.phase || ''}`;
      if (nextKey !== boardKey) void loadBoard(nextKey, !board);
    }
  }

  async function poll() {
    try {
      const state = await api('/api/state');
      pollFailures = 0;
      if (!connected) setConnection(true);
      applyState(state);
    } catch (error) {
      pollFailures++;
      if (pollFailures >= 2 || !currentState) setConnection(false);
      if (pollFailures === 1) $('disconnectBanner').textContent = error.message;
    } finally { setTimeout(poll, connected ? 1000 : 2000); }
  }

  async function loadBoard(key, fit) {
    if (fetchingBoard) return;
    fetchingBoard = true;
    if (!board) $('boardBusy').hidden = false;
    try {
      const geometry = await api('/api/board');
      if (!geometry || !Array.isArray(geometry.layers)) return;
      board = geometry;
      boardKey = key;
      updateLayers();
      $('emptyBoard').hidden = true;
      $('canvasLabel').hidden = false;
      const parts = [`${board.layers.length} layers`, `${(board.traces || []).length.toLocaleString()} trace segments`];
      const bounds = getBounds();
      if (bounds) parts.push(`${number(bounds[2] - bounds[0], 1)} × ${number(bounds[3] - bounds[1], 1)} mm`);
      $('geometrySummary').textContent = parts.join(' · ');
      if (fit) fitBoard(); else draw();
    } catch (error) {
      if (!board) $('geometrySummary').textContent = 'Board geometry is not available yet';
    } finally { fetchingBoard = false; $('boardBusy').hidden = true; }
  }

  function getBounds() {
    const given = board?.bounds;
    if (Array.isArray(given) && given.length === 4 && given.every(Number.isFinite) && given[2] > given[0] && given[3] > given[1]) return given;
    const points = [];
    for (const trace of board?.traces || []) points.push(...(trace.points || []));
    for (const pad of board?.pads || []) if (Number.isFinite(pad.x) && Number.isFinite(pad.y)) points.push([pad.x, pad.y]);
    for (const outline of board?.outlines || []) points.push(...(Array.isArray(outline) ? outline : outline.points || []));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) { if (!Array.isArray(p) || !p.every(Number.isFinite)) continue; minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); }
    return minX < maxX && minY < maxY ? [minX, minY, maxX, maxY] : null;
  }

  function layerKey(value) { return String(value); }
  function layerVisible(value) { return visibleLayers.get(layerKey(value)) !== false; }
  function layerColor(value) { return layerColors.get(layerKey(value)) || '#bdc5a5'; }

  function updateLayers() {
    const layers = board?.layers || [];
    const list = $('layersList');
    list.replaceChildren();
    layerColors = new Map();
    for (const [i, layer] of layers.entries()) {
      const key = layerKey(layer.id);
      if (!visibleLayers.has(key)) visibleLayers.set(key, true);
      const color = palette[i % palette.length];
      layerColors.set(key, color);
      const row = document.createElement('label'); row.className = 'layer-row';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = visibleLayers.get(key); checkbox.setAttribute('aria-label', `Show ${layer.name || 'layer ' + layer.id}`);
      checkbox.addEventListener('change', () => { visibleLayers.set(key, checkbox.checked); draw(); });
      const swatch = document.createElement('span'); swatch.className = 'layer-color'; swatch.style.background = color;
      const name = document.createElement('span'); name.className = 'layer-name'; name.textContent = layer.name || `Layer ${layer.id}`; name.title = name.textContent;
      const index = document.createElement('small'); index.textContent = String(i + 1).padStart(2, '0');
      row.append(checkbox, swatch, name, index); list.append(row);
    }
    $('layerCount').textContent = String(layers.length);
  }

  function resizeCanvas() {
    const rect = $('canvasWrap').getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const prevWidth = view.width, prevHeight = view.height;
    view.width = Math.max(1, rect.width); view.height = Math.max(1, rect.height);
    canvas.width = Math.round(view.width * dpr); canvas.height = Math.round(view.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (prevWidth > 1 && prevHeight > 1) { view.x += (view.width - prevWidth) / 2; view.y += (view.height - prevHeight) / 2; }
    draw();
  }

  function fitBoard() {
    const bounds = getBounds();
    if (!bounds) { draw(); return; }
    const width = Math.max(.01, bounds[2] - bounds[0]), height = Math.max(.01, bounds[3] - bounds[1]);
    const margin = Math.min(60, view.width * .12, view.height * .12);
    view.scale = Math.max(.01, Math.min((view.width - margin * 2) / width, (view.height - margin * 2) / height));
    view.fitScale = view.scale;
    view.x = view.width / 2 - (bounds[0] + bounds[2]) / 2 * view.scale;
    view.y = view.height / 2 + (bounds[1] + bounds[3]) / 2 * view.scale;
    updateZoom(); draw();
  }

  function worldToScreen(x, y) { return [x * view.scale + view.x, -y * view.scale + view.y]; }
  function screenToWorld(x, y) { return [(x - view.x) / view.scale, (view.y - y) / view.scale]; }

  function updateZoom() { $('zoomValue').textContent = `${Math.round(view.scale / view.fitScale * 100)}%`; }

  function zoomBy(factor, px = view.width / 2, py = view.height / 2) {
    if (!board) return;
    const [wx, wy] = screenToWorld(px, py);
    view.scale = Math.max(view.fitScale * .08, Math.min(view.fitScale * 80, view.scale * factor));
    view.x = px - wx * view.scale; view.y = py + wy * view.scale;
    updateZoom(); draw();
  }

  function draw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; paintBoard(); });
  }

  function path(points, closed = false) {
    if (!Array.isArray(points) || points.length < 2) return false;
    ctx.beginPath();
    let started = false;
    for (const p of points) {
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      const [x, y] = worldToScreen(p[0], p[1]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    if (closed) ctx.closePath();
    return started;
  }

  function circle(x, y, radius) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const p = worldToScreen(x, y);
    ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(.75, (Number(radius) || .2) * view.scale), 0, Math.PI * 2);
    ctx.fill();
  }

  function paintBoard() {
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.fillStyle = '#0c161d'; ctx.fillRect(0, 0, view.width, view.height);
    let gridStep = 25;
    let gridX = 0, gridY = 0;
    if (board) {
      const unit = Math.pow(10, Math.floor(Math.log10(28 / view.scale)));
      const ratio = 28 / view.scale / unit;
      gridStep = unit * (ratio > 5 ? 10 : ratio > 2 ? 5 : ratio > 1 ? 2 : 1) * view.scale;
      gridX = ((view.x % gridStep) + gridStep) % gridStep; gridY = ((view.y % gridStep) + gridStep) % gridStep;
    }
    ctx.fillStyle = '#24383e';
    for (let x = gridX; x < view.width; x += gridStep) for (let y = gridY; y < view.height; y += gridStep) ctx.fillRect(x, y, 1, 1);
    if (!board) return;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const outline of board.outlines || []) {
      const points = Array.isArray(outline) ? outline : outline.points;
      if (path(points, true)) { ctx.fillStyle = '#14252399'; ctx.fill(); ctx.strokeStyle = '#4e7567'; ctx.lineWidth = 1.4; ctx.stroke(); }
    }
    for (const layer of [...(board.layers || [])].reverse()) {
      if (!layerVisible(layer.id)) continue;
      ctx.strokeStyle = layerColor(layer.id); ctx.globalAlpha = .87;
      for (const trace of board.traces || []) {
        if (layerKey(trace.layer) !== layerKey(layer.id)) continue;
        if (path(trace.points)) { ctx.lineWidth = Math.max(.8, (Number(trace.width) || .1) * view.scale); ctx.stroke(); }
      }
      if ($('showPads').checked) {
        ctx.fillStyle = layerColor(layer.id); ctx.globalAlpha = .94;
        for (const pad of board.pads || []) {
          if (layerKey(pad.layer) !== layerKey(layer.id)) continue;
          if (pad.points && path(pad.points, true)) ctx.fill(); else circle(pad.x, pad.y, pad.radius);
        }
      }
    }
    ctx.globalAlpha = 1;
    if ($('showPads').checked && [...visibleLayers.values()].some(Boolean)) {
      for (const via of board.vias || []) {
        ctx.fillStyle = '#bac5a4'; circle(via.x, via.y, via.radius || .3);
        ctx.fillStyle = '#102026'; circle(via.x, via.y, (via.drillRadius || (via.radius || .3) * .42));
      }
    }
    if ($('showAirwires').checked) {
      ctx.strokeStyle = '#c8b875'; ctx.lineWidth = .8; ctx.globalAlpha = .46; ctx.setLineDash([3, 4]);
      for (const wire of board.airwires || []) {
        const points = Array.isArray(wire) ? wire : wire.points;
        if (path(points)) ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
  }

  function getSettings() {
    return { deepSearch: $('deepSearch').checked && !($('fanout').checked && $('fanoutOnly').checked), viaInPad: $('viaInPad').checked, fanout: $('fanout').checked, fanoutOnly: $('fanout').checked && $('fanoutOnly').checked, optimize: $('optimize').checked && !($('fanout').checked && $('fanoutOnly').checked), maxPasses: Number($('maxPasses').value), timeoutMinutes: Number($('timeoutMinutes').value) };
  }

  function saveSettings() { try { localStorage.setItem('ramenrouter.browser.settings.v1', JSON.stringify(getSettings())); } catch {} }

  async function startRouting(enableViaInPad = false) {
    if (busy || isActive() || !connected || !$('settingsForm').reportValidity()) return;
    if (enableViaInPad) {
      if (!canSuggestViaInPad()) return;
      $('viaInPad').checked = true;
      document.querySelector('.advanced-rules').open = true;
    }
    busy = true; updateControls();
    try { saveSettings(); await post('/api/run', getSettings()); }
    catch (error) { toast(error.message, true); }
    finally { busy = false; updateControls(); }
  }
  function restoreSettings() {
    try {
      const settings = JSON.parse(localStorage.getItem('ramenrouter.browser.settings.v1') || '{}');
      for (const key of ['fanout', 'fanoutOnly', 'optimize', 'deepSearch', 'viaInPad']) if (typeof settings[key] === 'boolean') $(key).checked = settings[key];
      if (Number.isInteger(settings.maxPasses) && settings.maxPasses >= 1 && settings.maxPasses <= 100) $('maxPasses').value = settings.maxPasses;
      if (Number.isInteger(settings.timeoutMinutes) && settings.timeoutMinutes >= 1 && settings.timeoutMinutes <= 1440) $('timeoutMinutes').value = settings.timeoutMinutes;
    } catch {}
  }

  async function upload(file) {
    if (!file || busy || isActive() || !connected) return;
    if (!/\.dsn$/i.test(file.name)) { toast('Choose a Specctra .dsn file exported from your PCB editor.', true); return; }
    if (file.size === 0) { toast('This file is empty. Export a new DSN from your PCB editor.', true); return; }
    busy = true; updateControls(); $('boardBusy').hidden = false;
    try {
      const result = await api(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      if (result) applyState(result);
      toast(`${file.name} imported. Reading board data…`);
    } catch (error) { toast(error.message, true); }
    finally { busy = false; $('fileInput').value = ''; updateControls(); $('boardBusy').hidden = false; setTimeout(() => { if (!fetchingBoard) $('boardBusy').hidden = true; }, 1000); }
  }

  async function download(type) {
    try {
      if (!nativeEngine || typeof nativeEngine.download !== 'function') throw new Error('Browser downloads are unavailable. Reopen index.html.');
      await nativeEngine.download(type);
      toast(type === 'log' ? 'Engine log downloaded.' : (type === 'report' ? 'Rule-check report downloaded.' : 'Export downloaded. Validate the result in your PCB editor.'));
    } catch (error) { toast(error.message, true); }
  }

  $('dropzone').addEventListener('click', () => $('fileInput').click());
  $('replaceButton').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', event => void upload(event.target.files[0]));
  for (const eventName of ['dragenter', 'dragover']) document.addEventListener(eventName, event => {
    event.preventDefault(); if (connected && !isActive() && !busy) $('dropzone').classList.add('drag-over');
  });
  document.addEventListener('dragleave', event => { if (!event.relatedTarget) $('dropzone').classList.remove('drag-over'); });
  document.addEventListener('drop', event => { event.preventDefault(); $('dropzone').classList.remove('drag-over'); void upload(event.dataTransfer?.files[0]); });
  $('demoButton').addEventListener('click', async () => {
    if (busy || isActive()) return;
    busy = true; updateControls();
    try { await post('/api/demo'); toast('Example board loaded. Choose your settings to try the engine.'); }
    catch (error) { toast(error.message, true); }
    finally { busy = false; updateControls(); }
  });
  $('settingsForm').addEventListener('submit', event => event.preventDefault());
  $('settingsForm').addEventListener('change', () => { saveSettings(); updateControls(); });
  $('runButton').addEventListener('click', () => void startRouting());
  $('enableViaRetry').addEventListener('click', () => void startRouting(true));
  $('dismissViaSuggestion').addEventListener('click', () => {
    dismissedSuggestionJobId = currentState?.job?.id;
    updateControls();
  });
  $('stopButton').addEventListener('click', async () => {
    $('stopButton').disabled = true;
    try { await post('/api/stop'); stoppingSince ??= Date.now(); toast('Stop requested. The engine will finish its current operation.'); }
    catch (error) { toast(error.message, true); updateControls(); }
  });
  $('forceStopButton').addEventListener('click', async () => {
    forcedStop = true; updateControls();
    try { await post('/api/stop', { force: true }); toast('Force stop requested. Unfinished work is discarded; only completed exports are kept.'); }
    catch (error) { forcedStop = false; toast(error.message, true); updateControls(); }
  });
  $('forceStopButton').title = 'Immediately stop the engine. Unfinished work is discarded; only completed exports are kept.';
  for (const [id, type] of [['downloadSes', 'ses'], ['downloadDsn', 'dsn'], ['downloadChecks', 'report'], ['downloadLog', 'log']]) $(id).addEventListener('click', () => void download(type));
  $('copyLog').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(lastLogs); toast('Engine log copied.'); }
    catch { toast('Clipboard access unavailable. Use Engine log to download it.', true); }
  });
  $('logToggle').addEventListener('click', () => {
    const collapsed = document.querySelector('.activity-panel').classList.toggle('collapsed');
    $('logToggle').setAttribute('aria-expanded', String(!collapsed)); $('logScroll').hidden = collapsed; $('logChevron').textContent = collapsed ? '⌃' : '⌄';
  });
  $('autoScroll').addEventListener('change', () => { if ($('autoScroll').checked) $('logScroll').scrollTop = $('logScroll').scrollHeight; });
  $('helpButton').addEventListener('click', () => $('aboutDialog').showModal());
  $('closeAbout').addEventListener('click', () => $('aboutDialog').close());
  $('closeAboutBottom').addEventListener('click', () => $('aboutDialog').close());
  $('aboutDialog').addEventListener('click', event => { if (event.target === $('aboutDialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
  $('fitButton').addEventListener('click', fitBoard);
  $('zoomIn').addEventListener('click', () => zoomBy(1.25));
  $('zoomOut').addEventListener('click', () => zoomBy(.8));
  $('showPads').addEventListener('change', draw);
  $('showAirwires').addEventListener('change', draw);
  canvas.addEventListener('wheel', event => { if (!board) return; event.preventDefault(); const rect = canvas.getBoundingClientRect(); zoomBy(Math.exp(-event.deltaY * .0018), event.clientX - rect.left, event.clientY - rect.top); }, { passive: false });
  canvas.addEventListener('pointerdown', event => { if (!board || event.button !== 0) return; view.dragging = true; view.pointerX = event.clientX; view.pointerY = event.clientY; canvas.setPointerCapture(event.pointerId); canvas.classList.add('dragging'); });
  canvas.addEventListener('pointermove', event => {
    const rect = canvas.getBoundingClientRect();
    if (view.dragging) { view.x += event.clientX - view.pointerX; view.y += event.clientY - view.pointerY; view.pointerX = event.clientX; view.pointerY = event.clientY; draw(); }
    if (board) { const [x, y] = screenToWorld(event.clientX - rect.left, event.clientY - rect.top); $('cursorPosition').textContent = `X ${x.toFixed(2)} · Y ${y.toFixed(2)} mm`; }
  });
  const endDrag = () => { view.dragging = false; canvas.classList.remove('dragging'); };
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag); canvas.addEventListener('lostpointercapture', endDrag);
  canvas.addEventListener('pointerleave', () => { $('cursorPosition').textContent = 'Drag to pan · scroll to zoom'; });
  canvas.addEventListener('dblclick', fitBoard);
  document.addEventListener('keydown', event => {
    if (event.target.matches('input,textarea,select') || $('aboutDialog').open || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); fitBoard(); }
  });
  restoreSettings();
  new ResizeObserver(resizeCanvas).observe($('canvasWrap'));
  resizeCanvas(); updateControls();
  $('disconnectBanner').hidden = true;
  void poll();
})();
