#!/usr/bin/env bash
# Fills in the NAS .env (runbook step 5), from the owner's Mac.
#   1. asks for the Cloudflare tunnel token and, optionally, new Spotify / PIN / API values
#      (hidden input; leave one empty to keep what the NAS already has),
#   2. on the NAS, carries over the values from the old single-container setup
#      (/volume1/docker/tesla-lyrics/.env) into keys that are still empty,
#   3. generates COOKIE_SECRET and sets REDIRECT_URI, but only where they are still empty,
#   4. logs in over SSH (asks for the NAS password) and updates the file in place, mode 600.
# Values travel over SSH stdin: they are never written on the Mac or put on a command line.
#
# Run: npm run deploy:nas-env   (or deploy/nas-env.sh)
# Override the defaults with NAS_HOST, NAS_PORT, NAS_USER, NAS_DIR, OLD_ENV, SITE_URL.
set -euo pipefail

NAS_HOST="${NAS_HOST:-192.168.1.222}"
NAS_PORT="${NAS_PORT:-25}"
NAS_USER="${NAS_USER:-MortenMonsted}"
NAS_DIR="${NAS_DIR:-/volume1/docker/tesla-lyrics/compose}"
OLD_ENV="${OLD_ENV:-/volume1/docker/tesla-lyrics/.env}"
SITE_URL="${SITE_URL:-https://lyrics.monsted.org}"

# Keys copied from the old .env when the new one has them empty. Not REDIRECT_URI (it pointed
# at http://ds.monsted.org:5011) and not COOKIE_SECRET (it may still be the built-in default).
CARRY_OVER='SPOTIFY_CLIENT_ID|SPOTIFY_CLIENT_SECRET|PIN_CODE|GENIUS_ACCESS_TOKEN|BRAVE_SEARCH_API_KEY|GITHUB_TOKEN|GITHUB_MODELS_MODEL|TESSIE_API_TOKEN|TESSIE_VIN'

ask() {
  local value
  read -r -s -p "$1 (empty = keep): " value
  echo >&2
  printf '%s' "$value"
}

echo "Leave everything but the tunnel token empty to keep the old setup's values."
tunnel_token="$(ask CLOUDFLARE_TUNNEL_TOKEN)"
spotify_id="$(ask SPOTIFY_CLIENT_ID)"
spotify_secret="$(ask SPOTIFY_CLIENT_SECRET)"
pin_code="$(ask PIN_CODE)"

# One KEY=value per line. A leading "?" means: only fill in if the NAS value is empty.
# The first line for a key wins, so typed values beat carried-over ones beat generated ones.
values() {
  [[ -n "$tunnel_token" ]] && echo "CLOUDFLARE_TUNNEL_TOKEN=$tunnel_token"
  [[ -n "$spotify_id" ]] && echo "SPOTIFY_CLIENT_ID=$spotify_id"
  [[ -n "$spotify_secret" ]] && echo "SPOTIFY_CLIENT_SECRET=$spotify_secret"
  [[ -n "$pin_code" ]] && echo "PIN_CODE=$pin_code"
  echo "?REDIRECT_URI=$SITE_URL/callback"
  echo "?COOKIE_SECRET=$(openssl rand -hex 32)"
}

remote=$(
  cat <<EOF
set -e
cd '$NAS_DIR'
[ -f .env ] || { echo "No .env in $NAS_DIR (runbook step 4)" >&2; exit 1; }
umask 077
in=\$(mktemp) out=\$(mktemp)
trap 'rm -f "\$in" "\$out"' EXIT
cat > "\$in"
if [ -r '$OLD_ENV' ]; then
  grep -E '^($CARRY_OVER)=.' '$OLD_ENV' | sed 's/^/?/' >> "\$in" || true
  echo "Carrying over values from $OLD_ENV where still empty." >&2
elif [ -e '$OLD_ENV' ]; then
  echo "Can't read $OLD_ENV as \$(id -un); nothing carried over (see the runbook, step 5)." >&2
fi
awk '
  NR == FNR {
    i = index(\$0, "="); k = substr(\$0, 1, i - 1); soft_line = 0
    if (substr(k, 1, 1) == "?") { k = substr(k, 2); soft_line = 1 }
    if (k in v) next
    v[k] = substr(\$0, i + 1); if (soft_line) soft[k] = 1
    next
  }
  {
    i = index(\$0, "=")
    if (i > 1 && \$0 !~ /^#/) {
      k = substr(\$0, 1, i - 1); seen[k] = 1
      if ((k in v) && (!(k in soft) || substr(\$0, i + 1) == "")) { print k "=" v[k]; changed[k] = 1; next }
    }
    print
  }
  END {
    for (k in v) if (!(k in seen)) { print k "=" v[k]; changed[k] = 1 }
    for (k in changed) print "  set " k > "/dev/stderr"
  }
' "\$in" .env > "\$out"
cat "\$out" > .env
chmod 600 .env
empty=\$(grep -E '^[A-Z_]+=\$' .env || true)
if [ -n "\$empty" ]; then echo "Still empty (fine for the optional ones):"; echo "\$empty" | sed 's/^/  /'; else echo "All values are set."; fi
EOF
)

echo "Updating $NAS_DIR/.env on $NAS_HOST"
values | ssh -p "$NAS_PORT" "$NAS_USER@$NAS_HOST" "$remote"
