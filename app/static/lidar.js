"use strict";

// ---------- Dalles LiDAR Forêt ouverte (MRNF) ----------
// Index des feuillets 1/20 000 servi par /api/lidar/dalles (cache local mis à jour depuis le MRNF)
// et relief ombré du MNT LiDAR par le WMS du MRNF.
(() => {
  // Rampe ordinale orange (validée), de l'acquisition la plus ancienne à la plus récente.
  const CLASSES = [
    { max: 2012, label: "2009 – 2012", color: "#f0a070" },
    { max: 2016, label: "2013 – 2016", color: "#e57a45" },
    { max: 2019, label: "2017 – 2019", color: "#cc5522" },
    { max: 2022, label: "2020 – 2022", color: "#a0401a" },
    { max: Infinity, label: "2023 et +", color: "#6f2a10" },
  ];
  const NO_YEAR = "#9ca3af";
  const colorOf = (an) => (an ? CLASSES.find((c) => an <= c.max).color : NO_YEAR);
  const rgba = (hex, a) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")}, ${a})`;

  let fillOpacity = 0.3;
  let hovered = null;
  const styles = new Map();   // styles partagés par couleur et épaisseur
  const style = (f) => {
    const color = colorOf(f.get("an")), width = f === hovered ? 2.5 : 1, key = `${color}|${width}`;
    if (!styles.has(key)) {
      styles.set(key, new ol.style.Style({
        stroke: new ol.style.Stroke({ color: rgba(color, Math.min(1, fillOpacity + 0.4)), width }),
        fill: new ol.style.Fill({ color: rgba(color, fillOpacity) }),
      }));
    }
    return styles.get(key);
  };

  // Au-dessus du fond et du relief ombré, sous la zone d'étude.
  const dallesSource = new ol.source.Vector();
  const dalles = new ol.layer.Vector({ source: dallesSource, style, zIndex: 20 });
  const ombre = new ol.layer.Tile({
    zIndex: 10, visible: false, opacity: 0.6,
    source: new ol.source.TileWMS({
      url: "https://geoegl.msp.gouv.qc.ca/ws/mffpecofor.fcgi",
      params: { LAYERS: "lidar_ombre", FORMAT: "image/png", TRANSPARENT: true, VERSION: "1.1.1" },
      attributions: "LiDAR © MRNF (Forêt ouverte)",
    }),
  });
  map.addLayer(ombre);
  map.addLayer(dalles);
  addOverlay(dalles, "Dalles LiDAR Forêt ouverte");
  addOverlay(ombre, "Relief ombré LiDAR (MRNF)");

  const tileAt = (pixel) => map.forEachFeatureAtPixel(pixel, (f) => f, { layerFilter: (l) => l === dalles });

  map.on("pointermove", (e) => {
    if (e.dragging) return;
    const f = isDrawing() || !dalles.getVisible() ? null : tileAt(e.pixel);
    if (f !== hovered) { hovered = f; dalles.changed(); }
    tileHover = !!f;
    setCursor();
  });

  // Bulle d'un feuillet : dates d'acquisition et liens de téléchargement.
  const bubble = document.createElement("div");
  bubble.className = "map-popup";
  const popupOverlay = new ol.Overlay({
    element: bubble, positioning: "bottom-center", offset: [0, -10], autoPan: { animation: { duration: 200 } },
  });
  map.addOverlay(popupOverlay);
  map.on("singleclick", (e) => {
    const f = isDrawing() || !dalles.getVisible() ? null : tileAt(e.pixel);
    if (!f) { popupOverlay.setPosition(undefined); return; }
    bubble.innerHTML = `<button type="button" class="map-popup-close" aria-label="Fermer">×</button>${popup(f.getProperties())}`;
    bubble.querySelector("button").onclick = () => popupOverlay.setPosition(undefined);
    popupOverlay.setPosition(e.coordinate);
  });

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function popup(p) {
    const ans = p.ans && p.ans.length ? p.ans.join(", ") : "inconnue";
    return `<div class="lidar-pop">
      <b>Feuillet ${esc(p.f)}</b> — ${esc(p.r)}<br>
      Acquisition : ${esc(ans)}<br>
      ${p.dens ? `Densité : jusqu'à ${esc(p.dens)} pt/m²<br>` : ""}
      ${p.prop ? `Source : ${esc(p.prop)}<br>` : ""}
      <a href="${esc(p.mnt)}" target="_blank" rel="noopener">MNT 1 m (GeoTIFF)</a> ·
      <a href="${esc(p.rep)}" target="_blank" rel="noopener">tous les produits</a>
    </div>`;
  }

  // ---------- Panneau : légende, opacité, mise à jour ----------
  const div = document.createElement("div");
  div.className = "lidar-ctl ol-unselectable ol-control";
  div.innerHTML = `
    <details open>
      <summary data-tip="Feuillets 1/20 000 du MNT LiDAR 1 m diffusé par le MRNF (Forêt ouverte). Cliquer un feuillet pour ses dates d'acquisition et ses liens de téléchargement.">LiDAR Forêt ouverte</summary>
      <div class="lidar-legend">
        ${CLASSES.map((c) => `<span><i style="background:${c.color}"></i>${c.label}</span>`).join("")}
      </div>
      <p class="lidar-note">Année d'acquisition la plus récente du feuillet</p>
      <label class="lidar-row" data-tip="Transparence des feuillets.">Dalles
        <input id="lidar-op" type="range" min="0" max="100" value="${fillOpacity * 100}"></label>
      <label class="lidar-row" data-tip="Transparence du relief ombré LiDAR (couche à activer dans le sélecteur de couches).">Relief
        <input id="lidar-op-ombre" type="range" min="0" max="100" value="60"></label>
      <div id="lidar-etat" class="lidar-note">Chargement de l'index…</div>
      <button id="lidar-maj" type="button" class="ghost small-btn" data-tip="Vérifie auprès du MRNF si un nouvel index des dalles ou de nouvelles acquisitions ont été publiés, et les télécharge le cas échéant. La vérification se fait aussi automatiquement une fois par jour.">Mettre à jour</button>
    </details>`;
  map.addControl(new ol.control.Control({ element: div }));

  $("lidar-op").oninput = (e) => {
    fillOpacity = Number(e.target.value) / 100;
    styles.clear();
    dalles.changed();
  };
  $("lidar-op-ombre").oninput = (e) => ombre.setOpacity(Number(e.target.value) / 100);

  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("fr-CA", { day: "numeric", month: "short", year: "numeric" }) : "?");

  function showState(s) {
    const el = $("lidar-etat");
    if (s.erreur) {
      el.className = "lidar-note err";
      el.textContent = s.erreur;
      return;
    }
    el.className = "lidar-note";
    if (s.maj_en_cours && !s.disponible) { el.textContent = "Téléchargement de l'index MRNF…"; return; }
    el.textContent = `${(s.dalles ?? 0).toLocaleString("fr-CA")} feuillets · index du ${fmtDate(s.index_date)}`
      + ` · acquisitions au ${fmtDate(s.meta_date)} · vérifié le ${fmtDate(s.verifie)}`;
  }

  let loadedIndex = null;
  async function loadTiles(s) {
    const key = `${s.index_date}|${s.meta_date}`;
    if (!s.disponible || key === loadedIndex) return;
    const r = await fetch("/api/lidar/dalles");
    if (!r.ok) return;
    const features = geojson.readFeatures(await r.json());
    hovered = null;
    dallesSource.clear();
    dallesSource.addFeatures(features);
    loadedIndex = key;
  }

  async function refresh() {
    try {
      const s = await (await fetch("/api/lidar/etat")).json();
      showState(s);
      await loadTiles(s);
      if (s.maj_en_cours || !s.disponible) setTimeout(refresh, 3000);  // premier téléchargement en cours
    } catch {
      $("lidar-etat").textContent = "Index des dalles indisponible.";
    }
  }

  $("lidar-maj").onclick = async () => {
    const btn = $("lidar-maj");
    btn.disabled = true;
    btn.textContent = "Vérification…";
    $("lidar-etat").textContent = "Vérification auprès du MRNF…";
    try {
      const s = await (await fetch("/api/lidar/maj", { method: "POST" })).json();
      showState(s);
      await loadTiles(s);
    } catch {
      $("lidar-etat").textContent = "Mise à jour impossible.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Mettre à jour";
    }
  };

  refresh();
})();
