import { freshwaterCoverage } from "./water-coverage.js";
import { BufferGeometry, Float32BufferAttribute } from "three"; import { shapeNetwork, dimensionNetwork } from "./hydro-design.js"; import { finishHydrology } from "./wetlands.js";

const mix = (a, b, t) => a + (b - a) * t;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

function unifyMainStems(network) {
  const original = network.reaches;
  const children = original.map(() => []);
  for (const reach of original)
    if (
      reach.parent >= 0 &&
      reach.parent !== reach.id &&
      children[reach.parent]
    )
      children[reach.parent].push(reach.id);
  const lengths = new Map(),
    visiting = new Set();
  const upstreamLength = (id) => {
    if (lengths.has(id)) return lengths.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const length =
      original[id].length + Math.max(0, ...children[id].map(upstreamLength));
    visiting.delete(id);
    lengths.set(id, length);
    return length;
  };
  original.forEach((r) => upstreamLength(r.id));
  const continuation = new Map();
  for (const reach of original) {
    const branches = children[reach.id].filter(
      (id) => original[id].kind !== "distributary",
    );
    if (branches.length)
      continuation.set(
        reach.id,
        branches.sort((a, b) => upstreamLength(b) - upstreamLength(a))[0],
      );
  }
  const consumed = new Set(),
    mapping = new Map(),
    routes = [];
  const roots = original
    .filter((r) => r.parent < 0)
    .sort((a, b) => upstreamLength(b.id) - upstreamLength(a.id));
  const assemble = (end) => {
    if (consumed.has(end.id)) return;
    const chain = [end];
    consumed.add(end.id);
    let current = end;
    while (continuation.has(current.id)) {
      const next = original[continuation.get(current.id)];
      if (consumed.has(next.id)) break;
      chain.unshift(next);
      consumed.add(next.id);
      current = next;
    }
    const route = {
      ...end,
      id: routes.length,
      pts: [],
      hw: [],
      depth: [],
      sed: [],
      speed: [],
      q: [],
      curv: [],
      cells: [],
 origKind: end.kind,
 _parent: end.parent,
 };
    for (const segment of chain) {
      mapping.set(segment.id, route.id);
      const start = route.pts.length ? 1 : 0;
      for (let i = start; i < segment.hw.length; i++) {
        route.pts.push(segment.pts[i * 2], segment.pts[i * 2 + 1]);
        for (const key of ["hw", "depth", "sed", "speed", "q", "curv"])
          route[key].push(segment[key][i] ?? 0);
      }
      route.cells.push(...segment.cells);
    }
    route.length = chain.reduce((sum, r) => sum + r.length, 0);
    route.strahler = Math.max(...chain.map((r) => r.strahler));
    routes.push(route);
    for (const segment of chain)
      for (const id of children[segment.id])
        if (!consumed.has(id)) assemble(original[id]);
  };
  for (const root of roots) assemble(root);
  for (const reach of original) if (!consumed.has(reach.id)) assemble(reach);
  for (const route of routes) {
    route.parent = route._parent >= 0 ? (mapping.get(route._parent) ?? -1) : -1;
    if (route.parent === route.id) route.parent = -1;
    route.kind =
      route.parent < 0
        ? route.id === 0
          ? "main"
          : "secondary"
        : route.length > 320
          ? "tributary"
          : "creek";
    delete route._parent;
  }
  network.reaches = routes;
}

/* ---------------------------------------------------------------------------
   Natural river planform
   ---------------------------------------------------------------------------
   The network is traced on the 10 m D8 drainage grid, so raw centrelines are
   staircases of 0/45/90 degree steps, and downstream extensions are pushed as
   raw cell centres. A Catmull-Rom curve through every one of those points
   reproduces the staircase exactly. Instead each reach is:
     1. resampled at a uniform arc-length spacing tied to its width,
     2. low-pass filtered with Taubin (lambda|mu) smoothing, which removes the
        grid-scale zig-zags but preserves the long meander wavelengths
        (plain Laplacian smoothing would shrink every bend),
     3. given gentle free meanders where it is still unnaturally straight
        (wavelength ~11 channel widths, amplitude ~1 width, tapered at both
        ends so mouths and confluences stay where hydrology put them),
     4. curvature-limited so no bend is tighter than ~2 channel widths,
     5. resampled again so the carving sees evenly spaced segments.
   Children are processed after their parents and their mouths are snapped
   onto the parent's final centreline first, so confluences stay joined.
--------------------------------------------------------------------------- */
const smooth01 = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const REACH_ATTRS = ["hw", "depth", "sed", "speed", "q"];

