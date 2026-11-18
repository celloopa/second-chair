// Reads and clicks Ableton Live's menu bar on the Mac (JXA, run by /usr/bin/osascript -l JavaScript) for live_menu.
// NOT TESTED ON A MAC YET. Written to match menu.ps1 on Windows; check it on a scratch set before trusting it.
//   list                 prints {"title","version","menus":[{"name","items":[...]}]}; reads only.
//   fire <Top> <Item>... clicks that menu item by name (names exactly as list gave them), after checking it's enabled.
// Needs Accessibility permission for the app running this server (System Settings > Privacy & Security > Accessibility).
// Reports conflict on whether System Events can click a menu of an app in the background; this does not activate Live.
// Prints one JSON object; on trouble {"error": "...", "message": "..."}.
ObjC.import("AppKit");

function liveProcess(se) {
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  let pid = -1, version = "";
  for (let i = 0; i < apps.count; i++) {
    const a = apps.objectAtIndex(i);
    if ((ObjC.unwrap(a.bundleIdentifier) || "").indexOf("com.ableton.live") === 0) {
      pid = a.processIdentifier;
      const b = $.NSBundle.bundleWithURL(a.bundleURL);
      version = b ? (ObjC.unwrap(b.objectForInfoDictionaryKey("CFBundleShortVersionString")) || "") : "";
      break;
    }
  }
  if (pid < 0) return null;
  const procs = se.processes.whose({ unixId: pid })();
  return procs.length ? { proc: procs[0], version: version } : null;
}

function items(menu) {
  const out = [];
  const list = menu.menuItems();
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    let name = "";
    try { name = it.name() || ""; } catch (e) { continue; }
    if (!name) continue; // separators have no name
    let enabled = true, checked = false;
    try { enabled = it.enabled(); } catch (e) {}
    try { checked = !!(it.attributes.byName("AXMenuItemMarkChar").value() || ""); } catch (e) {}
    const row = { name: name, enabled: enabled, checked: checked };
    let subs = [];
    try { subs = it.menus(); } catch (e) {}
    if (subs.length) row.items = items(subs[0]);
    out.push(row);
  }
  return out;
}

function run(argv) {
  const se = Application("System Events");
  let live;
  try { live = liveProcess(se); }
  catch (e) { return JSON.stringify({ error: "permission", message: "System Events refused: turn on Accessibility for the app that runs second-chair (System Settings > Privacy & Security > Accessibility)." }); }
  if (!live) return JSON.stringify({ error: "no-window", message: "Live is not open (no Ableton Live app found)." });
  const bar = live.proc.menuBars[0];
  let title = "";
  try { title = live.proc.windows[0].name(); } catch (e) {}
  try {
    if (argv[0] === "list") {
      const menus = [];
      const tops = bar.menuBarItems();
      for (let i = 0; i < tops.length; i++) {
        const name = tops[i].name();
        if (!name || name === "Apple") continue;
        menus.push({ name: name, items: items(tops[i].menus[0]) });
      }
      return JSON.stringify({ title: title, version: live.version, menus: menus });
    }
    if (argv[0] === "fire") {
      const names = argv.slice(1);
      if (names.length < 2) return JSON.stringify({ error: "bad-path", message: "A menu path needs a menu and an item." });
      let menu = bar.menuBarItems.byName(names[0]).menus[0];
      let item = null;
      for (let d = 1; d < names.length; d++) {
        item = menu.menuItems.byName(names[d]);
        if (!item.exists()) return JSON.stringify({ error: "not-found", message: "Live's menu has no item called \"" + names[d] + "\" there." });
        if (d < names.length - 1) menu = item.menus[0];
      }
      if (!item.enabled()) return JSON.stringify({ error: "disabled", message: "Live has \"" + names.join(" > ") + "\" greyed out right now." });
      item.click();
      return JSON.stringify({ fired: true, checked_after: null, title: title, version: live.version });
    }
    return JSON.stringify({ error: "bad-action", message: "Use list or fire." });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/not allowed|assistive|-1719|-25211/i.test(msg)) return JSON.stringify({ error: "permission", message: "System Events refused: turn on Accessibility for the app that runs second-chair (System Settings > Privacy & Security > Accessibility)." });
    return JSON.stringify({ error: "mac", message: "The Mac menu route failed: " + msg.slice(0, 200) });
  }
}
