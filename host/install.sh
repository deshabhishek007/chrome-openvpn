#!/usr/bin/env bash
# install.sh — one-time setup for controlling the VPN bridge from the
# Chrome extension. Does three things:
#   1. Finds the extension's ID in your Chrome profile and registers a
#      native messaging host manifest so Chrome may talk to
#      host/vpn-bridge-host.py.
#   2. Installs the root helper to /usr/local/libexec/vpn-bridge-helper
#      (root-owned, so it can't be modified without sudo afterwards).
#   3. Adds /etc/sudoers.d/vpn-bridge allowing your user to run exactly
#      that one helper without a password — nothing else.
#
# Usage: ./host/install.sh [extension-id]
#        (the id is auto-detected if the extension is already loaded)

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BASE="$(dirname "$DIR")"
HOST_NAME="com.vpnbridge.host"
HELPER_DST="/usr/local/libexec/vpn-bridge-helper"
SUDOERS_FILE="/etc/sudoers.d/vpn-bridge"

# --- 1. extension id ---------------------------------------------------
EXT_ID="${1:-}"
if [[ -z "$EXT_ID" ]]; then
  EXT_ID="$(EXT_DIR="$BASE/extension" python3 - <<'EOF'
import glob, json, os
home = os.path.expanduser("~")
ext_dir = os.path.realpath(os.environ["EXT_DIR"])
paths = glob.glob(home + "/Library/Application Support/Google/Chrome/*/Preferences") + \
        glob.glob(home + "/Library/Application Support/Google/Chrome/*/Secure Preferences")
for prefs_path in paths:
    try:
        with open(prefs_path) as f:
            prefs = json.load(f)
        settings = prefs.get("extensions", {}).get("settings", {})
        for ext_id, info in settings.items():
            # unpacked extensions are recorded by their load path
            path = os.path.realpath(info.get("path", ""))
            name = (info.get("manifest") or {}).get("name", "")
            if path == ext_dir or name == "OpenVPN Bridge":
                print(ext_id)
                raise SystemExit
    except (OSError, ValueError):
        continue
EOF
)"
fi
if [[ -z "$EXT_ID" ]]; then
  echo "error: could not find the 'OpenVPN Bridge' extension in Chrome." >&2
  echo "Load it first (chrome://extensions -> Load unpacked -> extension/)," >&2
  echo "or pass the id: ./host/install.sh <extension-id>" >&2
  exit 1
fi
echo "==> Extension id: $EXT_ID"

# --- 2. native messaging manifest -------------------------------------
chmod +x "$DIR/vpn-bridge-host.py"
NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$NM_DIR"
cat > "$NM_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "OpenVPN Bridge control",
  "path": "$DIR/vpn-bridge-host.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
echo "==> Registered native messaging host: $NM_DIR/$HOST_NAME.json"

# --- 3. root helper + sudoers ------------------------------------------
OPENVPN_BIN="$(command -v openvpn || true)"
[[ -z "$OPENVPN_BIN" && -x /opt/homebrew/sbin/openvpn ]] && OPENVPN_BIN=/opt/homebrew/sbin/openvpn
if [[ -z "$OPENVPN_BIN" ]]; then
  echo "error: openvpn not found. Install it with: brew install openvpn" >&2
  exit 1
fi

TMP_HELPER="$(mktemp)"
sed -e "s|__PROFILE_DIR__|$BASE/profiles|" \
    -e "s|__OPENVPN_BIN__|$OPENVPN_BIN|" \
    "$DIR/vpn-bridge-helper.template.sh" > "$TMP_HELPER"
bash -n "$TMP_HELPER"

echo "==> Installing root helper to $HELPER_DST (sudo will ask for your password)"
sudo mkdir -p /usr/local/libexec
sudo cp "$TMP_HELPER" "$HELPER_DST"
sudo chown root:wheel "$HELPER_DST"
sudo chmod 555 "$HELPER_DST"
rm -f "$TMP_HELPER"

TMP_SUDOERS="$(mktemp)"
echo "$USER ALL=(root) NOPASSWD: $HELPER_DST" > "$TMP_SUDOERS"
if ! sudo visudo -cf "$TMP_SUDOERS" >/dev/null; then
  echo "error: generated sudoers entry failed validation, not installing." >&2
  rm -f "$TMP_SUDOERS"
  exit 1
fi
sudo cp "$TMP_SUDOERS" "$SUDOERS_FILE"
sudo chown root:wheel "$SUDOERS_FILE"
sudo chmod 440 "$SUDOERS_FILE"
rm -f "$TMP_SUDOERS"
echo "==> Passwordless sudo enabled for exactly: $HELPER_DST"

echo
echo "Done. Reload the extension (chrome://extensions -> reload icon),"
echo "then open the popup — you can now start/stop the VPN from there."
