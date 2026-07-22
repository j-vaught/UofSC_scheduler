#!/usr/bin/env bash
# Orchestrates the OCR -> LLM-structuring pipeline end to end.
#
# Launch this so it survives your SSH session ending:
#
#   setsid nohup bash ~/pipeline/run_all.sh > ~/pipeline/logs/run_all.out 2>&1 &
#   disown
#
# Resumable: safe to re-run at any time. Already-finished maps (raw/*.md,
# out/*.json) and permanently-failed maps (failed/*.txt) are skipped.
#
# Config (all overridable via env vars, defaults match the task spec):
#   PIPELINE_DIR   ~/pipeline
#   MODEL          Qwen/Qwen3-32B-FP8
#   GPU_OCR        2   (Stage A OCR GPU)
#   GPU_B1/PORT_B1 1 / 8901   (first Stage B vLLM server, started immediately)
#   GPU_B2/PORT_B2 3 / 8902   (second Stage B vLLM server, started immediately)
#   GPU_B3/PORT_B3 $GPU_OCR / 8903  (third server, started once Stage A frees its GPU)
#   VLLM_READY_TIMEOUT   400  (seconds to wait for "Application startup complete")

set -uo pipefail

PIPELINE_DIR="${PIPELINE_DIR:-$HOME/pipeline}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODEL="${MODEL:-Qwen/Qwen3-32B-FP8}"
GPU_OCR="${GPU_OCR:-2}"
GPU_B1="${GPU_B1:-1}"; PORT_B1="${PORT_B1:-8901}"
GPU_B2="${GPU_B2:-3}"; PORT_B2="${PORT_B2:-8902}"
GPU_B3="${GPU_B3:-$GPU_OCR}"; PORT_B3="${PORT_B3:-8903}"
VLLM_READY_TIMEOUT="${VLLM_READY_TIMEOUT:-400}"

PADDLE_PY="$HOME/paddle-bench/.venv/bin/python3"
PARSER_PY="$HOME/parser-bench/.venv/bin/python3"
VLLM_BIN="$HOME/parser-bench/.venv/bin/vllm"

LOGS="$PIPELINE_DIR/logs"
PIDS="$PIPELINE_DIR/pids"

TAG_B1="gpu${GPU_B1}"
TAG_B2="gpu${GPU_B2}"
TAG_B3="gpu${GPU_B3}b"

log() { echo "[run_all $(date '+%H:%M:%S')] $*"; }

mkdir -p "$PIPELINE_DIR"/{pdfs,raw,out,claims,failed,logs,pids}

# --- manifest for status_updater.py, written before anything starts -------
cat > "$PIDS/slots.txt" <<EOF
${TAG_B1}|GPU${GPU_B1}
${TAG_B2}|GPU${GPU_B2}
${TAG_B3}|GPU${GPU_B3} (3rd, post-OCR)
EOF

start_status_updater() {
    if [ -f "$PIDS/status_updater.pid" ] && kill -0 "$(cat "$PIDS/status_updater.pid")" 2>/dev/null; then
        log "status_updater already running (pid $(cat "$PIDS/status_updater.pid"))"
        return
    fi
    PIPELINE_DIR="$PIPELINE_DIR" setsid nohup "$PARSER_PY" "$SCRIPT_DIR/status_updater.py" \
        > "$LOGS/status_updater.log" 2>&1 &
    echo $! > "$PIDS/status_updater.pid"
    log "status_updater started (pid $!)"
}

start_stage_a() {
    if [ -f "$PIDS/stage_a.pid" ] && kill -0 "$(cat "$PIDS/stage_a.pid")" 2>/dev/null; then
        log "stage A already running (pid $(cat "$PIDS/stage_a.pid"))"
        return
    fi
    rm -f "$PIPELINE_DIR/.ocr_done"
    PIPELINE_DIR="$PIPELINE_DIR" CUDA_VISIBLE_DEVICES="$GPU_OCR" setsid nohup "$PADDLE_PY" "$SCRIPT_DIR/stage_a_ocr.py" \
        > "$LOGS/stage_a.log" 2>&1 &
    echo $! > "$PIDS/stage_a.pid"
    log "stage A (OCR) started on GPU $GPU_OCR (pid $!)"
}

# start_vllm <gpu> <port> <tag>
start_vllm() {
    local gpu=$1 port=$2 tag=$3
    PIPELINE_DIR="$PIPELINE_DIR" CUDA_VISIBLE_DEVICES="$gpu" setsid nohup "$VLLM_BIN" serve "$MODEL" \
        --port "$port" --max-model-len 32000 --gpu-memory-utilization 0.95 \
        > "$LOGS/vllm_${tag}.log" 2>&1 &
    echo $! > "$PIDS/vllm_${tag}.pid"
    log "vllm server for $tag started on GPU $gpu, port $port (pid $!)"
}

