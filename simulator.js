// simulator.js — Statevector simulator for Q-Builder V2 (ES Module)
// Exports: simulateCircuit(ir, opts?) → {
//   qubits, ops, probs, amps, counts?, entangledLikely, postSelectProb
// }
// Gates supported:
//   1Q:  X, Y, Z, H, S, T, Rx, Ry, Rz
//   2Q:  CX, CY, CZ, SWAP
//   3Q:  CCX (Toffoli), CSWAP (Fredkin)
// Notes:
//  - Accepts both refs like "gate.x" and "X" (case-insensitive).
//  - Shots + noise are applied at READOUT (fast & browser-friendly).
//  - Post-selection is honored if IR contains: {type:"note", ref:"postselect", targets:[bit], params:{expect:0|1}}

export async function simulateCircuit(ir, opts = {}) {
  const shots = Math.max(0, Number(opts.shots ?? 0)) | 0;
  const noise = opts.noise || null;
  const seed  = Number.isFinite(opts.seed) ? (opts.seed|0) : null;

  // ----- RNG (seeded if provided) -----
  const rand = (function mkRNG(s) {
    if (s == null) return Math.random;
    function mulberry32(a){return function(){let t = a += 0x6D2B79F5; t = Math.imul(t ^ t>>>15, t | 1); t ^= t + Math.imul(t ^ t>>>7, t | 61); return ((t ^ t>>>14) >>> 0) / 4294967296;};}
    return mulberry32(s);
  })(seed);

  // ----- IR prep -----
  const n = Math.max(ir?.circuit?.qubits ?? 0, 0);
  const N = 1 << n;
  const ops = (ir?.circuit?.ops || []).slice().sort((a,b)=> (a.tick||0)-(b.tick||0));

  // Initialize |0...0>
  let psi = new Array(N).fill(null).map((_,i)=> i===0 ? C(1,0) : C(0,0));

  // Heuristic: any multi-qubit gate likely produces entanglement
  let entangledLikely = false;

  // ----- Evolve state -----
  for (const op of ops) {
    if (op.type !== "gate") continue;
    const ref = String(op.ref || "").toUpperCase();
    const refNorm = ref.startsWith("GATE.") ? ref.slice(5) : ref; // support "gate.x" & "X"
    const t = (op.targets || []).map(Number);

    switch (refNorm) {
      // 1Q
      case "X":  psi = apply1(psi, n, t[0], Mx); break;
      case "Y":  psi = apply1(psi, n, t[0], My); break;
      case "Z":  psi = apply1(psi, n, t[0], Mz); break;
      case "H":  psi = apply1(psi, n, t[0], Mh); break;
      case "S":  psi = apply1(psi, n, t[0], Ms); break;
      case "T":  psi = apply1(psi, n, t[0], Mt); break;
      case "RX": psi = apply1(psi, n, t[0], Mrx(Number(op.params?.theta || 0))); break;
      case "RY": psi = apply1(psi, n, t[0], Mry(Number(op.params?.theta || 0))); break;
      case "RZ": psi = apply1(psi, n, t[0], Mrz(Number(op.params?.theta || 0))); break;

      // 2Q
      case "CX": psi = applyCX(psi, n, t[0], t[1]); entangledLikely = true; break;
      case "CY": psi = applyCY(psi, n, t[0], t[1]); entangledLikely = true; break;
      case "CZ": psi = applyCZ(psi, n, t[0], t[1]); entangledLikely = true; break;
      case "SWAP": psi = applySWAP(psi, n, t[0], t[1]); entangledLikely = true; break;

      // 3Q
      case "CCX": case "CCNOT": psi = applyCCX(psi, n, t[0], t[1], t[2]); entangledLikely = true; break;
      case "CSWAP": psi = applyCSWAP(psi, n, t[0], t[1], t[2]); entangledLikely = true; break;

      default: /* unknown gate → ignore */ break;
    }
  }

  // ----- Post-selection (from IR note) -----
  let postSelectProb = null;
  const postNote = (ir?.circuit?.ops || []).find(o => o.type === "note" && o.ref === "postselect");
  if (postNote && Array.isArray(postNote.targets) && postNote.targets.length > 0) {
    const bit = Number(postNote.targets[0]);
    const val = Number(postNote.params?.expect ?? 1) ? 1 : 0;
    postSelectProb = postSelectByBit(psi, n, bit, val); // renormalizes psi
  }

  // ----- Analytics -----
  const probs = psi.map(a => a.re*a.re + a.im*a.im);

  // ----- Shots + readout noise -----
  let counts = null;
  if (shots > 0) {
    counts = new Map();
    const cdf = cdfFromProbs(probs);
    for (let s = 0; s < shots; s++) {
      const idx = sampleIdx(cdf, rand());
      let bits = idx.toString(2).padStart(n, "0"); // MSB→LSB string

      // Readout noise approximations (fast)
      if (noise && noise.type) bits = applyReadoutNoise(bits, noise, rand);

      counts.set(bits, (counts.get(bits) || 0) + 1);
    }
  }

  return {
    qubits: n,
    ops: ops.filter(o => o.type === "gate").length,
    probs,
    amps: psi,
    counts,
    entangledLikely,
    postSelectProb
  };
}

