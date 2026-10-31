#!/usr/bin/env bash
# B2 baseline: what a team can set up in under an hour. Export every view to C4-PlantUML with Structurizr,
# render with PlantUML, default auto-layout, no tuning. No filtering to affected views.
# Usage: tools/render-baseline/render.sh <model dir> <out dir>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PLANTUML_IMAGE="${PLANTUML_IMAGE:-plantuml/plantuml@sha256:9b5071ab56a4192aac458ab4b0d42261c22c8109695894ae5be6013c3be6cac1}"
OUT="$2"; mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
"$HERE/../export.sh" "$1" "$OUT" plantuml/c4plantuml
docker run --rm --user "$(id -u):$(id -g)" -v "$OUT":/data "$PLANTUML_IMAGE" -tsvg /data >/dev/null
for f in "$OUT"/structurizr-*.svg; do mv "$f" "$OUT/$(basename "$f" | sed -e 's/^structurizr-//')"; done
rm -f "$OUT"/structurizr-*.puml "$OUT"/workspace.json
ls "$OUT"
