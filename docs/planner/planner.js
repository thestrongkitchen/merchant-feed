/* The Strong Kitchen — "Plan your week" planner.
 *
 * Loaded on thestrongkitchen.com by one Google Tag Manager tag (all pages). It does two things:
 *   /menus*            adds a gold "Build Your Week" button beside All / Meals / Sides / Snacks that opens
 *                      the planner: pick items, park them in a basket, drag them onto Mon–Sun against the
 *                      customer's whole-day calorie + protein goal, then put the whole plan in the cart.
 *   /checkout/success  shows "Download my week plan" (a month-view PDF) once the planned order is paid.
 *
 * Data: planner.json next to this file, rebuilt from the live menu by build_merchant_feed.py.
 * Cart: the site's own POST /cart/add (same call its Add to Cart buttons make).
 * Everything the customer plans stays in their own browser (localStorage); nothing is sent anywhere else.
 */
(function () {
  "use strict";
  if (window.__tskPlanner) return;
  window.__tskPlanner = true;

  var BASE_URL = (document.currentScript && document.currentScript.src) ? document.currentScript.src.replace(/[^/]*$/, "") : "https://thestrongkitchen.github.io/merchant-feed/planner/";
  var DATA_URL = window.TSKP_DATA_URL || BASE_URL + "../products.json";
  // The menu data lives in the feed's products.json ("planner" section, refreshed by the scheduled jobs);
  // planner.json is the fallback for a build that predates that section.
  function loadData() {
    var get = function (u) { return fetch(u, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); };
    return get(DATA_URL).then(function (d) {
      if (d.planner) return d.planner;
      if (d.items && d.items[0] && d.items[0].sizes) return d;
      return get(BASE_URL + "../planner.json");
    });
  }
  var STORE = "tskPlanner";
  var path = location.pathname.replace(/\/+$/, "") || "/";
  // TSKP_PAGE lets the review playground run the planner off the live site
  var onMenu = window.TSKP_PAGE === "menu" || /^\/menus(\/|$)/.test(path);
  var onSuccess = path === "/checkout/success";
  if (!onMenu && !onSuccess) return;

  // Soft launch: only a browser that has opened a page with ?planner=preview sees the planner (remembered on that
  // device; ?planner=off forgets it). Set PREVIEW_ONLY to false to show it to everyone.
  var PREVIEW_ONLY = true;
  try {
    var pv = /[?&]planner=(preview|off)/.exec(location.search);
    if (pv) localStorage.setItem("tskPlannerPreview", pv[1] === "preview" ? "1" : "0");
  } catch (e) { /* storage blocked: the gate below simply stays closed */ }
  var previewer = false;
  try { previewer = localStorage.getItem("tskPlannerPreview") === "1"; } catch (e) { /* closed */ }
  if (PREVIEW_ONLY && !previewer && !window.TSKP_PAGE) return;

  // ------------------------------------------------------------------ helpers
  function $(root, sel) { return root.querySelector(sel); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function fmt(n) { return Math.round(n).toLocaleString(); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function reduced() { return window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches; }
  function load() { try { return JSON.parse(localStorage.getItem(STORE)) || null; } catch (e) { return null; } }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(st)); } catch (e) { /* private mode: plan just won't persist */ } }
  function addFont() {
    if (document.getElementById("tskp-font")) return;
    var l = document.createElement("link");
    l.id = "tskp-font"; l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Bungee&family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap";
    document.head.appendChild(l);
  }

  var st = load() || { cal: 2000, pro: 150, view: 0, packs: [], pieces: [] };
  var seq = 1 + Math.max(0, ...(st.packs || []).map(function (p) { return +p.pid.slice(1); }), ...(st.pieces || []).map(function (p) { return +p.uid.slice(1); }));

  var DATA, ITEMS = {}, GROUPS = [], DAYS = [];
  var ABBR = { "Fat Loss": "FL", "Performance": "Perf", "Protein Plus": "PP" };
  var CIRC = 2 * Math.PI * 46;
  var ptab = 0, selected = null, busy = false, drag = null, lastFocus = null, shown = { cal: 0, pro: 0 };
  var btn, pill, host, R, sheet;

  // ------------------------------------------------------------------ menu page
  function boot() {
    loadData().then(function (d) {
      DATA = d;
      // Never plan against a stale menu: the site reports its current menu week
      return fetch("/cart/status", { headers: { Accept: "application/json" } }).then(function (r) { return r.json(); }).then(function (s) {
        if (String(s.current_week) !== String(d.week)) { console.info("[TSK planner] menu week", s.current_week, "≠ data week", d.week, "— planner hidden until the data catches up"); return; }
        start();
      });
    }).catch(function (e) { console.warn("[TSK planner] not started:", e); });
  }

  function start() {
    DATA.items.forEach(function (m) {
      m.short = m.kind === "side" && m.sizes[0].protein >= 15 ? m.name + " (side)" : m.name;
      ITEMS[m.id] = m;
    });
    GROUPS = [
      { title: "Meals", items: DATA.items.filter(function (m) { return m.kind === "meal"; }) },
      { title: "Protein sides", items: DATA.items.filter(function (m) { return m.kind === "side" && m.sizes[0].protein >= 15; }) },
      { title: "Sides", items: DATA.items.filter(function (m) { return m.kind === "side" && m.sizes[0].protein < 15; }) },
      { title: "Snacks & breakfast", items: DATA.items.filter(function (m) { return m.kind === "snack"; }) }
    ].filter(function (g) { return g.items.length; });
    DAYS = planWeek(DATA.fulfillment);
    // A plan from an earlier menu week is dropped; the goals are kept
    if (st.week !== DATA.week) { st = { cal: st.cal, pro: st.pro, view: 0, packs: [], pieces: [], week: DATA.week }; }
    st.packs = st.packs.filter(function (k) { return info(k); });
    st.pieces = st.pieces.filter(function (p) { return info(p); });
    addFont();
    mountButton();
    mountSheet();
    render();
    save();
    window.TSKP_API = { paper: paper, close: close, goalsCode: goalsCode };
    fromLink();
  }

  // ------------------------------------------------------------------ saved goals as a short code, for the Thursday "your week is built" link
  // e.g. ?tskplan=lean.gluten.2.wk.2300.170  (goal . avoid list joined by - or "none" . meals a day . wk|all|0-2-4 . cal . protein)
  function goalsCode() {
    if (!st.quiz) return "";
    var q = st.quiz, d = q.days === "wk" || q.days === "all" ? q.days : q.days.join("-");
    return [q.goal, q.avoid.length ? q.avoid.join("-") : "none", q.perDay, d, st.cal, st.pro].join(".");
  }
  function fromLink() {
    var m = /[?&]tskplan=([a-z0-9.\-]+)/i.exec(location.search);
    if (!m) return;
    var p = m[1].toLowerCase().split(".");
    if (p.length < 6 || !GOALS[p[0]]) return;
    var days = p[3] === "wk" || p[3] === "all" ? p[3] : p[3].split("-").map(Number).filter(function (n) { return n >= 0 && n < 7; });
    qa = { goal: p[0], avoid: p[1] === "none" ? [] : p[1].split("-").filter(function (a) { return a === "gluten" || a === "dairy"; }),
      perDay: clamp(+p[2] || 2, 1, 3), days: days.length ? days : "wk", weight: "", own: true, cal: p[4], pro: p[5] };
    // drop the code from the address bar so a refresh doesn't rebuild over their swaps
    try { history.replaceState(null, "", location.pathname + location.search.replace(/([?&])tskplan=[^&]*&?/, "$1").replace(/[?&]$/, "") + location.hash); } catch (e) { /* fine */ }
    buildWeek(); open();
    var b = $(R, "#built");
    b.insertAdjacentHTML("afterbegin", "<b>This week, built from your saved goals.</b> ");
    b.scrollIntoView({ block: "start" });
  }

  // The plan week starts the Monday on or after the first delivery day
  function planWeek(fulfill) {
    var m = /([A-Z][a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?/.exec((fulfill || "").replace(/^.*?(Sunday|Monday),\s*/, ""));
    var now = new Date(), d = m ? new Date(m[1] + " " + m[2] + ", " + now.getFullYear()) : now;
    if (isNaN(d)) d = now;
    if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate() - 60)) d.setFullYear(d.getFullYear() + 1);
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
    var out = [], names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    for (var i = 0; i < 7; i++) {
      var x = new Date(d); x.setDate(d.getDate() + i);
      out.push({ date: x, short: names[x.getDay()].slice(0, 3), long: names[x.getDay()], n: x.getDate(), mon: x.toLocaleString("en-US", { month: "short" }) });
    }
    return out;
  }

  function info(p) {
    var m = ITEMS[p.id]; if (!m) return null;
    var sz = m.sizes.filter(function (s) { return s.option_id === p.opt; })[0];
    return sz ? { m: m, sz: sz } : null;
  }
  function addPack(id, opt) {
    var m = ITEMS[id], pid = "k" + seq++;
    st.packs.push({ pid: pid, id: id, opt: opt });
    for (var i = 0; i < m.serv; i++) st.pieces.push({ uid: "p" + seq++, pid: pid, id: id, opt: opt, day: -1 });
  }
  // Put one serving of an item on a day: use a spare from a pack already bought, else buy another pack
  function takePiece(id, opt, day) {
    var p = st.pieces.filter(function (x) { return x.id === id && x.opt === opt && x.day < 0; })[0];
    if (!p) { addPack(id, opt); p = st.pieces[st.pieces.length - 1 - (ITEMS[id].serv - 1)]; }
    p.day = day;
    return p;
  }

  // ------------------------------------------------------------------ the quiz: a few taps, then a week built around the answers
  var GOALS = {
    lean: { label: "Lean out", note: "Lose fat, keep muscle", calPerLb: 12, proPerLb: 0.9, size: ["Fat Loss"], dflt: [1800, 140] },
    maintain: { label: "Stay where I am", note: "Eat well without thinking about it", calPerLb: 14, proPerLb: 0.8, size: ["Performance", "Fat Loss"], dflt: [2200, 150] },
    build: { label: "Build muscle", note: "More protein, more fuel", calPerLb: 16, proPerLb: 1.0, size: ["Protein Plus", "Performance", "Fat Loss"], dflt: [2700, 180] }
  };
  var qa = null, qstep = 0;
  function showQuiz() {
    qa = st.quiz ? JSON.parse(JSON.stringify(st.quiz)) : { goal: null, avoid: [], perDay: null, days: null, weight: "", own: false, cal: "", pro: "" };
    qstep = 0;
    $(R, ".in").classList.add("quizzing"); $(R, "#quiz").hidden = false; $(R, "#built").hidden = true;
    drawQuiz();
  }
  function endQuiz() { $(R, ".in").classList.remove("quizzing"); $(R, "#quiz").hidden = true; }
  function drawQuiz() {
    var q = $(R, "#quiz"), n = 5;
    var head = '<div class="qdots">' + Array.apply(null, Array(n)).map(function (_, i) { return '<i class="' + (i <= qstep ? "on" : "") + '"></i>'; }).join("") + "</div>";
    var back = qstep ? '<button class="qback" data-q="back">← Back</button>' : "";
    function opts(key, list, multi) {
      return '<div class="opts">' + list.map(function (o) {
        var on = multi ? qa[key].indexOf(o[0]) >= 0 : qa[key] === o[0];
        return '<button class="opt" data-q="' + (multi ? "toggle" : "pick") + '" data-k="' + key + '" data-v="' + o[0] + '" aria-pressed="' + on + '">' + esc(o[1]) + (o[2] ? "<small>" + esc(o[2]) + "</small>" : "") + "</button>";
      }).join("") + "</div>";
    }
    var body;
    if (qstep === 0) body = '<span class="qkick">30 seconds</span><h3>What are you working toward?</h3><p>We\'ll build a week of our meals around it.</p>' +
      opts("goal", Object.keys(GOALS).map(function (k) { return [k, GOALS[k].label, GOALS[k].note]; }));
    else if (qstep === 1) body = "<h3>Anything you avoid?</h3><p>Pick any that apply.</p>" +
      opts("avoid", [["gluten", "Gluten"], ["dairy", "Dairy"]], true) +
      '<button class="qnext" data-q="next">' + (qa.avoid.length ? "Next" : "No restrictions, next") + "</button>";
    else if (qstep === 2) body = "<h3>How many of our meals a day?</h3><p>Most people eat one or two of ours and handle the rest.</p>" +
      opts("perDay", [[1, "One a day", "Usually lunch"], [2, "Two a day", "Lunch and dinner"], [3, "Three a day", "We cover most of your eating"]]);
    else if (qstep === 3) {
      var picking = qa.days && qa.days !== "wk" && qa.days !== "all";
      body = "<h3>Which days?</h3>" +
        opts("days", [["wk", "Weekdays", "Monday to Friday"], ["all", "Every day", "All seven days"], ["pick", "Let me pick"]]).replace('data-v="pick" aria-pressed="false"', 'data-v="pick" aria-pressed="' + picking + '"');
      if (picking) body += '<div class="daychips">' + DAYS.map(function (D, i) { return '<button data-q="day" data-v="' + i + '" aria-pressed="' + (qa.days.indexOf(i) >= 0) + '">' + D.short + "</button>"; }).join("") + '</div><button class="qnext" data-q="next"' + (qa.days.length ? "" : " disabled") + ">Next</button>";
    } else {
      var g = GOALS[qa.goal];
      body = "<h3>Last one: what do you weigh?</h3><p>We use it to estimate your daily calories and protein. It stays on this device.</p>" +
        (qa.own
          ? '<div class="qrow"><input id="qCal" type="number" inputmode="numeric" placeholder="Calories" value="' + esc(qa.cal) + '"><input id="qPro" type="number" inputmode="numeric" placeholder="Protein (g)" value="' + esc(qa.pro) + '"></div>'
          : '<div class="qrow"><input id="qW" type="number" inputmode="numeric" placeholder="e.g. 180" value="' + esc(qa.weight) + '"><span>lbs</span></div>') +
        '<button class="qnext" data-q="build">Build my week</button>' +
        '<button class="qlink" data-q="own">' + (qa.own ? "Use my weight instead" : "I already know my numbers") + "</button>" +
        '<button class="qlink" data-q="skip">Skip, use typical numbers (' + fmt(g.dflt[0]) + " cal · " + g.dflt[1] + "g)</button>" +
        '<p class="qnote">An estimate to plan with, not medical advice.</p>';
    }
    q.innerHTML = head + back + body;
  }
  function quizClick(b) {
    var a = b.dataset.q;
    if (a === "back") { qstep--; return drawQuiz(); }
    if (a === "pick") {
      var k = b.dataset.k, v = b.dataset.v;
      if (k === "perDay") v = +v;
      if (k === "days") { qa.days = v === "pick" ? [] : v; if (v === "pick") return drawQuiz(); }
      else qa[k] = v;
      qstep++; return drawQuiz();
    }
    if (a === "toggle") { var i = qa.avoid.indexOf(b.dataset.v); if (i >= 0) qa.avoid.splice(i, 1); else qa.avoid.push(b.dataset.v); return drawQuiz(); }
    if (a === "day") { var d = +b.dataset.v, j = qa.days.indexOf(d); if (j >= 0) qa.days.splice(j, 1); else qa.days.push(d); return drawQuiz(); }
    if (a === "next") { qstep++; return drawQuiz(); }
    if (a === "own") { readQuizInputs(); qa.own = !qa.own; return drawQuiz(); }
    if (a === "skip") { qa.weight = ""; qa.own = false; return buildWeek(); }
    if (a === "build") { readQuizInputs(); return buildWeek(); }
  }
  function readQuizInputs() {
    var w = $(R, "#qW"), c = $(R, "#qCal"), p = $(R, "#qPro");
    if (w) qa.weight = w.value; if (c) qa.cal = c.value; if (p) qa.pro = p.value;
  }
  function round(n, to) { return Math.round(n / to) * to; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  // Goal numbers: body weight × a per-pound rate for the chosen goal (or the customer's own numbers)
  function goalNumbers() {
    var g = GOALS[qa.goal], w = +qa.weight;
    if (qa.own && +qa.cal > 0 && +qa.pro > 0) return [+qa.cal, +qa.pro];
    if (w >= 80 && w <= 500) return [clamp(round(w * g.calPerLb, 50), 1200, 4500), clamp(round(w * g.proPerLb, 5), 60, 300)];
    return g.dflt;
  }
  function fits(m) {
    return (qa.avoid.indexOf("gluten") < 0 || m.badges.indexOf("Gluten Free") >= 0) && (qa.avoid.indexOf("dairy") < 0 || m.badges.indexOf("Dairy Free") >= 0);
  }
  function quizDays() { return qa.days === "wk" ? [0, 1, 2, 3, 4] : qa.days === "all" ? [0, 1, 2, 3, 4, 5, 6] : qa.days.slice().sort(); }
  function buildWeek() {
    var nums = goalNumbers(), g = GOALS[qa.goal], days = quizDays();
    st.cal = nums[0]; st.pro = nums[1]; st.quiz = qa; st.packs = []; st.pieces = []; st.pushed = false;
    var meals = DATA.items.filter(function (m) { return m.kind === "meal" && fits(m); });
    // Lean: most protein per calorie first; build: most protein first; maintain: menu order
    var size = function (m) { for (var i = 0; i < g.size.length; i++) { var s = m.sizes.filter(function (z) { return z.name === g.size[i]; })[0]; if (s) return s; } return m.sizes[0]; };
    if (qa.goal === "lean") meals.sort(function (a, b) { return size(b).protein / size(b).cal - size(a).protein / size(a).cal; });
    if (qa.goal === "build") meals.sort(function (a, b) { return size(b).protein - size(a).protein; });
    var k = 0, added = [];
    if (meals.length) days.forEach(function (d) { for (var j = 0; j < qa.perDay; j++) { var m = meals[k++ % meals.length]; takePiece(m.id, size(m).option_id, d); } });
    // Top up protein toward our share of the day (one meal of three = a third), with protein sides or bites
    var share = Math.min(1, qa.perDay / 3), proSides = DATA.items.filter(function (m) { return m.kind === "side" && fits(m) && m.sizes[0].protein >= 25; })
      .sort(function (a, b) { return b.sizes[0].protein - a.sizes[0].protein; });
    var bites = DATA.items.filter(function (m) { return m.kind === "snack" && fits(m) && /protein bite/i.test(m.name); })[0];
    if (meals.length) days.forEach(function (d, di) {
      for (var t = 0; t < 2; t++) {
        var T = dayTotals(d), gap = st.pro * share - T.pro, room = st.cal * share + 150 - T.cal;
        // finish a container already opened before starting another one
        var spareSide = proSides.filter(function (m) { return st.pieces.some(function (p) { return p.id === m.id && p.day < 0; }); })[0];
        if (gap >= 20 && proSides.length) { var s = spareSide || proSides[di % proSides.length]; if (s.sizes[0].cal > room) break; takePiece(s.id, s.sizes[0].option_id, d); added.push("side"); }
        else if (gap >= 8 && bites) { if (bites.sizes[0].cal > room) break; takePiece(bites.id, bites.sizes[0].option_id, d); added.push("bite"); }
        else break;
      }
    });
    st.view = days[0] || 0;
    fullView = false; dayOpen = false; swapFor = null;
    endQuiz(); selected = null; render();
    var spare = st.pieces.filter(function (p) { return p.day < 0; }).length;
    var avoid = qa.avoid.map(function (a) { return a === "gluten" ? "gluten free" : "dairy free"; }).join(" + ");
    $(R, "#built").innerHTML = meals.length
      ? "<b>Built for you.</b> Tap a day to see it. Swap anything, or drag it to another day." +
        (spare ? " Your order also has " + spare + " extra serving" + (spare > 1 ? "s" : "") + " to eat whenever you like." : "")
      : "<b>Nothing on this week's menu fits all of those.</b> Try fewer restrictions, or pick by hand below.";
    // land on the filled calendar, with the "built for you" note right above it
    var b = $(R, "#built"), calBlock = $(R, ".calwrap").parentNode;
    calBlock.parentNode.insertBefore(b, calBlock);
    b.hidden = false;
    b.scrollIntoView({ block: "start" });
  }
  // ------------------------------------------------------------------ the button on the menu page
  function mountButton() {
    var nav = document.querySelector("nav.sk-menus-filters") || (document.querySelector("a.sk-menus-filter") || {}).parentElement;
    btn = el("button", "sk-menus-filter tskp-plan-btn");
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "dialog");
    btn.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="vertical-align:-2px;margin-right:6px"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 7h12M5 1v4M11 1v4"/></svg>Build Your Week';
    btn.style.cssText = "display:inline-flex;align-items:center;flex-direction:row;background:#d9b46f;color:#2b230f;border-color:#d9b46f;font-weight:800;cursor:pointer";
    btn.addEventListener("click", open);
    if (nav) nav.appendChild(btn);
    // "My week" pill: only once something is planned, so returning visitors can pick up where they left off
    pill = el("button", "tskp-pill");
    pill.type = "button";
    pill.style.cssText = "position:fixed;right:calc(16px + env(safe-area-inset-right,0px));bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:2147483000;background:#2e3a18;color:#fff;border:2px solid #d9b46f;border-radius:16px;padding:9px 14px;font:600 13px 'Plus Jakarta Sans',Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);cursor:pointer;display:none;text-align:left";
    pill.addEventListener("click", open);
    document.body.appendChild(pill);
  }

  // ------------------------------------------------------------------ the planner sheet (shadow DOM keeps site CSS out)
  var CSS = "\n:host{all:initial}\n*{box-sizing:border-box}\n[hidden]{display:none!important}\n.wrap{--green:#73933c;--green-ink:#4f6a24;--forest:#2e3a18;--gold:#d9b46f;--bg:#f6f6f1;--card:#fff;--fg:#1d2314;--muted:#646b58;--line:#e2e3d8;--track:#e9ebe0;--over:#b5502f;--chip:#eef2e4;--chip-line:#cfd9b8;--today:#fbf5e8;--font:'Plus Jakarta Sans','Helvetica Neue',Arial,sans-serif;--score:'Bungee','Arial Black',Impact,sans-serif;font-family:var(--font);color:var(--fg);font-size:15px;line-height:1.5}\nbutton{font:inherit}\nbutton:focus-visible,input:focus-visible,.chip:focus-visible,.zone:focus-visible{outline:3px solid var(--gold);outline-offset:2px}\n.scrim{position:fixed;inset:0;background:rgba(10,14,6,.5);z-index:2147483001}\n.sheet{position:fixed;left:0;right:0;bottom:0;z-index:2147483002;background:#fff;border-radius:18px 18px 0 0;max-height:94%;overflow-y:auto;box-shadow:0 -10px 30px rgba(0,0,0,.25);padding:18px max(16px,env(safe-area-inset-right,0px)) calc(0px + env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px))}\n.in{max-width:980px;margin:0 auto;display:flex;flex-direction:column;gap:16px}\n.head{display:flex;justify-content:space-between;align-items:center;gap:12px}\n.head h2{margin:0;font-size:22px;font-weight:800}\n.x{background:none;border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:4px 10px;cursor:pointer}\n.goals{display:grid;grid-template-columns:1fr 1fr;gap:10px;max-width:520px}\n.goals label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--muted);min-width:0}\n.goals input{font:inherit;font-size:17px;font-weight:700;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;width:100%}\n.how,.hint2{font-size:13px;color:var(--muted);margin:0;max-width:65ch}\nh3.step{display:flex;align-items:center;gap:10px;margin:0 0 4px;font-size:17px;font-weight:800}\nh3.step .sn{font-family:var(--score);font-weight:400;font-size:12px;background:var(--forest);color:var(--gold);border-radius:6px;padding:3px 8px;white-space:nowrap}\n.hint2{margin:0 0 8px}\n.top2{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}\n.ptabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}\n.ptabs button{border:1px solid var(--line);background:none;color:var(--muted);border-radius:999px;padding:4px 12px;font-size:13px;font-weight:700;cursor:pointer}\n.ptabs button[aria-pressed=true]{background:var(--green);border-color:var(--green);color:#fff}\n.plist{max-height:230px;overflow-y:auto;border:1px solid var(--line);border-radius:10px}\n.prow{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;padding:7px 10px;border-top:1px solid var(--line);font-size:14px}\n.prow:first-child{border-top:0}\n.prow small{display:block;color:var(--muted);font-size:12px}\n.prow .pr{font-weight:700;font-size:13px}\n.add{font-size:13px;font-weight:700;background:var(--green);color:#fff;border:0;border-radius:8px;padding:5px 10px;cursor:pointer;white-space:nowrap}\n.add .ct{background:rgba(255,255,255,.25);border-radius:10px;padding:0 6px;margin-left:4px}\n.zone{border-radius:10px;border:1.5px dashed transparent}\n.zone.hot{border-color:var(--green)!important;background:var(--chip)!important}\n.tray .zone{display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start;padding:6px;background:var(--bg);border-color:var(--line);min-height:60px;max-height:230px;overflow-y:auto}\n.hint{color:var(--muted);font-size:13px;padding:2px 4px}\n.chip{display:inline-flex;align-items:center;gap:6px;background:var(--chip);border:1px solid var(--chip-line);border-radius:8px;padding:5px 8px;font-size:13px;line-height:1.2;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;max-width:100%;min-width:0}\n.chip b{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}\n.chip small{color:var(--muted);white-space:nowrap}\n.chip.meal{border-left:4px solid var(--green)}\n.chip.side{border-left:4px solid #8a9a6b}\n.chip.snack{border-left:4px solid var(--gold)}\n.chip.sel{outline:3px solid var(--gold);outline-offset:1px}\n.chip.lifting{opacity:.35}\n.chip .back{background:none;border:0;color:var(--muted);cursor:pointer;padding:0 2px;font-size:15px;line-height:1}\n.ghost{position:fixed;z-index:2147483005;pointer-events:none;box-shadow:0 8px 20px rgba(0,0,0,.3);transform:rotate(-2deg)}\n.calwrap{border:1px solid var(--line);border-radius:14px;overflow:hidden}\n.calhead{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;padding:10px 14px;background:var(--forest);color:#fff}\n.calhead b{font-size:16px}.calhead span{font-size:12px;color:#d8dccb}\n.cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}\n.cell{border:0;border-left:1px solid var(--line);border-radius:0;padding:8px 6px;min-height:220px;display:flex;flex-direction:column;gap:6px;cursor:pointer;min-width:0}\n.cell:first-child{border-left:0}\n.cell.view{background:var(--today);box-shadow:inset 0 -3px 0 var(--gold)}\n.dh{display:flex;align-items:baseline;justify-content:space-between;gap:4px}\n.dh b{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}\n.dh span{font-size:20px;font-weight:800;line-height:1}\n.cell .chips{display:flex;flex-direction:column;gap:4px;flex:1}\n.cell .chips .chip{font-size:12px;padding:4px 6px;gap:4px}\n.cell .chips .chip small{display:none}\n.count{display:none;font-size:12px;color:var(--muted);flex:1}\n.tot{font-size:11px;color:var(--muted);line-height:1.35}\n.tot b{color:var(--fg);font-family:var(--score);font-weight:400;font-size:12px}\n.bars{display:flex;flex-direction:column;gap:3px}\n.bars span{height:5px;border-radius:3px;background:var(--track);overflow:hidden}\n.bars i{display:block;height:100%;background:var(--green);transition:width .35s}\n.bars i.pro{background:var(--gold)}.bars i.over{background:var(--over)}\n.star{color:var(--gold);font-size:14px;line-height:1}\n.picking .cell{box-shadow:inset 0 0 0 2px var(--gold)}\n.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);padding:8px 14px;border-top:1px solid var(--line)}\n.legend i{display:inline-block;width:18px;height:5px;border-radius:3px;vertical-align:middle;margin-right:5px}\n.detail{border:1px solid var(--line);border-radius:14px;padding:12px 14px;display:grid;grid-template-columns:1fr 300px;gap:14px}\n.detail h3{margin:0 0 6px;font-size:17px;font-weight:800}\n.detail .zone{display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start;min-height:52px;padding:6px;border-color:var(--line)}\n.rings{display:grid;grid-template-columns:1fr 1fr;gap:10px}\n.ring{position:relative;display:grid;place-items:center;background:var(--forest);border-radius:14px;padding:10px 6px 8px;color:#fff}\n.ring svg{width:108px;height:108px;transform:rotate(-90deg)}\n.ring circle{fill:none;stroke-width:10}.ring .bg{stroke:rgba(255,255,255,.14)}\n.ring .fg{stroke-linecap:round;transition:stroke-dashoffset .6s cubic-bezier(.3,1.4,.5,1)}\n.ring .mid{position:absolute;top:10px;height:108px;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1}\n.ring .big{font-family:var(--score);font-size:22px}\n.ring .of{font-size:10px;color:#c9cfb8;margin-top:4px}\n.ring .cap{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);margin-top:4px}\n.ring.full{box-shadow:0 0 0 3px var(--gold),0 0 18px rgba(217,180,111,.6)}\n.ring .rstar{position:absolute;top:6px;right:8px;font-size:16px;color:var(--gold)}\n.youleft{border:2px dashed var(--line);border-radius:12px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}\n.youleft span{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}\n.youleft b{font-family:var(--score);font-size:16px;font-weight:400}\n.youleft.over b{color:var(--over)}\n.pop{position:fixed;z-index:2147483006;pointer-events:none;font-family:var(--score);font-size:18px;color:var(--green-ink);text-shadow:0 2px 0 #fff,0 0 8px #fff;animation:floatup 1.1s ease-out forwards}\n.pop.pro{color:#b88a2e}\n@keyframes floatup{0%{opacity:0;transform:translate(-50%,0) scale(.6)}15%{opacity:1;transform:translate(-50%,-8px) scale(1.15)}100%{opacity:0;transform:translate(-50%,-60px) scale(1)}}\n.order ul{list-style:none;margin:0;padding:0;columns:2;column-gap:24px}\n.order li{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:6px 0;border-top:1px solid var(--line);font-size:14px;break-inside:avoid}\n.order li small{color:var(--muted)}\n.rm{font-size:12px;background:none;border:1px solid var(--line);color:var(--muted);border-radius:6px;padding:2px 8px;cursor:pointer}\n.foot{font-size:12px;color:var(--muted);margin:0}\n.reset{font-size:12px;background:none;border:0;color:var(--green-ink);text-decoration:underline;cursor:pointer;padding:0}\n.cartbar{position:sticky;bottom:0;background:#fff;border-top:1px solid var(--line);padding:12px 0 calc(12px + env(safe-area-inset-bottom,0px));display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;z-index:3}\n.sum{font-size:14px}\n.member{margin-top:4px;font-size:13px;background:var(--today);border:1px solid var(--gold);border-radius:8px;padding:4px 10px;display:inline-block}\n.member b{color:var(--green-ink)}.member span{color:var(--muted)}\n.lock{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}\n.tocart{background:var(--green);color:#fff;border:0;border-radius:10px;padding:11px 18px;font-weight:800;font-size:15px;cursor:pointer}\n.tocart:disabled{opacity:.45;cursor:default}\n.msg{width:100%;font-size:14px;font-weight:600}\n.msg.err{color:var(--over)}\n.choice{width:100%;display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:14px;background:var(--today);border:1px solid var(--gold);border-radius:10px;padding:10px 12px}\n.choice button{border:1px solid var(--forest);background:#fff;border-radius:8px;padding:6px 12px;font-weight:700;cursor:pointer}\n.choice button.primary{background:var(--forest);color:#fff}\n@media (max-width:760px){.top2{grid-template-columns:1fr}.cell{min-height:112px;padding:6px 3px;gap:4px}.dh{flex-direction:column;align-items:center;gap:2px}.dh b{font-size:10px;letter-spacing:.04em}.dh span{font-size:16px}.cell .chips{display:none}.count{display:block;text-align:center;font-size:11px}.tot{text-align:center;font-size:10px}.tot b{font-size:11px;display:block}.tot .l2{display:none}.detail{grid-template-columns:1fr}.order ul{columns:1}}\n@media (prefers-reduced-motion:reduce){.bars i,.ring .fg{transition:none}.pop{display:none}}\n.in.quizzing>:not(.head):not(#quiz){display:none!important}\n.in.quizzing .redo{display:none}\n.redo{background:none;border:0;color:var(--green-ink);text-decoration:underline;font-size:13px;cursor:pointer;padding:0;margin-right:12px}\n.hbtns{display:flex;align-items:center}\n#quiz{max-width:560px;width:100%;margin:8px auto 24px;display:flex;flex-direction:column;gap:14px}\n.qdots{display:flex;gap:6px}.qdots i{flex:1;height:5px;border-radius:3px;background:var(--track)}.qdots i.on{background:var(--gold)}\n.qkick{font-family:var(--score);font-size:12px;color:var(--gold);background:var(--forest);border-radius:6px;padding:3px 8px;align-self:flex-start}\n#quiz h3{margin:0;font-size:24px;font-weight:800;line-height:1.2}\n#quiz p{margin:0;color:var(--muted);font-size:14px}\n.opts{display:flex;flex-direction:column;gap:10px}\n.opt{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;border:2px solid var(--line);background:#fff;border-radius:12px;padding:14px 16px;cursor:pointer;font-size:16px;font-weight:700;color:var(--fg)}\n.opt small{font-size:13px;font-weight:500;color:var(--muted)}\n.opt[aria-pressed=true]{border-color:var(--green);background:var(--chip)}\n.daychips{display:flex;flex-wrap:wrap;gap:8px}\n.daychips button{border:2px solid var(--line);background:#fff;border-radius:999px;padding:8px 14px;font-weight:700;cursor:pointer}\n.daychips button[aria-pressed=true]{border-color:var(--green);background:var(--green);color:#fff}\n.qrow{display:flex;gap:10px;flex-wrap:wrap;align-items:center}\n.qrow input{font:inherit;font-size:20px;font-weight:700;width:140px;border:2px solid var(--line);border-radius:10px;padding:10px 12px}\n.qnext{background:var(--green);color:#fff;border:0;border-radius:12px;padding:14px 20px;font-weight:800;font-size:16px;cursor:pointer;align-self:flex-start}\n.qnext:disabled{opacity:.4;cursor:default}\n.qlink{background:none;border:0;color:var(--green-ink);text-decoration:underline;cursor:pointer;padding:0;font-size:14px;align-self:flex-start}\n.qback{background:none;border:0;color:var(--muted);cursor:pointer;padding:0;font-size:13px;align-self:flex-start}\n.qnote{font-size:12px!important}\n.gline,.modebar,.dlist,.dclose{display:none}\n.gline{font-size:14px;color:var(--muted)}.gline b{color:var(--fg)}\n.gline button{background:none;border:0;color:var(--green-ink);text-decoration:underline;cursor:pointer;padding:0;font-size:14px}\n.modebar{justify-content:flex-start}\n.modebtn{background:#fff;border:1.5px solid var(--forest);color:var(--forest);border-radius:10px;padding:9px 14px;font-weight:700;font-size:14px;cursor:pointer}\n.dhead{display:flex;justify-content:space-between;align-items:center;gap:8px}\n.dclose{background:var(--forest);color:#fff;border:0;border-radius:8px;padding:6px 14px;font-weight:700;cursor:pointer}\n.drow{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--line);flex-wrap:wrap}\n.drow .chip{flex:1 1 auto}\n.drow .sw,.drow .rmv{background:#fff;border:1px solid var(--line);border-radius:8px;padding:5px 10px;font-size:13px;font-weight:700;cursor:pointer;color:var(--fg)}\n.drow .rmv{color:var(--muted)}\n.alts{width:100%;display:flex;flex-direction:column;gap:4px;padding:4px 0 6px 12px}\n.alts button{text-align:left;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:13px;cursor:pointer;color:var(--fg)}\n.alts button small{color:var(--muted)}\n.dhint{font-size:12px;color:var(--muted);margin:6px 0 0}\n.in.simple>.goals,.in.simple>.how,.in.simple>.top2,.in.simple>.order,.in.simple>.foot,.in.simple .step,.in.simple .hint2,.in.simple .legend,.in.simple .lock,.in.simple .redo{display:none!important}\n.in.simple .gline,.in.simple .dlist,.in.simple .dclose{display:block}\n.in.simple .modebar,.in.full .modebar{display:flex}\n.in.simple>.detail{display:none}\n.in.simple.dayopen>.detail{display:grid;grid-template-columns:1fr;position:fixed;left:0;right:0;bottom:0;z-index:6;max-height:52%;overflow-y:auto;background:#fff;border-radius:18px 18px 0 0;box-shadow:0 -10px 30px rgba(0,0,0,.25);padding:14px max(16px,env(safe-area-inset-right,0px)) calc(16px + env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px))}\n.in.simple #dZone{display:none}\n.in.simple.dayopen>.gline,.in.simple.dayopen>.built,.in.simple.dayopen>.modebar{display:none!important}\n.in.simple.dayopen>.detail{overflow-x:hidden}\n.sheet.tall{height:94%}\n.in.simple.dayopen>.detail>div{min-width:0}\n.drow .chip{flex:1 1 0;min-width:0}\n.in.simple .rings .ring svg{width:84px;height:84px}.in.simple .ring .mid{height:84px}.in.simple .ring .big{font-size:18px}\n.in.simple .built{font-size:13px;padding:8px 12px}\n.weekly{display:flex;flex-direction:column;gap:6px;font-size:13px;max-width:340px}\n.weekly label{display:flex;gap:8px;align-items:flex-start;cursor:pointer}\n.weekly input[type=checkbox]{width:18px;height:18px;margin:1px 0 0;accent-color:var(--green);flex:none}\n.weekly input[type=email]{font:inherit;font-size:15px;border:1px solid var(--line);border-radius:8px;padding:7px 10px}\n.built{border:2px solid var(--gold);background:var(--today);border-radius:12px;padding:10px 14px;font-size:14px}\n.built b{font-weight:800}\n";

  function mountSheet() {
    host = el("div"); host.id = "tsk-planner";
    document.body.appendChild(host);
    R = host.attachShadow({ mode: "open" });
    R.innerHTML = "<style>" + CSS + "</style>" +
      '<div class="wrap"><div class="scrim" hidden></div>' +
      '<section class="sheet" role="dialog" aria-modal="true" aria-label="Build your week" hidden><div class="in">' +
      '<div class="head"><h2 id="sheetTitle">Build your week</h2><div class="hbtns"><button class="redo" data-a="quiz">Redo my answers</button><button class="x" data-a="close">Close</button></div></div>' +
      '<div id="quiz" hidden></div><div class="gline" id="gline"></div><div class="built" id="built" hidden></div>' +
      '<div class="modebar" id="modebar" hidden><button class="modebtn" data-a="mode"></button></div>' +
      '<div class="goals"><label>Your whole day: calories<input id="gCal" type="number" inputmode="numeric" min="0" step="50"></label>' +
      '<label>Your whole day: protein (g)<input id="gPro" type="number" inputmode="numeric" min="0" step="5"></label></div>' +
      '<p class="how">Enter your goal for the full day. As you drop food onto the calendar, each day shows how much our food covers and what\'s left for you to make or grab on your own.</p>' +
      '<div class="top2"><div><h3 class="step"><span class="sn">Step 1</span>Pick from this week\'s menu</h3><p class="hint2">Tap Add on anything you want this week.</p>' +
      '<div class="ptabs" role="group" aria-label="Menu section"></div><div class="plist"></div></div>' +
      '<div class="tray"><h3 class="step"><span class="sn">Step 2</span><span id="trayTitle">In my basket</span></h3><p class="hint2">Everything you picked waits here until you give it a day.</p><div class="zone" id="tray" data-day="-1"></div></div></div>' +
      '<div><h3 class="step"><span class="sn">Step 3</span>Put each item on a day</h3><p class="hint2">Drag from your basket onto the calendar, or tap an item and then tap a day. Tap a day to see its score.</p>' +
      '<div class="calwrap"><div class="calhead"><b id="wk"></b><span id="dl"></span></div><div class="cal" id="cal"></div>' +
      '<div class="legend"><span><i style="background:#73933c"></i>Calories from us</span><span><i style="background:#d9b46f"></i>Protein from us</span><span>Bars fill toward your whole-day goal</span></div></div></div>' +
      '<div class="detail"><div><div class="dhead"><h3 id="dTitle"></h3><button class="dclose" data-a="dayclose">Done</button></div><div class="zone" id="dZone" data-day="0"></div><div class="dlist" id="dList"></div></div><div id="score"></div></div>' +
      '<div class="order"><h3 class="step"><span class="sn">Step 4</span>Your entire order</h3><p class="hint2">Check it over, then check out. Your week plan unlocks as soon as you\'ve paid.</p><ul id="orderList"></ul></div>' +
      '<p class="foot">Nutrition comes from each item\'s page. Sides and snacks split into the servings or pieces listed there. Your plan stays saved on this device. <button class="reset" data-a="reset">Start over</button></p>' +
      '<div class="cartbar"><div class="sum" id="sum"></div><div class="lock"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>Week plan PDF unlocks after checkout</div>' +
      '<div class="weekly" id="weekly" hidden><label><input type="checkbox" id="wkOpt"><span>Email me a freshly built week every Thursday, from these goals</span></label>' +
      '<input id="wkEmail" type="email" inputmode="email" autocomplete="email" placeholder="Your email" hidden></div>' +
      '<button class="tocart" data-a="checkout">Check out</button><div class="msg" id="msg" hidden></div><div class="choice" id="choice" hidden></div></div>' +
      "</div></section></div>";
    sheet = $(R, ".sheet");
    $(R, "#wk").textContent = "Week of " + DAYS[0].date.toLocaleString("en-US", { month: "long" }) + " " + DAYS[0].n;
    $(R, "#dl").textContent = DATA.delivery ? "Delivered " + DATA.delivery.replace(/(day), /g, "$1 ") : "";
    var cal = $(R, "#cal");
    DAYS.forEach(function (D, i) {
      var c = el("div", "cell zone");
      c.dataset.day = i; c.tabIndex = 0; c.id = "cell" + i;
      c.setAttribute("aria-label", D.long + " " + D.mon + " " + D.n);
      c.innerHTML = '<div class="dh"><b id="dn' + i + '">' + D.short + '</b><span>' + D.n + '</span></div><div class="chips" id="ch' + i + '"></div><div class="count" id="ct' + i + '"></div><div class="tot" id="t' + i + '"></div><div class="bars"><span><i id="bc' + i + '"></i></span><span><i class="pro" id="bp' + i + '"></i></span></div>';
      cal.appendChild(c);
    });
    $(R, "#score").innerHTML = '<div class="rings">' + ["cal", "pro"].map(function (k) {
      return '<div class="ring" id="ring-' + k + '"><svg viewBox="0 0 108 108" aria-hidden="true"><circle class="bg" cx="54" cy="54" r="46"/><circle class="fg" id="arc-' + k + '" cx="54" cy="54" r="46" stroke="' + (k === "cal" ? "#8fb04f" : "#d9b46f") + '" stroke-dasharray="' + CIRC + '" stroke-dashoffset="' + CIRC + '"/></svg><div class="mid"><span class="big" id="num-' + k + '">0</span><span class="of" id="of-' + k + '"></span></div><span class="cap">' + (k === "cal" ? "Calories" : "Protein") + ' from us</span></div>';
    }).join("") + '</div><div class="youleft" id="youLeft"><span>Left for you</span><b id="leftNum"></b></div>';
    renderPicker();
    wire();
    wireWeekly();
  }

  function renderPicker() {
    var tabs = $(R, ".ptabs"); tabs.innerHTML = "";
    GROUPS.forEach(function (g, i) {
      var b = el("button", null, esc(g.title)); b.setAttribute("aria-pressed", i === ptab);
      b.addEventListener("click", function () { ptab = i; renderPicker(); render(); });
      tabs.appendChild(b);
    });
    var list = $(R, ".plist"); list.innerHTML = ""; list.scrollTop = 0;
    GROUPS[ptab].items.forEach(function (m) {
      m.sizes.forEach(function (s) {
        var unit = m.kind === "side" ? " · " + m.serv + " servings" : m.serv > 1 ? " · " + m.serv + " pieces" : "";
        var row = el("div", "prow", "<div>" + esc(m.short) + (m.kind === "meal" ? " · " + esc(s.name) : "") +
          "<small>" + s.cal + " cal · " + s.protein + "g protein" + (m.serv > 1 ? " each" : "") + unit + "</small></div><div class=\"pr\">$" + s.price.toFixed(2) + "</div>");
        var b = el("button", "add"); b.dataset.k = m.id + "|" + s.option_id;
        b.addEventListener("click", function () { addPack(m.id, s.option_id); render(); });
        row.appendChild(b); list.appendChild(row);
      });
    });
  }

  function chip(p, compact, noBack) {
    var x = info(p), m = x.m, sz = x.sz;
    var c = el("div", "chip " + m.kind + (selected === p.uid ? " sel" : ""));
    c.dataset.uid = p.uid; c.tabIndex = 0;
    var tag = m.kind === "meal" && m.sizes.length > 1 ? " <small>" + esc(compact ? (ABBR[sz.name] || sz.name) : sz.name) + "</small>" : "";
    c.innerHTML = "<b>" + esc(m.short) + "</b>" + tag + "<small>" + sz.cal + " cal · " + sz.protein + "g</small>";
    if (p.day >= 0 && !compact && !noBack) {
      var back = el("button", "back", "×"); back.setAttribute("aria-label", "Take off this day");
      back.addEventListener("click", function (e) { e.stopPropagation(); p.day = -1; render(); });
      c.appendChild(back);
    }
    return c;
  }
  function dayTotals(i) {
    var on = st.pieces.filter(function (p) { return p.day === i; }), cal = 0, pro = 0;
    on.forEach(function (p) { var x = info(p); cal += x.sz.cal; pro += x.sz.protein; });
    return { on: on, cal: cal, pro: pro };
  }
  function bar(b, have, goal) { var pct = goal > 0 ? have / goal * 100 : 0; b.style.width = Math.min(pct, 100) + "%"; b.classList.toggle("over", pct > 100); }

  function countTo(k, target, sfx) {
    var e = $(R, "#num-" + k), from = shown[k]; shown[k] = target;
    if (reduced() || from === target) { e.textContent = fmt(target) + sfx; return; }
    var t0 = performance.now();
    (function step(t) { var f = Math.min(1, (t - t0) / 550), q = 1 - Math.pow(1 - f, 3); e.textContent = fmt(from + (target - from) * q) + sfx; if (f < 1) requestAnimationFrame(step); })(t0);
  }

  // ------------------------------------------------------------------ simple view: after the quiz the calendar is the whole screen;
  // "Add or change food" opens the full builder. Tapping a day slides up that day with Swap / Remove (drag still works).
  var fullView = false, dayOpen = false, swapFor = null;
  function isSimple() { return !!(st.quiz && st.packs.length && !fullView); }
  function sameFilters(m) {
    var q = st.quiz || { avoid: [] };
    return (q.avoid.indexOf("gluten") < 0 || m.badges.indexOf("Gluten Free") >= 0) && (q.avoid.indexOf("dairy") < 0 || m.badges.indexOf("Dairy Free") >= 0);
  }
  function alternatives(p) {
    var cur = info(p), m = cur.m, hiPro = m.sizes[0].protein >= 15;
    return DATA.items.filter(function (x) {
      return x.id !== m.id && x.kind === m.kind && sameFilters(x) && (x.kind !== "side" || (x.sizes[0].protein >= 15) === hiPro);
    }).map(function (x) {
      var s = x.sizes.filter(function (z) { return z.name === cur.sz.name; })[0] || x.sizes[0];
      return { m: x, sz: s };
    }).sort(function (a, b) { return b.sz.protein - a.sz.protein; }).slice(0, 6);
  }
  // Take one piece off the plan: a lone item leaves the order; a serving from a shared container goes back to the basket
  function removePiece(uid) {
    var p = st.pieces.filter(function (x) { return x.uid === uid; })[0]; if (!p) return;
    var others = st.pieces.filter(function (x) { return x.pid === p.pid && x.uid !== uid && x.day >= 0; });
    if (others.length) { p.day = -1; return; }
    st.packs = st.packs.filter(function (k) { return k.pid !== p.pid; });
    st.pieces = st.pieces.filter(function (x) { return x.pid !== p.pid; });
  }
  function swapPiece(uid, id, opt) {
    var p = st.pieces.filter(function (x) { return x.uid === uid; })[0]; if (!p) return;
    var day = p.day; removePiece(uid); var n = takePiece(id, opt, day);
    swapFor = null; render(); popAt(day, n);
  }
  function renderDayList(T) {
    var box = $(R, "#dList"); box.innerHTML = "";
    if (!T.on.length) { box.innerHTML = '<p class="dhint">Nothing on this day. Tap "Add or change food" to add something.</p>'; return; }
    T.on.forEach(function (p) {
      var row = el("div", "drow"); row.appendChild(chip(p, false, true));
      var sw = el("button", "sw", swapFor === p.uid ? "Cancel" : "Swap"); sw.dataset.a = "swap"; sw.dataset.uid = p.uid;
      var rm = el("button", "rmv", "Remove"); rm.dataset.a = "remove"; rm.dataset.uid = p.uid;
      row.appendChild(sw); row.appendChild(rm);
      if (swapFor === p.uid) {
        var alts = el("div", "alts"), cur = info(p);
        alternatives(p).forEach(function (a) {
          var d = a.sz.protein - cur.sz.protein;
          var b = el("button", null, esc(a.m.short) + (a.m.kind === "meal" && a.m.sizes.length > 1 ? " · " + esc(a.sz.name) : "") +
            " <small>" + a.sz.cal + " cal · " + a.sz.protein + "g" + (d ? " (" + (d > 0 ? "+" : "") + d + "g)" : "") + "</small>");
          b.dataset.a = "pickalt"; b.dataset.uid = p.uid; b.dataset.id = a.m.id; b.dataset.opt = a.sz.option_id;
          alts.appendChild(b);
        });
        if (!alts.children.length) alts.innerHTML = '<p class="dhint">Nothing else like this on this week\'s menu.</p>';
        row.appendChild(alts);
      }
      box.appendChild(row);
    });
    box.insertAdjacentHTML("beforeend", '<p class="dhint">Tip: drag an item up onto another day to move it.</p>');
  }

  function render() {
    if (!R) return;
    var simple = isSimple(), IN = $(R, ".in");
    IN.classList.toggle("simple", simple);
    IN.classList.toggle("full", !simple && !!st.quiz && !!st.packs.length);
    IN.classList.toggle("dayopen", simple && dayOpen);
    sheet.classList.toggle("tall", simple && dayOpen);
    $(R, "#sheetTitle").textContent = simple ? "Your week" : "Build your week";
    $(R, "#gline").innerHTML = st.quiz ? "<b>" + esc(goalsSummary()) + "</b> · " + fmt(st.cal) + " cal · " + st.pro + 'g protein a day · <button data-a="quiz">Edit</button>' : "";
    $(R, "#modebar").hidden = !(st.quiz && st.packs.length);
    $(R, ".modebtn").textContent = simple ? "Add or change food" : "← Back to my week";
    var gc = $(R, "#gCal"), gp = $(R, "#gPro");
    if (R.activeElement !== gc) gc.value = st.cal;
    if (R.activeElement !== gp) gp.value = st.pro;
    $(R, ".wrap").classList.toggle("picking", !!selected);

    var tray = $(R, "#tray"); tray.innerHTML = "";
    var left = st.pieces.filter(function (p) { return p.day < 0; });
    left.forEach(function (p) { tray.appendChild(chip(p)); });
    if (!left.length) tray.innerHTML = '<span class="hint">' + (st.pieces.length ? "Everything is on a day." : "Pick items and they show up here.") + "</span>";
    $(R, "#trayTitle").textContent = "In my basket (" + left.length + ")";

    var planned = 0;
    DAYS.forEach(function (D, i) {
      var T = dayTotals(i), ch = $(R, "#ch" + i); ch.innerHTML = "";
      T.on.forEach(function (p) { ch.appendChild(chip(p, true)); });
      var hit = T.on.length && T.pro >= st.pro;
      $(R, "#dn" + i).innerHTML = D.short + (hit ? ' <span class="star">★</span>' : "");
      $(R, "#ct" + i).textContent = T.on.length ? T.on.length + " item" + (T.on.length > 1 ? "s" : "") : "";
      $(R, "#t" + i).innerHTML = T.on.length ? "<b>" + fmt(T.cal) + '</b><span class="l2"> cal · </span><b>' + fmt(T.pro) + 'g</b><span class="l2"> protein</span>' : (selected ? "Tap to place" : "");
      bar($(R, "#bc" + i), T.cal, st.cal); bar($(R, "#bp" + i), T.pro, st.pro);
      $(R, "#cell" + i).classList.toggle("view", i === st.view);
      if (T.on.length) planned++;
    });

    var v = st.view, D = DAYS[v], T = dayTotals(v);
    $(R, "#dTitle").textContent = D.long + ", " + D.mon + " " + D.n;
    var dz = $(R, "#dZone"); dz.dataset.day = v; dz.innerHTML = "";
    T.on.forEach(function (p) { dz.appendChild(chip(p)); });
    if (!T.on.length) dz.innerHTML = '<span class="hint">' + (selected ? "Tap here to place it on this day" : "Nothing here yet. Drag food onto this day.") + "</span>";
    renderDayList(T);
    [["cal", T.cal, st.cal, ""], ["pro", T.pro, st.pro, "g"]].forEach(function (a) {
      var k = a[0], have = a[1], goal = a[2], sfx = a[3], pct = goal > 0 ? Math.min(have / goal, 1) : 0;
      var arc = $(R, "#arc-" + k);
      arc.style.strokeDashoffset = CIRC * (1 - pct);
      arc.style.stroke = k === "cal" && have > goal ? "#e07c58" : (k === "cal" ? "#8fb04f" : "#d9b46f");
      $(R, "#of-" + k).textContent = "of " + fmt(goal) + sfx;
      var ring = $(R, "#ring-" + k), full = k === "pro" && goal > 0 && have >= goal;
      ring.classList.toggle("full", full);
      var s0 = $(ring, ".rstar"); if (s0) s0.remove();
      if (full) ring.insertAdjacentHTML("beforeend", '<span class="rstar">★</span>');
      countTo(k, have, sfx);
    });
    var lc = st.cal - T.cal, lp = Math.max(0, st.pro - T.pro), yl = $(R, "#youLeft");
    yl.classList.toggle("over", lc < 0);
    yl.firstElementChild.textContent = lc < 0 ? "Our food is over your day by" : "Left for you";
    $(R, "#leftNum").textContent = lc < 0 ? fmt(-lc) + " cal" : fmt(lc) + " cal · " + fmt(lp) + "g";

    var ol = $(R, "#orderList"); ol.innerHTML = "";
    if (!st.packs.length) ol.innerHTML = "<li><small>Nothing in your order yet.</small></li>";
    st.packs.forEach(function (k) {
      var x = info(k), m = x.m;
      var li = el("li", null, "<div>" + esc(m.name) + (m.kind === "meal" ? " <small>" + esc(x.sz.name) + "</small>" : "") +
        (m.serv > 1 ? " <small>(" + m.serv + " " + (m.kind === "side" ? "servings" : "pieces") + ")</small>" : "") + "</div>");
      var rm = el("button", "rm", "Remove");
      rm.addEventListener("click", function () { st.packs = st.packs.filter(function (z) { return z.pid !== k.pid; }); st.pieces = st.pieces.filter(function (z) { return z.pid !== k.pid; }); render(); });
      li.appendChild(rm); ol.appendChild(li);
    });

    R.querySelectorAll(".add").forEach(function (b) {
      var parts = b.dataset.k.split("|"), q = st.packs.filter(function (k) { return k.id == parts[0] && k.opt == parts[1]; }).length;
      b.innerHTML = q ? 'Added<span class="ct">' + q + "</span>" : "Add";
    });
    var total = st.packs.reduce(function (t, k) { return t + info(k).sz.price; }, 0), save5 = total * 0.05;
    // Basic membership: $10 every 4 weeks, first month free, 5% off the whole order (Luke 10/23)
    $(R, "#sum").innerHTML = st.packs.length
      ? "<b>" + st.packs.length + "</b> item" + (st.packs.length > 1 ? "s" : "") + " · <b>$" + total.toFixed(2) + "</b>" +
        '<div class="member">With a <b>Basic membership</b>: <b>$' + (total - save5).toFixed(2) + "</b> <span>(save $" + save5.toFixed(2) + " this week · first month free · add it at checkout)</span></div>"
      : "Nothing picked yet";
    $(R, ".tocart").disabled = !st.packs.length || busy;
    $(R, "#weekly").hidden = !st.quiz;
    pill.style.display = st.pieces.length ? "block" : "none";
    pill.innerHTML = '<span style="display:block;font-size:11px;font-weight:800;letter-spacing:.1em;color:#d9b46f">MY WEEK</span>' + planned + " day" + (planned === 1 ? "" : "s") + " planned" + (left.length ? " · " + left.length + " to place" : "");
    save();
  }

  function popAt(day, p) {
    if (day < 0 || !p || reduced()) return;
    var r = $(R, "#cell" + day).getBoundingClientRect(), sz = info(p).sz;
    [["+" + sz.protein + "g", "pro", 0], ["+" + sz.cal, "", 22]].forEach(function (a) {
      var e = el("div", "pop " + a[1], a[0]);
      e.style.left = (r.left + r.width / 2) + "px"; e.style.top = (r.top + 34 + a[2]) + "px";
      $(R, ".wrap").appendChild(e); setTimeout(function () { e.remove(); }, 1200);
    });
  }

  // ------------------------------------------------------------------ interaction: drag (pointer events = mouse + touch) and tap-to-place
  function wire() {
    R.addEventListener("click", function (e) {
      var qb = e.target.closest("[data-q]"); if (qb) { quizClick(qb); return; }
      var a = e.target.closest("[data-a]"); if (!a) return;
      if (a.dataset.a === "close") close();
      if (a.dataset.a === "reset") { st = { cal: st.cal, pro: st.pro, view: 0, packs: [], pieces: [], week: DATA.week }; selected = null; $(R, "#built").hidden = true; render(); }
      if (a.dataset.a === "quiz") showQuiz();
      if (a.dataset.a === "checkout") checkout();
      if (a.dataset.a === "mode") { fullView = isSimple(); dayOpen = false; swapFor = null; render(); $(R, ".sheet").scrollTop = 0; }
      if (a.dataset.a === "dayclose") { dayOpen = false; swapFor = null; render(); }
      if (a.dataset.a === "swap") { swapFor = swapFor === a.dataset.uid ? null : a.dataset.uid; render(); }
      if (a.dataset.a === "remove") { removePiece(a.dataset.uid); swapFor = null; render(); }
      if (a.dataset.a === "pickalt") swapPiece(a.dataset.uid, +a.dataset.id, +a.dataset.opt);
    });
    $(R, ".scrim").addEventListener("click", close);
    ["gCal", "gPro"].forEach(function (id) {
      $(R, "#" + id).addEventListener("input", function (e) { var v = Math.max(0, +e.target.value || 0); if (id === "gCal") st.cal = v; else st.pro = v; render(); });
    });
    R.addEventListener("pointerdown", function (e) {
      var c = e.target.closest(".chip");
      if (!c || e.target.closest(".back") || e.button > 0) return;
      drag = { uid: c.dataset.uid, el: c, x: e.clientX, y: e.clientY, moved: false, ghost: null, hot: null };
      c.setPointerCapture(e.pointerId);
    });
    document.addEventListener("pointermove", function (e) {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) {
        drag.moved = true;
        var r = drag.el.getBoundingClientRect();
        drag.ox = e.clientX - r.left; drag.oy = e.clientY - r.top;
        drag.ghost = drag.el.cloneNode(true); drag.ghost.classList.add("ghost"); drag.ghost.style.width = Math.max(r.width, 120) + "px";
        $(R, ".wrap").appendChild(drag.ghost); drag.el.classList.add("lifting");
      }
      if (!drag.moved) return;
      drag.ghost.style.left = (e.clientX - drag.ox) + "px"; drag.ghost.style.top = (e.clientY - drag.oy) + "px";
      var hit = R.elementFromPoint(e.clientX, e.clientY), z = hit && hit.closest ? hit.closest(".zone") : null;
      if (drag.hot && drag.hot !== z) drag.hot.classList.remove("hot");
      if (z) z.classList.add("hot");
      drag.hot = z;
      var sr = sheet.getBoundingClientRect();
      if (e.clientY < sr.top + 70) sheet.scrollTop -= 14; else if (e.clientY > sr.bottom - 80) sheet.scrollTop += 14;
    });
    function endDrag() {
      if (!drag) return;
      var p = st.pieces.filter(function (x) { return x.uid === drag.uid; })[0], placed = -1;
      if (drag.moved) {
        if (drag.hot && p) { var before = p.day; p.day = +drag.hot.dataset.day; if (p.day >= 0) st.view = p.day; if (p.day >= 0 && p.day !== before) placed = p.day; selected = null; }
        drag.ghost.remove(); if (drag.hot) drag.hot.classList.remove("hot");
        drag = null; render(); popAt(placed, p); return;
      }
      selected = selected === drag.uid ? null : drag.uid;
      drag = null; render();
    }
    document.addEventListener("pointerup", endDrag);
    document.addEventListener("pointercancel", endDrag);
    R.querySelectorAll(".zone").forEach(function (z) {
      function act() {
        var day = +z.dataset.day, moved = null;
        if (selected) { var p = st.pieces.filter(function (x) { return x.uid === selected; })[0]; if (p && p.day !== day) { p.day = day; moved = p; } selected = null; }
        if (day >= 0) st.view = day;
        // simple view: tapping a day slides up that day, with the calendar kept in sight above it
        var opening = z.classList.contains("cell") && isSimple() && !moved;
        if (opening) { dayOpen = true; swapFor = null; }
        render(); if (moved) popAt(day, moved);
        if (opening) $(R, ".calwrap").scrollIntoView({ block: "start" });
      }
      z.addEventListener("click", function (e) { if (!e.target.closest(".chip") || z.classList.contains("cell")) act(); });
      z.addEventListener("keydown", function (e) { if ((e.key === "Enter" || e.key === " ") && e.target === z) { e.preventDefault(); act(); } });
    });
    R.addEventListener("keydown", function (e) {
      var c = e.target.closest && e.target.closest(".chip");
      if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selected = selected === c.dataset.uid ? null : c.dataset.uid; render(); }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !sheet.hidden) { if (selected) { selected = null; render(); } else close(); }
    });
  }

  function open() {
    lastFocus = document.activeElement; sheet.hidden = false; $(R, ".scrim").hidden = false; document.documentElement.style.overflow = "hidden";
    if (!st.quiz && !st.packs.length) showQuiz();   // first visit starts with the quiz
    $(R, ".x").focus({ preventScroll: true });
  }
  function close() { sheet.hidden = true; $(R, ".scrim").hidden = true; document.documentElement.style.overflow = ""; selected = null; render(); if (lastFocus && lastFocus.focus) lastFocus.focus(); }

  // ------------------------------------------------------------------ check out: put the plan in the real cart, then go to /checkout
  function csrf() { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.content : ""; }
  function cartPost(url, body) {
    return fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-TOKEN": csrf(), "X-Requested-With": "XMLHttpRequest" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.message || "The cart said no (" + r.status + ")"); return j; }); });
  }
  function msg(text, err) { var m = $(R, "#msg"); m.hidden = !text; m.textContent = text || ""; m.classList.toggle("err", !!err); }
  function planQty() {
    var q = {};
    st.packs.forEach(function (k) { var key = k.id + "|" + k.opt; q[key] = (q[key] || 0) + 1; });
    return q;
  }
  // ------------------------------------------------------------------ "email me my week every Thursday": goals saved on the customer's own Klaviyo profile
  function goalsSummary() {
    if (!st.quiz) return "";
    var q = st.quiz, d = q.days === "wk" ? "Mon–Fri" : q.days === "all" ? "every day" : q.days.slice().sort().map(function (i) { return DAYS[i].short; }).join(", ");
    return [GOALS[q.goal].label, q.perDay + " meal" + (q.perDay > 1 ? "s" : "") + " a day", d].concat(q.avoid.map(function (a) { return a + " free"; })).join(" · ");
  }
  function weeklyWanted() { return st.quiz && $(R, "#wkOpt").checked; }
  function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }
  function saveWeekly() {
    if (!weeklyWanted() || !window.klaviyo || !window.klaviyo.identify) return Promise.resolve();
    var props = { planner_code: goalsCode(), planner_summary: goalsSummary(), planner_saved: new Date().toISOString().slice(0, 10) };
    var em = $(R, "#wkEmail");
    if (!em.hidden && em.value) props.email = em.value.trim();
    var sent;
    try { sent = Promise.resolve(window.klaviyo.identify(props)); } catch (e) { return Promise.resolve(); }
    // never hold up checkout for more than a moment if Klaviyo is slow
    return Promise.race([sent.catch(function () {}), new Promise(function (ok) { setTimeout(ok, 1500); })]);
  }
  function wireWeekly() {
    var box = $(R, "#wkOpt"), em = $(R, "#wkEmail");
    box.addEventListener("change", function () {
      if (!box.checked) { em.hidden = true; return; }
      // ask for an email only when Klaviyo doesn't already know who this is
      var known = window.klaviyo && window.klaviyo.isIdentified ? Promise.resolve(window.klaviyo.isIdentified()) : Promise.resolve(false);
      known.then(function (yes) { em.hidden = !!yes; if (!yes) em.focus(); }, function () { em.hidden = false; });
    });
  }

  function checkout() {
    if (busy || !st.packs.length) return;
    var em = $(R, "#wkEmail");
    if (weeklyWanted() && !em.hidden && !validEmail(em.value.trim())) { msg("Add your email so we can send your week on Thursdays, or untick the box.", true); em.focus(); return; }
    fetch("/cart/count", { credentials: "same-origin", headers: { Accept: "application/json" } }).then(function (r) { return r.json(); }).then(function (c) {
      var existing = (c && c.items) || [];
      if (!existing.length) return push(existing, "add");
      var n = existing.reduce(function (t, i) { return t + (+i.qty || 0); }, 0), box = $(R, "#choice");
      box.hidden = false;
      box.innerHTML = "<span>Your cart already has " + n + " item" + (n > 1 ? "s" : "") + ".</span>";
      var them = n > 1 ? "them" : "it";
      [["Add my plan to " + them, "add", true], ["Replace " + them + " with my plan", "replace", false]].forEach(function (a) {
        var b = el("button", a[2] ? "primary" : "", a[0]);
        b.addEventListener("click", function () { box.hidden = true; push(existing, a[1]); });
        box.appendChild(b);
      });
    }).catch(function () { push([], "add"); });
  }
  function push(existing, how) {
    busy = true; render(); msg("Putting your plan in the cart…");
    var have = {};
    if (how === "add") existing.forEach(function (i) { have[i.product_id + "|" + i.productoption_id] = +i.qty || 0; });
    var q = planQty(), keys = Object.keys(q);
    var chain = how === "replace" ? cartPost("/cart/clear", {}) : Promise.resolve();
    keys.forEach(function (key) {
      var parts = key.split("|");
      chain = chain.then(function () { return cartPost("/cart/add", { product_id: +parts[0], productoption_id: +parts[1], quantity: (have[key] || 0) + q[key], mode: "set" }); });
    });
    chain.then(saveWeekly).then(function () {
      st.pushed = true; st.pushedAt = Date.now(); save();
      if (window.TSKP_ON_CHECKOUT) { busy = false; msg(""); render(); window.TSKP_ON_CHECKOUT(); return; }
      msg("Done. Taking you to checkout…");
      location.href = "/checkout";
    }).catch(function (e) {
      busy = false; render();
      msg("Something went wrong putting your plan in the cart: " + e.message + ". Your plan is saved; try again, or add items from the menu.", true);
    });
  }

  // ------------------------------------------------------------------ order confirmation page: the plan download
  function successPage() {
    if (!st.pushed || !st.pieces || !st.pieces.some(function (p) { return p.day >= 0; })) return;
    if (st.pushedAt && Date.now() - st.pushedAt > 3 * 864e5) return;   // only right after the planned checkout
    loadData().then(function (d) {
      DATA = d;
      d.items.forEach(function (m) { m.short = m.kind === "side" && m.sizes[0].protein >= 15 ? m.name + " (side)" : m.name; ITEMS[m.id] = m; });
      if (st.week !== d.week) return;
      DAYS = planWeek(d.fulfillment);
      addFont();
      var box = el("div");
      box.style.cssText = "max-width:980px;margin:16px auto;padding:14px 16px;border:2px solid #d9b46f;background:#fbf5e8;border-radius:14px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;font-family:'Plus Jakarta Sans',Arial,sans-serif;color:#1d2314";
      box.innerHTML = '<div><b style="font-size:16px">Your week plan is ready.</b><div style="font-size:13px;color:#646b58">A calendar of what you\'re eating each day, with what our food covers and what\'s left for you.</div></div>';
      var b = el("button", null, "Download my week plan");
      b.style.cssText = "background:#2e3a18;color:#fff;border:0;border-radius:10px;padding:11px 18px;font-weight:800;font-size:15px;cursor:pointer;font-family:inherit";
      b.addEventListener("click", function () { b.disabled = true; b.textContent = "Making your PDF…"; downloadPdf().then(function () { b.disabled = false; b.textContent = "Download again"; }, function (e) { b.disabled = false; b.textContent = "Download my week plan"; alert("Sorry, the PDF didn't work: " + e.message); }); });
      box.appendChild(b);
      var main = document.querySelector("main") || document.body;
      main.insertBefore(box, main.firstChild);
    }).catch(function (e) { console.warn("[TSK planner] success page:", e); });
  }

  function loadScript(src) {
    return new Promise(function (ok, bad) { var s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = function () { bad(new Error("could not load " + src)); }; document.head.appendChild(s); });
  }
  // Month view of the plan week's month, the plan week filled in, rendered off-screen then saved as a landscape PDF
  function downloadPdf() {
    var libs = window.jspdf && window.html2canvas ? Promise.resolve() :
      loadScript("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js").then(function () { return loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"); });
    return libs.then(function () {
      var sheetEl = paper();
      document.body.appendChild(sheetEl);
      return (document.fonts ? document.fonts.ready : Promise.resolve()).then(function () {
        return window.html2canvas(sheetEl, { scale: 2, backgroundColor: "#ffffff" });
      }).then(function (canvas) {
        sheetEl.remove();
        var pdf = new window.jspdf.jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
        var W = pdf.internal.pageSize.getWidth(), H = pdf.internal.pageSize.getHeight(), m = 24;
        var w = W - 2 * m, h = w * canvas.height / canvas.width;
        if (h > H - 2 * m) { h = H - 2 * m; w = h * canvas.width / canvas.height; }
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", (W - w) / 2, m, w, h);
        pdf.save("Strong-Kitchen-week-plan-" + DAYS[0].mon + "-" + DAYS[0].n + ".pdf");
      }, function (e) { sheetEl.remove(); throw e; });
    });
  }
  function paper() {
    var mon = DAYS[0].date, first = new Date(mon.getFullYear(), mon.getMonth(), 1);
    var start = new Date(first); while (start.getDay() !== 1) start.setDate(start.getDate() - 1);
    var last = new Date(mon.getFullYear(), mon.getMonth() + 1, 0), weekStart = DAYS[0].date.getTime();
    var cells = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(function (d) { return '<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#8a8f7d;background:#f3f4ee;padding:5px 7px;border-right:1px solid #d9dbcf;border-bottom:1px solid #d9dbcf">' + d + "</div>"; }).join("");
    var cur = new Date(start), filled = [], avgP = 0;
    while (cur <= last || cur.getTime() <= weekStart + 6 * 864e5) {
      for (var d = 0; d < 7; d++) {
        var inPlan = cur.getTime() >= weekStart && cur.getTime() < weekStart + 7 * 864e5, inMonth = cur.getMonth() === mon.getMonth();
        var base = "border-right:1px solid #d9dbcf;border-bottom:1px solid #d9dbcf;padding:5px 7px;font-size:12px;";
        if (inPlan) {
          var i = Math.round((cur.getTime() - weekStart) / 864e5), T = dayTotals(i);
          if (T.on.length) { filled.push(T); avgP += T.pro; }
          // the same item twice in a day prints once with ×2
          var counts = {}, order = [];
          T.on.forEach(function (p) { var key = p.id + "|" + p.opt; if (!counts[key]) { counts[key] = 0; order.push(p); } counts[key]++; });
          var lis = order.map(function (p) { var x = info(p), n = counts[p.id + "|" + p.opt], c = x.m.kind === "meal" ? "#73933c" : x.m.kind === "side" ? "#8a9a6b" : "#d9b46f"; return '<li style="font-size:11.5px;line-height:1.25;padding-left:7px;border-left:3px solid ' + c + ';margin:0 0 3px">' + esc(x.m.short) + (x.m.kind === "meal" && x.m.sizes.length > 1 ? " (" + (ABBR[x.sz.name] || x.sz.name) + ")" : "") + (n > 1 ? " ×" + n : "") + "</li>"; }).join("");
          var lc = st.cal - T.cal, lp = Math.max(0, st.pro - T.pro);
          cells += '<div style="' + base + 'background:#f7f1e2;border-top:2px solid #d9b46f;min-height:230px;display:flex;flex-direction:column;gap:4px;color:#1d2314"><b style="font-size:15px">' + cur.getDate() + (inMonth ? "" : " " + cur.toLocaleString("en-US", { month: "short" })) + '</b><ul style="list-style:none;margin:0;padding:0;flex:1">' + (lis || '<li style="color:#8a8f7d;font-size:11.5px">Your own meals</li>') + "</ul>" +
            (T.on.length ? '<div style="font-size:10.5px;line-height:1.35;border-top:1px dashed #d9dbcf;padding-top:4px"><b style="color:#4f6a24">From us:</b> ' + fmt(T.cal) + " cal · " + fmt(T.pro) + "g<br>" + (lc >= 0 ? "<b>For you:</b> " + fmt(lc) + " cal · " + fmt(lp) + "g" : '<b style="color:#b5502f">Over by ' + fmt(-lc) + " cal</b>") + "</div>" : "") + "</div>";
        } else {
          cells += '<div style="' + base + "min-height:34px;color:" + (inMonth ? "#8a8f7d" : "#c6c9bd") + '">' + cur.getDate() + "</div>";
        }
        cur.setDate(cur.getDate() + 1);
      }
    }
    var wrap = el("div");
    wrap.style.cssText = "position:fixed;left:-10000px;top:0;width:1000px;background:#fff;color:#1d2314;padding:36px 40px;font-family:'Plus Jakarta Sans',Arial,sans-serif";
    wrap.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:20px;border-bottom:3px solid #2e3a18;padding-bottom:14px">' +
      '<div><div style="font-weight:800;font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#73933c">The Strong Kitchen</div><div style="font-size:30px;font-weight:800;line-height:1.1;margin-top:4px">Your week plan</div></div>' +
      '<div style="text-align:right;font-size:13px;color:#8a8f7d">Your daily goal<b style="display:block;font-size:16px;color:#1d2314">' + fmt(st.cal) + " cal · " + fmt(st.pro) + "g protein</b>" + filled.length + " days planned · we cover about " + fmt(filled.length ? avgP / filled.length : 0) + "g protein a day</div></div>" +
      '<div style="margin:18px 0 8px;display:flex;justify-content:space-between;align-items:baseline"><b style="font-size:20px">' + mon.toLocaleString("en-US", { month: "long", year: "numeric" }) + '</b><span style="font-size:12px;color:#8a8f7d">Your week: ' + DAYS[0].long + ", " + DAYS[0].mon + " " + DAYS[0].n + " – " + DAYS[6].long + ", " + DAYS[6].mon + " " + DAYS[6].n + "</span></div>" +
      '<div style="display:grid;grid-template-columns:repeat(7,1fr);border-top:1px solid #d9dbcf;border-left:1px solid #d9dbcf">' + cells + "</div>" +
      '<div style="display:flex;justify-content:space-between;gap:20px;margin-top:16px;font-size:11.5px;color:#8a8f7d"><span>Reheating and storage instructions are on each label.</span><span>Next week\'s menu opens Thursday · thestrongkitchen.com</span></div>';
    return wrap;
  }

  if (onMenu) boot(); else successPage();
})();
