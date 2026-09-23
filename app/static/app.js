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
L.control.layers({ "Plan (OSM)": osm, "Imagerie": ortho }).addTo(map);
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

$("go").onclick = async () => {
  if (!zone) return;
  const layers = [...document.querySelectorAll("input[name=layer]:checked")].map((i) => i.value);
  if (!layers.length) { log("Sélectionnez au moins une couche.", "err"); return; }
  const body = {
    geometry: zoneGeometry(),
    layers,
    contour_interval: Number($("interval").value),
    dem_resolution: $("resolution").value ? Number($("resolution").value) : null,
    smoothing_m: Number($("smoothing").value),
    default_height: Number($("default-height").value) || 6,
    crs: $("crs").value,
    dem_grid: $("dem-grid").checked,
    traffic: $("traffic").checked,
  };
  $("log").innerHTML = "";
  $("results").classList.add("hidden");
  $("go").disabled = true;
  $("go").textContent = "Extraction en cours…";
  try {
    const r = await fetch("/api/extract", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail ? JSON.stringify(d.detail) : r.statusText);
    await poll(d.job_id);
  } catch (err) {
    log(`Erreur : ${err.message}`, "err");
  } finally {
    $("go").textContent = "Générer le ZIP";
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
      log("ZIP prêt.", "ok");
      $("download").href = `/api/jobs/${jobId}/download`;
      $("open-3d").onclick = () => window.openViewer(jobId);
      $("results").classList.remove("hidden");
      $("download").click();
      return;
    }
    if (d.status === "erreur") { log(d.error, "err"); return; }
    await new Promise((res) => setTimeout(res, 1500));
  }
}

updateZone();
