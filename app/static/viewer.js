// Aperçu 3D pour validation visuelle : terrain, bâtiments extrudés, routes, courbes, zone.
// Repère three.js : x = est, y = altitude (exagérée), z = -nord.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const $ = (id) => document.getElementById(id);

const SRC = {
  LIDAR: { color: "#9aa9bd", label: "LiDAR (DSM − DTM)" },
  OSM_H: { color: "#f08c2e", label: "OSM : hauteur" },
  OSM_NIV: { color: "#e8c547", label: "OSM : niveaux × 3 m" },
  DEFAUT: { color: "#d63b3b", label: "Valeur par défaut" },
  PROJET: { color: "#7c3aed", label: "Bâtiment projeté" },
};
// Source de l'emprise : source retenue pour la maille (principale) ou bâtiment ajouté par l'autre source.
const EMP = {
  "OSM/PRINCIPAL": { color: "#2f6fc0", label: "OSM, source principale" },
  "OSM/COMPLEMENT": { color: "#8fc1f2", label: "OSM, complément" },
  "REFBATI/PRINCIPAL": { color: "#2a8f4f", label: "Référentiel, source principale" },
  "REFBATI/COMPLEMENT": { color: "#9fd9ae", label: "Référentiel, complément" },
  PROJET: { color: "#7c3aed", label: "Bâtiment projeté" },
};
const empKey = (b) => (b.e === "PROJET" || !b.e ? "PROJET" : `${b.e}/${b.er}`);
const EMP_NAMES = { OSM: "OpenStreetMap", REFBATI: "Référentiel québécois sur les bâtiments", PROJET: "Saisie sur plan" };
const DEMOLI_COLOR = "#e02424";
const OSM_TYPES = { w: "way", r: "relation", n: "node" };
// Historique d'un objet OSM (w123 -> chemin 123) : auteurs, dates et sources de chaque modification.
const osmHistory = (id) => (OSM_TYPES[id[0]] ? `https://www.openstreetmap.org/${OSM_TYPES[id[0]]}/${id.slice(1)}/history` : null);
const HEIGHT_STOPS = [[0, "#3b6fb6"], [10, "#4fb0a5"], [20, "#9ccf5a"], [35, "#f2c14e"], [60, "#e0603a"]];
const ROAD_COLORS = {
  Autoroute: "#c0392b", Nationale: "#e67e22", "Régionale": "#e6a822", Collectrice: "#d4b000",
};
const ROAD_DEFAULT = "#4a4f57";
const DJMA_CLASSES = [
  [100000, "#7a0177", "> 100 000"], [50000, "#c51b8a", "50 000 – 100 000"], [20000, "#f768a1", "20 000 – 50 000"],
  [5000, "#fbb4b9", "5 000 – 20 000"], [0, "#feebe2", "< 5 000"],
];
const DJMA_NONE = "#9aa0a8";
const SPEED_CLASSES = [
  [90, "#b2182b", "90 km/h et plus"], [70, "#ef8a62", "70 – 80"], [50, "#f4c542", "50 – 60"],
  [0, "#67a9cf", "moins de 50"],
];
const roadColor = {
  class: (r) => ROAD_COLORS[r.k] || ROAD_DEFAULT,
  djma: (r) => (r.d === null || r.d === undefined ? DJMA_NONE : DJMA_CLASSES.find(([min]) => r.d >= min)[1]),
  speed: (r) => (r.vs === "DEFAUT" || r.v === null || r.v === undefined ? DJMA_NONE
    : SPEED_CLASSES.find(([min]) => r.v >= min)[1]),
};
const CONTOUR_COLOR = "#8a5a2b";
const ZONE_COLOR = "#1f5fae";
const SINK_M = 0.5; // enfoncement du pied des bâtiments sous le terrain (non exagéré)

let view = null;

function ramp(stops, v) {
  if (v <= stops[0][0]) return new THREE.Color(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      return new THREE.Color(ca).lerp(new THREE.Color(cb), (v - a) / (b - a));
    }
  }
  return new THREE.Color(stops[stops.length - 1][1]);
}

