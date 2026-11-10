/* Mimosa Monitor Web 0.2: local recording and demo rules. No trained AI. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Mimosa = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '0.2.0';
  const uid = (prefix) => prefix + '_' + (globalThis.crypto?.randomUUID?.() ||
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const FULL_RULES = Object.freeze({dryThreshold: 25, resetThreshold: 40,
    dryHold: 120, resetHold: 120, wateringRise: 15, wateringHold: 30,
    wateringCooldown: 120, wateringStable: 30, maxGap: 2});
  const QUICK_RULES = Object.freeze({...FULL_RULES, dryHold: 6, resetHold: 6,
    wateringHold: 3, wateringCooldown: 8, wateringStable: 4});
  class Calibration {
    constructor(dry = null, wet = null) { this.dry = dry; this.wet = wet; }
    get valid() {
      return [this.dry, this.wet].every(v => typeof v === 'number' &&
        Number.isFinite(v) && v >= 0 && v <= 1023) && Math.abs(this.wet - this.dry) >= 50;
    }
    percent(raw) {
      return this.valid && Number.isFinite(raw) ?
        clamp(100 * (raw - this.dry) / (this.wet - this.dry), 0, 100) : null;
    }
  }
  const DEMO_CALIBRATION = new Calibration(800, 300);
  class CareRules {
    constructor(config = FULL_RULES) { this.config = {...config}; this.reset(); }
    reset() {
      this.armed = true; this.drySince = null; this.resetSince = null;
      this.anchor = null; this.waterSince = null; this.latched = false;
      this.waterAt = null; this.lastT = null; this.history = [];
    }
    update(t, wetness) {
      if (!Number.isFinite(wetness)) { this.reset(); return []; }
      if (this.lastT !== null && t <= this.lastT) return [];
      const c = this.config, notices = [];
      if (this.lastT !== null && t - this.lastT > c.maxGap) this.reset();
      this.lastT = t;
      if (this.armed) {
        if (wetness <= c.dryThreshold) {
          this.drySince ??= t;
          if (t - this.drySince >= c.dryHold) {
            notices.push('dry'); this.armed = false; this.drySince = null;
          }
        } else this.drySince = null;
      } else {
        if (wetness > c.resetThreshold) {
          this.resetSince ??= t;
          if (t - this.resetSince >= c.resetHold) {
            this.armed = true; this.resetSince = null;
          }
        } else this.resetSince = null;
      }
      this.history.push([t, wetness]);
      this.history = this.history.filter(p => t - p[0] <= c.wateringStable + 1);
      this.anchor ??= wetness;
      if (this.latched) {
        const recent = this.history.filter(p => t - p[0] <= c.wateringStable).map(p => p[1]);
        const stable = recent.length >= 2 && t - this.history[0][0] >= c.wateringStable &&
          Math.max(...recent) - Math.min(...recent) <= 2;
        if (t - this.waterAt >= c.wateringCooldown && stable) {
          this.latched = false; this.anchor = wetness;
        }
      } else if (wetness >= this.anchor + c.wateringRise) {
        this.waterSince ??= t;
        if (t - this.waterSince >= c.wateringHold) {
          notices.push('water'); this.latched = true; this.waterAt = t; this.waterSince = null;
        }
      } else { this.waterSince = null; this.anchor = Math.min(this.anchor, wetness); }
      return notices;
    }
    dryProgress(t) {
      return this.drySince === null ? null : clamp((t - this.drySince) / this.config.dryHold, 0, 1);
    }
  }
  class PacketParser {
    constructor() { this.last = null; this.rollovers = 0; }
    parse(line) {
      line = line.trim();
      if (!line || line === 'sample_ms,plant_adc,moisture_adc') return null;
      if (line.length > 96 || !/^\d+,\d+,\d+$/.test(line)) throw Error('Expected three unsigned integers');
      const [ms, plant, moisture] = line.split(',').map(Number);
      if (!Number.isSafeInteger(ms) || ms < 0 || ms >= 2 ** 32 ||
          plant > 1023 || moisture > 1023) throw Error('Reading outside the expected range');
      if (this.last !== null) {
        if (ms === this.last) throw Error('Repeated board timestamp');
        if (ms < this.last) {
          if (this.last - ms > 2 ** 31) this.rollovers++;
          else throw Error('Board clock restarted; reconnect to begin a fresh session');
        }
      }
      this.last = ms;
      return {sample_ms: ms + this.rollovers * 2 ** 32, plant_adc: plant, moisture_adc: moisture};
    }
  }
  class LineBuffer {
    constructor(parser = new PacketParser()) { this.parser = parser; this.buffer = ''; this.rejected = 0; }
    push(text) {
      this.buffer += text;
      const lines = this.buffer.split('\n'); this.buffer = lines.pop();
      const rows = [];
      for (const line of lines) {
        try { const row = this.parser.parse(line); if (row) rows.push(row); }
        catch (_) { this.rejected++; }
      }
      if (this.buffer.length > 512) { this.buffer = ''; this.rejected++; }
      return rows;
    }
  }
  const SAMPLE_FIELDS = ['timestamp_utc', 'sample_ms', 'plant_adc', 'moisture_adc',
    'relative_wetness_pct', 'session_elapsed_s', 'plant_id', 'session_id', 'data_source', 'connection_id'];
  const EVENT_FIELDS = ['timestamp_utc', 'session_elapsed_s', 'event', 'details',
    'plant_id', 'session_id', 'data_source'];
  class Session {
    constructor({source, plant = 'Mimosa', calibration = new Calibration(), config = FULL_RULES,
      connection = uid(source), now = 0, utc = new Date().toISOString()}) {
      if (!['simulated', 'usb'].includes(source)) throw Error('Unknown source');
      this.id = uid(source === 'simulated' ? 'demo' : 'real');
      this.source = source; this.plant = plant; this.connection = connection;
      this.startT = now; this.closed = false; this.samples = []; this.events = [];
      this.trials = []; this.activeTrial = null; this.lastT = null;
      this.metadata = {app_version: VERSION, session_id: this.id, plant_id: plant,
        data_source: source, is_synthetic: source === 'simulated', connection_id: connection,
        started_utc: utc, state: 'recording', calibration: {dry: calibration.dry, wet: calibration.wet},
        care_rules: {...config}, target_sample_rate_hz: 20, trial_pre_s: 5, trial_post_s: 10,
        ai_model: null, ai_accuracy: null,
        notes: 'No AI model is trained or evaluated in this version. ADC counts are not millivolts.'};
      this.event('Session started', source === 'simulated' ? 'Artificial readings only' : 'USB input', now);
    }
    event(event, details, t) {
      if (this.closed) return;
      this.events.push({timestamp_utc: new Date().toISOString(),
        session_elapsed_s: +(Math.max(0, t - this.startT)).toFixed(4), event, details,
        plant_id: this.plant, session_id: this.id, data_source: this.source});
    }
    append(sample, wetness, t) {
      if (this.closed) throw Error('Session is closed');
      if (sample.data_source !== this.source || sample.connection_id !== this.connection)
        throw Error('Cannot mix sources or connections');
      if (this.lastT !== null && t < this.lastT) throw Error('Host clock moved backwards');
      if (this.activeTrial && this.lastT !== null && t - this.lastT > .3)
        this.finishTrial('interrupted', 'Gap in incoming readings');
      this.lastT = t;
      const row = {timestamp_utc: sample.timestamp_utc || new Date().toISOString(),
        sample_ms: sample.sample_ms, plant_adc: sample.plant_adc, moisture_adc: sample.moisture_adc,
        relative_wetness_pct: wetness === null ? '' : +wetness.toFixed(3),
        session_elapsed_s: +(t - this.startT).toFixed(4), plant_id: this.plant,
        session_id: this.id, data_source: this.source, connection_id: this.connection};
      this.samples.push(row);
      if (this.activeTrial) {
        this.activeTrial.rows.push({...row, relative_time_s: +(t - this.activeTrial.actionT).toFixed(4)});
        if (t - this.activeTrial.actionT >= 10) return this.finishTrial('complete');
      }
      return null;
    }
    startTrial(label, t) {
      if (this.closed || this.activeTrial || !['touch', 'sham'].includes(label))
        throw Error('Finish the current trial before marking another');
      const elapsed = t - this.startT;
      const baseline = this.samples.filter(r => r.session_elapsed_s >= elapsed - 5.1 &&
        r.session_elapsed_s <= elapsed);
      if (!baseline.length || elapsed - baseline[0].session_elapsed_s < 4.8)
        throw Error('Wait for five seconds of baseline readings first');
      const times = baseline.map(r => r.session_elapsed_s).concat(elapsed);
      if (times.some((v, i) => i && v - times[i - 1] > .3))
        throw Error('Baseline has a gap; wait for five uninterrupted seconds');
      this.activeTrial = {trial_id: uid('trial'), label, actionT: t,
        marked_utc: new Date().toISOString(), data_source: this.source,
        is_synthetic: this.source === 'simulated', state: 'recording',
        rows: baseline.map(r => ({...r, relative_time_s: +(r.session_elapsed_s - elapsed).toFixed(4)}))};
      this.event('Trial marked', label + ' / ' + this.activeTrial.trial_id, t);
      return this.activeTrial;
    }
    finishTrial(state, reason = '') {
      const trial = this.activeTrial; if (!trial) return null;
      this.activeTrial = null; trial.state = state; trial.reason = reason;
      this.trials.push(trial);
      this.event('Trial ' + state, trial.label + (reason ? ': ' + reason : ''), this.lastT ?? this.startT);
      return trial;
    }
    close(reason, t) {
      if (this.closed) return;
      this.finishTrial('interrupted', reason);
      this.event('Session stopped', reason, t);
      this.metadata.state = 'closed'; this.metadata.stop_reason = reason;
      this.metadata.ended_utc = new Date().toISOString(); this.closed = true;
    }
    snapshot() {
      return {id: this.id, metadata: {...this.metadata, sample_count: this.samples.length},
        samples: this.samples.slice(), events: this.events.slice(),
        trials: this.trials.map(t => ({...t, rows: t.rows.slice()})),
        active_trial: this.activeTrial ? {...this.activeTrial, rows: this.activeTrial.rows.slice()} : null};
    }
  }
  function recoverSnapshot(record) {
    const copy = structuredClone(record);
    if (copy.metadata.state === 'recording') {
      copy.metadata.state = 'recovered';
      copy.metadata.stop_reason = 'Recovered browser backup; normal completion was not recorded';
    }
    if (copy.active_trial) {
      copy.trials.push({...copy.active_trial, state: 'interrupted', reason: 'Recovered incomplete trial'});
      copy.active_trial = null;
    }
    return copy;
  }
  function csvCell(value) {
    let text = String(value ?? '');
    // Preserve user text as text when a CSV is opened in spreadsheet software.
    if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }
  function csv(fields, rows) {
    return fields.join(',') + '\r\n' + rows.map(row => fields.map(f => csvCell(row[f])).join(',')).join('\r\n') + '\r\n';
  }
  function sessionFiles(record) {
    record = recoverSnapshot(record);
    const files = {'samples.csv': csv(SAMPLE_FIELDS, record.samples),
      'events.csv': csv(EVENT_FIELDS, record.events),
      'metadata.json': JSON.stringify({...record.metadata, trials: record.trials.map(({rows, actionT, ...t}) =>
        ({...t, sample_count: rows.length}))}, null, 2)};
    for (const trial of record.trials) {
      const {rows, actionT, ...meta} = trial;
      const fields = [...SAMPLE_FIELDS, 'trial_id', 'trial_label', 'relative_time_s', 'trial_state'];
      files['trials/' + trial.trial_id + '.csv'] = csv(fields, rows.map(row => ({...row,
        trial_id: trial.trial_id, trial_label: trial.label, trial_state: trial.state})));
      files['trials/' + trial.trial_id + '.json'] = JSON.stringify({...meta, sample_count: rows.length}, null, 2);
    }
    files['READ_ME.txt'] = 'Mimosa Monitor Web ' + VERSION + '\nSource: ' + record.metadata.data_source +
      '\nSynthetic data: ' + record.metadata.is_synthetic + '\nState: ' + record.metadata.state +
      '\nCSV timestamps are UTC host receipt times. sample_ms is the device or demo clock.\n' +
      'Relative wetness is a calibrated index, not volumetric water content.\n' +
      'A signal change alone cannot establish touch, stress, damage, or a biological cause.\n' +
      'This app has no trained AI model. Review gaps, controls and trial labels before analysis.\n';
    return files;
  }
  // A small, dependency-free ZIP writer, using the ZIP stored (uncompressed) format.
  const crcTable = Array.from({length: 256}, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function zip(files) {
    const chunks = [], central = [], encoder = new TextEncoder(); let offset = 0;
    const header = (size) => { const bytes = new Uint8Array(size); return [bytes, new DataView(bytes.buffer)]; };
    for (const [name, text] of Object.entries(files)) {
      const filename = encoder.encode(name), data = encoder.encode(text), crc = crc32(data);
      const [local, v] = header(30);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true);
      v.setUint16(12, 33, true); v.setUint32(14, crc, true);
      v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, filename.length, true);
      chunks.push(local, filename, data);
      const [entry, c] = header(46);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true); c.setUint16(14, 33, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, filename.length, true); c.setUint32(42, offset, true);
      central.push(entry, filename); offset += local.length + filename.length + data.length;
    }
    const centralSize = central.reduce((sum, c) => sum + c.length, 0);
    const [end, e] = header(22); const count = Object.keys(files).length;
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, count, true); e.setUint16(10, count, true);
    e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
    const all = [...chunks, ...central, end];
    const output = new Uint8Array(offset + centralSize + end.length); let p = 0;
    for (const part of all) { output.set(part, p); p += part.length; }
    return output;
  }
  return {VERSION, uid, clamp, Calibration, DEMO_CALIBRATION, FULL_RULES, QUICK_RULES,
    CareRules, PacketParser, LineBuffer, Session, recoverSnapshot, csv, sessionFiles, zip};
}));
