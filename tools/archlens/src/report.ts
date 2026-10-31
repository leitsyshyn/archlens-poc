// Markdown output: summary.md (local) and comment.md (PR comment).
import { counts, type Delta, type ViewImpact } from "./diff.ts";
import type { RuleResult } from "./rules.ts";

export const COMMENT_MARKER = "<!-- archlens-diff-comment -->";
export const COMMENT_TITLE = "ArchLens: architecture changes in this PR";

const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;

export function summaryLine(d: Delta, r1: RuleResult): string {
  const c = counts(d);
  const part = (label: string, s: { added: number; removed: number; modified: number }) => {
    const bits = [s.added && `${s.added} added`, s.removed && `${s.removed} removed`, s.modified && `${s.modified} modified`].filter(Boolean);
    return `${label}: ${bits.length ? bits.join(", ") : "no change"}`;
  };
  return [
    part("elements", c.elements),
    part("relationships", c.relationships),
    part("deployment nodes", c.deploymentNodes),
    part("deployment instances", c.deploymentInstances),
    `${c.affectedViews} of ${c.totalViews} views affected`,
    `R1 ${r1.passed ? "pass" : "FAIL"}`,
  ].join(" · ");
}

function changeLists(d: Delta): string[] {
  const out: string[] = [];
  const el = (e: { kind: string; name: string; id: string; environment?: string }) => `${e.kind} **${e.name}** (\`${e.id}\`${e.environment ? `, ${e.environment}` : ""})`;
  const sec = (title: string, s: { added: any[]; removed: any[]; modified: any[] }, fmt: (x: any) => string) => {
    if (!s.added.length && !s.removed.length && !s.modified.length) return;
    out.push(`**${title}**`);
    for (const x of s.added) out.push(`- ➕ added ${fmt(x)}`);
    for (const x of s.removed) out.push(`- ➖ removed ${fmt(x)}`);
    for (const x of s.modified) out.push(`- ✏️ modified ${fmt(x)}: ${x.changes.map((c: any) => `${c.field} \`${c.from}\` → \`${c.to}\``).join(", ")}`);
    out.push("");
  };
  sec("Elements", d.elements, el);
  sec("Relationships", d.relationships, (r) => `\`${r.src}\` → \`${r.dst}\` "${r.description}"${r.technology ? ` [${r.technology}]` : ""}`);
  sec("Deployment nodes", d.deployment.nodes, el);
  sec("Deployment instances", d.deployment.instances, el);
  return out;
}

function r1Block(r1: RuleResult): string[] {
  return r1.passed
    ? ["**R1 (compose services ↔ model containers): ✅ pass**", ""]
    : ["**R1 (compose services ↔ model containers): ❌ FAIL**", "", ...r1.messages.map((m) => `- ${m}`), ""];
}

const viewLine = (v: ViewImpact) => `- \`${v.key}\` (${v.kind}) — ${v.status}`;

export function summaryMd(d: Delta, r1: RuleResult, images: Map<string, string>): string {
  const out = [`# ${COMMENT_TITLE}`, "", summaryLine(d, r1), "", ...r1Block(r1), "## Changes", "", ...changeLists(d), "## Views", ""];
  for (const v of d.views) {
    out.push(viewLine(v));
    for (const r of v.reasons) out.push(`  - ${r}`);
    if (images.has(v.key)) out.push(`  - image: ${images.get(v.key)}`);
  }
  return out.join("\n") + "\n";
}

export function commentMd(d: Delta, r1: RuleResult, images: Map<string, string>, deltaJson: string, meta: { base?: string; head?: string }): string {
  const affected = d.views.filter((v) => v.affected);
  const untouched = d.views.filter((v) => !v.affected);
  const out = [COMMENT_MARKER, `## ${COMMENT_TITLE}`, "", `**Summary:** ${summaryLine(d, r1)}`, ""];
  out.push(...r1Block(r1));
  out.push("### Changes", "", ...changeLists(d));
  out.push(`### Affected views (${affected.length})`, "");
  for (const v of affected) {
    out.push(`#### \`${v.key}\` — ${v.title}`, "");
    for (const r of v.reasons) out.push(`- ${r}`);
    out.push("");
    const img = images.get(v.key);
    if (img) out.push(`<img src="${img}" alt="ArchLens diff of view ${v.key}" width="100%">`, "");
  }
  if (untouched.length)
    out.push(`Not affected, not re-rendered: ${untouched.map((v) => `\`${v.key}\``).join(", ")}`, "");
  const json = deltaJson.length > 40000 ? deltaJson.slice(0, 40000) + "\n… truncated" : deltaJson;
  out.push("<details><summary>Raw delta JSON</summary>", "", "```json", json, "```", "", "</details>", "");
  out.push(`<sub>ArchLens POC · deterministic, no LLM${meta.base && meta.head ? ` · base \`${meta.base}\` → head \`${meta.head}\`` : ""}</sub>`);
  return out.join("\n") + "\n";
}