// ---------- Construction des objets ----------

function buildTerrain(t, zref) {
  const w = (t.nx - 1) * t.res, h = (t.ny - 1) * t.res;
  const geo = new THREE.PlaneGeometry(w, h, t.nx - 1, t.ny - 1);
  geo.rotateX(-Math.PI / 2);
  let zmin = Infinity, zmax = -Infinity;
  for (const v of t.z) if (v !== null) { if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
  if (!Number.isFinite(zmin)) { zmin = zref; zmax = zref; }
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const hypso = [[0, "#6f9e5a"], [0.35, "#a8b86b"], [0.7, "#b99a6b"], [1, "#e9e4dc"]];
  for (let i = 0; i < pos.count; i++) {
    const z = t.z[i] ?? zmin;
    pos.setY(i, z - zref);
    ramp(hypso, (z - zmin) / Math.max(zmax - zmin, 1)).toArray(colors, i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  // PlaneGeometry est centré ; les données sont centrées sur le centre des cellules extrêmes.
  const mesh = new THREE.Mesh(geo, mat);
  return { mesh, zmin, zmax };
}

function buildBuildings(items, zref) {
  const parts = [];
  items.forEach((b, k) => {
    const shape = new THREE.Shape(b.o.map(([x, y]) => new THREE.Vector2(x, y)));
    b.i.forEach((ring) => shape.holes.push(new THREE.Path(ring.map(([x, y]) => new THREE.Vector2(x, y)))));
    // Pied du volume sous le point le plus bas du terrain, sommet à sol (centre) + hauteur réelle.
    const bottom = b.gm - SINK_M, depth = Math.max(b.t - bottom, 0.5);
    let g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    g.translate(0, bottom - zref, 0);
    g.deleteAttribute("uv");
    g = g.index ? g.toNonIndexed() : g;
    const n = g.attributes.position.count;
    const pos = g.attributes.position.array;
    // Par sommet : altitude de référence (non exagérée) et décalage réel conservé tel quel.
    const ref = new Float32Array(n), off = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const top = pos[i * 3 + 1] > bottom - zref + depth / 2;
      ref[i] = (top ? b.g : b.gm) - zref;
      off[i] = top ? b.t - b.g : -SINK_M;
    }
    g.setAttribute("bid", new THREE.BufferAttribute(new Float32Array(n).fill(k), 1));
    g.setAttribute("ref", new THREE.BufferAttribute(ref, 1));
    g.setAttribute("off", new THREE.BufferAttribute(off, 1));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.clearGroups();
    parts.push(g);
  });
  if (!parts.length) return null;
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return new THREE.Mesh(geo, mat);
}

// Exagération du relief seulement : la base suit le terrain exagéré, la hauteur reste réelle.
function exaggerate(state, k) {
  [state.terrain, state.roads, state.contours, state.zone].forEach((o) => { if (o) o.scale.y = k; });
  [state.bmesh, state.gmesh].forEach((mesh) => {
    if (!mesh) return;
    const pos = mesh.geometry.attributes.position;
    const ref = mesh.geometry.attributes.ref.array, off = mesh.geometry.attributes.off.array;
    for (let i = 0; i < pos.count; i++) pos.array[i * 3 + 1] = ref[i] * k + off[i];
    pos.needsUpdate = true;
    mesh.geometry.computeBoundingSphere();
    mesh.geometry.computeBoundingBox();
  });
}

function colorBuildings(mesh, items, mode, selected) {
  if (!mesh) return;
  const bid = mesh.geometry.attributes.bid.array;
  const col = mesh.geometry.attributes.color;
  const cache = items.map((b, k) => {
    if (k === selected) return new THREE.Color("#ff2bd6");
    if (mode === "source") return new THREE.Color((SRC[b.s] || SRC.DEFAUT).color);
    if (mode === "footprint") return new THREE.Color((EMP[empKey(b)] || EMP.PROJET).color);
    return ramp(HEIGHT_STOPS, b.h ?? 0);
  });
  for (let i = 0; i < bid.length; i++) cache[bid[i]].toArray(col.array, i * 3);
  col.needsUpdate = true;
}

function buildLines(polylines, zref, colorOf) {
  const pos = [], col = [];
  const c = new THREE.Color();
  polylines.forEach((pl) => {
    c.set(colorOf(pl));
    const pts = pl.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1, z1] = pts[i], [x2, y2, z2] = pts[i + 1];
      pos.push(x1, z1 - zref, -y1, x2, z2 - zref, -y2);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
}

// ---------- Scène ----------

function createView(data, projects) {
  const container = $("viewer-canvas");
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue("--sky").trim() || "#dfe8f0");
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8d7c64, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(-1, 2, 1.2);
  scene.add(sun);

  const world = new THREE.Group();
  scene.add(world);
  const zref = data.zref;
  const t = data.terrain;
  const extent = Math.max(t.nx, t.ny) * t.res;

  const terrain = buildTerrain(t, zref);
  world.add(terrain.mesh);

  // État projeté : existants non démolis + projetés ; les démolis restent visibles en fantômes.
  const demolis = new Set(projects.demolis);
  const all = data.buildings || [];
  const items = all.filter((b) => !demolis.has(b.bid)).concat(projects.buildings);
  const ghosts = all.filter((b) => demolis.has(b.bid));
  const bmesh = buildBuildings(items, zref);
  if (bmesh) world.add(bmesh);
  const gmesh = buildBuildings(ghosts, zref);
  if (gmesh) {
    gmesh.material.dispose();
    gmesh.material = new THREE.MeshLambertMaterial({ color: DEMOLI_COLOR, transparent: true, opacity: 0.3, depthWrite: false });
    world.add(gmesh);
  }

  const roads = data.roads ? buildLines(data.roads.map((r) => ({ pts: r.c, k: r.k, d: r.d })), zref,
    roadColor.class) : null;
  if (roads) { roads.userData.items = data.roads; world.add(roads); }

  const contours = data.contours ? buildLines(
    data.contours.map((c) => ({ pts: c.c.map(([x, y]) => [x, y, c.z + 0.15]) })), zref, () => CONTOUR_COLOR) : null;
  if (contours) { contours.visible = false; world.add(contours); }

  const zone = buildLines([{ pts: data.zone.map(([x, y, z]) => [x, y, z + 1]) }], zref, () => ZONE_COLOR);
  world.add(zone);

  const camera = new THREE.PerspectiveCamera(45, 1, Math.max(extent / 5000, 0.5), extent * 20);
  const relief = terrain.zmax - terrain.zmin;
  camera.position.set(extent * 0.45, relief + extent * 0.55, extent * 0.75);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, relief * 0.3, 0);
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.enableDamping = true;
  controls.update();

  const state = {
    renderer, scene, camera, controls, world, items, bmesh, gmesh, terrain: terrain.mesh, roads, contours, zone,
    mode: "source", selected: -1, raf: 0,
  };
  colorBuildings(bmesh, items, state.mode, -1);

  function resize() {
    const { clientWidth: w, clientHeight: h } = container;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  }
  state.resize = resize;
  window.addEventListener("resize", resize);
  resize();

  // Sélection d'un bâtiment au clic (pas au glisser).
  const ray = new THREE.Raycaster();
  let down = null;
  renderer.domElement.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || !bmesh) return;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObject(bmesh)[0];
    select(state, hit ? bmesh.geometry.attributes.bid.array[hit.face.a] : -1);
  });

  (function loop() {
    state.raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  })();
  return state;
}

