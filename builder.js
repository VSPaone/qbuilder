/* builder.js — Main UI logic (ES Module)
   Wires up: canvas editor, inspector, exports, preview, suggestions, linter.
   Relies on:
     - simulator.js:  simulateCircuit(ir) -> {qubits, ops, probs, amps}
     - intel.js:      loadCKG(), suggest({domain,problem,title}), lint(ir, ckg)
   Data contract (IR):
     {
       meta: { type, title, domain, problem },
       circuit: {
         qubits: <int>,
         ops: [{ type:"gate|oracle|algorithm|solution",
                 ref:"gate.x|gate.cx|oracle.*|algo.*|sol.*|custom.*",
                 targets:[...], params:{...}, tick:<int> }]
       },
       components?: [...] // reserved for macros
     }
*/

import { simulateCircuit } from './simulator.js';
import { loadCKG, suggest, lint } from './intel.js';

/* -----------------------------
   DOM helpers
------------------------------*/
const $ = (s, r=document)=>r.querySelector(s);
const $$ = (s, r=document)=>Array.from(r.querySelectorAll(s));

const UI = {
  // Canvas & overlays
  ws: $("#workspace"),
  wsInner: $("#canvasInner"),
  overlay: $("#canvasOverlay"),

  // Panels
  insp: $("#inspector"),
  diag: $("#diag"),
  status: $("#statusLeft"),
  zoomPct: $("#zoomPct"),
  nodeCount: $("#nodeCount"),
  wireCount: $("#wireCount"),
  lintState: $("#lintState"),
  depthHint: $("#depthHint"),
  twoQCount: $("#twoQCount"),
  breadcrumb: $("#breadcrumb"),

  // Define problem
  inpDomain: $("#inpDomain"),
  inpProblem: $("#inpProblem"),
  inpTitle: $("#inpTitle"),
  btnSuggest: $("#btnSuggest"),
  suggestions: $("#suggestions"),

  // Export modals
  btnExportMenu: $("#btnExportMenu"),
  exportMenu: $("#exportMenu"),
  btnExportJSON: $("#btnExportJSON"),
  btnExportQASM: $("#btnExportQASM"),
  btnExportQiskit: $("#btnExportQiskit"),
  modJSON: $("#modalJSON"),
  outJSON: $("#outJSON"),
  dlJSON: $("#btnDownloadJSON"),
  modQASM: $("#modalQASM"),
  outQASM: $("#outQASM"),
  dlQASM: $("#btnDownloadQASM"),
  modQiskit: $("#modalQiskit"),
  outQiskit: $("#outQiskit"),
  dlQiskit: $("#btnDownloadQiskit"),

  // Preview modal
  btnPreview: $("#btnPreview"),
  modPreview: $("#modalPreview"),
  simQubits: $("#simQubits"),
  simOps: $("#simOps"),
  simEnt: $("#simEnt"),
  simHist: $("#simHist"),
  simTable: $("#simStateTable"),
  btnRerun: $("#btnRerun"),

  // Project I/O
  btnNew: $("#btnNew"),
  btnOpen: $("#btnOpen"),
  btnSave: $("#btnSave"),
  fileOpen: $("#fileOpen"),

  // Toolbar
  btnAutoLayout: $("#btnAutoLayout"),
  btnClear: $("#btnClearCanvas"),
  btnGroup: $("#btnGroup"),
  btnUngroup: $("#btnUngroup"),
  btnSaveToLib: $("#btnSaveToLib"),

  // Filters
  fltErr: $("#fltErr"),
  fltWarn: $("#fltWarn"),
  fltInfo: $("#fltInfo"),

  // Context
  ctx: $("#ctxMenu"),
  ctxDuplicate: $("#ctxDuplicate"),
  ctxDelete: $("#ctxDelete"),
  ctxGroup: $("#ctxGroup"),
  ctxSaveToLib: $("#ctxSaveToLib"),

  // Zoom dock
  zoomIn: $("#dockZoomIn"),
  zoomOut: $("#dockZoomOut"),
  zoomReset: $("#dockReset"),
};

/* -----------------------------
   Editor Model & Specs
------------------------------*/
const svgNS = "http://www.w3.org/2000/svg";

