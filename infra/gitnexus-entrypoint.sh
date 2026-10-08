#!/bin/bash
# GitNexus — Entrypoint Script
# 1. Bootstrap default repo if no indexed repos found.
# 2. Watchdog: keep the graph of every checkout in the shared /app/data/repos/
#    volume (written by the cortex-api indexer) at its current commit.
# 3. Supervise eval-server.

set -e

GITNEXUS_DIR="${HOME}/.gitnexus"
REPOS_DIR="/app/data/repos"
PORT="${PORT:-4848}"

# Cap Node.js heap to prevent OOM kills. GitNexus defaults to 8GB (HEAP_MB=8192)
# which exceeds container memory limits.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=3072}"

# eval-server keeps up to five repositories open, each with a LadybugDB buffer
# pool that GitNexus sizes at min(2 GiB, 80% of the *host's* RAM) — it never
# looks at the container limit, so on a 23 GiB host every open repo may grow to
# 2 GiB. 512 MiB still holds the largest graph we serve (365 MB on disk) whole.
# Only eval-server gets the cap: analyze sizes its own pool to the repository,
# and its bulk load fails on large ones below ~256 MiB.
SERVE_BUFFER_POOL="${GITNEXUS_SERVE_BUFFER_POOL_SIZE:-536870912}"

# eval-server 1.6.12+ refuses `--host 0.0.0.0` without a bearer token, and other
# containers can only reach us on a non-loopback bind. Honour an operator-supplied
# token; otherwise generate one and publish it on the shared /app/data volume so
# dashboard-api can read it. Persisted, so it survives restarts and stays stable
# for clients that cached it.
TOKEN_FILE="${GITNEXUS_AUTH_TOKEN_FILE:-/app/data/gitnexus-auth-token}"
if [ -n "${GITNEXUS_AUTH_TOKEN:-}" ]; then
    echo "GitNexus: Using GITNEXUS_AUTH_TOKEN from the environment."
    mkdir -p "$(dirname "$TOKEN_FILE")"
    printf '%s' "$GITNEXUS_AUTH_TOKEN" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
elif [ -s "$TOKEN_FILE" ]; then
    GITNEXUS_AUTH_TOKEN="$(cat "$TOKEN_FILE")"
    echo "GitNexus: Reusing the token at $TOKEN_FILE."
else
    GITNEXUS_AUTH_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    mkdir -p "$(dirname "$TOKEN_FILE")"
    printf '%s' "$GITNEXUS_AUTH_TOKEN" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    echo "GitNexus: Generated an eval-server token at $TOKEN_FILE."
fi
export GITNEXUS_AUTH_TOKEN

# Check if registry.json exists and has entries
has_indexed_repos() {
    if [ -f "${GITNEXUS_DIR}/registry.json" ]; then
        node -e "
            const r = require('${GITNEXUS_DIR}/registry.json');
            const repos = Array.isArray(r) ? r : (r.repos || []);
            process.exit(repos.length > 0 ? 0 : 1);
        " 2>/dev/null
        return $?
    fi
    return 1
}

# Count currently registered repos
count_registered_repos() {
    if [ -f "${GITNEXUS_DIR}/registry.json" ]; then
        node -e "
            const r = require('${GITNEXUS_DIR}/registry.json');
            const repos = Array.isArray(r) ? r : (r.repos || []);
            console.log(repos.length);
        " 2>/dev/null || echo "0"
    else
        echo "0"
    fi
}

# ── Step 1: Bootstrap default repo if needed ──
if has_indexed_repos; then
    BEFORE=$(count_registered_repos)
    echo "GitNexus: Found ${BEFORE} indexed repo(s) in registry."
