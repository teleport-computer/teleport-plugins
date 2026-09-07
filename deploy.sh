#!/usr/bin/env bash
# deploy.sh — THE redeploy recipe for oauth3 on a tee-daemon node (issue #16).
#
# This codifies what used to live only in a memory note, after two outages caused by hand-built
# manifests:
#   2026-08-10 — a partial manifest dropped the live `env` block (SEAL_KEY/OWNER_SECRET gone)
#                → fail-fast 500 on every route for two days.
#   2026-08-12 — a worker-supplied SEAL_KEY mismatched the sealed vault → 500s again.
# The fix in both cases: never author the manifest from scratch. READ the live manifest first,
# carry every field (especially the whole `env`) forward byte-for-byte, and change ONLY what a
# redeploy must change (tarball, ref, GIT_SHA) plus the pinned verified fields below. Secret
# values are never named, never printed.
#
# Verified manifest (pinned by this script, per the recipe):
#   isolation: container      own container (deno --deny-env posture)
#   oci_runtime: runc         explicit OCI runtime (same as the other container projects)
#   listen: {port: 8080}      PATH-based routing on the default ingress (/oauth3/...).
#                             listen.port != 8080 claims a dedicated host port and the daemon
#                             hard-fails the deploy if another project holds it — the
#                             "port-3000 conflict". The app still serves on 3000 in-container;
#                             the daemon routes containers by (container-ip, 3000), independent
#                             of listen.port.
#   env_passthrough           preserved verbatim from live (OWNER_SECRET, SEAL_KEY, the OAUTH3_*
#                             aliases, BROWSER_SPI_*); the daemon injects these from its own env.
#   env                       preserved verbatim from live (POLL_INTERVAL_MIN, PUBLIC_URL,
#                             DATA_DIR, BROWSER_SPI_*, ...) + GIT_SHA of the deployed ref.
#
# Usage:
#   bash deploy.sh <node-url> [git-ref]
#     node-url  REQUIRED — base URL of the tee-daemon (its default :8080 ingress), e.g.
#               https://<app-id>-8080.dstack-....phala.network. There is NO default node: this
#               script refuses to run without one so it can never silently target prod.
#     git-ref   optional — git ref to deploy (default: HEAD). Must exist in this repo.
#
# Token: TEE_DAEMON_TOKEN in the environment, else read from ~/.tee-daemon-staging.env.
#
# Exits 0 only after the post-deploy manifest is read back and verified: isolation/listen/
# env_passthrough intact, env keys identical (GIT_SHA value aside), and /oauth3/api/health 200.
set -euo pipefail

NODE="${1:-}"
usage() { echo "usage: bash deploy.sh <node-url> [git-ref]   (node-url is REQUIRED, e.g. https://<id>-8080.dstack-….network)" >&2; }
case "$NODE" in
  -h|--help) usage; exit 0 ;;
esac

# ── node is a required argument; no hardcoded prod node ──────────────────────────────────────
if [ -z "$NODE" ]; then
  echo "ERROR: node-url is required (there is no default node — refusing to guess)." >&2
  usage; exit 2