function hashUnit(k) {
  const x = Math.sin(k * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}
function noise1(t) {
  const i = Math.floor(t),
    f = t - i,
    u = f * f * (3 - 2 * f);
  return mix(hashUnit(i), hashUnit(i + 1), u);
}
function seededRandom(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function arcLengths(p) {
  const n = p.length / 2,
    s = new Float64Array(n);
  for (let i = 1; i < n; i++)
    s[i] =
      s[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
  return s;
}
function medianOf(a) {
  if (!a || !a.length) return 6;
  const b = Array.from(a).sort((x, y) => x - y);
  return b[b.length >> 1] || 6;
}
function resampleReach(reach, ds) {
  const src = reach.pts,
    n = src.length / 2;
  if (n < 2) return;
  const s = arcLengths(src),
    L = s[n - 1];
  if (L < ds * 2.5) return;
  const m = Math.max(3, Math.round(L / ds) + 1),
    step = L / (m - 1),
    pts = new Array(m * 2),
    out = {};
  for (const k of REACH_ATTRS) out[k] = new Array(m);
  let j = 0;
  for (let i = 0; i < m; i++) {
    const target = i === m - 1 ? L : i * step;
    while (j < n - 2 && s[j + 1] < target) j++;
    const seg = s[j + 1] - s[j],
      t = seg > 1e-9 ? clamp((target - s[j]) / seg) : 0;
    pts[i * 2] = mix(src[j * 2], src[j * 2 + 2], t);
    pts[i * 2 + 1] = mix(src[j * 2 + 1], src[j * 2 + 3], t);
    for (const k of REACH_ATTRS) {
      const a = reach[k];
      if (!a || !a.length) {
        out[k][i] = 0;
        continue;
      }
      const a0 = a[Math.min(j, a.length - 1)] ?? 0,
        a1 = a[Math.min(j + 1, a.length - 1)] ?? a0;
      out[k][i] = mix(a0, a1, t);
    }
  }
  pts[0] = src[0];
  pts[1] = src[1];
  pts[m * 2 - 2] = src[n * 2 - 2];
  pts[m * 2 - 1] = src[n * 2 - 1];
  reach.pts = pts;
  for (const k of REACH_ATTRS) reach[k] = out[k];
}
// lambda|mu smoothing with pinned end points: a low-pass filter without shrinkage
function taubin(p, pairs, lam = 0.5, mu = -0.53) {
  const n = p.length / 2;
  if (n < 3 || pairs <= 0) return;
  const tmp = new Float64Array(p.length);
  for (let it = 0; it < pairs * 2; it++) {
    const f = it & 1 ? mu : lam;
    for (let i = 1; i < n - 1; i++) {
      tmp[i * 2] = p[i * 2] + f * ((p[i * 2 - 2] + p[i * 2 + 2]) * 0.5 - p[i * 2]);
      tmp[i * 2 + 1] =
        p[i * 2 + 1] + f * ((p[i * 2 - 1] + p[i * 2 + 3]) * 0.5 - p[i * 2 + 1]);
    }
    for (let i = 1; i < n - 1; i++) {
      p[i * 2] = tmp[i * 2];
      p[i * 2 + 1] = tmp[i * 2 + 1];
    }
  }
}
// relax any bend tighter than rmin(i) (Menger curvature on the polyline)
function limitCurvature(p, rmin, iterations) {
  const n = p.length / 2;
  if (n < 3) return;
  for (let it = 0; it < iterations; it++) {
    let moved = 0;
    for (let i = 1; i < n - 1; i++) {
      const ax = p[i * 2 - 2],
        az = p[i * 2 - 1],
        bx = p[i * 2],
        bz = p[i * 2 + 1],
        cx = p[i * 2 + 2],
        cz = p[i * 2 + 3];
      const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax),
        den =
          Math.hypot(bx - ax, bz - az) *
          Math.hypot(cx - bx, cz - bz) *
          Math.hypot(cx - ax, cz - az);
      if (den < 1e-9) continue;
      const k = Math.abs((2 * cross) / den) * rmin(i);
      if (k <= 1) continue;
      const f = Math.min(0.5, 0.16 + (k - 1) * 0.22);
      p[i * 2] = bx + ((ax + cx) * 0.5 - bx) * f;
      p[i * 2 + 1] = bz + ((az + cz) * 0.5 - bz) * f;
      moved++;
    }
    if (!moved) break;
  }
}
// free meanders on reaches that are still unnaturally straight
function injectMeanders(reach, rnd) {
  const p = reach.pts,
    n = p.length / 2;
  if (n < 10) return;
  const s = arcLengths(p),
    L = s[n - 1];
  if (L < 150) return;
  const width = (i) => 2 * Math.max(reach.hw[i] || 4, 3);
  const straight = new Float32Array(n);
  let j0 = 0,
    j1 = 0;
  for (let i = 0; i < n; i++) {
    const win = clamp(width(i) * 6, 55, 420);
    while (j0 < i && s[i] - s[j0] > win) j0++;
    while (j1 < n - 1 && s[j1] - s[i] < win) j1++;
    const arc = s[j1] - s[j0],
      chord = Math.hypot(p[j1 * 2] - p[j0 * 2], p[j1 * 2 + 1] - p[j0 * 2 + 1]);
    straight[i] = arc > win * 0.9 ? smooth01(1.2, 1.04, arc / Math.max(chord, 1e-3)) : 0;
  }
  // soften the straightness field so meander amplitude never switches abruptly
  const soft = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0,
      wsum = 0;
    for (let k = -6; k <= 6; k++) {
      const q = Math.min(n - 1, Math.max(0, i + k)),
        w = 1 - Math.abs(k) / 7;
      acc += straight[q] * w;
      wsum += w;
    }
    soft[i] = acc / wsum;
  }
  const ph1 = rnd() * 64,
    side = rnd() < 0.5 ? 1 : -1;
  let phase = rnd() * Math.PI * 2;
  const off = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = width(i),
      wl = clamp(w * 11, 70, 650);
    if (i) phase += (Math.PI * 2 * (s[i] - s[i - 1])) / wl;
    const taper = smooth01(0, wl * 0.6, s[i]) * smooth01(0, wl * 0.6, L - s[i]),
      amp =
        clamp(w * 1.2, 10, 70) *
        soft[i] *
        taper *
        (0.7 + 0.6 * noise1(s[i] / (wl * 1.7) + ph1));
    off[i] = side * amp * (Math.sin(phase) + 0.22 * Math.sin(2 * phase + ph1));
  }
  const q = p.slice();
  for (let i = 1; i < n - 1; i++) {
    const tx = p[i * 2 + 2] - p[i * 2 - 2],
      tz = p[i * 2 + 3] - p[i * 2 - 1],
      tl = Math.hypot(tx, tz) || 1;
    q[i * 2] = p[i * 2] - (tz / tl) * off[i];
    q[i * 2 + 1] = p[i * 2 + 1] + (tx / tl) * off[i];
  }
  reach.pts = q;
}
function signedCurvature(p) {
  const count = p.length / 2;
  return Array.from({ length: count }, (_, i) => {
    if (!i || i === count - 1) return 0;
    const ax = p[i * 2] - p[i * 2 - 2],
      az = p[i * 2 + 1] - p[i * 2 - 1];
    const bx = p[i * 2 + 2] - p[i * 2],
      bz = p[i * 2 + 3] - p[i * 2 + 1];
    return (
      (ax * bz - az * bx) /
      Math.max(Math.hypot(ax, az) * Math.hypot(bx, bz) * Math.hypot(ax + bx, az + bz), 1)
    );
  });
}
// pull one end of a reach onto its parent's centreline (falloff over the last points)
function snapToParent(reach, parent, atStart) {
  const n = reach.pts.length / 2,
    pp = parent.pts;
  if (n < 2 || pp.length < 4) return;
  const idx = atStart ? 0 : n - 1,
    ex = reach.pts[idx * 2],
    ez = reach.pts[idx * 2 + 1];
  let best = null,
    distance = Infinity,
    node = 0;
  for (let i = 0; i < pp.length - 2; i += 2) {
    const ax = pp[i],
      az = pp[i + 1],
      dx = pp[i + 2] - ax,
      dz = pp[i + 3] - az,
      t = clamp(((ex - ax) * dx + (ez - az) * dz) / Math.max(dx * dx + dz * dz, 0.001)),
      x = ax + t * dx,
      z = az + t * dz,
      d = Math.hypot(x - ex, z - ez);
    if (d < distance) {
      distance = d;
      best = { x, z };
      node = (i >> 1) + (t > 0.5 ? 1 : 0);
    }
  }
  if (!best || distance > 180) return;
  const dx = best.x - ex,
    dz = best.z - ez,
    span = Math.max(1, Math.min(n - 1, 10));
  for (let j = 0; j <= span; j++) {
    const w = Math.pow(1 - j / span, 2),
      k = atStart ? j : n - 1 - j;
    reach.pts[k * 2] += dx * w;
    reach.pts[k * 2 + 1] += dz * w;
  }
  if (!atStart) reach.joinNode = node;
}