const NODE_SPECS = {
  qubit:  { title:"Qubit", w:140, h:52,  props:{ index:0 },        ports:{in:0,out:1}, kind:"decl" },
  measure:{ title:"Measure", w:140, h:62, props:{ q:0 },           ports:{in:1,out:1}, kind:"io" },

  // 1Q gates
  "gate.x":  { title:"X",  w:120, h:72, props:{ q:0 }, ports:{in:1,out:1}, arity:1 },
  "gate.y":  { title:"Y",  w:120, h:72, props:{ q:0 }, ports:{in:1,out:1}, arity:1 },
  "gate.z":  { title:"Z",  w:120, h:72, props:{ q:0 }, ports:{in:1,out:1}, arity:1 },
  "gate.h":  { title:"H",  w:120, h:72, props:{ q:0 }, ports:{in:1,out:1}, arity:1 },
  "gate.rx": { title:"Rx", w:140, h:92, props:{ q:0, theta:Math.PI/2 }, ports:{in:1,out:1}, arity:1 },
  "gate.ry": { title:"Ry", w:140, h:92, props:{ q:0, theta:Math.PI/2 }, ports:{in:1,out:1}, arity:1 },
  "gate.rz": { title:"Rz", w:140, h:92, props:{ q:0, theta:Math.PI/2 }, ports:{in:1,out:1}, arity:1 },
  "gate.t":  { title:"T",  w:120, h:72, props:{ q:0 }, ports:{in:1,out:1}, arity:1 },
  "gate.s":  { title:"S",  w:120, h:72, props:{ q:0 }, ports:{in:1,out:1}, arity:1 },

  // 2Q
  "gate.cx":   { title:"CX",   w:160, h:98, props:{ control:0, target:1 }, ports:{in:1,out:1}, arity:2 },
  "gate.cy":   { title:"CY",   w:160, h:98, props:{ control:0, target:1 }, ports:{in:1,out:1}, arity:2 },
  "gate.cz":   { title:"CZ",   w:160, h:98, props:{ control:0, target:1 }, ports:{in:1,out:1}, arity:2 },
  "gate.swap": { title:"SWAP", w:160, h:98, props:{ q0:0, q1:1 },          ports:{in:1,out:1}, arity:2 },

  // 3Q
  "gate.ccx":   { title:"CCNOT", w:190, h:110, props:{ c1:0, c2:1, target:2 }, ports:{in:1,out:1}, arity:3 },
  "gate.cswap": { title:"CSWAP", w:190, h:110, props:{ control:0, q0:1, q1:2 }, ports:{in:1,out:1}, arity:3 },

  // Oracles & algorithms (placeholders for IR)
  "oracle.marked":    { title:"Oracle: Marked",    w:240, h:120, props:{ bitstring:"11" }, ports:{in:1,out:1} },
  "oracle.threshold": { title:"Oracle: Threshold", w:240, h:130, props:{ qubits:"0,1,2", tau:2 }, ports:{in:1,out:1} },
  "oracle.truth":     { title:"Oracle: Truth",     w:240, h:150, props:{ table:"00:0,01:0,10:0,11:1" }, ports:{in:1,out:1} },

  "algo.grover": { title:"Grover", w:180, h:90, props:{ iterations:1 }, ports:{in:1,out:1} },
  "algo.dj":     { title:"Deutsch–Jozsa", w:200, h:90, props:{}, ports:{in:1,out:1} },
  "algo.qaoa":   { title:"QAOA", w:180, h:100, props:{ p:1, beta:0.7, gamma:0.7 }, ports:{in:1,out:1} },
};

const State = {
  zoom: 1,
  _id: 1,
  nodes: [],     // {id,type,title,x,y,w,h,props,ports:{in:[],out:[]},el}
  wires: [],     // {from:{id,port}, to:{id,port}, el}
  selection: null,
  linking: null, // {fromId, tempLine, start:{x,y}}
  ckg: null,
  breadcrumb: [{ name: "Main Circuit", subgraph: null }], // for macros (future)
};

/* -----------------------------
   SVG layer for wires
------------------------------*/
const wireLayer = document.createElementNS(svgNS, "svg");
wireLayer.setAttribute("class", "absolute inset-0 pointer-events-none");
wireLayer.style.width = "100%";
wireLayer.style.height = "100%";
UI.wsInner.appendChild(wireLayer);

/* -----------------------------
   Utilities
------------------------------*/
const nextId = () => `n${State._id++}`;
const toCanvasPoint = (clientX, clientY) => {
  const rect = UI.ws.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
};
const drawWirePath = (x1,y1,x2,y2) => {
  const dx = Math.max(40, Math.abs(x2-x1)/2);
  return `M ${x1} ${y1} C ${x1+dx} ${y1}, ${x2-dx} ${y2}, ${x2} ${y2}`;
};
const status = (msg)=> UI.status.textContent = msg;
const download = (name, text) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], {type:"text/plain"}));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
};


/* -----------------------------
   Node creation & rendering
------------------------------*/
function createNode(type, x, y) {
  const spec = NODE_SPECS[type];
  if (!spec) return null;
  const node = {
    id: nextId(), type, title: spec.title, x, y, w: spec.w, h: spec.h,
    props: structuredClone(spec.props || {}), ports:{ in:[], out:[] }, el:null
  };
  State.nodes.push(node);
  renderNode(node);
  refreshCounts();
  debouncedValidate();
  return node;
}