else
    REPO_URL="${DEFAULT_REPO:-}"
    if [ -z "$REPO_URL" ]; then
        echo "GitNexus: No indexed repos found and DEFAULT_REPO is not set — skipping bootstrap."
        echo "GitNexus: Add repos via the Dashboard (Projects → Index Repo) or set DEFAULT_REPO env var."
    else
        echo "GitNexus: No indexed repos found. Bootstrapping default repo..."

        REPO_NAME=$(basename "$REPO_URL" .git)
        REPO_PATH="${REPOS_DIR}/${REPO_NAME}"

        mkdir -p "$REPOS_DIR"

        if [ ! -d "$REPO_PATH/.git" ]; then
            echo "GitNexus: Cloning $REPO_URL..."
            git clone --depth 1 "$REPO_URL" "$REPO_PATH" 2>&1 || {
                # Do not exec here — that would bypass the supervisor below and
                # bring back the crash loop this script exists to prevent.
                echo "GitNexus: Clone failed — continuing to the supervisor with no repos."
            }
        else
            echo "GitNexus: Repo already cloned at $REPO_PATH"
            cd "$REPO_PATH" && git pull --ff-only 2>/dev/null || true
        fi

        echo "GitNexus: Analyzing $REPO_PATH (with embeddings)..."
        cd "$REPO_PATH" && gitnexus analyze --embeddings 2>&1 || {
            echo "GitNexus: Analyze failed for default repo."
        }
    fi
fi

# ── Step 2: Watchdog — keep every checkout's graph at its HEAD ──
# cortex-api checks each project's default branch out at /app/data/repos/{projectId}
# and updates it in place, leaving .gitnexus/ behind; other branches live under the
# hidden .branches/, which the glob below does not match. A checkout is analysed
# whenever its HEAD is not the commit last analysed — incrementally, one repo at a
# time, in the background so eval-server keeps answering meanwhile.
#
# What used to go wrong here, and what stops it now:
#   - Under `set -e` one failed analyze ended the loop, and every later analysis
#     with it. The loop runs with `set +e`, inside a loop that restarts it.
#   - A failing commit was retried every 10 seconds. A failure now waits
#     ANALYZE_RETRY_BASE seconds, doubling per attempt up to ANALYZE_RETRY_MAX;
#     a new commit is tried at once.
#   - An analyze that ran the container out of memory could take eval-server down
#     with it. analyze runs with the highest OOM score, so the kernel picks it.
# Embeddings stay off: --embeddings corrupted the LadybugDB WAL on large repos
# (C# repos >10K symbols). Enable them per repo by hand if needed:
#   docker exec cortex-gitnexus bash -c 'cd /app/data/repos/<id> && gitnexus analyze --embeddings'
WATCH_STATE_DIR="${GITNEXUS_DIR}/cortex-watchdog"
ANALYZE_RETRY_BASE="${GITNEXUS_ANALYZE_RETRY_BASE:-300}"
ANALYZE_RETRY_MAX="${GITNEXUS_ANALYZE_RETRY_MAX:-21600}"
ANALYZE_TIMEOUT="${GITNEXUS_ANALYZE_TIMEOUT:-3600}"

# Seconds to wait before retrying a commit that failed $1 times.
retry_delay() {
    local delay=$ANALYZE_RETRY_BASE attempt=1
    while [ "$attempt" -lt "$1" ] && [ "$delay" -lt "$ANALYZE_RETRY_MAX" ]; do
        delay=$((delay * 2))
        attempt=$((attempt + 1))
    done
    [ "$delay" -gt "$ANALYZE_RETRY_MAX" ] && delay=$ANALYZE_RETRY_MAX
    echo "$delay"
}

