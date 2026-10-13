#!/bin/sh
set -eu

file=${1:?index.html path required}
expected=c64ed78df604b162534d5ab50c157ed0bd87510ae2c6adf0134cf29fc72c749a
actual=$(sha256sum "$file" | cut -d ' ' -f 1)
if [ "$actual" != "$expected" ]; then
  echo 'Refusing to change an unexpected FRA index.html' >&2
  exit 1
fi

sed -i 's@/css/pride-panels.css?v=20260925-1@/css/pride-panels.css?v=20260929-1@' "$file"
sed -i '/^<div class="pride-background" aria-hidden="true">/c\<div id="glass-background" aria-hidden="true"><div class="glow glow-1"></div><div class="glow glow-2"></div><div class="glow glow-3"></div><div class="bars-layer"></div></div>' "$file"

grep -Fq '/css/pride-panels.css?v=20260929-1' "$file"
grep -Fq '<div id="glass-background" aria-hidden="true">' "$file"
if grep -Fq 'class="pride-background"' "$file"; then
  echo 'Old background remained in index.html' >&2
  exit 1
fi
