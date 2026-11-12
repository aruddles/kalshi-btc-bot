'use strict';
// LiveChart: Kalshi-style real-time line chart drawn on a <canvas>.
//
// - The time axis advances every frame, so the line scrolls smoothly and its
//   head eases toward the latest value instead of jumping between ticks.
// - Ranges: live (60s), 5m, 15m, 1h. Switching animates the window width.
// - The y-axis rescales smoothly. Price mode colours the line green above the
//   target and red below it; chance mode plots the YES price in percent.
// - Hover or touch shows a crosshair and reports the point via onHover.
(function (global) {
  const RANGES = { live: 60e3, '5m': 5 * 60e3, '15m': 15 * 60e3, '1h': 60 * 60e3 };
  const TIME_STEPS = [5e3, 10e3, 15e3, 30e3, 60e3, 2 * 60e3, 3 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 20 * 60e3, 30 * 60e3];
  const MAX_AGE_MS = 65 * 60e3;
  const PAD = { top: 26, right: 92, bottom: 24, left: 8 };
  const COLORS = {
    up: '#39d98a', down: '#ff6474', chance: '#5b8cff', grid: 'rgba(120,135,160,.12)',
    axis: '#6f7b8f', target: '#8994a6', pillBg: '#18202c', pillText: '#c3cddb',
    crosshair: 'rgba(200,210,225,.35)', panel: '#0e131d', empty: '#5d6a7e',
  };

  const ease = (current, target, dtMs, tauMs) => current + (target - current) * (1 - Math.exp(-dtMs / tauMs));

  function niceStep(span, count) {
    const raw = span / Math.max(1, count);
    const mag = 10 ** Math.floor(Math.log10(raw));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
    return 10 * mag;
  }

  // Index of the last point with t <= time (or -1).
  function lastAtOrBefore(points, time) {
    let lo = 0, hi = points.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= time) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  class LiveChart {
    constructor(canvas, { onHover = () => {} } = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.onHover = onHover;
      this.series = new Map();      // name -> [{t, v}] sorted by t
      this.active = null;           // { name, kind: 'price' | 'chance' }
      this.rangeKey = 'live';
      this.span = RANGES.live;      // animated window width (ms)
      this.target = null;
      this.markers = [];            // [{ t, label }]
      this.head = null;             // eased head value
      this.yMin = null; this.yMax = null;
      this.hoverX = null;
      this.lastFrame = 0;
      this.width = 0; this.height = 0;

      this._resize = this._resize.bind(this);
      this._frame = this._frame.bind(this);
      new ResizeObserver(this._resize).observe(canvas);
      this._resize();
      this._bindPointer();
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this._kick(); });
      this._kick();
    }

    // ---- data -------------------------------------------------------------
    setSeries(name, points) {
      const pts = points.filter(p => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
      this.series.set(name, pts);
      if (this.active?.name === name) this._resetHead();
    }

    push(name, t, v) {
      if (!Number.isFinite(t) || !Number.isFinite(v)) return;
      let pts = this.series.get(name);
      if (!pts) { pts = []; this.series.set(name, pts); }
      const last = pts[pts.length - 1];
      if (last && t < last.t) return;
      if (last && t - last.t < 200) last.v = v; else pts.push({ t, v });
      const cutoff = Date.now() - MAX_AGE_MS;
      let drop = 0;
      while (drop < pts.length && pts[drop].t < cutoff) drop++;
      if (drop) pts.splice(0, drop);
      if (this.active?.name === name && this.head == null) this.head = v;
    }

    show(name, kind) {
      if (this.active?.name === name && this.active.kind === kind) return;
      const kindChanged = this.active?.kind !== kind;
      this.active = { name, kind };
      this._resetHead();
      if (kindChanged) this.yMin = this.yMax = null;
    }

    setRange(key) { if (RANGES[key]) this.rangeKey = key; }
    setTarget(v) { this.target = Number.isFinite(v) && v > 0 ? v : null; }
    setMarkers(markers) { this.markers = (markers || []).filter(m => Number.isFinite(m.t)); }

    // Latest value and the value at the start of the visible window.
    windowStats() {
      const pts = this._points();
      if (!pts.length) return null;
      const start = Date.now() - RANGES[this.rangeKey];
      const i = Math.max(0, lastAtOrBefore(pts, start));
      return { first: pts[i].v, last: pts[pts.length - 1].v, firstT: pts[i].t };
    }

    // ---- internals --------------------------------------------------------
    _points() { return (this.active && this.series.get(this.active.name)) || []; }
    _resetHead() { const p = this._points(); this.head = p.length ? p[p.length - 1].v : null; }

    _resize() {
      const r = this.canvas.getBoundingClientRect();
      const dpr = global.devicePixelRatio || 1;
      this.width = Math.max(1, r.width); this.height = Math.max(1, r.height);
      this.canvas.width = Math.round(this.width * dpr);
      this.canvas.height = Math.round(this.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._kick();
    }

    _bindPointer() {
      const move = e => { const r = this.canvas.getBoundingClientRect(); this.hoverX = e.clientX - r.left; this._kick(); };
      const leave = () => { this.hoverX = null; this.onHover(null); };
      this.canvas.addEventListener('pointermove', move);
      this.canvas.addEventListener('pointerdown', move);
      this.canvas.addEventListener('pointerleave', leave);
      this.canvas.addEventListener('pointercancel', leave);
    }

    _kick() { if (!this.raf && !document.hidden) this.raf = requestAnimationFrame(this._frame); }

    _frame(ts) {
      this.raf = null;
      const dt = this.lastFrame ? Math.min(100, ts - this.lastFrame) : 16;
      this.lastFrame = ts;
      this._draw(dt);
      if (!document.hidden) this._kick();
    }

    _fmt(v, precise) {
      if (this.active?.kind === 'chance') return `${v.toFixed(precise ? 1 : 0)}%`;
      return '$' + v.toLocaleString('en-US', { minimumFractionDigits: precise ? 2 : 0, maximumFractionDigits: precise ? 2 : 0 });
    }

    _timeLabel(t, withSeconds) {
      return new Date(t).toLocaleTimeString([], withSeconds ? { hour: 'numeric', minute: '2-digit', second: '2-digit' } : { hour: 'numeric', minute: '2-digit' });
    }

    _draw(dt) {
      const { ctx, width: W, height: H } = this;
      const now = Date.now();
      const plot = { l: PAD.left, r: W - PAD.right, t: PAD.top, b: H - PAD.bottom };
      ctx.clearRect(0, 0, W, H);

      this.span = ease(this.span, RANGES[this.rangeKey], dt, 90);
      const x1 = now, x0 = now - this.span;
      const xOf = t => plot.l + (t - x0) / (x1 - x0) * (plot.r - plot.l);

      const all = this._points();
      if (!all.length) {
        ctx.fillStyle = COLORS.empty; ctx.font = '600 12px Inter, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Waiting for live data…', (plot.l + plot.r) / 2, (plot.t + plot.b) / 2);
        ctx.textAlign = 'left';
        return;
      }

      // Ease the head toward the newest value; it is drawn at x = now.
      const latest = all[all.length - 1].v;
      this.head = this.head == null ? latest : ease(this.head, latest, dt, 140);

      // Visible points, one per pixel column (keeps 1h of 1s data cheap to draw).
      const startIdx = Math.max(0, lastAtOrBefore(all, x0));
      const vis = [];
      let lastCol = -Infinity;
      for (let i = startIdx; i < all.length; i++) {
        const p = all[i], col = Math.round(xOf(p.t));
        if (col === lastCol) vis[vis.length - 1] = p; else vis.push(p);
        lastCol = col;
      }
      vis.push({ t: now, v: this.head });

      // Smooth y-range around the visible data (and the target, in price mode).
      const kind = this.active.kind;
      let lo = Infinity, hi = -Infinity;
      for (const p of vis) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
      if (kind === 'price' && this.target) { lo = Math.min(lo, this.target); hi = Math.max(hi, this.target); }
      const minSpan = kind === 'chance' ? 10 : 8;
      if (hi - lo < minSpan) { const c = (hi + lo) / 2; lo = c - minSpan / 2; hi = c + minSpan / 2; }
      const pad = (hi - lo) * 0.14;
      let tMin = lo - pad, tMax = hi + pad;
      if (kind === 'chance') { tMin = Math.max(0, tMin); tMax = Math.min(100, tMax); }
      if (this.yMin == null) { this.yMin = tMin; this.yMax = tMax; }
      this.yMin = ease(this.yMin, tMin, dt, 160);
      this.yMax = ease(this.yMax, tMax, dt, 160);
      const yOf = v => plot.b - (v - this.yMin) / (this.yMax - this.yMin) * (plot.b - plot.t);

      // Grid + y labels.
      ctx.font = '500 10px Inter, sans-serif';
      ctx.textBaseline = 'middle';
      const step = niceStep(this.yMax - this.yMin, 4);
      ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
      // Axis labels that would sit under the head or reference pills are skipped.
      const refV = kind === 'price' ? this.target : 50;
      const pillYs = [yOf(this.head), ...(refV != null ? [yOf(refV)] : [])];
      for (let v = Math.ceil(this.yMin / step) * step; v <= this.yMax; v += step) {
        const y = Math.round(yOf(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(plot.l, y); ctx.lineTo(plot.r, y); ctx.stroke();
        if (pillYs.some(py => Math.abs(py - y) < 14)) continue;
        ctx.fillStyle = COLORS.axis; ctx.fillText(this._fmt(v, false), plot.r + 10, y);
      }

      // Time labels.
      // Smallest tick step that leaves room for each label at this chart width.
      const withSec = this.rangeKey === 'live';
      const labelW = ctx.measureText(this._timeLabel(now, withSec)).width + 18;
      const pxPerMs = (plot.r - plot.l) / (x1 - x0);
      const tStep = TIME_STEPS.find(st => st * pxPerMs >= labelW && (withSec || st >= 60e3)) || TIME_STEPS[TIME_STEPS.length - 1];
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      for (let t = Math.ceil(x0 / tStep) * tStep; t <= x1; t += tStep) {
        const x = xOf(t);
        if (x < plot.l + 24 || x > plot.r - 24) continue;
        ctx.fillStyle = COLORS.axis; ctx.fillText(this._timeLabel(t, withSec), x, H - 7);
      }
      ctx.textAlign = 'left';

      // Market open/close markers.
      ctx.setLineDash([2, 4]);
      for (const m of this.markers) {
        const x = xOf(m.t);
        if (x < plot.l || x > plot.r) continue;
        ctx.strokeStyle = 'rgba(140,155,180,.35)';
        ctx.beginPath(); ctx.moveTo(x + 0.5, plot.t); ctx.lineTo(x + 0.5, plot.b); ctx.stroke();
        ctx.fillStyle = COLORS.axis; ctx.font = '700 8px Inter, sans-serif';
        ctx.fillText(m.label, x + 4, plot.t + 8);
      }
      ctx.setLineDash([]);

      // Line + area. In price mode the part above the target is green, below is red.
      const ref = kind === 'price' ? this.target : 50;
      const splitY = ref != null ? Math.min(plot.b, Math.max(plot.t, yOf(ref))) : null;
      const path = new Path2D();
      vis.forEach((p, i) => { const x = xOf(p.t), y = yOf(p.v); i ? path.lineTo(x, y) : path.moveTo(x, y); });
      const area = new Path2D(path);
      area.lineTo(xOf(now), plot.b); area.lineTo(Math.max(plot.l, xOf(vis[0].t)), plot.b); area.closePath();

      const paint = (color, clipTop, clipBottom) => {
        ctx.save();
        ctx.beginPath(); ctx.rect(plot.l, clipTop, plot.r - plot.l + 1, clipBottom - clipTop); ctx.clip();
        const g = ctx.createLinearGradient(0, plot.t, 0, plot.b);
        g.addColorStop(0, color + '33'); g.addColorStop(1, color + '00');
        ctx.fillStyle = g; ctx.fill(area);
        ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.stroke(path);
        ctx.restore();
      };
      if (kind === 'price' && splitY != null) {
        paint(COLORS.up, 0, splitY);
        paint(COLORS.down, splitY, H);
      } else {
        paint(COLORS.chance, 0, H);
      }

      // Target / 50% reference line with a label pill.
      if (ref != null && splitY > plot.t && splitY < plot.b) {
        ctx.setLineDash([6, 5]); ctx.strokeStyle = COLORS.target; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(plot.l, splitY); ctx.lineTo(plot.r, splitY); ctx.stroke(); ctx.setLineDash([]);
        this._pill(kind === 'price' ? `TARGET ${this._fmt(ref, false)}` : '50%', plot.r + 4, splitY, COLORS.pillBg, COLORS.pillText);
      }

      // Pulsing head dot + current value pill.
      const hx = xOf(now), hy = yOf(this.head);
      const headColor = kind === 'chance' || !this.target ? COLORS.chance : (this.head < this.target ? COLORS.down : COLORS.up);
      const pulse = (now % 1600) / 1600;
      ctx.beginPath(); ctx.arc(hx, hy, 4 + pulse * 10, 0, Math.PI * 2);
      ctx.fillStyle = headColor + Math.round((1 - pulse) * 70).toString(16).padStart(2, '0'); ctx.fill();
      ctx.beginPath(); ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = headColor; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = COLORS.panel; ctx.stroke();
      this._pill(this._fmt(this.head, kind === 'price'), plot.r + 4, hy, headColor, '#06110c');

      // Hover crosshair.
      if (this.hoverX != null && this.hoverX >= plot.l && this.hoverX <= plot.r) {
        const t = x0 + (this.hoverX - plot.l) / (plot.r - plot.l) * (x1 - x0);
        const i = lastAtOrBefore(all, t);
        const p = i < 0 ? null : (t >= all[all.length - 1].t ? { t: now, v: this.head } : all[i]);
        if (p) {
          const x = this.hoverX, y = yOf(p.v);
          ctx.strokeStyle = COLORS.crosshair; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x + 0.5, plot.t); ctx.lineTo(x + 0.5, plot.b); ctx.stroke();
          ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
          const label = `${this._fmt(p.v, true)}  ·  ${this._timeLabel(p.t, true)}`;
          ctx.font = '700 10px Inter, sans-serif';
          const w = ctx.measureText(label).width + 14;
          const bx = Math.min(plot.r - w, Math.max(plot.l, x - w / 2));
          ctx.fillStyle = 'rgba(16,23,34,.94)'; ctx.strokeStyle = '#263247';
          ctx.beginPath(); ctx.roundRect(bx, 2, w, 18, 4); ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#edf2f8'; ctx.textBaseline = 'middle'; ctx.fillText(label, bx + 7, 11);
          this.onHover(p);
        }
      }
    }

    _pill(text, x, y, bg, fg) {
      const { ctx } = this;
      ctx.font = '700 10px Inter, sans-serif';
      const w = ctx.measureText(text).width + 10;
      const top = Math.min(this.height - PAD.bottom - 16, Math.max(0, y - 8));
      x = Math.min(x, this.width - w - 1);
      ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(x, top, w, 16, 3); ctx.fill();
      ctx.fillStyle = fg; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 5, top + 8);
    }
  }

  LiveChart.RANGES = RANGES;
  global.LiveChart = LiveChart;
})(window);
