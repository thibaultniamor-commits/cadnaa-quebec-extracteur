"use strict";

const MAX_KM2 = 100;
const WARN_KM2 = 25;
const QC_BOUNDS = [-79.8, 44.99, -57.1, 62.6];   // ouest, sud, est, nord (degrés)

const $ = (id) => document.getElementById(id);

// ---------- Carte (OpenLayers) ----------
// Affichage en Web Mercator ; la zone est envoyée au serveur en WGS84 (GeoJSON). WGS84, MERC : carto.js.
const toMerc = (lon, lat) => ol.proj.fromLonLat([lon, lat]);
const extentMerc = (e) => ol.proj.transformExtent(e, WGS84, MERC);
const geojson = new ol.format.GeoJSON({ dataProjection: WGS84, featureProjection: MERC });
const ZONE_COLOR = "#1f5fae";

const { osm, ortho } = baseLayers();
// Cadre du Québec : vue d'ensemble seulement (un grand pointillé redessiné à chaque image freine la carte).
const qcFrame = new ol.layer.Vector({
  zIndex: 30, minResolution: 150,
  source: new ol.source.Vector({ features: [new ol.Feature(ol.geom.Polygon.fromExtent(extentMerc(QC_BOUNDS)))] }),
  style: new ol.style.Style({ stroke: new ol.style.Stroke({ color: "#888", width: 1, lineDash: [4, 4] }) }),
});

const zoneStyle = [
  new ol.style.Style({
    stroke: new ol.style.Stroke({ color: ZONE_COLOR, width: 2 }),
    fill: new ol.style.Fill({ color: "rgba(31, 95, 174, 0.08)" }),
  }),
  new ol.style.Style({   // poignées : sommets déplaçables
    image: new ol.style.Circle({
      radius: 5, fill: new ol.style.Fill({ color: "#fff" }), stroke: new ol.style.Stroke({ color: ZONE_COLOR, width: 2 }),
    }),
    geometry: (f) => new ol.geom.MultiPoint(f.getGeometry().getCoordinates()[0].slice(0, -1)),
  }),
];
const zoneSource = new ol.source.Vector();

// Bâtiments projetés saisis dans l'éditeur (plan.js), rappelés sur la carte principale.
const projSource = new ol.source.Vector();

const map = new ol.Map({
  target: "map",
  layers: [
    osm, ortho, qcFrame,
    new ol.layer.Vector({
      source: projSource, zIndex: 40,
      style: new ol.style.Style({
        stroke: new ol.style.Stroke({ color: "#7c3aed", width: 2 }),
        fill: new ol.style.Fill({ color: "rgba(124, 58, 237, 0.25)" }),
      }),
    }),
    new ol.layer.Vector({ source: zoneSource, style: zoneStyle, zIndex: 50 }),
  ],
  view: new ol.View({ center: toMerc(-71.22, 46.81), zoom: 13, maxZoom: 19, extent: extentMerc([-90, 40, -50, 66]) }),
  controls: ol.control.defaults.defaults({ attributionOptions: { collapsible: false } })
    .extend([new ol.control.ScaleLine({ units: "metric" })]),
});

// Sélecteur de fond de carte et de couches superposées (lidar.js y ajoute les siennes).
const layerCtl = document.createElement("div");
layerCtl.className = "map-layers ol-unselectable ol-control";
layerCtl.innerHTML = `<details>
    <summary data-tip="Fond de carte et couches d'aide à la saisie de la zone.">Couches</summary>
    <fieldset><legend>Fond</legend>
      <label><input type="radio" name="basemap" value="osm" checked> Plan (OSM)</label>
      <label><input type="radio" name="basemap" value="ortho"> Imagerie</label>
    </fieldset>
    <fieldset id="map-overlays"><legend>Superpositions</legend></fieldset>
  </details>`;