/* ============================
   Complex helpers
============================ */
function C(re=0, im=0){ return {re, im}; }
function cadd(a,b){ return C(a.re+b.re, a.im+b.im); }
function cmul(a,b){ return C(a.re*b.re - a.im*b.im, a.re*b.im + a.im*b.re); }

/* ============================
   1-qubit matrices
============================ */
const ONE = C(1,0), ZERO = C(0,0);
const Mx = [[ZERO, ONE],[ONE, ZERO]];
const My = [[ZERO, C(0,-1)],[C(0,1), ZERO]];                 // [[0,-i],[i,0]]
const Mz = [[ONE, ZERO],[ZERO, C(-1,0)]];
const Mh = (()=>{ const s=1/Math.SQRT2; return [[C(s,0), C(s,0)],[C(s,0), C(-s,0)]]; })();
const Ms = [[ONE, ZERO],[ZERO, C(0,1)]];                     // S phase
const Mt = [[ONE, ZERO],[ZERO, C(Math.SQRT1_2, Math.SQRT1_2)]]; // T = exp(iπ/4)

function Mrx(theta){
  const c = Math.cos(theta/2), s = Math.sin(theta/2);
  return [[C(c,0), C(0,-s)], [C(0,-s), C(c,0)]];
}
function Mry(theta){
  const c = Math.cos(theta/2), s = Math.sin(theta/2);
  return [[C(c,0), C(-s,0)], [C(s,0), C(c,0)]];
}
function Mrz(theta){
  const p = theta/2;
  // e^{-i p} and e^{+i p}
  return [[C(Math.cos(-p), Math.sin(-p)), ZERO], [ZERO, C(Math.cos(p), Math.sin(p))]];
}

/* ============================
   Core application kernels
============================ */
// Apply a 1-qubit unitary to target bit q
function apply1(state, n, q, M){
  if (!Number.isInteger(q) || q<0 || q>=n) return state;
  const size = 1 << n;
  const out = state.slice();
  const mask = 1 << q;

  for (let i=0; i<size; i++){
    if ((i & mask) === 0){
      const j = i | mask;
      const a0 = state[i];
      const a1 = state[j];
      const a0p = cadd( cmul(M[0][0], a0), cmul(M[0][1], a1) );
      const a1p = cadd( cmul(M[1][0], a0), cmul(M[1][1], a1) );
      out[i] = a0p; out[j] = a1p;
    }
  }
  return out;
}

// CX
function applyCX(state, n, control, target){
  if (!valid2(n, control, target)) return state;
  const size = 1<<n, cm=1<<control, tm=1<<target;
  const out = state.slice();
  for (let i=0;i<size;i++){
    if ((i & cm) && ((i & tm) === 0)){
      const j = i | tm; out[i] = state[j]; out[j] = state[i];
    }
  }
  return out;
}

// CY
function applyCY(state, n, control, target){
  if (!valid2(n, control, target)) return state;
  const size = 1<<n, cm=1<<control, tm=1<<target;
  const out = state.slice();
  for (let i=0;i<size;i++){
    if ((i & cm) && ((i & tm) === 0)){
      const j = i | tm;
      const a0 = state[i], a1 = state[j];
      // Y|0> = i|1>, Y|1> = -i|0>
      // Apply My to the pair [a0; a1]:
      out[i] = cadd( cmul(My[0][0], a0), cmul(My[0][1], a1) );
      out[j] = cadd( cmul(My[1][0], a0), cmul(My[1][1], a1) );
    }
  }
  return out;
}

