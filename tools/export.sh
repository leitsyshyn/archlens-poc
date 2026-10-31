#!/usr/bin/env bash
# Usage: tools/export.sh <dir containing workspace.dsl> <out dir> [json|plantuml/c4plantuml]
# Runs the current consolidated Structurizr distribution (structurizr/structurizr, 6.2.4) through Docker.
# The old structurizr/cli image is a banner-only stub now and does not export anything.
set -euo pipefail
DIR="$(cd "$1" && pwd)"; OUT="$2"; FORMAT="${3:-json}"
IMAGE="${STRUCTURIZR_IMAGE:-structurizr/structurizr@sha256:8aebde645a7cc8d3b9e1e774cd6d75a84ce45d74ae70eb783876182fe7db31a2}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
LOG="$(mktemp)"
if ! docker run --rm --user "$(id -u):$(id -g)" -v "$DIR":/in:ro -v "$OUT":/out "$IMAGE" \
     export -workspace /in/workspace.dsl -format "$FORMAT" -output /out >"$LOG" 2>&1; then
  grep -vE '^\s+at ' "$LOG" >&2 || true; rm -f "$LOG"; echo "structurizr export failed" >&2; exit 1
fi
rm -f "$LOG"
case "$FORMAT" in json) test -s "$OUT/workspace.json" || { echo "no workspace.json produced" >&2; exit 1; } ;; esac