export function refineRiverNetwork(network, ctx) { const full = !network._unified; if (full) { unifyMainStems(network); network._unified = true; // Generalise the traced drainage into a few real river systems, then size each reach by the water it carries.
if (ctx) { shapeNetwork(network, ctx); dimensionNetwork(network, ctx); } }
  const reaches = network.reaches,
    level = new Map();
  const depthOf = (r) => {
    if (level.has(r.id)) return level.get(r.id);
    let d = 0,
      q = r;
    while (q && q.parent >= 0 && q.parent !== q.id && d < 64) {
      q = reaches[q.parent];
      d++;
    }
    level.set(r.id, d);
    return d;
  };
  const order = [...reaches].sort((a, b) => depthOf(a) - depthOf(b));
  for (const reach of order) {
    if (!reach.pts || reach.pts.length < 6) continue;
    const parent = reach.parent >= 0 ? reaches[reach.parent] : null;
    if (parent && parent !== reach)
      snapToParent(reach, parent, reach.kind === "distributary");
    const medHw = medianOf(reach.hw),
      rmin = (i) => clamp((reach.hw[i] || medHw) * 4.2, 20, 150);
    if (full) {
      const ds = clamp(medHw * 0.7, 5, 11);
      resampleReach(reach, ds);
      const sigma = clamp(1.1 * medHw + 8, 12, 45);
      taubin(reach.pts, Math.round(clamp(2 * (sigma / ds) ** 2, 4, 40)));
      const seed =
        ((reach.id + 1) * 2654435761) ^
        Math.round(reach.pts[0] * 7.31) ^
        (Math.round(reach.pts[1] * 3.17) << 9);
      injectMeanders(reach, seededRandom(seed));
      taubin(reach.pts, 3);
      limitCurvature(reach.pts, rmin, 70);
      resampleReach(reach, ds);
    } else {
      taubin(reach.pts, 3);
      limitCurvature(reach.pts, rmin, 30);
    }
    reach.length = arcLengths(reach.pts)[reach.pts.length / 2 - 1]; reach.curv = signedCurvature(reach.pts); } // The last word on width and depth, after the generator's own widening passes and once the lakes are known.
if (ctx) dimensionNetwork(network, ctx); }