map.addControl(new ol.control.Control({ element: layerCtl }));
layerCtl.querySelectorAll("input[name=basemap]").forEach((input) => {
  input.onchange = () => { osm.setVisible(input.value === "osm"); ortho.setVisible(input.value === "ortho"); };
});
function addOverlay(layer, label) {
  const row = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = layer.getVisible();
  box.onchange = () => layer.setVisible(box.checked);
  row.append(box, ` ${label}`);
  $("map-overlays").append(row);
}

// Curseur : poignée de rectangle, sinon survol d'une dalle LiDAR (lidar.js).
let cornerHover = false, tileHover = false;
function setCursor() {
  map.getTargetElement().style.cursor = cornerHover ? "move" : tileHover ? "pointer" : "";
}

// ---------- Zone d'étude : tracé et modification ----------
let zone = null;          // ol.Feature ; propriété "shape" : "Rectangle" ou "Polygon"
let drawing = null;       // interaction de tracé en cours
let drawEndedAt = 0;

// Vrai pendant un tracé et juste après (le clic qui termine le tracé n'ouvre pas de bulle).
function isDrawing() { return !!drawing || Date.now() - drawEndedAt < 500; }

// Polygone : sommets déplaçables, ajout en tirant un côté, suppression par clic droit ou Alt + clic.
const editable = new ol.Collection();
const modify = new ol.interaction.Modify({ features: editable, style: new ol.style.Style({ image: zoneStyle[1].getImage() }) });
let beforeEdit = null;
modify.on("modifystart", () => { beforeEdit = zone.getGeometry().clone(); });
modify.on("modifyend", () => {
  if (selfIntersects(zone.getGeometry())) {
    zone.setGeometry(beforeEdit);
    updateZone().then(() => alertInfo("Le polygone ne doit pas se croiser : modification annulée."));
    return;
  }
  updateZone();
});
map.addInteraction(modify);
map.getViewport().addEventListener("contextmenu", (e) => {
  if (!zone || zone.get("shape") !== "Polygon" || drawing) return;
  const pixel = map.getEventPixel(e);
  const ring = zone.getGeometry().getCoordinates()[0].slice(0, -1);
  const i = ring.findIndex((c) => {
    const p = map.getPixelFromCoordinate(c);
    return Math.hypot(p[0] - pixel[0], p[1] - pixel[1]) <= 8;
  });
  if (i < 0) return;
  e.preventDefault();
  if (ring.length <= 3) { alertInfo("Un polygone garde au moins 3 sommets."); return; }
  ring.splice(i, 1);
  const geom = new ol.geom.Polygon([[...ring, ring[0]]]);
  if (selfIntersects(geom)) { alertInfo("Le polygone ne doit pas se croiser : sommet conservé."); return; }
  zone.setGeometry(geom);
  updateZone();
});

// Rectangle : un coin se déplace, le coin opposé reste fixe, la forme reste rectangulaire.
boxEditor(map, () => (zone && zone.get("shape") === "Rectangle" && !drawing ? zone : null), () => updateZone(), (hover) => {
  cornerHover = hover;
  setCursor();
});

function setZone(feature, shape) {
  zoneSource.clear();
  editable.clear();
  feature.set("shape", shape);
  zoneSource.addFeature(feature);
  if (shape === "Polygon") editable.push(feature);
  zone = feature;
  updateZone();
}

const drawStyle = new ol.style.Style({
  stroke: new ol.style.Stroke({ color: ZONE_COLOR, width: 2, lineDash: [6, 4] }),
  fill: new ol.style.Fill({ color: "rgba(31, 95, 174, 0.08)" }),
  image: new ol.style.Circle({ radius: 4, fill: new ol.style.Fill({ color: ZONE_COLOR }) }),
});

