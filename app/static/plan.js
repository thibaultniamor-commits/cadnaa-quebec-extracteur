"use strict";
// Bâtiments projetés : import d'un plan (PDF ou DXF), calage par points sur les emprises existantes,
// superposition sur la carte (transparence, rognage), saisie des emprises et des démolitions.
// Utilise les globales de app.js : $, map, zone, job, openHelp, resetZip.

(() => {
  const VIOLET = "#7c3aed";
  const DXF_COLOR = "#d6007e";
  const SNAP_PX = 10;
  const LEVEL_H = 3;
  const STYLE = {
    existing: { color: "#f5c400", weight: 1.5, fillOpacity: 0.08, fillColor: "#f5c400" },
    demolished: { color: "#e02424", weight: 2, dashArray: "4 3", fillColor: "#e02424", fillOpacity: 0.35 },
    project: { color: VIOLET, weight: 2, fillColor: VIOLET, fillOpacity: 0.25 },
    selected: { color: "#ff2bd6", weight: 3, fillColor: VIOLET, fillOpacity: 0.35 },
  };

  const P = {
    plan: null,       // { name, kind, pdf: {id, pages, page, w, h, dpi, url}, dxf: {...} }
    crop: null,       // [xmin, ymin, xmax, ymax] en coordonnées plan (y vers le haut)
    pairs: [],        // { p: [x, y], ll: [lat, lng], pm, mm }
    pending: null,    // paire dont seul le point plan est posé
    fit: null,        // réponse de /api/calage (ok)
    fitInfo: null,    // dernière réponse, même en échec
    mode: null,       // pick-plan | pick-map | crop | draw | take | demol
    projects: [],     // { id, nom, niveaux, hauteur, plan, ring: [[lat, lng]], layer, alt, surf }
    demolis: new Set(),
    covered: [],
    selected: null,
    existing: [],     // { id, rings: [Float64Array lat,lng], bb }
    existSnap: null, planSnap: null, dxfMapSnap: null,
    jobId: null, viewSet: false, touched: false,
    lastHeight: 9, lastLevels: null, seq: 0,
  };

  let planMap, calMap, planRenderer, dxfMapRenderer, existingLayer, planLayer, dxfMapLayer, mapImg, cropLayer;
  let snapPlanMk, snapMapMk, projGroup, mainGroup;

  // ---------- Géométrie ----------

  // Affine plan -> carte : lng = a x + b y + c ; lat = d x + e y + f.
  const toLL = (A, x, y) => [A[3] * x + A[4] * y + A[5], A[0] * x + A[1] * y + A[2]];
  function toPlan(A, lat, lng) {
    const [a, b, c, d, e, f] = A, det = a * e - b * d;
    return [(e * (lng - c) - b * (lat - f)) / det, (-d * (lng - c) + a * (lat - f)) / det];
  }

  // Point dans un anneau plat [u0, v0, u1, v1, …].
  function inRing(r, u, v) {
    let inside = false;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      if ((r[i + 1] > v) !== (r[j + 1] > v) && u < ((r[j] - r[i]) * (v - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) {
        inside = !inside;
      }
    }
    return inside;
  }
  function ringArea(r) {
    let s = 0;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) s += r[j] * r[i + 1] - r[i] * r[j + 1];
    return Math.abs(s / 2);
  }

  // Découpe d'un segment par un rectangle (Liang-Barsky).
  function clipSeg(x0, y0, x1, y1, [xmin, ymin, xmax, ymax]) {
    const dx = x1 - x0, dy = y1 - y0;
    const p = [-dx, dx, -dy, dy], q = [x0 - xmin, xmax - x0, y0 - ymin, ymax - y0];
    let t0 = 0, t1 = 1;
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return null; continue; }
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
    return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy, t1 < 1];
  }
  function clipLine(xy, crop) {
    const out = [];
    let cur = null;
    for (let i = 0; i + 3 < xy.length; i += 2) {
      const s = clipSeg(xy[i], xy[i + 1], xy[i + 2], xy[i + 3], crop);
      if (!s) { if (cur) out.push(cur); cur = null; continue; }
      if (cur && (cur[cur.length - 2] !== s[0] || cur[cur.length - 1] !== s[1])) { out.push(cur); cur = null; }
      if (!cur) cur = [s[0], s[1]];
      cur.push(s[2], s[3]);
      if (s[4]) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }

  // Sommet le plus proche du curseur, à moins de tol pixels (tableaux plats [lat, lng, …]).
  function snap(m, ll, sources, tol = SNAP_PX) {
    const eps = m.options.crs === L.CRS.Simple ? 1 : 1e-5;
    const p0 = m.project(ll);
    const ky = Math.abs(m.project([ll.lat + eps, ll.lng]).y - p0.y) / eps;
    const kx = Math.abs(m.project([ll.lat, ll.lng + eps]).x - p0.x) / eps;
    let best = tol * tol, arr = null, idx = -1;
    for (const a of sources) {
      if (!a) continue;
      for (let i = 0; i < a.length; i += 2) {
        const dy = (a[i] - ll.lat) * ky, dx = (a[i + 1] - ll.lng) * kx;
        const d = dx * dx + dy * dy;
        if (d < best) { best = d; arr = a; idx = i; }
      }
    }
    return arr ? L.latLng(arr[idx], arr[idx + 1]) : null;
  }
  const pxDist = (m, a, b) => m.latLngToContainerPoint(a).distanceTo(m.latLngToContainerPoint(b));

  function flatSnap(rings) {
    const n = rings.reduce((s, r) => s + r.length, 0);
    const out = new Float64Array(n);
    let k = 0;
    rings.forEach((r) => { out.set(r, k); k += r.length; });
    return out;
  }

  const snapPlan = (ll) => (P.plan && P.plan.dxf ? snap(planMap, ll, [P.planSnap]) : null);
  const snapExisting = (ll) => snap(calMap, ll, [P.existSnap]);
  function snapDraw(ll, except = null) {
    const proj = flatSnap(P.projects.filter((p) => p !== except).map((p) => p.ring.flat()));
    return snap(calMap, ll, [P.dxfMapSnap, P.existSnap, proj]);
  }

  // ---------- Plan affiché sur la carte (image PDF transformée par CSS) ----------

  const PlanImage = L.Layer.extend({
    options: { pane: "plan" },
    initialize(url, w, h) { this._url = url; this._w = w; this._h = h; },
    onAdd(m) {
      this._img = L.DomUtil.create("img", "cal-plan-img leaflet-image-layer leaflet-zoom-hide");
      this._img.src = this._url;
      this._img.alt = "";
      this._img.draggable = false;
      this.getPane().appendChild(this._img);
      m.on("zoom viewreset moveend", this.update, this);
      this.update();
    },
    onRemove(m) {
      this._img.remove();
      m.off("zoom viewreset moveend", this.update, this);
    },
    update() {
      const m = this._map, A = P.fit && P.fit.affine_ll;
      if (!m || !A) return;
      const origin = m.getPixelOrigin();
      const pt = (x, y) => m.project(toLL(A, x, y)).subtract(origin);
      const o = pt(0, 0), u = pt(this._w, 0), v = pt(0, -this._h);
      const w = this._w, h = this._h;
      Object.assign(this._img.style, {
        width: `${w}px`, height: `${h}px`,
        transform: `matrix(${(u.x - o.x) / w},${(u.y - o.y) / w},${(v.x - o.x) / h},${(v.y - o.y) / h},${o.x},${o.y})`,
      });
      // Rognage : rectangle en coordonnées plan -> marges en pixels de l'image.
      if (P.crop) {
        const [x0, y0, x1, y1] = P.crop, c = (v1) => Math.max(0, v1);
        this._img.style.clipPath = `inset(${c(-y1)}px ${c(w - x1)}px ${c(h + y0)}px ${c(x0)}px)`;
      } else {
        this._img.style.clipPath = "";
      }
    },
  });

  // ---------- Cartes de l'éditeur ----------

  function initMaps() {
    if (calMap) return;
    planMap = L.map("cal-plan", {
      crs: L.CRS.Simple, minZoom: -20, maxZoom: 10, zoomSnap: 0.25, zoomDelta: 0.5, attributionControl: false,
      doubleClickZoom: false,
    });
    planRenderer = L.canvas({ padding: 0.3 });
    calMap = L.map("cal-map", { maxZoom: 22, zoomSnap: 0.5, doubleClickZoom: false });
    const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 22, maxNativeZoom: 19, attribution: "© contributeurs OpenStreetMap",
    });
    const ortho = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 22, maxNativeZoom: 19, attribution: "Imagerie © Esri" }).addTo(calMap);
    L.control.layers({ "Plan (OSM)": osm, "Imagerie": ortho }).addTo(calMap);
    L.control.scale({ imperial: false }).addTo(calMap);
    const pane = calMap.createPane("plan");
    pane.style.zIndex = 350;
    pane.style.pointerEvents = "none";
    dxfMapRenderer = L.canvas({ pane: "plan", padding: 0.3 });
    calMap.createPane("proj").style.zIndex = 420; // emprises projetées au-dessus des existantes
    projGroup = L.featureGroup().addTo(calMap);
    const mk = { radius: 7, color: "#ff3b30", weight: 2, fill: false, interactive: false };
    snapMapMk = L.circleMarker([0, 0], mk);
    snapPlanMk = L.circleMarker([0, 0], mk);

    planMap.on("click", onPlanClick);
    planMap.on("mousemove", (e) => showSnap(planMap, snapPlanMk, P.mode === "pick-plan" ? snapPlan(e.latlng) : null));
    planMap.on("pm:create", onCropCreated);
    calMap.on("click", onMapClick);
    calMap.on("dblclick", () => { if (P.mode === "draw") drawFinish(); });
    calMap.on("mousemove", onMapMove);
    P.projects.forEach(drawProject);
    applyOverlayStyle();
  }

  function showSnap(m, mk, ll) {
    if (ll) { mk.setLatLng(ll); if (!m.hasLayer(mk)) mk.addTo(m); }
    else if (m.hasLayer(mk)) mk.remove();
  }

  function onMapMove(e) {
    let s = null;
    if (P.mode === "pick-map") s = snapExisting(e.latlng);
    else if (P.mode === "draw") {
      s = snapDraw(e.latlng);
      drawMove(s || e.latlng);
    }
    showSnap(calMap, snapMapMk, s);
  }

  // ---------- Emprises existantes (jaune) et démolitions (rouge) ----------

  async function loadExisting() {
    P.jobId = job.id;
    P.existing = [];
    P.existSnap = null;
    if (existingLayer) existingLayer.remove();
    const r = await fetch(`/api/jobs/${job.id}/batiments`);
    const fc = await r.json();
    if (!r.ok) throw new Error(fc.detail || r.statusText);
    fc.features.forEach((f) => {
      const g = f.geometry;
      const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      polys.forEach((poly) => {
        const rings = poly.map((ring) => Float64Array.from(ring.flatMap(([lng, lat]) => [lat, lng])));
        const o = rings[0];
        let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
        for (let i = 0; i < o.length; i += 2) {
          s = Math.min(s, o[i]); n = Math.max(n, o[i]); w = Math.min(w, o[i + 1]); e = Math.max(e, o[i + 1]);
        }
        P.existing.push({ id: f.properties.OSM_ID, rings, bb: [s, w, n, e] });
      });
    });
    P.existSnap = flatSnap(P.existing.flatMap((b) => b.rings));
    existingLayer = L.geoJSON(fc, {
      renderer: L.canvas({ padding: 0.3 }), interactive: false,
      style: (f) => (P.demolis.has(f.properties.OSM_ID) ? STYLE.demolished : STYLE.existing),
    }).addTo(calMap);
  }

  function existingAt(ll) {
    return P.existing.find((b) => ll.lat >= b.bb[0] && ll.lat <= b.bb[2] && ll.lng >= b.bb[1] && ll.lng <= b.bb[3]
      && inRing(b.rings[0], ll.lat, ll.lng) && !b.rings.slice(1).some((h) => inRing(h, ll.lat, ll.lng)));
  }

  function restyleExisting() {
    if (existingLayer) {
      existingLayer.setStyle((f) => (P.demolis.has(f.properties.OSM_ID) ? STYLE.demolished : STYLE.existing));
    }
  }

  function toggleDemolish(ll) {
    const b = existingAt(ll);
    if (!b) { message("Aucun bâtiment existant sous le clic.", "warn", 2500); return; }
    if (P.demolis.has(b.id)) P.demolis.delete(b.id); else P.demolis.add(b.id);
    restyleExisting();
    changed();
  }

  // ---------- Import et affichage du plan ----------

  async function importPlan(file) {
    const info = $("proj-info");
    info.className = "info muted";
    info.textContent = `Lecture de ${file.name}…`;
    try {
      const r = await fetch(`/api/plans?name=${encodeURIComponent(file.name)}`, {
        method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || r.statusText);
      await openEditor();
      resetPlan();
      P.plan = { name: file.name, kind: d.kind };
      if (d.kind === "dxf") P.plan.dxf = prepareDxf(d);
      else P.plan.pdf = { id: d.plan_id, pages: d.pages, page: 0 };
      await showPlan();
      summary();
    } catch (err) {
      info.className = "info err";
      info.textContent = `Plan non importé : ${err.message}`;
      message(`Plan non importé : ${err.message}`, "err");
    } finally {
      $("plan-file").value = "";
    }
  }

  function prepareDxf(d) {
    const lines = d.lines.map((l) => {
      const xy = Float64Array.from(l.slice(2));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < xy.length; i += 2) {
        x0 = Math.min(x0, xy[i]); x1 = Math.max(x1, xy[i]); y0 = Math.min(y0, xy[i + 1]); y1 = Math.max(y1, xy[i + 1]);
      }
      const closed = l[1] === 1;
      return { layer: l[0], closed, xy, bb: [x0, y0, x1, y1], area: closed ? ringArea(xy) : 0 };
    });
    return { lines, layers: d.layers, hidden: new Set(), bbox: d.bbox, unit_m: d.unit_m, units: d.units };
  }
  const visibleLines = () => P.plan.dxf.lines.filter((l) => !P.plan.dxf.hidden.has(l.layer));

  function resetPlan() {
    cancelMode();
    P.pairs.forEach((p) => { p.pm.remove(); p.mm.remove(); });
    P.pairs = [];
    P.fit = P.fitInfo = null;
    P.crop = null;
    [planLayer, cropLayer, dxfMapLayer, mapImg].forEach((l) => { if (l) l.remove(); });
    planLayer = cropLayer = dxfMapLayer = mapImg = null;
    P.planSnap = P.dxfMapSnap = null;
    P.plan = null;
  }

  async function showPlan() {
    const plan = P.plan;
    [planLayer, mapImg].forEach((l) => { if (l) l.remove(); });
    let bounds;
    if (plan.pdf) {
      const pdf = plan.pdf, pg = pdf.pages[pdf.page];
      message(`Rendu de la page ${pdf.page + 1}…`, "muted");
      pdf.url = `/api/plans/${pdf.id}/page/${pdf.page}`;
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error("rendu de la page impossible (plan expiré ?)"));
        im.src = pdf.url;
      });
      Object.assign(pdf, { w: img.naturalWidth, h: img.naturalHeight, dpi: pg.dpi });
      bounds = [[-pdf.h, 0], [0, pdf.w]];
      planLayer = L.imageOverlay(pdf.url, bounds).addTo(planMap);
      mapImg = new PlanImage(pdf.url, pdf.w, pdf.h);
    } else {
      drawDxfPlan();
      const [x0, y0, x1, y1] = plan.dxf.bbox;
      bounds = [[y0, x0], [y1, x1]];
    }
    planMap.invalidateSize();
    planMap.fitBounds(bounds, { padding: [20, 20] });
    renderPlanControls();
    renderPairs();
    renderStats();
    refreshOverlay();
    setMode(null);
  }

  function drawDxfPlan() {
    if (planLayer) planLayer.remove();
    const vis = visibleLines();
    const latlngs = vis.map((l) => {
      const pts = [];
      for (let i = 0; i < l.xy.length; i += 2) pts.push([l.xy[i + 1], l.xy[i]]);
      return pts;
    });
    planLayer = L.polyline(latlngs, { renderer: planRenderer, color: "#1d2330", weight: 1, interactive: false })
      .addTo(planMap);
    P.planSnap = flatSnap(vis.map((l) => {
      const a = new Float64Array(l.xy.length);
      for (let i = 0; i < l.xy.length; i += 2) { a[i] = l.xy[i + 1]; a[i + 1] = l.xy[i]; }
      return a;
    }));
  }

  function renderPlanControls() {
    const plan = P.plan;
    $("cal-title").textContent = plan
      ? `${plan.name}${plan.pdf ? ` — page ${plan.pdf.page + 1}/${plan.pdf.pages.length}` : ""}`
        + (plan.dxf ? ` — DXF${plan.dxf.units ? ` en ${plan.dxf.units}` : " sans unité"}` : "")
      : "Bâtiments projetés — aucun plan importé";
    const pages = plan && plan.pdf ? plan.pdf.pages : [];
    $("cal-page-row").classList.toggle("hidden", pages.length < 2);
    $("cal-page").innerHTML = pages.map((p, i) =>
      `<option value="${i}"${plan.pdf.page === i ? " selected" : ""}>Page ${i + 1} (${p.w_mm} × ${p.h_mm} mm)</option>`).join("");
    const dxf = plan && plan.dxf;
    $("cal-layers-box").classList.toggle("hidden", !dxf);
    $("cal-layers").innerHTML = dxf ? dxf.layers.map((l, i) =>
      `<label class="check small"><input type="checkbox" data-layer="${i}"${dxf.hidden.has(i) ? "" : " checked"}>
        ${escapeHtml(l.name)} <span class="muted">(${l.n})</span></label>`).join("") : "";
    const method = $("cal-method");
    const rigid = method.querySelector("option[value=rigide]");
    rigid.disabled = !(dxf && dxf.unit_m);
    rigid.textContent = dxf && dxf.unit_m ? `Échelle DXF (${dxf.units}), 2 pts min.` : "Échelle DXF (unités inconnues)";
    if (rigid.disabled && method.value === "rigide") method.value = "similitude";
    ["cal-crop", "cal-uncrop", "cal-add", "cal-method"].forEach((id) => { $(id).disabled = !plan; });
    $("cal-take").classList.toggle("hidden", !dxf);
    $("cal-empty").classList.toggle("hidden", !!plan);
  }

  // ---------- Rognage ----------

  function onCropCreated(e) {
    if (P.mode !== "crop") { e.layer.remove(); return; }
    if (cropLayer) cropLayer.remove();
    cropLayer = e.layer;
    cropLayer.setStyle({ color: "#ff3b30", weight: 2, dashArray: "6 4", fill: false });
    cropLayer.pm.enable({ allowSelfIntersection: false, snappable: false });
    cropLayer.on("pm:edit", updateCrop);
    updateCrop();
    setMode(null);
  }
  function updateCrop() {
    const b = cropLayer.getBounds();
    P.crop = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    refreshOverlay();
  }

  // ---------- Points de calage ----------

  function pointIcon(n, pending = false) {
    return L.divIcon({
      className: `cal-pt${pending ? " pending" : ""}`, iconSize: [18, 18], iconAnchor: [9, 9],
      html: `<i></i><b>${n}</b>`,
    });
  }

  function pairMarker(m, ll, n, pair, side) {
    const mk = L.marker(ll, { icon: pointIcon(n, side === "plan"), draggable: true, autoPan: true, keyboard: false })
      .addTo(m);
    mk.on("dragend", () => {
      const s = side === "plan" ? snapPlan(mk.getLatLng()) : snapExisting(mk.getLatLng());
      if (s) mk.setLatLng(s);
      const ll2 = mk.getLatLng();
      if (side === "plan") pair.p = [ll2.lng, ll2.lat]; else pair.ll = [ll2.lat, ll2.lng];
      if (pair.ll) runFit();
    });
    return mk;
  }

  function onPlanClick(e) {
    if (P.mode !== "pick-plan") return;
    const ll = snapPlan(e.latlng) || e.latlng;
    const pair = { p: [ll.lng, ll.lat], ll: null };
    pair.pm = pairMarker(planMap, ll, P.pairs.length + 1, pair, "plan");
    P.pending = pair;
    setMode("pick-map");
  }

  function completePair(latlng) {
    const ll = snapExisting(latlng) || latlng;
    const pair = P.pending;
    P.pending = null;
    pair.ll = [ll.lat, ll.lng];
    pair.pm.setIcon(pointIcon(P.pairs.length + 1));
    pair.mm = pairMarker(calMap, ll, P.pairs.length + 1, pair, "map");
    P.pairs.push(pair);
    setMode(null);
    renderPairs();
    runFit();
  }

  function removePair(i) {
    const [p] = P.pairs.splice(i, 1);
    p.pm.remove();
    p.mm.remove();
    P.pairs.forEach((q, k) => { q.pm.setIcon(pointIcon(k + 1)); q.mm.setIcon(pointIcon(k + 1)); });
    renderPairs();
    runFit();
  }

  const planBBox = () => (P.plan.pdf ? [0, -P.plan.pdf.h, P.plan.pdf.w, 0] : P.plan.dxf.bbox);
  const planUnit = () => (P.plan.pdf ? 0.0254 / P.plan.pdf.dpi : P.plan.dxf.unit_m);

  async function runFit() {
    const seq = ++P.seq;
    if (!P.plan) return;
    let fit = null, info = null;
    if (P.pairs.length) {
      try {
        const r = await fetch("/api/calage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pairs: P.pairs.map((p) => [p.p[0], p.p[1], p.ll[0], p.ll[1]]),
            method: $("cal-method").value, bbox: planBBox(), unit_m: planUnit(),
          }),
        });
        info = await r.json();
        if (!r.ok) throw new Error(info.detail || r.statusText);
        fit = info.ok ? info : null;
      } catch (err) {
        info = { ok: false, message: err.message };
      }
    }
    if (seq !== P.seq) return; // réponse périmée
    P.fit = fit;
    P.fitInfo = info;
    renderPairs();
    renderStats();
    refreshOverlay();
    setMode(P.mode);
  }

  function renderPairs() {
    const res = P.fit ? P.fit.residuals : [];
    const rows = P.pairs.map((p, i) => {
      const r = res[i];
      const cls = r === undefined ? "" : r > 1.5 ? "err" : r > 0.5 ? "warn" : "";
      const txt = r === undefined ? "—" : `${fmt(r, 2)} m`;
      return `<tr data-i="${i}"><td><span class="pt-num">${i + 1}</span></td><td class="${cls}">${txt}</td>
        <td><button type="button" class="ghost tiny" data-del="${i}" data-tip="Supprimer ce point de calage.">✕</button></td></tr>`;
    });
    if (P.pending) rows.push(`<tr><td><span class="pt-num">${P.pairs.length + 1}</span></td><td class="muted" colspan="2">à placer sur la carte…</td></tr>`);
    $("cal-pairs").innerHTML = rows.length
      ? `<tr><th>Point</th><th data-tip="Distance au sol entre le point de la carte et la position calculée à partir du plan.">Écart</th><th></th></tr>${rows.join("")}`
      : "";
  }

  function renderStats() {
    const el = $("cal-stats"), info = P.fitInfo, plan = P.plan;
    el.className = "info";
    if (!plan) { el.textContent = ""; return; }
    if (!P.pairs.length) {
      el.className = "info muted";
      el.textContent = "Aucun point : 3 ou 4 points bien répartis autour du projet sont conseillés.";
      return;
    }
    if (!info || !info.ok) {
      el.className = "info warn";
      el.textContent = info ? info.message : "";
      return;
    }
    const lines = [];
    if (info.rms === null) {
      lines.push(`<span class="warn">Calage sans contrôle : ${info.min} points suffisent à la transformation, `
        + "les écarts sont nuls. Ajoutez un point pour vérifier.</span>");
    } else {
      const cls = info.rms > 1.5 ? "err" : info.rms > 0.5 ? "warn" : "ok";
      lines.push(`Écart moyen (RMS) : <b class="${cls}">${fmt(info.rms, 2)} m</b>`);
    }
    if (plan.pdf) lines.push(`Échelle déduite : 1:${fmt(Math.round(info.ratio), 0)} <span class="muted">(format du PDF)</span>`);
    else if (plan.dxf.unit_m) lines.push(`Facteur d'échelle : ${fmt(info.ratio, 4)} <span class="muted">(1 = unités ${plan.dxf.units} respectées)</span>`);
    else lines.push(`1 unité du DXF = ${fmt(info.scale, 4)} m`);
    lines.push(`Rotation : ${fmt(info.rotation, 2)}°`);
    if (info.aniso !== undefined) lines.push(`Déformation x/y : ${fmt(info.aniso, 2)} %`);
    info.warnings.forEach((w) => lines.push(`<span class="warn">${escapeHtml(w)}</span>`));
    el.innerHTML = lines.join("<br>");
  }

  // ---------- Superposition sur la carte ----------

  function applyOverlayStyle() {
    if (!calMap) return;
    const pane = calMap.getPane("plan");
    pane.style.display = $("cal-show").checked ? "" : "none";
    pane.style.opacity = Number($("cal-opacity").value) / 100;
    pane.style.mixBlendMode = $("cal-multiply").checked ? "multiply" : "normal";
    $("cal-opacity-val").textContent = `${$("cal-opacity").value} %`;
  }

  function refreshOverlay() {
    if (!calMap) return;
    const A = P.fit && P.fit.affine_ll;
    if (dxfMapLayer) { dxfMapLayer.remove(); dxfMapLayer = null; }
    P.dxfMapSnap = null;
    if (!A || !P.plan) {
      if (mapImg) mapImg.remove();
      return;
    }
    if (P.plan.pdf) {
      if (!calMap.hasLayer(mapImg)) mapImg.addTo(calMap);
      mapImg.update();
      return;
    }
    const latlngs = [], snaps = [];
    visibleLines().forEach((l) => {
      (P.crop ? clipLine(l.xy, P.crop) : [l.xy]).forEach((xy) => {
        const pts = [], flat = new Float64Array(xy.length);
        for (let i = 0; i < xy.length; i += 2) {
          const ll = toLL(A, xy[i], xy[i + 1]);
          pts.push(ll);
          flat[i] = ll[0];
          flat[i + 1] = ll[1];
        }
        latlngs.push(pts);
        snaps.push(flat);
      });
    });
    P.dxfMapSnap = flatSnap(snaps);
    dxfMapLayer = L.polyline(latlngs, { renderer: dxfMapRenderer, color: DXF_COLOR, weight: 1.2, interactive: false })
      .addTo(calMap);
  }

  // ---------- Tracé d'une emprise ----------

  const D = { pts: [], line: null, guide: null };

  function drawStart() {
    D.pts = [];
    D.line = L.polyline([], { color: VIOLET, weight: 2, pane: "proj", interactive: false }).addTo(calMap);
    D.guide = L.polyline([], { color: VIOLET, weight: 1.5, dashArray: "5 5", pane: "proj", interactive: false })
      .addTo(calMap);
  }
  function drawClick(latlng) {
    const s = snapDraw(latlng) || latlng;
    if (D.pts.length >= 3 && pxDist(calMap, s, D.pts[0]) < SNAP_PX) { drawFinish(); return; }
    if (D.pts.length && pxDist(calMap, s, D.pts[D.pts.length - 1]) < 4) return; // clics du double-clic
    D.pts.push(s);
    D.line.setLatLngs(D.pts);
  }
  function drawMove(ll) {
    if (!D.pts.length) return;
    const last = D.pts[D.pts.length - 1];
    D.guide.setLatLngs(D.pts.length >= 2 ? [last, ll, D.pts[0]] : [last, ll]);
  }
  function drawUndo() {
    D.pts.pop();
    D.line.setLatLngs(D.pts);
    D.guide.setLatLngs([]);
  }
  function drawCleanup() {
    if (D.line) D.line.remove();
    if (D.guide) D.guide.remove();
    D.pts = [];
    D.line = D.guide = null;
  }
  function drawFinish() {
    const ring = D.pts.map((p) => [p.lat, p.lng]);
    drawCleanup();
    setMode(null);
    if (ring.length >= 3) addProject(ring);
    else message("Il faut au moins 3 sommets.", "warn", 2500);
  }

  // Prend une polyligne fermée du DXF sous le clic (la plus petite qui contient le point).
  function takeAt(latlng) {
    const A = P.fit && P.fit.affine_ll;
    if (!A) return;
    const [x, y] = toPlan(A, latlng.lat, latlng.lng);
    const c = P.crop;
    let best = null;
    visibleLines().forEach((l) => {
      const [x0, y0, x1, y1] = l.bb;
      if (!l.closed || x < x0 || x > x1 || y < y0 || y > y1) return;
      if (c && (x0 < c[0] || y0 < c[1] || x1 > c[2] || y1 > c[3])) return;
      if ((!best || l.area < best.area) && inRing(l.xy, x, y)) best = l;
    });
    if (!best) { message("Aucune polyligne fermée du DXF sous le clic.", "warn", 2500); return; }
    const ring = [];
    for (let i = 0; i < best.xy.length - 2; i += 2) ring.push(toLL(A, best.xy[i], best.xy[i + 1]));
    addProject(ring);
    setMode("take");
  }

  // ---------- Bâtiments projetés ----------

  function addProject(ring) {
    const used = new Set(P.projects.map((p) => p.nom));
    let n = P.projects.length + 1;
    while (used.has(`Projet ${n}`)) n++;
    const pr = {
      id: `p${Date.now().toString(36)}${n}`, nom: `Projet ${n}`, niveaux: P.lastLevels, hauteur: P.lastHeight,
      plan: P.plan ? P.plan.name : null, ring, alt: null, surf: null,
    };
    P.projects.push(pr);
    drawProject(pr);
    select(pr);
    changed();
  }

  function drawProject(pr) {
    if (!projGroup) return;
    pr.layer = L.polygon(pr.ring, { ...STYLE.project, pane: "proj", interactive: false }).addTo(projGroup);
    pr.layer.bindTooltip("", { permanent: true, direction: "center", className: "proj-label" });
    labelProject(pr);
    pr.layer.on("pm:edit", () => onProjectEdited(pr));
  }
  function labelProject(pr) {
    if (pr.layer) pr.layer.setTooltipContent(`${escapeHtml(pr.nom)}<br>${fmt(pr.hauteur, 1)} m`);
  }

  // Après déplacement d'un sommet : accrochage aux sommets voisins (DXF, existants, autres projets).
  function onProjectEdited(pr) {
    let moved = false;
    const ring = pr.layer.getLatLngs()[0].map((v) => {
      const s = snapDraw(v, pr);
      if (s && !s.equals(v)) { moved = true; return s; }
      return v;
    });
    if (moved) {
      pr.layer.setLatLngs(ring);
      pr.layer.pm.disable();
      pr.layer.pm.enable({ draggable: false, snappable: false, allowSelfIntersection: false });
    }
    pr.ring = ring.map((v) => [v.lat, v.lng]);
    changed();
  }

  function projectAt(ll) {
    return P.projects.find((p) => inRing(Float64Array.from(p.ring.flat()), ll.lat, ll.lng));
  }

  function select(pr) {
    const prev = P.selected;
    if (prev && prev.layer) {
      prev.layer.pm.disable();
      prev.layer.setStyle(STYLE.project);
    }
    P.selected = pr;
    if (pr && pr.layer) {
      pr.layer.setStyle(STYLE.selected);
      pr.layer.pm.enable({ draggable: false, snappable: false, allowSelfIntersection: false });
    }
    const box = $("cal-edit");
    box.classList.toggle("hidden", !pr);
    if (pr) {
      $("pb-nom").value = pr.nom;
      $("pb-niv").value = pr.niveaux ?? "";
      $("pb-h").value = pr.hauteur;
    }
    renderList();
  }

  function deleteProject(pr) {
    if (pr.layer) pr.layer.remove();
    P.projects = P.projects.filter((p) => p !== pr);
    if (P.selected === pr) select(null);
    changed();
  }

  function renderList() {
    $("cal-list").innerHTML = P.projects.map((p) => `
      <li data-id="${p.id}" class="${p === P.selected ? "sel" : ""}">
        <b>${escapeHtml(p.nom)}</b> · ${fmt(p.hauteur, 1)} m${p.niveaux ? ` (${p.niveaux} niv.)` : ""}
        <span class="muted">${p.surf ? ` · ${fmt(p.surf, 0)} m²` : ""}${p.alt !== null && p.alt !== undefined ? ` · sol ${fmt(p.alt, 1)} m` : ""}</span>
        ${p.out ? `<span class="warn" data-tip="Emprise hors de la zone d'étude : pas d'altitude du sol (ALT_SOL vide). Agrandir la zone et relancer l'extraction si le bâtiment doit être modélisé.">· hors zone</span>` : ""}
      </li>`).join("") || `<li class="muted">Aucun bâtiment projeté.</li>`;
    const n = P.covered.filter((id) => !P.demolis.has(id)).length;
    $("cal-covered").textContent = `Démolir les bâtiments recouverts (${n})`;
    $("cal-covered").disabled = n === 0;
  }

  function summary() {
    const info = $("proj-info");
    const n = P.projects.length, d = P.demolis.size;
    info.className = n ? "info" : "info muted";
    info.textContent = n || d
      ? `${n} bâtiment${n > 1 ? "s" : ""} projeté${n > 1 ? "s" : ""}, ${d} démoli${d > 1 ? "s" : ""}`
        + (P.plan ? ` — plan : ${P.plan.name}` : "")
      : P.plan ? `Plan chargé : ${P.plan.name}. Aucun bâtiment projeté.` : "Aucun bâtiment projeté.";
    $("plan-reopen").textContent = P.plan || n || d ? "Rouvrir l'éditeur" : "Ouvrir l'éditeur";
  }

  function updateMainLayer() {
    if (!mainGroup) mainGroup = L.layerGroup().addTo(map);
    mainGroup.clearLayers();
    P.projects.forEach((p) => L.polygon(p.ring, { ...STYLE.project, interactive: false }).addTo(mainGroup));
  }

  // ---------- Synchronisation avec l'extraction (aperçu 3D et ZIP) ----------

  let syncTimer = null, syncPromise = Promise.resolve();

  function changed() {
    P.touched = true;
    renderList();
    summary();
    updateMainLayer();
    resetZip();
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncTimer = null; syncPromise = sync(); }, 300);
  }

  async function sync() {
    if (!job || !P.touched) return;
    const body = {
      mode: $("proj-mode").value,
      demolis: [...P.demolis],
      buildings: P.projects.map((p) => ({
        id: p.id, nom: p.nom, hauteur: p.hauteur, niveaux: p.niveaux || null, plan: p.plan,
        geometry: { type: "Polygon", coordinates: [[...p.ring, p.ring[0]].map(([lat, lng]) => [lng, lat])] },
      })),
    };
    try {
      const r = await fetch(`/api/jobs/${job.id}/projets`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail));
      const out = new Set(d.hors_zone);
      P.projects.forEach((p) => { p.alt = d.alt_sol[p.id]; p.surf = d.surface[p.id]; p.out = out.has(p.id); });
      P.covered = d.recouverts;
      renderList();
      summary();
    } catch (err) {
      const info = $("proj-info");
      info.className = "info err";
      info.textContent = `Bâtiments projetés non enregistrés : ${err.message}`;
      message(`Non enregistré : ${err.message}`, "err");
    }
  }

  window.flushProjects = async () => {
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; syncPromise = sync(); }
    await syncPromise;
  };

  // Nouvelle extraction : les saisies (en WGS84) sont rattachées à la nouvelle zone.
  window.onExtraction = () => {
    $("proj-section").classList.remove("hidden");
    P.viewSet = false;
    if (P.touched) syncPromise = sync();
  };

  // ---------- Modes, messages, ouverture ----------

  function message(text, cls = "", ms = 0) {
    const el = $("cal-msg");
    el.textContent = text;
    el.className = text ? cls : "hidden";
    clearTimeout(message.t);
    if (ms) message.t = setTimeout(() => setMode(P.mode), ms);
  }

  function setMode(mode) {
    if (P.mode === "draw" && mode !== "draw") drawCleanup();
    if (mode === "draw" && P.mode !== "draw") drawStart();
    P.mode = mode;
    const btn = { "pick-plan": "cal-add", "pick-map": "cal-add", crop: "cal-crop", draw: "cal-draw", take: "cal-take", demol: "cal-demol" };
    Object.values(btn).forEach((id) => $(id).classList.remove("active"));
    if (btn[mode]) $(btn[mode]).classList.add("active");
    $("cal-plan-wrap").classList.toggle("cross", mode === "pick-plan");
    $("cal-map-wrap").classList.toggle("cross", ["pick-map", "draw", "take", "demol"].includes(mode));
    if (calMap) {
      if (mode !== "pick-plan") showSnap(planMap, snapPlanMk, null);
      if (!["pick-map", "draw"].includes(mode)) showSnap(calMap, snapMapMk, null);
    }
    const n = P.pairs.length + 1;
    const texts = {
      "pick-plan": `Point ${n} : cliquez sur le PLAN (à gauche) un point bien identifiable : coin de bâtiment existant, `
        + `angle de lot, borne.${P.plan && P.plan.dxf ? " Accrochage aux sommets du DXF." : ""} Échap : annuler.`,
      "pick-map": `Point ${n} : cliquez le MÊME point sur la CARTE (à droite). Accrochage aux coins des bâtiments `
        + "existants (jaune). Échap : annuler.",
      crop: "Rognage : tracez sur le plan (à gauche) un rectangle autour de la partie utile (sans cartouche ni légende).",
      draw: "Tracé : cliquez les sommets (accrochage au plan et aux bâtiments). Double-clic ou clic sur le premier "
        + "sommet pour fermer. Retour arrière : dernier sommet. Échap : abandon.",
      take: "Cliquez à l'intérieur d'une polyligne fermée du DXF pour en faire une emprise projetée. Échap : terminer.",
      demol: "Cliquez un bâtiment existant pour le marquer démoli (rouge) ou l'annuler. Échap : terminer.",
    };
    let text = texts[mode] || "", cls = "";
    if (!mode) {
      cls = "muted";
      if (!P.plan) text = "Importez un plan (PDF ou DXF), ou tracez directement les emprises sur la carte.";
      else if (!P.fit) text = "Ajoutez des points de calage : 3 ou 4 points bien répartis autour du projet.";
    }
    message(text, cls);
  }

  function cancelMode() {
    if (P.pending) { P.pending.pm.remove(); P.pending = null; renderPairs(); }
    if (planMap) planMap.pm.disableDraw();
    setMode(null);
  }

  function toggleMode(mode) {
    if (P.mode === mode || (mode === "pick-plan" && P.mode === "pick-map")) { cancelMode(); return; }
    cancelMode();
    if (mode === "take" && !P.fit) { message("Calez d'abord le plan (points de calage).", "warn", 2500); return; }
    if (mode === "crop") {
      planMap.pm.enableDraw("Rectangle", {
        snappable: false, pathOptions: { color: "#ff3b30", weight: 2, dashArray: "6 4", fill: false },
      });
    }
    setMode(mode);
  }

  function onMapClick(e) {
    switch (P.mode) {
      case "pick-map": completePair(e.latlng); break;
      case "draw": drawClick(e.latlng); break;
      case "take": takeAt(e.latlng); break;
      case "demol": toggleDemolish(e.latlng); break;
      case null: select(projectAt(e.latlng) || null); break;
      default: break;
    }
  }

  async function openEditor() {
    if (!job) return;
    $("calage").classList.remove("hidden");
    initMaps();
    planMap.invalidateSize();
    calMap.invalidateSize();
    try {
      if (P.jobId !== job.id) await loadExisting();
    } catch (err) {
      message(`Bâtiments existants indisponibles : ${err.message}`, "err");
    }
    if (!P.viewSet) {
      P.viewSet = true;
      const b = P.projects.length ? projGroup.getBounds() : zone ? zone.getBounds() : map.getBounds();
      calMap.fitBounds(b, { maxZoom: 18 });
    }
    renderPlanControls();
    renderPairs();
    renderStats();
    renderList();
    setMode(null);
  }

  function closeEditor() {
    cancelMode();
    select(null);
    $("calage").classList.add("hidden");
    window.flushProjects();
  }

  // ---------- Utilitaires ----------

  function fmt(v, nd) {
    return Number(v).toLocaleString("fr-CA", { minimumFractionDigits: nd, maximumFractionDigits: nd });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- Branchements ----------

  $("plan-file").onchange = (e) => { if (e.target.files[0]) importPlan(e.target.files[0]); };
  $("plan-reopen").onclick = openEditor;
  $("proj-mode").onchange = () => { if (P.projects.length) changed(); };
  $("cal-close").onclick = closeEditor;
  $("cal-help").onclick = () => openHelp("h-projets");
  $("cal-toggle-plan").onclick = () => {
    const hidden = $("cal-body").classList.toggle("no-plan");
    $("cal-toggle-plan").textContent = hidden ? "Afficher le plan source" : "Masquer le plan source";
    calMap.invalidateSize();
    if (!hidden) planMap.invalidateSize();
  };
  $("cal-page").onchange = async (e) => {
    const plan = P.plan;
    P.pairs.forEach((p) => { p.pm.remove(); p.mm.remove(); });
    P.pairs = [];
    P.fit = P.fitInfo = null;
    if (cropLayer) { cropLayer.remove(); cropLayer = null; }
    P.crop = null;
    plan.pdf.page = Number(e.target.value);
    try { await showPlan(); } catch (err) { message(`Page non affichée : ${err.message}`, "err"); }
  };
  $("cal-layers").onchange = (e) => {
    const i = Number(e.target.dataset.layer);
    if (e.target.checked) P.plan.dxf.hidden.delete(i); else P.plan.dxf.hidden.add(i);
    drawDxfPlan();
    refreshOverlay();
  };
  $("cal-crop").onclick = () => toggleMode("crop");
  $("cal-uncrop").onclick = () => {
    if (cropLayer) { cropLayer.remove(); cropLayer = null; }
    P.crop = null;
    refreshOverlay();
  };
  $("cal-add").onclick = () => toggleMode("pick-plan");
  $("cal-method").onchange = runFit;
  $("cal-pairs").onclick = (e) => {
    const del = e.target.closest("[data-del]");
    if (del) { removePair(Number(del.dataset.del)); return; }
    const row = e.target.closest("tr[data-i]");
    if (row) {
      const p = P.pairs[Number(row.dataset.i)];
      planMap.panTo(p.pm.getLatLng());
      calMap.panTo(p.mm.getLatLng());
    }
  };
  ["cal-show", "cal-multiply"].forEach((id) => { $(id).onchange = applyOverlayStyle; });
  $("cal-opacity").oninput = applyOverlayStyle;
  $("cal-draw").onclick = () => toggleMode("draw");
  $("cal-take").onclick = () => toggleMode("take");
  $("cal-demol").onclick = () => toggleMode("demol");
  $("cal-covered").onclick = () => {
    P.covered.forEach((id) => P.demolis.add(id));
    restyleExisting();
    changed();
  };
  $("cal-list").onclick = (e) => {
    const li = e.target.closest("li[data-id]");
    const pr = li && P.projects.find((p) => p.id === li.dataset.id);
    if (!pr) return;
    select(pr);
    calMap.fitBounds(pr.layer.getBounds(), { maxZoom: 20, padding: [60, 60] });
  };
  $("pb-nom").oninput = (e) => {
    const pr = P.selected, v = e.target.value.trim();
    if (!pr || !v) return;
    pr.nom = v.slice(0, 100);
    labelProject(pr);
    changed();
  };
  $("pb-niv").oninput = (e) => {
    const pr = P.selected, v = Number(e.target.value);
    if (!pr) return;
    if (e.target.value === "") { pr.niveaux = null; changed(); return; }
    if (!Number.isInteger(v) || v < 1 || v > 150) return;
    pr.niveaux = P.lastLevels = v;
    pr.hauteur = P.lastHeight = v * LEVEL_H;
    $("pb-h").value = pr.hauteur;
    labelProject(pr);
    changed();
  };
  $("pb-h").oninput = (e) => {
    const pr = P.selected, v = Number(e.target.value);
    if (!pr || !(v > 0 && v <= 300)) return;
    pr.hauteur = P.lastHeight = v;
    labelProject(pr);
    changed();
  };
  $("pb-del").onclick = () => { if (P.selected) deleteProject(P.selected); };

  document.addEventListener("keydown", (e) => {
    if ($("calage").classList.contains("hidden") || $("help").open) return;
    const typing = e.target instanceof Element && e.target.matches("input, select, textarea");
    if (e.key === "Escape") { cancelMode(); e.preventDefault(); }
    else if (e.key === "Backspace" && P.mode === "draw" && !typing) { drawUndo(); e.preventDefault(); }
    else if (e.key === "Enter" && P.mode === "draw" && !typing) drawFinish();
  });

  summary();
})();
