// intel.js — CKG-powered suggestions + quantum-aware linter (ES Module)
//
// Exports:
//   - loadCKG(): Promise<CKGObject>
//   - suggest({domain, problem, title}, ckg): Array<{type,label,explain}>
//   - lint(ir, ckg): { errors:[], warnings:[], info:[], depth, twoQCount, marks:[] }
//
// CKG shape (ckg.json expected):
// {
//   "nodes": [
//     { "name":"Hadamard Gate (H)", "kind":"gate", "map":"gate.h",
//       "domains":["general"], "problems":["any"], "tags":["superposition"],
//       "explain":"Creates superposition of |0> and |1|." },
//     { "name":"Grover Algorithm", "kind":"algorithm", "map":"algo.grover",
//       "domains":["finance","general"], "problems":["search"], "tags":["oracle","diffuser"],
//       "explain":"Quadratic speedup for unstructured search." },
//     ...
//   ],
//   "rules": [
//     {"if":{"domain":"finance","problem":"search"},
//      "then":{"requireOneOf":["oracle.*"], "recommend":["algo.grover","gate.h","gate.cx"]},
//      "explain":"Grover search in finance typically needs a marking oracle."}
//   ]
// }
//
// If ckg.json is missing/invalid, we fall back to a minimal built-in graph.

const DEFAULT_CKG = {
  nodes: [
    { name:"Hadamard Gate (H)", kind:"gate", map:"gate.h",
      domains:["general"], problems:["any"], tags:["superposition"],
      explain:"Creates superposition. Often used at circuit start." },
    { name:"Pauli-X", kind:"gate", map:"gate.x",
      domains:["general"], problems:["any"], tags:["bit-flip"],
      explain:"Bit-flip (NOT) gate." },
    { name:"CNOT", kind:"gate", map:"gate.cx",
      domains:["general"], problems:["any"], tags:["entangle"],
      explain:"Controlled-X; primary entangling 2-qubit gate." },
    { name:"Grover Algorithm", kind:"algorithm", map:"algo.grover",
      domains:["finance","logistics","general"], problems:["search"], tags:["oracle","diffusion"],
      explain:"Quadratic speedup for unstructured search; needs an oracle." },
    { name:"Marked Oracle", kind:"oracle", map:"oracle.marked",
      domains:["finance","general"], problems:["search"], tags:["marking","phase-flip"],
      explain:"Phase-flips marked states; used by Grover-like workflows." },
    { name:"Deutsch–Jozsa", kind:"algorithm", map:"algo.dj",
      domains:["cryptography","general"], problems:["classification"],
      tags:["balanced/constant"], explain:"Tests if a function is balanced or constant." },
    { name:"QAOA", kind:"algorithm", map:"algo.qaoa",
      domains:["finance","logistics"], problems:["optimization"], tags:["variational"],
      explain:"Approximate combinatorial optimization via alternating operators." }
  ],
  rules: [
    { if:{domain:"finance", problem:"search"},
      then:{ requireOneOf:["oracle.*"], recommend:["algo.grover","gate.h","gate.cx"] },
      explain:"Grover search in finance needs a marking oracle and entanglement." }
  ]
};

// intel.js  ───────────────────────────────────────────────────────────

// Add near the top (before normalizeCKG)
const KIND_ALIASES = {
  gate: 'gate', g: 'gate',
  oracle: 'oracle', o: 'oracle',
  algorithm: 'algorithm', algo: 'algorithm',
  solution: 'solution', sol: 'solution'
};
function normKind(k = '') {
  const key = String(k).toLowerCase().trim();
  return KIND_ALIASES[key] || key;   // default to original if no alias
}

/* =========================
   Public API
========================= */
export async function loadCKG(){
  try{
    const res = await fetch('./ckg.json', { cache: 'no-store' });
    if(!res.ok) throw new Error('ckg missing');
    const data = await res.json();
    if (!Array.isArray(data?.nodes)) throw new Error('ckg bad');
    return normalizeCKG(data);
  }catch(_){
    console.warn('[intel] Using fallback CKG.');
    return normalizeCKG(DEFAULT_CKG);
  }
}

