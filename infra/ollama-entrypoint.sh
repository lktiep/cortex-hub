#!/bin/sh
# Starts ollama with every local model pinned to the container's CPU quota.
#
# ollama 0.34.4 spawns llama-server without --threads, so llama.cpp starts one
# thread per *host* CPU and ignores the cgroup quota. On a 12-vCPU host capped at
# four CPUs that is twelve threads sharing four CPUs of time: every scheduler
# period was throttled and an 8-chunk embedding batch took 0.4-1.0s. Pinned to
# four threads the same batch takes ~0.3s and a full index ran at 23.9 chunks/s
# instead of 13.6 (measured on that host, 2026-10-09).
#
# There is no environment variable for the thread count; the only per-model
# knob is the num_thread parameter, so each model is re-created from itself
# with that one parameter added (its other parameters are inherited). The work
# runs beside the server, after it answers, and is skipped for models already
# pinned, so a restart costs a few `ollama show` calls. A model pulled while the
# container runs keeps the default until the next restart.
#
# CORTEX_OLLAMA_THREADS empty, zero or not a number leaves models untouched.

pin_threads() {
  threads=$(printf '%s\n' "${CORTEX_OLLAMA_THREADS:-}" | awk '/^[0-9]+(\.[0-9]+)?$/ { print int($1) }')
  [ -n "$threads" ] && [ "$threads" -gt 0 ] || return 0

  tries=0
  until ollama list >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -gt 120 ]; then
      echo "cortex: ollama did not answer within 120s; models keep their thread count" >&2
      return 1
    fi
    sleep 1
  done

  modelfile=$(mktemp)
  ollama list | awk 'NR > 1 { print $1 }' | while read -r model; do
    current=$(ollama show "$model" --parameters 2>/dev/null | awk '$1 == "num_thread" { print $2 }')
    [ "$current" = "$threads" ] && continue
    printf 'FROM %s\nPARAMETER num_thread %s\n' "$model" "$threads" > "$modelfile"
    if ollama create "$model" -f "$modelfile" >/dev/null 2>&1; then
      echo "cortex: $model pinned to $threads threads"
    else
      echo "cortex: could not pin $model to $threads threads" >&2
    fi
  done
  rm -f "$modelfile"
}

# Detached twice so the helper is orphaned to the container's init (compose sets
# `init: true`), which reaps it; ollama, exec'd below, never would.
( pin_threads & )
exec /bin/ollama serve