function renderNode(n) {
  const el = document.createElement("div");
  n.el = el;
  el.className = "absolute bg-white border border-gray-300 rounded shadow-soft select-none";
  el.style.left = `${n.x}px`; el.style.top = `${n.y}px`;
  el.style.width = `${n.w}px`; el.style.height = `${n.h}px`;
  el.tabIndex = 0;

  // header
  const head = document.createElement("div");
  head.className = "cursor-move px-2 py-1 bg-gray-100 border-b border-gray-200 rounded-t text-sm font-semibold";
  head.textContent = n.title;
  el.appendChild(head);

  // body
  const body = document.createElement("div");
  body.className = "px-2 py-2 text-xs text-gray-600";
  body.innerHTML = `<span class="text-[11px] italic">${n.type}</span>`;
  el.appendChild(body);

  // ports in
  const inCount = NODE_SPECS[n.type].ports?.in || 0;
  for (let i=0;i<inCount;i++){
    const p = document.createElement("div");
    p.className = "absolute -left-2 top-1/2 -translate-y-1/2 w-3 h-3 bg-indigo-500 rounded-full ring-2 ring-white";
    el.appendChild(p); n.ports.in.push(p);
    p.addEventListener("mouseup", (ev)=>{
      if (State.linking) { completeWire(n.id, "in", 0); ev.stopPropagation(); }
    });
  }
  // ports out
  const outCount = NODE_SPECS[n.type].ports?.out || 0;
  for (let i=0;i<outCount;i++){
    const p = document.createElement("div");
    p.className = "absolute -right-2 top-1/2 -translate-y-1/2 w-3 h-3 bg-emerald-500 rounded-full ring-2 ring-white cursor-crosshair";
    el.appendChild(p); n.ports.out.push(p);
    p.addEventListener("mousedown", (ev)=>{ beginWire(n.id, "out", 0, ev); ev.stopPropagation(); });
  }

  // selection & drag
  el.addEventListener("mousedown", (e)=>{ selectNode(n.id); startDragNode(n, e); });
  el.addEventListener("keydown", (e)=>{ if (e.key==="Delete") deleteNode(n.id); });
  el.addEventListener("dblclick", ()=>{ /* future: open macro subgraph */ });

  UI.wsInner.appendChild(el);
}

function selectNode(id){
  State.selection = id;
  State.nodes.forEach(n => n.el.classList.toggle("ring-2", n.id===id));
  renderInspector();
}

function deleteNode(id){
  // drop any connected wires (defensively check parent)
  State.wires = State.wires.filter(w => {
    const keep = (w.from.id !== id && w.to.id !== id);
    if (!keep && w.el && w.el.parentNode) w.el.parentNode.removeChild(w.el);
    return keep;
  });

  // remove the node element from its real parent (#canvasInner)
  const i = State.nodes.findIndex(n => n.id === id);
  if (i >= 0) {
    const el = State.nodes[i].el;
    if (el && el.parentNode) el.parentNode.removeChild(el);
    State.nodes.splice(i, 1);
  }

  State.selection = null;
  renderInspector();
  refreshCounts();
  debouncedValidate();
}

/* -----------------------------
   Dragging nodes
------------------------------*/
let drag = null;
function startDragNode(node, ev){
  drag = { node, startX:ev.clientX, startY:ev.clientY, ox:node.x, oy:node.y };
  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", endDrag);
}
function onDragMove(ev){
  if(!drag){
    if(State.linking) updateTempWire(ev);
    return;
  }
  const dx = ev.clientX - drag.startX;
  const dy = ev.clientY - drag.startY;
  drag.node.x = Math.max(0, drag.ox+dx);
  drag.node.y = Math.max(0, drag.oy+dy);
  drag.node.el.style.left = `${drag.node.x}px`;
  drag.node.el.style.top  = `${drag.node.y}px`;
  updateAllWires();
}
function endDrag(){
  drag = null;
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", endDrag);
  debouncedValidate();
}

/* -----------------------------
   Wires
------------------------------*/
function beginWire(fromId, _k, _i, ev){
  const p = toCanvasPoint(ev.clientX, ev.clientY);
  const temp = document.createElementNS(svgNS, "path");
  temp.setAttribute("stroke", "#10b981");
  temp.setAttribute("stroke-width", "2");
  temp.setAttribute("fill", "none");
  wireLayer.appendChild(temp);
  State.linking = { fromId, tempLine: temp, start: p };
  document.addEventListener("mousemove", updateTempWire);
  document.addEventListener("mouseup", cancelLinking);
}
function updateTempWire(ev){
  if(!State.linking) return;
  const s = State.linking.start;
  const e = toCanvasPoint(ev.clientX, ev.clientY);
  State.linking.tempLine.setAttribute("d", drawWirePath(s.x,s.y,e.x,e.y));
}
// builder.js ─ cancelLinking()
function cancelLinking(){
  if (State.linking?.tempLine?.parentNode) {
    State.linking.tempLine.parentNode.removeChild(State.linking.tempLine);
  }
  State.linking = null;
  document.removeEventListener("mousemove", updateTempWire);
  document.removeEventListener("mouseup", cancelLinking);
}
function completeWire(toId){
  const link = State.linking; if(!link) return;
  wireLayer.removeChild(link.tempLine);
  const el = document.createElementNS(svgNS, "path");
  el.setAttribute("stroke", "#6ee7b7");
  el.setAttribute("stroke-width", "2.5");
  el.setAttribute("fill", "none");
  wireLayer.appendChild(el);
  const w = { from:{id:link.fromId,port:0}, to:{id:toId,port:0}, el };
  State.wires.push(w);
  updateWire(w);
  cancelLinking();
  refreshCounts();
  debouncedValidate();
}
function nodeOutCenter(n){
  const r = n.ports.out[0].getBoundingClientRect();
  return toCanvasPoint(r.left+r.width/2, r.top+r.height/2);
}
function nodeInCenter(n){
  const r = n.ports.in[0].getBoundingClientRect();
  return toCanvasPoint(r.left+r.width/2, r.top+r.height/2);
}
function updateWire(w){
  const a = State.nodes.find(n=>n.id===w.from.id);
  const b = State.nodes.find(n=>n.id===w.to.id);
  if(!a||!b) return;
  const p1 = nodeOutCenter(a);
  const p2 = nodeInCenter(b);
  w.el.setAttribute("d", drawWirePath(p1.x,p1.y,p2.x,p2.y));
}
// --- REPLACE: updateAllWires
function updateAllWires(){
  State.wires.forEach(updateWire);
}

