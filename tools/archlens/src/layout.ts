// Stable layout: Graphviz `dot` lays out the BASE revision of a view once; the HEAD revision reuses those
// positions (pinned) and only brand-new nodes are placed by a simple collision-avoiding rule.
// Edges are routed with `neato -n2` on the pinned positions. Graphviz does not draw clusters in
// pinned mode, so cluster (boundary / deployment node) boxes are computed here from their members.
import { spawnSync } from "node:child_process";
import type { El, Model, View } from "./load.ts";
import type { ChangeIndex } from "./diff.ts";

export type Status = "unchanged" | "added" | "removed" | "modified";

export interface GNode {
  id: string;
  w: number;
  h: number;
  cluster?: string;
  status: Status;
  before?: El;
  after?: El;
}
export interface GCluster {
  id: string;
  parent?: string;
  status: Status;
  before?: El;
  after?: El;
}
export interface GEdge {
  key: string;
  src: string;
  dst: string;
  order?: string;
  label: string;
  tech: string;
  status: Status;
}
export interface Graph {
  nodes: Map<string, GNode>;
  clusters: Map<string, GCluster>;
  edges: GEdge[];
}
export interface P {
  x: number;
  y: number;
}
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface Routed {
  nodes: Map<string, P>;
  clusters: Map<string, Box>;
  edges: { edge: GEdge; pts: P[] }[];
  moved: number; // pinned nodes whose position differs from the base layout (expected 0)
  pinned: number;
  placed: string[]; // identities placed by the rule (new nodes)
}

const PAD = 16;
const HEADER = 30;
const GAP = 40;
const NODE_W = 240;
const NODE_H_ELEMENT = 118;
const NODE_H_LEAF = 84;

// ---------------------------------------------------------------------------------------------
// Graph construction

export function buildGraph(model: Model, view: View): Graph {
  const els = view.elements.map((id) => model.elements.get(id)).filter((e): e is El => !!e);
  const inView = new Set(els.map((e) => e.id));
  const hasChildInView = new Set(els.filter((e) => e.parent && inView.has(e.parent)).map((e) => e.parent!));
  const nodes = new Map<string, GNode>();
  const clusters = new Map<string, GCluster>();

  const clusterOf = (e: El): string | undefined => {
    if (view.kind === "deployment") return e.parent && inView.has(e.parent) ? e.parent : undefined;
    return view.scope && e.parent === view.scope ? view.scope : undefined;
  };
  const scopeEl = view.scope ? model.elements.get(view.scope) : undefined;
  for (const e of els) {
    const isCluster = view.kind === "deployment" && e.kind === "deploymentNode" && hasChildInView.has(e.id);
    if (isCluster) clusters.set(e.id, { id: e.id, parent: clusterOf(e), status: "unchanged", after: e });
    else {
      const leaf = view.kind === "deployment";
      nodes.set(e.id, { id: e.id, w: NODE_W, h: leaf ? NODE_H_LEAF : NODE_H_ELEMENT, cluster: clusterOf(e), status: "unchanged", after: e });
    }
  }
  if (view.kind !== "deployment" && scopeEl && els.some((e) => e.parent === scopeEl.id))
    clusters.set(scopeEl.id, { id: scopeEl.id, status: "unchanged", after: scopeEl });

  const edges: GEdge[] = [];
  for (const r of view.rels) {
    const rel = model.rels.get(r.key)!;
    if (!nodes.has(rel.src) || !nodes.has(rel.dst)) continue;
    edges.push({
      key: r.key + (r.order ? `#${r.order}` : ""),
      src: rel.src,
      dst: rel.dst,
      order: r.order,
      label: r.label,
      tech: rel.technology,
      status: "unchanged",
    });
  }
  return { nodes, clusters, edges };
}