function startDraw(shape) {
  stopDraw();
  drawing = new ol.interaction.Draw(shape === "Rectangle"
    ? { type: "Circle", geometryFunction: ol.interaction.Draw.createBox(), style: drawStyle }
    : { type: "Polygon", style: drawStyle });
  drawing.on("drawend", (e) => {
    const geom = e.feature.getGeometry();
    stopDraw();
    if (shape === "Polygon" && selfIntersects(geom)) {
      alertInfo("Le polygone ne doit pas se croiser : tracé annulé, recommencez.");
      return;
    }
    setZone(e.feature, shape);
  });
  map.addInteraction(drawing);
  setDrawButtons(shape);
}
function stopDraw() {
  if (drawing) {
    map.removeInteraction(drawing);
    drawing = null;
    drawEndedAt = Date.now();
  }
  setDrawButtons(null);
}
function setDrawButtons(shape) {
  $("draw-rect").classList.toggle("active", shape === "Rectangle");
  $("draw-poly").classList.toggle("active", shape === "Polygon");
}
$("draw-rect").onclick = () => startDraw("Rectangle");
$("draw-poly").onclick = () => startDraw("Polygon");
$("clear").onclick = () => {
  stopDraw();
  zoneSource.clear();
  editable.clear();
  zone = null;
  updateZone();
};
// Échap abandonne le tracé ; Retour arrière retire le dernier sommet du polygone.
document.addEventListener("keydown", (e) => {
  if (!drawing || e.target.closest("input, select, textarea")) return;
  if (e.key === "Escape") stopDraw();
  else if (e.key === "Backspace") { drawing.removeLastPoint(); e.preventDefault(); }
});

function zoneGeometry() {
  return geojson.writeGeometryObject(zone.getGeometry(), { decimals: 7 });
}

// Emprise [ouest, sud, est, nord] (degrés) de la zone, sinon de la vue (éditeur de calage).
function mainBounds() {
  return ol.proj.transformExtent(zone ? zone.getGeometry().getExtent() : map.getView().calculateExtent(), MERC, WGS84);
}

// Projection des shapefiles ("EPSG:2949"…) pour la zone courante : celle de l'éditeur de calage.
function outputCode() {
  const [lon] = ol.proj.toLonLat(ol.extent.getCenter(zone.getGeometry().getExtent()));
  return crsCode($("crs").value, lon);
}

// Emprises projetées, anneaux [[lat, lng], …].
function setMainProjects(rings) {
  projSource.clear();
  projSource.addFeatures(rings.map((ring) =>
    new ol.Feature(new ol.geom.Polygon([[...ring, ring[0]].map(([lat, lng]) => toMerc(lng, lat))]))));
}

async function updateZone() {
  const info = $("zone-info");
  checkStale();
  if (!zone) {
    info.className = "info muted";
    info.textContent = "Dessinez la zone sur la carte.";
    $("go").disabled = true;
    return;
  }
  const geom = zone.getGeometry();
  const km2 = ol.sphere.getArea(geom, { projection: MERC }) / 1e6;
  const [lon, lat] = ol.proj.toLonLat(ol.extent.getCenter(geom.getExtent()));
  const inQc = lon >= QC_BOUNDS[0] && lon <= QC_BOUNDS[2] && lat >= QC_BOUNDS[1] && lat <= QC_BOUNDS[3];
  let text = `Surface : ${km2.toLocaleString("fr-CA", { maximumFractionDigits: 2 })} km²`;
  let cls = "info";
  if (!inQc) { text += " — hors du Québec"; cls += " err"; }
  else if (km2 > MAX_KM2) { text += ` — maximum ${MAX_KM2} km²`; cls += " err"; }
  else if (km2 > WARN_KM2) { text += " — grande zone : extraction longue"; cls += " warn"; }
  info.className = cls;
  info.textContent = text;
  $("go").disabled = !inQc || km2 > MAX_KM2;
  if (inQc) {
    try {
      const r = await fetch(`/api/crs?lon=${lon}`);
      const d = await r.json();
      info.textContent = `${text}\nProjection auto : ${d.name} (EPSG:${d.epsg})`;
      info.style.whiteSpace = "pre-line";
    } catch { /* affichage facultatif */ }
  }
}

