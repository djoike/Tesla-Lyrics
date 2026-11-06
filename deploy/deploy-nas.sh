#!/usr/bin/env bash
# Deploys the newest pushed commit to the NAS (runbook "Update"), from the owner's Mac.
# It can be started at any point after a push:
#   1. stops if this Mac has commits that aren't pushed, or if the commit is already live,
#   2. asks for the NAS password once and checks it (kept in memory only, never written down),
#   3. waits for CI on the commit to go green,
#   4. reuses a green Release of the commit, waits for one that is running, or starts one,
#   5. logs in over SSH, pulls the images and restarts the stack,
#   6. waits until https://lyrics.monsted.org reports the new version.
#
# Needs GitHub CLI logged in with write access to Actions (to start the Release).
# Run: npm run deploy:nas   (or deploy/deploy-nas.sh)
#      deploy/deploy-nas.sh --prepare   does steps 1, 3 and 4 only: no password, no NAS.
# Override the defaults with NAS_HOST, NAS_PORT, NAS_USER, NAS_DIR, SITE_URL.
set -euo pipefail

NAS_HOST="${NAS_HOST:-192.168.1.222}"
NAS_PORT="${NAS_PORT:-25}"
NAS_USER="${NAS_USER:-MortenMonsted}"
NAS_DIR="${NAS_DIR:-/volume1/docker/tesla-lyrics/compose}"
SITE_URL="${SITE_URL:-https://lyrics.monsted.org}"
PREPARE=0
[[ "${1:-}" == --prepare ]] && PREPARE=1

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() {
  echo "  $*" >&2
  exit 1
}
live_version() { curl -fsS --max-time 10 "$SITE_URL/api/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }

# 1. Which commit to deploy: the newest one on GitHub's default branch.
command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 ||
  fail "GitHub CLI isn't logged in (gh auth login); it's needed to follow CI and start the Release."
branch="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)"
# Asked through GitHub's API, so no SSH key for GitHub is needed.
remote_head() { gh api "repos/{owner}/{repo}/commits/$branch" --jq .sha; }
say "Commit to deploy"
sha="$(remote_head)"
# This Mac's HEAD must be on GitHub's branch: the same commit, or one before it.
pushed="$(gh api "repos/{owner}/{repo}/compare/$(git rev-parse HEAD)...$sha" --jq .status 2>/dev/null || echo unknown)"
[[ "$pushed" == identical || "$pushed" == ahead ]] ||
  fail "This Mac has commits that aren't on GitHub's $branch yet. Push first (git push), then run this again."
echo "  ${sha:0:7} $(gh api "repos/{owner}/{repo}/commits/$sha" --jq '.commit.message | split("\n")[0]')"
if [[ "$(live_version)" == "$sha" ]]; then
  echo "  Already live on $SITE_URL. Nothing to do."
  exit 0
fi

# 2. The password, once, checked now so a typo doesn't show up after the build.
#    SSH reads it through a throwaway askpass helper; sudo reads it from stdin.
if [[ $PREPARE == 0 ]]; then
  say "NAS password for $NAS_USER@$NAS_HOST"
  read -rs -p "Password: " NAS_PASSWORD
  echo
  export NAS_PASSWORD
  askpass="$(mktemp)"
  trap 'rm -f "$askpass"; unset NAS_PASSWORD' EXIT
  printf '#!/bin/sh\nprintf "%%s\\n" "$NAS_PASSWORD"\n' >"$askpass"
  chmod 700 "$askpass"
  nas() {
    printf '%s\n' "$NAS_PASSWORD" |
      SSH_ASKPASS="$askpass" SSH_ASKPASS_REQUIRE=force \
        ssh -p "$NAS_PORT" -o ConnectTimeout=10 "$NAS_USER@$NAS_HOST" "$@"
  }
  nas "sudo -S -p '' true" 2>/dev/null || fail "Couldn't log in to the NAS with that password."
  echo "  OK. You can leave it now; it deploys on its own when the build is ready."
fi

# Newest run of a workflow for the commit, as "id status conclusion", or nothing.
find_run() {
  gh run list --workflow "$1" --commit "$sha" --limit 1 \
    --json databaseId,status,conclusion --jq '.[0] | select(.) | "\(.databaseId) \(.status) \(.conclusion // "-")"'
}
# Waits for run $2 of workflow $1 to finish; fails unless it's green.
wait_run() {
  local name="$1" id="$2" status conclusion last=""
  while :; do
    read -r status conclusion < <(gh run view "$id" --json status,conclusion --jq '"\(.status) \(.conclusion // "-")"')
    [[ "$status" != "$last" ]] && echo "  $name: $status" && last="$status"
    [[ "$status" == completed ]] && break
    sleep 15
  done
  [[ "$conclusion" == success ]] && return
  [[ "$conclusion" == cancelled ]] && fail "$name was cancelled, probably by a newer push. Run this again to deploy that one."
  fail "$name failed ($conclusion): $(gh run view "$id" --json url --jq .url)"
}

# 3. CI must be green before an image is built: the Release moves the "latest" tag the NAS pulls.
say "CI for ${sha:0:7}"
run=""
for _ in $(seq 1 40); do # CI starts within seconds of a push; allow up to 10 minutes
  run="$(find_run CI)"
  [[ -n "$run" ]] && break
  sleep 15
done
[[ -n "$run" ]] || fail "No CI run for ${sha:0:7} showed up on GitHub."
wait_run CI "${run%% *}"

# 4. The Release: reuse a green one, wait for a running one, or start one.
say "Release for ${sha:0:7}"
run="$(find_run Release)"
read -r id status conclusion <<<"${run:-- - -}"
if [[ "$status" == completed && "$conclusion" == success ]]; then
  echo "  Already built."
elif [[ "$id" != - && "$status" != completed ]]; then
  wait_run Release "$id"
else
  [[ "$(remote_head)" == "$sha" ]] ||
    fail "Someone pushed again while this ran. Run this again to deploy the newest commit."
  gh workflow run Release --ref "$branch"
  echo "  Started."
  run=""
  for _ in $(seq 1 20); do
    run="$(find_run Release)"
    read -r id status conclusion <<<"${run:-- - -}"
    [[ "$id" != - && ("$status" != completed || "$conclusion" == success) ]] && break
    sleep 3
  done
  [[ "$id" != - ]] || fail "The Release didn't show up on GitHub."
  wait_run Release "$id"
fi

if [[ $PREPARE == 1 ]]; then
  echo
  echo "Ready: ${sha:0:7} is built. Deploy it with: npm run deploy:nas"
  exit 0
fi

# 5. Pull and restart.
say "Pulling and restarting on the NAS"
# A non-interactive SSH session on Synology lacks /usr/local/bin, where docker lives.
remote="export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin && cd '$NAS_DIR' && docker compose --profile tunnel pull && docker compose --profile tunnel up -d && sleep 15 && docker compose ps -a"
nas "sudo -S -p '' sh -c \"$remote\""

# 6. Wait for the new version to answer through the tunnel.
say "Checking $SITE_URL"
for _ in $(seq 1 20); do
  version="$(live_version)"
  if [[ "$version" == "$sha" ]]; then
    echo "  Live: ${sha:0:7}"
    exit 0
  fi
  sleep 3
done
fail "The site doesn't report ${sha:0:7} yet. Last version: ${version:-none}"
