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
};
const HEIGHT_STOPS = [[0, "#3b6fb6"], [10, "#4fb0a5"], [20, "#9ccf5a"], [35, "#f2c14e"], [60, "#e0603a"]];
const ROAD_COLORS = {
  Autoroute: "#c0392b", Nationale: "#e67e22", "Régionale": "#e6a822", Collectrice: "#d4b000",
};
const ROAD_DEFAULT = "#4a4f57";
const CONTOUR_COLOR = "#8a5a2b";
const ZONE_COLOR = "#1f5fae";

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
    const depth = Math.max(b.t - b.b, 0.5);
    let g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    g.translate(0, b.b - zref, 0);
    g.deleteAttribute("uv");
    g = g.index ? g.toNonIndexed() : g;
    const n = g.attributes.position.count;
    g.setAttribute("bid", new THREE.BufferAttribute(new Float32Array(n).fill(k), 1));
    g.setAttribute("base", new THREE.BufferAttribute(new Float32Array(n).fill(b.b - zref), 1));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.clearGroups();
    parts.push(g);
  });
  if (!parts.length) return null;
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  geo.userData.y0 = Float32Array.from(geo.attributes.position.array.filter((_, i) => i % 3 === 1));
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return new THREE.Mesh(geo, mat);
}

// Exagération du relief seulement : la base suit le terrain exagéré, la hauteur reste réelle.
function exaggerate(state, k) {
  [state.terrain, state.roads, state.contours, state.zone].forEach((o) => { if (o) o.scale.y = k; });
  const mesh = state.bmesh;
  if (!mesh) return;
  const pos = mesh.geometry.attributes.position, base = mesh.geometry.attributes.base.array;
  const y0 = mesh.geometry.userData.y0;
  for (let i = 0; i < pos.count; i++) pos.array[i * 3 + 1] = base[i] * k + (y0[i] - base[i]);
  pos.needsUpdate = true;
  mesh.geometry.computeBoundingSphere();
  mesh.geometry.computeBoundingBox();
}

function colorBuildings(mesh, items, mode, selected) {
  if (!mesh) return;
  const bid = mesh.geometry.attributes.bid.array;
  const col = mesh.geometry.attributes.color;
  const cache = items.map((b, k) => {
    if (k === selected) return new THREE.Color("#ff2bd6");
    return mode === "source" ? new THREE.Color((SRC[b.s] || SRC.DEFAUT).color) : ramp(HEIGHT_STOPS, b.h ?? 0);
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

function createView(data) {
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

  const items = data.buildings || [];
  const bmesh = buildBuildings(items, zref);
  if (bmesh) world.add(bmesh);

  const roads = data.roads ? buildLines(data.roads.map((r) => ({ pts: r.c, k: r.k })), zref,
    (r) => ROAD_COLORS[r.k] || ROAD_DEFAULT) : null;
  if (roads) world.add(roads);

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
    renderer, scene, camera, controls, world, items, bmesh, terrain: terrain.mesh, roads, contours, zone,
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
    <strong>${b.n || "Bâtiment sans nom"}</strong><span class="muted"> · ${b.ty}</span>
    <dl>
      <dt>HAUTEUR</dt><dd>${fmt(b.h)}</dd>
      <dt>Source</dt><dd>${(SRC[b.s] || {}).label || b.s}</dd>
      <dt>H_LIDAR</dt><dd>${fmt(b.hl)}</dd>
      <dt>H_OSM</dt><dd>${fmt(b.ho)}</dd>
      <dt>NIVEAUX</dt><dd>${fmt(b.nv, "")}</dd>
    </dl>`;
  box.classList.remove("hidden");
}

function legend(state) {
  const el = $("viewer-legend");
  if (state.mode === "source") {
    const counts = {};
    state.items.forEach((b) => { counts[b.s] = (counts[b.s] || 0) + 1; });
    el.innerHTML = Object.entries(SRC).map(([k, v]) =>
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

function summary(data) {
  const s = data.stats || {};
  const parts = [`${s.zone_km2 ?? "?"} km²`, `EPSG:${s.epsg}`];
  if (s.couverture_lidar !== undefined) parts.push(`LiDAR ${Math.round(s.couverture_lidar * 100)} %`);
  if (s.batiments !== undefined) parts.push(`${s.batiments} bâtiments`);
  if (s.routes !== undefined) parts.push(`${s.routes} tronçons`);
  if (data.contour_step > 1) parts.push(`courbes affichées : 1 sur ${data.contour_step}`);
  return parts.join(" · ");
}

function bindControls() {
  const toggle = (id, key) => {
    $(id).onchange = (e) => { if (view && view[key]) view[key].visible = e.target.checked; };
  };
  toggle("v-terrain", "terrain");
  toggle("v-buildings", "bmesh");
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
  $("viewer-close").onclick = closeViewer;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && view) closeViewer(); });
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
    const r = await fetch(`/api/jobs/${jobId}/preview`);
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
    const data = await r.json();
    view = createView(data);
    $("viewer-title").textContent = summary(data);
    // Réapplique l'état des contrôles.
    ["v-terrain", "v-buildings", "v-roads", "v-contours", "v-zone"].forEach((id) => $(id).dispatchEvent(new Event("change")));
    $("v-exag").dispatchEvent(new Event("input"));
    view.mode = $("v-mode").value;
    colorBuildings(view.bmesh, view.items, view.mode, -1);
    legend(view);
    $("viewer-pick").classList.add("hidden");
  } catch (err) {
    $("viewer-title").textContent = `Aperçu indisponible : ${err.message}`;
  }
};

bindControls();