function select(state, k) {
  state.selected = k;
  colorBuildings(state.bmesh, state.items, state.mode, k);
  const box = $("viewer-pick");
  if (k < 0) { box.classList.add("hidden"); return; }
  const b = state.items[k];
  const fmt = (v, u = " m") => (v === null || v === undefined ? "—" : `${v.toLocaleString("fr-CA")}${u}`);
  box.innerHTML = `
    <strong>${escapeHtml(b.n || "Bâtiment sans nom")}</strong><span class="muted"> · ${escapeHtml(b.ty)}</span>
    <dl>
      <dt>HAUTEUR</dt><dd>${fmt(b.h)}</dd>
      <dt>Source</dt><dd>${(SRC[b.s] || {}).label || b.s}</dd>
      <dt>H_LIDAR</dt><dd>${fmt(b.hl)}</dd>
      <dt>H_OSM</dt><dd>${fmt(b.ho)}</dd>
      <dt>NIVEAUX</dt><dd>${fmt(b.nv, "")}</dd>
      <dt>Emprise</dt><dd>${escapeHtml(EMP_NAMES[b.e] || b.e || "—")}${b.er ? ` (${b.er === "PRINCIPAL" ? "source principale" : "complément"})` : ""}</dd>
      ${b.e === "REFBATI" ? `<dt>Producteur</dt><dd>${escapeHtml(b.ep)}</dd>
      <dt>Date source</dt><dd>${escapeHtml(b.ed || "inconnue")}</dd>` : ""}
      ${b.oi && osmHistory(b.oi) ? `<dt>OSM</dt><dd><a href="${osmHistory(b.oi)}" target="_blank" rel="noopener"
        title="Qui a tracé ce bâtiment, quand, et avec quelle source">${escapeHtml(b.oi)} · historique</a></dd>` : ""}
    </dl>`;
  box.classList.remove("hidden");
}

