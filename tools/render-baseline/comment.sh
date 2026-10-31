#!/usr/bin/env bash
# Builds the B2 comment body: every view, base image above head image. Not filtered.
# Usage: comment.sh <base render dir> <head render dir> <raw url prefix for base> <raw url prefix for head> <base sha> <head sha>
set -euo pipefail
BASE_DIR="$1"; HEAD_DIR="$2"; BASE_URL="$3"; HEAD_URL="$4"; BSHA="${5:0:7}"; HSHA="${6:0:7}"
echo "<!-- archlens-baseline-render-comment -->"
echo "## Baseline: rendered diagrams (before / after)"
echo
echo "Plain render job: Structurizr export to C4-PlantUML, PlantUML default auto-layout, every view rendered for base (\`$BSHA\`) and head (\`$HSHA\`). Nothing is filtered or highlighted; each image is laid out independently."
echo
VIEWS=$( (cd "$BASE_DIR" && ls *.svg 2>/dev/null; cd "$HEAD_DIR" && ls *.svg) | sort -u )
for f in $VIEWS; do
  k="${f%.svg}"
  echo "### \`$k\`"; echo
  echo "**Before** (base \`$BSHA\`)"; echo
  if [ -f "$BASE_DIR/$f" ]; then echo "<img src=\"$BASE_URL/$f\" alt=\"base $k\" width=\"100%\">"; else echo "_view does not exist in base_"; fi
  echo; echo "**After** (head \`$HSHA\`)"; echo
  if [ -f "$HEAD_DIR/$f" ]; then echo "<img src=\"$HEAD_URL/$f\" alt=\"head $k\" width=\"100%\">"; else echo "_view does not exist in head_"; fi
  echo
done
