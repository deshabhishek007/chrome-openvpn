#!/bin/bash
# vpn-bridge-helper — root-side operations for the Chrome VPN bridge.
#
# Installed by host/install.sh to /usr/local/libexec/vpn-bridge-helper,
# owned by root and allowed passwordless via /etc/sudoers.d/vpn-bridge.
# Because it runs as root without a password, it is deliberately strict:
#  - profiles are referenced by NAME only, resolved inside a fixed dir
#  - --script-security 1 blocks up/down scripts inside .ovpn files
#  - it only ever starts openvpn with --route-nopull (never full-tunnel)
#
# __PROFILE_DIR__ and __OPENVPN_BIN__ are substituted at install time.

set -euo pipefail

PROFILE_DIR="__PROFILE_DIR__"
OPENVPN_BIN="__OPENVPN_BIN__"
LOG=/tmp/openvpn-bridge.log
PIDFILE=/tmp/openvpn-bridge.pid

stop_tunnel() {
  local iface
  iface="$(grep -Eo 'utun[0-9]+' "$LOG" 2>/dev/null | tail -1 || true)"
  if [[ -n "$iface" ]]; then
    route -n delete -inet default -ifscope "$iface" 2>/dev/null || true
  fi
  if [[ -f "$PIDFILE" ]]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  # catch strays from crashed sessions; matches only our tunnels
  pkill -f -- "--route-nopull" 2>/dev/null || true
}

case "${1:-}" in
  start)
    name="${2:-}"
    if ! [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]]; then
      echo "invalid profile name" >&2; exit 2
    fi
    cfg="$PROFILE_DIR/$name.ovpn"
    if [[ ! -f "$cfg" ]]; then
      echo "no such profile: $name" >&2; exit 2
    fi

    stop_tunnel
    rm -f "$LOG"

    auth_args=()
    [[ -f "$PROFILE_DIR/auth.txt" ]] && auth_args=(--auth-user-pass "$PROFILE_DIR/auth.txt")

    "$OPENVPN_BIN" --config "$cfg" \
      "${auth_args[@]+"${auth_args[@]}"}" \
      --route-nopull \
      --script-security 1 \
      --log "$LOG" --writepid "$PIDFILE" --daemon
    chmod 644 "$LOG"

    for _ in $(seq 1 45); do
      grep -q "Initialization Sequence Completed" "$LOG" 2>/dev/null && break
      if ! kill -0 "$(cat "$PIDFILE" 2>/dev/null || echo 0)" 2>/dev/null; then
        echo "openvpn exited:" >&2; tail -5 "$LOG" >&2; exit 1
      fi
      sleep 1
    done
    if ! grep -q "Initialization Sequence Completed" "$LOG"; then
      stop_tunnel
      echo "tunnel did not come up in 45s:" >&2; tail -5 "$LOG" >&2; exit 1
    fi

    iface="$(grep -Eo 'utun[0-9]+' "$LOG" | tail -1)"
    route -n add -inet default -ifscope "$iface" -interface "$iface" >/dev/null 2>&1 || true
    echo "$iface"
    ;;
  stop)
    stop_tunnel
    echo "stopped"
    ;;
  *)
    echo "usage: vpn-bridge-helper start <profile-name> | stop" >&2
    exit 2
    ;;
esac
