        const smoothed = Math.min(acc / wsum, -0.05);
        h[k] = navMask && navMask[k] ? Math.min(smoothed, -2.5) : smoothed;
      }
  }
  // 2) exact linear profile across the waterline (same slope both sides), then
  //    a short blend back to the existing bed / bank — NEVER raising a navigable
  //    river-lake junction or river-sea mouth above navigable boat draft!
  const linIn = cell * 1.15,
    linOut = cell * 1.2,
    blend = cell * 0.7;
  const reshape = (k, s, halfWidth) => {
    const t = SLOPE * s;
    if (s < 0) {
      if (!wet[k] || h[k] >= 0) return;
      // Preserve deep carved navigable fairways so boats never ground on artificial sills
      if (navMask && navMask[k]) {
        const l1 = Math.min(linIn * 0.6, halfWidth * 0.45),
          w = smooth01(l1, l1 + blend, -s);
        h[k] = Math.min(h[k], Math.min(t + (h[k] - t) * w, -2.2));
        return;
      }
      const l1 = Math.min(linIn, halfWidth * 0.75),
        w = smooth01(l1, l1 + blend, -s);
      h[k] = Math.min(t + (h[k] - t) * w, -0.004);
    } else {
      if (wet[k] || h[k] <= 0) return;
      const w = smooth01(linOut, linOut + blend, s);
      h[k] = Math.max(t + (h[k] - t) * w, 0.004);
    }
  };
  const reach = linOut + blend;
  for (let k = 0; k < NN; k++) {
    const s = sd[k];
    if (s > reach || body[k] === BODY_SEA || lakeId[k] >= 0) continue;
    reshape(k, s, vtAt[k]);
  }
  if (lakeSD)
    for (let k = 0; k < NN; k++) {
      const s = lakeSD[k];
      if (s > reach || body[k] === BODY_SEA) continue;
      // CRITICAL: never build a shallow lake-shore sill across a river inlet/outlet!
      if (sd[k] < reach * 1.25 || (navMask && navMask[k])) continue;
      if (s < 0 && lakeId[k] < 0) continue;
      reshape(k, s, 1e9);
    }
}

export function buildFreshwaterGeometry(world) {
  const position = [],
    water = [],
    edge = [],
    river = [],
    swamp = [],
    maskAttr = [];
  const n = world.N;
  const hasSwamp = !!world.swamp;
  const hasLake = !!world.lakeId; // The estuary mask, made safe at the banks. inl is 1 on fresh water and 0 on dry ground, so sampled bilinearly
// it used to fall away toward every bank: the surface faded out along the shore and took on its sea-mouth look
// there, leaving the shallows see-through. Dry cells now take the strongest mask of the water beside them, so
// the surface stays whole right up to the waterline and fades only where fresh water truly meets the sea.
const maskField = freshwaterCoverage(world);
  const sample = (x, z) => {
    const ix = Math.min(n - 2, Math.floor(x)),
      iz = Math.min(n - 2, Math.floor(z));
    const u = x - ix,
      v = z - iz,
      k = iz * n + ix;
    const at = (a) =>
      mix(mix(a[k], a[k + 1], u), mix(a[k + n], a[k + n + 1], u), v);
    const depth = -at(world.h);
    let lk = 0;
    if (hasLake) {
      const l00 = world.lakeId[k] >= 0 ? 1 : 0;
      const l10 = world.lakeId[k + 1] >= 0 ? 1 : 0;
      const l01 = world.lakeId[k + n] >= 0 ? 1 : 0;
      const l11 = world.lakeId[k + n + 1] >= 0 ? 1 : 0;
      lk = mix(mix(l00, l10, u), mix(l01, l11, u), v);
    }
    const swVal = hasSwamp ? at(world.swamp) : 0;
    // Open lakes stay purely crisp & crystalline even near low marsh margins
    const sw = clamp(swVal * (1 - lk * 0.88), 0, 1);
    return {
      x: (x + 0.5) * world.cell - world.half,
      z: (z + 0.5) * world.cell - world.half,
      depth,
      fx: at(world.flowX),
      fz: at(world.flowZ),
      sed: at(world.sed),
      mask: at(maskField),
      sw,
      lk,
    };
  };
  const interpolate = (a, b) => {
    const t = a.depth / (a.depth - b.depth);
    return Object.fromEntries(
      Object.keys(a).map((k) => [k, mix(a[k], b[k], t)]),
    );
  };
  const emit = (p) => {
    // Exact matched smoothstep(0.28, 0.90, p.mask) with ocean freshTakeover so
    // freshwater + sea sum smoothly to 1.0 with zero seam across every estuary mouth!
    const mouthFade = smooth01(0.28, 0.90, p.mask);
    // Feather vertical offset gently from 0.008 inland to 0.001 at the sea mouth
    const yLevel = 0.001 + 0.007 * mouthFade;
    position.push(p.x, yLevel, p.z);
    water.push(p.fx, p.fz, Math.max(0.001, p.depth), p.sed);
    // Coverage is not depth: interpolating a zero at the bank fades an entire 5 m triangle.
    // The fragment shader handles the millimetre-scale contact feather instead.
    edge.push(mouthFade);
    river.push(clamp((Math.hypot(p.fx, p.fz) - 0.04) / 0.30));
    swamp.push(p.sw, p.lk);
    maskAttr.push(mouthFade);
  };
  for (let z = 0; z < n - 1; z++)
    for (let x = 0; x < n - 1; x++) {
      const k = z * n + x;
      if (
        Math.max(
          maskField[k],
          maskField[k + 1],
          maskField[k + n],
          maskField[k + n + 1],
        ) < 0.285
      )
        continue;
      if (
        Math.min(
          world.h[k],
          world.h[k + 1],
          world.h[k + n],
          world.h[k + n + 1],
        ) >= 0
      )
        continue;
      for (let sz = 0; sz < 2; sz++)
        for (let sx = 0; sx < 2; sx++) {
          const a = sample(x + sx / 2, z + sz / 2),
            b = sample(x + (sx + 1) / 2, z + sz / 2);
          const c = sample(x + sx / 2, z + (sz + 1) / 2),
            d = sample(x + (sx + 1) / 2, z + (sz + 1) / 2);
          for (const tri of [
            [a, c, b],
            [b, c, d],
          ]) {
            const poly = [];
            for (let i = 0; i < 3; i++) {
              const p = tri[i],
                q = tri[(i + 1) % 3];
              if (p.depth >= 0) poly.push(p);
              if (p.depth >= 0 !== q.depth >= 0) poly.push(interpolate(p, q));
            }
            for (let i = 1; i < poly.length - 1; i++) {
              emit(poly[0]);
              emit(poly[i]);
              emit(poly[i + 1]);
            }
          }
        }
    }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("aWater", new Float32BufferAttribute(water, 4));
  geometry.setAttribute("aEdge", new Float32BufferAttribute(edge, 1));
  geometry.setAttribute("aRiver", new Float32BufferAttribute(river, 1));
  geometry.setAttribute("aSwamp", new Float32BufferAttribute(swamp, 2));
  geometry.setAttribute("aMask", new Float32BufferAttribute(maskAttr, 1));
  geometry.computeBoundingSphere();
  return geometry;
}