# wait_ready <tag> -> 0 if "Application startup complete" seen, 1 on timeout/death
wait_ready() {
    local tag=$1
    local logf="$LOGS/vllm_${tag}.log"
    local pidf="$PIDS/vllm_${tag}.pid"
    local waited=0
    while true; do
        if grep -q "Application startup complete" "$logf" 2>/dev/null; then
            log "vllm $tag ready after ${waited}s"
            return 0
        fi
        local pid; pid="$(cat "$pidf" 2>/dev/null || true)"
        if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
            log "vllm $tag process died before becoming ready -- see $logf"
            return 1
        fi
        if [ "$waited" -ge "$VLLM_READY_TIMEOUT" ]; then
            log "vllm $tag did not become ready within ${VLLM_READY_TIMEOUT}s -- giving up, see $logf"
            return 1
        fi
        sleep 5
        waited=$((waited + 5))
    done
}

# start_worker <port> <tag>
start_worker() {
    local port=$1 tag=$2
    PIPELINE_DIR="$PIPELINE_DIR" setsid nohup "$PARSER_PY" "$SCRIPT_DIR/stage_b_worker.py" \
        --port "$port" --tag "$tag" > "$LOGS/worker_${tag}.log" 2>&1 &
    echo $! > "$PIDS/worker_${tag}.pid"
    log "worker for $tag started (pid $!, port $port)"
}

# start_vllm_with_retry <gpu> <port> <tag> -> 0 if server ready, 1 if given up
start_vllm_with_retry() {
    local gpu=$1 port=$2 tag=$3
    local attempt
    for attempt in 1 2; do
        # Belt-and-suspenders: a previous attempt on this tag may still be
        # alive (e.g. wait_ready gave up on a slow-but-not-dead startup) --
        # never let two vllm processes fight over the same GPU.
        stop_pidfile "$PIDS/vllm_${tag}.pid"
        start_vllm "$gpu" "$port" "$tag"
        if wait_ready "$tag"; then
            return 0
        fi
        log "vllm $tag attempt $attempt failed"
    done
    stop_pidfile "$PIDS/vllm_${tag}.pid"
    log "vllm $tag: giving up after 2 attempts -- continuing pipeline without this slot"
    return 1
}

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
        kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
    fi
}

total_pdfs() { find "$PIPELINE_DIR/pdfs" -maxdepth 1 -name '*.pdf' 2>/dev/null | wc -l | tr -d ' '; }
resolved_count() {
    local j f
    j=$(find "$PIPELINE_DIR/out" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
    f=$(find "$PIPELINE_DIR/failed" -maxdepth 1 -name '*.txt' 2>/dev/null | wc -l | tr -d ' ')
    echo $((j + f))
}

log "PIPELINE_DIR=$PIPELINE_DIR  MODEL=$MODEL"
log "GPU_OCR=$GPU_OCR  B1=gpu${GPU_B1}:${PORT_B1}  B2=gpu${GPU_B2}:${PORT_B2}  B3(post-OCR)=gpu${GPU_B3}:${PORT_B3}"

start_status_updater
start_stage_a

start_vllm_with_retry "$GPU_B1" "$PORT_B1" "$TAG_B1" && start_worker "$PORT_B1" "$TAG_B1"
start_vllm_with_retry "$GPU_B2" "$PORT_B2" "$TAG_B2" && start_worker "$PORT_B2" "$TAG_B2"

log "waiting for Stage A (OCR) to finish so GPU $GPU_OCR can host the 3rd server..."
while [ ! -f "$PIPELINE_DIR/.ocr_done" ]; do
    sleep 15
done
log "Stage A done -- GPU $GPU_OCR is free"

start_vllm_with_retry "$GPU_B3" "$PORT_B3" "$TAG_B3" && start_worker "$PORT_B3" "$TAG_B3"

log "waiting for every OCR'd map to have a JSON output (or a recorded failure)..."
while true; do
    total="$(total_pdfs)"
    resolved="$(resolved_count)"
    if [ "$total" -gt 0 ] && [ "$resolved" -ge "$total" ] && [ -f "$PIPELINE_DIR/.ocr_done" ]; then
        log "all $total maps resolved ($resolved json+failed) -- finishing up"
        break
    fi
    sleep 20
done

log "stopping vLLM servers and workers..."
stop_pidfile "$PIDS/worker_${TAG_B1}.pid"
stop_pidfile "$PIDS/worker_${TAG_B2}.pid"
stop_pidfile "$PIDS/worker_${TAG_B3}.pid"
stop_pidfile "$PIDS/vllm_${TAG_B1}.pid"
stop_pidfile "$PIDS/vllm_${TAG_B2}.pid"
stop_pidfile "$PIDS/vllm_${TAG_B3}.pid"

PIPELINE_DIR="$PIPELINE_DIR" "$PARSER_PY" "$SCRIPT_DIR/status_updater.py" --once
stop_pidfile "$PIDS/status_updater.pid"

log "done. Final counts: total=$(total_pdfs) resolved=$(resolved_count). See $PIPELINE_DIR/STATUS.txt"