fi
if ! [[ "$NODE" =~ ^https?:// ]]; then
  echo "ERROR: node-url must start with http(s):// — got: $NODE" >&2
  usage; exit 2
fi
while [[ "$NODE" == */ ]]; do NODE="${NODE%/}"; done

REF="${2:-HEAD}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$REPO/server/handler.ts" ] || { echo "ERROR: $REPO is not the oauth3-server repo root (server/handler.ts missing)" >&2; exit 2; }

DENO="$(command -v deno || true)"
[ -z "$DENO" ] && [ -x "$HOME/.deno/bin/deno" ] && DENO="$HOME/.deno/bin/deno"
[ -n "$DENO" ] || { echo "ERROR: deno not found on PATH or in ~/.deno/bin" >&2; exit 2; }

# ── daemon token (env, else the standard box location) ───────────────────────────────────────
if [ -z "${TEE_DAEMON_TOKEN:-}" ] && [ -f "$HOME/.tee-daemon-staging.env" ]; then
  TEE_DAEMON_TOKEN="$(bash -c 'set -a; . "$1" >/dev/null 2>&1; echo "${TEE_DAEMON_TOKEN:-}"' _ "$HOME/.tee-daemon-staging.env")"
fi
[ -n "${TEE_DAEMON_TOKEN:-}" ] || { echo "ERROR: no TEE_DAEMON_TOKEN (set it, or provide ~/.tee-daemon-staging.env)" >&2; exit 2; }
AUTH="Authorization: Bearer $TEE_DAEMON_TOKEN"

D="$(mktemp -d)"
trap 'rm -rf "$D"' EXIT

# ── 1. read the LIVE manifest first — this is the whole safety model ─────────────────────────
# Shared reader. Primary: the projects list (GET /_api/projects). Fallback: the single-project
# read (GET /_api/projects/oauth3 — the same API `cli verify` uses). The fallback exists because
# the gateway in front of the daemon has been observed serving the POST's own response body to a
# GET of the bare /_api/projects URL for a minute or so after a deploy (single-dict echo); the
# single-project URL is not affected.
cat > "$D/read_oauth3.py" <<'PY'
import json, sys
raw = open(sys.argv[1]).read()
try:
    data = json.loads(raw)
except Exception as e:
    sys.exit(f"ERROR: {sys.argv[1]} is not JSON ({e}): {raw[:200]!r}")
if isinstance(data, dict) and data.get("name") == "oauth3":
    m = data  # single-project form (or the gateway's POST-echo) — already the oauth3 manifest
else:
    if isinstance(data, dict):
        data = data.get("projects", [])
    m = next((q for q in data if isinstance(q, dict) and q.get("name") == "oauth3"), None)
    if m is None:
        if isinstance(data, list):
            detail = f"{len(data)} projects, none named 'oauth3'"
        else:
            detail = f"type={type(data).__name__}"
        sys.exit(f"ERROR: oauth3 not found in {sys.argv[1]} ({detail}) — raw head: {raw[:200]!r}")
json.dump(m, open(sys.argv[2], "w"), indent=1, sort_keys=True)
PY

read_manifest() { # read_manifest <out.json> — list URL first, single-project fallback
  if curl -sf --max-time 30 "$NODE/_api/projects" -H "$AUTH" > "$D/list.json" \
     && python3 "$D/read_oauth3.py" "$D/list.json" "$1"; then
    return 0
  fi
  echo "    (list read unavailable — falling back to GET $NODE/_api/projects/oauth3)" >&2
  curl -sf --max-time 30 "$NODE/_api/projects/oauth3" -H "$AUTH" > "$D/one.json" \
    && python3 "$D/read_oauth3.py" "$D/one.json" "$1"
}

echo "==> pre-read: GET $NODE/_api/projects (oauth3)"
read_manifest "$D/pre.json" || {
  echo "ERROR: cannot read the live oauth3 manifest (bad node-url or token?)" >&2; exit 1; }

echo "==> manifest-preserve (live fields carried forward untouched)"
python3 - "$D/pre.json" <<'PY' || exit 1
import json, sys
pre = json.load(open(sys.argv[1]))
env = pre.get("env") or {}
print("    env keys (values never printed): " + ", ".join(sorted(env)))
print("    env_passthrough: " + ", ".join(pre.get("env_passthrough") or []))
PY

python3 - "$D/pre.json" <<'PY' || exit 1
import json, sys
pre = json.load(open(sys.argv[1]))
env = pre.get("env") or {}
# Refuse rather than ship a core that cannot open its own vault. A missing secret here means the
# live manifest is already damaged; deploying over it would destroy the only copy (2026-08-10).
for secret, aliases in (("SEAL_KEY", ("SEAL_KEY", "OAUTH3_SEAL_KEY")),
                        ("OWNER_SECRET", ("OWNER_SECRET", "OAUTH3_OWNER_SECRET"))):
    if not any(env.get(a) for a in aliases):
        sys.exit(f"ERROR: live manifest has no {secret} — refusing to deploy (restore the live manifest first)")
# The verified recipe's non-secret env fields must exist live; a missing one means drift/damage.
for req in ("POLL_INTERVAL_MIN", "PUBLIC_URL"):
    if not env.get(req):
        sys.exit(f"ERROR: live manifest env lacks {req} — refusing to deploy (restore it first)")
PY

# ── 2. build the tarball from a committed git ref (flat layout: handler.ts at the ROOT) ───────
SHA="$(git -C "$REPO" rev-parse --short "$REF")" || { echo "ERROR: git ref not found: $REF" >&2; exit 2; }
echo "==> build $REF ($SHA)"
git -C "$REPO" archive "$REF" | tar -x -C "$D"
[ -f "$D/server/handler.ts" ] || { echo "ERROR: server/handler.ts missing in $REF — abort" >&2; exit 1; }
"$DENO" check "$D/server/main.ts" >/dev/null || { echo "ERROR: deno check FAILED for $REF — abort" >&2; exit 1; }
echo "deploy $(date -u +%FT%TZ) $REF $SHA" > "$D/server/DEPLOY_STAMP"
tar czf "$D/oauth3.tgz" -C "$D/server" .
# List into a variable first: under `set -o pipefail`, `tar tzf … | grep -q` makes grep exit on the
# first match, tar takes SIGPIPE, and the PIPELINE reports failure — on success.
LISTING="$(tar tzf "$D/oauth3.tgz")"
# Flat layout: handler.ts at the tarball ROOT (tar writes root entries as "./handler.ts" with -C
# dir .). A nested server/handler.ts is what the 2026-08-12 worker shipped — the entry never
# resolved under entry="handler.ts" — so trip on that explicitly.
grep -qE '^\./?handler\.ts$' <<<"$LISTING" || { echo "ERROR: tarball is not flat (handler.ts not at root) — abort" >&2; exit 1; }
! grep -qE '(^|/)server/handler\.ts$' <<<"$LISTING" || { echo "ERROR: tarball is nested (server/handler.ts) — abort" >&2; exit 1; }

# ── 3. compose the manifest: live fields + verified pins + deploy identity ────────────────────
SHA="$SHA" REF="$REF" python3 - "$D/pre.json" "$D/manifest.json" <<'PY' || exit 1
import json, os, sys
m = json.load(open(sys.argv[1]))
# Volatile daemon-owned fields: the daemon rewrites these on deploy; never echo stale ones back.
for k in ("container_id", "image_digest", "deployed_at", "commit_sha", "tree_hash"):
    m.pop(k, None)
# The verified recipe (see header). listen.port=8080 = path-based routing, no dedicated host port.
m["isolation"] = "container"
m["oci_runtime"] = "runc"
m["listen"] = {"port": 8080, "protocol": "http"}
m["entry"] = "handler.ts"          # flat layout, matches the tarball we just built
m["ref"] = os.environ["REF"]
env = dict(m.get("env") or {})
env["GIT_SHA"] = os.environ["SHA"]
m["env"] = env
if not m.get("env_passthrough"):
    sys.exit("ERROR: live env_passthrough is empty — refusing to deploy (would drop secret injection)")
json.dump(m, open(sys.argv[2], "w"), indent=1, sort_keys=True)
print(f"    verified pins: isolation=container oci_runtime=runc listen.port=8080 entry=handler.ts ref={m['ref']}")
PY

# ── 4. POST ──────────────────────────────────────────────────────────────────────────────────
echo "==> POST $NODE/_api/projects"
CODE="$(curl -s -o "$D/post.resp" -w '%{http_code}' --max-time 120 -X POST "$NODE/_api/projects" \
  -H "$AUTH" \
  -F "manifest=@$D/manifest.json;type=application/json" \
  -F "files=@$D/oauth3.tgz;type=application/gzip")" || { echo "ERROR: POST failed (network)" >&2; exit 1; }
case "$CODE" in
  2*) echo "    accepted (HTTP $CODE)" ;;
  *)  echo "ERROR: daemon rejected the deploy (HTTP $CODE):" >&2; cat "$D/post.resp" >&2; exit 1 ;;