export function suggest(query, ckg){
  const { domain, problem, title } = sanitizeQuery(query);
  const KG = ckg || DEFAULT_CKG;

  // score each node by: (domain match + problem match + title similarity + general boost)
  const tokens = tokenize(title);
  const scored = KG.nodes.map(n=>{
    let s = 0;
    s += matchDomain(n.domains, domain) ? 2 : (n.domains.includes("general")? 1 : 0);
    s += matchProblem(n.problems, problem) ? 2 : (n.problems.includes("any")? 1 : 0);
    s += jaccard(tokens, tokenize(n.name.concat(' ', (n.tags||[]).join(' ')))) * 3;
    // prefer concrete gate/algorithm/oracle maps that exist in the palette
    s += paletteKnown(n.map) ? 0.5 : 0;
    return { n, s };
  });

  // include rule-driven recommendations (strong boost)
  (KG.rules||[]).forEach(r=>{
    if (ruleMatches(r.if, domain, problem)){
      (r.then?.recommend||[]).forEach(m=>{
        const idx = scored.findIndex(x=>x.n.map===m);
        if (idx>=0) scored[idx].s += 3;
      });
    }
  });

  const top = scored
    .filter(x => x.s > 0.25)
    .sort((a,b)=> b.s - a.s)
    .slice(0, 10)
    .map(x => ({
      type: x.n.map,
      label: labelOf(x.n),
      explain: x.n.explain || ''
    }));

  // De-dup by map/type
  const seen = new Set();
  return top.filter(t => (seen.has(t.type) ? false : (seen.add(t.type), true)));
}

export function lint(ir, ckg){
  const errors = [], warnings = [], info = [];
  const marks = []; // node-level marking is not available from IR alone; leaving empty by design.

  const ops = (ir?.circuit?.ops || []).slice().sort((a,b)=> (a.tick||0)-(b.tick||0));
  const qubits = Math.max(ir?.circuit?.qubits ?? 0, 0);

  // Track usage per qubit and simple schedule checks
  const used = new Set();
  const twoQRefs = new Set(["gate.cx","gate.cy","gate.cz","gate.swap","gate.ccx","gate.cswap"]);
  let twoQCount = 0;
  let depth = ops.length ? (ops[ops.length-1].tick - ops[0].tick + 1) : 0;

  // Measurement ordering check: record first measurement tick per qubit
  const firstMeasureTick = new Map();

  for (const o of ops){
    if (o.type === "gate"){
      const t = (o.targets||[]).map(Number);
      // bounds & duplicates
      if (!t.length){
        errors.push(`Gate ${o.ref} has no targets.`);
      }
      for (const q of t){
        if (!Number.isInteger(q) || q < 0 || q >= qubits){
          errors.push(`Gate ${o.ref} references invalid qubit q[${q}] (declared ${qubits}).`);
        } else {
          used.add(q);
        }
      }
      // control-target sanity
      if (o.ref === "gate.cx" || o.ref === "gate.cy" || o.ref === "gate.cz"){
        if (t.length>=2 && t[0] === t[1]) errors.push(`${o.ref.toUpperCase()} control and target cannot be identical (q[${t[0]}]).`);
      }
      if (o.ref === "gate.ccx" || o.ref === "gate.cswap"){
        if (new Set(t).size !== t.length) errors.push(`${o.ref.toUpperCase()} requires all distinct qubits (${t.join(',')}).`);
      }
      if (twoQRefs.has(o.ref)) twoQCount++;
      // measured-after? (later we check against measurement map)
      for (const q of t){
        if (firstMeasureTick.has(q) && o.tick > firstMeasureTick.get(q)){
          warnings.push(`Gate ${o.ref} on q[${q}] occurs after a measurement at tick ${firstMeasureTick.get(q)}.`);
        }
      }
    } else if (o.type === "io" && o.ref === "measure"){
      const q = Number((o.targets||[])[0]);
      if (!Number.isInteger(q) || q<0 || q>=qubits){
        errors.push(`Measurement references invalid qubit q[${q}] (declared ${qubits}).`);
      } else {
        if (!firstMeasureTick.has(q)) firstMeasureTick.set(q, o.tick ?? 0);
      }
    } else if (o.type === "oracle"){
      // basic sanity: encourage presence with Grover
      if (ir?.meta?.problem === "search" && !containsRef(ops, r => r.type==="oracle")){
        warnings.push("Search problem without an oracle — consider adding oracle.marked / oracle.truth.");
      }
    }
  }

  // Unused qubits (declared but never targeted)
  for (let q=0; q<qubits; q++){
    if (!used.has(q)){
      warnings.push(`Qubit q[${q}] is declared but never used by any gate.`);
    }
  }

  // Informational: no 2-qubit ops => likely separable states
  if (twoQCount === 0 && (ops.some(o=>o.type==="gate"))){
    info.push("No multi-qubit gates found — circuit will likely remain in a product (non-entangled) state.");
  }

  // Domain/problem rule checks via CKG
  const KG = ckg || DEFAULT_CKG;
  const d = (ir?.meta?.domain || "").toLowerCase();
  const p = (ir?.meta?.problem || "").toLowerCase();
  (KG.rules||[]).forEach(rule=>{
    if (ruleMatches(rule.if, d, p)){
      const need = rule.then?.requireOneOf || [];
      if (need.length && !anyRefMatches(ops, need)){
        warnings.push(rule.explain || `Rule hint: missing one of ${need.join(', ')}`);
      }
    }
  });

  return { errors, warnings, info, depth, twoQCount, marks };
}

