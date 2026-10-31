#!/usr/bin/env node
// archlens diff --base base.json --head head.json --compose compose.yml --out dir [--views k1,k2]
// archlens post --repo owner/name --pr N --sha SHA --out dir [--details-url URL] [--mode auto|check|status]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildGraph, graphvizVersion, mergeGraphs, stableLayout } from "./layout.ts";
import { diffModels, indexDelta, type Delta } from "./diff.ts";
import { InputError, loadModel } from "./load.ts";
import { renderSvg } from "./render.ts";
import { COMMENT_MARKER, commentMd, summaryLine, summaryMd } from "./report.ts";
import { checkR1, readComposeServices, type RuleResult } from "./rules.ts";
import { CHECK_NAME, publishCheck, upsertComment } from "./github.ts";

export interface DiffOptions {
  base: string;
  head: string;
  compose: string;
  out: string;
  views?: string[];
  imageBaseUrl?: string;
  prodEnv?: string;
  baseLabel?: string;
  headLabel?: string;
}

export interface DiffResult {
  delta: Delta;
  r1: RuleResult;
  svgs: Map<string, string>;
  report: any;
}

// Pure-ish core (writes files only when `write` is set) so tests can call it directly.
export function runDiff(o: DiffOptions, write = true): DiffResult {
  const base = loadModel(o.base);
  const head = loadModel(o.head);
  const services = readComposeServices(o.compose);
  const delta = diffModels(base, head);
  const r1 = checkR1(head, services, o.compose.replace(/^.*\/deploy\//, "deploy/"), o.prodEnv ?? "Production");
  const idx = indexDelta(base, head, delta);
  const relRoot = (key: string) => head.rels.get(key)?.rootKey ?? base.rels.get(key)?.rootKey ?? key;

  const svgs = new Map<string, string>();
  const rendering: any[] = [];
  const layouts: Record<string, unknown> = {};
  for (const v of delta.views) {
    if (!v.affected || v.status === "removed") continue;
    if (o.views && !o.views.includes(v.key)) continue;
    const hv = head.views.get(v.key)!;
    const bv = base.views.get(v.key);
    const headG = buildGraph(head, hv);
    const baseG = bv ? buildGraph(base, bv) : undefined;
    const merged = mergeGraphs(baseG, headG, idx, relRoot);
    const { routed, basePositions } = stableLayout(baseG, merged);
    svgs.set(
      v.key,
      renderSvg({
        title: `${hv.title}`,
        subtitle: `ArchLens diff${o.baseLabel && o.headLabel ? ` · ${o.baseLabel} → ${o.headLabel}` : ""} · view key: ${v.key}`,
        graph: merged,
        routed,
      }),
    );
    rendering.push({ view: v.key, nodes: merged.nodes.size, pinned: routed.pinned, movedUnchanged: routed.moved, newlyPlaced: routed.placed, image: `images/${v.key}.svg` });
    layouts[v.key] = {
      engine: "graphviz dot (base layout), node centres in points, y up, keyed by element identity",
      nodes: Object.fromEntries([...basePositions].sort((a, b) => a[0].localeCompare(b[0])).map(([k, p]) => [k, { x: +p.x.toFixed(2), y: +p.y.toFixed(2) }])),
    };
  }

  const report = {
    schema: "archlens-delta/1",
    tooling: { graphviz: graphvizVersion(), node: process.version },
    identity: {
      field: 'model element `properties["structurizr.dsl.identifier"]` (DSL identifier); relationships: source identity + destination identity + description; numeric export ids are never used',
      base: base.identityStats,
      head: head.identityStats,
    },
    summary: summaryLine(delta, r1),
    ...delta,
    rules: [r1],
    rendering,
  };
  const deltaJson = JSON.stringify(report, null, 2) + "\n";

  if (write) {
    mkdirSync(join(o.out, "images"), { recursive: true });
    mkdirSync(join(o.out, "layout"), { recursive: true });
    writeFileSync(join(o.out, "delta.json"), deltaJson);
    for (const [k, svg] of svgs) writeFileSync(join(o.out, "images", `${k}.svg`), svg);
    for (const [k, l] of Object.entries(layouts)) writeFileSync(join(o.out, "layout", `${k}.base.json`), JSON.stringify(l, null, 2) + "\n");
    const rel = new Map([...svgs.keys()].map((k) => [k, `images/${k}.svg`]));
    writeFileSync(join(o.out, "summary.md"), summaryMd(delta, r1, rel));
    const urls = new Map([...svgs.keys()].map((k) => [k, `${o.imageBaseUrl ?? "images"}/${k}.svg`]));
    writeFileSync(join(o.out, "comment.md"), commentMd(delta, r1, urls, deltaJson, { base: o.baseLabel, head: o.headLabel }));
  }
  return { delta, r1, svgs, report };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "diff") {
    const { values } = parseArgs({
      args: rest,
      options: {
        base: { type: "string" },
        head: { type: "string" },
        compose: { type: "string" },
        out: { type: "string" },
        views: { type: "string" },
        "image-base-url": { type: "string" },
        "prod-env": { type: "string" },
        "base-label": { type: "string" },
        "head-label": { type: "string" },
      },
    });
    if (!values.base || !values.head || !values.compose || !values.out) throw new InputError("usage: archlens diff --base <base.json> --head <head.json> --compose <compose.yml> --out <dir> [--views a,b]");
    const r = runDiff({
      base: values.base,
      head: values.head,
      compose: values.compose,
      out: values.out,
      views: values.views?.split(",").filter(Boolean),
      imageBaseUrl: values["image-base-url"],
      prodEnv: values["prod-env"],
      baseLabel: values["base-label"],
      headLabel: values["head-label"],
    });
    console.log(r.report.summary);
    for (const m of r.r1.messages) console.log(`R1: ${m}`);
    process.exit(r.r1.passed ? 0 : 1);
  } else if (cmd === "post") {
    const { values } = parseArgs({
      args: rest,
      options: { repo: { type: "string" }, pr: { type: "string" }, sha: { type: "string" }, out: { type: "string" }, "details-url": { type: "string" }, mode: { type: "string" } },
    });
    if (!values.repo || !values.pr || !values.sha || !values.out) throw new InputError("usage: archlens post --repo o/r --pr N --sha SHA --out dir");
    const delta = JSON.parse(readFileSync(join(values.out, "delta.json"), "utf8"));
    const r1: RuleResult = delta.rules[0];
    let body = readFileSync(join(values.out, "comment.md"), "utf8");
    try {
      body += `\n${readFileSync(join(values.out, "determinism.txt"), "utf8")}`;
    } catch {
      // no determinism note available
    }
    if (!body.includes(COMMENT_MARKER)) throw new InputError("comment.md has no marker");
    const c = await upsertComment(values.repo, Number(values.pr), COMMENT_MARKER, body);
    console.log(`comment ${c.created ? "created" : "updated"}: ${c.url}`);
    const summary = [`**${delta.summary}**`, "", r1.passed ? "R1 passed." : "R1 failed:", ...r1.messages.map((m: string) => `- ${m}`), "", `Comment: ${c.url}`].join("\n");
    const short = r1.passed ? "R1 passed: compose services and Production deployment match the model" : `R1 failed: ${r1.messages.length} violation(s). ${r1.messages[0]?.replace(/`/g, "")}`;
    const how = await publishCheck(values.repo, values.sha, r1.passed, summary, short, values["details-url"] ?? c.url, (values.mode as any) ?? "auto");
    console.log(`${CHECK_NAME} published as ${how}: ${r1.passed ? "success" : "failure"}`);
  } else {
    throw new InputError("commands: diff | post");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`archlens: ${e.message}`);
    process.exit(e instanceof InputError ? 2 : 2);
  });
}
