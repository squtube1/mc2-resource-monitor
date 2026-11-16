// Resource Monitor for MC² (Plugin API v2).
//
// Plugins run in a sandboxed web view: there is no require(), no fs and no
// file paths. Everything here goes through the mc2 bridge. main.js does the
// scanning and keeps the result in mc2.storage ("report"); the tab and the
// Play screen card read it from there, and ask for a fresh scan by writing
// "scanRequest".

function dupGroups(mods) {
  // Two copies of one mod: the same Modrinth/CurseForge project, or the same
  // name (catches a hand-dropped jar next to the Modrinth copy).
  var groups = [];
  var seen = {};
  function add(members) {
    if (members.length < 2) return;
    var key = members.map(function (m) { return m.id; }).sort().join("|");
    if (seen[key]) return;
    seen[key] = true;
    groups.push({ name: members[0].name, count: members.length, files: members.map(function (m) { return m.id; }) });
  }
  var byProject = {}, byName = {};
  mods.forEach(function (m) {
    if (m.projectId != null) (byProject[m.projectId] = byProject[m.projectId] || []).push(m);
    var n = String(m.name || "").trim().toLowerCase();
    if (n) (byName[n] = byName[n] || []).push(m);
  });
  Object.keys(byProject).forEach(function (k) { add(byProject[k]); });
  Object.keys(byName).forEach(function (k) { add(byName[k]); });
  return groups;
}

async function scanPack(inst, runningIds) {
  var info = {};
  try { info = await mc2.instances.get(inst.id); } catch (e) {}
  var mods = [];
  try { mods = await mc2.mods.list(inst.id); } catch (e) {}
  var worlds = [];
  try { worlds = await mc2.worlds.list(inst.id); } catch (e) {}
  return {
    id: inst.id,
    name: inst.name,
    version: inst.version,
    loader: inst.loader,
    memoryMB: info.memoryMB || null,
    playtimeSeconds: info.playtimeSeconds || 0,
    mods: mods.length,
    enabled: mods.filter(function (m) { return m.enabled; }).length,
    dups: dupGroups(mods),
    worlds: worlds.length,
    worldBytes: worlds.reduce(function (s, w) { return s + (w.sizeBytes || 0); }, 0),
    running: !!runningIds[inst.id],
  };
}

var scanning = false;

async function scan() {
  if (scanning) return null;
  scanning = true;
  try {
    var instances = await mc2.listInstances();
    var runningIds = {};
    try {
      (await mc2.instances.running()).forEach(function (r) { runningIds[r.id] = true; });
    } catch (e) {}
    var packs = [];
    for (var i = 0; i < instances.length; i++) packs.push(await scanPack(instances[i], runningIds));
    var report = {
      at: Date.now(),
      packs: packs,
      totals: {
        packs: packs.length,
        running: packs.filter(function (p) { return p.running; }).length,
        worldBytes: packs.reduce(function (s, p) { return s + p.worldBytes; }, 0),
        dups: packs.reduce(function (s, p) { return s + p.dups.length; }, 0),
        runningMB: packs.reduce(function (s, p) { return s + (p.running ? (p.memoryMB || 0) : 0); }, 0),
      },
    };
    await mc2.storage.set("report", report);
    await updateBadge(report);
    return report;
  } finally {
    scanning = false;
  }
}

async function updateBadge(report) {
  var on = await mc2.settings.get("badge");
  var n = report.totals.dups;
  mc2.setBadge("instances", on && n > 0 ? String(n) : null);
}

function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

var timers = [];
var lastRequest = 0;

async function restartTimer() {
  if (timers[1]) clearInterval(timers[1]);
  var minutes = (await mc2.settings.get("everyMinutes")) || 10;
  timers[1] = setInterval(scan, minutes * 60 * 1000);
}

if (!(mc2.apiVersion >= 2)) {
  mc2.notify("Resource Monitor needs a newer version of MC². Update MC² to use it.");
} else {
  module.exports = {
    onload: async function () {
      mc2.addTab({ id: "resource-monitor", title: "Resources", icon: "gauge", file: "panel.html" });
      mc2.addWidget({ id: "resource-summary", title: "Resources", file: "widget.html", height: 110 });

      mc2.addCommand({
        id: "find-duplicate-mods",
        name: "Find duplicate mods in every pack",
        icon: "doc.on.doc",
        callback: async function () {
          var report = await scan();
          if (!report) return;
          var hit = report.packs.filter(function (p) { return p.dups.length; });
          if (!hit.length) { mc2.notify("No duplicate mods in any pack."); return; }
          mc2.notify(hit.map(function (p) {
            return p.name + ": " + p.dups.map(function (d) { return d.name + " ×" + d.count; }).join(", ");
          }).join(" · "));
        },
      });

      mc2.addMenuItem({
        id: "check-pack",
        where: "instance",
        title: "Check resources",
        icon: "gauge",
        callback: async function (ctx) {
          var inst = (await mc2.listInstances()).find(function (i) { return i.id === ctx.instanceId; });
          if (!inst) return;
          var p = await scanPack(inst, {});
          var parts = [];
          if (p.memoryMB) parts.push((p.memoryMB / 1024).toFixed(1).replace(/\.0$/, "") + " GB memory");
          parts.push(p.enabled + " of " + plural(p.mods, "mod", "mods") + " on");
          parts.push(plural(p.worlds, "world", "worlds") + ", " + (p.worldBytes / 1073741824).toFixed(2) + " GB");
          if (p.dups.length) parts.push("duplicates: " + p.dups.map(function (d) { return d.name + " ×" + d.count; }).join(", "));
          mc2.notify(p.name + ": " + parts.join(" · "));
        },
      });

      ["game-exit", "instance-launch", "instance-created", "instance-removed", "mod-installed", "mod-removed"]
        .forEach(function (ev) { mc2.on(ev, function () { setTimeout(scan, 1500); }); });
      mc2.on("settings-change", function (c) {
        if (c.key === "everyMinutes") restartTimer();
        if (c.key === "badge") mc2.storage.get("report").then(function (r) { if (r) updateBadge(r); });
      });

      // The tab and card ask for a scan by writing a timestamp.
      timers[0] = setInterval(async function () {
        var req = await mc2.storage.get("scanRequest");
        if (req && req > lastRequest) { lastRequest = req; scan(); }
      }, 2000);
      await restartTimer();
      await scan();
    },

    onunload: function () {
      timers.forEach(function (t) { if (t) clearInterval(t); });
      timers = [];
    },
  };
}
