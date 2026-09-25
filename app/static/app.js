"use strict";

const MAX_KM2 = 100;
const WARN_KM2 = 25;
const QC_BOUNDS = [[44.99, -79.8], [62.6, -57.1]];

const $ = (id) => document.getElementById(id);

// ---------- Carte ----------
const map = L.map("map", { maxBounds: [[40, -90], [66, -50]] }).setView([46.81, -71.22], 13);
const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: "© contributeurs OpenStreetMap",
}).addTo(map);
const ortho = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 19, attribution: "Imagerie © Esri" });
const layerControl = L.control.layers({ "Plan (OSM)": osm, "Imagerie": ortho }).addTo(map);
L.rectangle(QC_BOUNDS, { color: "#888", weight: 1, fill: false, dashArray: "4 4", interactive: false }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

map.pm.setLang("fr");
map.pm.setGlobalOptions({ pathOptions: { color: "#1f5fae", weight: 2, fillOpacity: 0.08 } });

let zone = null;

function setZone(layer) {
  if (zone && zone !== layer) map.removeLayer(zone);
  zone = layer;
  zone.on("pm:edit", updateZone);
  zone.pm.enable({ allowSelfIntersection: false });
  updateZone();
}

map.on("pm:create", (e) => { setZone(e.layer); setDrawButtons(null); });

function startDraw(shape) {
  map.pm.disableDraw();
  map.pm.enableDraw(shape, { snappable: false });
  setDrawButtons(shape);
}
function setDrawButtons(shape) {
  $("draw-rect").classList.toggle("active", shape === "Rectangle");
  $("draw-poly").classList.toggle("active", shape === "Polygon");
}
$("draw-rect").onclick = () => startDraw("Rectangle");
$("draw-poly").onclick = () => startDraw("Polygon");
$("clear").onclick = () => {
  map.pm.disableDraw(); setDrawButtons(null);
  if (zone) map.removeLayer(zone);
  zone = null; updateZone();
};

// Aire géodésique approchée (formule sphérique), en km².
function areaKm2(latlngs) {
  const R = 6378137, rad = Math.PI / 180;
  let s = 0;
  for (let i = 0; i < latlngs.length; i++) {
    const a = latlngs[i], b = latlngs[(i + 1) % latlngs.length];
    s += (b.lng - a.lng) * rad * (2 + Math.sin(a.lat * rad) + Math.sin(b.lat * rad));
  }
  return Math.abs(s * R * R / 2) / 1e6;
}

function zoneGeometry() {
  return zone.toGeoJSON().geometry;
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
  const ring = zone.getLatLngs()[0];
  const km2 = areaKm2(ring);
  const c = zone.getBounds().getCenter();
  const inQc = L.latLngBounds(QC_BOUNDS).contains(c);
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
      const r = await fetch(`/api/crs?lon=${c.lng}`);
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
    map.fitBounds([[s, w], [n, e2]], { maxZoom: 16 });
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
  const body = requestBody();
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
      job = { id: d.job_id, params: JSON.stringify(body), zip: null };
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