/* -----------------------------
   Palette / Suggestions → Canvas
------------------------------*/
UI.ws.addEventListener("dragover", e=>e.preventDefault());
UI.ws.addEventListener("drop", (e)=>{
  e.preventDefault();
  const t = e.dataTransfer.getData("text/qbuilder-type");
  if(!t) return;
  const p = toCanvasPoint(e.clientX, e.clientY);
  createNode(t, p.x-60, p.y-30);
});

function enablePaletteDrags(){
  $$("#plQubits [draggable], #plGates [draggable], #plOracles [draggable], #plAlgorithms [draggable], #plSolutions [draggable], #plLibrary [draggable], #suggestions [draggable]")
  .forEach(el=>{
    el.addEventListener("dragstart", (e)=>{
      e.dataTransfer.setData("text/qbuilder-type", el.dataset.type);
    });
  });
}
enablePaletteDrags();

/* -----------------------------
   Inspector
------------------------------*/
function renderInspector(){
  const id = State.selection;
  const box = UI.insp;
  box.innerHTML = "";
  if(!id){ box.innerHTML = `<p class="text-sm text-gray-600">Select a node to edit its properties.</p>`; return; }
  const n = State.nodes.find(x=>x.id===id); if(!n) return;
  const head = document.createElement("div");
  head.className = "font-semibold mb-2"; head.textContent = `${n.title} (${n.type})`;
  box.appendChild(head);

  const form = document.createElement("div"); form.className = "space-y-2";
  Object.entries(n.props).forEach(([k,v])=>{
    const row = document.createElement("div"); row.className = "flex items-center gap-2";
    const lab = document.createElement("label"); lab.className="text-sm w-28"; lab.textContent = k;
    const inp = document.createElement("input"); inp.className = "border rounded px-2 py-1 flex-1"; inp.value = v;
    inp.addEventListener("input", ()=>{ n.props[k] = tryNum(inp.value); debouncedValidate(); });
    row.append(lab, inp); form.appendChild(row);
  });
  box.appendChild(form);

  const danger = document.createElement("div"); danger.className="mt-3";
  danger.innerHTML = `<button id="btnDeleteNode" class="px-3 py-1.5 rounded border border-red-300 text-red-700 hover:bg-red-50">
    <i class="ri-delete-bin-6-line mr-1"></i>Delete</button>`;
  box.appendChild(danger);
  $("#btnDeleteNode").addEventListener("click", ()=>deleteNode(n.id));
}
const tryNum = (x)=> (Number.isFinite(Number(x)) ? Number(x) : x);

/* -----------------------------
   Build IR (left→right then top→bottom)
------------------------------*/
function declaredQubits(){
  return State.nodes.filter(n=>n.type==="qubit").map(n=>Number(n.props.index)).sort((a,b)=>a-b);
}
function buildIR(){
  const sorted = State.nodes.slice().sort((a,b)=>(a.x-b.x)||(a.y-b.y));
  const qubits = declaredQubits();
  const nQ = qubits.length ? Math.max(...qubits)+1 : 0;
  const ops = [];
  for(const n of sorted){
    const tick = Math.round(n.x/40);
    switch(n.type){
      // 1Q
      case "gate.x": case "gate.y": case "gate.z":
      case "gate.h": case "gate.rx": case "gate.ry": case "gate.rz":
      case "gate.t": case "gate.s":
        ops.push({ type:"gate", ref:n.type, targets:[n.props.q ?? n.props.q0 ?? 0], params:{...n.props}, tick });
        break;
      // 2Q / 3Q
      case "gate.cx": case "gate.cy": case "gate.cz":
      case "gate.swap": case "gate.ccx": case "gate.cswap":
        ops.push({ type:"gate", ref:n.type, targets:Object.values(n.props).map(Number), params:{...n.props}, tick });
        break;
      // io
      case "measure":
        ops.push({ type:"io", ref:"measure", targets:[n.props.q], tick });
        break;
      // high-level
      case "oracle.marked": case "oracle.threshold": case "oracle.truth":
        ops.push({ type:"oracle", ref:n.type, params:{...n.props}, tick }); break;
      case "algo.grover": case "algo.dj": case "algo.qaoa":
        ops.push({ type:"algorithm", ref:n.type, params:{...n.props}, tick }); break;
      default: break;
    }
  }
  // builder.js ─ buildIR()
    const meta = {
    type: (document.querySelector("input[name='artifact']:checked") || {}).value || "gate",
    title: UI.inpTitle?.value || "",
    domain: UI.inpDomain?.value,
    problem: UI.inpProblem?.value
    };

  return { meta, circuit:{ qubits:nQ, ops } };
}