// Recolore les segments de routes (2 sommets par segment, dans l'ordre de construction).
function colorRoads(state, mode) {
  const roads = state.roads;
  if (!roads) return;
  const col = roads.geometry.attributes.color;
  const c = new THREE.Color();
  let v = 0;
  roads.userData.items.forEach((r) => {
    c.set(roadColor[mode](r));
    for (let s = 0; s < r.c.length - 1; s++, v += 2) { c.toArray(col.array, v * 3); c.toArray(col.array, v * 3 + 3); }
  });
  col.needsUpdate = true;
  const el = $("viewer-road-legend");
  if (mode === "djma") {
    const n = roads.userData.items.filter((r) => r.d !== null && r.d !== undefined).length;
    el.innerHTML = DJMA_CLASSES.map(([, col, label]) => `<div><i style="background:${col}"></i>${label} véh/j</div>`).join("")
      + `<div><i style="background:${DJMA_NONE}"></i>Sans donnée <span class="muted">(${roads.userData.items.length - n})</span></div>`;
  } else if (mode === "speed") {
    const n = roads.userData.items.filter((r) => r.vs === "DEFAUT").length;
    el.innerHTML = SPEED_CLASSES.map(([, col, label]) => `<div><i style="background:${col}"></i>${label}</div>`).join("")
      + `<div><i style="background:${DJMA_NONE}"></i>Défaut de la classe, à vérifier <span class="muted">(${n})</span></div>`;
  } else {
    el.innerHTML = Object.entries(ROAD_COLORS).map(([k, col]) => `<div><i style="background:${col}"></i>${k}</div>`).join("")
      + `<div><i style="background:${ROAD_DEFAULT}"></i>Autres</div>`;
  }
}

function legend(state) {
  const el = $("viewer-legend");
  if (state.mode === "source" || state.mode === "footprint") {
    const [classes, keyOf] = state.mode === "source" ? [SRC, (b) => b.s] : [EMP, empKey];
    const counts = {};
    state.items.forEach((b) => { const k = keyOf(b); counts[k] = (counts[k] || 0) + 1; });
    el.innerHTML = Object.entries(classes).map(([k, v]) =>
      `<div><i style="background:${v.color}"></i>${v.label} <span class="muted">(${counts[k] || 0})</span></div>`).join("");
  } else {
    el.innerHTML = HEIGHT_STOPS.map(([h, c]) => `<div><i style="background:${c}"></i>${h} m</div>`).join("");
  }
}