analyze_if_stale() {
    local repo_dir="${1%/}" repo_name head failed_file failed_head failures failed_at delay
    repo_name=$(basename "$repo_dir")
    [ -d "$repo_dir/.git" ] || return 0
    # cortex-api is changing this checkout right now.
    [ -f "${REPOS_DIR}/${repo_name}.cloning" ] && return 0

    head=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null) || return 0
    if [ -d "$repo_dir/.gitnexus" ] && [ "$(cat "${WATCH_STATE_DIR}/${repo_name}.analyzed" 2>/dev/null)" = "$head" ]; then
        return 0
    fi

    failed_file="${WATCH_STATE_DIR}/${repo_name}.failed"
    failures=0
    if [ -f "$failed_file" ]; then
        read -r failed_head failures failed_at < "$failed_file"
        case "$failures" in ''|*[!0-9]*) failures=1 ;; esac
        case "$failed_at" in ''|*[!0-9]*) failed_at=0 ;; esac
        if [ "$failed_head" = "$head" ]; then
            [ $(( $(date +%s) - failed_at )) -lt "$(retry_delay "$failures")" ] && return 0
        else
            failures=0
        fi
    fi

    echo "GitNexus watchdog: analyzing ${repo_name} at ${head:0:12}..."
    if (
        cd "$repo_dir" || exit 1
        { echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null
        # Without --force, analyze only redoes what changed since the last run.
        # --index-only keeps AGENTS.md, CLAUDE.md and skills out of the checkout.
        exec timeout --kill-after=60 "$ANALYZE_TIMEOUT" gitnexus analyze --index-only
    ) 2>&1; then
        printf '%s\n' "$head" > "${WATCH_STATE_DIR}/${repo_name}.analyzed"
        rm -f "$failed_file"
        echo "GitNexus watchdog: ${repo_name} analyzed."
    else
        failures=$((failures + 1))
        printf '%s %s %s\n' "$head" "$failures" "$(date +%s)" > "$failed_file"
        delay=$(retry_delay "$failures")
        echo "GitNexus watchdog: analyze of ${repo_name} failed (attempt ${failures}) — retrying in ${delay}s, or on a new commit."
    fi
}

watch_repos() {
    mkdir -p "$WATCH_STATE_DIR"
    while true; do
        for repo_dir in "$REPOS_DIR"/*/; do
            [ -d "$repo_dir" ] && analyze_if_stale "$repo_dir"
        done
        sleep 10
    done
}

# Started before eval-server so it can pick up repos the dashboard clones while
# the registry is still empty.
(
    set +e
    echo "GitNexus: Starting watchdog daemon..."
    while true; do
        ( watch_repos )
        echo "GitNexus watchdog: stopped unexpectedly — restarting in 30s."
        sleep 30
    done
) &
WATCHDOG_PID=$!

# Supervise eval-server. It refuses to stay up with an empty registry, so if we
# exited here the container would die and `restart: unless-stopped` would spin it
# in a ~3s crash loop — burning CPU, flooding logs, and letting dependents start
# against a dead service. Instead: wait for a repo, run, and restart if it dies.
# eval-server holds a LadybugDB, so give it a window to close cleanly rather than
# killing it outright. Stays under Docker's default 10s stop timeout.
cleanup() {
    trap - TERM INT
    kill "$WATCHDOG_PID" 2>/dev/null || true
    if [ -n "${EVAL_PID:-}" ]; then
        kill -TERM "$EVAL_PID" 2>/dev/null || true
        for _ in $(seq 1 8); do
            kill -0 "$EVAL_PID" 2>/dev/null || break
            sleep 1
        done
        kill -KILL "$EVAL_PID" 2>/dev/null || true
    fi
    exit 0
}
trap cleanup TERM INT

while true; do
    if ! has_indexed_repos; then
        echo "GitNexus: Registry empty — waiting for a repo to be indexed."
        echo "GitNexus: Add one via the Dashboard (Projects -> Index Repo), or set DEFAULT_REPO."
        while ! has_indexed_repos; do
            sleep 10
        done
        echo "GitNexus: Repo detected ($(count_registered_repos) registered)."
    fi

    echo "GitNexus: Starting eval-server on port $PORT..."
    GITNEXUS_LBUG_BUFFER_POOL_SIZE="$SERVE_BUFFER_POOL" \
        gitnexus eval-server --port "$PORT" --host 0.0.0.0 --idle-timeout 0 &
    EVAL_PID=$!
    wait "$EVAL_PID" || true
    echo "GitNexus: eval-server exited — restarting in 10s."
    sleep 10
done