// ---------- Recherche d'adresse (Nominatim) ----------
$("search").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ca"
    + "&viewbox=-79.8,62.6,-57.1,44.99&bounded=1&q=" + encodeURIComponent(q);
  try {
    const res = await (await fetch(url, { headers: { "Accept-Language": "fr" } })).json();
    if (!res.length) { alertInfo("Adresse introuvable au Québec."); return; }
    const [s, n, w, e2] = res[0].boundingbox.map(Number);
    map.getView().fit(extentMerc([w, s, e2, n]), { maxZoom: 16, padding: [20, 20, 20, 20] });
  } catch { alertInfo("Recherche indisponible."); }
};
function alertInfo(msg) {
  const info = $("zone-info");
  info.className = "info warn";
  info.textContent = msg;
}

// ---------- Extraction ----------
function log(msg, cls = "") {
  const li = document.createElement("li");
  li.textContent = msg;
  if (cls) li.className = cls;
  $("log").appendChild(li);
}

function requestBody() {
  return {
    geometry: zoneGeometry(),
    layers: [...document.querySelectorAll("input[name=layer]:checked")].map((i) => i.value),
    contour_interval: Number($("interval").value),
    dem_resolution: $("resolution").value ? Number($("resolution").value) : null,
    smoothing_m: Number($("smoothing").value),
    default_height: Number($("default-height").value) || 6,
    crs: $("crs").value,
    dem_grid: $("dem-grid").checked,
    traffic: $("traffic").checked,
    dem_source: $("dem-source").value,
    footprint_source: $("footprint-source").value,
    road_attrs: $("road-attrs").checked,
    profile: ["p-jour", "p-soir", "p-nuit"].map((id) => Number($(id).value) || 0),
  };
}

// Extraction courante : sert à l'aperçu 3D et à la génération du ZIP.
let job = null;   // { id, params, zip }

// Signale que la zone ou les options ne correspondent plus à l'extraction affichée.
function checkStale() {
  if (!job) return;
  const stale = !zone || JSON.stringify(requestBody()) !== job.params;
  $("stale").classList.toggle("hidden", !stale);
  $("make-zip").disabled = stale;
  $("viewer-zip").disabled = stale;
}
$("panel").addEventListener("change", checkStale);
$("panel").addEventListener("input", checkStale);

$("go").onclick = async () => {
  if (!zone) return;
  const body = requestBody(), code = outputCode();
  if (!body.layers.length) { log("Sélectionnez au moins une couche.", "err"); return; }
  const total = body.profile.reduce((a, b) => a + b, 0);
  if (body.traffic && Math.abs(total - 100) > 0.5) {
    log(`Profil jour / soir / nuit : le total fait ${total} %, il doit faire 100 %.`, "err");
    return;
  }
  job = null;
  $("log").innerHTML = "";
  $("results").classList.add("hidden");
  $("proj-section").classList.add("hidden");
  $("go").disabled = true;
  $("go").textContent = "Extraction en cours…";
  try {
    const r = await fetch("/api/extract", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail ? JSON.stringify(d.detail) : r.statusText);
    const done = await poll(d.job_id);
    if (done) {
      job = { id: d.job_id, params: JSON.stringify(body), zip: null, code };
      renderProvenance(done.summary || {});
      $("make-zip").textContent = "Générer le ZIP";
      $("results").classList.remove("hidden");
      checkStale();
      window.onExtraction();
      window.openViewer(job.id);
    }
  } catch (err) {
    log(`Erreur : ${err.message}`, "err");
  } finally {
    $("go").textContent = "Extraire et prévisualiser";
    $("go").disabled = !zone;
  }
};

async function poll(jobId) {
  let shown = 0;
  for (;;) {
    const d = await (await fetch(`/api/jobs/${jobId}`)).json();
    d.messages.slice(shown).forEach((m) => log(m));
    shown = d.messages.length;
    if (d.status === "termine") {
      log("Données prêtes : vérifiez l'aperçu 3D, puis générez le ZIP.", "ok");
      return d;
    }
    if (d.status === "erreur") { log(d.error, "err"); return false; }
    await new Promise((res) => setTimeout(res, 1500));
  }
}