/* =========================
   Helpers
========================= */
// Ensure your normalizer uses normKind(...)
function normalizeCKG(raw) {
  const nodes = (raw?.nodes || []).map(n => ({
    ...n,
    kind: normKind(n.kind),          // <── THIS was throwing
    id: String(n.id ?? n.name ?? crypto.randomUUID()),
    name: String(n.name ?? n.id ?? ''),
  }));
  const edges = (raw?.edges || []).map(e => ({
    ...e,
    from: String(e.from),
    to: String(e.to),
    relation: String(e.relation || e.rel || 'related'),
  }));
  return { nodes, edges, version: String(raw?.version || '1') };
}

function sanitizeQuery(q){
  return {
    domain: String(q?.domain||'general').toLowerCase(),
    problem: String(q?.problem||'any').toLowerCase(),
    title: String(q?.title||'').trim()
  };
}

function matchDomain(domains, d){
  return domains.includes(d) || domains.includes('general');
}
function matchProblem(problems, p){
  return problems.includes(p) || problems.includes('any');
}
function tokenize(s){
  return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean);
}
function jaccard(a, b){
  const A = new Set(a), B = new Set(Array.isArray(b)? b : tokenize(b));
  const inter = [...A].filter(x=>B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter/uni;
}
function paletteKnown(map){
  // whitelist of palette IDs the UI understands
  return [
    'qubit','measure',
    'gate.x','gate.y','gate.z','gate.h','gate.rx','gate.ry','gate.rz','gate.t','gate.s',
    'gate.cx','gate.cy','gate.cz','gate.swap','gate.ccx','gate.cswap',
    'oracle.marked','oracle.threshold','oracle.truth',
    'algo.grover','algo.dj','algo.qaoa',
    'sol.portfolio','sol.route','sol.molecule'
  ].includes(map);
}
function labelOf(n){
  if (n.kind==='gate' && n.map?.startsWith('gate.')) return `Gate: ${n.name}`;
  if (n.kind==='oracle') return `Oracle: ${n.name}`;
  if (n.kind==='algorithm') return `Algorithm: ${n.name}`;
  if (n.kind==='solution') return `Solution: ${n.name}`;
  return n.name;
}

function mapByName(name){
  const s = name.toLowerCase();
  if (/\bhadamard\b|^h\b/.test(s)) return 'gate.h';
  if (/\bpauli[-\s]?x\b|^x$/.test(s)) return 'gate.x';
  if (/\bpauli[-\s]?y\b|^y$/.test(s)) return 'gate.y';
  if (/\bpauli[-\s]?z\b|^z$/.test(s)) return 'gate.z';
  if (/^rx/.test(s)) return 'gate.rx';
  if (/^ry/.test(s)) return 'gate.ry';
  if (/^rz/.test(s)) return 'gate.rz';
  if (/^t\b/.test(s)) return 'gate.t';
  if (/^s\b/.test(s)) return 'gate.s';
  if (/\bcnot\b|cx\b/.test(s)) return 'gate.cx';
  if (/\bcy\b/.test(s)) return 'gate.cy';
  if (/\bcz\b/.test(s)) return 'gate.cz';
  if (/\bswap\b/.test(s)) return 'gate.swap';
  if (/\bccnot\b|\btoffoli\b|\bccx\b/.test(s)) return 'gate.ccx';
  if (/\bcswap\b|\bfredkin\b/.test(s)) return 'gate.cswap';
  if (/\bgrover\b/.test(s)) return 'algo.grover';
  if (/deutsch.*jozsa|dj\b/.test(s)) return 'algo.dj';
  if (/\bqaoa\b/.test(s)) return 'algo.qaoa';
  if (/oracle.*marked|marked state/.test(s)) return 'oracle.marked';
  if (/oracle.*threshold/.test(s)) return 'oracle.threshold';
  if (/oracle.*truth|truth table/.test(s)) return 'oracle.truth';
  return '';
}
function mapToPalette(m){ return paletteKnown(m) ? m : mapByName(m||''); }

function ruleMatches(cond, d, p){
  if (!cond) return false;
  const dm = !cond.domain || String(cond.domain).toLowerCase() === d;
  const pm = !cond.problem || String(cond.problem).toLowerCase() === p;
  return dm && pm;
}
function containsRef(ops, pred){ return ops.some(pred); }
function anyRefMatches(ops, patterns){
  // pattern like "oracle.*" or exact "algo.grover"
  return patterns.some(pat=>{
    if (pat.endsWith('.*')){
      const prefix = pat.slice(0,-2);
      return ops.some(o=> (o.ref||'').startsWith(prefix));
    }
    return ops.some(o=> (o.ref||'') === pat);
  });
}