// Rule R1: compose services and the Production deployment must agree with the model.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { InputError, type Model } from "./load.ts";

export interface RuleResult {
  rule: "R1";
  passed: boolean;
  messages: string[];
}

export function readComposeServices(path: string): string[] {
  let doc: any;
  try {
    doc = parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new InputError(`cannot read compose file ${path}: ${(e as Error).message}`);
  }
  if (!doc || typeof doc.services !== "object" || doc.services === null) throw new InputError(`${path} has no "services" section`);
  return Object.keys(doc.services).sort();
}

// R1: every compose service maps to a container in the model (service name == container DSL identifier),
// and every container with a container instance in Production has a compose service.
export function checkR1(head: Model, services: string[], composePath: string, productionEnv = "Production"): RuleResult {
  const containers = [...head.elements.values()].filter((e) => e.kind === "container");
  const byId = new Map(containers.map((c) => [c.id, c]));
  const messages: string[] = [];
  for (const s of services)
    if (!byId.has(s))
      messages.push(`Compose service \`${s}\` has no matching container in the model (expected a container with DSL identifier \`${s}\`).`);
  const deployed = new Set(
    [...head.elements.values()].filter((e) => e.kind === "containerInstance" && e.environment === productionEnv && e.ref).map((e) => e.ref!),
  );
  for (const id of [...deployed].sort())
    if (!services.includes(id))
      messages.push(`Container \`${id}\` (${byId.get(id)?.name ?? id}) has an instance in ${productionEnv} but ${composePath} has no service \`${id}\`.`);
  return { rule: "R1", passed: messages.length === 0, messages };
}
