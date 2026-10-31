// Self-contained SVG output (no external fonts, scripts or markers). Everything is sorted and numbers use
// fixed precision, so the same inputs produce byte-identical SVG.
import type { El } from "./load.ts";
import type { Box, GCluster, GEdge, GNode, Graph, P, Routed, Status } from "./layout.ts";

const FONT = "Helvetica, Arial, sans-serif";
const C = {
  unchanged: { fill: "#ffffff", stroke: "#8c959f", w: 1.5, text: "#1f2328" },
  added: { fill: "#dafbe1", stroke: "#1a7f37", w: 3.5, text: "#0f3d1e" },
  modified: { fill: "#fff8c5", stroke: "#9a6700", w: 3.5, text: "#4d3800" },
  removed: { fill: "#f6f8fa", stroke: "#cf222e", w: 2, text: "#6e7781" },
} as const;
const EDGE = {
  unchanged: { stroke: "#6e7781", w: 1.6 },
  added: { stroke: "#1a7f37", w: 3.5 },
  modified: { stroke: "#9a6700", w: 3.5 },
  removed: { stroke: "#cf222e", w: 2.2 },
} as const;

const f = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function wrap(text: string, max: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/.{0,2}$/, "") + "…";
    return kept;
  }
  return lines;
}

const KIND_LABEL: Record<string, string> = {
  person: "Person",
  softwareSystem: "Software System",
  container: "Container",
  component: "Component",
  deploymentNode: "Deployment Node",
  infrastructureNode: "Infrastructure Node",
  containerInstance: "Container Instance",
  softwareSystemInstance: "Software System Instance",
};
const kindText = (e: El) => `[${KIND_LABEL[e.kind]}${e.technology ? ": " + e.technology : ""}]`;

function bezier(p: P[], seg: number, t: number): P {
  const [a, b, c, d] = [p[3 * seg], p[3 * seg + 1], p[3 * seg + 2], p[3 * seg + 3]];
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
    y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
  };
}

export interface RenderInput {
  title: string;
  subtitle: string;
  graph: Graph;
  routed: Routed;
}

