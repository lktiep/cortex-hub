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
                echo "GitNexus: Clone failed, starting eval-server with no repos..."
                exec gitnexus eval-server --port "$PORT" --idle-timeout 0 2>&1
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

# Start the eval-server in the background
echo "GitNexus: Starting eval-server on port $PORT..."
gitnexus eval-server --port "$PORT" --idle-timeout 0 &
EVAL_PID=$!

# Run background watchdog daemon to index new/re-indexed repos
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

# Wait for eval-server to exit
wait $EVAL_PID

