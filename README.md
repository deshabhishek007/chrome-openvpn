# OpenVPN Bridge for Chrome

Route **only Chrome's traffic** through your OpenVPN server. The rest of
your Mac stays on the normal connection.

## Why this design?

A Chrome extension cannot speak the OpenVPN protocol — the extension API
(`chrome.proxy`) can only point the browser at an HTTP/SOCKS proxy. So this
project has two halves:

```
Chrome ──(extension sets SOCKS5 proxy)──▶ 127.0.0.1:1080 (gost)
                                              │ outbound bound to utunX
                                              ▼
                                        OpenVPN tunnel ──▶ your VPN server
```

- **`vpn-bridge.sh`** starts OpenVPN with `--route-nopull`, so the tunnel
  comes up but the system routing table is untouched — no other app uses
  it. Then it starts `gost`, a SOCKS5 proxy on `127.0.0.1:1080` whose
  outbound connections are bound to the VPN's tun interface.
- **`extension/`** is a Chrome extension with a toggle and two modes:
  - **All Chrome traffic** — everything in Chrome goes via the VPN.
  - **Only these sites** — just the domains you list (plus their
    subdomains) go via the VPN; the rest of Chrome stays direct. Use
    this when only a few sites are blocked without the VPN.

Because the system routing table is never modified, SSH, terminals, and
every other app keep using your normal connection — the "SSH breaks when
the VPN is on" problem goes away. Just make sure the **OpenVPN Connect
app stays disconnected** while using the bridge; if it connects, it
tunnels the whole system again.

## One-time setup

1. Install the tools (already done if Claude set this up for you):

   ```sh
   brew install openvpn gost
   ```

2. Export your `.ovpn` profile from your VPN provider and drop it into
   `profiles/`. (OpenVPN Connect doesn't let you export imported profiles —
   download the original `.ovpn` from your provider's dashboard instead.)

   If your server needs a username/password, create `profiles/auth.txt`:

   ```
   your-username
   your-password
   ```

3. Load the extension in Chrome:
   - Open `chrome://extensions`
   - Enable **Developer mode** (top right)
   - Click **Load unpacked** and select the `extension/` folder

## Daily use

```sh
./vpn-bridge.sh              # one profile: uses it; several: shows a menu
./vpn-bridge.sh eu           # partial name match, e.g. hos-vpn-eu.ovpn
./vpn-bridge.sh ~/Downloads/myserver.ovpn   # explicit path
```

With several `.ovpn` files in `profiles/`, the no-argument form lists
them with their server addresses and asks you to pick a number. To
switch servers, Ctrl-C the running bridge and start it again with a
different choice — Chrome's toggle can stay ON the whole time.

It asks for `sudo` (creating a tun interface requires root), waits for the
tunnel, then starts the proxy. Leave it running.

Then click the **OpenVPN Bridge** icon in Chrome, pick a mode
(**All Chrome traffic**, or **Only these sites** with your list of
VPN-required domains), and hit connect. In all-traffic mode the popup
shows Chrome's public IP so you can confirm it changed. Toggle off (or
just stop the script with Ctrl-C) to go back to direct.

## Optional: start/stop the VPN from the extension itself

Instead of running `./vpn-bridge.sh` in a terminal, the popup can manage
the tunnel directly — pick a profile from a dropdown, press **Start**,
and the proxy toggle flips on automatically (Stop reverses both).

One-time setup (after loading the extension):

```sh
./host/install.sh
```

This wires up three things:

1. A **native messaging host** manifest, so Chrome is allowed to launch
   `host/vpn-bridge-host.py` and exchange messages with it — this is
   Chrome's sanctioned mechanism for extensions to talk to local
   programs; the manifest is locked to this extension's ID.
2. A **root helper** at `/usr/local/libexec/vpn-bridge-helper`
   (root-owned, read-only) that does only the privileged parts: start
   openvpn with `--route-nopull` + `--script-security 1`, add/remove the
   interface-scoped route, stop the tunnel. Profiles are referenced by
   name only and resolved inside this project's `profiles/` dir.
3. A **sudoers rule** (`/etc/sudoers.d/vpn-bridge`) allowing your user
   to run exactly that one helper without a password — nothing else
   gains passwordless sudo.

To undo it all:

```sh
sudo rm /etc/sudoers.d/vpn-bridge /usr/local/libexec/vpn-bridge-helper
rm ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.vpnbridge.host.json
```

The terminal script keeps working either way; they control the same
tunnel and proxy.

## Notes & limitations

- **Only Chrome is affected.** The proxy setting applies to the whole
  Chrome profile (all tabs/windows of that profile), not other apps.
- **DNS:** Chrome sends hostnames to the SOCKS5 proxy, and `gost`
  resolves them over encrypted DNS-over-HTTPS (Cloudflare `1.1.1.1`).
  ISP-level DNS blocking therefore can't stop the VPN-routed sites from
  resolving, and your ISP's resolver never sees those lookups.
- **localhost is bypassed** by the extension, so local dev servers keep
  working while the VPN is on.
- If the bridge isn't running but the extension is toggled ON, Chrome has
  no route to the internet — the popup will tell you to start
  `./vpn-bridge.sh`.
- Keep `.ovpn` files and `auth.txt` private; they contain credentials.