/* -----------------------------
   Linter (via intel.js)
------------------------------*/
let lintTimer=null;
function debouncedValidate(){
  UI.lintState.textContent = "checking…";
  if(lintTimer) clearTimeout(lintTimer);
  lintTimer = setTimeout(async ()=>{
    const ir = buildIR();
    const report = await lint(ir, State.ckg); // {errors:[...], warnings:[...], info:[...], depth, twoQCount, marks:[{nodeId,severity}]}
    renderDiagnostics(report);
    applyLintMarks(report);
    UI.depthHint.textContent = String(report.depth ?? 0);
    UI.twoQCount.textContent = String(report.twoQCount ?? 0);
    UI.lintState.textContent = (report.errors?.length? "errors" : report.warnings?.length? "warnings" : "ok");
  }, 350);
}
function renderDiagnostics(rep){
  const showE = UI.fltErr.checked, showW = UI.fltWarn.checked, showI = UI.fltInfo.checked;
  const items = [];
  (rep.errors||[]).forEach(x=> showE && items.push(row("E", x)));
  (rep.warnings||[]).forEach(x=> showW && items.push(row("W", x)));
  (rep.info||[]).forEach(x=> showI && items.push(row("I", x)));
  UI.diag.innerHTML = items.length? items.join("") : "OK";
  function row(tag, msg){ return `<div><b>${tag}</b> — ${escapeHtml(msg)}</div>`; }
}
function applyLintMarks(rep){
  // Clear styles
  State.nodes.forEach(n=> n.el.classList.remove("err","warn"));
  (rep.marks||[]).forEach(m=>{
    const n = State.nodes.find(x=>x.id===m.nodeId);
    if(!n) return;
    if(m.severity==="error") n.el.classList.add("err");
    else if(m.severity==="warning") n.el.classList.add("warn");
  });
}
const escapeHtml = (s)=> String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));

/* -----------------------------
   Suggestions (via intel.js + ckg.json)
------------------------------*/
UI.btnSuggest.addEventListener("click", async ()=>{
  const res = await suggest({
    domain: UI.inpDomain.value,
    problem: UI.inpProblem.value,
    title: UI.inpTitle.value
  }, State.ckg);
  UI.suggestions.innerHTML = "";
  res.forEach(item=>{
    const chip = document.createElement("div");
    chip.className = "cursor-grab px-2 py-1.5 rounded bg-white border shadow-soft flex justify-between items-center";
    chip.textContent = item.label;
    chip.title = item.explain || "";
    chip.draggable = true; chip.dataset.type = item.type;
    chip.addEventListener("dragstart", (e)=> e.dataTransfer.setData("text/qbuilder-type", item.type));
    UI.suggestions.appendChild(chip);
  });
  enablePaletteDrags();
  status(`Suggestions: ${res.length}`);
});

/* -----------------------------
   Exporters (JSON / QASM / Qiskit)
------------------------------*/
UI.btnExportMenu.addEventListener("click", ()=> UI.exportMenu.classList.toggle("hidden"));
document.addEventListener("click", (e)=>{ if(!UI.btnExportMenu.contains(e.target)) UI.exportMenu.classList.add("hidden"); });

UI.btnExportJSON.addEventListener("click", ()=>{
  const ir = buildIR(); UI.outJSON.value = JSON.stringify(ir, null, 2);
  showModal(UI.modJSON);
});
UI.btnExportQASM.addEventListener("click", ()=>{
  const qasm = toQASM(buildIR());
  UI.outQASM.value = qasm; showModal(UI.modQASM);
});
UI.btnExportQiskit.addEventListener("click", ()=>{
  const py = toQiskit(buildIR());
  UI.outQiskit.value = py; showModal(UI.modQiskit);
});
UI.dlJSON.addEventListener("click", ()=> download("circuit.json", UI.outJSON.value));
UI.dlQASM.addEventListener("click", ()=> download("circuit.qasm", UI.outQASM.value));
UI.dlQiskit.addEventListener("click", ()=> download("circuit_qiskit.py", UI.outQiskit.value));

function toQASM(ir){
  const nq = Math.max(ir.circuit.qubits, Math.max(-1, ...(declaredQubits()))+1);
  let s = `OPENQASM 3;\nqubit[${nq}] q;\n`;
  ir.circuit.ops.sort((a,b)=>a.tick-b.tick).forEach(o=>{
    if(o.type==="gate"){
      const t=o.targets;
      switch(o.ref){
        case "gate.x": s+=`x q[${t[0]}];\n`; break;
        case "gate.y": s+=`y q[${t[0]}];\n`; break;
        case "gate.z": s+=`z q[${t[0]}];\n`; break;
        case "gate.h": s+=`h q[${t[0]}];\n`; break;
        case "gate.rx": s+=`rx(${Number(o.params.theta).toFixed(6)}) q[${t[0]}];\n`; break;
        case "gate.ry": s+=`ry(${Number(o.params.theta).toFixed(6)}) q[${t[0]}];\n`; break;
        case "gate.rz": s+=`rz(${Number(o.params.theta).toFixed(6)}) q[${t[0]}];\n`; break;
        case "gate.t": s+=`t q[${t[0]}];\n`; break;
        case "gate.s": s+=`s q[${t[0]}];\n`; break;
        case "gate.cx": s+=`cx q[${t[0]}], q[${t[1]}];\n`; break;
        case "gate.cy": s+=`cy q[${t[0]}], q[${t[1]}];\n`; break;
        case "gate.cz": s+=`cz q[${t[0]}], q[${t[1]}];\n`; break;
        case "gate.swap": s+=`swap q[${t[0]}], q[${t[1]}];\n`; break;
        case "gate.ccx": s+=`ccx q[${t[0]}], q[${t[1]}], q[${t[2]}];\n`; break;
        case "gate.cswap": s+=`cswap q[${t[0]}], q[${t[1]}], q[${t[2]}];\n`; break;
        default: s+=`// ${o.ref}\n`;
      }
    } else if (o.type==="io" && o.ref==="measure"){
      s+=`bit b${o.targets[0]};\nmeasure q[${o.targets[0]}] -> b${o.targets[0]};\n`;
    } else {
      s+=`// ${o.type.toUpperCase()} ${o.ref} ${JSON.stringify(o.params||{})}\n`;
    }
  });
  return s;
}

