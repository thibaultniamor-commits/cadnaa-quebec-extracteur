"use strict";

// Outils de carte communs à la carte principale (app.js) et à l'éditeur de calage (plan.js) :
// projections de sortie, fonds de carte, rectangle modifiable, contrôle de validité des polygones.
// La carte principale reste en Web Mercator ; l'éditeur de calage s'affiche dans la projection des shapefiles.

// ---------- Projections de sortie : NAD83(CSRS) / MTM 3 à 10 et Lambert Québec ----------
// Même règle que app/crs.py.
// WGS84 -> NAD83(CSRS) : même transformation que pyproj côté serveur (EPSG « NAD83(CSRS) to WGS 84 (2) »,
// Helmert 7 paramètres, environ 1 m à Québec), rotations en convention « position vector » de proj4.
const WGS84 = "EPSG:4326", MERC = "EPSG:3857";
const CSRS_TOWGS84 = "+towgs84=-0.991,1.9072,0.5129,0.0257899075194932,0.0096500989602704,0.0116599432323421,0";
for (let z = 3; z <= 10; z++) {
  proj4.defs(`EPSG:${2942 + z}`,
    `+proj=tmerc +lat_0=0 +lon_0=${-(49.5 + 3 * z)} +k=0.9999 +x_0=304800 +y_0=0 +ellps=GRS80 ${CSRS_TOWGS84} +units=m +no_defs`);
}
proj4.defs("EPSG:32198",
  "+proj=lcc +lat_0=44 +lon_0=-68.5 +lat_1=60 +lat_2=46 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs");
ol.proj.proj4.register(proj4);
// Étendue de validité (le Québec) : nécessaire à OpenLayers pour reprojeter les tuiles des fonds de carte.
[...Array.from({ length: 8 }, (_, i) => `EPSG:${2945 + i}`), "EPSG:32198"].forEach((code) => {
  const p = ol.proj.get(code);
  p.setExtent(ol.proj.transformExtent([-80.5, 44, -56.5, 63.5], WGS84, code, 32));
  p.setWorldExtent([-80.5, 44, -56.5, 63.5]);
});

const mtmZone = (lon) => Math.min(Math.max(Math.floor((-lon - 57) / 3) + 3, 3), 10);

// Code EPSG ("EPSG:2949") pour le choix du panneau ("auto", "mtm7", "lambert") et la longitude de la zone.
function crsCode(choice, lon) {
  if (choice === "lambert") return "EPSG:32198";
  const zone = choice && choice.startsWith("mtm") ? Number(choice.slice(3)) : mtmZone(lon);
  return `EPSG:${2942 + zone}`;
}

// ---------- Fonds de carte ----------
// Les tuiles restent en Web Mercator ; OpenLayers les reprojette dans la projection de la carte.
function baseLayers() {
  const osm = new ol.layer.Tile({
    zIndex: 0,
    source: new ol.source.OSM({ attributions: "© contributeurs OpenStreetMap", maxZoom: 19 }),
  });
  const ortho = new ol.layer.Tile({
    zIndex: 0, visible: false,
    source: new ol.source.XYZ({
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      maxZoom: 19, attributions: "Imagerie © Esri",
    }),
  });
  return { osm, ortho };
}

// Vue dans une projection métrique, en gardant le centre et l'échelle (mètres par pixel) de l'ancienne vue.
function viewIn(code, old) {
  const opts = { projection: code, maxZoom: 24, constrainResolution: false };
  if (!old) return new ol.View(opts);
  const from = old.getProjection(), center = old.getCenter();
  const mPerPx = ol.proj.getPointResolution(from, old.getResolution(), center, "m");
  return new ol.View({ ...opts, center: ol.proj.transform(center, from, code), resolution: mPerPx });
}

// ---------- Rectangle modifiable par ses coins (le coin opposé reste fixe) ----------
function boxEditor(map, getFeature, onEnd, onHover) {
  let anchor = null;
  const cornerAt = (pixel) => {
    const f = getFeature();
    if (!f) return null;
    const [x0, y0, x1, y1] = f.getGeometry().getExtent();
    const corners = [[x0, y0], [x0, y1], [x1, y1], [x1, y0]];
    for (let i = 0; i < 4; i++) {
      const p = map.getPixelFromCoordinate(corners[i]);
      if (Math.hypot(p[0] - pixel[0], p[1] - pixel[1]) <= 8) return corners[(i + 2) % 4];
    }
    return null;
  };
  map.addInteraction(new ol.interaction.Pointer({
    handleDownEvent(e) {
      anchor = cornerAt(e.pixel);
      return !!anchor;
    },
    handleDragEvent(e) {
      const [ax, ay] = anchor, [bx, by] = e.coordinate;
      getFeature().setGeometry(ol.geom.Polygon.fromExtent([Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]));
    },
    handleUpEvent() {
      anchor = null;
      onEnd();
      return false;
    },
  }));
  map.on("pointermove", (e) => { if (!e.dragging) onHover(!!cornerAt(e.pixel)); });
}

// Deux côtés non consécutifs du contour se coupent.
function selfIntersects(geom) {
  const r = geom.getCoordinates()[0], n = r.length - 1;
  const side = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const [a, b, c, d] = [r[i], r[i + 1], r[j], r[j + 1]];
      if (side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b)) return true;
    }
  }
  return false;
}

// Sommet le plus proche de coord à moins de tol (unités de la carte), dans des tableaux plats [x0, y0, x1, y1, …].
function snapVertex(coord, sources, tol) {
  let best = tol * tol, hit = null;
  for (const a of sources) {
    if (!a) continue;
    for (let i = 0; i < a.length; i += 2) {
      const dx = a[i] - coord[0], dy = a[i + 1] - coord[1], d = dx * dx + dy * dy;
      if (d < best) { best = d; hit = [a[i], a[i + 1]]; }
    }
  }
  return hit;
}
function flatCoords(rings) {
  const out = new Float64Array(rings.reduce((s, r) => s + r.length * 2, 0));
  let k = 0;
  rings.forEach((r) => r.forEach(([x, y]) => { out[k++] = x; out[k++] = y; }));
  return out;
}
