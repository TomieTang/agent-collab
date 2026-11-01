#!/usr/bin/env bash
set -euo pipefail

: "${OPENCODE_SERVER_PASSWORD:?请先设置 OPENCODE_SERVER_PASSWORD}"
export CANNBOT_GUI=1

exec opencode serve --hostname 127.0.0.1 --port "${OC_PORT:-4096}"
