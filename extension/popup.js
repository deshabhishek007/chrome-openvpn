const $ = (id) => document.getElementById(id);
const hero = $("hero");
const heroText = $("heroText");
const heroIp = $("heroIp");
const profileSel = $("profileSel");
const bridgeBtn = $("bridgeBtn");
const bridgeBtnText = $("bridgeBtnText");
const bridgeStatus = $("bridgeStatus");
const modeAllBtn = $("modeAll");
const modeSitesBtn = $("modeSites");
const sitesWrap = $("sitesWrap");
const sitesInput = $("sites");
const addSiteBtn = $("addSite");
const toggle = $("toggle");
const switchSub = $("switchSub");
const hostInput = $("host");
const portInput = $("port");

let cfg = { enabled: false, mode: "all", sites: [], host: "127.0.0.1", port: 1080 };
let bridgeRunning = false;
let ipCheckSeq = 0;

// ---- config / proxy state ---------------------------------------------

function parseSites() {
  return sitesInput.value
    .split("\n")
    .map((s) => s.trim().toLowerCase())
    .map((s) => s.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter((s, i, a) => s.length > 0 && a.indexOf(s) === i);
}

async function saveCfg(patch = {}) {
  cfg = { ...cfg, ...patch };
  await chrome.runtime.sendMessage({
    type: "set-state",
    enabled: cfg.enabled,
    host: hostInput.value.trim() || "127.0.0.1",
    port: Number(portInput.value) || 1080,
    mode: cfg.mode,
    sites: parseSites(),
  });
}

function render() {
  toggle.checked = cfg.enabled;
  modeAllBtn.classList.toggle("active", cfg.mode === "all");
  modeSitesBtn.classList.toggle("active", cfg.mode === "sites");
  sitesWrap.classList.toggle("visible", cfg.mode === "sites");
  switchSub.textContent =
    cfg.mode === "sites"
      ? `${parseSites().length} site(s) via VPN, rest direct`
      : "All Chrome traffic";
}

function setHero(state, text, ipHtml) {
  hero.className = state; // "", "on", "err"
  heroText.textContent = text;
  if (ipHtml !== undefined) heroIp.innerHTML = ipHtml;
}

async function fetchIp() {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch("https://ipwho.is/", {
      cache: "no-store", signal: controller.signal,
    });
    const d = await res.json();
    if (d && d.ip) {
      const flag = d.flag && d.flag.emoji ? " " + d.flag.emoji : "";
      return { ip: d.ip, where: (d.country || "") + flag };
    }
  } catch (e) { /* fall through to plain lookup */ }
  finally { clearTimeout(t); }
  const res = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
  return { ip: (await res.json()).ip, where: "" };
}

async function updateHero() {
  const seq = ++ipCheckSeq;
  if (!cfg.enabled) {
    setHero("", "Direct connection", "Checking IP…");
  } else if (cfg.mode === "sites") {
    setHero("on", "Split tunnel active", "Checking IP…");
  } else {
    setHero("on", "Protected — via VPN", "Checking IP…");
  }
  try {
    const { ip, where } = await fetchIp();
    if (seq !== ipCheckSeq) return; // a newer check superseded this one
    const loc = where ? ` · ${where}` : "";
    if (cfg.enabled && cfg.mode === "sites") {
      heroIp.innerHTML = `Listed sites via VPN · other traffic: <b>${ip}</b>${loc}`;
    } else {
      heroIp.innerHTML = `IP <b>${ip}</b>${loc}`;
    }
  } catch (e) {
    if (seq !== ipCheckSeq) return;
    if (cfg.enabled && cfg.mode === "all") {
      setHero("err", "Proxy unreachable",
        "Start the tunnel below, or run <b>./vpn-bridge.sh</b>");
    } else {
      heroIp.textContent = "Could not determine IP.";
    }
  }
}

// ---- events: routing & switch ------------------------------------------

toggle.addEventListener("change", async () => {
  await saveCfg({ enabled: toggle.checked });
  render();
  setTimeout(updateHero, 300);
});

modeAllBtn.addEventListener("click", async () => {
  await saveCfg({ mode: "all" });
  render();
  setTimeout(updateHero, 300);
});