// CZ
function applyCZ(state, n, control, target){
  if (!valid2(n, control, target)) return state;
  const size = 1<<n, cm=1<<control, tm=1<<target, both = cm | tm;
  const out = state.slice();
  for (let i=0;i<size;i++){
    if ((i & both) === both){ out[i] = C(-out[i].re, -out[i].im); }
  }
  return out;
}

// SWAP
function applySWAP(state, n, q0, q1){
  if (!valid2(n, q0, q1)) return state;
  if (q0 === q1) return state;
  const [a,b] = q0<q1 ? [q0,q1] : [q1,q0];
  const size = 1<<n, am=1<<a, bm=1<<b;
  const out = state.slice();
  for (let i=0;i<size;i++){
    const ia = (i & am) ? 1 : 0;
    const ib = (i & bm) ? 1 : 0;
    if (ia !== ib){
      const j = i ^ (am | bm);
      if (i < j){ out[i] = state[j]; out[j] = state[i]; }
    }
  }
  return out;
}

// CCX (Toffoli)
function applyCCX(state, n, c1, c2, target){
  if (!valid3(n, c1, c2, target)) return state;
  const size = 1<<n, m1=1<<c1, m2=1<<c2, mt=1<<target;
  const out = state.slice();
  for (let i=0;i<size;i++){
    if ((i&m1) && (i&m2) && ((i&mt)===0)){
      const j = i | mt; out[i] = state[j]; out[j] = state[i];
    }
  }
  return out;
}

// CSWAP (Fredkin)
function applyCSWAP(state, n, control, q0, q1){
  if (!valid3(n, control, q0, q1)) return state;
  if (q0 === q1) return state;
  const size = 1<<n, cm=1<<control, a=1<<q0, b=1<<q1;
  const out = state.slice();
  for (let i=0;i<size;i++){
    if ((i & cm) === 0) continue;
    const ia = (i & a) ? 1 : 0, ib = (i & b) ? 1 : 0;
    if (ia !== ib){
      const j = i ^ (a | b);
      if (i < j){ out[i] = state[j]; out[j] = state[i]; }
    }
  }
  return out;
}

function valid2(n,a,b){ return Number.isInteger(a)&&Number.isInteger(b)&&a>=0&&b>=0&&a<n&&b<n&&a!==b; }
function valid3(n,a,b,c){ return new Set([a,b,c]).size===3 && [a,b,c].every(q=>Number.isInteger(q)&&q>=0&&q<n); }

/* ============================
   Post-selection & sampling
============================ */
function postSelectByBit(psi, n, bit, expect){
  if (!Number.isInteger(bit) || bit < 0 || bit >= n) return null;
  const mask = 1 << bit;
  let keep = 0;
  for (let i=0;i<psi.length;i++){
    const v = (i & mask) ? 1 : 0;
    if (v !== expect) { psi[i] = C(0,0); } else { keep += psi[i].re*psi[i].re + psi[i].im*psi[i].im; }
  }
  if (keep <= 0) return 0;
  const norm = 1 / Math.sqrt(keep);
  for (let i=0;i<psi.length;i++){ psi[i].re *= norm; psi[i].im *= norm; }
  return keep; // probability mass kept before renormalization
}

function cdfFromProbs(probs){
  const N = probs.length, cdf = new Float64Array(N);
  let s = 0; for (let i=0;i<N;i++){ s += probs[i]; cdf[i] = s; }
  if (s > 0){ for (let i=0;i<N;i++) cdf[i] /= s; }
  return cdf;
}
function sampleIdx(cdf, r){
  let lo = 0, hi = cdf.length - 1;
  while (lo < hi){
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < r) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function applyReadoutNoise(bits, noise, rand){
  const n = bits.length;
  const arr = bits.split(""); // MSB…LSB
  if (!noise || !noise.type) return bits;

  for (let i=0;i<n;i++){
    const b = arr[i] === "1" ? 1 : 0;
    if (noise.type === "DEPOLARIZING" || noise.type === "depolarizing") {
      const p = Number(noise.p ?? noise.prob ?? 0);
      if (rand() < p) arr[i] = b ? "0" : "1";
    } else if (noise.type === "AMP-DAMP" || noise.type === "amp-damp") {
      const g = Number(noise.gamma ?? noise.g ?? 0);
      if (b === 1 && rand() < g) arr[i] = "0";
    } else if (noise.type === "PHASE-DAMP" || noise.type === "phase-damp") {
      // no change to populations at readout
    }
  }
  return arr.join("");
}