// Union of base and head with change status on every item.
export function mergeGraphs(base: Graph | undefined, head: Graph, idx: ChangeIndex, relRoot: (key: string) => string): Graph {
  const out: Graph = { nodes: new Map(), clusters: new Map(), edges: [] };
  const statusOf = (id: string, inBase: boolean, inHead: boolean): Status =>
    !inBase ? "added" : !inHead ? "removed" : idx.modified.has(id) ? "modified" : "unchanged";
  const ids = <T>(a: Map<string, T> | undefined, b: Map<string, T>) => [...new Set([...(a?.keys() ?? []), ...b.keys()])].sort();
  for (const id of ids(base?.nodes, head.nodes)) {
    const b = base?.nodes.get(id);
    const h = head.nodes.get(id);
    out.nodes.set(id, {
      id,
      w: (h ?? b)!.w,
      h: (h ?? b)!.h,
      cluster: (h ?? b)!.cluster,
      status: statusOf(id, base ? !!b : false, !!h),
      before: b?.after,
      after: h?.after,
    });
  }
  for (const id of ids(base?.clusters, head.clusters)) {
    const b = base?.clusters.get(id);
    const h = head.clusters.get(id);
    out.clusters.set(id, { id, parent: (h ?? b)!.parent, status: statusOf(id, base ? !!b : false, !!h), before: b?.after, after: h?.after });
  }
  const eKey = (e: GEdge) => e.key;
  const bm = new Map((base?.edges ?? []).map((e) => [eKey(e), e]));
  const hm = new Map(head.edges.map((e) => [eKey(e), e]));
  for (const k of [...new Set([...bm.keys(), ...hm.keys()])].sort()) {
    const b = bm.get(k);
    const h = hm.get(k);
    const e = (h ?? b)!;
    const status: Status = !b && base ? "added" : !h ? "removed" : idx.relModified.has(relRoot(e.key.split("#")[0])) ? "modified" : "unchanged";
    out.edges.push({ ...e, status: base ? status : "added" });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Graphviz

export function graphvizVersion(): string {
  const r = spawnSync("dot", ["-V"], { encoding: "utf8" });
  return (r.stderr || r.stdout || "").trim();
}

function run(cmd: string, args: string[], input: string): string {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

// Layout of one graph with dot (clusters honoured). Returns node centres in points, y up.
export function dotLayout(g: Graph): Map<string, P> {
  const names = new Map([...g.nodes.keys()].sort().map((id, i) => [id, `n${i}`]));
  const cNames = new Map([...g.clusters.keys()].sort().map((id, i) => [id, `cluster_c${i}`]));
  const lines: string[] = ["digraph G {", "  graph [rankdir=TB, nodesep=0.8, ranksep=1.3, newrank=true, splines=false];", "  node [shape=box, fixedsize=true, label=\"\"];"];
  const emit = (parent: string | undefined, indent: string) => {
    for (const [id, c] of [...g.clusters].sort()) {
      if (c.parent !== parent) continue;
      lines.push(`${indent}subgraph ${cNames.get(id)} {`, `${indent}  margin=${PAD + 8};`, `${indent}  label=${q(" ")}; labelloc=t;`);
      emit(id, indent + "  ");
      for (const [nid, n] of [...g.nodes].sort()) if (n.cluster === id) lines.push(`${indent}  ${names.get(nid)} [width=${n.w / 72}, height=${n.h / 72}];`);
      lines.push(`${indent}}`);
    }
  };
  emit(undefined, "  ");
  for (const [nid, n] of [...g.nodes].sort()) if (!n.cluster) lines.push(`  ${names.get(nid)} [width=${n.w / 72}, height=${n.h / 72}];`);
  for (const e of g.edges) lines.push(`  ${names.get(e.src)} -> ${names.get(e.dst)};`);
  lines.push("}");
  const out = run("dot", ["-Tplain"], lines.join("\n"));
  const rev = new Map([...names].map(([id, n]) => [n, id]));
  const pos = new Map<string, P>();
  for (const l of out.split("\n")) {
    const t = l.trim().split(/\s+/);
    if (t[0] === "node") pos.set(rev.get(t[1])!, { x: Number(t[2]) * 72, y: Number(t[3]) * 72 });
  }
  return pos;
}

// Edge routing with every node pinned (`neato -n2`). Returns edge polylines (cubic bezier points) and the
// node positions as Graphviz reports them (translated frame).
function routeEdges(g: Graph, pos: Map<string, P>): { nodes: Map<string, P>; edges: Map<number, P[]> } {
  const names = new Map([...g.nodes.keys()].sort().map((id, i) => [id, `n${i}`]));
  const lines = ["digraph G {", "  graph [splines=true, sep=\"+10\"];", "  node [shape=box, fixedsize=true, label=\"\"];"];
  for (const [id, n] of [...g.nodes].sort()) {
    const p = pos.get(id)!;
    lines.push(`  ${names.get(id)} [width=${n.w / 72}, height=${n.h / 72}, pos="${p.x.toFixed(2)},${p.y.toFixed(2)}"];`);
  }
  g.edges.forEach((e, i) => lines.push(`  ${names.get(e.src)} -> ${names.get(e.dst)} [arrowhead=none, comment="e${i}"];`));
  lines.push("}");
  const out = run("neato", ["-n2", "-Tplain"], lines.join("\n"));
  const rev = new Map([...names].map(([id, n]) => [n, id]));
  const nodes = new Map<string, P>();
  const edgeLines: { tail: string; head: string; pts: P[] }[] = [];
  for (const l of out.split("\n")) {
    const t = l.trim().split(/\s+/);
    if (t[0] === "node") nodes.set(rev.get(t[1])!, { x: Number(t[2]) * 72, y: Number(t[3]) * 72 });
    if (t[0] === "edge") {
      const n = Number(t[3]);
      const pts: P[] = [];
      for (let i = 0; i < n; i++) pts.push({ x: Number(t[4 + 2 * i]) * 72, y: Number(t[5 + 2 * i]) * 72 });
      edgeLines.push({ tail: rev.get(t[1])!, head: rev.get(t[2])!, pts });
    }
  }
  // Match routed edges to input edges: same (tail, head), in input order.
  const used = new Set<number>();
  const edges = new Map<number, P[]>();
  g.edges.forEach((e, i) => {
    const j = edgeLines.findIndex((x, k) => !used.has(k) && x.tail === e.src && x.head === e.dst);
    if (j >= 0) {
      used.add(j);
      edges.set(i, edgeLines[j].pts);
    }
  });
  return { nodes, edges };
}

// ---------------------------------------------------------------------------------------------
// Geometry

export function nodeBox(g: Graph, id: string, p: P): Box {
  const n = g.nodes.get(id)!;
  return { x0: p.x - n.w / 2, y0: p.y - n.h / 2, x1: p.x + n.w / 2, y1: p.y + n.h / 2 };
}
const union = (a: Box | undefined, b: Box): Box =>
  a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : { ...b };
const inflate = (b: Box, d: number): Box => ({ x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d });
const hit = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export function clusterBoxes(g: Graph, pos: Map<string, P>): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const memo = (id: string): Box | undefined => {
    if (boxes.has(id)) return boxes.get(id);
    let b: Box | undefined;
    for (const [nid, n] of g.nodes) if (n.cluster === id && pos.has(nid)) b = union(b, nodeBox(g, nid, pos.get(nid)!));
    for (const [cid, c] of g.clusters) if (c.parent === id) {
      const cb = memo(cid);
      if (cb) b = union(b, cb);
    }
    if (!b) return undefined;
    const r = { x0: b.x0 - PAD, y0: b.y0 - PAD, x1: b.x1 + PAD, y1: b.y1 + PAD + HEADER };
    boxes.set(id, r);
    return r;
  };
  for (const id of g.clusters.keys()) memo(id);
  return boxes;
}

const ancestors = (g: Graph, id: string): Set<string> => {
  const s = new Set<string>();
  for (let c = g.clusters.get(id)?.parent; c; c = g.clusters.get(c)?.parent) s.add(c);
  return s;
};

// Number of layout conflicts: overlapping nodes, nodes inside foreign clusters, overlapping sibling clusters.
function conflicts(g: Graph, pos: Map<string, P>): number {
  let n = 0;
  const ids = [...pos.keys()].filter((i) => g.nodes.has(i)).sort();
  const nb = new Map(ids.map((i) => [i, nodeBox(g, i, pos.get(i)!)]));
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) if (hit(inflate(nb.get(ids[i])!, GAP / 2 - 4), inflate(nb.get(ids[j])!, GAP / 2 - 4))) n++;
  const cb = clusterBoxes(g, pos);
  const memberOf = (nid: string, cid: string) => {
    for (let c = g.nodes.get(nid)!.cluster; c; c = g.clusters.get(c)?.parent) if (c === cid) return true;
    return false;
  };
  for (const [cid, box] of cb) for (const nid of ids) if (!memberOf(nid, cid) && hit(box, nb.get(nid)!)) n++;
  const cids = [...cb.keys()].sort();
  for (let i = 0; i < cids.length; i++)
    for (let j = i + 1; j < cids.length; j++) {
      if (ancestors(g, cids[i]).has(cids[j]) || ancestors(g, cids[j]).has(cids[i])) continue;
      if (hit(cb.get(cids[i])!, cb.get(cids[j])!)) n++;
    }
  return n;
}

// Place nodes without a position: nearest conflict-free grid point around their connected neighbours.
function placeNew(g: Graph, pos: Map<string, P>): string[] {
  const placed: string[] = [];
  const missing = [...g.nodes.keys()].filter((id) => !pos.has(id)).sort();
  for (const id of missing) {
    const n = g.nodes.get(id)!;
    const neigh = g.edges.flatMap((e) => (e.src === id ? [e.dst] : e.dst === id ? [e.src] : [])).filter((x) => pos.has(x));
    const mates = [...g.nodes.values()].filter((m) => m.id !== id && m.cluster && m.cluster === n.cluster && pos.has(m.id)).map((m) => m.id);
    const anchors = (neigh.length ? neigh : mates.length ? mates : [...pos.keys()]).map((a) => pos.get(a)!);
    const c = anchors.length
      ? { x: anchors.reduce((s, p) => s + p.x, 0) / anchors.length, y: anchors.reduce((s, p) => s + p.y, 0) / anchors.length }
      : { x: 0, y: 0 };
    const baseline = conflicts(g, pos);
    const sx = (n.w + GAP) / 2;
    const sy = (n.h + GAP) / 2;
    const cands: { p: P; cost: number }[] = [];
    for (let i = -14; i <= 14; i++)
      for (let j = -10; j <= 10; j++) cands.push({ p: { x: c.x + i * sx, y: c.y + j * sy }, cost: Math.hypot(i * sx, j * sy) + (j > 0 ? 1 : 0) + (i < 0 ? 0.5 : 0) });
    cands.sort((a, b) => a.cost - b.cost || a.p.y - b.p.y || a.p.x - b.p.x);
    let chosen: P | undefined;
    for (const cand of cands) {
      if (cand.cost === 0 && neigh.length) continue; // never sit exactly on the neighbour centroid
      pos.set(id, cand.p);
      if (conflicts(g, pos) <= baseline) {
        chosen = cand.p;
        break;
      }
    }
    if (!chosen) {
      const maxX = Math.max(...[...pos.values()].map((p) => p.x), 0);
      chosen = { x: maxX + n.w + GAP, y: c.y };
    }
    pos.set(id, chosen);
    placed.push(id);
  }
  return placed;
}

// ---------------------------------------------------------------------------------------------
// Public entry: stable layout of the merged graph.

export interface LayoutResult {
  routed: Routed;
  basePositions: Map<string, P>; // persisted: node centres of the base layout, by identity
}

export function stableLayout(baseGraph: Graph | undefined, merged: Graph): LayoutResult {
  const basePositions = baseGraph ? dotLayout(baseGraph) : dotLayout(merged);
  const pos = new Map<string, P>();
  for (const id of merged.nodes.keys()) if (basePositions.has(id)) pos.set(id, { ...basePositions.get(id)! });
  const pinned = pos.size;
  const placed = placeNew(merged, pos);

  let nodes = pos;
  let edgePts = new Map<number, P[]>();
  try {
    const r = routeEdges(merged, pos);
    // Graphviz translates the drawing; recover the common offset and verify nothing moved.
    const ids = [...pos.keys()].sort();
    const off = (id: string) => ({ dx: r.nodes.get(id)!.x - pos.get(id)!.x, dy: r.nodes.get(id)!.y - pos.get(id)!.y });
    const ref = off(ids[0]);
    nodes = new Map(ids.map((id) => [id, { x: pos.get(id)!.x + ref.dx, y: pos.get(id)!.y + ref.dy }]));
    edgePts = r.edges;
  } catch {
    // fall through: straight edges
  }
  const edges = merged.edges.map((edge, i) => ({ edge, pts: edgePts.get(i) ?? straight(merged, nodes, edge) }));
  // Stability check against the persisted base layout (up to a common translation).
  let moved = 0;
  const common = [...pos.keys()].filter((id) => basePositions.has(id) && !placed.includes(id));
  if (common.length) {
    const ref = { dx: nodes.get(common[0])!.x - basePositions.get(common[0])!.x, dy: nodes.get(common[0])!.y - basePositions.get(common[0])!.y };
    for (const id of common) {
      const dx = nodes.get(id)!.x - basePositions.get(id)!.x - ref.dx;
      const dy = nodes.get(id)!.y - basePositions.get(id)!.y - ref.dy;
      if (Math.hypot(dx, dy) > 0.5) moved++;
    }
  }
  return { routed: { nodes, clusters: clusterBoxes(merged, nodes), edges, moved, pinned, placed }, basePositions };
}

function straight(g: Graph, pos: Map<string, P>, e: GEdge): P[] {
  const a = pos.get(e.src)!;
  const b = pos.get(e.dst)!;
  const t = (id: string, from: P, to: P): P => {
    const n = g.nodes.get(id)!;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const s = Math.min(dx ? n.w / 2 / Math.abs(dx) : Infinity, dy ? n.h / 2 / Math.abs(dy) : Infinity);
    return { x: from.x + dx * s, y: from.y + dy * s };
  };
  const p0 = t(e.src, a, b);
  const p3 = t(e.dst, b, a);
  return [p0, { x: p0.x + (p3.x - p0.x) / 3, y: p0.y + (p3.y - p0.y) / 3 }, { x: p0.x + ((p3.x - p0.x) * 2) / 3, y: p0.y + ((p3.y - p0.y) * 2) / 3 }, p3];
}
