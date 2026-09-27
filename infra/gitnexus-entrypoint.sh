#!/bin/bash
# GitNexus — Entrypoint Script
# Ensures repos are indexed before starting eval-server.
# 1. Bootstrap default repo if no indexed repos found.
# 2. Auto-discover and analyze repos from shared /app/data/repos/ volume
#    (cloned by cortex-api indexer).

set -e

GITNEXUS_DIR="${HOME}/.gitnexus"
REPOS_DIR="/app/data/repos"
PORT="${PORT:-4848}"

# Cap Node.js heap to prevent OOM kills. GitNexus defaults to 8GB (HEAP_MB=8192)
# which exceeds container memory limits. Set to 3GB to fit within 4GB container limit.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=3072}"

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

# ── Step 2: Auto-discover repos from shared volume ──
# The cortex-api indexer clones repos to /app/data/repos/{projectId}
# We scan for any git repos that aren't yet in the GitNexus registry.
if [ -d "$REPOS_DIR" ]; then
    echo "GitNexus: Scanning ${REPOS_DIR} for unregistered repos..."
    ANALYZED=0

    for repo_dir in "$REPOS_DIR"/*/; do
        [ -d "$repo_dir/.git" ] || continue
        
        repo_name=$(basename "$repo_dir")
        
        # Check if already registered by looking for .gitnexus dir in repo
        if [ -d "$repo_dir/.gitnexus" ]; then
            echo "  ✓ ${repo_name} — already indexed"
            continue
        fi

        # Check if cloning is currently in progress
        if [ -f "${REPOS_DIR}/${repo_name}.cloning" ]; then
            echo "  → ${repo_name} — cloning in progress (skipping)"
            continue
        fi

        echo "  → Analyzing ${repo_name}..."
        # Note: --embeddings omitted for auto-discovery to avoid LadybugDB WAL
        # corruption on large repos (observed with C# repos >10K symbols).
        # Embeddings can be enabled per-repo manually:
        #   docker exec cortex-gitnexus bash -c 'cd /app/data/repos/<id> && gitnexus analyze --embeddings'
        cd "$repo_dir" && gitnexus analyze --force 2>&1 && {
            ANALYZED=$((ANALYZED + 1))
            echo "  ✓ ${repo_name} — indexed successfully"
        } || {
            echo "  ✗ ${repo_name} — analyze failed (skipping)"
        }
    done

    TOTAL=$(count_registered_repos)
    echo "GitNexus: Auto-discovery complete. ${ANALYZED} new repos analyzed. Total registered: ${TOTAL}"
fi

# Run background watchdog daemon to index new/re-indexed repos.
# Started BEFORE eval-server so it can pick up repos the dashboard clones while
# the registry is still empty.
(
    echo "GitNexus: Starting watchdog daemon..."
    while true; do
        sleep 10
        if [ -d "$REPOS_DIR" ]; then
            for repo_dir in "$REPOS_DIR"/*/; do
                [ -d "$repo_dir/.git" ] || continue
                repo_name=$(basename "$repo_dir")
                
                # Check if cloning is currently in progress
                if [ -f "${REPOS_DIR}/${repo_name}.cloning" ]; then
                    echo "GitNexus watchdog: Repo ${repo_name} is currently cloning. Skipping."
                    continue
                fi
                
                if [ ! -d "$repo_dir/.gitnexus" ]; then
                    echo "GitNexus watchdog: New or re-indexed repo detected: ${repo_name}."
                    echo "GitNexus watchdog: Analyzing ${repo_name}..."
                    cd "$repo_dir" && gitnexus analyze --force 2>&1
                    echo "GitNexus watchdog: ${repo_name} analyzed successfully."
                fi
            done
        fi
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
    gitnexus eval-server --port "$PORT" --host 0.0.0.0 --idle-timeout 0 &
    EVAL_PID=$!
    wait "$EVAL_PID" || true
    echo "GitNexus: eval-server exited — restarting in 10s."
    sleep 10
done

