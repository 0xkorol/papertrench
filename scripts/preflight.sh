#!/usr/bin/env bash
# Release preflight: everything that used to be a manual checklist item that
# someone (always) forgets. Run from the repo root:  bash scripts/preflight.sh
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "PREFLIGHT FAIL: $*" >&2; exit 1; }

MANIFEST_V=$(grep -oP '"version":\s*"\K[0-9.]+' extension/manifest.json | head -1)
PACKAGE_V=$(grep -oP '"version":\s*"\K[0-9.]+' extension/package.json | head -1)

echo "manifest: $MANIFEST_V  package: $PACKAGE_V"
[ "$MANIFEST_V" = "$PACKAGE_V" ] || fail "manifest.json ($MANIFEST_V) != package.json ($PACKAGE_V)"

grep -q "## v$MANIFEST_V" CHANGELOG.md || fail "CHANGELOG.md has no entry for v$MANIFEST_V"
# Download CTAs must point at /releases/latest and never pin a versioned zip,
# which 404s until the release asset exists (policy since f23df6c).
grep -q 'github.com/OnlyTerp/papertrench/releases/latest' site/index.html \
  || fail "site/index.html has no /releases/latest download link"
if grep -Eq 'papertrench-[0-9]+\.[0-9]+\.[0-9]+\.zip' site/index.html; then
  fail "site/index.html contains a version-pinned papertrench-X.Y.Z.zip URL (must use /releases/latest)"
fi

# The manifest must never regress to <all_urls> content scripts (DEFECT O-09).
if grep -q '"<all_urls>"' extension/manifest.json; then
  # host_permissions may legitimately stay broad (user-configured AI/RPC
  # endpoints are fetched by the service worker) — content_scripts must not.
  python3 - <<'PY' || exit 1
import json, sys
m = json.load(open('extension/manifest.json'))
for cs in m.get('content_scripts', []):
    if '<all_urls>' in cs.get('matches', []):
        sys.exit('PREFLIGHT FAIL: content_scripts matches <all_urls> — see DEFECTS.md O-09')
for war in m.get('web_accessible_resources', []):
    if '<all_urls>' in war.get('matches', []):
        sys.exit('PREFLIGHT FAIL: web_accessible_resources matches <all_urls>')
print('manifest scope OK (host_permissions broad by design, content scripts narrow)')
PY
fi

echo "Running test suite..."
(cd extension && node --test > /tmp/pt-preflight-tests.log 2>&1) \
  || { tail -30 /tmp/pt-preflight-tests.log; fail "test suite not green"; }
tail -8 /tmp/pt-preflight-tests.log | grep -E "pass|fail"

echo
echo "PREFLIGHT OK for v$MANIFEST_V"
echo "Remaining manual steps:"
echo "  1. docs/QA-MATRIX.md pass on the built zip (content/bridge changes only)"
echo "  2. git tag v$MANIFEST_V && git push origin main --tags  (CI builds + releases)"
echo "  3. Verify the release asset hash against SHA256SUMS.txt"