/* ---------------------------------------------------------------------------
   Smooth waterlines
   ---------------------------------------------------------------------------
   Carving marks a cell wet when its *centre* lies inside the channel and then
   forces it >= 0.2 m below the datum, while the bank just outside is held
   >= 0.2 m above it. The h = 0 contour therefore always sits halfway between
   cell centres and traces the 10 m wet mask as a staircase. Here, after every
   other terrain pass, heights within about one cell of each river or lake
   edge are blended towards a single linear function of the true signed
   distance to that edge (same slope on both sides). Linear interpolation of
   the heightfield then places the waterline with sub-cell accuracy, so banks
   follow the real curved channel instead of the grid.
--------------------------------------------------------------------------- */
const BODY_LAND = 0;
const BODY_SEA = 1;
const BODY_LAKE = 2;
const BODY_RIVER = 3;
const BODY_ESTUARY = 6;

/* ---------------------------------------------------------------------------
   Guaranteed unobstructed navigable passages:
     1) River <-> Lake inlets & outlets (cuts cleanly through any shore rim,
        ridge ring, or delta shoal created before river polyline refinement)
     2) River <-> Sea estuaries (carves BOTH land/beach berms AND shallow sea
        bars smoothly out to open deep ocean, with a wide gradual brackish
        plume & flow-field transition so the water blends seamlessly!)
--------------------------------------------------------------------------- */
export function carveNavigablePassages(o) {
  const {
    N,
    cell,
    half,
    h,
    rivers,
    lakes,
    lakeId,
    body,
    wet,
    inl,
    flowX,
    flowZ,
    navMask,
    sed,
    swamp,
  } = o;
  if (!h || !N) return; // Stray pools filled, real swamps built and the water's fields rebuilt, before any passage is cut.
finishHydrology(o); if (!rivers?.length) return; const NN = N * N;

  const idxOf = (x, z) => {
    const ix = Math.round((x + half) / cell - 0.5);
    const iz = Math.round((z + half) / cell - 0.5);
    if (ix < 1 || iz < 1 || ix >= N - 1 || iz >= N - 1) return -1;
    return iz * N + ix;
  };

  // Carve a smooth, natural parabolic navigable channel along segment (ax,az)->(bx,bz)
  // that cuts cleanly through land rims, shoals, AND coastal sandbars alike.
  const carveSegment = (
    ax,
    az,
    bx,
    bz,
    hw0,
    hw1,
    d0,
    d1,
    spd0,
    spd1,
    opts = {},
  ) => {
    const dx = bx - ax,
      dz = bz - az,
      len2 = dx * dx + dz * dz;
    if (len2 < 1e-4) return;
    const len = Math.sqrt(len2);
    const dirX = dx / len,
      dirZ = dz / len;
    const bankFlare = opts.bankFlare ?? 1.55;
    const maxR = Math.max(hw0, hw1) * bankFlare + cell * 2.2;
    const x0 = Math.max(1, Math.floor((Math.min(ax, bx) - maxR + half) / cell));
    const x1 = Math.min(N - 2, Math.ceil((Math.max(ax, bx) + maxR + half) / cell));
    const z0 = Math.max(1, Math.floor((Math.min(az, bz) - maxR + half) / cell));
    const z1 = Math.min(N - 2, Math.ceil((Math.max(az, bz) + maxR + half) / cell));

    for (let iz = z0; iz <= z1; iz++) {
      const z = (iz + 0.5) * cell - half;
      for (let ix = x0; ix <= x1; ix++) {
        const x = (ix + 0.5) * cell - half;
        const t = clamp(((x - ax) * dx + (z - az) * dz) / len2);
        const px = ax + dx * t,
          pz = az + dz * t;
        const dist = Math.hypot(x - px, z - pz);
        const hw = mix(hw0, hw1, t);
        const outerR = hw * bankFlare + cell * 1.4;
        if (dist > outerR) continue;
        const k = iz * N + ix;
        const depthC = mix(d0, d1, t);
        const u = dist / Math.max(hw, 1);

        if (u < 1.0) {
          // Smooth flat-bottomed U/parabolic navigable channel: wide deep core for boats,
          // gentle sloped flanks up to the natural waterline.
          const core = 1 - smooth01(0.42, 1.0, u);
          const targetH = -Math.max(0.28, depthC * (0.24 + 0.76 * core));
          if (targetH < h[k]) h[k] = targetH;
          if (!opts.keepSea || body[k] !== BODY_SEA) {
            wet[k] = 1;
            if (body[k] === BODY_LAND) {
              body[k] = opts.estuary ? BODY_ESTUARY : BODY_RIVER;
            }
          }
          if (u < 0.74 && navMask) navMask[k] = 1;
          if (swamp && u < 0.78) swamp[k] *= smooth01(0.45, 0.9, u);

          // Blend smooth natural flow velocity through junction/mouth
          const spd = mix(spd0, spd1, t) * (0.45 + 0.55 * core);
          if (spd > 0.02 && flowX && flowZ) {
            const cur = Math.hypot(flowX[k], flowZ[k]);
            if (spd > cur * 0.85) {
              flowX[k] = mix(flowX[k], dirX * spd, 0.65);
              flowZ[k] = mix(flowZ[k], dirZ * spd, 0.65);
            }
          }
          if (inl && opts.inlTarget != null && !(opts.keepSea && body[k] === BODY_SEA)) {
            const inlV = mix(opts.inlTarget[0], opts.inlTarget[1], t);
            inl[k] = Math.max(inl[k], inlV * (0.55 + 0.45 * core));
          }
          if (sed && opts.sedVal != null) {
            sed[k] = Math.max(sed[k], opts.sedVal * (0.5 + 0.5 * core));
          }
        } else {
          // Gently grade adjacent dry banks down toward the channel so there are no vertical cliffs
          if (h[k] > 0) {
            const bankT = smooth01(1.0, bankFlare, u);
            const bankTarget = 0.25 + bankT * bankT * (opts.estuary ? 3.2 : 5.4);
            if (h[k] > bankTarget) {
              h[k] = mix(h[k], bankTarget, (1 - bankT) * 0.78);
            }
          }
        }
      }
    }
  };

  // 1) RIVER <-> LAKE PASSAGES: ensure every river touching or passing near a lake
  //    has a deep, wide, completely unobstructed throat into and out of the lake basin.
  for (const r of rivers) {
    const p = r.pts,
      hw = r.hw,
      m = Math.min(hw.length, p.length / 2);
    if (m < 3) continue;
    const isNav = r.navigable || r.kind === "main" || r.kind === "secondary";

    for (const lake of lakes || []) {
      const reachR = lake.r * 1.65 + 90;
      let minDist = Infinity,
        closestIdx = -1;
      for (let i = 0; i < m; i++) {
        const d = Math.hypot(p[i * 2] - lake.x, p[i * 2 + 1] - lake.z);
        if (d < minDist) {
          minDist = d;
          closestIdx = i;
        }
      }
      if (minDist > reachR) continue;

      // Carve continuously along every reach segment crossing the lake rim zone (0.45*r .. 1.55*r)
      for (let i = 0; i + 1 < m; i++) {
        const ax = p[i * 2],
          az = p[i * 2 + 1],
          bx = p[i * 2 + 2],
          bz = p[i * 2 + 3];
        const mx = (ax + bx) * 0.5,
          mz = (az + bz) * 0.5;
        const dMid = Math.hypot(mx - lake.x, mz - lake.z);
        if (dMid > lake.r * 1.65 + 70) continue;
        // Flare width gently right as the river opens into the lake bay
        const mouthFlare = 1 + 0.22 * (1 - smooth01(lake.r * 0.65, lake.r * 1.4, dMid));
        const w0 = Math.max(hw[i] * mouthFlare, isNav ? 13 : 10.5);
        const w1 = Math.max(hw[i + 1] * mouthFlare, isNav ? 13 : 10.5);
        const d0 = Math.max(r.depths?.[i] || 2.8, isNav ? 2.9 : 2.2);
        const d1 = Math.max(r.depths?.[i + 1] || 2.8, isNav ? 2.9 : 2.2);
        const s0 = r.speeds?.[i] ?? 0.25;
        const s1 = r.speeds?.[i + 1] ?? 0.25;
        carveSegment(ax, az, bx, bz, w0, w1, d0, d1, s0, s1, {
          bankFlare: 1.6,
          inlTarget: [1.0, 1.0],
        });
      }

      // If the river polyline skirted the lake edge (closest point is outside lake basin),
      // bridge a natural navigable inlet/outlet channel straight into the lake's deep water!
      if (closestIdx >= 0 && minDist > lake.r * 0.55 && minDist < lake.r * 1.42) {
        const sx = p[closestIdx * 2],
          sz = p[closestIdx * 2 + 1];
        const vx = lake.x - sx,
          vz = lake.z - sz;
        const vl = Math.hypot(vx, vz) || 1;
        const ex = sx + (vx / vl) * Math.min(vl * 0.72, lake.r * 0.85);
        const ez = sz + (vz / vl) * Math.min(vl * 0.72, lake.r * 0.85);
        const wBase = Math.max(hw[closestIdx] || 13, isNav ? 14 : 11);
        carveSegment(sx, sz, ex, ez, wBase, wBase * 1.25, 2.9, 3.4, 0.26, 0.14, {
          bankFlare: 1.65,
          inlTarget: [1.0, 1.0],
        });
      }
    }
  }

  // 2) RIVER -> SEA: one slim passage through the beach berm and the bar beyond it, out to water a boat floats
// in. No trumpet and no lane dredged across the reef flat: a river mouth, not a lagoon. The sea it crosses
// stays sea; only the berm it cuts through becomes river.
for (const r of rivers) { if (r.outlet !== "Sea" && r.bodyKind !== BODY_ESTUARY) continue; const p = r.pts, hw = r.hw, m = Math.min(hw.length, p.length / 2); if (m < 3) continue; let startIdx = m - 1, backDist = 0; while (startIdx > 0 && backDist < 70) { backDist += Math.hypot(p[startIdx * 2] - p[(startIdx - 1) * 2], p[startIdx * 2 + 1] - p[(startIdx - 1) * 2 + 1]); startIdx--; } const endX = p[(m - 1) * 2], endZ = p[(m - 1) * 2 + 1]; const refIdx = Math.max(0, m - 5); let dirX = endX - p[refIdx * 2], dirZ = endZ - p[refIdx * 2 + 1]; const dl = Math.hypot(dirX, dirZ) || 1; dirX /= dl; dirZ /= dl; const mouthPts = []; for (let i = startIdx; i < m; i++) mouthPts.push({ x: p[i * 2], z: p[i * 2 + 1], hw: hw[i] || 14, d: Math.max(r.depths?.[i] || 2.6, 2.6), spd: Math.max(r.speeds?.[i] || 0.3, 0.24), }); let cx = endX, cz = endZ; const mouthHw = Math.min(hw[m - 1] || 16, 32); const mouthSpd = Math.max(r.speeds?.[m - 1] || 0.34, 0.28); const step = 14; let reachedSeaAt = -1; for (let s = 1; s <= 30; s++) { const distOut = s * step; // Steer gently toward deeper water, so the passage never runs along a sandspit.
let bestDX = dirX, bestDZ = dirZ, bestScore = Infinity; for (const ang of [-0.45, -0.22, 0, 0.22, 0.45]) { const ca = Math.cos(ang), sa = Math.sin(ang); const tx = dirX * ca - dirZ * sa; const tz = dirX * sa + dirZ * ca; const probeK = idxOf(cx + tx * 45, cz + tz * 45); if (probeK < 0) continue; const score = h[probeK] + Math.abs(ang) * 2.2; if (score < bestScore) { bestScore = score; bestDX = tx; bestDZ = tz; } } dirX = mix(dirX, bestDX, 0.35); dirZ = mix(dirZ, bestDZ, 0.35); const nLen = Math.hypot(dirX, dirZ) || 1; dirX /= nLen; dirZ /= nLen; cx += dirX * step; cz += dirZ * step; const k = idxOf(cx, cz); if (k < 0) break; if (body[k] === BODY_SEA && reachedSeaAt < 0) reachedSeaAt = distOut; const seaDist = reachedSeaAt >= 0 ? distOut - reachedSeaAt : 0; // Past the beach it narrows to a boat channel and is gone.
const wHere = Math.max(9, mouthHw * (1 - 0.55 * smooth01(20, 190, seaDist))); const dHere = 2.7 + 0.5 * smooth01(0, 120, seaDist); mouthPts.push({ x: cx, z: cz, hw: wHere, d: dHere, spd: mouthSpd * Math.exp(-seaDist / 90) }); if (reachedSeaAt >= 0 && (h[k] < -3.0 || seaDist > 230)) break; } for (let i = 0; i + 1 < mouthPts.length; i++) { const a = mouthPts[i], b = mouthPts[i + 1]; carveSegment(a.x, a.z, b.x, b.z, a.hw, b.hw, a.d, b.d, a.spd, b.spd, { estuary: true, keepSea: true, bankFlare: 1.4, inlTarget: [1, 1], }); } } // 3) The plume. Over the sea only, the inland mask is softened so the river's surface and the sea's cross-fade
// without a seam. Fresh water itself stays wholly fresh, right to its banks.
if (inl) { const tmp = new Float32Array(NN); for (let pass = 0; pass < 4; pass++) { tmp.set(inl); for (let iz = 1; iz < N - 1; iz++) for (let ix = 1; ix < N - 1; ix++) { const k = iz * N + ix; if (body[k] !== BODY_SEA || h[k] >= 0) continue; let sum = tmp[k] * 2, weight = 2; for (const q of [k - 1, k + 1, k - N, k + N]) { if (h[q] >= 0) continue; sum += tmp[q]; weight++; } inl[k] = Math.min(0.98, Math.max(tmp[k] * 0.6, sum / weight)); } } } } export function sculptRiverWaterlines(o) {
  const { N, cell, half, h, rivers, body, lakeId, wet, lakeSD, navMask } = o;
  if (!h || !N) return;
  const NN = N * N,
    SLOPE = 0.095,
    bandOut = cell * 2.4,
    minHalf = cell * 1.05,
    sd = new Float32Array(NN).fill(1e9),
    vtAt = new Float32Array(NN);
  for (const r of rivers || []) {
    const p = r.pts,
      hw = r.hw,
      m = Math.min(hw.length, p.length / 2);
    for (let F = 0; F + 1 < m; F++) {
      const C = p[F * 2],
        P = p[F * 2 + 1],
        U = p[F * 2 + 2] - C,
        V = p[F * 2 + 3] - P,
        len2 = U * U + V * V || 1,
        reachR = Math.max(hw[F], hw[F + 1], minHalf) + bandOut + cell,
        x0 = Math.max(0, Math.floor((Math.min(C, C + U) - reachR + half) / cell)),
        x1 = Math.min(N - 1, Math.ceil((Math.max(C, C + U) + reachR + half) / cell)),
        z0 = Math.max(0, Math.floor((Math.min(P, P + V) - reachR + half) / cell)),
        z1 = Math.min(N - 1, Math.ceil((Math.max(P, P + V) + reachR + half) / cell));
      for (let iz = z0; iz <= z1; iz++) {
        const z = (iz + 0.5) * cell - half;
        for (let ix = x0; ix <= x1; ix++) {
          const x = (ix + 0.5) * cell - half,
            t = clamp(((x - C) * U + (z - P) * V) / len2),
            d = Math.hypot(x - (C + U * t), z - (P + V * t)),
            vt = Math.max(mix(hw[F], hw[F + 1], t), minHalf),
            s = d - vt,
            k = iz * N + ix;
          if (s < sd[k]) {
            sd[k] = s;
            vtAt[k] = vt;
          }
        }
      }
    }
  }
  // 1) soften the carved channel core: the navigable-depth clamp and the per-cell
  //    slope limiter leave grid-aligned steps on the bed that show up as blocky
  //    depth colour. A few masked averaging passes inside the channel only.
  const inside = (k) =>
    sd[k] < -0.5 && wet[k] && h[k] < 0 && body[k] !== BODY_SEA && lakeId[k] < 0;
  const copy = new Float32Array(NN);
  for (let pass = 0; pass < 3; pass++) {
    copy.set(h);
    for (let iz = 1; iz < N - 1; iz++)
      for (let ix = 1; ix < N - 1; ix++) {
        const k = iz * N + ix;
        if (!inside(k)) continue;
        let acc = copy[k] * 4,
          wsum = 4;
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dz) continue;
            const q = k + dz * N + dx;
            if (!inside(q)) continue;
            const w = dx && dz ? 1 : 2;
            acc += copy[q] * w;
            wsum += w;
          }
