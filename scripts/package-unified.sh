#!/usr/bin/env bash
# Reuse the dependency tree from the trusted release's generateImage-with-deps.zip.
set -euo pipefail
if [[ $# != 2 ]]; then
  echo "usage: bash scripts/package-unified.sh <release-image-zip> <new-output-zip>" >&2
  exit 2
fi
root=$(cd "$(dirname "$0")/.." && pwd)
output=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
[[ ! -e "$output" ]] || { echo "output already exists" >&2; exit 1; }
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
unzip -q "$1" 'node_modules/*' -d "$stage"
cp "$root/cloudfunctions/unified-entry.cjs" "$stage/index.js"
for handler in aiProxy generateImage; do
  mkdir "$stage/$handler"
  cp "$root/cloudfunctions/$handler/index.js" "$stage/$handler/"
done
cd "$stage"
node - "$root/cloudfunctions/generateImage/package.json" <<'NODE'
const fs = require("node:fs");
const { dependencies, overrides } = require(process.argv[2]);
for (const [pkg, v] of Object.entries({ ...dependencies, ...overrides })) {
  if (require(pkg + "/package.json").version !== v) throw new Error("Unexpected version of " + pkg);
}
fs.writeFileSync("package.json", JSON.stringify({ name: "cloudbase-unified-aiproxy", private: true, main: "index.js", dependencies, overrides }, null, 2));
NODE
zip -qr "$output" index.js package.json aiProxy generateImage node_modules
