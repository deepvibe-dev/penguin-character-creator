// Smooth strategy-game camera for the colony map.
//
//   drag            pan (with a little inertia when you let go)
//   WASD / arrows   pan
//   screen edges    pan when the pointer rests near the edge of the map
//   mouse wheel     zoom towards the pointer
//   + / - / 0       zoom in, zoom out, fit
//
// The stage (canvas + labels) is moved with a CSS transform; the camera eases
// towards its target every animation frame so all movement is smooth.

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
const EDGE = 28; // px from the viewport edge that triggers edge scrolling
const KEY_SPEED = 900; // screen px per second
const EDGE_SPEED = 700;
const EASE = 14; // higher = snappier

export class Camera {
  constructor(viewport, stage, { onClickBlocked } = {}) {
    this.viewport = viewport;
    this.stage = stage;
    this.width = 1;
    this.height = 1;
    this.x = 0; // screen position of world (0,0)
    this.y = 0;
    this.z = 2;
    this.tx = 0; // targets
    this.ty = 0;
    this.tz = 2;
    this.vx = 0; // inertia, screen px per second
    this.vy = 0;
    this.keys = new Set();
    this.pointer = null; // last pointer position inside the viewport
    this.drag = null;
    this.edgeScroll = true;
    this.active = false;
    this.fitted = false;
    this.onClickBlocked = onClickBlocked;
    this.onZoom = null;
    this._frame = this._frame.bind(this);
    this._last = 0;
    this._bind();
  }

  /** Tell the camera the size of the world (in logical pixels). */
  setWorld(width, height) {
    const first = !this.fitted;
    this.width = width;
    this.height = height;
    if (first) this.fit(true);
    else this._clamp();
    this._apply();
  }

