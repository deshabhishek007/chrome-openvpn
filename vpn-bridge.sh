#!/usr/bin/env bash
# vpn-bridge.sh — Chrome-only OpenVPN bridge.
#
# Brings up your OpenVPN tunnel WITHOUT touching the system routing
# table (--route-nopull), then starts a SOCKS5 proxy on 127.0.0.1 whose
# outbound traffic is bound to the VPN's tun interface. Point Chrome at
# that proxy (via the extension in ./extension) and only Chrome uses
# the VPN. Ctrl-C tears everything down.
#
# Usage:
#   ./vpn-bridge.sh [path/to/config.ovpn]
#   (or drop your .ovpn into ./profiles/ and run with no arguments)
#
# Optional:
#   PORT=1080            SOCKS5 listen port (default 1080)
#   ./profiles/auth.txt  username on line 1, password on line 2, if your
#                        server requires credentials

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-1080}"
LOG="/tmp/openvpn-bridge.log"
PIDFILE="/tmp/openvpn-bridge.pid"

# --- locate binaries -------------------------------------------------
OPENVPN_BIN="$(command -v openvpn || true)"
[[ -z "$OPENVPN_BIN" && -x /opt/homebrew/sbin/openvpn ]] && OPENVPN_BIN=/opt/homebrew/sbin/openvpn
[[ -z "$OPENVPN_BIN" && -x /usr/local/sbin/openvpn ]] && OPENVPN_BIN=/usr/local/sbin/openvpn
if [[ -z "$OPENVPN_BIN" ]]; then
  echo "error: openvpn not found. Install it with: brew install openvpn" >&2
  exit 1
fi
GOST_BIN="$(command -v gost || true)"
if [[ -z "$GOST_BIN" ]]; then
  echo "error: gost not found. Install it with: brew install gost" >&2
  exit 1
fi

# --- locate the .ovpn profile ----------------------------------------
CONFIG="${1:-}"
if [[ -z "$CONFIG" ]]; then
  CONFIG="$(ls "$DIR"/profiles/*.ovpn 2>/dev/null | head -1 || true)"
fi
if [[ -z "$CONFIG" || ! -f "$CONFIG" ]]; then
  echo "error: no .ovpn config found." >&2
  echo "  Pass one as an argument, or drop it into: $DIR/profiles/" >&2
  exit 1
fi
echo "==> Using profile: $CONFIG"

AUTH_ARGS=()
if [[ -f "$DIR/profiles/auth.txt" ]]; then
  AUTH_ARGS=(--auth-user-pass "$DIR/profiles/auth.txt")
  echo "==> Using credentials from profiles/auth.txt"
fi

# --- cleanup on exit ---------------------------------------------------
cleanup() {
  echo
  echo "==> Shutting down..."
  if [[ -n "${IFACE:-}" ]]; then
    sudo route -n delete -inet default -ifscope "$IFACE" 2>/dev/null || true
  fi
  if [[ -f "$PIDFILE" ]]; then
    sudo kill "$(cat "$PIDFILE")" 2>/dev/null || true
    sudo rm -f "$PIDFILE"
  fi
  echo "==> Tunnel closed. Chrome (if still toggled ON) has no proxy to"
  echo "    reach — remember to toggle the extension OFF."
}
trap cleanup EXIT INT TERM

# --- start openvpn, isolated from system routing ----------------------
echo "==> Starting OpenVPN (system routes will NOT be changed)..."
echo "    sudo is needed to create the tun interface."
sudo rm -f "$LOG" "$PIDFILE"
sudo "$OPENVPN_BIN" \
  --config "$CONFIG" \
  "${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}" \
  --route-nopull \
  --log "$LOG" \
  --writepid "$PIDFILE" \
  --daemon

echo -n "==> Waiting for tunnel"
for i in $(seq 1 60); do
  if sudo grep -q "Initialization Sequence Completed" "$LOG" 2>/dev/null; then
    break
  fi
  if ! sudo kill -0 "$(sudo cat "$PIDFILE" 2>/dev/null || echo 0)" 2>/dev/null; then
    echo; echo "error: OpenVPN exited. Last log lines:" >&2
    sudo tail -20 "$LOG" >&2 || true
    exit 1
  fi
  echo -n "."
  sleep 1
done
echo
if ! sudo grep -q "Initialization Sequence Completed" "$LOG" 2>/dev/null; then
  echo "error: tunnel did not come up within 60s. Last log lines:" >&2
  sudo tail -20 "$LOG" >&2 || true
  exit 1
fi

IFACE="$(sudo grep -Eo 'utun[0-9]+' "$LOG" | tail -1)"
if [[ -z "$IFACE" ]]; then
  echo "error: could not determine tun interface from $LOG" >&2
  exit 1
fi
TUN_IP="$(ifconfig "$IFACE" 2>/dev/null | awk '/inet /{print $2; exit}')"
echo "==> Tunnel up on $IFACE (${TUN_IP:-no ip?}) — system routing untouched."

# macOS scoped routing: sockets bound to the tun interface (IP_BOUND_IF,
# which is how gost pins its outbound traffic) still consult the routing
# table, scoped to that interface. With --route-nopull the tun has no
# routes at all, so give it a default route that is visible ONLY to
# interface-scoped lookups. The main routing table — and therefore every
# other app on the system — is unaffected.
sudo route -n add -inet default -ifscope "$IFACE" -interface "$IFACE" >/dev/null
echo "==> Added scoped default route on $IFACE (invisible to other apps)."

# --- start the SOCKS5 proxy bound to the tun interface ----------------
# DNS is resolved over DoH (encrypted), so ISP DNS blocking can't stop
# sites from resolving even though the resolver runs on this machine.
GOST_CFG="/tmp/gost-bridge.yml"
cat > "$GOST_CFG" <<EOF
services:
- name: vpn-socks
  addr: 127.0.0.1:${PORT}
  handler:
    type: socks5
  listener:
    type: tcp
  interface: ${IFACE}
  resolver: doh
resolvers:
- name: doh
  nameservers:
  - addr: https://1.1.1.1/dns-query
    prefer: ipv4
EOF

echo "==> Starting SOCKS5 proxy on 127.0.0.1:$PORT (outbound via $IFACE, DNS via DoH)"
echo
echo "    Now toggle the 'OpenVPN Bridge' extension ON in Chrome."
echo "    Press Ctrl-C here to disconnect."
echo
"$GOST_BIN" -C "$GOST_CFG"