function dispose(state) {
  cancelAnimationFrame(state.raf);
  window.removeEventListener("resize", state.resize);
  state.scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  state.controls.dispose();
  state.renderer.dispose();
  state.renderer.domElement.remove();
}

// ---------- Interface ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function summary(data, projects) {
  const s = data.stats || {};
  const parts = [`${s.zone_km2 ?? "?"} km²`, `EPSG:${s.epsg}`];
  if (s.couverture_lidar !== undefined) parts.push(`LiDAR ${Math.round(s.couverture_lidar * 100)} %`);
  if (s.batiments !== undefined) parts.push(`${s.batiments} bâtiments`);
  const np = new Set(projects.buildings.map((b) => b.pid)).size;
  if (np) parts.push(`${np} projeté${np > 1 ? "s" : ""}`);
  if (projects.demolis.length) parts.push(`${projects.demolis.length} démoli${projects.demolis.length > 1 ? "s" : ""}`);
  if (s.routes !== undefined) parts.push(`${s.routes} tronçons`);
  if (s.routes_djma !== undefined) parts.push(`DJMA sur ${s.routes_djma} tronçons (${s.routes_djma_km} km)`);
  if (data.contour_step > 1) parts.push(`courbes affichées : 1 sur ${data.contour_step}`);
  return parts.join(" · ");
}

function bindControls() {
  const toggle = (id, key) => {
    $(id).onchange = (e) => { if (view && view[key]) view[key].visible = e.target.checked; };
  };
  toggle("v-terrain", "terrain");
  toggle("v-buildings", "bmesh");
  toggle("v-demolis", "gmesh");
  toggle("v-roads", "roads");
  toggle("v-contours", "contours");
  toggle("v-zone", "zone");
  $("v-exag").oninput = (e) => {
    const k = Number(e.target.value);
    $("v-exag-val").textContent = `×${k}`;
    if (view) exaggerate(view, k);
  };
  $("v-mode").onchange = (e) => {
    if (!view) return;
    view.mode = e.target.value;
    colorBuildings(view.bmesh, view.items, view.mode, view.selected);
    legend(view);
  };
  $("v-road-mode").onchange = (e) => { if (view) colorRoads(view, e.target.value); };
  $("viewer-close").onclick = closeViewer;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && view && !$("help").open) closeViewer(); });
}

function closeViewer() {
  $("viewer").classList.add("hidden");
  if (view) { dispose(view); view = null; }
}

window.openViewer = async (jobId) => {
  $("viewer").classList.remove("hidden");
  $("viewer-title").textContent = "Chargement de l'aperçu…";
  if (view) { dispose(view); view = null; }
  try {
    await window.flushProjects();
    const [r, rp] = await Promise.all([fetch(`/api/jobs/${jobId}/preview`), fetch(`/api/jobs/${jobId}/projets`)]);
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
    const data = await r.json();
    const projects = rp.ok ? await rp.json() : { buildings: [], demolis: [] };
    view = createView(data, projects);
    $("viewer-title").textContent = summary(data, projects);
    $("v-demolis-row").classList.toggle("hidden", !view.gmesh);
    // Réapplique l'état des contrôles.
    ["v-terrain", "v-buildings", "v-demolis", "v-roads", "v-contours", "v-zone"].forEach((id) => $(id).dispatchEvent(new Event("change")));
    $("v-exag").dispatchEvent(new Event("input"));
    view.mode = $("v-mode").value;
    colorBuildings(view.bmesh, view.items, view.mode, -1);
    legend(view);
    colorRoads(view, $("v-road-mode").value);
    $("viewer-pick").classList.add("hidden");
  } catch (err) {
    $("viewer-title").textContent = `Aperçu indisponible : ${err.message}`;
  }
};

bindControls();
