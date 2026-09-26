"use strict";
// Bâtiments projetés : import d'un plan (PDF ou DXF), calage par points sur les emprises existantes,
// superposition sur la carte (transparence, rognage), saisie des emprises et des démolitions.
// Utilise les globales de app.js : $, job, openHelp, resetZip, mainBounds, setMainProjects, et carto.js.
// Deux cartes OpenLayers : le plan dans ses propres unités, la carte dans la projection de l'extraction.

(() => {
  const VIOLET = "#7c3aed";
  const DXF_COLOR = "#d6007e";
  const SNAP_PX = 10;
  const LEVEL_H = 3;

  const stroke = (color, width, lineDash) => new ol.style.Stroke({ color, width, lineDash });
  const fill = (color) => new ol.style.Fill({ color });
  const STYLE = {
    existing: new ol.style.Style({ stroke: stroke("#f5c400", 1.5), fill: fill("rgba(245, 196, 0, 0.08)") }),
    demolished: new ol.style.Style({ stroke: stroke("#e02424", 2, [4, 3]), fill: fill("rgba(224, 36, 36, 0.35)") }),
    project: { stroke: stroke(VIOLET, 2), fill: fill("rgba(124, 58, 237, 0.25)") },
    selected: { stroke: stroke("#ff2bd6", 3), fill: fill("rgba(124, 58, 237, 0.35)") },
    crop: new ol.style.Style({ stroke: stroke("#ff3b30", 2, [6, 4]) }),
    snap: new ol.style.Style({ image: new ol.style.Circle({ radius: 7, stroke: stroke("#ff3b30", 2) }) }),
    draw: new ol.style.Style({
      stroke: stroke(VIOLET, 2), fill: fill("rgba(124, 58, 237, 0.12)"),
      image: new ol.style.Circle({ radius: 4, fill: fill(VIOLET) }),
    }),
  };

  const P = {
    plan: null,       // { name, kind, pdf: {id, pages, page, w, h, dpi, url, img}, dxf: {...} }
    crop: null,       // [xmin, ymin, xmax, ymax] en coordonnées plan (y vers le haut)
    pairs: [],        // { p: [x, y], ll: [lat, lng], pf, mf } : points plan et carte, et leurs objets
    pending: null,    // paire dont seul le point plan est posé
    fit: null,        // réponse de /api/calage (ok)
    fitInfo: null,    // dernière réponse, même en échec
    mode: null,       // pick-plan | pick-map | crop | draw | take | demol
    projects: [],     // { id, nom, niveaux, hauteur, plan, ring: [[lat, lng]], feature, alt, surf }
    demolis: new Set(),
    covered: [],
    selected: null,
    existSnap: null, planSnap: null,
    jobId: null, viewSet: false, touched: false,
    lastHeight: 9, lastLevels: null, seq: 0,
  };

  // ---------- Géométrie ----------

  // Affine plan -> carte : X = a x + b y + c ; Y = d x + e y + f (projection de la carte de l'éditeur).
  const toView = (A, x, y) => [A[0] * x + A[1] * y + A[2], A[3] * x + A[4] * y + A[5]];
  function toPlan(A, X, Y) {
    const [a, b, c, d, e, f] = A, det = a * e - b * d;
    return [(e * (X - c) - b * (Y - f)) / det, (-d * (X - c) + a * (Y - f)) / det];
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
  const pairsOf = (xy) => { const pts = []; for (let i = 0; i < xy.length; i += 2) pts.push([xy[i], xy[i + 1]]); return pts; };

  // Accrochage des clics (points de calage) : sommets à moins de SNAP_PX pixels.
  const tolOf = (m) => SNAP_PX * m.getView().getResolution();
  const snapPlan = (c) => (P.plan && P.plan.dxf ? snapVertex(c, [P.planSnap], tolOf(planMap)) : null);
  const snapExisting = (c) => snapVertex(c, [P.existSnap], tolOf(calMap));

  // Carte de l'éditeur <-> [lat, lng] (les saisies sont gardées en WGS84).
  let calCode = null;
  const llToView = ([lat, lng]) => ol.proj.fromLonLat([lng, lat], calCode);
  const viewToLl = (c) => { const [lng, lat] = ol.proj.toLonLat(c, calCode); return [lat, lng]; };

  // ---------- Cartes de l'éditeur ----------

  let planMap, calMap;
  const planImage = new ol.layer.Image({ zIndex: 0, visible: false });
  const planDxf = new ol.layer.VectorImage({ zIndex: 0, source: new ol.source.Vector(), style: new ol.style.Style({ stroke: stroke("#1d2330", 1) }) });
  const cropSource = new ol.source.Vector();
  const planPairs = new ol.source.Vector(), mapPairs = new ol.source.Vector();
  const planSnapMk = new ol.Feature(), mapSnapMk = new ol.Feature();
  const existingSource = new ol.source.Vector();
  const dxfMapSource = new ol.source.Vector();
  const projSource = new ol.source.Vector();
  const selection = new ol.Collection();       // emprise projetée en cours de modification
  const otherProjects = new ol.Collection();   // accrochage : les autres emprises projetées
  let overlaySource, overlayLayer, dxfMapLayer, drawProj = null, drawCrop = null, snaps = [];

  function pairStyle(f) {
    const color = "#ff3b30";
    return [
      new ol.style.Style({
        image: new ol.style.Circle({ radius: 8, stroke: stroke(color, 2, f.get("pending") ? [3, 3] : undefined), fill: fill("rgba(255, 255, 255, 0.35)") }),
        text: new ol.style.Text({
          text: String(f.get("n")), offsetX: 13, offsetY: -12, font: "bold 12px system-ui, 'Segoe UI', sans-serif",
          fill: fill(color), stroke: stroke("#fff", 3),
        }),
      }),
      new ol.style.Style({ image: new ol.style.Circle({ radius: 1.5, fill: fill(color) }) }),
    ];
  }

  function projectStyle(f) {
    const pr = f.get("pr"), s = pr === P.selected ? STYLE.selected : STYLE.project;
    return [
      new ol.style.Style({ stroke: s.stroke, fill: s.fill }),
      new ol.style.Style({
        geometry: (g) => g.getGeometry().getInteriorPoint(),
        text: new ol.style.Text({
          text: `${pr.nom}\n${fmt(pr.hauteur, 1)} m`, font: "600 12px system-ui, 'Segoe UI', sans-serif",
          fill: fill("#3b0764"), stroke: stroke("#fff", 3), overflow: true,
        }),
      }),
    ];
  }

  function initMaps() {
    if (calMap) return;
    planMap = new ol.Map({
      target: "cal-plan",
      layers: [
        planImage, planDxf,
        new ol.layer.Vector({ source: cropSource, style: STYLE.crop, zIndex: 5 }),
        new ol.layer.Vector({ source: planPairs, style: pairStyle, zIndex: 10 }),
        new ol.layer.Vector({ source: new ol.source.Vector({ features: [planSnapMk] }), style: STYLE.snap, zIndex: 11 }),
      ],
      controls: ol.control.defaults.defaults({ attribution: false, rotate: false }),
      interactions: ol.interaction.defaults.defaults({ doubleClickZoom: false }),
    });

    const { osm, ortho } = baseLayers();
    ortho.setVisible(true);
    osm.setVisible(false);
    overlaySource = new ol.source.ImageCanvas({ canvasFunction: drawOverlay, ratio: 1 });
    overlayLayer = new ol.layer.Image({ source: overlaySource, zIndex: 20, className: "cal-plan-layer" });
    dxfMapLayer = new ol.layer.VectorImage({
      source: dxfMapSource, zIndex: 21, className: "cal-plan-layer", style: new ol.style.Style({ stroke: stroke(DXF_COLOR, 1.2) }),
    });
    calMap = new ol.Map({
      target: "cal-map",
      layers: [
        osm, ortho,
        new ol.layer.Vector({ source: existingSource, zIndex: 10, style: (f) => (P.demolis.has(f.get("ID_BAT")) ? STYLE.demolished : STYLE.existing) }),
        overlayLayer, dxfMapLayer,
        new ol.layer.Vector({ source: projSource, zIndex: 30, style: projectStyle }),
        new ol.layer.Vector({ source: mapPairs, style: pairStyle, zIndex: 40 }),
        new ol.layer.Vector({ source: new ol.source.Vector({ features: [mapSnapMk] }), style: STYLE.snap, zIndex: 41 }),
      ],
      view: viewIn(calCode),
      controls: ol.control.defaults.defaults({ attributionOptions: { collapsible: false } })
        .extend([new ol.control.ScaleLine({ units: "metric" }), baseSwitch(osm, ortho)]),
      interactions: ol.interaction.defaults.defaults({ doubleClickZoom: false }),
    });

    // Points de calage déplaçables ; un point lâché s'accroche, puis le calage est recalculé.
    const planDrag = new ol.interaction.Translate({ layers: (l) => l.getSource() === planPairs, hitTolerance: 6 });
    planDrag.on("translateend", (e) => e.features.forEach((f) => {
      const pair = f.get("pair"), s = snapPlan(f.getGeometry().getCoordinates());
      if (s) f.getGeometry().setCoordinates(s);
      pair.p = f.getGeometry().getCoordinates().slice();
      if (pair.ll) runFit();
    }));
    planMap.addInteraction(planDrag);
    const mapDrag = new ol.interaction.Translate({ layers: (l) => l.getSource() === mapPairs, hitTolerance: 6 });
    mapDrag.on("translateend", (e) => e.features.forEach((f) => {
      const pair = f.get("pair"), s = snapExisting(f.getGeometry().getCoordinates());
      if (s) f.getGeometry().setCoordinates(s);
      pair.ll = viewToLl(f.getGeometry().getCoordinates());
      runFit();
    }));
    calMap.addInteraction(mapDrag);

    // Emprise projetée sélectionnée : sommets déplaçables, avec accrochage (plan calé, existants, autres projets).
    const modify = new ol.interaction.Modify({ features: selection });
    modify.on("modifyend", () => {
      const pr = P.selected;
      if (!pr) return;
      pr.ring = pr.feature.getGeometry().getCoordinates()[0].slice(0, -1).map(viewToLl);
      changed();
    });
    calMap.addInteraction(modify);
    addSnaps();

    // Rognage : rectangle sur le plan, coins déplaçables.
    boxEditor(planMap, () => cropSource.getFeatures()[0] || null, updateCrop, () => {});

    planMap.on("click", onPlanClick);
    planMap.on("pointermove", (e) => {
      if (e.dragging) return;
      showSnap(planSnapMk, P.mode === "pick-plan" ? snapPlan(e.coordinate) : null);
    });
    calMap.on("click", onMapClick);
    calMap.on("pointermove", (e) => {
      if (e.dragging) return;
      showSnap(mapSnapMk, P.mode === "pick-map" ? snapExisting(e.coordinate) : null);
    });
    applyOverlayStyle();
  }

  // Accrochage OpenLayers (tracé et modification des emprises) : à ajouter après les interactions concernées.
  function addSnaps() {
    snaps.forEach((s) => calMap.removeInteraction(s));
    snaps = [
      new ol.interaction.Snap({ source: dxfMapSource, pixelTolerance: SNAP_PX }),
      new ol.interaction.Snap({ source: existingSource, pixelTolerance: SNAP_PX }),
      new ol.interaction.Snap({ features: otherProjects, pixelTolerance: SNAP_PX }),
    ];
    snaps.forEach((s) => calMap.addInteraction(s));
  }
  function refreshOtherProjects() {
    otherProjects.clear();
    P.projects.forEach((p) => { if (p !== P.selected && p.feature) otherProjects.push(p.feature); });
  }

  function baseSwitch(osm, ortho) {
    const el = document.createElement("div");
    el.className = "map-layers ol-unselectable ol-control";
    el.innerHTML = `<label><input type="radio" name="cal-base" value="osm"> Plan (OSM)</label>
      <label><input type="radio" name="cal-base" value="ortho" checked> Imagerie</label>`;
    el.querySelectorAll("input").forEach((i) => {
      i.onchange = () => { osm.setVisible(i.value === "osm"); ortho.setVisible(i.value === "ortho"); };
    });
    return new ol.control.Control({ element: el });
  }

  function showSnap(mk, c) { mk.setGeometry(c ? new ol.geom.Point(c) : undefined); }

  // ---------- Emprises existantes (jaune) et démolitions (rouge) ----------

  async function loadExisting() {
    P.jobId = job.id;
    P.existSnap = null;
    existingSource.clear();
    const r = await fetch(`/api/jobs/${job.id}/batiments`);
    const fc = await r.json();
    if (!r.ok) throw new Error(fc.detail || r.statusText);
    const features = geojson.readFeatures(fc, { featureProjection: calCode });
    existingSource.addFeatures(features);
    const rings = [];
    features.forEach((f) => {
      const g = f.getGeometry();
      (g.getType() === "Polygon" ? [g.getCoordinates()] : g.getCoordinates()).forEach((poly) => rings.push(...poly));
    });
    P.existSnap = flatCoords(rings);
  }

  const existingAt = (c) => existingSource.getFeaturesAtCoordinate(c)[0] || null;

  function toggleDemolish(c) {
    const f = existingAt(c);
    if (!f) { message("Aucun bâtiment existant sous le clic.", "warn", 2500); return; }
    const id = f.get("ID_BAT");
    if (P.demolis.has(id)) P.demolis.delete(id); else P.demolis.add(id);
    existingSource.changed();
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

  function clearPairs() {
    planPairs.clear();
    mapPairs.clear();
    P.pairs = [];
    P.fit = P.fitInfo = null;
  }

  function resetPlan() {
    cancelMode();
    clearPairs();
    cropSource.clear();
    P.crop = null;
    planImage.setVisible(false);
    planDxf.setSource(new ol.source.Vector());
    dxfMapSource.clear();
    P.planSnap = null;
    P.plan = null;
    refreshOverlay();
  }

  // Le plan est affiché dans ses propres unités : pixels de l'image (y vers le haut, de -h à 0) ou unités du DXF.
  function planView(extent) {
    const projection = new ol.proj.Projection({ code: `plan-${Date.now()}`, units: "pixels", extent });
    planMap.setView(new ol.View({ projection, constrainResolution: false, maxZoom: 40 }));
    planMap.getView().fit(extent, { padding: [20, 20, 20, 20] });
    return projection;
  }

  async function showPlan() {
    const plan = P.plan;
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
      Object.assign(pdf, { w: img.naturalWidth, h: img.naturalHeight, dpi: pg.dpi, img });
      const extent = [0, -pdf.h, pdf.w, 0];
      const projection = planView(extent);
      planDxf.setSource(new ol.source.Vector());
      planImage.setSource(new ol.source.ImageStatic({ url: pdf.url, imageExtent: extent, projection }));
      planImage.setVisible(true);
    } else {
      planImage.setVisible(false);
      planView(plan.dxf.bbox);
      drawDxfPlan();
    }
    renderPlanControls();
    renderPairs();
    renderStats();
    refreshOverlay();
    setMode(null);
  }

  function drawDxfPlan() {
    const vis = visibleLines();
    planDxf.setSource(new ol.source.Vector({ features: [new ol.Feature(new ol.geom.MultiLineString(vis.map((l) => pairsOf(l.xy))))] }));
    P.planSnap = flatCoords(vis.map((l) => pairsOf(l.xy)));
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

  function onCropDrawn(e) {
    cropSource.clear();
    cropSource.addFeature(e.feature);
    updateCrop();
    setMode(null);
  }
  function updateCrop() {
    const f = cropSource.getFeatures()[0];
    P.crop = f ? f.getGeometry().getExtent() : null;
    refreshOverlay();
  }

  // ---------- Points de calage ----------

  function pairFeature(source, coord, n, pair, pending) {
    const f = new ol.Feature({ geometry: new ol.geom.Point(coord), n, pending, pair });
    source.addFeature(f);
    return f;
  }

  function onPlanClick(e) {
    if (P.mode !== "pick-plan") return;
    const c = snapPlan(e.coordinate) || e.coordinate;
    const pair = { p: c.slice(), ll: null };
    pair.pf = pairFeature(planPairs, c, P.pairs.length + 1, pair, true);
    P.pending = pair;
    setMode("pick-map");
  }

  function completePair(coord) {
    const c = snapExisting(coord) || coord;
    const pair = P.pending;
    P.pending = null;
    pair.ll = viewToLl(c);
    pair.pf.set("pending", false);
    pair.mf = pairFeature(mapPairs, c, P.pairs.length + 1, pair, false);
    P.pairs.push(pair);
    setMode(null);
    renderPairs();
    runFit();
  }

  function removePair(i) {
    const [p] = P.pairs.splice(i, 1);
    planPairs.removeFeature(p.pf);
    mapPairs.removeFeature(p.mf);
    P.pairs.forEach((q, k) => { q.pf.set("n", k + 1); q.mf.set("n", k + 1); });
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
            view_epsg: Number(calCode.split(":")[1]),
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
    const show = $("cal-show").checked, opacity = Number($("cal-opacity").value) / 100;
    [overlayLayer, dxfMapLayer].forEach((l) => { l.setVisible(show); l.setOpacity(opacity); });
    $("cal-map-wrap").classList.toggle("multiply", $("cal-multiply").checked);
    $("cal-opacity-val").textContent = `${$("cal-opacity").value} %`;
  }

  // Image du plan PDF déformée par l'affine de calage (plan -> carte), rognée, dessinée à chaque rendu.
  function drawOverlay(extent, resolution, pixelRatio, size) {
    const canvas = document.createElement("canvas");
    canvas.width = size[0];
    canvas.height = size[1];
    const A = P.fit && P.fit.affine_view, pdf = P.plan && P.plan.pdf;
    if (!A || !pdf || !pdf.img) return canvas;
    const ctx = canvas.getContext("2d");
    const k = size[0] / (extent[2] - extent[0]);
    // Pixel (i, j) de l'image = point (i, -j) du plan.
    ctx.setTransform(k * A[0], -k * A[3], -k * A[1], k * A[4], k * (A[2] - extent[0]), k * (extent[3] - A[5]));
    if (P.crop) {
      const [x0, y0, x1, y1] = P.crop;
      ctx.beginPath();
      ctx.rect(x0, -y1, x1 - x0, y1 - y0);
      ctx.clip();
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(pdf.img, 0, 0);
    return canvas;
  }

  function refreshOverlay() {
    if (!calMap) return;
    const A = P.fit && P.fit.affine_view;
    overlaySource.changed();
    dxfMapSource.clear();
    if (!A || !P.plan || !P.plan.dxf) return;
    const lines = [];
    visibleLines().forEach((l) => {
      (P.crop ? clipLine(l.xy, P.crop) : [l.xy]).forEach((xy) => {
        const pts = [];
        for (let i = 0; i < xy.length; i += 2) pts.push(toView(A, xy[i], xy[i + 1]));
        lines.push(pts);
      });
    });
    dxfMapSource.addFeature(new ol.Feature(new ol.geom.MultiLineString(lines)));
  }

  // ---------- Tracé d'une emprise ----------

  function drawStart() {
    otherProjects.clear();
    P.projects.forEach((p) => { if (p.feature) otherProjects.push(p.feature); });
    drawProj = new ol.interaction.Draw({ type: "Polygon", style: STYLE.draw });
    drawProj.on("drawend", (e) => {
      const ring = e.feature.getGeometry().getCoordinates()[0].slice(0, -1).map(viewToLl);
      setTimeout(() => {
        setMode(null);
        if (ring.length >= 3) addProject(ring);
        else message("Il faut au moins 3 sommets.", "warn", 2500);
      });
    });
    calMap.addInteraction(drawProj);
    addSnaps();
  }
  function drawCleanup() {
    if (drawProj) calMap.removeInteraction(drawProj);
    drawProj = null;
  }

  // Prend une polyligne fermée du DXF sous le clic (la plus petite qui contient le point).
  function takeAt(coord) {
    const A = P.fit && P.fit.affine_view;
    if (!A) return;
    const [x, y] = toPlan(A, coord[0], coord[1]);
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
    for (let i = 0; i < best.xy.length - 2; i += 2) ring.push(viewToLl(toView(A, best.xy[i], best.xy[i + 1])));
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
    if (!calMap) return;
    pr.feature = new ol.Feature({ geometry: new ol.geom.Polygon([[...pr.ring, pr.ring[0]].map(llToView)]), pr });
    projSource.addFeature(pr.feature);
  }
  function labelProject(pr) {
    if (pr.feature) pr.feature.changed();
  }

  const projectAt = (c) => { const f = projSource.getFeaturesAtCoordinate(c)[0]; return f ? f.get("pr") : null; };

  function select(pr) {
    const prev = P.selected;
    P.selected = pr;
    selection.clear();
    if (prev && prev.feature) prev.feature.changed();
    if (pr && pr.feature) {
      selection.push(pr.feature);
      pr.feature.changed();
    }
    refreshOtherProjects();
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
    if (pr.feature) projSource.removeFeature(pr.feature);
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
    setMainProjects(P.projects.map((p) => p.ring));
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
    if (P.mode === "crop" && mode !== "crop" && drawCrop) { planMap.removeInteraction(drawCrop); drawCrop = null; }
    P.mode = mode;
    const btn = { "pick-plan": "cal-add", "pick-map": "cal-add", crop: "cal-crop", draw: "cal-draw", take: "cal-take", demol: "cal-demol" };
    Object.values(btn).forEach((id) => $(id).classList.remove("active"));
    if (btn[mode]) $(btn[mode]).classList.add("active");
    $("cal-plan-wrap").classList.toggle("cross", mode === "pick-plan" || mode === "crop");
    $("cal-map-wrap").classList.toggle("cross", ["pick-map", "draw", "take", "demol"].includes(mode));
    if (calMap) {
      if (mode !== "pick-plan") showSnap(planSnapMk, null);
      if (mode !== "pick-map") showSnap(mapSnapMk, null);
    }
    const n = P.pairs.length + 1;
    const texts = {
      "pick-plan": `Point ${n} : cliquez sur le PLAN (à gauche) un point bien identifiable : coin de bâtiment existant, `
        + `angle de lot, borne.${P.plan && P.plan.dxf ? " Accrochage aux sommets du DXF." : ""} Échap : annuler.`,
      "pick-map": `Point ${n} : cliquez le MÊME point sur la CARTE (à droite). Accrochage aux coins des bâtiments `
        + "existants (jaune). Échap : annuler.",
      crop: "Rognage : tracez sur le plan (à gauche) un rectangle autour de la partie utile (sans cartouche ni légende).",
      draw: "Tracé : cliquez les sommets (accrochage aux sommets et aux côtés du plan et des bâtiments). Double-clic ou clic "
        + "sur le premier sommet pour fermer. Retour arrière : dernier sommet. Échap : abandon.",
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
    if (P.pending) { planPairs.removeFeature(P.pending.pf); P.pending = null; renderPairs(); }
    setMode(null);
  }

  function toggleMode(mode) {
    if (P.mode === mode || (mode === "pick-plan" && P.mode === "pick-map")) { cancelMode(); return; }
    cancelMode();
    if (mode === "take" && !P.fit) { message("Calez d'abord le plan (points de calage).", "warn", 2500); return; }
    if (mode === "crop") {
      drawCrop = new ol.interaction.Draw({ type: "Circle", geometryFunction: ol.interaction.Draw.createBox(), style: STYLE.crop });
      drawCrop.on("drawend", onCropDrawn);
      planMap.addInteraction(drawCrop);
    }
    setMode(mode);
  }

  function onMapClick(e) {
    switch (P.mode) {
      case "pick-map": completePair(e.coordinate); break;
      case "take": takeAt(e.coordinate); break;
      case "demol": toggleDemolish(e.coordinate); break;
      case null: select(projectAt(e.coordinate)); break;
      default: break;
    }
  }

  // Carte de l'éditeur dans la projection de l'extraction ; une nouvelle projection redessine toutes les saisies.
  function useProjection(code) {
    if (code === calCode) return;
    calCode = code;
    if (!calMap) return;
    calMap.setView(viewIn(code, calMap.getView()));
    existingSource.clear();
    P.existSnap = null;
    P.jobId = null;
    projSource.clear();
    P.projects.forEach(drawProject);
    if (P.selected) select(P.selected);
    mapPairs.clear();
    P.pairs.forEach((p, i) => { p.mf = pairFeature(mapPairs, llToView(p.ll), i + 1, p, false); });
    P.fit = null;
    refreshOverlay();
    runFit();
  }

  async function openEditor() {
    if (!job) return;
    $("calage").classList.remove("hidden");
    useProjection(job.code);
    initMaps();
    planMap.updateSize();
    calMap.updateSize();
    try {
      if (P.jobId !== job.id) await loadExisting();
    } catch (err) {
      message(`Bâtiments existants indisponibles : ${err.message}`, "err");
    }
    if (!P.viewSet) {
      P.viewSet = true;
      const extent = P.projects.length ? projSource.getExtent() : ol.proj.transformExtent(mainBounds(), WGS84, calCode);
      calMap.getView().fit(extent, { padding: [40, 40, 40, 40], minResolution: 0.3 });
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
    calMap.updateSize();
    if (!hidden) planMap.updateSize();
  };
  $("cal-page").onchange = async (e) => {
    const plan = P.plan;
    clearPairs();
    cropSource.clear();
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
    cropSource.clear();
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
      planMap.getView().animate({ center: p.p, duration: 250 });
      calMap.getView().animate({ center: llToView(p.ll), duration: 250 });
    }
  };
  ["cal-show", "cal-multiply"].forEach((id) => { $(id).onchange = applyOverlayStyle; });
  $("cal-opacity").oninput = applyOverlayStyle;
  $("cal-draw").onclick = () => toggleMode("draw");
  $("cal-take").onclick = () => toggleMode("take");
  $("cal-demol").onclick = () => toggleMode("demol");
  $("cal-covered").onclick = () => {
    P.covered.forEach((id) => P.demolis.add(id));
    existingSource.changed();
    changed();
  };
  $("cal-list").onclick = (e) => {
    const li = e.target.closest("li[data-id]");
    const pr = li && P.projects.find((p) => p.id === li.dataset.id);
    if (!pr) return;
    select(pr);
    calMap.getView().fit(pr.feature.getGeometry().getExtent(), { padding: [60, 60, 60, 60], minResolution: 0.05, duration: 250 });
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
    else if (e.key === "Backspace" && P.mode === "draw" && drawProj && !typing) { drawProj.removeLastPoint(); e.preventDefault(); }
    else if (e.key === "Enter" && P.mode === "draw" && drawProj && !typing) drawProj.finishDrawing();
  });

  summary();
})();
