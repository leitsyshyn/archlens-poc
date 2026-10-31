// Loads a Structurizr workspace JSON export into a normalised model keyed by stable identity.
import { readFileSync } from "node:fs";

export type Kind =
  | "person"
  | "softwareSystem"
  | "container"
  | "component"
  | "deploymentNode"
  | "infrastructureNode"
  | "containerInstance"
  | "softwareSystemInstance";

export interface El {
  id: string; // stable identity (see identity.ts)
  identityFrom: "dsl" | "path";
  numericId: string; // export-time id, NEVER used for identity
  kind: Kind;
  name: string;
  description: string;
  technology: string;
  tags: string;
  parent?: string;
  environment?: string;
  instances?: string; // deployment node instance count
  ref?: string; // identity of the container / system an instance refers to
}

export interface Rel {
  key: string; // `${src}|${dst}|${description}`
  src: string;
  dst: string;
  description: string;
  technology: string;
  tags: string;
  derived: boolean; // implied relationship (linkedRelationshipId present)
  rootKey: string; // key of the explicit relationship this one derives from
}

export interface ViewRel {
  key: string;
  label: string; // view specific label (dynamic views override the description)
  order?: string;
}

export type ViewKind = "systemContext" | "container" | "component" | "dynamic" | "deployment";

export interface View {
  key: string;
  kind: ViewKind;
  title: string;
  scope?: string;
  environment?: string;
  elements: string[];
  rels: ViewRel[];
}

export interface Model {
  name: string;
  elements: Map<string, El>;
  rels: Map<string, Rel>;
  views: Map<string, View>;
  identityStats: { dsl: number; path: number };
}

type J = any;

const VIEW_LISTS: [string, ViewKind][] = [
  ["systemContextViews", "systemContext"],
  ["containerViews", "container"],
  ["componentViews", "component"],
  ["dynamicViews", "dynamic"],
  ["deploymentViews", "deployment"],
];

export function loadModel(path: string): Model {
  let json: J;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new InputError(`cannot read workspace JSON ${path}: ${(e as Error).message}`);
  }
  if (!json?.model || !json?.views) throw new InputError(`${path} is not a Structurizr workspace JSON`);
  return normalise(json);
}

export class InputError extends Error {}

