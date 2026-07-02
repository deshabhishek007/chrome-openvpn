const dot = document.getElementById("dot");
const toggle = document.getElementById("toggle");
const hostInput = document.getElementById("host");
const portInput = document.getElementById("port");
const modeAllBtn = document.getElementById("modeAll");
const modeSitesBtn = document.getElementById("modeSites");
const sitesWrap = document.getElementById("sitesWrap");
const sitesInput = document.getElementById("sites");
const status = document.getElementById("status");

let enabled = false;
let mode = "all";

function parseSites() {
  return sitesInput.value
    .split("\n")
    .map((s) => s.trim().toLowerCase())
    .map((s) => s.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter((s) => s.length > 0);
}

function render() {
  dot.className = "dot" + (enabled ? " on" : "");
  toggle.textContent = enabled
    ? "Disconnect (back to direct)"
    : mode === "sites"
      ? "Route listed sites via VPN"
      : "Connect Chrome to VPN";
  toggle.classList.toggle("on", enabled);
  modeAllBtn.classList.toggle("active", mode === "all");
  modeSitesBtn.classList.toggle("active", mode === "sites");
  sitesWrap.classList.toggle("visible", mode === "sites");
  // Lock inputs while connected so the applied config matches the UI.
  hostInput.disabled = enabled;
  portInput.disabled = enabled;
  sitesInput.disabled = enabled;
  modeAllBtn.disabled = enabled;
  modeSitesBtn.disabled = enabled;
}

async function showPublicIP() {
  status.innerHTML = "Checking public IP…";
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const res = await fetch("https://api.ipify.org?format=json", {
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(t);
    const { ip } = await res.json();
    if (enabled && mode === "sites") {
      // The IP-check site itself isn't in the VPN list, so this shows
      // the direct IP. Say so instead of confusing the user.
      status.innerHTML =
        `Listed sites go via VPN.<br>Other traffic direct (IP: <b>${ip}</b>)`;
    } else {
      status.innerHTML =
        `Chrome's public IP: <b>${ip}</b>` + (enabled ? " (via VPN)" : " (direct)");
    }
  } catch (e) {
    if (enabled) {
      dot.className = "dot err";
      status.innerHTML =
        "Could not reach the internet through the proxy.<br>" +
        "Is the bridge running? Start it with <b>./vpn-bridge.sh</b>";
    } else {
      status.textContent = "Could not determine public IP.";
    }
  }
}

async function load() {
  const cfg = await chrome.runtime.sendMessage({ type: "get-state" });
  enabled = cfg.enabled;
  mode = cfg.mode || "all";
  hostInput.value = cfg.host;
  portInput.value = cfg.port;
  sitesInput.value = (cfg.sites || []).join("\n");
  render();
  showPublicIP();
}

modeAllBtn.addEventListener("click", () => {
  mode = "all";
  render();
});
modeSitesBtn.addEventListener("click", () => {
  mode = "sites";
  render();
});

toggle.addEventListener("click", async () => {
  const sites = parseSites();
  if (!enabled && mode === "sites" && sites.length === 0) {
    status.innerHTML = "Add at least one domain to the list first.";
    return;
  }
  toggle.disabled = true;
  enabled = !enabled;
  await chrome.runtime.sendMessage({
    type: "set-state",
    enabled,
    host: hostInput.value.trim() || "127.0.0.1",
    port: Number(portInput.value) || 1080,
    mode,
    sites,
  });
  toggle.disabled = false;
  render();
  // Give the proxy switch a moment to settle before probing.
  setTimeout(showPublicIP, 300);
});

load();
