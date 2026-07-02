// OpenVPN Bridge - background service worker.
// Toggles Chrome's proxy settings between "direct" and a local SOCKS5
// proxy that tunnels through OpenVPN. Two modes:
//   "all"   - every request in this Chrome profile goes via the VPN
//   "sites" - only the listed domains go via the VPN, rest stay direct
// Only Chrome is affected; the proxy setting lives at "regular" scope.

const DEFAULTS = { host: "127.0.0.1", port: 1080, mode: "all", sites: [] };

async function getConfig() {
  const s = await chrome.storage.local.get([
    "host", "port", "enabled", "mode", "sites",
  ]);
  return {
    host: s.host || DEFAULTS.host,
    port: s.port || DEFAULTS.port,
    mode: s.mode || DEFAULTS.mode,
    sites: Array.isArray(s.sites) ? s.sites : DEFAULTS.sites,
    enabled: Boolean(s.enabled),
  };
}

function fixedServersConfig(proxyHost, proxyPort) {
  return {
    mode: "fixed_servers",
    rules: {
      singleProxy: { scheme: "socks5", host: proxyHost, port: Number(proxyPort) },
      // Never send local/loopback traffic through the tunnel.
      bypassList: ["localhost", "127.0.0.1", "<local>"],
    },
  };
}

function pacScriptConfig(proxyHost, proxyPort, sites) {
  // Route only the listed domains (and their subdomains) via the VPN.
  const pac = `function FindProxyForURL(url, host) {
  var sites = ${JSON.stringify(sites)};
  if (host === "localhost" || host === "127.0.0.1") return "DIRECT";
  for (var i = 0; i < sites.length; i++) {
    var d = sites[i];
    if (host === d || dnsDomainIs(host, "." + d))
      return "SOCKS5 ${proxyHost}:${Number(proxyPort)}";
  }
  return "DIRECT";
}`;
  return { mode: "pac_script", pacScript: { data: pac } };
}

async function applyState({ enabled, host, port, mode, sites }) {
  if (enabled) {
    const value =
      mode === "sites" && sites.length > 0
        ? pacScriptConfig(host, port, sites)
        : fixedServersConfig(host, port);
    await chrome.proxy.settings.set({ value, scope: "regular" });
  } else {
    await chrome.proxy.settings.clear({ scope: "regular" });
  }
  await chrome.action.setBadgeText({ text: enabled ? "ON" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#1a7f37" });
}

// Restore state when the browser starts or the extension is (re)loaded.
async function restore() {
  await applyState(await getConfig());
}
chrome.runtime.onStartup.addListener(restore);
chrome.runtime.onInstalled.addListener(restore);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === "set-state") {
      const cfg = {
        enabled: msg.enabled,
        host: msg.host || DEFAULTS.host,
        port: msg.port || DEFAULTS.port,
        mode: msg.mode || DEFAULTS.mode,
        sites: Array.isArray(msg.sites) ? msg.sites : [],
      };
      await chrome.storage.local.set(cfg);
      await applyState(cfg);
      sendResponse({ ok: true, ...cfg });
    } else if (msg.type === "get-state") {
      sendResponse(await getConfig());
    }
  })();
  return true; // keep the message channel open for the async response
});

// If another extension or policy takes over the proxy setting, reflect
// reality in our stored state so the popup doesn't lie.
chrome.proxy.settings.onChange.addListener(async (details) => {
  const cfg = await getConfig();
  const controlledByUs =
    details.levelOfControl === "controlled_by_this_extension";
  if (cfg.enabled && !controlledByUs) {
    await chrome.storage.local.set({ enabled: false });
    await chrome.action.setBadgeText({ text: "" });
  }
});
