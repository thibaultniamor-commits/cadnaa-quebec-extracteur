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

  map.createPane("lidar-ombre").style.zIndex = 250;   // au-dessus du fond, sous les dalles
  map.createPane("lidar-dalles").style.zIndex = 350;  // sous la zone d'étude (overlayPane : 400)

  let fillOpacity = 0.3;
  const style = (f) => ({
    color: colorOf(f.properties.an), weight: 1, opacity: Math.min(1, fillOpacity + 0.4),
    fillColor: colorOf(f.properties.an), fillOpacity,
  });

  const dalles = L.geoJSON(null, {
    pane: "lidar-dalles",
    renderer: L.canvas({ pane: "lidar-dalles", padding: 0.3 }),
    style,
    onEachFeature: (f, layer) => {
      layer.on("mouseover", () => layer.setStyle({ weight: 2.5 }));
      layer.on("mouseout", () => dalles.resetStyle(layer));
      layer.on("click", (e) => {
        if (map.pm.globalDrawModeEnabled()) return;  // pas de bulle pendant le tracé de la zone
        L.popup({ maxWidth: 320 }).setLatLng(e.latlng).setContent(popup(f.properties)).openOn(map);
      });
    },
  }).addTo(map);

  const ombre = L.tileLayer.wms("https://geoegl.msp.gouv.qc.ca/ws/mffpecofor.fcgi", {
    layers: "lidar_ombre", format: "image/png", transparent: true, opacity: 0.6,
    pane: "lidar-ombre", maxZoom: 19, attribution: "LiDAR © MRNF (Forêt ouverte)",
  });

  layerControl.addOverlay(dalles, "Dalles LiDAR Forêt ouverte");
  layerControl.addOverlay(ombre, "Relief ombré LiDAR (MRNF)");

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
  const ctl = L.control({ position: "bottomleft" });
  ctl.onAdd = () => {
    const div = L.DomUtil.create("div", "lidar-ctl leaflet-bar");
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
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    return div;
  };
  ctl.addTo(map);

  $("lidar-op").oninput = (e) => {
    fillOpacity = Number(e.target.value) / 100;
    dalles.setStyle(style);
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
    dalles.clearLayers();
    dalles.addData(await r.json());
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
