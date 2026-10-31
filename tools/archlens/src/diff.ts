// Semantic diff of two normalised models, and the list of affected views.
import type { El, Kind, Model, Rel, View } from "./load.ts";

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}
export interface ElChange {
  id: string;
  kind: Kind;
  name: string;
  environment?: string;
  parent?: string;
}
export interface ElModified extends ElChange {
  changes: FieldChange[];
}
export interface RelChange {
  key: string;
  src: string;
  dst: string;
  description: string;
  technology: string;
}
export interface RelModified extends RelChange {
  changes: FieldChange[];
}
export interface Section<A, M> {
  added: A[];
  removed: A[];
  modified: M[];
}
export interface ViewImpact {
  key: string;
  kind: string;
  title: string;
  status: "added" | "removed" | "changed" | "unchanged";
  affected: boolean;
  reasons: string[];
}
export interface Delta {
  elements: Section<ElChange, ElModified>;
  relationships: Section<RelChange, RelModified>;
  deployment: {
    nodes: Section<ElChange, ElModified>;
    instances: Section<ElChange, ElModified>;
  };
  views: ViewImpact[];
}

const MODEL_KINDS = new Set<Kind>(["person", "softwareSystem", "container", "component"]);
const NODE_KINDS = new Set<Kind>(["deploymentNode", "infrastructureNode"]);
const INSTANCE_KINDS = new Set<Kind>(["containerInstance", "softwareSystemInstance"]);

const FIELDS: (keyof El)[] = ["name", "description", "technology", "tags", "instances", "parent"];

const change = (e: El): ElChange => ({
  id: e.id,
  kind: e.kind,
  name: e.name,
  ...(e.environment ? { environment: e.environment } : {}),
  ...(e.parent ? { parent: e.parent } : {}),
});

function diffElements(base: Model, head: Model, kinds: Set<Kind>): Section<ElChange, ElModified> {
  const out: Section<ElChange, ElModified> = { added: [], removed: [], modified: [] };
  const ids = [...new Set([...base.elements.keys(), ...head.elements.keys()])].sort();
  for (const id of ids) {
    const b = base.elements.get(id);
    const h = head.elements.get(id);
    const kind = (h ?? b)!.kind;
    if (!kinds.has(kind)) continue;
    if (!b) out.added.push(change(h!));
    else if (!h) out.removed.push(change(b));
    else {
      const changes: FieldChange[] = [];
      for (const f of FIELDS) {
        if (INSTANCE_KINDS.has(kind) && f !== "parent") continue; // instance labels derive from their container
        if ((b[f] ?? "") !== (h[f] ?? "")) changes.push({ field: f, from: String(b[f] ?? ""), to: String(h[f] ?? "") });
      }
      if (changes.length) out.modified.push({ ...change(h), changes });
    }
  }
  return out;
}

const relChange = (r: Rel): RelChange => ({
  key: r.key,
  src: r.src,
  dst: r.dst,
  description: r.description,
  technology: r.technology,
});

// Relationships are identified by (source identity, destination identity, description).
// A leftover single removal + single addition between the same pair is reported as a modification
// (description changed).
function diffRelationships(base: Model, head: Model): Section<RelChange, RelModified> {
  const explicit = (m: Model) => new Map([...m.rels].filter(([, r]) => !r.derived));
  const b = explicit(base);
  const h = explicit(head);
  const out: Section<RelChange, RelModified> = { added: [], removed: [], modified: [] };
  const removed: Rel[] = [];
  const added: Rel[] = [];
  for (const k of [...new Set([...b.keys(), ...h.keys()])].sort()) {
    const x = b.get(k);
    const y = h.get(k);
    if (x && !y) removed.push(x);
    else if (!x && y) added.push(y);
    else if (x && y) {
      const changes: FieldChange[] = [];
      for (const f of ["technology", "tags"] as const)
        if (x[f] !== y[f]) changes.push({ field: f, from: x[f], to: y[f] });
      if (changes.length) out.modified.push({ ...relChange(y), changes });
    }
  }
  const pair = (r: Rel) => `${r.src}|${r.dst}`;
  const remByPair = groupBy(removed, pair);
  const addByPair = groupBy(added, pair);
  for (const [p, rs] of remByPair) {
    const as = addByPair.get(p);
    if (rs.length === 1 && as?.length === 1) {
      const changes: FieldChange[] = [{ field: "description", from: rs[0].description, to: as[0].description }];
      if (rs[0].technology !== as[0].technology) changes.push({ field: "technology", from: rs[0].technology, to: as[0].technology });
      out.modified.push({ ...relChange(as[0]), changes });
      remByPair.set(p, []);
      addByPair.set(p, []);
    }
  }
  out.removed = [...remByPair.values()].flat().map(relChange);
  out.added = [...addByPair.values()].flat().map(relChange);
  out.modified.sort((a, c) => a.key.localeCompare(c.key));
  return out;
}

function groupBy<T>(xs: T[], f: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(f(x), [...(m.get(f(x)) ?? []), x]);
  return m;
}

export function diffModels(base: Model, head: Model): Delta {
  const elements = diffElements(base, head, MODEL_KINDS);
  const nodes = diffElements(base, head, NODE_KINDS);
  const instances = diffElements(base, head, INSTANCE_KINDS);
  const relationships = diffRelationships(base, head);
  const delta: Delta = { elements, relationships, deployment: { nodes, instances }, views: [] };
  delta.views = impactOnViews(base, head, delta);
  return delta;
}

// ---------------------------------------------------------------------------------------------
// Views

export interface ChangeIndex {
  added: Set<string>;
  removed: Set<string>;
  modified: Map<string, FieldChange[]>;
  relModified: Map<string, FieldChange[]>; // by relationship key
  relRemoved: Set<string>;
  relAdded: Set<string>;
}

