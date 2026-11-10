/* Browser controller. No server, API keys, accounts or third-party scripts. */
(() => {
  'use strict';
  const M = window.Mimosa, $ = id => document.getElementById(id);
  const clock = () => performance.now() / 1000;
  const state = {running: false, busy: false, mode: 'simulated', session: null,
    calibration: new M.Calibration(), plant: 'Mimosa', quick: true,
    port: null, reader: null, readTask: null, connection: '', latest: null,
    history: [], notices: [], rules: null, rejected: 0, startedAt: 0,
    demoStart: 0, demoWetness: 44, peakAt: null, backupOK: false, backupError: false};
  const dbReady = new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(Error('Browser storage unavailable')); return; }
    const request = indexedDB.open('mimosa-monitor-web-v02', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('sessions', {keyPath: 'id'});
      request.result.createObjectStore('summaries', {keyPath: 'id'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('Close other app tabs to open browser storage'));
  });
  dbReady.catch(() => { state.backupError = true; updateBackupLabel(); });
  try {
    const saved = JSON.parse(localStorage.getItem('mimosa-plant-settings-v02') || '{}');
    if (typeof saved.plant === 'string') state.plant = saved.plant.slice(0, 40) || 'Mimosa';
    const cal = new M.Calibration(saved.dry, saved.wet); if (cal.valid) state.calibration = cal;
  } catch (_) { /* The demo remains usable when local storage is unavailable. */ }
  let messageTimer;
  function message(text) {
    $('message').textContent = text; $('message').hidden = false;
    clearTimeout(messageTimer); messageTimer = setTimeout(() => { $('message').hidden = true; }, 6500);
  }
  function updateBackupLabel() {
    $('backupStatus').textContent = state.backupError ? 'Backup unavailable · download before closing' :
      state.backupOK ? 'Backed up in this browser' : 'Preparing local backup…';
  }
  async function saveRecord(record) {
    try {
      const db = await dbReady;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['sessions', 'summaries'], 'readwrite');
        tx.objectStore('sessions').put(record);
        tx.objectStore('summaries').put({id: record.id, source: record.metadata.data_source,
          plant: record.metadata.plant_id, started: record.metadata.started_utc,
          state: record.metadata.state, samples: record.samples.length});
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
      state.backupOK = true; state.backupError = false;
    } catch (_) { state.backupError = true; }
    updateBackupLabel();
  }
  function config() { return state.mode === 'simulated' && state.quick ? M.QUICK_RULES : M.FULL_RULES; }
  function activeCalibration() { return state.mode === 'simulated' ? M.DEMO_CALIBRATION : state.calibration; }
  function newSession() {
    state.rules = new M.CareRules(config()); state.history = []; state.latest = null;
    state.notices = []; state.startedAt = clock(); state.rejected = 0;
    state.session = new M.Session({source: state.mode, plant: state.plant, connection: state.connection,
      calibration: activeCalibration(), config: config(), now: state.startedAt});
    state.backupOK = false; void saveRecord(state.session.snapshot()); renderNotices(); renderTrials();
  }
  function notify(type, title, detail) {
    const demo = state.mode === 'simulated';
    state.notices.unshift({type, title, detail, demo, at: new Date()});
    state.notices = state.notices.slice(0, 8);
    state.session?.event(title, detail, clock()); renderNotices();
    if ('Notification' in window && Notification.permission === 'granted' && !document.hidden) {
      try { new Notification((demo ? 'DEMO · ' : '') + title, {body: detail, tag: 'mimosa-' + type}); }
      catch (_) { /* In-app notice is the supported fallback. */ }
    }
  }
  function renderNotices() {
    const list = $('noticeList'); list.replaceChildren();
    $('noticeCount').textContent = state.notices.length + (state.notices.length === 1 ? ' NOTICE' : ' NOTICES');
    if (!state.notices.length) { const p = document.createElement('p'); p.className = 'empty';
      p.textContent = 'Your notices will appear here.'; list.append(p); }
    for (const n of state.notices) {
      const row = document.createElement('div'); row.className = 'notice';
      const icon = document.createElement('span'); icon.className = 'notice-icon'; icon.textContent = n.type === 'water' ? '↗' : n.type === 'dry' ? '!' : '∿'; icon.ariaHidden = 'true';
      const body = document.createElement('div'), title = document.createElement('strong');
      title.textContent = (n.demo ? 'DEMO · ' : '') + n.title;
      const detail = document.createElement('p'); detail.textContent = n.detail;
      const time = document.createElement('time'); time.dateTime = n.at.toISOString();
      time.textContent = n.at.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
      body.append(title, detail, time); row.append(icon, body); list.append(row);
    }
  }
  function receive(packet, t = clock()) {
    if (!state.running || document.hidden) return;
    const sample = {...packet, data_source: state.mode, connection_id: state.connection,
      timestamp_utc: new Date().toISOString()};
    const wetness = activeCalibration().percent(packet.moisture_adc);
    const previousTrialCount = state.session.trials.length;
    const complete = state.session.append(sample, wetness, t);
    state.latest = {sample, wetness, t}; state.history.push({...sample, t});
    while (state.history.length && t - state.history[0].t > 16) state.history.shift();
    for (const notice of state.rules.update(t, wetness)) {
      if (notice === 'dry') notify('dry', 'Check soil before watering',
        'The relative wetness stayed at or below 25% for ' + config().dryHold + ' seconds.');
      if (notice === 'water') notify('water', 'Watering detected — sensor rise',
        'The relative wetness rose by at least 15 points for ' + config().wateringHold + ' seconds. Check what happened.');
    }
    if (complete || state.session.trials.length !== previousTrialCount) {
      renderTrials(); void saveRecord(state.session.snapshot());
      message(complete ? (state.mode === 'simulated' ? 'Demo trial saved.' : 'Trial saved. Review its signal and controls.') : 'Trial interrupted by a gap in readings.');
    }
  }
  function tickDemo() {
    if (!state.running || state.mode !== 'simulated' || document.hidden) return;
    const t = clock(), age = t - state.demoStart;
    let peak = 0;
    if (state.peakAt !== null) { const dt = t - state.peakAt;
      peak = 118 * Math.exp(-(((dt - 1.3) / .7) ** 2)) - 21 * Math.exp(-(((dt - 3.4) / 1.1) ** 2)); }
    const plant = Math.round(M.clamp(512 + 2 * Math.sin(age * .8) + (Math.random() - .5) * 4 + peak, 0, 1023));
    const moisture = Math.round(M.clamp(800 - state.demoWetness * 5 + (Math.random() - .5) * 1.2, 0, 1023));
    receive({sample_ms: Math.round(age * 1000), plant_adc: plant, moisture_adc: moisture}, t);
  }
  async function stopMonitor(reason = 'Paused by user') {
    state.running = false;
    if (state.session && !state.session.closed) {
      state.session.close(reason, clock()); await saveRecord(state.session.snapshot());
    }
    if (state.reader) { try { await state.reader.cancel(); } catch (_) {} }
    if (state.readTask) { try { await state.readTask; } catch (_) {} state.readTask = null; }
    if (state.port) { try { await state.port.close(); } catch (_) {} state.port = null; }
    state.rules?.reset(); renderTrials(); render();
  }
  async function busy(action) {
    if (state.busy) return;
    state.busy = true; render();
    try { await action(); } catch (error) { message(error.message || 'The action could not finish.'); }
    finally { state.busy = false; render(); }
  }
  async function startDemo() {
    await stopMonitor('Starting a fresh demo session');
    state.mode = 'simulated'; state.connection = M.uid('demo'); state.demoStart = clock();
    state.demoWetness = 44; state.peakAt = null; newSession(); state.running = true;
    tickDemo(); render();
  }
  async function connectUSB() {
    if (!window.isSecureContext || !('serial' in navigator)) {
      message('USB needs desktop Chrome and a secure page. Use the HTTPS GitHub Pages link; the demo works here.'); return;
    }
    // Request access directly from the click, before awaiting unrelated work.
    let selected;
    try { selected = await navigator.serial.requestPort(); }
    catch (error) { if (error.name !== 'NotFoundError') message('USB access was not granted: ' + error.message); return; }
    await stopMonitor('Switching to USB');
    try { await selected.open({baudRate: 115200, bufferSize: 16384}); }
    catch (error) { message('Could not open the board. Close other serial apps, then try again. ' + error.message); return; }
    state.mode = 'usb'; state.connection = M.uid('usb'); state.port = selected;
    newSession(); state.running = true;
    const buffer = new M.LineBuffer(), decoder = new TextDecoder('utf-8');
    state.readTask = (async () => {
      let failure = 'USB stream ended';
      try {
        state.reader = selected.readable.getReader();
        while (state.running && state.port === selected) {
          const {value, done} = await state.reader.read(); if (done) break;
          const rows = buffer.push(decoder.decode(value, {stream: true}));
          state.rejected = buffer.rejected;
          for (const row of rows) receive(row);
        }
      } catch (error) { failure = 'USB read failed: ' + error.message; }
      finally { state.reader?.releaseLock(); state.reader = null; }
      if (state.running && state.port === selected) { message(failure); void stopMonitor(failure); }
    })();
    render();
  }
  function renderTrials() {
    const list = $('trialRows'); list.replaceChildren();
    const trials = state.session?.trials || [];
    if (!trials.length) { const tr = document.createElement('tr'), td = document.createElement('td');
      td.colSpan = 5; td.className = 'empty'; td.textContent = 'No trials yet. Start with a baseline, then mark an action.';
      tr.append(td); list.append(tr); }
    for (const trial of trials.slice().reverse()) {
      const tr = document.createElement('tr');
      const cells = [trial.label === 'touch' ? 'Touch' : 'Sham', trial.is_synthetic ? 'SIMULATED' : 'USB',
        trial.state, trial.rows.length, new Date(trial.marked_utc).toLocaleTimeString()];
      cells.forEach((text, i) => { const td = document.createElement('td'); td.textContent = text;
        if (i === 1) td.className = 'table-source'; tr.append(td); }); list.append(tr);
    }
    const completed = trials.filter(t => !t.is_synthetic && t.state === 'complete');
    $('realTrialCount').textContent = completed.filter(t => t.label === 'touch').length + ' / ' + completed.filter(t => t.label === 'sham').length;
  }
  function markTrial(label) {
    if (!state.running || !state.latest) { message('Start monitoring and wait for baseline readings first.'); return; }
    try {
      state.session.startTrial(label, clock());
      if (state.mode === 'simulated' && label === 'touch') state.peakAt = clock();
      message(state.mode === 'simulated' ? 'Demo ' + label + ' marked. Keep the page visible for 10 seconds.' :
        label === 'touch' ? 'Touch marked. Gently touch once now.' : 'Sham marked. Leave the plant untouched.');
      void saveRecord(state.session.snapshot()); render();
    } catch (error) { message(error.message); }
  }
  function drawChart(id) {
    const canvas = $(id); if (!canvas.getBoundingClientRect().width) return;
    const width = canvas.clientWidth, height = canvas.clientHeight, dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    const left = 35, right = 8, top = 12, bottom = 25, w = width - left - right, h = height - top - bottom;
    const data = state.history, now = data.length ? data[data.length - 1].t : clock();
    const recent = data.filter(d => now - d.t <= 15), values = recent.map(d => d.plant_adc);
    const lo = values.length ? Math.max(0, Math.min(...values) - 6) : 0;
    const hi = values.length ? Math.min(1023, Math.max(...values) + 6) : 1023;
    ctx.font = '10px -apple-system, Arial, sans-serif'; ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = top + i * h / 3; ctx.strokeStyle = '#e8eee2'; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
      ctx.fillStyle = '#63745c'; ctx.textAlign = 'right'; ctx.fillText(Math.round(hi - i * (hi - lo) / 3), left - 8, y + 3);
    }
    for (let i = 0; i <= 3; i++) { const x = left + i * w / 3; ctx.strokeStyle = '#f0f3ec';
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, height - bottom); ctx.stroke(); }
    ctx.textAlign = 'left'; ctx.fillStyle = '#63745c'; ctx.fillText('−15 s', left, height - 4);
    ctx.textAlign = 'right'; ctx.fillText('now', width - right, height - 4);
    if (!recent.length) return;
    const x = d => left + (d.t - (now - 15)) / 15 * w, y = d => top + (hi - d.plant_adc) / (hi - lo || 1) * h;
    const fill = ctx.createLinearGradient(0, top, 0, top + h); fill.addColorStop(0, '#72a67b33'); fill.addColorStop(1, '#72a67b00');
    ctx.beginPath(); ctx.moveTo(x(recent[0]), top + h); recent.forEach(d => ctx.lineTo(x(d), y(d)));
    ctx.lineTo(x(recent[recent.length - 1]), top + h); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    ctx.beginPath(); recent.forEach((d, i) => { if (!i || d.t - recent[i - 1].t > .3) ctx.moveTo(x(d), y(d)); else ctx.lineTo(x(d), y(d)); });
    ctx.lineWidth = 1.7; ctx.strokeStyle = '#347752'; ctx.lineJoin = 'round'; ctx.stroke();
    const last = recent[recent.length - 1]; ctx.beginPath(); ctx.arc(x(last), y(last), 3, 0, 2 * Math.PI); ctx.fillStyle = '#347752'; ctx.fill();
  }
  function render() {
    const demo = state.mode === 'simulated', s = state.session, t = clock(), latest = state.latest;
    $('sourceBadge').textContent = demo ? 'SIMULATED DATA' : 'USB SENSOR DATA';
    $('sourceBadge').className = 'badge ' + (demo ? 'badge-demo' : 'badge-real');
    $('plantDisplay').textContent = state.plant;
    $('connectionStatus').textContent = !state.running ? 'Monitoring paused' : demo ? 'Demo is running' : latest ? 'USB readings received' : 'USB open · waiting for readings';
    $('connectionDetail').textContent = !state.running ? 'Start a fresh session to continue. Last readings remain visible.' :
      demo ? 'Artificial readings · target 20 samples/second' : '115200 baud · classic Nano CSV protocol';
    $('statusDot').classList.toggle('paused', !state.running); $('recordDot').classList.toggle('paused', !state.running);
    $('sessionState').textContent = state.running ? (demo ? 'Recording demo' : 'Recording USB') : 'Session paused';
    $('stopButton').disabled = !state.running || state.busy;
    $('exportButton').disabled = !s?.samples.length || state.busy;
    $('exportButton').textContent = state.running ? 'Stop & download' : 'Download session';
    $('demoButton').disabled = state.busy; $('usbButton').disabled = state.busy;
    $('demoButton').textContent = demo && state.running ? 'Restart demo' : 'Start demo';
    $('demoControls').hidden = !demo; $('quickTimers').checked = demo && state.quick;
    for (const id of ['dryButton', 'waterButton', 'signalButton', 'normalButton']) $(id).disabled = !state.running || !demo;
    const wet = latest?.wetness;
    $('moistureValue').textContent = typeof wet === 'number' ? Math.round(wet) : '—';
    $('moistureMarker').hidden = typeof wet !== 'number';
    if (typeof wet === 'number') $('moistureMarker').style.left = M.clamp(wet, 1, 99) + '%';
    $('calibrationBadge').textContent = demo ? 'DEMO CALIBRATION' : state.calibration.valid ? 'YOUR CALIBRATION' : 'CALIBRATION NEEDED';
    const dry = typeof wet === 'number' && wet <= 25;
    $('careStatus').textContent = !state.running ? 'Last reading · monitoring paused' : typeof wet !== 'number' ?
      'Calibrate to calculate wetness' : dry ? 'Low relative wetness · check the soil' : 'Within the set range';
    $('careStatus').classList.toggle('attention', dry);
    $('careExplanation').textContent = !demo && !state.calibration.valid ? 'Raw moisture ADC: ' + (latest?.sample.moisture_adc ?? '—') + '. Add dry and wet references in Settings.' :
      'Not a measured water-content percentage. Check the soil before acting on a notice.';
    $('dryTimer').textContent = 'Dry-soil ' + (demo ? 'demo ' : '') + 'notice: at or below 25% for ' + config().dryHold + ' seconds.';
    $('dryProgress').style.width = (state.rules?.dryProgress(t) || 0) * 100 + '%';
    $('adcValue').textContent = latest?.sample.plant_adc ?? '—'; $('traceSource').textContent = demo ? 'Artificial trace' : 'USB amplifier input';
    $('chartWait').hidden = !!state.history.length;
    $('sessionSource').textContent = demo ? 'SIMULATED' : 'USB';
    $('sampleCount').textContent = (s?.samples.length || 0).toLocaleString();
    const elapsed = Math.max(0, s?.samples.at(-1)?.session_elapsed_s || 0);
    $('sessionTime').textContent = String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' + String(Math.floor(elapsed % 60)).padStart(2, '0');
    const recent = state.history.filter(p => t - p.t <= 3);
    const rate = recent.length > 1 ? (recent.length - 1) / (recent.at(-1).t - recent[0].t) : 0;
    $('sampleRate').textContent = state.running && Number.isFinite(rate) && rate > 0 ? rate.toFixed(1) + ' Hz' : '—';
    $('rejectedCount').textContent = state.rejected;
    const active = s?.activeTrial;
    const baselineReady = state.running && s?.samples.length > 1 && latest && t - latest.t < .3 &&
      elapsed >= 5 && state.history.some(p => t - p.t >= 4.8);
    $('touchButton').disabled = !baselineReady || !!active || state.busy;
    $('shamButton').disabled = !baselineReady || !!active || state.busy;
    $('trialStatus').textContent = active ? 'Recording ' + active.label + (demo ? ' · DEMO' : '') :
      !state.running ? 'Monitoring paused' : baselineReady ? 'Ready to mark an action' : 'Building baseline…';
    $('trialProgress').textContent = active ? Math.max(0, 10 - (t - active.actionT)).toFixed(1) + ' seconds remaining. Keep this page visible.' :
      !state.running ? 'Start a session for the next trial.' : baselineReady ? '5 seconds before the marker + 10 seconds after.' : 'Wait for 5 seconds of uninterrupted readings.';
    drawChart('careChart'); drawChart('experimentChart');
  }
  function switchTab(name) {
    for (const tab of ['care', 'experiment']) {
      const active = tab === name; $(tab + 'Tab').setAttribute('aria-selected', String(active));
      $(tab + 'Tab').tabIndex = active ? 0 : -1; $(tab + 'Panel').hidden = !active;
    }
    render();
  }
  let downloadURL = null;
  function downloadRecord(record) {
    const data = M.zip(M.sessionFiles(record));
    if (downloadURL) URL.revokeObjectURL(downloadURL);
    downloadURL = URL.createObjectURL(new Blob([data], {type: 'application/zip'}));
    const link = $('saveRecording'); link.href = downloadURL;
    link.download = 'mimosa_' + record.metadata.data_source + '_' + record.id + '.zip';
    $('downloadReady').hidden = false; link.click();
    message('Recording ZIP ready. Check Downloads, or use Save recording ZIP above the tabs.');
  }
  async function showRecordings() {
    $('recordingsDialog').showModal(); const list = $('recordingList'); list.textContent = 'Loading backups…';
    try {
      const db = await dbReady;
      const items = await new Promise((resolve, reject) => { const req = db.transaction('summaries').objectStore('summaries').getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      list.replaceChildren();
      if (!items.length) { list.textContent = 'No backups saved in this browser yet.'; return; }
      for (const item of items.sort((a, b) => b.started.localeCompare(a.started))) {
        const row = document.createElement('div'); row.className = 'recording-item';
        const info = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('p');
        title.textContent = (item.source === 'simulated' ? 'DEMO · ' : 'USB · ') + item.plant;
        detail.textContent = new Date(item.started).toLocaleString() + ' · ' + item.samples.toLocaleString() + ' samples · ' + item.state;
        const button = document.createElement('button'); button.className = 'button outline'; button.textContent = 'Download';
        button.addEventListener('click', async () => {
          if (state.session?.id === item.id) { $('recordingsDialog').close(); await busy(async () => { await stopMonitor('Stopped for export'); await downloadRecord(state.session.snapshot()); }); return; }
          button.disabled = true;
          try { const record = await new Promise((resolve, reject) => { const req = db.transaction('sessions').objectStore('sessions').get(item.id); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
            if (record) await downloadRecord(record); else message('This backup could not be found.');
          } catch (_) { message('Could not read this browser backup.'); } finally { button.disabled = false; }
        });
        info.append(title, detail); row.append(info, button); list.append(row);
      }
    } catch (_) { list.textContent = 'Browser backup is unavailable here. Download the current session from the main screen.'; }
  }
  $('demoButton').addEventListener('click', () => busy(startDemo));
  $('usbButton').addEventListener('click', () => busy(connectUSB));
  $('stopButton').addEventListener('click', () => busy(() => stopMonitor()));
  $('exportButton').addEventListener('click', () => busy(async () => {
    const stopping = stopMonitor('Stopped for export');
    if (state.session) downloadRecord(state.session.snapshot());
    await stopping;
  }));
  $('dryButton').addEventListener('click', () => { state.demoWetness = 20; state.session.event('Demo control', 'Dry soil selected', clock()); message('Artificial soil set to 20%. Wait ' + config().dryHold + ' seconds for the notice.'); });
  $('waterButton').addEventListener('click', () => { state.demoWetness = 80; state.session.event('Demo control', 'Water selected', clock()); message('Artificial soil set to 80%. Wait ' + config().wateringHold + ' seconds for the notice.'); });
  $('signalButton').addEventListener('click', () => { state.peakAt = clock(); notify('signal', 'Signal example — manually triggered', 'An artificial peak was added. This is a demo notice, not AI detection.'); });
  $('normalButton').addEventListener('click', () => { state.demoWetness = 44; state.peakAt = null; state.rules.reset(); state.session.event('Demo control', 'Baseline and care timers reset', clock()); message('Artificial readings and care timers reset.'); });
  $('quickTimers').addEventListener('change', () => { state.quick = $('quickTimers').checked;
    if (state.running && state.mode === 'simulated') { state.session.close('Demo timer settings changed', clock()); void saveRecord(state.session.snapshot()); newSession(); }
    render(); message('Timer settings saved. A fresh demo session keeps the settings consistent.'); });
  $('touchButton').addEventListener('click', () => markTrial('touch')); $('shamButton').addEventListener('click', () => markTrial('sham'));
  for (const name of ['care', 'experiment']) {
    $(name + 'Tab').addEventListener('click', () => switchTab(name));
    $(name + 'Tab').addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const target = event.key === 'Home' ? 'care' : event.key === 'End' ? 'experiment' : name === 'care' ? 'experiment' : 'care';
      switchTab(target); $(target + 'Tab').focus(); } });
  }
  $('settingsButton').addEventListener('click', () => {
    $('plantName').value = state.plant; $('dryReference').value = state.calibration.dry ?? ''; $('wetReference').value = state.calibration.wet ?? '';
    $('latestMoisture').textContent = 'Latest raw moisture reading: ' + (state.latest?.sample.moisture_adc ?? '—') + (state.mode === 'simulated' ? ' (simulated; do not use for real calibration)' : ' ADC');
    $('settingsError').textContent = ''; $('settingsDialog').showModal();
  });
  $('settingsForm').addEventListener('submit', event => {
    event.preventDefault(); const plant = $('plantName').value.trim();
    if (!plant) { $('settingsError').textContent = 'Enter a plant name.'; return; }
    const d = $('dryReference').value, w = $('wetReference').value;
    let calibration = new M.Calibration();
    if (d !== '' || w !== '') {
      if (d === '' || w === '') { $('settingsError').textContent = 'Enter both references, or leave both empty.'; return; }
      calibration = new M.Calibration(Number(d), Number(w));
      if (!calibration.valid) { $('settingsError').textContent = 'References must be 0–1023 ADC and at least 50 counts apart.'; return; }
    }
    if (state.session && !state.session.closed) { state.session.close('Plant or calibration settings changed', clock()); void saveRecord(state.session.snapshot()); }
    state.plant = plant; state.calibration = calibration;
    try { localStorage.setItem('mimosa-plant-settings-v02', JSON.stringify({plant, dry: calibration.dry, wet: calibration.wet})); }
    catch (_) { message('Settings apply now but could not be saved after closing this page.'); }
    if (state.running) newSession(); $('settingsDialog').close(); render();
  });
  $('helpButton').addEventListener('click', () => $('helpDialog').showModal());
  $('recordingsButton').addEventListener('click', showRecordings);
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  $('alertsButton').addEventListener('click', async () => {
    if (!('Notification' in window) || !window.isSecureContext) { message('Desktop alerts are unavailable here. In-app notices still work. Try the HTTPS link in desktop Chrome.'); return; }
    try { const permission = await Notification.requestPermission();
      $('alertsHint').textContent = permission === 'granted' ? 'Desktop alerts enabled for this browser while the monitor page is active.' : 'Desktop alerts were not enabled. In-app notices still work.';
      if (permission === 'granted') $('alertsButton').textContent = 'Desktop alerts enabled';
    } catch (_) { message('Desktop alerts could not be enabled. In-app notices still work.'); }
  });
  if ('serial' in navigator) navigator.serial.addEventListener('disconnect', event => {
    if (event.target === state.port) { message('Board disconnected. Recording stopped.'); void stopMonitor('Board disconnected'); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.running) void stopMonitor('Page hidden; session paused to avoid missing readings');
  });
  window.addEventListener('pagehide', () => {
    if (state.session && !state.session.closed) { state.session.close('Page closed', clock()); void saveRecord(state.session.snapshot()); }
  });
  setInterval(tickDemo, 50);
  setInterval(() => {
    if (state.running && state.mode === 'usb' && clock() - (state.latest?.t ?? state.startedAt) > 5) {
      message('No valid USB data for 5 seconds. Recording stopped; reconnect the board.'); void stopMonitor('No valid USB data for 5 seconds');
    }
    render();
  }, 200);
  setInterval(() => { if (state.running && state.session) void saveRecord(state.session.snapshot()); }, 5000);
  void busy(startDemo);
})();