function toQiskit(ir){
  const nq = Math.max(ir.circuit.qubits, Math.max(-1, ...(declaredQubits()))+1);
  let s = `from qiskit import QuantumCircuit\nqc = QuantumCircuit(${nq})\n`;
  ir.circuit.ops.sort((a,b)=>a.tick-b.tick).forEach(o=>{
    const t=o.targets||[];
    if(o.type==="gate"){
      switch(o.ref){
        case "gate.x": s+=`qc.x(${t[0]})\n`; break;
        case "gate.y": s+=`qc.y(${t[0]})\n`; break;
        case "gate.z": s+=`qc.z(${t[0]})\n`; break;
        case "gate.h": s+=`qc.h(${t[0]})\n`; break;
        case "gate.rx": s+=`qc.rx(${Number(o.params.theta).toFixed(6)}, ${t[0]})\n`; break;
        case "gate.ry": s+=`qc.ry(${Number(o.params.theta).toFixed(6)}, ${t[0]})\n`; break;
        case "gate.rz": s+=`qc.rz(${Number(o.params.theta).toFixed(6)}, ${t[0]})\n`; break;
        case "gate.t": s+=`qc.t(${t[0]})\n`; break;
        case "gate.s": s+=`qc.s(${t[0]})\n`; break;
        case "gate.cx": s+=`qc.cx(${t[0]}, ${t[1]})\n`; break;
        case "gate.cy": s+=`qc.cy(${t[0]}, ${t[1]})\n`; break;
        case "gate.cz": s+=`qc.cz(${t[0]}, ${t[1]})\n`; break;
        case "gate.swap": s+=`qc.swap(${t[0]}, ${t[1]})\n`; break;
        case "gate.ccx": s+=`qc.ccx(${t[0]}, ${t[1]}, ${t[2]})\n`; break;
        case "gate.cswap": s+=`qc.cswap(${t[0]}, ${t[1]}, ${t[2]})\n`; break;
        default: s+=`# ${o.ref}\n`;
      }
    } else if (o.type==="io" && o.ref==="measure"){
      s+=`qc.measure(${t[0]}, ${t[0]})\n`;
    } else {
      s+=`# ${o.type}: ${o.ref} params=${JSON.stringify(o.params||{})}\n`;
    }
  });
  s+=`\nprint(qc)\n`;
  return s;
}

/* -----------------------------
   Preview (Simulator)
------------------------------*/
// --- REPLACE: runPreview
UI.btnPreview.addEventListener("click", runPreview);
UI.btnRerun.addEventListener("click", runPreview);

function collectSimOptions() {
  // Controls live in the Preview modal
  const shots = Math.max(0, Number(document.getElementById("shotsInput")?.value ?? 0)) | 0;
  const seedVal = document.getElementById("seedInput")?.value;
  const seed = (seedVal === "" || seedVal == null) ? undefined : Number(seedVal);
  const mirror = Math.max(0, Number(document.getElementById("mirrorInput")?.value ?? 1)) | 0;

  const ns = document.getElementById("noiseSelect")?.value || "";
  let noise = null;
  if (ns === "depolarizing") noise = { type: "depolarizing", p: 0.02 };
  if (ns === "amp-damp")     noise = { type: "amp-damp",   gamma: 0.05 };
  if (ns === "phase-damp")   noise = { type: "phase-damp", lambda: 0.05 };

  return { shots, noise, seed, mirror };
}

async function runPreview(){
  const ir = buildIR();
  const opts = collectSimOptions();

  // Backward-compatible call if old simulator signature is used
  let res;
  try {
    res = await simulateCircuit(ir, opts);
  } catch {
    res = await simulateCircuit(ir); // fallback
  }

  // Summary
  UI.simQubits.textContent = String(res.qubits ?? ir.circuit.qubits ?? 0);
  UI.simOps.textContent    = String(ir.circuit.ops.length);
  UI.simEnt.textContent    = (res.entangled || res.entangledLikely) ? "likely" : "unlikely";
  const keep = (typeof res.postSelectProb === "number") ? `${(100*res.postSelectProb).toFixed(1)}%` : "—";
  const keepEl = document.getElementById("simKeepPct");
  if (keepEl) keepEl.textContent = keep;

  // Histogram & table
  drawHistogram(res);
  drawStateTable(res);

  // Transparency: show what "bricks" ran (we derive a brick-ish summary from IR ops)
  const bricksPre = document.getElementById("simBricks");
  if (bricksPre) {
    const bricks = ir.circuit.ops.map(o => ({
      kind: o.type, ref: o.ref, targets: o.targets, tick: o.tick
    }));
    bricksPre.textContent = JSON.stringify(bricks, null, 2);
  }

  showModal(UI.modPreview);
}

