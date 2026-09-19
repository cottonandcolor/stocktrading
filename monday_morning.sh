#!/bin/zsh
# Launch the local paper-trading stack for Monday's session.
# Target: before the 9:45 ET opening-range window.

set -euo pipefail

ROOT="/Users/preetidave/stocktrading"
cd "$ROOT"
mkdir -p logs
STAMP=$(date +%Y%m%d_%H%M%S)
LOG="$ROOT/logs/monday_${STAMP}.log"
PY="$ROOT/.venv/bin/python"
STREAMLIT="$ROOT/.venv/bin/streamlit"

{
  echo "===== Monday launch $(date) ====="
  echo "Timezone check: $(TZ=America/New_York date)"
} | tee -a "$LOG"

# 1) Paper trading dashboard
if lsof -nP -iTCP:8501 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Streamlit already on :8501" | tee -a "$LOG"
else
  echo "Starting paper_platform.py on :8501" | tee -a "$LOG"
  nohup "$STREAMLIT" run paper_platform.py \
    --server.headless true \
    --browser.gatherUsageStats false \
    >>"$LOG" 2>&1 &
  echo $! > logs/streamlit.pid
  sleep 3
fi

# 2) Open the dashboard in the default browser
open "http://localhost:8501" >/dev/null 2>&1 || true

# 3) Open an interactive Terminal for approval-based day_trader
#    (needs a real TTY so YES approvals work)
osascript <<'APPLESCRIPT' >>"$LOG" 2>&1
tell application "Terminal"
  activate
  do script "cd /Users/preetidave/stocktrading && echo 'PAPER day trader — type YES only for READY signals' && .venv/bin/python day_trader.py --live"
end tell
APPLESCRIPT

# 4) Desktop notification
osascript -e 'display notification "Paper trader + day scanner are starting. Approve READY signals in Terminal." with title "Monday trading stack"' >/dev/null 2>&1 || true

echo "Launch complete. Dashboard: http://localhost:8501" | tee -a "$LOG"
echo "Logs: $LOG"
