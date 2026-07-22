#!/usr/bin/env bash
# Stops every process this pipeline started, strictly by recorded PID file
# (never by pattern-matching process names/commandlines). Safe to run any
# time -- e.g. mid-run to pause things, or after a run to reclaim GPUs.
#
#   bash ~/pipeline/stop_all.sh
#
# Does NOT touch anything outside ~/pipeline/pids/*.pid, so it can never
# reach GPU 0 or any process this pipeline didn't itself launch.

set -uo pipefail

PIPELINE_DIR="${PIPELINE_DIR:-$HOME/pipeline}"
PIDS="$PIPELINE_DIR/pids"

log() { echo "[stop_all $(date '+%H:%M:%S')] $*"; }

stop_pidfile() {
    local pidfile=$1
    [ -f "$pidfile" ] || return 0
    local pid; pid="$(cat "$pidfile" 2>/dev/null || true)"
    [ -n "$pid" ] || return 0
    if kill -0 "$pid" 2>/dev/null; then
        log "stopping pid $pid ($(basename "$pidfile"))"
        kill -TERM "$pid" 2>/dev/null || true
        for _ in $(seq 1 20); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 1
        done
        if kill -0 "$pid" 2>/dev/null; then
            log "pid $pid still alive after SIGTERM, sending SIGKILL"
            kill -KILL "$pid" 2>/dev/null || true
        fi
    else
        log "$(basename "$pidfile"): pid $pid already gone"
    fi
}

if [ ! -d "$PIDS" ]; then
    log "no $PIDS directory -- nothing to stop"
    exit 0
fi

shopt -s nullglob
for pidfile in "$PIDS"/*.pid; do
    stop_pidfile "$pidfile"
done

log "done"