// --- REPLACE: drawHistogram
function drawHistogram(result){
  const c = UI.simHist.getContext("2d");
  const W = UI.simHist.width  = UI.simHist.clientWidth || 600;
  const H = UI.simHist.height = 240;

  c.clearRect(0,0,W,H);

  // Choose data: counts (shots) > probs (analytic)
  let entries = [];
  if (result.counts && typeof result.counts.forEach === "function") {
    result.counts.forEach((v, k) => entries.push({ key: k, value: v }));
  } else if (Array.isArray(result.probs)) {
    const n = Math.log2(result.probs.length) | 0;
    entries = result.probs.map((p,i)=>({ key: i.toString(2).padStart(n,"0"), value: p }));
  }

  // Sort by value desc and take top-K that fit
  entries.sort((a,b)=>b.value - a.value);
  const K = Math.min(24, entries.length);

  // Axes
  c.fillStyle = "#111827";
  c.font = "12px ui-sans-serif";
  c.fillText("Top outcomes", 8, 14);

  // Bars
  const padL = 60, padR = 12, padB = 26, padT = 20;
  const maxV  = Math.max(...entries.slice(0,K).map(e=>e.value), 1e-12);
  const barW  = Math.max(6, (W - padL - padR) / K - 6);

  // Gridline
  c.strokeStyle = "#e5e7eb";
  c.beginPath(); c.moveTo(padL, H - padB + .5); c.lineTo(W - padR, H - padB + .5); c.stroke();

  entries.slice(0,K).forEach((e, idx) => {
    const x = padL + idx * (barW + 6);
    const h = (H - padB - padT) * (e.value / maxV);
    const y = H - padB - h;

    // Bar
    c.fillStyle = "#4f46e5";
    c.fillRect(x, y, barW, h);

    // Label (bitstring)
    c.fillStyle = "#6b7280";
    c.save();
    c.translate(x + barW/2, H - padB + 12);
    c.rotate(-Math.PI/4);
    c.fillText(e.key, -20, 0);
    c.restore();
  });

  // Legend
  const mode = result.counts ? "counts" : "prob.";
  c.fillStyle = "#6b7280";
  c.fillText(`mode: ${mode}`, W - 90, 14);
}

// --- REPLACE: drawStateTable
function drawStateTable({ amps, probs, counts }){
  const rows = [];
  rows.push(`<tr class="text-left"><th>#</th><th>|state⟩</th><th>Re</th><th>Im</th><th>|amp|²</th></tr>`);
  const n = amps ? (Math.log2(amps.length) | 0) : (probs ? (Math.log2(probs.length) | 0) : 0);

  if (amps && Array.isArray(amps)) {
    for (let i=0;i<amps.length;i++){
      const st = i.toString(2).padStart(n,"0");
      const re = (amps[i].re ?? 0).toFixed(6);
      const im = (amps[i].im ?? 0).toFixed(6);
      const p  = ((amps[i].re??0)**2 + (amps[i].im??0)**2).toFixed(6);
      rows.push(`<tr><td>${i}</td><td>|${st}⟩</td><td>${re}</td><td>${im}</td><td>${p}</td></tr>`);
    }
  } else if (probs && Array.isArray(probs)) {
    for (let i=0;i<probs.length;i++){
      const st = i.toString(2).padStart(n,"0");
      const p  = (probs[i] ?? 0).toFixed(6);
      rows.push(`<tr><td>${i}</td><td>|${st}⟩</td><td>—</td><td>—</td><td>${p}</td></tr>`);
    }
  } else if (counts) {
    const arr = [];
    counts.forEach((v,k)=> arr.push({ k, v }));
    arr.sort((a,b)=> b.v - a.v);
    arr.forEach(({k,v},i)=> rows.push(`<tr><td>${i}</td><td>|${k}⟩</td><td>—</td><td>—</td><td>${v}</td></tr>`));
  }

  UI.simTable.innerHTML = rows.join("");
}

/* -----------------------------
   Project I/O & Layout
------------------------------*/
UI.btnNew.addEventListener("click", ()=>{
  State.nodes.forEach(n=> UI.wsInner.removeChild(n.el));
  State.nodes=[]; State.wires.forEach(w=>wireLayer.removeChild(w.el)); State.wires=[];
  State.selection=null; renderInspector(); refreshCounts(); debouncedValidate(); status("New canvas.");
});

