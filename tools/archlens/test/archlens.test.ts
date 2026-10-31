import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { runDiff } from "../src/cli.ts";

const fx = (n: string) => new URL(`./fixtures/${n}`, import.meta.url).pathname;
const opts = (compose: string) => ({ base: fx("base.json"), head: fx("head.json"), compose: fx(compose), out: "unused" });
const hasDot = spawnSync("dot", ["-V"]).status === 0;

const drift = runDiff(opts("compose-drift.yml"), false);
const d = drift.delta;
const view = (k: string) => d.views.find((v) => v.key === k)!;

test("identity: DSL identifiers are used for every element (no path fallback)", () => {
  assert.equal(drift.report.identity.base.path, 0);
  assert.equal(drift.report.identity.head.path, 0);
});

test("change 1: rename + technology change is ONE modified element, not remove + add", () => {
  assert.deepEqual(d.elements.modified.map((m) => m.id), ["mobileApp"]);
  assert.deepEqual(
    d.elements.modified[0].changes.map((c) => [c.field, c.from, c.to]),
    [
      ["name", "Mobile App", "Mobile Storefront"],
      ["technology", "Kotlin / Android", "Kotlin Multiplatform"],
    ],
  );
  assert.ok(!d.elements.removed.some((e) => e.id === "mobileApp"));
  assert.ok(!d.elements.added.some((e) => e.id === "mobileApp"));
  for (const k of ["containers", "checkoutFlow"]) assert.ok(view(k).reasons.some((r) => r.includes("Mobile Storefront") && r.startsWith("modified")), k);
});

test("change 2: one added container and one added relationship; container view affected", () => {
  assert.deepEqual(d.elements.added.map((e) => e.id), ["cache"]);
  assert.deepEqual(d.relationships.added.map((r) => r.key), ["apiGateway|cache|Caches sessions in"]);
  assert.ok(view("containers").affected);
});

test("change 3: one removed relationship; dynamic view listed as affected", () => {
  assert.deepEqual(d.relationships.removed.map((r) => r.key), ["notificationService|mobileApp|Sends push notifications to"]);
  assert.ok(view("checkoutFlow").reasons.some((r) => r.startsWith("relationship removed")));
});

test("change 4: Production deployment affected, Staging not (by content)", () => {
  assert.deepEqual(d.deployment.instances.added.map((e) => [e.id, e.environment]), [["productionCache", "Production"]]);
  assert.deepEqual(d.deployment.nodes.added.map((e) => e.id), ["productionCacheNode"]);
  assert.ok(view("productionDeployment").affected);
  assert.equal(view("stagingDeployment").affected, false);
  assert.deepEqual(view("stagingDeployment").reasons, []);
});

test("affected set is exactly {containers, checkoutFlow, productionDeployment}", () => {
  assert.deepEqual(d.views.filter((v) => v.affected).map((v) => v.key).sort(), ["checkoutFlow", "containers", "productionDeployment"]);
});

test("change 5: R1 fails naming the service, exit-code semantics via result", () => {
  assert.equal(drift.r1.passed, false);
  assert.equal(drift.r1.messages.length, 1);
  assert.match(drift.r1.messages[0], /`worker`/);
});

test("R1 passes once the compose file matches the model", () => {
  assert.equal(runDiff(opts("compose-fixed.yml"), false).r1.passed, true);
});

test("R1 also fails for a Production container without a compose service", () => {
  const r = runDiff(opts("compose-base.yml"), false).r1; // base compose lacks `cache`, which head deploys to Production
  assert.equal(r.passed, false);
  assert.match(r.messages[0], /`cache`.*no service/);
});

test("rendering: only affected views are rendered and unchanged elements do not move", { skip: !hasDot && "graphviz not installed" }, () => {
  const r = runDiff(opts("compose-drift.yml"), false);
  assert.deepEqual([...r.svgs.keys()].sort(), ["checkoutFlow", "containers", "productionDeployment"]);
  for (const x of r.report.rendering) assert.equal(x.movedUnchanged, 0, x.view);
});

test("rendering is deterministic: two runs give byte-identical SVG", { skip: !hasDot && "graphviz not installed" }, () => {
  const hash = (m: Map<string, string>) => createHash("sha256").update([...m].sort().map(([k, v]) => k + v).join("\n")).digest("hex");
  const a = runDiff(opts("compose-drift.yml"), false).svgs;
  const b = runDiff(opts("compose-drift.yml"), false).svgs;
  assert.equal(hash(a), hash(b));
  for (const [k, v] of a) assert.equal(v, b.get(k), k);
});