// ---------- Provenance de l'extraction ----------
const MNT_NAMES = { FORET_OUVERTE: "LiDAR Forêt ouverte (MRNF)", HRDEM: "LiDAR HRDEM (RNCan)", MRDEM: "MRDEM 30 m (RNCan)" };
const pct = (v) => `${Math.round(v * 100)} %`;
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function renderProvenance(s) {
  const rows = [];
  if (s.mnt_sources) {
    const parts = Object.entries(s.mnt_sources).filter(([, v]) => v >= 0.0005).map(([k, v]) => `${MNT_NAMES[k] || k} ${pct(v)}`);
    const years = s.mnt_annees && s.mnt_annees.length ? ` · acquisition ${s.mnt_annees.join(", ")}` : "";
    rows.push(["Relief", `${parts.join(", ")}${years} · altitudes ${s.alt_ref}`]);
  }
  if (s.emprises) {
    const e = s.emprises, n = e.retenues || {}, get = (k) => n[k] || 0;
    const osm = get("OSM_PRINCIPAL") + get("OSM_COMPLEMENT"), ref = get("REFBATI_PRINCIPAL") + get("REFBATI_COMPLEMENT");
    let t = `${osm} OpenStreetMap, ${ref} Référentiel québécois`;
    if (e.mailles) t += ` · Référentiel principal sur ${e.mailles_refbati} maille(s) de 500 m sur ${e.mailles}, OSM sur les autres`;
    if (e.refbati_annees && e.refbati_annees.length) t += ` · Référentiel : données ${e.refbati_annees.join("–")}`;
    rows.push(["Emprises", t]);
    if (e.indisponibles && e.indisponibles.length) {
      rows.push(["Attention", `source indisponible : ${e.indisponibles.map((k) => (k === "OSM" ? "OpenStreetMap" : "Référentiel")).join(", ")}`, "warn"]);
    }
  }
  if (s.hauteurs && s.batiments) {
    const h = s.hauteurs, total = s.batiments;
    const osm = (h.OSM_H || 0) + (h.OSM_NIV || 0);
    rows.push(["Hauteurs", `${pct((h.LIDAR || 0) / total)} mesurées au LiDAR (RNCan), ${pct(osm / total)} OSM, `
      + `${pct((h.DEFAUT || 0) / total)} valeur par défaut`, h.DEFAUT / total > 0.2 ? "warn" : ""]);
  }
  if (s.routes !== undefined) rows.push(["Routes", `AQréseau+ (Adresses Québec, MRNF) · ${s.routes} tronçons`]);
  if (s.sections_mtmd !== undefined) {
    rows.push(["Débits", `MTMD · DJMA sur ${s.routes_djma} tronçon(s) ; les autres sont sans débit (à compléter)`]);
  }
  if (s.routes_vit_osm !== undefined) {
    rows.push(["Vitesses", `OpenStreetMap sur ${pct(s.routes_vit_osm)} du linéaire (tronçon, rue ou voisinage) ; le reste : vitesse indicative `
      + "selon la classe et le milieu (VIT_SRC = DEFAUT), à valider", s.routes_vit_osm < 0.5 ? "warn" : ""]);
    rows.push(["Voies, revêtement", `OpenStreetMap : voies sur ${pct(s.routes_voies_osm)}, revêtement sur `
      + `${pct(s.routes_revet_osm)} du linéaire ; ailleurs valeurs par défaut`]);
    if (s.routes_osm_indisponible) rows.push(["Attention", "OpenStreetMap indisponible : valeurs par défaut partout", "warn"]);
  } else if (s.routes !== undefined) {
    rows.push(["Vitesses", "indicatives selon la classe (VIT_DEF), à valider", "muted"]);
  }
  $("provenance").innerHTML = `<div class="prov-head"><b>Provenance de cette extraction</b>
      <a href="#" id="prov-more">Détails et liens officiels</a></div>
    <dl>${rows.map(([k, v, c]) => `<dt>${k}</dt><dd class="${c || ""}">${escHtml(v)}</dd>`).join("")}</dl>`;
  $("prov-more").onclick = (e) => { e.preventDefault(); openHelp("h-provenance"); };
}