esac

# ── 5. health gate ───────────────────────────────────────────────────────────────────────────
echo "==> health gate: GET $NODE/oauth3/api/health"
H=""
for i in $(seq 1 24); do
  sleep 5
  H="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$NODE/oauth3/api/health" || true)"
  echo "    t+$((i*5))s health=$H"
  [ "$H" = "200" ] && break
done
[ "$H" = "200" ] || { echo "ERROR: DEPLOY FAILED — /oauth3/api/health is $H, not 200; do NOT collect evidence against it" >&2; exit 1; }
echo "    body: $(curl -sf -m 15 "$NODE/oauth3/api/health")"
echo "    version: $(curl -sf -m 15 "$NODE/oauth3/_api/version")"

# ── 6. read the manifest back and VERIFY the preserve contract ───────────────────────────────
echo "==> post-read + verify"
# Right after a redeploy the daemon's store can briefly answer without the project, and the bare
# /_api/projects URL may still echo the POST body (see the reader note in section 1). Retry the
# read rather than report a false failure.
POST_OK=""
for i in $(seq 1 6); do
  if read_manifest "$D/post.json"; then POST_OK=yes; break; fi
  echo "    (store settling — retry $i/6)"
  sleep 3
done
[ -n "$POST_OK" ] || { echo "ERROR: post-read failed — could not read the oauth3 manifest back after deploy" >&2; exit 1; }
python3 - "$D/pre.json" "$D/post.json" "$SHA" <<'PY' || exit 1
import json, re, sys