UI.btnSave.addEventListener("click", ()=>{
  const saveObj = { nodes: State.nodes.map(slim), wires: State.wires.map(w=>({from:w.from,to:w.to})) };
  download("qbuilder_project.json", JSON.stringify(saveObj, null, 2));
});
UI.btnOpen.addEventListener("click", ()=> UI.fileOpen.click());
UI.fileOpen.addEventListener("change", async ()=>{
  const f = UI.fileOpen.files[0]; if(!f) return;
  try{
    const obj = JSON.parse(await f.text());
    UI.btnNew.click();
    (obj.nodes||[]).forEach(n=>{
      const nd = createNode(n.type, n.x, n.y);
      nd.props = { ...nd.props, ...n.props };
    });
    (obj.wires||[]).forEach(w=>{
      if(State.nodes.find(n=>n.id===w.from.id) && State.nodes.find(n=>n.id===w.to.id)){
        const el = document.createElementNS(svgNS, "path");
        el.setAttribute("stroke", "#6ee7b7");
        el.setAttribute("stroke-width", "2.5"); el.setAttribute("fill","none");
        wireLayer.appendChild(el);
        const ww = { from:w.from, to:w.to, el }; State.wires.push(ww); updateWire(ww);
      }
    });
    refreshCounts(); debouncedValidate(); status("Project loaded.");
  }catch(e){ status("Invalid project file."); }
});
const slim = (n)=>({ id:n.id, type:n.type, x:n.x, y:n.y, props:n.props });

UI.btnAutoLayout.addEventListener("click", ()=>{
  // columnar grouping by type class
  const groups = { decl:[], one:[], two:[], three:[], hi:[] };
  State.nodes.forEach(n=>{
    const spec = NODE_SPECS[n.type] || {};
    if(spec.kind==="decl") groups.decl.push(n);
    else if((spec.arity||0)===1) groups.one.push(n);
    else if((spec.arity||0)===2) groups.two.push(n);
    else if((spec.arity||0)===3) groups.three.push(n);
    else groups.hi.push(n);
  });
  const cols = [groups.decl, groups.one, groups.two, groups.three, groups.hi];
  let x=40; cols.forEach(col=>{
    let y=40; col.forEach(n=>{ n.x=x; n.y=y; n.el.style.left=`${x}px`; n.el.style.top=`${y}px`; y+=n.h+30; });
    x += 260;
  });
  updateAllWires();
});
UI.btnClear.addEventListener("click", ()=> UI.btnNew.click());

/* -----------------------------
   Zoom controls
------------------------------*/
UI.zoomIn.addEventListener("click", ()=> setZoom(State.zoom*1.1));
UI.zoomOut.addEventListener("click", ()=> setZoom(State.zoom/1.1));
UI.zoomReset.addEventListener("click", ()=> setZoom(1));
// --- REPLACE: setZoom
function setZoom(z){
  State.zoom = Math.min(2, Math.max(0.5, z));
  applyView();
  UI.zoomPct.textContent = `${Math.round(State.zoom*100)}%`;
  updateAllWires(); // keep wires aligned with the scaled canvas
}

// --- ADD: pan+zoom application
if (!State.pan) State.pan = { x: 0, y: 0 };
function applyView(){
  UI.wsInner.style.transform = `translate(${State.pan.x}px, ${State.pan.y}px) scale(${State.zoom})`;
  UI.wsInner.style.transformOrigin = '0 0';
}

/* -----------------------------
   Context menu (basic)
------------------------------*/
let ctxNode = null;
UI.ws.addEventListener("contextmenu", (e)=>{
  e.preventDefault();
  const target = State.nodes.find(n=> n.el.contains(e.target));
  if(!target){ UI.ctx.classList.add("hidden"); return; }
  ctxNode = target;
  UI.ctx.style.left = `${e.clientX}px`; UI.ctx.style.top = `${e.clientY}px`;
  UI.ctx.classList.remove("hidden");
});
document.addEventListener("click", ()=> UI.ctx.classList.add("hidden"));
UI.ctxDuplicate.addEventListener("click", ()=>{
  if(!ctxNode) return; const n = createNode(ctxNode.type, ctxNode.x+20, ctxNode.y+20); n.props = {...ctxNode.props};
});
UI.ctxDelete.addEventListener("click", ()=> ctxNode && deleteNode(ctxNode.id));
UI.ctxGroup.addEventListener("click", ()=> status("Grouping → Macro will be handled by intel.js in next step."));
UI.ctxSaveToLib.addEventListener("click", ()=> status("Save to Library via intel.js (next step)."));

/* -----------------------------
   Modal helpers
------------------------------*/
function showModal(m){ m.classList.add("show"); }
function hideModal(m){ m.classList.remove("show"); }
$$("[data-close]").forEach(btn=>{
  btn.addEventListener("click", ()=> hideModal($(btn.getAttribute("data-close"))));
});

/* -----------------------------
   Init
------------------------------*/
(async function init(){
  State.ckg = await loadCKG(); // intel.js loads ckg.json
  seedDemo();
  enablePaletteDrags();
  debouncedValidate();
  status("Ready. Drag from Palette or Suggestions to add nodes.");
})();

function seedDemo(){
  createNode("qubit", 40, 60).props.index = 0;
  createNode("qubit", 40, 160).props.index = 1;
  createNode("gate.h", 280, 60).props.q = 0;
  const cx = createNode("gate.cx", 520, 90); cx.props.control=0; cx.props.target=1;
  refreshCounts();
}

/* -----------------------------
   Small helpers
------------------------------*/
function refreshCounts(){
  UI.nodeCount.textContent = String(State.nodes.length);
  UI.wireCount.textContent = String(State.wires.length);
}