$("open-3d").onclick = () => { if (job) window.openViewer(job.id); };

// Bâtiments projetés modifiés : le ZIP déjà écrit n'est plus à jour.
function resetZip() {
  if (job) job.zip = null;
  [$("make-zip"), $("viewer-zip")].forEach((b) => { b.textContent = "Générer le ZIP"; });
}

async function makeZip() {
  if (!job) return;
  const buttons = [$("make-zip"), $("viewer-zip")];
  buttons.forEach((b) => { b.disabled = true; b.textContent = "Écriture du ZIP…"; });
  try {
    await window.flushProjects();
    if (!job.zip) {
      const r = await fetch(`/api/jobs/${job.id}/zip`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || r.statusText);
      job.zip = d.name;
      log(`ZIP généré : ${d.name}`, "ok");
    }
    $("download").href = `/api/jobs/${job.id}/download`;
    $("download").click();
    buttons.forEach((b) => { b.textContent = "Télécharger à nouveau le ZIP"; });
  } catch (err) {
    log(`Erreur : ${err.message}`, "err");
    buttons.forEach((b) => { b.textContent = "Générer le ZIP"; });
  } finally {
    checkStale();
  }
}
$("make-zip").onclick = makeZip;
$("viewer-zip").onclick = makeZip;

// ---------- Notice ----------
function openHelp(anchor) {
  const dlg = $("help");
  if (!dlg.open) dlg.showModal();
  const target = anchor && document.getElementById(anchor);
  dlg.querySelector("article").scrollTop = target ? target.offsetTop - 8 : 0;
}
$("open-help").onclick = () => openHelp();
$("open-sources").onclick = () => openHelp("h-provenance");
$("footer-sources").onclick = (e) => { e.preventDefault(); openHelp("h-provenance"); };
$("help").querySelectorAll("article a.help-link").forEach((a) => {
  a.onclick = (e) => { e.preventDefault(); openHelp(a.getAttribute("href").slice(1)); };
});
$("viewer-help").onclick = () => openHelp("h-apercu");
$("help-close").onclick = () => $("help").close();
$("help").addEventListener("click", (e) => { if (e.target === $("help")) $("help").close(); });
$("help").querySelectorAll(".help-toc a").forEach((a) => {
  a.onclick = (e) => { e.preventDefault(); openHelp(a.getAttribute("href").slice(1)); };
});

// ---------- Bulles d'aide (survol et focus des éléments [data-tip]) ----------
const tip = $("tip");
let tipTarget = null;
function showTip(el) {
  tipTarget = el;
  tip.textContent = el.dataset.tip;
  tip.classList.remove("hidden");
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const pad = 8;
  let x = Math.min(Math.max(pad, r.left), window.innerWidth - t.width - pad);
  let y = r.bottom + 6;
  if (y + t.height > window.innerHeight - pad) y = r.top - t.height - 6;
  tip.style.left = `${x}px`;
  tip.style.top = `${Math.max(pad, y)}px`;
}
function hideTip() { tipTarget = null; tip.classList.add("hidden"); }
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-tip]");
  if (el === tipTarget) return;
  if (el) showTip(el); else hideTip();
});
document.addEventListener("focusin", (e) => {
  const el = e.target.closest("[data-tip]");
  if (el) showTip(el); else hideTip();
});
document.addEventListener("focusout", hideTip);
document.addEventListener("scroll", hideTip, true);
document.addEventListener("mousedown", hideTip);

updateZone();
