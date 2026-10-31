# archlens-poc

Proof of concept for **ArchLens direction A**: review architecture changes in a pull request, with a stable visual diff
and a manifest check. One public repo, one synthetic C4 model (Structurizr DSL), one PR with five known changes, and
four outputs for the same change set so they can be compared:

| Output | What | Where it runs |
|---|---|---|
| B1 | raw text diff | GitHub "Files changed" |
| B2 | plain render job: every view rendered before and after, independent auto-layout (PlantUML) | `.github/workflows/baseline-render.yml` |
| B3 | AI reviewer (CodeRabbit), optional | install by hand, see below |
| A | ArchLens: semantic diff, affected views only, base layout held fixed, highlights, rule R1, `archlens/model-diff` check | `.github/workflows/archlens-diff.yml` |

Demo PR: <https://github.com/leitsyshyn/archlens-poc/pull/1>. Results and the honest comparison are in [`docs/poc-comparison.md`](docs/poc-comparison.md).

**What ran where:** everything on the PR ran in GitHub Actions (both workflows, tests, the Structurizr and PlantUML Docker steps, the PR comments and the `archlens/model-diff` check run). Locally I only ran the same tools to develop, to inspect images, and for the second determinism run; nothing posted to the PR came from a local run.

## Layout

```
model/workspace.dsl              ShopFlow, a synthetic e-commerce model (written for this POC, no third-party content)
deploy/docker-compose.yml        manifest checked by rule R1
tools/export.sh                  Structurizr export through Docker (JSON or C4-PlantUML)
tools/render-baseline/           B2: render + comment scripts
tools/archlens/                  A: the diff tool (TypeScript, plain Node, pnpm)
tools/publish-artifacts.sh       pushes images to the throw-away `poc-artifacts` branch
.github/workflows/               baseline-render.yml, archlens-diff.yml
docs/poc-comparison.md           evaluation
```

Model size: 1 person, 1 system in scope, 2 external systems, 11 containers, 14 components (in 3 containers), 39 explicit
relationships, 7 views (system context, container, 2 component, 1 dynamic, `Staging` and `Production` deployment). Both
environments deploy the same 10 server containers with different instance counts; `Production` also has a
`Web Application Firewall` that `Staging` lacks. `Mobile App` runs on customer devices and is deliberately in no deployment.

## Tools and versions

| Tool | Version | Why |
|---|---|---|
| Structurizr (`structurizr/structurizr` Docker image) | 6.2.4, pinned by digest in `tools/export.sh` | DSL to workspace JSON and C4-PlantUML |
| PlantUML (`plantuml/plantuml` Docker image) | 1.2026.9, pinned by digest | B2 rendering, no network needed (C4 stdlib is bundled) |
| Graphviz | 16.1.0 locally, 2.43.0 (apt `graphviz`) on `ubuntu-24.04` in CI | `dot` for the base layout, `neato -n2` for edge routing |
| Node.js | 24 (runs `.ts` directly, no build step) | tool |
| pnpm | 10.23.0 | install |
| `yaml` | 2.8.1 | read the compose file |

**Which Structurizr export path worked.** The `structurizr/cli` image named in the original plan is now a banner-only stub:
its entrypoint prints the end-of-life notice and exits without exporting anything (exit code 0, no file written). The
current consolidated distribution, the `structurizr/structurizr` image, works:
`docker run --rm -v <dir>:/in:ro -v <out>:/out structurizr/structurizr export -workspace /in/workspace.dsl -format json -output /out`
(also `-format plantuml/c4plantuml`). Both images are `linux/amd64` and `linux/arm64`.

## Run locally

Prerequisites: Docker, Node 24, pnpm, Graphviz (`dot`, `neato`).

```bash
# B2: render every view of a model directory with the baseline pipeline
tools/render-baseline/render.sh model /tmp/b2-head

# A: export two revisions and diff them
git worktree add /tmp/base origin/main        # or any base revision
tools/export.sh /tmp/base/model /tmp/export/base json
tools/export.sh model            /tmp/export/head json
cd tools/archlens && pnpm install
node src/cli.ts diff --base /tmp/export/base/workspace.json --head /tmp/export/head/workspace.json \
     --compose ../../deploy/docker-compose.yml --out /tmp/archlens-out
# exit code 0 = R1 pass, 1 = R1 fail, 2 = input error
# writes delta.json, summary.md, comment.md, images/<view>.svg, layout/<view>.base.json
pnpm test
```