modeSitesBtn.addEventListener("click", async () => {
  await saveCfg({ mode: "sites" });
  render();
  setTimeout(updateHero, 300);
});

let sitesTimer = null;
sitesInput.addEventListener("input", () => {
  clearTimeout(sitesTimer);
  sitesTimer = setTimeout(async () => {
    await saveCfg();
    render();
  }, 500);
});

addSiteBtn.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = new URL(tab.url).hostname.replace(/^www\./, "");
    if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error("not a website");
    const sites = parseSites();
    if (!sites.includes(host)) {
      sitesInput.value = [...sites, host].join("\n");
      await saveCfg();
      render();
      setTimeout(updateHero, 300);
    }
  } catch (e) {
    bridgeStatus.textContent = "Current tab has no usable site address.";
  }
});

for (const el of [hostInput, portInput]) {
  el.addEventListener("change", () => saveCfg().then(() => setTimeout(updateHero, 300)));
}

// ---- local bridge (tunnel) ----------------------------------------------

function bridge(payload) {
  return chrome.runtime.sendMessage({ type: "bridge", payload });
}

function setBridgeBusy(busy, label) {
  bridgeBtn.disabled = busy;
  bridgeBtn.classList.toggle("busy", busy);
  if (label) bridgeBtnText.textContent = label;
}

function renderBridge(st) {
  bridgeRunning = Boolean(st && st.running);
  bridgeBtnText.textContent = bridgeRunning ? "Stop" : "Start";
  bridgeBtn.classList.toggle("stop", bridgeRunning);
  bridgeBtn.classList.remove("busy");
  bridgeBtn.disabled = false;
  profileSel.disabled = bridgeRunning;
  if (bridgeRunning) {
    bridgeStatus.innerHTML = `Tunnel <b>up</b>: ${st.profile || "?"} (${st.iface})`;
    if (st.profile) profileSel.value = st.profile;
  } else if (st && st.tunnel && !st.proxy) {
    bridgeStatus.textContent = "Tunnel up but proxy down — press Start to repair.";
  } else {
    bridgeStatus.innerHTML = "Tunnel <b>down</b>.";
  }
}

async function loadBridge() {
  const [list, st] = await Promise.all([
    bridge({ cmd: "list" }),
    bridge({ cmd: "status" }),
  ]);
  if (!list.ok || list.notInstalled || !st.ok) {
    bridgeStatus.textContent = list.error || st.error || "Bridge control unavailable.";
    bridgeBtn.disabled = true;
    profileSel.disabled = true;
    return;
  }
  profileSel.innerHTML = "";
  for (const p of list.profiles) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.server ? `${p.name} (${p.server})` : p.name;
    profileSel.appendChild(opt);
  }
  if (list.profiles.length === 0) {
    bridgeStatus.textContent = "No .ovpn profiles found in profiles/.";
    bridgeBtn.disabled = true;
    return;
  }
  renderBridge(st);
}

bridgeBtn.addEventListener("click", async () => {
  profileSel.disabled = true;
  let res;
  if (bridgeRunning) {
    setBridgeBusy(true, "Stopping…");
    res = await bridge({ cmd: "stop" });
  } else {
    setBridgeBusy(true, "Starting…");
    bridgeStatus.textContent = "Connecting tunnel — takes a few seconds…";
    res = await bridge({ cmd: "start", profile: profileSel.value });
  }
  if (!res.ok) bridgeStatus.textContent = res.error;
  const st = await bridge({ cmd: "status" });
  if (st.ok) renderBridge(st);
  else setBridgeBusy(false);
  // the background worker auto-toggles the proxy on start/stop
  const fresh = await chrome.runtime.sendMessage({ type: "get-state" });
  cfg = { ...cfg, ...fresh };
  render();
  setTimeout(updateHero, 300);
});

// ---- init -----------------------------------------------------------------

async function init() {
  const stored = await chrome.runtime.sendMessage({ type: "get-state" });
  cfg = { ...cfg, ...stored };
  hostInput.value = cfg.host;
  portInput.value = cfg.port;
  sitesInput.value = (cfg.sites || []).join("\n");
  render();
  updateHero();
  loadBridge();
}

init();