def load_oauth3(path):
    return json.load(open(path))

def mask(k, v):
    return f"<masked {len(str(v))} chars>" if re.search(r"SECRET|KEY|TOKEN|PASSWORD", k, re.I) else v

def masked(p):
    d = {k: mask(k, v) for k, v in p.items() if k != "env"}
    d["env"] = {k: mask(k, v) for k, v in (p.get("env") or {}).items()}
    return d

pre, post, sha = load_oauth3(sys.argv[1]), load_oauth3(sys.argv[2]), sys.argv[3]
fail = []

# Acceptance: post-deploy carries the verified fields.
if post.get("isolation") != "container":
    fail.append(f"isolation={post.get('isolation')!r}, expected 'container'")
if (post.get("listen") or {}).get("port") != 8080:
    fail.append(f"listen={post.get('listen')!r}, expected port 8080")
# Acceptance: the full env_passthrough list survives verbatim.
if post.get("env_passthrough") != pre.get("env_passthrough"):
    fail.append(f"env_passthrough changed: {pre.get('env_passthrough')} -> {post.get('env_passthrough')}")
# Acceptance: env keys identical, values identical except GIT_SHA (the deployed commit).
pre_env, post_env = pre.get("env") or {}, post.get("env") or {}
for k, v in pre_env.items():
    if k == "GIT_SHA":
        continue
    if post_env.get(k) != v:
        fail.append(f"env.{k} did not survive the deploy")
for k in post_env:
    if k not in pre_env:
        fail.append(f"env.{k} appeared from nowhere")
if post_env.get("GIT_SHA") != sha:
    fail.append(f"env.GIT_SHA={post_env.get('GIT_SHA')!r}, expected {sha!r}")

# Diff discipline: only deploy-identity fields + the verified pins may differ.
ALLOWED = {"container_id", "image_digest", "deployed_at", "commit_sha", "tree_hash",
           "ref", "listen", "oci_runtime", "isolation", "entry", "env"}
ENV_ALLOWED = {"GIT_SHA"}
changed = {k for k in set(pre) | set(post)
           if k != "env" and json.dumps(pre.get(k), sort_keys=True) != json.dumps(post.get(k), sort_keys=True)}
changed |= {f"env.{k}" for k in set(pre_env) | set(post_env) if pre_env.get(k) != post_env.get(k)}
unexpected = changed - ALLOWED - {f"env.{k}" for k in ENV_ALLOWED}
if unexpected:
    fail.append(f"unexpected field changes: {sorted(unexpected)}")

print("    --- pre  (secrets masked) ---");  print(json.dumps(masked(pre),  indent=1, sort_keys=True))
print("    --- post (secrets masked) ---");  print(json.dumps(masked(post), indent=1, sort_keys=True))
print(f"    changed fields: {sorted(changed)}")
if fail:
    print("VERIFY FAILED:", file=sys.stderr)
    for f in fail:
        print(f"    - {f}", file=sys.stderr)
    sys.exit(1)
print("    VERIFIED: isolation=container, listen.port=8080, env_passthrough intact, env keys intact")
PY

echo "== $REF ($SHA) deployed and verified on $NODE =="
