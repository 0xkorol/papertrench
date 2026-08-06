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

# Every page's nav must reach every destination.
#
# This drifted twice. The Arena shipped five pages and fifteen others kept a
# nav that predated them — first pointing "Leaderboard" at the marketing
# anchor instead of the board, then reaching the board but not Sprint or
# Duels. Both times the site advertised features two thirds of it could not
# navigate to, and both times it was caught by a person rather than a check.
# Same failure mode as the version-pinned download link above: a rule that
# lives only in someone's memory.
NAV_DESTS="leaderboard.html sprint.html duels.html clans.html"
NAV_MISSING=""
for page in site/*.html; do
  # Article pages and the Arena family all carry the same nav block.
  grep -q 'class="nav-links"' "$page" || continue
  # Match inside <nav>…</nav> ONLY. Grepping the whole file passed vacuously on
  # every page that links these destinations from body copy — which is all six
  # Arena pages, since they cross-link each other (duel.html alone has seven
  # body links to duels.html). A page could lose two nav entries and still
  # report OK. The 15 legacy pages happened to be protected because they carry
  # no such body links, which is also why a mutation test against news.html
  # could not tell the two implementations apart.
  nav=$(sed -n '/<nav>/,/<\/nav>/p' "$page")
  for dest in $NAV_DESTS; do
    printf '%s' "$nav" | grep -q "href=\"$dest\"" \
      || NAV_MISSING="$NAV_MISSING $(basename "$page"):$dest"
  done
done
[ -z "$NAV_MISSING" ] || fail "nav is missing destinations —$NAV_MISSING"
echo "nav OK ($(grep -lc 'class="nav-links"' site/*.html | wc -l) pages reach $NAV_DESTS)"

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

# The server suite is NOT in CI (.github/workflows/test.yml runs the extension
# suite only), so this is the only gate on it before a release.
echo "Running server suite..."
(cd server && node --test > /tmp/pt-preflight-server.log 2>&1) \
  || { tail -30 /tmp/pt-preflight-server.log; fail "server suite not green"; }
tail -8 /tmp/pt-preflight-server.log | grep -E "pass|fail"

# The news hero prints "TESTS PASSING" and "AUDITED DEFECTS CLOSED" as
# hand-typed numbers, on a page whose next stat reads "0 NUMBERS INVENTED".
# They sat at 872/116 while the real figures moved to 1212/131. Nobody noticed
# because nothing checked — the same failure mode as the nav and the download
# link above. Gate on the parsed FAIL COUNT, never on a pipeline exit code:
# `node --test | grep` exits 0 even at 1105/1108.
EXT_PASS=$(grep -E '^ℹ pass ' /tmp/pt-preflight-tests.log | awk '{print $3}')
EXT_FAIL=$(grep -E '^ℹ fail ' /tmp/pt-preflight-tests.log | awk '{print $3}')
SRV_PASS=$(grep -E '^ℹ pass ' /tmp/pt-preflight-server.log | awk '{print $3}')
SRV_FAIL=$(grep -E '^ℹ fail ' /tmp/pt-preflight-server.log | awk '{print $3}')
[ -n "$EXT_PASS" ] && [ -n "$SRV_PASS" ] || fail "could not parse suite totals"
[ "$EXT_FAIL" = "0" ] && [ "$SRV_FAIL" = "0" ] \
  || fail "suite fail count non-zero (extension $EXT_FAIL, server $SRV_FAIL)"
TESTS_REAL=$((EXT_PASS + SRV_PASS))
for page in site/news.html site/index.html; do
  shown=$(grep -oP 'data-check="tests">\K[0-9]+' "$page")
  [ "$shown" = "$TESTS_REAL" ] \
    || fail "$page says $shown tests passing; the suites report $TESTS_REAL ($EXT_PASS + $SRV_PASS)"
done

# The homepage's "TRADING SITES" figure must never exceed what the build
# actually supports — over-claiming advertises a capability the user does not
# have. Under-claiming is tolerated on purpose: between a commit and its tag,
# the manifest legitimately runs ahead of what anyone can install.
SITES_REAL=$(python3 - <<'PY'
import json
m = json.load(open('extension/manifest.json'))
hosts = set()
for cs in m.get('content_scripts', []):
    for pat in cs.get('matches', []):
        h = pat.split('://')[-1].split('/')[0].replace('*.', '')
        if h != '*':
            hosts.add(h)
print(len(hosts - {'x.com', 'twitter.com'}))
PY
)
SITES_SHOWN=$(grep -oP 'data-check="sites">\K[0-9]+' site/index.html)
[ "$SITES_SHOWN" -le "$SITES_REAL" ] \
  || fail "site/index.html claims $SITES_SHOWN trading sites; the manifest supports $SITES_REAL"
[ "$SITES_SHOWN" = "$SITES_REAL" ] \
  || echo "  note: index.html says $SITES_SHOWN trading sites, manifest now has $SITES_REAL — bump it when this ships"

DEFECTS_REAL=$(grep -cE 'fixed v[0-9]' DEFECTS.md)
DEFECTS_SHOWN=$(grep -oP 'data-check="defects">\K[0-9]+' site/news.html)
[ "$DEFECTS_SHOWN" = "$DEFECTS_REAL" ] \
  || fail "site/news.html says $DEFECTS_SHOWN defects closed; DEFECTS.md marks $DEFECTS_REAL"
echo "news stats OK (tests $TESTS_REAL = $EXT_PASS + $SRV_PASS, defects closed $DEFECTS_REAL)"

echo
echo "PREFLIGHT OK for v$MANIFEST_V"
echo "Remaining manual steps:"
echo "  1. docs/QA-MATRIX.md pass on the built zip (content/bridge changes only)"
echo "  2. git tag v$MANIFEST_V && git push origin main --tags  (CI builds + releases)"
echo "  3. Verify the release asset hash against SHA256SUMS.txt"