`--views a,b` restricts rendering to the given view keys. `archlens post` upserts the PR comment and publishes the check
(`GITHUB_TOKEN` or a logged-in `gh`).

## How ArchLens works

1. **Identity.** Elements are matched across revisions by the DSL identifier, which the Structurizr JSON export preserves
   as `properties["structurizr.dsl.identifier"]`. The numeric `id` fields are never used. Relationships are identified by
   `source identity | destination identity | description`; a lone removal plus a lone addition between the same pair is
   reported as a modification. Verified: the rename in change 1 is **one modified element**, not a removal plus an addition.
   Fallback if an element had no identifier: canonical name path (never needed here: 0 of 76 base and 0 of 79 head elements). Deployment nodes need an explicit identifier in the DSL, otherwise Structurizr assigns a random UUID.
2. **Diff.** Elements, relationships, deployment nodes (including instance count) and instances, per view: affected or not, and why.
   Implied relationships (`linkedRelationshipId`) are derived and only counted per view, not listed as model changes.
3. **Views.** A view is affected if its element or relationship set changed, or it contains (or is scoped to) a modified element or relationship.
4. **Layout.** For each affected view only: `dot` lays out the **base** revision once (node sizes fixed, so no font dependence);
   those positions are persisted by element identity (`layout/<view>.base.json`) and reused for head. Nodes that
   did not exist get the nearest conflict-free grid position around their connected neighbours. `neato -n2` then routes edges
   with all nodes pinned. The tool measures how many pinned nodes moved (expected 0) and prints it in the legend.
5. **Render.** Own SVG writer: added = green, modified = amber with `was:` old values, removed = dashed ghost at its base
   position, legend in every image, no external fonts or scripts. Same inputs give byte-identical SVG (checked in CI by running twice).
6. **R1.** Every compose service must equal the DSL identifier of a model container, and every container with a container
   instance in `Production` must have a compose service. The result is the `archlens/model-diff` check (a check run in CI, so
   the full messages are in its summary; a commit status when run locally).

## Design choices

- **TypeScript, plain Node, pnpm**: the fastest path to a working demo; Node 24 runs `.ts` natively. No framework.
- **Deviation from the spec**: Graphviz `neato -n` ignores clusters (it draws no boundary boxes), so boundaries and deployment
  nodes are drawn by the tool from their members' positions, and `dot` supplies the base layout. New nodes are placed by a
  grid-search rule instead of `neato` pinning, which the spec allows as an equivalent.
- **No LLM anywhere**, no secrets beyond `GITHUB_TOKEN`.
- **Images** live on the `poc-artifacts` branch under paths containing the commit SHA and are referenced by raw URL.

## Known limitations

- Synthetic model; shows mechanism, not adoption.
- Layout is deterministic per Graphviz version, not across versions (local 16.1.0 and CI 2.43.0 lay out differently).
- Text widths are estimated; very long labels can overflow their box. Edge labels may overlap nodes in dense areas.
- Only Structurizr JSON input, only rule R1, compose only. No Kubernetes, Terraform, LikeC4.
- Nodes are fixed-size and positions are only stable while the base layout is the reference; a view whose base layout
  is already tangled stays tangled.
- The diff does not detect a node moved to a different parent, only that its `parent` field changed.

## CodeRabbit (B3, optional)

Not installed by the agent (and no `@coderabbitai` comment was posted, because without the app it would just be a stray comment).
To add it: install the CodeRabbit GitHub App on the `leitsyshyn` account (GitHub Marketplace, search "CodeRabbit"; the usual
install page is <https://github.com/apps/coderabbitai>, which the pricing pages do not link, so verify it) and grant it the
repository `archlens-poc` only. Then comment `@coderabbitai review` on the PR, and `@coderabbitai generate sequence diagram`
if no diagram appears. Repos with fewer than 10 stars need the review triggered by hand.

Free for public repositories: <https://www.coderabbit.ai/pricing> says "install CodeRabbit on a public repository, and receive
free reviews forever for public repositories", and <https://docs.coderabbit.ai/management/plans> says "Unlimited public
repositories, no credit card required" with rate limits that vary by stars (see <https://docs.coderabbit.ai/management/rate-limits>).
Files to leave untouched for the comparison: its comment on the PR.

## Source and attribution

The ShopFlow model was written for this POC; it is not derived from the Structurizr "Big Bank plc" example or any
other third-party workspace.