export function renderSvg(input: RenderInput): string {
  const { graph: g, routed: r } = input;
  // Bounds in layout space (y up).
  let b: Box | undefined;
  const grow = (x0: number, y0: number, x1: number, y1: number) => {
    b = b ? { x0: Math.min(b.x0, x0), y0: Math.min(b.y0, y0), x1: Math.max(b.x1, x1), y1: Math.max(b.y1, y1) } : { x0, y0, x1, y1 };
  };
  for (const [id, p] of r.nodes) {
    const n = g.nodes.get(id)!;
    grow(p.x - n.w / 2, p.y - n.h / 2, p.x + n.w / 2, p.y + n.h / 2);
  }
  for (const box of r.clusters.values()) grow(box.x0, box.y0, box.x1, box.y1);
  for (const e of r.edges) for (const p of e.pts) grow(p.x, p.y, p.x, p.y);
  if (!b) b = { x0: 0, y0: 0, x1: 400, y1: 200 };
  const M = 30;
  const TITLE_H = 54;
  const LEGEND_H = 74;
  const W = Math.max(b.x1 - b.x0 + 2 * M, 820);
  const H = b.y1 - b.y0 + 2 * M + TITLE_H + LEGEND_H;
  // layout (x, y-up) -> svg
  const X = (x: number) => x - b!.x0 + M;
  const Y = (y: number) => b!.y1 - y + M + TITLE_H;

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}" height="${f(H)}" viewBox="0 0 ${f(W)} ${f(H)}" font-family="${FONT}">`);
  out.push(`<title>${esc(input.title)}</title>`);
  out.push(`<rect x="0" y="0" width="${f(W)}" height="${f(H)}" fill="#ffffff"/>`);
  out.push(`<text x="${M}" y="26" font-size="18" font-weight="bold" fill="#1f2328">${esc(input.title)}</text>`);
  out.push(`<text x="${M}" y="44" font-size="12" fill="#57606a">${esc(input.subtitle)}</text>`);

  // Clusters: outermost first so nested ones draw on top.
  const depth = (c: GCluster): number => (c.parent && g.clusters.get(c.parent) ? 1 + depth(g.clusters.get(c.parent)!) : 0);
  const clusters = [...g.clusters.values()].sort((a, c) => depth(a) - depth(c) || a.id.localeCompare(c.id));
  for (const c of clusters) {
    const box = r.clusters.get(c.id);
    if (!box) continue;
    const st = C[c.status];
    const ghost = c.status === "removed";
    const el = c.after ?? c.before!;
    const inst = (e?: El) => (e?.kind === "deploymentNode" ? e.instances : undefined);
    const countLabel = c.status === "modified" && c.before && c.after && inst(c.before) !== inst(c.after) ? ` ×${inst(c.before)} → ×${inst(c.after)}` : inst(el) && inst(el) !== "1" ? ` ×${inst(el)}` : "";
    const label = `${el.name}${countLabel} ${kindText(el)}`;
    out.push(
      `<g${ghost ? ' opacity="0.5"' : ""}><rect x="${f(X(box.x0))}" y="${f(Y(box.y1))}" width="${f(box.x1 - box.x0)}" height="${f(box.y1 - box.y0)}" rx="8" fill="${c.status === "unchanged" ? "none" : st.fill}" fill-opacity="${c.status === "unchanged" ? 1 : 0.35}" stroke="${st.stroke}" stroke-width="${st.w}" stroke-dasharray="${c.status === "unchanged" || ghost ? "7 5" : "none"}"/>` +
        `<text x="${f(X(box.x0) + 10)}" y="${f(Y(box.y1) + 19)}" font-size="12.5" font-weight="bold" fill="${st.text}">${esc(label)}${tag(c.status)}</text></g>`,
    );
  }

  // Edges.
  for (const { edge, pts } of r.edges) out.push(drawEdge(edge, pts, X, Y));
  // Nodes.
  for (const [id, p] of [...r.nodes].sort((a, c) => a[0].localeCompare(c[0]))) out.push(drawNode(g.nodes.get(id)!, p, X, Y));
  // Edge labels on top.
  for (const { edge, pts } of r.edges) out.push(drawEdgeLabel(edge, pts, X, Y));

  // Legend.
  const ly = H - LEGEND_H + 10;
  out.push(`<rect x="${M}" y="${f(ly)}" width="${f(W - 2 * M)}" height="${LEGEND_H - 20}" rx="6" fill="#f6f8fa" stroke="#d0d7de"/>`);
  out.push(`<text x="${M + 12}" y="${f(ly + 18)}" font-size="12" font-weight="bold" fill="#1f2328">Legend</text>`);
  const items: [string, Status | "pinned"][] = [
    ["Added", "added"],
    ["Modified (old → new shown)", "modified"],
    ["Removed (ghost, base position)", "removed"],
    ["Unchanged", "unchanged"],
  ];
  let lx = M + 80;
  for (const [text, st] of items) {
    const s = C[st as Status];
    out.push(`<rect x="${f(lx)}" y="${f(ly + 6)}" width="26" height="16" rx="3" fill="${s.fill}" stroke="${s.stroke}" stroke-width="${Math.min(s.w, 2.5)}" stroke-dasharray="${st === "removed" ? "4 3" : "none"}" opacity="${st === "removed" ? 0.6 : 1}"/>`);
    out.push(`<text x="${f(lx + 34)}" y="${f(ly + 19)}" font-size="11.5" fill="#1f2328">${esc(text)}</text>`);
    lx += 34 + text.length * 6.2 + 26;
  }
  out.push(`<text x="${M + 12}" y="${f(ly + 44)}" font-size="11" fill="#57606a">Unchanged elements keep their base-layout position (${r.pinned} pinned, ${r.moved} moved, ${r.placed.length} newly placed). Dashed boxes are boundaries / deployment nodes.</text>`);
  out.push("</svg>");
  return out.join("\n") + "\n";
}

const tag = (s: Status) => (s === "added" ? " · NEW" : s === "modified" ? " · CHANGED" : s === "removed" ? " · REMOVED" : "");