export function normalise(json: J): Model {
  const elements = new Map<string, El>();
  const byNumeric = new Map<string, string>(); // numeric id -> identity
  const rawRels: { src: string; dst: string; r: J }[] = [];
  const stats = { dsl: 0, path: 0 };

  const add = (raw: J, kind: Kind, parent: El | undefined, extra: Partial<El> = {}): El => {
    // Identity: the DSL identifier when the export preserves it, else the canonical name path.
    const dsl = raw.properties?.["structurizr.dsl.identifier"] as string | undefined;
    const nameForPath = raw.name ?? `${extra.ref ?? "?"}#${raw.instanceId ?? 1}`;
    const id = dsl ?? `${parent ? parent.id + "/" : ""}${nameForPath}`;
    dsl ? stats.dsl++ : stats.path++;
    const el: El = {
      id,
      identityFrom: dsl ? "dsl" : "path",
      numericId: String(raw.id),
      kind,
      name: raw.name ?? "",
      description: raw.description ?? "",
      technology: raw.technology ?? "",
      tags: normaliseTags(raw.tags),
      parent: parent?.id,
      ...extra,
    };
    if (elements.has(id)) throw new InputError(`duplicate identity ${id}`);
    elements.set(id, el);
    byNumeric.set(String(raw.id), id);
    for (const r of raw.relationships ?? []) rawRels.push({ src: id, dst: String(r.destinationId), r });
    return el;
  };

  for (const p of json.model.people ?? []) add(p, "person", undefined);
  for (const s of json.model.softwareSystems ?? []) {
    const sys = add(s, "softwareSystem", undefined);
    for (const c of s.containers ?? []) {
      const cont = add(c, "container", sys);
      for (const k of c.components ?? []) add(k, "component", cont);
    }
  }
  const walkNodes = (nodes: J[], parent: El | undefined) => {
    for (const n of nodes ?? []) {
      const node = add(n, "deploymentNode", parent, { environment: n.environment, instances: String(n.instances ?? "1") });
      for (const i of n.infrastructureNodes ?? []) add(i, "infrastructureNode", node, { environment: i.environment });
      for (const ci of n.containerInstances ?? []) {
        const ref = byNumeric.get(String(ci.containerId));
        add({ ...ci, name: undefined }, "containerInstance", node, { environment: ci.environment, ref });
      }
      for (const si of n.softwareSystemInstances ?? []) {
        const ref = byNumeric.get(String(si.softwareSystemId));
        add({ ...si, name: undefined }, "softwareSystemInstance", node, { environment: si.environment, ref });
      }
      walkNodes(n.children, node);
    }
  };
  walkNodes(json.model.deploymentNodes, undefined);

  // Instances take their display name from the thing they instantiate.
  for (const el of elements.values()) {
    if (el.ref) {
      const target = elements.get(el.ref);
      el.name = target?.name ?? el.ref;
      el.technology = target?.technology ?? "";
      el.description = target?.description ?? "";
    }
  }

  // Relationships. Numeric ids only serve to resolve links inside this one file.
  const relByNumeric = new Map<string, { src: string; dst: string; description: string; linked?: string }>();
  for (const { src, dst, r } of rawRels) {
    relByNumeric.set(String(r.id), {
      src,
      dst: byNumeric.get(dst) ?? dst,
      description: r.description ?? "",
      linked: r.linkedRelationshipId !== undefined ? String(r.linkedRelationshipId) : undefined,
    });
  }
  const rels = new Map<string, Rel>();
  const keyOf = (n: string) => {
    const r = relByNumeric.get(n)!;
    return `${r.src}|${r.dst}|${r.description}`;
  };
  const rootKeyOf = (n: string): string => {
    let cur = n;
    for (let guard = 0; guard < 20; guard++) {
      const r = relByNumeric.get(cur);
      if (!r?.linked || !relByNumeric.has(r.linked)) return keyOf(cur);
      cur = r.linked;
    }
    return keyOf(cur);
  };
  for (const { src, dst, r } of rawRels) {
    const n = String(r.id);
    const key = keyOf(n);
    rels.set(key, {
      key,
      src,
      dst: byNumeric.get(dst) ?? dst,
      description: r.description ?? "",
      technology: r.technology ?? "",
      tags: normaliseTags(r.tags),
      derived: r.linkedRelationshipId !== undefined,
      rootKey: rootKeyOf(n),
    });
  }

  const views = new Map<string, View>();
  for (const [listName, kind] of VIEW_LISTS) {
    for (const v of json.views[listName] ?? []) {
      const scopeNumeric = v.softwareSystemId ?? v.elementId;
      views.set(v.key, {
        key: v.key,
        kind,
        title: v.title || v.name || v.key,
        scope: scopeNumeric !== undefined ? byNumeric.get(String(scopeNumeric)) : undefined,
        environment: v.environment,
        elements: (v.elements ?? []).map((e: J) => byNumeric.get(String(e.id)) ?? `?${e.id}`).sort(),
        rels: (v.relationships ?? [])
          .filter((r: J) => relByNumeric.has(String(r.id)))
          .map((r: J) => ({
            key: keyOf(String(r.id)),
            label: r.description ?? relByNumeric.get(String(r.id))!.description,
            order: r.order,
          }))
          .sort((a: ViewRel, b: ViewRel) => (a.order ?? "").localeCompare(b.order ?? "", "en", { numeric: true }) || a.key.localeCompare(b.key)),
      });
    }
  }
  return { name: json.name ?? "", elements, rels, views, identityStats: stats };
}

function normaliseTags(t: unknown): string {
  return String(t ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
    .join(",");
}