  fit(instant = false) {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    if (!vw || !vh) return;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(vw / this.width, vh / this.height)));
    // pixel art looks best at whole or half-step zoom; prefer that when it still fits
    this.tz = z >= 1 ? Math.floor(z * 2) / 2 : z;
    this.tx = (vw - this.width * this.tz) / 2;
    this.ty = (vh - this.height * this.tz) / 2;
    this.vx = this.vy = 0;
    this.fitted = true;
    if (instant) {
      this.x = this.tx;
      this.y = this.ty;
      this.z = this.tz;
    }
    this._kick();
  }

  zoomBy(factor, cx, cy) {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    if (cx === undefined) {
      cx = vw / 2;
      cy = vh / 2;
    }
    const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.tz * factor));
    // keep the world point under (cx, cy) fixed
    const wx = (cx - this.tx) / this.tz;
    const wy = (cy - this.ty) / this.tz;
    this.tz = nz;
    this.tx = cx - wx * nz;
    this.ty = cy - wy * nz;
    this._clamp();
    this._kick();
  }

  setActive(active) {
    this.active = active;
    if (!active) {
      this.keys.clear();
      this.pointer = null;
    }
    this._kick();
  }

  // --- internals -------------------------------------------------------------

  _bind() {
    const vp = this.viewport;
    vp.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, t: performance.now(), moved: false };
      this.vx = this.vy = 0;
    });
    vp.addEventListener("pointermove", (e) => {
      const r = vp.getBoundingClientRect();
      this.pointer = { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
      const d = this.drag;
      if (d && d.id === e.pointerId) {
        const dx = e.clientX - d.lx;
        const dy = e.clientY - d.ly;
        if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) {
          d.moved = true;
          vp.setPointerCapture(e.pointerId);
          vp.classList.add("dragging");
        }
        if (d.moved) {
          const now = performance.now();
          const dt = Math.max(1, now - d.t) / 1000;
          // follow the hand exactly while dragging, remember the speed for inertia
          this.tx += dx;
          this.ty += dy;
          this.x += dx;
          this.y += dy;
          this.vx = this.vx * 0.6 + (dx / dt) * 0.4;
          this.vy = this.vy * 0.6 + (dy / dt) * 0.4;
          d.t = now;
          this._clamp();
          this._apply();
        }
        d.lx = e.clientX;
        d.ly = e.clientY;
      }
      this._kick();
    });
    const end = (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      if (d.moved) {
        vp.classList.remove("dragging");
        if (this.onClickBlocked) this.onClickBlocked();
        if (performance.now() - d.t > 80) this.vx = this.vy = 0; // stopped before letting go
      }
      this.drag = null;
      this._kick();
    };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);
    vp.addEventListener("pointerleave", () => {
      if (!this.drag) this.pointer = null;
    });
    vp.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = vp.getBoundingClientRect();
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.zoomBy(Math.exp(-delta * 0.0018), e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );

    const KEYS = { w: "up", arrowup: "up", s: "down", arrowdown: "down", a: "left", arrowleft: "left", d: "right", arrowright: "right" };
    window.addEventListener("keydown", (e) => {
      if (!this.active || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (KEYS[k]) {
        this.keys.add(KEYS[k]);
        e.preventDefault();
        this._kick();
      } else if (k === "+" || k === "=") this.zoomBy(1.4);
      else if (k === "-" || k === "_") this.zoomBy(1 / 1.4);
      else if (k === "0") this.fit();
    });
    window.addEventListener("keyup", (e) => {
      const k = KEYS[e.key.toLowerCase()];
      if (k) this.keys.delete(k);
    });
    window.addEventListener("blur", () => this.keys.clear());
    window.addEventListener("resize", () => {
      this._clamp();
      this._kick();
    });
  }

  _clamp() {
    // keep at least a quarter of the viewport covered by the map
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    const mw = this.width * this.tz;
    const mh = this.height * this.tz;
    const keepX = Math.min(mw, vw) * 0.5;
    const keepY = Math.min(mh, vh) * 0.5;
    this.tx = Math.min(vw - keepX, Math.max(keepX - mw, this.tx));
    this.ty = Math.min(vh - keepY, Math.max(keepY - mh, this.ty));
  }

  _kick() {
    if (!this._raf) {
      this._last = performance.now();
      this._raf = requestAnimationFrame(this._frame);
    }
  }

  _frame(now) {
    this._raf = null;
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    let moving = false;

    if (this.active && !this.drag) {
      // keyboard and edge scrolling move the target
      let dx = 0;
      let dy = 0;
      if (this.keys.has("left")) dx += 1;
      if (this.keys.has("right")) dx -= 1;
      if (this.keys.has("up")) dy += 1;
      if (this.keys.has("down")) dy -= 1;
      if (dx || dy) {
        this.tx += dx * KEY_SPEED * dt;
        this.ty += dy * KEY_SPEED * dt;
        moving = true;
      }
      const p = this.pointer;
      if (this.edgeScroll && p) {
        const ex = p.x < EDGE ? 1 - p.x / EDGE : p.x > p.w - EDGE ? -(1 - (p.w - p.x) / EDGE) : 0;
        const ey = p.y < EDGE ? 1 - p.y / EDGE : p.y > p.h - EDGE ? -(1 - (p.h - p.y) / EDGE) : 0;
        if (ex || ey) {
          this.tx += ex * EDGE_SPEED * dt;
          this.ty += ey * EDGE_SPEED * dt;
          moving = true;
        }
      }
      // inertia after a drag
      if (Math.abs(this.vx) + Math.abs(this.vy) > 8) {
        this.tx += this.vx * dt;
        this.ty += this.vy * dt;
        const decay = Math.exp(-5 * dt);
        this.vx *= decay;
        this.vy *= decay;
        moving = true;
      } else {
        this.vx = this.vy = 0;
      }
      if (moving) this._clamp();
    }

    // ease the camera towards its target
    const k = 1 - Math.exp(-EASE * dt);
    this.x += (this.tx - this.x) * k;
    this.y += (this.ty - this.y) * k;
    this.z += (this.tz - this.z) * k;
    const settled = Math.abs(this.tx - this.x) < 0.3 && Math.abs(this.ty - this.y) < 0.3 && Math.abs(this.tz - this.z) < 0.002;
    if (settled) {
      this.x = this.tx;
      this.y = this.ty;
      this.z = this.tz;
    }
    this._apply();
    if (!settled || moving || this.keys.size || (this.edgeScroll && this.pointer && this.active)) this._kick();
  }

  _apply() {
    this.stage.style.transform = `translate(${this.x.toFixed(2)}px, ${this.y.toFixed(2)}px) scale(${this.z.toFixed(4)})`;
    this.stage.style.setProperty("--inv-zoom", (1 / this.z).toFixed(4));
    if (this.onZoom) this.onZoom(this.tz);
  }
}