function drawNode(n: GNode, p: P, X: (x: number) => number, Y: (y: number) => number): string {
  const st = C[n.status];
  const el = (n.after ?? n.before)!;
  const x = X(p.x - n.w / 2);
  const y = Y(p.y + n.h / 2);
  const ghost = n.status === "removed";
  const lines: { t: string; size: number; weight?: string; fill?: string; style?: string }[] = [];
  const names = wrap(el.name, 28, 2);
  names.forEach((t) => lines.push({ t, size: 13.5, weight: "bold" }));
  if (n.status === "modified" && n.before && n.after) {
    const ch = (k: keyof El) => n.before![k] !== n.after![k];
    if (ch("name")) lines.push({ t: `was: ${n.before.name}`, size: 11, fill: "#9a6700", style: "italic" });
    lines.push({ t: kindText(el), size: 11, fill: "#57606a" });
    if (ch("technology")) lines.push({ t: `was: [${n.before.technology || "none"}]`, size: 11, fill: "#9a6700", style: "italic" });
    if (ch("description")) lines.push({ t: `was: ${n.before.description}`, size: 10, fill: "#9a6700", style: "italic" });
  } else {
    lines.push({ t: kindText(el), size: 11, fill: "#57606a" });
  }
  const room = Math.floor((n.h - 14) / 14) - lines.length;
  if (el.description && n.h > 100 && room > 0) wrap(el.description, 36, Math.min(room, 2)).forEach((t) => lines.push({ t, size: 10.5, fill: "#57606a" }));
  let ty = y + 20;
  const parts: string[] = [];
  for (const l of lines) {
    parts.push(
      `<text x="${f(x + n.w / 2)}" y="${f(ty)}" text-anchor="middle" font-size="${l.size}"${l.weight ? ` font-weight="${l.weight}"` : ""}${l.style ? ` font-style="${l.style}"` : ""} fill="${l.fill ?? st.text}">${esc(l.t)}</text>`,
    );
    ty += l.size + 3.5;
  }
  return (
    `<g${ghost ? ' opacity="0.5"' : ""}><rect x="${f(x)}" y="${f(y)}" width="${f(n.w)}" height="${f(n.h)}" rx="8" fill="${st.fill}" stroke="${st.stroke}" stroke-width="${st.w}" stroke-dasharray="${ghost ? "7 5" : "none"}"/>` +
    parts.join("") +
    (n.status !== "unchanged"
      ? `<text x="${f(x + n.w - 8)}" y="${f(y + n.h - 7)}" text-anchor="end" font-size="9.5" font-weight="bold" fill="${st.stroke}">${tag(n.status).replace(" · ", "")}</text>`
      : "") +
    `</g>`
  );
}

function path(pts: P[], X: (x: number) => number, Y: (y: number) => number): string {
  let d = `M${f(X(pts[0].x))},${f(Y(pts[0].y))}`;
  for (let i = 1; i + 2 < pts.length; i += 3)
    d += ` C${f(X(pts[i].x))},${f(Y(pts[i].y))} ${f(X(pts[i + 1].x))},${f(Y(pts[i + 1].y))} ${f(X(pts[i + 2].x))},${f(Y(pts[i + 2].y))}`;
  return d;
}

function drawEdge(e: GEdge, pts: P[], X: (x: number) => number, Y: (y: number) => number): string {
  const st = EDGE[e.status];
  const ghost = e.status === "removed";
  const end = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const ang = Math.atan2(end.y - prev.y, end.x - prev.x);
  const L = 12 + st.w;
  const wing = 0.38;
  const tri = [
    end,
    { x: end.x - L * Math.cos(ang - wing), y: end.y - L * Math.sin(ang - wing) },
    { x: end.x - L * Math.cos(ang + wing), y: end.y - L * Math.sin(ang + wing) },
  ];
  return (
    `<g${ghost ? ' opacity="0.6"' : ""}><path d="${path(pts, X, Y)}" fill="none" stroke="${st.stroke}" stroke-width="${st.w}" stroke-dasharray="${ghost ? "8 5" : "none"}"/>` +
    `<polygon points="${tri.map((t) => `${f(X(t.x))},${f(Y(t.y))}`).join(" ")}" fill="${st.stroke}"/></g>`
  );
}

function drawEdgeLabel(e: GEdge, pts: P[], X: (x: number) => number, Y: (y: number) => number): string {
  const segs = (pts.length - 1) / 3;
  const mid = bezier(pts, Math.floor((segs - 1) / 2), segs % 2 === 0 ? 1 : 0.5);
  const st = EDGE[e.status];
  const text = `${e.order ? e.order + ". " : ""}${e.label}`;
  const lines = wrap(text, 30, 2);
  const ghost = e.status === "removed";
  const w = Math.max(...lines.map((l) => l.length)) * 5.6 + 8;
  const h = lines.length * 12.5 + 4;
  const x = X(mid.x);
  const y = Y(mid.y);
  return (
    `<g${ghost ? ' opacity="0.7"' : ""}><rect x="${f(x - w / 2)}" y="${f(y - h / 2)}" width="${f(w)}" height="${f(h)}" rx="3" fill="#ffffff" fill-opacity="0.85"/>` +
    lines.map((l, i) => `<text x="${f(x)}" y="${f(y - h / 2 + 12 + i * 12.5)}" text-anchor="middle" font-size="10.5" fill="${e.status === "unchanged" ? "#424a53" : st.stroke}">${esc(l)}</text>`).join("") +
    `</g>`
  );
}