export function indexDelta(base: Model, head: Model, d: Delta): ChangeIndex {
  const all = [d.elements, d.deployment.nodes, d.deployment.instances];
  const modified = new Map<string, FieldChange[]>();
  for (const s of all) for (const m of s.modified) modified.set(m.id, m.changes);
  // Instances inherit the changes of the container they instantiate (their label comes from it).
  for (const m of [...head.elements.values(), ...base.elements.values()])
    if (m.ref && modified.has(m.ref) && !modified.has(m.id)) modified.set(m.id, modified.get(m.ref)!);
  return {
    added: new Set(all.flatMap((s) => s.added.map((e) => e.id))),
    removed: new Set(all.flatMap((s) => s.removed.map((e) => e.id))),
    modified,
    relModified: new Map(d.relationships.modified.map((r) => [r.key, r.changes])),
    relRemoved: new Set(d.relationships.removed.map((r) => r.key)),
    relAdded: new Set(d.relationships.added.map((r) => r.key)),
  };
}

function impactOnViews(base: Model, head: Model, d: Delta): ViewImpact[] {
  const idx = indexDelta(base, head, d);
  const name = (id: string) => (head.elements.get(id) ?? base.elements.get(id))?.name || id;
  const relName = (key: string, m: Model) => {
    const r = m.rels.get(key)!;
    return `${name(r.src)} → ${name(r.dst)} "${r.description}"`;
  };
  const out: ViewImpact[] = [];
  for (const key of [...new Set([...base.views.keys(), ...head.views.keys()])].sort()) {
    const bv = base.views.get(key);
    const hv = head.views.get(key);
    const v = (hv ?? bv)!;
    if (!bv || !hv) {
      out.push({ key, kind: v.kind, title: v.title, status: bv ? "removed" : "added", affected: true, reasons: [bv ? "view removed" : "view added"] });
      continue;
    }
    out.push(impactOfView(key, bv, hv, base, head, idx, name, relName));
  }
  return out;
}

function impactOfView(
  key: string,
  bv: View,
  hv: View,
  base: Model,
  head: Model,
  idx: ChangeIndex,
  name: (id: string) => string,
  relName: (key: string, m: Model) => string,
): ViewImpact {
  const reasons: string[] = [];
  const bEls = new Set(bv.elements);
  const hEls = new Set(hv.elements);
  const kindLabel = (id: string) => (head.elements.get(id) ?? base.elements.get(id))!.kind;
  const isNode = (id: string) => NODE_KINDS.has(kindLabel(id));
  for (const id of [...hEls].filter((x) => !bEls.has(x)).sort())
    reasons.push(`${idx.added.has(id) ? "added" : "added to view"}: ${kindLabel(id)} ${name(id)}`);
  for (const id of [...bEls].filter((x) => !hEls.has(x)).sort())
    reasons.push(`${idx.removed.has(id) ? "removed" : "removed from view"}: ${kindLabel(id)} ${name(id)}`);
  for (const id of [...hEls].filter((x) => bEls.has(x)).sort()) {
    const ch = idx.modified.get(id);
    if (ch) reasons.push(`modified: ${kindLabel(id)} ${name(id)} (${describe(ch)})`);
  }
  if (hv.scope && idx.modified.has(hv.scope) && !hEls.has(hv.scope))
    reasons.push(`modified (view scope): ${name(hv.scope)} (${describe(idx.modified.get(hv.scope)!)})`);

  const bRels = new Map(bv.rels.map((r) => [r.key + "#" + (r.order ?? ""), r]));
  const hRels = new Map(hv.rels.map((r) => [r.key + "#" + (r.order ?? ""), r]));
  let derivedAdded = 0;
  let derivedRemoved = 0;
  for (const [k, r] of [...hRels].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!bRels.has(k)) {
      if (head.rels.get(r.key)?.derived) derivedAdded++;
      else reasons.push(`relationship added: ${relName(r.key, head)}`);
    }
  }
  for (const [k, r] of [...bRels].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!hRels.has(k)) {
      if (base.rels.get(r.key)?.derived) derivedRemoved++;
      else reasons.push(`relationship removed: ${relName(r.key, base)}`);
    }
  }
  if (derivedAdded) reasons.push(`${derivedAdded} derived relationship(s) added (implied between ${"instances/parents"})`);
  if (derivedRemoved) reasons.push(`${derivedRemoved} derived relationship(s) removed`);
  for (const [k, r] of [...hRels].sort((a, b) => a[0].localeCompare(b[0]))) {
    const b = bRels.get(k);
    if (!b) continue;
    const root = head.rels.get(r.key)?.rootKey ?? r.key;
    if (idx.relModified.has(root)) reasons.push(`relationship modified: ${relName(r.key, head)} (${describe(idx.relModified.get(root)!)})`);
    else if (b.label !== r.label) reasons.push(`step label changed: "${b.label}" → "${r.label}"`);
  }
  void isNode;
  return { key, kind: hv.kind, title: hv.title, status: reasons.length ? "changed" : "unchanged", affected: reasons.length > 0, reasons };
}

export const describe = (ch: FieldChange[]) => ch.map((c) => `${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`).join(", ");

export function counts(d: Delta) {
  const n = (s: Section<unknown, unknown>) => ({ added: s.added.length, removed: s.removed.length, modified: s.modified.length });
  return {
    elements: n(d.elements),
    relationships: n(d.relationships),
    deploymentNodes: n(d.deployment.nodes),
    deploymentInstances: n(d.deployment.instances),
    affectedViews: d.views.filter((v) => v.affected).length,
    totalViews: d.views.length,
  };
}
