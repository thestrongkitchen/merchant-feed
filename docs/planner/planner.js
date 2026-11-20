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

  // ------------------------------------------------------------------ first-order offer ladder (Luke 11/18; $75/$125/$175 set from the Sept-Nov order spread: median $105, avg $117)
  // Each rung is a site promo code Luke creates in the admin with that ORDER MINIMUM (the site can't count meals).
  // CODES_READY stays false until those codes exist: the ladder shows, but checkout never types a code in.
  // KLAVIYO_LOCKIN stays false until Luke OKs saving the lock-in email/offer to Klaviyo; until then it stays on this device.
  var OFFER = {
    rungs: [
      { min: 75, pct: 0, code: "MYWEEK", label: "Free delivery" },
      { min: 125, pct: 10, code: "BESTPLAN", label: "Free delivery + 10% off" },
      { min: 175, pct: 15, code: "NOCOOKING", label: "Free delivery + 15% off" }
    ],
    CODES_READY: true,         // Luke 11/18: MYWEEK (620) / BESTPLAN (621) / NOCOOKING (622) created in the admin; SKDELIVER (623) = orders 2-4
    KLAVIYO_LOCKIN: true,      // Luke 11/18 "go ahead with step 3" (only preview browsers see the planner until launch)
    LIST: "WAWZxw",            // "Build Your Week - signups": triggers draft flow UaFzkB; NOT the old code list Tg6vZf
    COMPANY: "RHx7TH",
    DAYS_VALID: 21
  };
  var OFFER_KEY = "tskPlannerOffer";
  function rungFor(sub) { var r = null; OFFER.rungs.forEach(function (x) { if (sub >= x.min - 0.005) r = x; }); return r; }
  function nextRung(sub) { return OFFER.rungs.filter(function (x) { return sub < x.min - 0.005; })[0] || null; }
  function moreFor(x) { return x.pct ? x.pct + "% off" : "free delivery"; }
  function getOffer() {
    try { var o = JSON.parse(localStorage.getItem(OFFER_KEY)); return o && (o.email || o.via) && Date.now() - o.at < OFFER.DAYS_VALID * 864e5 ? o : null; } catch (e) { return null; }
  }
  function setOffer(o) { try { localStorage.setItem(OFFER_KEY, JSON.stringify(o)); } catch (e) { /* private mode: no lock-in */ } }
  // signed in on the menu = an existing customer: they keep the membership line and get no first-order ladder
  function signedIn() { return !!document.querySelector('form[action$="/logout"]'); }
  // Same test the first-order popup uses (Luke 11/18: "popup didn't show to current customers"): a browser Klaviyo already
  // knows (signed in, clicked one of our emails, ordered on this phone) is treated as a current customer and sees no
  // discount lines. Someone who locked in on this device keeps their offer, so it can't vanish after they type their email.
  var knownVisitor = !!document.querySelector('form[action$="/logout"]');
  // Signed in: judge by order history (Luke 11/18: an account with no orders is still a new customer and gets the
  // first-order plan). Unreadable history counts as a current customer, the safe side. Answer cached for the visit.
  var orderCheck = null;
  function hasOrders() {
    if (!orderCheck) orderCheck = fetch("/account/orders", { credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function (t) { return /Order\s*#\s*\d{3,}/i.test(t); }, function () { return true; });
    return orderCheck;
  }
  function checkKnown() {
    if (signedIn()) return hasOrders().then(function (has) { knownVisitor = has; return has; });
    var k = window.klaviyo;
    if (!k || typeof k.isIdentified !== "function") return Promise.resolve(knownVisitor);
    return Promise.resolve(k.isIdentified()).then(function (v) { knownVisitor = !!v; return knownVisitor; }, function () { return knownVisitor; });
  }
  function offerShown() { return !!getOffer() || !knownVisitor; }
  var path = location.pathname.replace(/\/+$/, "") || "/";
  // TSKP_PAGE lets the review playground run the planner off the live site
  var onMenu = window.TSKP_PAGE === "menu" || /^\/menus(\/|$)/.test(path);
  var onSuccess = path === "/checkout/success";
  var onCart = path === "/cart", onCheckout = path === "/checkout";
  // landing pages: a big "Build my week" card at the top of the content, where the old code form sat (Luke 11/18)
  var onLanding = path === "/where-we-deliver" || /^\/lp\/meal-prep-delivery-[a-z0-9-]+$/.test(path);
  if (!onMenu && !onSuccess && !onCart && !onCheckout && !onLanding) return;

  // Soft launch: only a browser that has opened a page with ?planner=preview sees the planner (remembered on that
  // device; ?planner=off forgets it). Set PREVIEW_ONLY to false to show it to everyone.
  var PREVIEW_ONLY = false;   // LAUNCHED 11/18 (Luke: "lets do it all"); GTM v25 paused the popup / inline forms / code bar
  try {
    var pv = /[?&]planner=(preview|off)/.exec(location.search);
    if (pv) localStorage.setItem("tskPlannerPreview", pv[1] === "preview" ? "1" : "0");
  } catch (e) { /* storage blocked: the gate below simply stays closed */ }
  var previewer = false;
  try { previewer = localStorage.getItem("tskPlannerPreview") === "1"; } catch (e) { /* closed */ }
  if (PREVIEW_ONLY && !previewer && !window.TSKP_PAGE) return;
  // While in preview, say what the planner is doing on screen (customers never see this)
  function note(text, ms) {
    if (!PREVIEW_ONLY || window.TSKP_PAGE || !document.body) return;
    var n = document.getElementById("tskp-note");
    if (!n) {
      n = document.createElement("div"); n.id = "tskp-note";
      n.style.cssText = "position:fixed;left:12px;right:12px;top:calc(12px + env(safe-area-inset-top,0px));z-index:2147483646;background:#2e3a18;color:#fff;border:2px solid #d9b46f;border-radius:10px;padding:10px 12px;font:600 13px Arial,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.3)";
      document.body.appendChild(n);
    }
    n.textContent = text; n.style.display = "block";
    clearTimeout(n._t); if (ms) n._t = setTimeout(function () { n.style.display = "none"; }, ms);
  }
  if (onMenu) note("Build Your Week preview: on. Loading this week's menu…");

  // ------------------------------------------------------------------ landing pages: the top card
  if (onLanding) {
    var runCard = function () {
      var content = document.querySelector(".landing-content") || document.querySelector(".content-blocks");
      if (!content || document.getElementById("tskp-topcard")) return;
      var slug = path.split("/").pop();
      var url = "https://thestrongkitchen.com/menus?tskopen=1&utm_source=site-lp&utm_medium=top-card&utm_campaign=build-your-week&utm_content=" + slug;
      var card = document.createElement("div");
      card.id = "tskp-topcard";
      card.style.cssText = "margin:0 0 1.5rem;padding:22px 20px;border:2px solid #d9b46f;border-radius:12px;background:#f6f8f0;font-family:'Plus Jakarta Sans','Helvetica Neue',Arial,sans-serif;color:#1d2314";
      var draw = function (known) {
        card.innerHTML =
          '<div style="font-size:1.4rem;line-height:1.25;font-weight:800;color:#2e3a18;margin:0 0 6px">' +
            (known ? "Plan your week in 30 seconds" : "New here? Let us build your first week") + "</div>" +
          '<div style="font-size:1rem;line-height:1.5;margin:0 0 14px">' +
            (known ? "Tell us your goal and we'll build a week of this menu around it. Change anything, then check out."
                   : "Answer a few quick taps and we'll build a week of our meals around your goal, priced, with your first-order savings counted: <b>free delivery from $75, 10% off from $125, 15% off from $175</b>.") + "</div>" +
          '<a href="' + url + '" style="display:block;text-align:center;padding:16px 20px;font-size:1.15rem;font-weight:800;color:#fff;background:#73933c;border-radius:10px;text-decoration:none">Build my week \u2192</a>' +
          '<div style="font-size:.85rem;line-height:1.4;color:#646b58;margin:8px 0 0;text-align:center">' +
            (known ? "Keeps 7 days · Hot in 3 minutes · No subscription" : "Plus your first month of membership free · No subscription") + "</div>";
      };
      draw(knownVisitor);
      content.insertBefore(card, content.firstChild);
      // the page's own fallback (a bold line + "Build my week" button saved in the CMS for browsers that block GTM):
      // when this card is showing, hide that pair so there is one big button, not two
      // the old form also took over the page's first "Get your code" button; likewise hide any Build-my-week button in the
      // first few blocks so the card is the only one near the top (the one in the closing "New here?" section stays)
      var blocksBox = content.querySelector(".content-blocks") || content;
      var kids = [].slice.call(blocksBox.children).filter(function (el) { return el !== card; });
      kids.slice(0, 6).forEach(function (el) { if (el.querySelector && el.querySelector('a[href*="tskopen=1"]') && /block-button/.test(el.className)) el.style.display = "none"; });
      var own = content.querySelector('a[href*="utm_medium=top-button"]');
      if (own) {
        var btnBlock = own.closest(".block-button") || own.parentNode;
        var prev = btnBlock && btnBlock.previousElementSibling;
        if (btnBlock) btnBlock.style.display = "none";
        if (prev && /build your first week/i.test(prev.textContent)) prev.style.display = "none";
      }
      checkKnown().then(function (k) { draw(k); }, function () {});
      track("topcard_view");
      card.addEventListener("click", function (e) { if (e.target.tagName === "A") track("topcard_click"); });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", runCard); else runCard();
    return;
  }
  // ------------------------------------------------------------------ /cart and /checkout: only the offer, never the builder
  if (onCart || onCheckout) {
    var runOffer = function () {
      if (!getOffer()) return;   // only shoppers who locked in their savings in the planner
      if (onCart) { cartLine(); document.addEventListener("click", function () { setTimeout(cartLine, 900); }); }
      else applyAtCheckout();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", runOffer); else runOffer();
    return;
  }
  function cartSubtotal() {
    return fetch("/cart/count", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); }).then(function (c) { return parseFloat(c && c.subtotal) || 0; });
  }
  // a line above "Proceed to Checkout": what they've earned, what the next rung needs, and that it carries through sign-up
  function cartLine() {
    cartSubtotal().then(function (sub) {
      var go = [].filter.call(document.querySelectorAll("a,button"), function (b) { return /proceed to checkout/i.test(b.textContent); })[0];
      if (!go) return;
      var d = document.getElementById("tskp-offer");
      if (!d) {
        d = document.createElement("div"); d.id = "tskp-offer";
        d.style.cssText = "margin:0 0 12px;padding:10px 12px;border:2px solid #d9b46f;background:#fbf5e8;border-radius:10px;font:600 14px/1.45 'Plus Jakarta Sans',Arial,sans-serif;color:#1d2314;text-align:left";
        go.parentNode.insertBefore(d, go);
      }
      var r = rungFor(sub), nx = nextRung(sub), sm = "<span style='font-weight:500;color:#4d5340'>";
      d.innerHTML = (r
        ? "<b>✓ " + esc(r.label) + "</b> on your first order" + (r.pct ? " (saves $" + (sub * r.pct / 100).toFixed(2) + ")" : "") + ". We'll apply it at checkout."
        : "<b>$" + (nx.min - sub).toFixed(2) + " more</b> gets you free delivery on your first order.") +
        (r && nx ? "<br>" + sm + "Add $" + (nx.min - sub).toFixed(2) + " more for " + moreFor(nx) + ".</span>" : "") +
        "<br>" + sm + "Plus: your first month of Basic membership is free, another 5% off (about $" + (sub * 0.05).toFixed(2) + "). Add it at checkout.</span>" +
        (signedIn() ? "" : "<br>" + sm + "Next you'll make your account. Your cart and savings come with you.</span>");
    }).catch(function () {});
  }
  // On checkout: type the right code into "Have a code?" and press Apply, once per visit, before they fill anything in.
  // If they take it off, it stays off.
  function applyAtCheckout() {
    var f = document.querySelector('form[action$="/checkout/coupon"]'), inp = f && f.querySelector('input[name="code"]');
    if (!inp) return;
    var tried = null; try { tried = sessionStorage.getItem("tskpCouponTried"); } catch (e) { /* none */ }
    if (tried) return;
    var m = /Coupon \/ gift card\s*-?\$([\d.,]+)/i.exec(document.body.innerText);
    if (m && parseFloat(m[1].replace(/,/g, "")) > 0) return;   // a code is already on the order
    var pastOrders = fetch("/account/orders", { credentials: "same-origin" }).then(function (r) { return r.text(); })
      .then(function (t) { return /Order\s*#\s*\d{3,}/i.test(t); }, function () { return true; });   // can't tell = don't apply
    Promise.all([cartSubtotal(), pastOrders]).then(function (a) {
      var sub = a[0], r = rungFor(sub);
      if (a[1]) { note("Preview: this account has past orders, so no first-order code goes on.", 8000); return; }
      if (!r) return;
      if (!OFFER.CODES_READY) { note("Preview: checkout would apply " + r.code + " now ($" + sub.toFixed(2) + " order). Codes aren't switched on yet, so nothing was typed.", 10000); return; }
      try { sessionStorage.setItem("tskpCouponTried", r.code); } catch (e) { return; }   // can't remember the try = don't risk a loop
      inp.value = r.code;
      if (f.requestSubmit) f.requestSubmit(); else f.submit();
    }).catch(function () {});
  }

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
    // Both downloads start together (Luke 11/19 "seems slow to load": they used to run one after the other)
    var statusP = fetch("/cart/status", { headers: { Accept: "application/json" } }).then(function (r) { return r.json(); });
    statusP.catch(function () { /* reported through the chain below */ });
    loadData().then(function (d) {
      DATA = d;
      // Never plan against a stale menu: the site reports its current menu week
      return statusP.then(function (s) {
        if (String(s.current_week) !== String(d.week)) {
          console.info("[TSK planner] menu week", s.current_week, "≠ data week", d.week, "— planner hidden until the data catches up");
          note("Build Your Week preview: the menu just changed and the planner's data hasn't caught up yet (site week " + s.current_week + ", data week " + d.week + "). Try again in 30 minutes.");
          return;
        }
        try { start(); } catch (e) { note("Build Your Week preview hit an error: " + (e && e.message ? e.message : e)); throw e; }
        note(btn && btn.parentNode ? "Build Your Week preview: ready. The gold button is in the All / Meals / Sides / Snacks row." : "Build Your Week preview: loaded, but couldn't find the menu's filter row to put the button in.", btn && btn.parentNode ? 5000 : 0);
      });
    }).catch(function (e) { console.warn("[TSK planner] not started:", e); note("Build Your Week preview couldn't load: " + (e && e.message ? e.message : e)); });
  }

  function start() {
    checkKnown().then(function () { if (R && st && st.packs) render(); });
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
    window.TSKP_API = { paper: paper, close: close, goalsCode: goalsCode, cartLink: cartLink, emailProps: emailProps };
    if (!fromCartLink()) fromLink();
    if (/[?&]tskopen=1/.test(location.search)) { dropParams(["tskopen"]); open(); }
  }

  // ------------------------------------------------------------------ saved goals as a short code, for the Thursday "your week is built" link
  // e.g. ?tskplan=lean.gluten.2.wk.2300.170  (goal . avoid list joined by - or "none" . meals a day . wk|all|0-2-4 . cal . protein)
  function goalsCode() {
    if (!st.quiz) return "";
    var q = st.quiz, d = q.days === "wk" || q.days === "all" ? q.days : q.days.join("-");
    return [q.goal, q.avoid.length ? q.avoid.join("-") : "none", PLAN_INFO[q.perDay] ? PLAN_INFO[q.perDay].code : q.perDay, d, st.cal, st.pro].join(".");
  }
  // ------------------------------------------------------------------ one-tap cart link (emails: Warm Prospects, Monday recap)
  // /menus?tskcart=<menu week>.<product id>-<option id>-<qty>_<...>   [&tsko=1 = show first-order savings]   [&tskplan=<goals> = fallback]
  // Same menu week: fill the cart and go to /cart. Menu moved on: rebuild from the goals if given, else open the planner.
  function dropParams(names) {
    try {
      var q = location.search.replace(/^\?/, "").split("&").filter(function (kv) { return kv && names.indexOf(kv.split("=")[0]) < 0; }).join("&");
      history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash);
    } catch (e) { /* fine */ }
  }
  function cartLink(offer) {
    var q = {};
    st.packs.forEach(function (k) { var key = k.id + "-" + k.opt; q[key] = (q[key] || 0) + 1; });
    var items = Object.keys(q).map(function (k) { return k + "-" + q[k]; }).join("_");
    return location.origin + "/menus?tskcart=" + DATA.week + "." + items + (st.quiz ? "&tskplan=" + goalsCode() : "") + (offer ? "&tsko=1" : "");
  }
  function fromCartLink() {
    var m = /[?&]tskcart=(\d+)\.([0-9_\-]+)/.exec(location.search);
    if (!m) return false;
    var wantsOffer = /[?&]tsko=1/.test(location.search);
    track(wantsOffer ? "link_prospect" : "link_reorder");
    dropParams(["tskcart", "tsko"]);
    if (wantsOffer && !getOffer() && !knownVisitor) setOffer({ email: "", via: "link", at: Date.now() });
    var list = m[2].split("_").map(function (x) { return x.split("-").map(Number); }).filter(function (x) { return x.length === 3 && x[2] > 0 && x[2] < 50; });
    var ok = String(m[1]) === String(DATA.week) && list.length && list.every(function (x) { return ITEMS[x[0]] && ITEMS[x[0]].sizes.some(function (z) { return z.option_id === x[1]; }); });
    if (!ok) {
      if (/[?&]tskplan=/.test(location.search)) return false;   // fromLink rebuilds the week from their goals
      open(); showQuiz();
      $(R, "#quiz").insertAdjacentHTML("afterbegin", '<p class="built"><b>The menu changed since that email.</b> Answer a few taps and we\'ll build this week\'s version.</p>');
      return true;
    }
    dropParams(["tskplan"]);
    st.packs = []; st.pieces = []; st.pushed = false;
    list.forEach(function (x) { for (var i = 0; i < x[2]; i++) addPack(x[0], x[1]); });
    // spread meals Mon-Fri so the planner view makes sense if they open it later
    var d = 0;
    st.pieces.forEach(function (p) { p.day = d % 5; d++; });
    save(); open(); render();
    if (!wantsOffer) skipOffer = true;   // re-order links (Monday recap) never stop for the first-order email prompt
    checkout();
    return true;
  }
  // what the Week Builder emails read from the profile (sent only once KLAVIYO_LOCKIN is on)
  function emailProps() {
    var total = st.packs.reduce(function (t, k) { return t + info(k).sz.price; }, 0), r = rungFor(total), w = weekStats();
    var groups = {}, order = [];
    st.packs.forEach(function (k) { var key = k.id + "|" + k.opt; if (!groups[key]) { groups[key] = { k: k, n: 0 }; order.push(key); } groups[key].n++; });
    order.sort(function (a, b) { var A = ITEMS[groups[a].k.id], B = ITEMS[groups[b].k.id]; return (A.kind === "meal" ? 0 : 1) - (B.kind === "meal" ? 0 : 1) || groups[b].n - groups[a].n; });
    var items = order.slice(0, 6).map(function (key) {
      var g = groups[key], x = info(g.k);
      return { name: x.m.name, n: g.n, img: x.m.img || "",
        note: (x.m.kind === "meal" && x.m.sizes.length > 1 ? x.sz.name + " · " : "") + x.sz.cal + " cal · " + x.sz.protein + "g protein" };
    });
    return {
      planner_code: goalsCode(), planner_summary: goalsSummary(), planner_saved: new Date().toISOString().slice(0, 10),
      planner_cart_link: cartLink(offerShown()),
      planner_heard: heardYou().replace(/<[^>]+>/g, ""),
      planner_week_line: w.nM + " meals" + (w.snackPacks ? " + " + w.snackPacks + " snacks" : "") + " · about " + w.hours + " hours of cooking back",
      planner_total: total.toFixed(2),
      planner_paid: r && r.pct ? (total * (1 - r.pct / 100)).toFixed(2) : "",
      planner_rung: r ? r.label.toLowerCase() : "",
      planner_items: items, planner_more: Math.max(0, order.length - 6)
    };
  }
  function fromLink() {
    var m = /[?&]tskplan=([a-z0-9.\-]+)/i.exec(location.search);
    if (!m) return;
    var p = m[1].toLowerCase().split(".");
    if (p.length < 6 || !GOALS[p[0]]) return;
    var days = p[3] === "wk" || p[3] === "all" ? p[3] : p[3].split("-").map(Number).filter(function (n) { return n >= 0 && n < 7; });
    qa = { goal: p[0], avoid: p[1] === "none" ? [] : p[1].split("-").filter(function (a) { return a === "gluten" || a === "dairy"; }),
      perDay: { b: "best", l: "lunch", f: "full" }[p[2]] || clamp(+p[2] || 2, 1, 3), days: days.length ? days : "wk", weight: "", own: true, cal: p[4], pro: p[5] };
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
  // Luke 11/19: the three goals read Health / Fitness / Time saved. The keys stay lean / build / maintain so saved plans
  // and ?tskplan links keep working; only the words and the order changed. Health = Fat Loss sizes, most protein per
  // calorie; Fitness = biggest sizes, most protein; Time saved = Performance sizes, menu order.
  var GOALS = {
    lean: { label: "Health", note: "Eat better, feel better, lose a little", calPerLb: 12, proPerLb: 0.9, size: ["Fat Loss"], dflt: [1800, 140] },
    build: { label: "Fitness", note: "More protein for training and recovery", calPerLb: 16, proPerLb: 1.0, size: ["Protein Plus", "Performance", "Fat Loss"], dflt: [2700, 180] },
    maintain: { label: "Time saved", note: "Good food without the cooking", calPerLb: 14, proPerLb: 0.8, size: ["Performance", "Fat Loss"], dflt: [2200, 150] }
  };

  // ------------------------------------------------------------------ quiz v2 (Luke 11/20, talked through on mic): Luke's words between the
  // questions, a pick-any "good week" list per obstacle, only the recommended plan up front. Test link only until he
  // edits the text: ?tskquiz=2 turns it on in one browser, ?tskquiz=1 back to the live version. Q2.ON = true = everyone.
  var Q2 = {
    ON: true,   // LIVE 11/20 (Luke: "push this live")
    PHOTO: BASE_URL + "../img/luke-portrait.jpg",
    goalNote: { lean: "Eat better, feel better, move better", build: "More protein and balanced calories for training and recovery", maintain: "Delicious, convenient food without the hassle" },
    // Luke 11/20: the question names their goal (Time saved wording is Claude's)
    blockQ: { lean: "What gets in the way of eating healthy?", build: "What gets in the way of eating enough protein?", maintain: "What gets in the way of eating well on busy days?" },
    block: [["time", "I don't have the time", "Long days, always something to do"], ["what", "I don't know what to eat", "Nutrition info is confusing"], ["cook", "I don't know how to cook the right foods", "I know what I should eat, just not how to make it taste good"]],
    affirm: {
      lean: "Health doesn't have to be complicated. It mostly comes down to balanced calories, enough protein and fairly consistent mealtimes. Add good sleep and exercise and it's even more powerful.",
      build: "Most fitness goals come down to how many calories you eat and how much protein you get, paired with consistent exercise and strength training.",
      maintain: "When you're busy and there's always something to do, it's easy to put yourself last. Good nutrition falls behind, because you don't have the time or the energy left to cook."
    },
    goodIntro: {
      hate: "You hate cooking, so a good week is one where you don't do any of the hard parts.",
      time: "You're short on time, so a good week is one where food never slows you down.",
      what: "You're not sure what to eat, so a good week is one where it's all figured out for you.",
      cook: "Cooking healthy food well is a skill. A good week is one where it's already made, and made right."
    },
    good: {
      hate: [["shop", "No grocery shopping"], ["prep", "No prepping"], ["cook", "No cooking"], ["portion", "No portioning"], ["clean", "No cleanup"]],
      time: [["stop", "Never stopping to figure out lunch or dinner"], ["rush", "No rushed grocery trips"], ["uber", "No Uber Eats"], ["fast", "No money wasted on calorie-loaded fast food"], ["eve", "Evenings back for what you'd rather do"]],
      cook: [["taste", "Healthy meals that actually taste good"], ["recipes", "No recipes to figure out"], ["waste", "No groceries wasted on meals that didn't work out"], ["protein", "Proteins cooked right, every time"], ["portion", "Learning what a good portion looks like"]],
      what: [["portion", "No worrying about portion control"], ["protein", "Always getting enough protein"], ["enjoy", "Looking forward to my meals"], ["variety", "A good mix of proteins, vegetables and starches"], ["label", "Calories and protein listed on every meal"]]
    },
    planIntro: "Based on what you told me, this is the plan I'd start you on.",
    // Luke 11/20: they choose how much we handle; the plan card then prices that choice. Priciest first.
    handleIntro: "The more of your week we handle, the faster you get there. I'd start most people in the middle, but it's your call.",
    pace: { all: "Fastest", week: "Steady", some: "A start" },
    covers: { all: "Every lunch and dinner, all week", week: "Lunch and dinner Monday to Friday. Weekends are yours", some: "Lunch on workdays" },
    handleIntroHate: "Since you hate cooking, I'd have us do all of it. But it's your call.",
    // Luke 11/20 wording; priciest first, as on the plan screen
    handle: [["all", "full", "I need to see results as fast as possible", "14 meals + snacks: lunch and dinner, every day"],
             ["week", "best", "As fast as possible, without overhauling my life", "10 meals + snacks: lunch and dinner, Monday to Friday"],
             ["some", "lunch", "I'll take my time. I'm not in a rush", "5 meals + snacks: lunch, Monday to Friday"]],
    handleRec: {},
    planWhy: {
      full: "Lunch and dinner every day means you never have to think about food.",
      best: "Lunch and dinner, Monday to Friday, covers the days that are hardest to get right and leaves your weekends free.",
      lunch: "Lunch, Monday to Friday, covers the meal that usually falls apart on a workday, and your evenings stay yours to cook."
    },
    // what to expect, by goal (Luke 11/20 on mic; the Health line is Claude's draft for him to edit)
    expect: {
      maintain: "You'll feel the difference the first week: no cooking and no deciding what's for dinner.",
      build: "Most people feel better right away from the extra protein, and see a little progress each week that keeps adding up. Give yourself 30 days before you weigh in again.",
      lean: "The first week takes the guesswork out. Stick with it and the small, steady changes add up. Give yourself 30 days before you judge the results."
    },
    expectBlock: { hate: "You never have to cook again if you don't want to. And as you eat our meals, you'll get a feel for what a healthy portion looks like." },
    expectAsk: "The one thing I need from you: order by Wednesday night each week.",
    emailLine: "I'll hold this week for you. When you're ready to check out, it only takes a minute to set up your account.",
    emailSub: "Up to 15% off plus free delivery on your first order, depending on the plan you pick. Your week stays saved, so you can check out anytime.",
    targetSub: { lean: "Skip this if your goal isn't about the scale.", build: "Not every fitness goal is about the scale. Skip this if yours isn't." },
    // timeline (Claude's draft; the pace numbers are placeholders for Luke)
    RATE_LOSS: 1, RATE_GAIN: 0.5,   // no longer shown (Luke 11/20: no weight promises)
    REST_CAL: 1205, FAT_CAL: 3500,
    MIN_PER_MEAL: 40,   // Luke 11/20: shopping, prep, cooking, packing and cleanup per home-cooked meal (BLS: ~1 hr/day prep+cleanup for people who cook)
    promiseIntro: "Here's what I can promise you:",
    promise: {
      lean: ["Enough protein in every meal", "Controlled calories, already portioned", "Fiber, plus a mix of vegetables, starches and proteins", "A wide variety of flavors, week to week"],
      build: ["Enough protein for full muscle recovery", "Balanced calories, so you can build muscle without gaining fat, or lean out", "Every meal counted, so you know your numbers"],
      maintain: ["About {hrs} hours back each week: no shopping, prepping, cooking, packing or cleanup", "Lunch and dinner decided before the week starts"]
    },
    tlWeek1: { lean: "Balanced meals in the fridge and nothing to figure out.", build: "Protein in every meal. Most people feel better right away.", maintain: "No cooking and no deciding what's for dinner." },
    tlDay30: "Weigh in again and see how it's going.",
    deadline: "Order by {day} and you get:",
    goalWhy: {
      lean: "You want to eat better, feel better and move better. That comes from balanced meals, eaten consistently.",
      build: "You want your calories and protein on target. That's easiest when both big meals of the day are already planned.",
      maintain: "You want good food without the hassle."
    }
  };
  (function () {
    var m = /[?&]tskquiz=([12])/.exec(location.search);
    if (m) try { if (m[1] === "2") localStorage.setItem("tskpQuiz2", "1"); else localStorage.removeItem("tskpQuiz2"); } catch (e) { /* fine */ }
  })();
  function quizV2() { if (Q2.ON) return true; try { return localStorage.getItem("tskpQuiz2") === "1"; } catch (e) { return false; } }
  // Luke "talking": his photo beside his words
  function lukeSays(html) { return '<div class="luke"><img src="' + Q2.PHOTO + '" alt="Luke" width="44" height="44"><div><b>Luke, owner &amp; chef</b><p>' + html + "</p></div></div>"; }
  function goodLabels(q) {
    var list = (q && q.good && Q2.good[q.block]) || [];
    return list.filter(function (o) { return q.good.indexOf(o[0]) >= 0; }).map(function (o) { return o[1]; });
  }
  function handlePlan(q) { var h = Q2.handle.filter(function (x) { return x[0] === (q && q.handle); })[0]; return h ? h[1] : "best"; }
  function handleScreen() {
      var rec = Q2.handleRec[qa.block] || "week";
      return '<span class="qkick">Your pace</span>' + lukeSays(esc(Q2.handleIntro)) + "<h3>How fast do you want to see results?</h3>" +
        '<div class="opts">' + Q2.handle.map(function (h) {
          var e = previewPlan(h[1]);
          return '<button class="opt' + (h[0] === rec ? " best" : "") + '" data-q="handle" data-v="' + h[0] + '">' + (h[0] === rec ? "★ " : "") + esc(h[2]) +
            "<small>We handle: " + esc(lowerFirst(Q2.covers[h[0]])) + '</small><em class="ppace">' + esc(paceLine(e).charAt(0).toUpperCase() + paceLine(e).slice(1)) + "</em></button>";
        }).join("") + "</div>";
  }
  function paceLine(e) {
    if (qa.goal === "build") return "about " + fmt(Math.round(e.proWeek / 10) * 10) + "g of protein a week from us";
    if (qa.goal === "maintain") return "about " + e.hours + " hours back a week";
    var saved = Math.round(e.meals * (Q2.REST_CAL - e.mealCal) / 100) * 100;
    return "about " + fmt(saved) + " fewer calories a week than takeout";
  }
  function lowerFirst(t) { return t.charAt(0).toLowerCase() + t.slice(1); }
  function joinList(a) { return a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
  var qa = null, qstep = 0, plansOpen = false;
  function showQuiz() {
    qa = st.quiz ? JSON.parse(JSON.stringify(st.quiz)) : { goal: null, block: null, want: null, avoid: [], perDay: null, days: null, weight: "", own: false, cal: "", pro: "" };
    if (!qa.good) qa.good = [];
    qa.handleDone = false; qa.handle = null; V2.at = "goal"; V2.email = null;
    qstep = 0; plansOpen = false;
    $(R, ".in").classList.add("quizzing"); $(R, "#quiz").hidden = false; $(R, "#built").hidden = true;
    drawQuiz();
  }
  function endQuiz() { $(R, ".in").classList.remove("quizzing"); $(R, "#quiz").hidden = true; }
  // ------------------------------------------------------------------ funnel events for GA4 (Luke 11/18: who uses it, where they drop)
  // GTM already forwards every dataLayer event that starts with skf_ to GA4 with its skf_form value (popup chat 11/18).
  var STEP_NAMES = ["goal", "obstacle", "good_week", "avoid", "weight", "plan", "per_day", "days", "email"], lastStep = -1;
  // Who is this visitor, for reporting (Luke 11/19: "how many were current customers?"). Rides in skf_form, which GA4
  // already collects, so no GTM/GA4 change: planner-customer = signed in with orders, planner-account = signed in, no
  // orders, planner-known = not signed in but Klaviyo knows the browser (customer OR email subscriber), planner-new = neither.
  // Worked out once per visit; every event waits for it (max ~3 s) so events keep their order. No names or emails.
  var kindP = null;
  function visitorKind() {
    if (kindP) return kindP;
    if (signedIn()) return (kindP = hasOrders().then(function (h) { return h ? "customer" : "account"; }));
    kindP = new Promise(function (done) {
      var tries = 0;
      (function look() {
        var k = window.klaviyo;
        if (k && typeof k.isIdentified === "function") {
          Promise.resolve(k.isIdentified()).then(function (v) { done(v ? "known" : "new"); }, function () { done("unknown"); });
        } else if (++tries > 12) done("unknown"); else setTimeout(look, 250);
      })();
    });
    return kindP;
  }
  function track(name) {
    visitorKind().then(function (kind) {
      try { (window.dataLayer = window.dataLayer || []).push({ event: "skf_planner_" + name, skf_form: "planner-" + kind }); } catch (e) { /* fine */ }
    }, function () { /* fine */ });
  }
  function drawQuiz() {
    if (quizV2()) return drawQuizV2();
    if (qstep !== lastStep) { lastStep = qstep; track("step_" + (STEP_NAMES[qstep] || qstep)); }
    var q = $(R, "#quiz"), n = qstep === 8 ? 6 : qstep > 5 ? 8 : 6;
    var head = '<div class="qdots">' + Array.apply(null, Array(n)).map(function (_, i) { return '<i class="' + (i <= qstep ? "on" : "") + '"></i>'; }).join("") + "</div>";
    var back = qstep ? '<button class="qback" data-q="back">← Back</button>' : "";
    function opts(key, list, multi) {
      return '<div class="opts">' + list.map(function (o) {
        var on = multi ? qa[key].indexOf(o[0]) >= 0 : qa[key] === o[0];
        return '<button class="opt" data-q="' + (multi ? "toggle" : "pick") + '" data-k="' + key + '" data-v="' + o[0] + '" aria-pressed="' + on + '">' + esc(o[1]) + (o[2] ? "<small>" + esc(o[2]) + "</small>" : "") + "</button>";
      }).join("") + "</div>";
    }
    var body, v2 = quizV2();
    if (v2 && qstep === 0) body = '<span class="qkick">30 seconds</span><h3>What are you working toward?</h3><p>We\'ll build a week of our meals around it.</p>' +
      opts("goal", Object.keys(GOALS).map(function (k) { return [k, GOALS[k].label, Q2.goalNote[k]]; }));
    else if (v2 && qstep === 1) body = lukeSays(esc(Q2.affirm[qa.goal] || "")) + "<h3>What gets in the way the most?</h3>" + opts("block", Q2.block);
    else if (v2 && qstep === 2) body = lukeSays(esc(Q2.goodIntro[qa.block] || "")) + "<h3>What would a good week look like?</h3><p>Pick any that matter to you.</p>" +
      opts("good", Q2.good[qa.block] || [], true) +
      '<button class="qnext" data-q="next"' + (qa.good.length ? "" : " disabled") + ">Next</button>";
    else if (v2 && qstep === 3 && !qa.handle && !qa.handleDone) body = handleScreen();
    else if (qstep === 0) body = '<span class="qkick">30 seconds</span><h3>What are you working toward?</h3><p>We\'ll build a week of our meals around it.</p>' +
      opts("goal", Object.keys(GOALS).map(function (k) { return [k, GOALS[k].label, GOALS[k].note]; }));
    else if (qstep === 1) body = "<h3>What gets in the way most?</h3><p>Pick the biggest one.</p>" +
      // Luke 11/19: three obstacles. Old answers (out / bored / protein) still read back for saved plans.
      opts("block", [["hate", "I hate cooking", "Shopping, cooking, dishes: none of it"], ["time", "I don't have the time", "Long days, and cooking eats the evening"],
        ["what", "I don't know what to eat", "Every night it's the same question"]]);
    else if (qstep === 2) body = "<h3>What would a good week look like?</h3>" +
      // Luke 11/19: three answers. Old ones (time / protein / progress) still read back for saved plans.
      opts("want", [["easy", "Never wondering what to eat", "It's already in the fridge"], ["health", "Improved health", "Real food, portioned right"],
        ["recovery", "Better workout recovery", "Protein in every meal"]]);
    else if (qstep === 3) body = "<h3>Anything you avoid?</h3><p>Pick any that apply.</p>" +
      opts("avoid", [["gluten", "Gluten"], ["dairy", "Dairy"]], true) +
      '<button class="qnext" data-q="next">' + (qa.avoid.length ? "Next" : "No restrictions, next") + "</button>";
    else if (qstep === 4) {
      var g = GOALS[qa.goal];
      body = "<h3>What do you weigh?</h3><p>We use it to estimate your daily calories and protein. It stays on this device.</p>" +
        (qa.own
          ? '<div class="qrow"><input id="qCal" type="number" inputmode="numeric" placeholder="Calories" value="' + esc(qa.cal) + '"><input id="qPro" type="number" inputmode="numeric" placeholder="Protein (g)" value="' + esc(qa.pro) + '"></div>'
          : '<div class="qrow"><input id="qW" type="number" inputmode="numeric" placeholder="e.g. 180" value="' + esc(qa.weight) + '"><span>lbs</span></div>') +
        '<button class="qnext" data-q="wnext">Next</button>' +
        '<button class="qlink" data-q="own">' + (qa.own ? "Use my weight instead" : "I already know my numbers") + "</button>" +
        '<button class="qlink" data-q="skip">Skip, use typical numbers (' + fmt(g.dflt[0]) + " cal · " + g.dflt[1] + "g)</button>" +
        '<p class="qnote">An estimate to plan with, not medical advice.</p>';
    } else if (v2 && qstep === 5 && !qa.handle) {
      body = handleScreen();
    } else if (qstep === 5) {
      // Luke 11/18: three plans, the middle one recommended, the top one the anchor. Prices are this week's menu, built to their goal.
      var mine = v2 ? handlePlan(qa) : "best", showPlans = v2 && !plansOpen ? [mine] : PLANS;
      body = (v2 ? '<span class="qkick">Last step</span>' + lukeSays(esc(Q2.planIntro)) + "<h3>Your plan</h3><p>Priced on this week\'s menu and built to your goal, protein snacks included. Change anything after.</p>"
                 : '<span class="qkick">Last step</span><h3>Pick your plan</h3><p>Priced on this week\'s menu and built to your goal, protein snacks included. Change anything after.</p>') + ASSURE +
        '<div class="opts">' + showPlans.map(function (k) {
          var P = PLAN_INFO[k], e = previewPlan(k), rr = offerShown() ? rungFor(e.total) : null;
          var price = rr && rr.pct ? '<s class="pold">$' + Math.round(e.total) + "</s> $" + Math.round(e.total * (1 - rr.pct / 100)) : "$" + Math.round(e.total);
          var star = k === mine;
          return '<button class="opt plan' + (star ? " best" : "") + '" data-q="plan" data-v="' + k + '">' +
            '<span class="ptop"><span>' + (star ? "★ " : "") + esc(v2 && star ? "Your plan" : P.name) + '</span><span class="pprice">' + price + "</span></span>" +
            "<small>" + esc(P.what) + " · " + e.meals + " meals" + (e.snacks ? " + " + e.snacks + " snack" + (e.snacks > 1 ? "s" : "") : "") + "</small>" + (offerShown() && rungFor(e.total) ? '<em class="prung">First order: ' + esc(rungFor(e.total).label.toLowerCase()) + "</em>" : "") + (k === mine ? whyRec(e, k) : "") + "</button>";
        }).join("") + "</div>" +
        (v2 ? '<p class="sulab">What to expect</p>' + lukeSays(esc([Q2.expectBlock[qa.block], Q2.expect[qa.goal], Q2.expectAsk].filter(Boolean).join(" "))) : "") +
        (v2 && !plansOpen ? '<button class="qlink" data-q="moreplans">See the other plans</button>' : "") +
        '<button class="qlink" data-q="custom">Let me choose meals a day and days</button>';
    } else if (qstep === 8) {
      var e8 = previewPlan(qa.perDay), r8 = rungFor(e8.total);
      // Luke 11/19: lead with the money. The % rungs show a dollar figure; delivery fees vary, so delivery stays in words.
      var off8 = r8 && r8.pct ? Math.round(e8.total * r8.pct) / 100 : 0;
      var head8 = off8 ? "Where should we send your $" + off8.toFixed(2) + " off?" : r8 ? "Where should we send your free delivery?" : "Where should we save it?";
      if (v2) {   // Luke 11/20: "entering their email to activate the code", and they can check out any time
        head8 = off8 ? "Enter your email to activate your $" + off8.toFixed(2) + " off" : r8 ? "Enter your email to activate free delivery" : "Enter your email to save your week";
        body = '<span class="qkick">Your week is ready</span>' + lukeSays(esc(Q2.emailLine)) + "<h3>" + head8 + "</h3>" +
          "<p>" + (off8 ? r8.pct + "% off this week plus free delivery, on your first order. " : r8 ? "Free delivery on your first order. " : "") + "Your week stays saved, so you can check out anytime.</p>" +
          '<div class="qrow"><input id="qEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@email.com" style="width:100%"></div>' +
          '<p class="qerr" id="qErr" hidden>That email doesn&#39;t look right.</p>' +
          '<button class="qnext" data-q="email">Activate my savings</button>' +
          '<button class="qlink" data-q="noemail">Skip for now</button>' +
          (OFFER.KLAVIYO_LOCKIN ? '<p class="qnote">You&#39;ll get emails from The Strong Kitchen. Unsubscribe anytime.</p>' : "");
      } else
      body = '<span class="qkick">Your week is ready</span><h3>' + head8 + "</h3>" +
        "<p>" + (off8 ? "That's " + r8.pct + "% off this week, plus free delivery, on your first order. "
                      : r8 ? "Free delivery on your first order. " : "") +
        (OFFER.KLAVIYO_LOCKIN ? "We'll also email you your week so you can finish anytime." : "We'll hold your week so you can finish anytime.") + "</p>" +
        '<div class="qrow"><input id="qEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@email.com" style="width:100%"></div>' +
        '<p class="qerr" id="qErr" hidden>That email doesn\'t look right.</p>' +
        '<button class="qnext" data-q="email">Show my week</button>' +
        '<button class="qlink" data-q="noemail">Skip for now</button>' +
        (OFFER.KLAVIYO_LOCKIN ? '<p class="qnote">You&#39;ll get emails from The Strong Kitchen. Unsubscribe anytime.</p>' : "");
    } else if (qstep === 6) body = "<h3>How many of our meals a day?</h3>" +
      opts("perDay", [[1, "One a day", "Usually lunch"], [2, "Two a day", "Lunch and dinner"], [3, "Three a day", "We cover most of your eating"]]);
    else {
      var picking = qa.days && qa.days !== "wk" && qa.days !== "all";
      body = "<h3>Which days?</h3>" +
        opts("days", [["wk", "Weekdays", "Monday to Friday"], ["all", "Every day", "All seven days"], ["pick", "Let me pick"]]).replace('data-v="pick" aria-pressed="false"', 'data-v="pick" aria-pressed="' + picking + '"');
      if (picking) body += '<div class="daychips">' + DAYS.map(function (D, i) { return '<button data-q="day" data-v="' + i + '" aria-pressed="' + (qa.days.indexOf(i) >= 0) + '">' + D.short + "</button>"; }).join("") + '</div><button class="qnext" data-q="next"' + (qa.days.length ? "" : " disabled") + ">Build my week</button>";
    }
    q.innerHTML = head + back + body;
  }
  function quizClick(b) {
    var a = b.dataset.q;
    if (/^su/.test(a)) return signupClick(a, b);
    if (quizV2()) return quizClickV2(b);
    if (a === "back" && quizV2() && qstep === 3 && qa.handle) { qa.handle = null; qa.handleDone = false; return drawQuiz(); }
    if (a === "back" && quizV2() && qstep === 3 && !qa.handle) { qstep = 2; return drawQuiz(); }
    if (a === "back") { qstep = qstep === 8 ? (PLAN_INFO[qa.perDay] ? 5 : 7) : qstep - 1; return drawQuiz(); }
    if (a === "plan") { track("plan_" + b.dataset.v); qa.perDay = b.dataset.v; qa.days = PLAN_INFO[b.dataset.v].days; return askEmailOrBuild(); }
    if (a === "email") {
      var ev = $(R, "#qEmail").value.trim();
      if (!validEmail(ev)) { $(R, "#qErr").hidden = false; $(R, "#qEmail").focus(); return; }
      track("email"); buildWeek(); lockIn(ev); return;
    }
    if (a === "noemail") { track("email_skip"); return buildWeek(); }
    if (a === "custom") { qstep = 6; return drawQuiz(); }
    if (a === "pick") {
      var k = b.dataset.k, v = b.dataset.v;
      if (k === "perDay") v = +v;
      if (k === "days") {
        qa.days = v === "pick" ? [] : v;
        if (v === "pick") return drawQuiz();
        return askEmailOrBuild();   // the days question is the last one on the custom path
      }
      if (k === "block" && qa.block !== v) { qa.good = []; qa.handle = null; qa.handleDone = false; }
      qa[k] = v;
      qstep++; return drawQuiz();
    }
    if (a === "toggle") { var arr = qa[b.dataset.k] || (qa[b.dataset.k] = []), i = arr.indexOf(b.dataset.v); if (i >= 0) arr.splice(i, 1); else arr.push(b.dataset.v); return drawQuiz(); }
    if (a === "handle") { qa.handle = b.dataset.v; qa.handleDone = true; plansOpen = false; track("handle_" + b.dataset.v); return drawQuiz(); }
    if (a === "moreplans") { plansOpen = true; track("plans_more"); return drawQuiz(); }
    if (a === "day") { var d = +b.dataset.v, j = qa.days.indexOf(d); if (j >= 0) qa.days.splice(j, 1); else qa.days.push(d); return drawQuiz(); }
    if (a === "next") { if (qstep === 7) return askEmailOrBuild(); qstep++; return drawQuiz(); }
    if (a === "own") { readQuizInputs(); qa.own = !qa.own; return drawQuiz(); }
    if (a === "skip") { qa.weight = ""; qa.own = false; qstep = 5; return drawQuiz(); }
    if (a === "wnext") { readQuizInputs(); qstep = 5; return drawQuiz(); }
  }
  // new visitors who haven't locked in yet get the email step; current customers and anyone already locked in go straight to the week
  function askEmailOrBuild() {
    // signed in with no orders: the account already gives us the email, so the account is the lock-in
    if (offerShown() && !getOffer() && signedIn()) { setOffer({ email: "", via: "account", at: Date.now() }); return buildWeek(); }
    if (offerShown() && !getOffer()) { qstep = 8; drawQuiz(); var f = $(R, "#qEmail"); if (f) f.focus(); return; }
    return buildWeek();
  }
  // ------------------------------------------------------------------ quiz v2 order (Luke 11/20, Hormozi's diagnostic sale):
  // questionnaire -> info (email) -> current -> desired -> timeline -> the option (how much we handle) -> price.
  // Steps are named, not numbered, so screens can come and go (email only for new visitors, target weight only with a weight).
  var V2 = { at: "goal", email: null, pending: null };
  function v2Steps() {
    var s = ["goal", "block", "good"];
    if (V2.email) s.push("email");
    s.push("avoid", "weight");
    // (the target-weight screen is off: Luke 11/20, we don't promise a weight)
    return s.concat(["timeline", "handle", "plan"]);
  }
  function v2Go(dir) {
    if (V2.at === "good" && dir > 0 && V2.email === null) V2.email = offerShown() && !getOffer();
    var s = v2Steps(), i = s.indexOf(V2.at);
    V2.at = s[Math.max(0, Math.min(s.length - 1, i + dir))];
    drawQuizV2();
    var f = $(R, "#quiz input:not([type=checkbox])"); if (f && dir > 0) f.focus({ preventScroll: true });
  }
  // the email is held until the week exists, so the first follow-up email can show it; leaving early still signs them up
  function v2Flush() { if (V2.pending) { var e = V2.pending; V2.pending = null; lockIn(e); } }
  window.addEventListener("pagehide", v2Flush);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") v2Flush(); });
  function v2Weeks() {
    var w = +qa.weight, t = +qa.target;
    if (!(w > 0 && t > 0) || w === t) return null;
    var lose = w > t, rate = lose ? Q2.RATE_LOSS : Q2.RATE_GAIN;
    return { lose: lose, diff: Math.abs(w - t), weeks: Math.ceil(Math.abs(w - t) / rate), rate: rate, t: t };
  }
  function v2Timeline() {
    var rows = [["This week", Q2.tlWeek1[qa.goal]]];
    if (qa.goal !== "maintain") rows.push(["Day 30", Q2.tlDay30]);
    var pv = previewPlan("best");
    if (pv.mealCal) rows.splice(1, 0, ["Every meal", "About " + pv.mealCal + " calories, already portioned. The average restaurant meal is about " + fmt(Math.round(Q2.REST_CAL / 100) * 100) + " (Tufts University study)."]);
    rows.push(["Every Wednesday", Q2.expectAsk]);
    return '<ol class="tl">' + rows.map(function (r) { return "<li><b>" + esc(r[0]) + "</b><span>" + esc(r[1]) + "</span></li>"; }).join("") + "</ol>";
  }
  function drawQuizV2() {
    if (V2.at !== lastStep) { lastStep = V2.at; track("step_" + V2.at); }
    var q = $(R, "#quiz"), s = v2Steps(), i = Math.max(0, s.indexOf(V2.at));
    var head = '<div class="qdots">' + s.map(function (_, j) { return '<i class="' + (j <= i ? "on" : "") + '"></i>'; }).join("") + "</div>";
    var back = i ? '<button class="qback" data-q="back">← Back</button>' : "";
    function opts(key, list, multi) {
      return '<div class="opts">' + list.map(function (o) {
        var on = multi ? (qa[key] || []).indexOf(o[0]) >= 0 : qa[key] === o[0];
        return '<button class="opt" data-q="' + (multi ? "toggle" : "pick") + '" data-k="' + key + '" data-v="' + o[0] + '" aria-pressed="' + on + '">' + esc(o[1]) + (o[2] ? "<small>" + esc(o[2]) + "</small>" : "") + "</button>";
      }).join("") + "</div>";
    }
    var body = "", at = V2.at, g = GOALS[qa.goal];
    if (at === "goal") body = '<span class="qkick">30 seconds</span><h3>What are you working toward?</h3><p>We\'ll build a week of our meals around it.</p>' +
      opts("goal", Object.keys(GOALS).map(function (k) { return [k, GOALS[k].label, Q2.goalNote[k]]; }));
    else if (at === "block") body = lukeSays(esc(Q2.affirm[qa.goal] || "")) + "<h3>" + esc(Q2.blockQ[qa.goal] || "What gets in the way the most?") + "</h3>" + opts("block", Q2.block);
    else if (at === "good") body = lukeSays(esc(Q2.goodIntro[qa.block] || "")) + "<h3>What would a good week look like?</h3><p>Pick any that matter to you.</p>" +
      opts("good", Q2.good[qa.block] || [], true) + '<button class="qnext" data-q="next"' + ((qa.good || []).length ? "" : " disabled") + ">Next</button>";
    else if (at === "email") body = '<span class="qkick">Your savings</span>' + lukeSays(esc(Q2.emailLine)) +
      "<h3>Enter your email to activate your savings</h3><p>" + esc(Q2.emailSub) + "</p>" +
      '<div class="qrow"><input id="qEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@email.com" style="width:100%" value="' + esc(V2.pending || "") + '"></div>' +
      '<p class="qerr" id="qErr" hidden>That email doesn&#39;t look right.</p>' +
      '<button class="qnext" data-q="v2email">Activate my savings</button><button class="qlink" data-q="next">Skip for now</button>' +
      (OFFER.KLAVIYO_LOCKIN ? '<p class="qnote">You&#39;ll get emails from The Strong Kitchen. Unsubscribe anytime.</p>' : "");
    else if (at === "avoid") body = "<h3>Anything you avoid?</h3><p>Pick any that apply.</p>" + opts("avoid", [["gluten", "Gluten"], ["dairy", "Dairy"]], true) +
      '<button class="qnext" data-q="next">' + (qa.avoid.length ? "Next" : "No restrictions, next") + "</button>";
    else if (at === "weight") body = "<h3>What do you weigh today?</h3><p>We use it to estimate your daily calories and protein. It stays on this device.</p>" +
      (qa.own
        ? '<div class="qrow"><input id="qCal" type="number" inputmode="numeric" placeholder="Calories" value="' + esc(qa.cal) + '"><input id="qPro" type="number" inputmode="numeric" placeholder="Protein (g)" value="' + esc(qa.pro) + '"></div>'
        : '<div class="qrow"><input id="qW" type="number" inputmode="numeric" placeholder="e.g. 180" value="' + esc(qa.weight) + '"><span>lbs</span></div>') +
      '<button class="qnext" data-q="v2w">Next</button>' +
      '<button class="qlink" data-q="own">' + (qa.own ? "Use my weight instead" : "I already know my numbers") + "</button>" +
      '<button class="qlink" data-q="v2wskip">Skip, use typical numbers (' + fmt(g.dflt[0]) + " cal · " + g.dflt[1] + "g)</button>" +
      '<p class="qnote">An estimate to plan with, not medical advice.</p>';
    else if (at === "target") body = "<h3>What weight are you aiming for?</h3><p>" + esc(Q2.targetSub[qa.goal] || "") + "</p>" +
      '<div class="qrow"><input id="qT" type="number" inputmode="numeric" placeholder="e.g. ' + Math.round(+qa.weight * (qa.goal === "build" ? 1.03 : 0.92)) + '" value="' + esc(qa.target || "") + '"><span>lbs</span></div>' +
      '<p class="qerr" id="qErr" hidden>Add a weight, or skip this one.</p>' +
      '<button class="qnext" data-q="v2t">Next</button><button class="qlink" data-q="v2tskip">Skip this one</button>';
    else if (at === "timeline") body = '<span class="qkick">What to expect</span>' + lukeSays(esc(Q2.promiseIntro) + '<ul class="prom">' +
        (Q2.promise[qa.goal] || []).map(function (x) { return "<li>" + esc(x.replace("{hrs}", previewPlan("best").hours)) + "</li>"; }).join("") + "</ul>") + v2Timeline() +
      '<button class="qnext" data-q="next">See my options</button>';
    else if (at === "handle") body = handleScreen();
    else {
      var mine = handlePlan(qa), list = plansOpen ? PLANS : [mine];
      body = '<span class="qkick">Last step</span>' + lukeSays(esc(Q2.planIntro)) + "<h3>Your plan</h3><p>Priced on this week's menu and built to your goal, protein snacks included. Change anything after.</p>" + ASSURE +
        '<div class="opts">' + list.map(function (k) {
          var P = PLAN_INFO[k], e = previewPlan(k), rr = offerShown() ? rungFor(e.total) : null, star = k === mine;
          // Luke 11/20: the full price first (the anchor), then what ordering by the deadline takes off it
          var stack = savingsStack(e.total, rr);
          return '<button class="opt plan' + (star ? " best" : "") + '" data-q="plan" data-v="' + k + '">' +
            '<span class="ptop"><span>' + (star ? "★ Your plan" : esc(P.name)) + '</span><span class="pprice">$' + e.total.toFixed(2) + "</span></span>" +
            "<small>" + esc(P.what) + " · " + e.meals + " meals" + (e.snacks ? " + " + e.snacks + " snack" + (e.snacks > 1 ? "s" : "") : "") + "</small>" +
            stack + (star ? whyRec(e, k) + '<span class="pcta">Build my week →</span>' : "") + "</button>";
        }).join("") + "</div>" +
        (plansOpen ? "" : '<button class="qlink" data-q="moreplans">See the other plans</button>');
    }
    q.innerHTML = head + back + body;
  }
  function savingsStack(total, rr) {
    if (!rr) return "";
    var off = rr.pct ? Math.round(total * rr.pct) / 100 : 0;
    return '<span class="pstack"><span class="pdead">' + esc(v2Deadline()) + "</span>" +
      '<span class="prow"><span>✓ Free delivery</span><span>Free</span></span>' +
      (off ? '<span class="prow"><span>✓ ' + rr.pct + "% off your first order</span><span>−$" + off.toFixed(2) + "</span></span>" : "") +
      '<span class="prow ptot"><span>Your first order</span><span>$' + (total - off).toFixed(2) + "</span></span></span>";
  }
  // the bottom bar's one-line version (a phone has no room for the box there)
  function savingsLine(total, rr) {
    var off = rr.pct ? Math.round(total * rr.pct) / 100 : 0;
    return '<div class="member offer"><b>' + esc(v2Deadline().replace(/ and you get:$/, "")) + ":</b> free delivery" + (off ? " + " + rr.pct + "% off" : "") +
      " · first order <b>$" + (total - off).toFixed(2) + "</b></div>";
  }
  function v2Deadline() {
    var d = new Date(), add = (3 - d.getDay() + 7) % 7;   // 3 = Wednesday; on a Wednesday it's tonight
    d.setDate(d.getDate() + add);
    return Q2.deadline.replace("{day}", add === 0 ? "tonight" : add === 1 ? "tomorrow night" : "Wednesday " + (d.getMonth() + 1) + "/" + d.getDate());
  }
  function quizClickV2(b) {
    var a = b.dataset.q;
    if (a === "back") { readQuizInputs(); return v2Go(-1); }
    if (a === "pick") {
      var k = b.dataset.k, v = b.dataset.v;
      if (k === "block" && qa.block !== v) qa.good = [];
      qa[k] = v; return v2Go(1);
    }
    if (a === "toggle") { var arr = qa[b.dataset.k] || (qa[b.dataset.k] = []), i = arr.indexOf(b.dataset.v); if (i >= 0) arr.splice(i, 1); else arr.push(b.dataset.v); return drawQuizV2(); }
    if (a === "next") { if (V2.at === "email") track("email_skip"); return v2Go(1); }
    if (a === "v2email") {
      var ev = $(R, "#qEmail").value.trim();
      if (!validEmail(ev)) { $(R, "#qErr").hidden = false; $(R, "#qEmail").focus(); return; }
      track("email"); setOffer({ email: ev, at: Date.now() }); V2.pending = ev; return v2Go(1);
    }
    if (a === "own") { readQuizInputs(); qa.own = !qa.own; return drawQuizV2(); }
    if (a === "v2w") { readQuizInputs(); return v2Go(1); }
    if (a === "v2wskip") { qa.weight = ""; qa.own = false; qa.target = ""; return v2Go(1); }
    if (a === "v2t") {
      var t = +$(R, "#qT").value;
      if (!(t > 50 && t < 600)) { $(R, "#qErr").hidden = false; return; }
      qa.target = String(Math.round(t)); return v2Go(1);
    }
    if (a === "v2tskip") { qa.target = ""; return v2Go(1); }
    if (a === "handle") { qa.handle = b.dataset.v; plansOpen = false; track("handle_" + b.dataset.v); return v2Go(1); }
    if (a === "moreplans") { plansOpen = true; track("plans_more"); return drawQuizV2(); }
    if (a === "plan") {
      track("plan_" + b.dataset.v); qa.perDay = b.dataset.v; qa.days = PLAN_INFO[b.dataset.v].days;
      buildWeek(); v2Flush(); return;
    }
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
  // meals a day from us on day d (0 = Monday): the recommended plan is 2 on weekdays, 1 on the weekend
  var ASSURE = '<div class="assure"><span>✓ Keeps 7 days</span><span>✓ Hot in 3 minutes</span><span>✓ No subscription</span></div>';
  var PLANS = ["full", "best", "lunch"];   // Luke 11/19: priciest on top, so it gets more affordable as they read down
  var PLAN_INFO = {
    lunch: { name: "Lunch plan", what: "Lunch Mon–Fri", days: "wk", code: "l" },
    best: { name: "Recommended", what: "Lunch + dinner Mon–Fri", days: "wk", code: "b" },
    full: { name: "Full week", what: "Lunch + dinner, all 7 days", days: "all", code: "f" }
  };
  function perDayFor(q, d) {
    if (q.perDay === "lunch") return d < 5 ? 1 : 0;
    if (q.perDay === "best") return d < 5 ? 2 : 0;
    if (q.perDay === "full") return 2;
    return q.perDay;
  }
  // build a plan off to the side to price its card, then put everything back
  function previewPlan(k) {
    var keepSt = JSON.stringify(st), keepQa = JSON.stringify(qa);
    qa.perDay = k; qa.days = PLAN_INFO[k].days;
    planCore();
    var out = { total: st.packs.reduce(function (t, x) { return t + info(x).sz.price; }, 0),
      meals: st.pieces.filter(function (x) { return x.day >= 0 && ITEMS[x.id].kind === "meal"; }).length,
      snacks: st.packs.filter(function (x) { return ITEMS[x.id].kind !== "meal"; }).length };
    var mp = st.pieces.filter(function (x) { return x.day >= 0 && ITEMS[x.id].kind === "meal"; });
    try { out.hours = weekStats().hours; } catch (e) { out.hours = Math.round(out.meals * Q2.MIN_PER_MEAL / 60); }   // same count the built week shows
    out.proWeek = st.pieces.filter(function (x) { return x.day >= 0; }).reduce(function (t, x) { return t + info(x).sz.protein; }, 0);
    out.mealCal = mp.length ? Math.round(mp.reduce(function (t, x) { return t + info(x).sz.cal; }, 0) / mp.length) : 0;
    st = JSON.parse(keepSt); qa = JSON.parse(keepQa);
    return out;
  }
  // Luke 11/19: the recommended card says WHY, in terms of their own answers. Weekdays are where cooking falls apart;
  // lunch + dinner Mon-Fri covers those meals and leaves weekends free. Then one line tied to their obstacle, and the
  // discount when this plan is the one that reaches it.
  function whyRec(e) {
    if (quizV2()) return whyRecV2(e, arguments[1]);
    var hrs = Math.round(e.meals * Q2.MIN_PER_MEAL / 60);
    var tie = {
      hate: "That's " + e.meals + " meals you never cook.",
      time: "That's about " + hrs + " hours of cooking and dishes back.",
      what: "That's " + e.meals + " \"what's for dinner\" questions already answered.",
      out: "That's " + e.meals + " fewer takeout nights.",
      bored: "That's " + e.meals + " meals across the week's menu.",
      protein: "That's both big meals of the day with protein built in."
    }[qa.block] || "";
    var lunch = previewPlan("lunch"), r = offerShown() ? rungFor(e.total) : null, rl = offerShown() ? rungFor(lunch.total) : null;
    var save = r && r.pct && (!rl || rl.pct < r.pct) ? " It also unlocks " + r.pct + "% off your first order." : "";
    return '<span class="pwhyrec"><b>Why we recommend it:</b> weekdays are when cooking falls apart. Lunch and dinner, Monday to Friday, ' +
      "covers those and leaves your weekends free. " + esc(tie) + save + "</span>";
  }
  function v2Hours(meals) { return Math.round(meals * Q2.MIN_PER_MEAL / 60); }
  function calSwap(e) {
    if (qa.goal === "maintain") return " That's about " + e.hours + " hours of shopping, prepping, cooking and cleanup back each week.";
    if (qa.goal === "maintain" || !e.mealCal || e.mealCal >= Q2.REST_CAL) return "";
    var saved = Math.round(e.meals * (Q2.REST_CAL - e.mealCal) / 100) * 100;
    return " If these " + e.meals + " meals replace takeout, that's about " + fmt(saved) + " fewer calories a week, around " +
      (Math.round(saved / Q2.FAT_CAL * 2) / 2) + " lb of fat's worth.";
  }
  function whyRecV2(e, k) {
    var picks = goodLabels(qa).map(lowerFirst);
    var lunch = previewPlan("lunch"), r = offerShown() ? rungFor(e.total) : null, rl = offerShown() ? rungFor(lunch.total) : null;
    var save = r && r.pct && (!rl || rl.pct < r.pct) ? " It also unlocks " + r.pct + "% off your first order." : "";
    return '<span class="pwhyrec"><b>Why I recommend it:</b> ' + esc(Q2.goalWhy[qa.goal] || "") +
      " " + esc(Q2.planWhy[k || "best"]) +
      (picks.length ? " You told me a good week means " + esc(joinList(picks)) + ". This plan does that for " + e.meals + " meals." : "") +
      (qa.handle === "all" ? " " + esc(Q2.expectBlock.hate) : "") +
      calSwap(e) + "</span>";
  }
  function quizDays() { return qa.days === "wk" ? [0, 1, 2, 3, 4] : qa.days === "all" ? [0, 1, 2, 3, 4, 5, 6] : qa.days.slice().sort(); }
  function planCore() {
    var nums = goalNumbers(), g = GOALS[qa.goal], days = quizDays();
    st.cal = nums[0]; st.pro = nums[1]; st.quiz = qa; st.packs = []; st.pieces = []; st.pushed = false;
    var meals = DATA.items.filter(function (m) { return m.kind === "meal" && fits(m); });
    // Lean: most protein per calorie first; build: most protein first; maintain: menu order
    var size = function (m) { for (var i = 0; i < g.size.length; i++) { var s = m.sizes.filter(function (z) { return z.name === g.size[i]; })[0]; if (s) return s; } return m.sizes[0]; };
    if (qa.goal === "lean") meals.sort(function (a, b) { return size(b).protein / size(b).cal - size(a).protein / size(a).cal; });
    if (qa.goal === "build") meals.sort(function (a, b) { return size(b).protein - size(a).protein; });
    var k = 0, added = [];
    if (meals.length) days.forEach(function (d) { for (var j = 0; j < perDayFor(qa, d); j++) { var m = meals[k++ % meals.length]; takePiece(m.id, size(m).option_id, d); } });
    // Top up protein toward our share of the day (one meal of three = a third) with protein oatmeal and protein bites.
    // Luke 11/18: drive meals and snacks, not sides.
    var share = function (d) { return Math.min(1, perDayFor(qa, d) / 3); };
    var oats = DATA.items.filter(function (m) { return m.kind === "snack" && fits(m) && /protein oatmeal/i.test(m.name); });
    var bites = DATA.items.filter(function (m) { return m.kind === "snack" && fits(m) && /protein bite/i.test(m.name); })[0];
    var oi = 0;
    // Luke 11/18: first move a meal up to Protein Plus (protein is the point; calories are the goal's job), then oatmeal, then at most 2 bites a day
    var upgrade = function (d) {
      var p = st.pieces.filter(function (x) { var m = ITEMS[x.id]; return x.day === d && m.kind === "meal" && x.opt !== pp(m) && pp(m); })
        .sort(function (a, b) { return (ITEMS[b.id].sizes.filter(function (z) { return z.option_id === pp(ITEMS[b.id]); })[0].protein - info(b).sz.protein) - (ITEMS[a.id].sizes.filter(function (z) { return z.option_id === pp(ITEMS[a.id]); })[0].protein - info(a).sz.protein); })[0];
      if (!p) return false;
      var o = pp(ITEMS[p.id]); p.opt = o; st.packs.forEach(function (k) { if (k.pid === p.pid) k.opt = o; });
      return true;
    };
    var pp = function (m) { var z = m.sizes.filter(function (s) { return s.name === "Protein Plus"; })[0]; return z ? z.option_id : null; };
    if (meals.length) days.forEach(function (d) {
      var hadOats = false, nBites = 0;
      while (st.pro * share(d) - dayTotals(d).pro >= 6 && upgrade(d)) {}
      for (var t = 0; t < 3; t++) {
        var T = dayTotals(d), gap = st.pro * share(d) - T.pro, room = st.cal * share(d) + 150 - T.cal;
        if (gap >= 12 && oats.length && !hadOats && oats[oi % oats.length].sizes[0].cal <= room) { var o = oats[oi++ % oats.length]; takePiece(o.id, o.sizes[0].option_id, d); hadOats = true; added.push("oats"); }
        else if (gap >= 6 && bites && nBites < 2 && bites.sizes[0].cal <= room) { takePiece(bites.id, bites.sizes[0].option_id, d); nBites++; added.push("bite"); }
        else break;
      }
    });
    st.pieces.filter(function (p) { return p.day < 0; }).forEach(function (p) {
      var best = null, bestGap = -1e9;
      // never a third of the same snack on one day: fewest of this item first, then the biggest protein gap
      days.forEach(function (d) {
        var same = st.pieces.filter(function (x) { return x.day === d && x.id === p.id; }).length;
        var gap = st.pro * share(d) - dayTotals(d).pro - same * 1000;
        if (gap > bestGap) { bestGap = gap; best = d; }
      });
      if (best !== null) p.day = best;
    });
    return meals;
  }
  function buildWeek() {
    track("week_built");
    var meals = planCore(), days = quizDays();
    st.view = days[0] || 0;
    fullView = false; dayOpen = false; swapFor = null; justBuilt = true; addOpen = false;
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
  var CSS = "\n:host{all:initial}\n*{box-sizing:border-box}\n[hidden]{display:none!important}\n.wrap{--green:#73933c;--green-ink:#4f6a24;--forest:#2e3a18;--gold:#d9b46f;--bg:#f6f6f1;--card:#fff;--fg:#1d2314;--muted:#646b58;--line:#e2e3d8;--track:#e9ebe0;--over:#b5502f;--chip:#eef2e4;--chip-line:#cfd9b8;--today:#fbf5e8;--font:'Plus Jakarta Sans','Helvetica Neue',Arial,sans-serif;--score:'Bungee','Arial Black',Impact,sans-serif;font-family:var(--font);color:var(--fg);font-size:15px;line-height:1.5}\nbutton{font:inherit}\nbutton:focus-visible,input:focus-visible,.chip:focus-visible,.zone:focus-visible{outline:3px solid var(--gold);outline-offset:2px}\n.scrim{position:fixed;inset:0;background:rgba(10,14,6,.5);z-index:2147483001}\n.sheet{position:fixed;left:0;right:0;bottom:0;z-index:2147483002;background:#fff;border-radius:18px 18px 0 0;max-height:94%;max-height:92dvh;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;box-shadow:0 -10px 30px rgba(0,0,0,.25);padding:18px max(16px,env(safe-area-inset-right,0px)) calc(0px + env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px))}\n.in{max-width:980px;margin:0 auto;display:flex;flex-direction:column;gap:16px}\n.head{display:flex;justify-content:space-between;align-items:center;gap:12px}\n.head h2{margin:0;font-size:22px;font-weight:800}\n.x{background:none;border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:4px 10px;cursor:pointer}\n.goals{display:grid;grid-template-columns:1fr 1fr;gap:10px;max-width:520px}\n.goals label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--muted);min-width:0}\n.goals input{font:inherit;font-size:17px;font-weight:700;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;width:100%}\n.how,.hint2{font-size:13px;color:var(--muted);margin:0;max-width:65ch}\nh3.step{display:flex;align-items:center;gap:10px;margin:0 0 4px;font-size:17px;font-weight:800}\nh3.step .sn{font-family:var(--score);font-weight:400;font-size:12px;background:var(--forest);color:var(--gold);border-radius:6px;padding:3px 8px;white-space:nowrap}\n.hint2{margin:0 0 8px}\n.top2{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}\n.ptabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}\n.ptabs button{border:1px solid var(--line);background:none;color:var(--muted);border-radius:999px;padding:4px 12px;font-size:13px;font-weight:700;cursor:pointer}\n.ptabs button[aria-pressed=true]{background:var(--green);border-color:var(--green);color:#fff}\n.plist{max-height:230px;overflow-y:auto;border:1px solid var(--line);border-radius:10px}\n.prow{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;padding:7px 10px;border-top:1px solid var(--line);font-size:14px}\n.prow:first-child{border-top:0}\n.prow small{display:block;color:var(--muted);font-size:12px}\n.prow .pr{font-weight:700;font-size:13px}\n.add{font-size:13px;font-weight:700;background:var(--green);color:#fff;border:0;border-radius:8px;padding:5px 10px;cursor:pointer;white-space:nowrap}\n.add .ct{background:rgba(255,255,255,.25);border-radius:10px;padding:0 6px;margin-left:4px}\n.zone{border-radius:10px;border:1.5px dashed transparent}\n.zone.hot{border-color:var(--green)!important;background:var(--chip)!important}\n.tray .zone{display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start;padding:6px;background:var(--bg);border-color:var(--line);min-height:60px;max-height:230px;overflow-y:auto}\n.hint{color:var(--muted);font-size:13px;padding:2px 4px}\n.chip{display:inline-flex;align-items:center;gap:6px;background:var(--chip);border:1px solid var(--chip-line);border-radius:8px;padding:5px 8px;font-size:13px;line-height:1.2;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;max-width:100%;min-width:0}\n.chip b{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}\n.chip small{color:var(--muted);white-space:nowrap}\n.chip.meal{border-left:4px solid var(--green)}\n.chip.side{border-left:4px solid #8a9a6b}\n.chip.snack{border-left:4px solid var(--gold)}\n.chip.sel{outline:3px solid var(--gold);outline-offset:1px}\n.chip.lifting{opacity:.35}\n.chip .back{background:none;border:0;color:var(--muted);cursor:pointer;padding:0 2px;font-size:15px;line-height:1}\n.ghost{position:fixed;z-index:2147483005;pointer-events:none;box-shadow:0 8px 20px rgba(0,0,0,.3);transform:rotate(-2deg)}\n.calwrap{border:1px solid var(--line);border-radius:14px;overflow:hidden}\n.calhead{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;padding:10px 14px;background:var(--forest);color:#fff}\n.calhead b{font-size:16px}.calhead span{font-size:12px;color:#d8dccb}\n.cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}\n.cell{border:0;border-left:1px solid var(--line);border-radius:0;padding:8px 6px;min-height:220px;display:flex;flex-direction:column;gap:6px;cursor:pointer;min-width:0}\n.cell:first-child{border-left:0}\n.cell.view{background:var(--today);box-shadow:inset 0 -3px 0 var(--gold)}\n.dh{display:flex;align-items:baseline;justify-content:space-between;gap:4px}\n.dh b{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}\n.dh span{font-size:20px;font-weight:800;line-height:1}\n.cell .chips{display:flex;flex-direction:column;gap:4px;flex:1}\n.cell .chips .chip{font-size:12px;padding:4px 6px;gap:4px}\n.cell .chips .chip small{display:none}\n.count{display:none;font-size:12px;color:var(--muted);flex:1}\n.tot{font-size:11px;color:var(--muted);line-height:1.35}\n.tot b{color:var(--fg);font-family:var(--score);font-weight:400;font-size:12px}\n.bars{display:flex;flex-direction:column;gap:3px}\n.bars span{height:5px;border-radius:3px;background:var(--track);overflow:hidden}\n.bars i{display:block;height:100%;background:var(--green);transition:width .35s}\n.bars i.pro{background:var(--gold)}.bars i.over{background:var(--over)}\n.star{color:var(--gold);font-size:14px;line-height:1}\n.picking .cell{box-shadow:inset 0 0 0 2px var(--gold)}\n.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);padding:8px 14px;border-top:1px solid var(--line)}\n.legend i{display:inline-block;width:18px;height:5px;border-radius:3px;vertical-align:middle;margin-right:5px}\n.detail{border:1px solid var(--line);border-radius:14px;padding:12px 14px;display:grid;grid-template-columns:1fr 300px;gap:14px}\n.detail h3{margin:0 0 6px;font-size:17px;font-weight:800}\n.detail .zone{display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start;min-height:52px;padding:6px;border-color:var(--line)}\n.rings{display:grid;grid-template-columns:1fr 1fr;gap:10px}\n.ring{position:relative;display:grid;place-items:center;background:var(--forest);border-radius:14px;padding:10px 6px 8px;color:#fff}\n.ring svg{width:108px;height:108px;transform:rotate(-90deg)}\n.ring circle{fill:none;stroke-width:10}.ring .bg{stroke:rgba(255,255,255,.14)}\n.ring .fg{stroke-linecap:round;transition:stroke-dashoffset .6s cubic-bezier(.3,1.4,.5,1)}\n.ring .mid{position:absolute;top:10px;height:108px;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1}\n.ring .big{font-family:var(--score);font-size:22px}\n.ring .of{font-size:10px;color:#c9cfb8;margin-top:4px}\n.ring .cap{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);margin-top:4px}\n.ring.full{box-shadow:0 0 0 3px var(--gold),0 0 18px rgba(217,180,111,.6)}\n.ring .rstar{position:absolute;top:6px;right:8px;font-size:16px;color:var(--gold)}\n.youleft{border:2px dashed var(--line);border-radius:12px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}\n.youleft span{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}\n.youleft b{font-family:var(--score);font-size:16px;font-weight:400}\n.youleft.over b{color:var(--over)}\n.pop{position:fixed;z-index:2147483006;pointer-events:none;font-family:var(--score);font-size:18px;color:var(--green-ink);text-shadow:0 2px 0 #fff,0 0 8px #fff;animation:floatup 1.1s ease-out forwards}\n.pop.pro{color:#b88a2e}\n@keyframes floatup{0%{opacity:0;transform:translate(-50%,0) scale(.6)}15%{opacity:1;transform:translate(-50%,-8px) scale(1.15)}100%{opacity:0;transform:translate(-50%,-60px) scale(1)}}\n.order ul{list-style:none;margin:0;padding:0;columns:2;column-gap:24px}\n.order li{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:6px 0;border-top:1px solid var(--line);font-size:14px;break-inside:avoid}\n.order li small{color:var(--muted)}\n.rm{font-size:12px;background:none;border:1px solid var(--line);color:var(--muted);border-radius:6px;padding:2px 8px;cursor:pointer}\n.foot{font-size:12px;color:var(--muted);margin:0}\n.reset{font-size:12px;background:none;border:0;color:var(--green-ink);text-decoration:underline;cursor:pointer;padding:0}\n.cartbar{position:sticky;bottom:0;background:#fff;border-top:1px solid var(--line);padding:12px 0 calc(12px + env(safe-area-inset-bottom,0px));display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;z-index:3}\n.sum{font-size:14px}\n.member{margin-top:4px;font-size:13px;background:var(--today);border:1px solid var(--gold);border-radius:8px;padding:4px 10px;display:inline-block}\n.member b{color:var(--green-ink)}.member span{color:var(--muted)}\n.lock{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}\n.lockin{width:100%}.lockin input{font:inherit;font-size:16px;width:100%;border:2px solid var(--gold);border-radius:10px;padding:9px 12px;background:var(--today)}.member.offer b{color:var(--green-ink)}\n.in.simple .lockin{order:3}\n.tocart{background:var(--green);color:#fff;border:0;border-radius:10px;padding:11px 18px;font-weight:800;font-size:15px;cursor:pointer}\n.tocart:disabled{opacity:.45;cursor:default}\n.msg{width:100%;font-size:14px;font-weight:600}\n.msg.err{color:var(--over)}\n.choice{width:100%;display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:14px;background:var(--today);border:1px solid var(--gold);border-radius:10px;padding:10px 12px}\n.choice button{border:1px solid var(--forest);background:#fff;border-radius:8px;padding:6px 12px;font-weight:700;cursor:pointer}\n.choice button.primary{background:var(--forest);color:#fff}\n@media (max-width:760px){.top2{grid-template-columns:1fr}.cell{min-height:112px;padding:6px 3px;gap:4px}.dh{flex-direction:column;align-items:center;gap:2px}.dh b{font-size:10px;letter-spacing:.04em}.dh span{font-size:16px}.cell .chips{display:none}.count{display:block;text-align:center;font-size:11px}.tot{text-align:center;font-size:10px}.tot b{font-size:11px;display:block}.tot .l2{display:none}.detail{grid-template-columns:1fr}.order ul{columns:1}}\n@media (prefers-reduced-motion:reduce){.bars i,.ring .fg{transition:none}.pop{display:none}}\n.in.quizzing>:not(.head):not(#quiz){display:none!important}\n.in.quizzing .redo{display:none}\n.redo{background:none;border:0;color:var(--green-ink);text-decoration:underline;font-size:13px;cursor:pointer;padding:0;margin-right:12px}\n.hbtns{display:flex;align-items:center}\n#quiz{max-width:560px;width:100%;margin:8px auto 24px;display:flex;flex-direction:column;gap:14px}\n.qdots{display:flex;gap:6px}.qdots i{flex:1;height:5px;border-radius:3px;background:var(--track)}.qdots i.on{background:var(--gold)}\n.qkick{font-family:var(--score);font-size:12px;color:var(--gold);background:var(--forest);border-radius:6px;padding:3px 8px;align-self:flex-start}\n#quiz h3{margin:0;font-size:24px;font-weight:800;line-height:1.2}\n#quiz p{margin:0;color:var(--muted);font-size:14px}\n.opts{display:flex;flex-direction:column;gap:10px}\n.opt{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;border:2px solid var(--line);background:#fff;border-radius:12px;padding:14px 16px;cursor:pointer;font-size:16px;font-weight:700;color:var(--fg)}\n.opt small{font-size:13px;font-weight:500;color:var(--muted)}\n.opt[aria-pressed=true]{border-color:var(--green);background:var(--chip)}\n.opt.best{border-color:var(--gold);background:var(--today);box-shadow:0 0 0 2px var(--gold)}\n.opt.plan{width:100%}.ptop{display:flex;justify-content:space-between;align-items:baseline;gap:10px;width:100%}.pprice{font-family:var(--score);font-weight:400;font-size:18px;color:var(--green-ink)}.opt.plan.best .ptop{font-size:18px}.prung{font-style:normal;font-size:12.5px;font-weight:700;color:var(--green-ink)}\n.pwhyrec{display:block;margin-top:8px;padding-top:8px;border-top:1px solid #e3e6d8;font-size:13px;line-height:1.45;font-weight:500;color:var(--fg);text-align:left}\n.daychips{display:flex;flex-wrap:wrap;gap:8px}\n.daychips button{border:2px solid var(--line);background:#fff;border-radius:999px;padding:8px 14px;font-weight:700;cursor:pointer}\n.daychips button[aria-pressed=true]{border-color:var(--green);background:var(--green);color:#fff}\n.qrow{display:flex;gap:10px;flex-wrap:wrap;align-items:center}\n.qrow input{font:inherit;font-size:20px;font-weight:700;width:140px;border:2px solid var(--line);border-radius:10px;padding:10px 12px}\n.qnext{background:var(--green);color:#fff;border:0;border-radius:12px;padding:14px 20px;font-weight:800;font-size:16px;cursor:pointer;align-self:flex-start}\n.qnext:disabled{opacity:.4;cursor:default}\n.qlink{background:none;border:0;color:var(--green-ink);text-decoration:underline;cursor:pointer;padding:0;font-size:14px;align-self:flex-start}\n.qback{background:none;border:0;color:var(--muted);cursor:pointer;padding:0;font-size:13px;align-self:flex-start}\n.qnote{font-size:12px!important}\n.qerr{color:var(--over)!important;font-weight:700;font-size:13px!important}\n#quiz p b{color:var(--green-ink)}\n.gline,.modebar,.dlist,.dclose{display:none}\n.gline{font-size:14px;color:var(--muted)}.gline b{color:var(--fg)}\n.gline button{background:none;border:0;color:var(--green-ink);text-decoration:underline;cursor:pointer;padding:0;font-size:14px}\n.modebar{justify-content:flex-start}\n.modebtn{background:#fff;border:1.5px solid var(--forest);color:var(--forest);border-radius:10px;padding:9px 14px;font-weight:700;font-size:14px;cursor:pointer}\n.dhead{display:flex;justify-content:space-between;align-items:center;gap:8px}\n.dclose{background:var(--forest);color:#fff;border:0;border-radius:8px;padding:6px 14px;font-weight:700;cursor:pointer}\n.drow{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--line);flex-wrap:wrap}\n.drow .chip{flex:1 1 auto}\n.drow .sw,.drow .rmv{background:#fff;border:1px solid var(--line);border-radius:8px;padding:5px 10px;font-size:13px;font-weight:700;cursor:pointer;color:var(--fg)}\n.drow .rmv{color:var(--muted)}\n.alts{width:100%;display:flex;flex-direction:column;gap:4px;padding:4px 0 6px 12px}\n.alts button{text-align:left;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:13px;cursor:pointer;color:var(--fg)}\n.alts button small{color:var(--muted)}\n.dhint{font-size:12px;color:var(--muted);margin:6px 0 0}\n.in.simple>.goals,.in.simple>.how,.in.simple>.top2,.in.simple>.order,.in.simple>.foot,.in.simple .step,.in.simple .hint2,.in.simple .legend,.in.simple .lock,.in.simple .redo{display:none!important}\n.in.simple .gline,.in.simple .dlist,.in.simple .dclose{display:block}\n.in.simple .modebar,.in.full .modebar{display:flex}\n.in.simple>.detail{display:none}\n.in.simple.dayopen>.detail{display:grid;grid-template-columns:1fr;position:fixed;left:0;right:0;bottom:0;z-index:6;max-height:52%;max-height:50dvh;overscroll-behavior:contain;overflow-y:auto;background:#fff;border-radius:18px 18px 0 0;box-shadow:0 -10px 30px rgba(0,0,0,.25);padding:14px max(16px,env(safe-area-inset-right,0px)) calc(16px + env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px))}\n.in.simple #dZone{display:none}\n.in.simple.dayopen>.gline,.in.simple.dayopen>.built,.in.simple.dayopen>.modebar{display:none!important}\n.in.simple.dayopen>.detail{overflow-x:hidden}\n.sheet.tall{height:94%;height:92dvh}\n.in.simple.dayopen>.detail>div{min-width:0}\n.drow .chip{flex:1 1 0;min-width:0}\n.in.simple .rings .ring svg{width:84px;height:84px}.in.simple .ring .mid{height:84px}.in.simple .ring .big{font-size:18px}\n.in.simple .built{font-size:13px;padding:8px 12px}\n.in.simple>:not(.head):not(#reveal):not(.cartbar):not(.gline):not(.modebar):not(#quiz){display:none!important}\n.rdots{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;position:sticky;top:-18px;z-index:4;background:#fff;padding:6px 0}\n.rday{display:flex;flex-direction:column;align-items:center;gap:0;border:1.5px solid var(--line);background:#fff;border-radius:10px;padding:5px 0;cursor:pointer;color:var(--muted);min-width:0}\n.rday b{font-size:11px;letter-spacing:.06em;text-transform:uppercase}.rday span{font-size:17px;font-weight:800;color:var(--fg);line-height:1.1}.rday em{font-style:normal;font-size:9.5px;white-space:nowrap}\n.rday.has{border-color:var(--chip-line);background:var(--chip)}\n.rday.on{background:var(--forest);border-color:var(--forest);color:var(--gold)}.rday.on span{color:#fff}\n.rday.hot{outline:3px solid var(--gold)}\n.racts{display:flex;gap:6px;margin-top:4px}.rrm{color:var(--muted)!important}\n.rcard{touch-action:pan-y;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}.rcard.held{outline:3px solid var(--gold);transform:scale(.98)}.rcard.lifting{opacity:.4}\n.radd{background:#fff;border:2px dashed var(--chip-line);color:var(--green-ink);border-radius:12px;padding:12px;font-weight:800;font-size:15px;cursor:pointer}\n.addtabs{display:flex;gap:6px}.addtabs button{flex:1;border:1px solid var(--line);background:#fff;border-radius:999px;padding:6px 0;font-weight:700;font-size:13px;cursor:pointer;color:var(--muted)}.addtabs button[aria-pressed=true]{background:var(--green);border-color:var(--green);color:#fff}\n.addlist{margin:0}.ralt .plus{margin-left:auto;font-style:normal;font-size:22px;font-weight:800;color:var(--green);padding:0 6px}\n.rempty,.rtip{margin:0;font-size:13px;color:var(--muted)}.rtip{font-size:12px;text-align:center}\n#reveal .rhead h3{margin:0}\n.in.simple .cartbar{padding:8px 0 calc(8px + env(safe-area-inset-bottom,0px));gap:4px 10px;align-items:center}\n.in.simple .sum{font-size:13px;flex:1;min-width:0}\n.pwhy{font-size:12.5px;font-weight:700;color:var(--forest)}\n.pold{color:var(--muted);font-weight:500;text-decoration-thickness:2px}.pprice .pold{font-family:var(--font);font-size:14px;margin-right:4px}\n.assure{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11.5px;font-weight:700;color:var(--green-ink);margin:0 0 3px}.assure span{white-space:nowrap}#quiz .assure{font-size:13px;margin:0}\n.member.mstack{margin-top:2px;font-weight:500}.in.simple .pwhy{font-size:12px}\n.in.simple .member{display:block;border:0;background:none;padding:0;margin-top:1px;font-size:11.5px}\n.in.simple .tocart{order:2;padding:10px 18px}\n.in.simple .weekly{order:3;width:100%;max-width:none;font-size:12px}\n.in.simple .weekly input[type=checkbox]{width:16px;height:16px}\n.in.simple .msg,.in.simple .choice{order:4}\n.in.simple>.modebar{display:none!important}\n.rfull{align-self:center;background:none;border:0;color:var(--green-ink);text-decoration:underline;font-size:13px;cursor:pointer;padding:2px}\n#reveal{display:flex;flex-direction:column;gap:12px;max-width:560px;width:100%;margin:0 auto 20px}\n.rhead span{font-family:var(--score);font-size:12px;color:var(--gold);background:var(--forest);border-radius:6px;padding:3px 8px}\n.rhead h3{margin:8px 0 0;font-size:26px;font-weight:800;line-height:1.1}\n.rhead p{margin:2px 0 0;color:var(--muted);font-size:14px}\n.rwhy{margin:0;font-size:13px;color:var(--muted);background:var(--today);border-radius:10px;padding:8px 12px}\n.rwhy b{color:var(--fg)}\n.rheard{margin:0;font-size:15px;line-height:1.45;color:var(--fg);border-left:4px solid var(--gold);padding:2px 0 2px 12px}.rheard b{color:var(--green-ink)}\n.rcard{display:grid;grid-template-columns:112px 1fr;gap:12px;align-items:start;border:1px solid var(--line);border-radius:14px;padding:10px;background:#fff}\n.rimg{width:112px;height:112px;max-width:100%;object-fit:cover;border-radius:10px;background:var(--track);display:block}\n.noimg{display:grid;place-items:center;background:var(--chip);color:var(--green-ink);font:800 12px var(--font);letter-spacing:.1em;text-transform:uppercase}\n.rbody{display:flex;flex-direction:column;gap:3px;min-width:0}\n.rbody b{font-size:16px;line-height:1.25}\n.rwith{font-size:13px;color:var(--muted);line-height:1.35}\n.rmac{font-size:13px;font-weight:700;color:var(--green-ink)}\n.rportion{font-size:12.5px;color:var(--fg);background:var(--today);border-radius:6px;padding:3px 7px;align-self:flex-start;line-height:1.35}.rportion b{font-weight:800}\n.rswap{align-self:flex-start;margin-top:4px;background:#fff;border:1.5px solid var(--line);border-radius:8px;padding:5px 12px;font-weight:700;font-size:13px;cursor:pointer;color:var(--fg)}\n.ralts{display:flex;flex-direction:column;gap:6px;margin:-4px 0 4px 16px}\n.ralt{display:flex;gap:10px;align-items:center;text-align:left;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:6px;cursor:pointer;color:var(--fg)}\n.raimg{width:52px;height:52px;object-fit:cover;border-radius:8px;flex:none;font-size:9px}\n.ralt span{display:flex;flex-direction:column;min-width:0}\n.ralt b{font-size:14px}\n.ralt small{color:var(--muted);font-size:12px}\n.rtot{display:grid;grid-template-columns:1fr 1fr;gap:8px}\n.rtot div{border-radius:12px;padding:10px 12px;background:var(--forest);color:#fff;display:flex;flex-direction:column;gap:2px}\n.rtot div+div{background:var(--today);color:var(--fg);border:2px dashed var(--line)}\n.rtot span{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.8}\n.rtot b{font-family:var(--score);font-weight:400;font-size:14px}\n.rnav{display:flex;gap:8px}\n.rnext{flex:1;background:var(--green);color:#fff;border:0;border-radius:12px;padding:15px 16px;font-weight:800;font-size:16px;cursor:pointer}\n.rback{background:#fff;border:1.5px solid var(--line);border-radius:12px;padding:0 16px;font-weight:700;cursor:pointer}\n.rskip{align-self:center;background:none;border:0;color:var(--muted);text-decoration:underline;font-size:13px;cursor:pointer;padding:4px}\n.weekly{display:flex;flex-direction:column;gap:6px;font-size:13px;max-width:340px}\n.weekly label{display:flex;gap:8px;align-items:flex-start;cursor:pointer}\n.weekly input[type=checkbox]{width:18px;height:18px;margin:1px 0 0;accent-color:var(--green);flex:none}\n.weekly input[type=email]{font:inherit;font-size:15px;border:1px solid var(--line);border-radius:8px;padding:7px 10px}\n.built{border:2px solid var(--gold);background:var(--today);border-radius:12px;padding:10px 14px;font-size:14px}\n.built b{font-weight:800}\n";

  CSS += "\n.sugrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}\n.sul{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:700;color:var(--muted)}\n.sul input{font:inherit;font-size:17px;font-weight:600;color:var(--fg);width:100%;border:2px solid var(--line);border-radius:10px;padding:11px 12px;background:#fff}\n.sul input:focus{outline:none;border-color:var(--green)}\n.sulab{margin:4px 0 0!important;font-size:13px!important;font-weight:700;color:var(--muted)!important}\n.suchips{display:flex;flex-wrap:wrap;gap:8px}\n.suchips button{border:2px solid var(--line);background:#fff;border-radius:999px;padding:9px 13px;font:inherit;font-size:14px;font-weight:700;color:var(--fg);cursor:pointer}\n.suchips button[aria-pressed=true]{border-color:var(--green);background:var(--chip)}\n.supw{display:flex;gap:8px}\n.supw input{flex:1}\n.supw button{border:2px solid var(--line);background:#fff;border-radius:10px;padding:0 14px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;color:var(--fg)}\n.surules{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:13px;color:var(--muted)}\n.surules li:before{content:'\\25CB  '}\n.surules li.ok{color:var(--green-ink);font-weight:700}\n.surules li.ok:before{content:'\\2713  '}\n.suck{display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.4;color:var(--fg);cursor:pointer}\n.suck input{width:20px;height:20px;margin:0;flex:none;accent-color:var(--green)}\n.suck a{color:var(--green-ink)}\n.suts{min-height:65px}\n.qerr a{color:inherit}\n@media (max-width:420px){.sugrid,.surules{grid-template-columns:1fr}}\n";   // sign-up screens
  CSS += "\n.luke{display:flex;gap:10px;align-items:flex-start;background:#fbf5e8;border:1px solid #ecdcb4;border-radius:14px;padding:10px 12px}\n.luke img{width:44px;height:44px;border-radius:50%;object-fit:cover;object-position:50% 35%;flex:none;border:2px solid var(--gold)}\n.luke b{display:block;font-size:12px;color:var(--muted);margin-bottom:2px}\n.luke p{margin:0!important;font-size:14.5px!important;line-height:1.45;color:var(--fg)!important}\n";   // Luke's talk-through lines
  CSS += "\n.tl{list-style:none;margin:0;padding:0 0 0 14px;border-left:3px solid var(--gold);display:flex;flex-direction:column;gap:10px}\n.tl li{display:flex;flex-direction:column;gap:2px;font-size:14.5px;line-height:1.4;color:var(--fg)}\n.tl b{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--green-ink)}\n.pcta{display:block;margin-top:10px;text-align:center;background:var(--green);color:#fff;border-radius:10px;padding:11px;font-weight:800;font-size:15px}\n";   // v2 timeline
  CSS += "\n.pstack{display:flex;flex-direction:column;gap:4px;width:100%;margin-top:10px;padding:10px 12px;background:#fff;border:1px dashed var(--gold);border-radius:10px;font-size:14px;font-weight:600}\n.pdead{font-size:12.5px;font-weight:800;color:var(--forest)}\n.prow{display:flex;justify-content:space-between;gap:10px;color:var(--green-ink)}\n.ptot{margin-top:4px;padding-top:6px;border-top:1px solid var(--line);font-size:16px;font-weight:800;color:var(--fg)}\n";   // v2 price stack
  CSS += "\n.prom{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}\n.prom li{font-size:14.5px;line-height:1.4;padding-left:20px;position:relative}\n.prom li:before{content:'\\2713';position:absolute;left:0;color:var(--green-ink);font-weight:800}\n";   // v2 promises
  CSS += "\n.luke p b{display:inline;font-size:inherit;color:inherit;margin:0}\n";   // v2 bar savings box
  CSS += "\n.ppace{font-style:normal;font-size:13.5px;font-weight:600;color:var(--green-ink);margin-top:4px}\n.ppace b{color:var(--forest)}\n";   // pace lines
  function mountSheet() {
    host = el("div"); host.id = "tsk-planner";
    document.body.appendChild(host);
    R = host.attachShadow({ mode: "open" });
    R.innerHTML = "<style>" + CSS + "</style>" +
      '<div class="wrap"><div class="scrim" hidden></div>' +
      '<section class="sheet" role="dialog" aria-modal="true" aria-label="Build your week" hidden><div class="in">' +
      '<div class="head"><h2 id="sheetTitle">Build your week</h2><div class="hbtns"><button class="redo" data-a="quiz">Redo my answers</button><button class="x" data-a="close">Close</button></div></div>' +
      '<div id="quiz" hidden></div><div class="gline" id="gline"></div><div class="built" id="built" hidden></div>' +
      '<div class="modebar" id="modebar" hidden><button class="modebtn" data-a="mode"></button></div><div id="reveal" hidden></div>' +
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
      '<div class="lockin" id="lockin" hidden><input id="liEmail" type="email" inputmode="email" autocomplete="email" placeholder="Your email locks in these savings"></div>' +

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
  var fullView = false, dayOpen = false, swapFor = null, justBuilt = false;
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

  // ------------------------------------------------------------------ day view (Luke 11/18): after the quiz, a row of days on top and the
  // chosen day's food below with photo + description; Add / Swap / Remove on that day, totals update as they change
  function photoHtml(m, cls) {
    return m.img ? '<img class="' + cls + '" src="' + esc(m.img) + '" alt="" loading="lazy">'
      : '<div class="' + cls + ' noimg"><span>' + (m.kind === "side" ? "Side" : "Snack") + "</span></div>";
  }
  var addOpen = false, addTab = 0;
  var ADD_TABS = [["meal", "Meals"], ["side", "Sides"], ["snack", "Snacks"]];
  function defaultSize(m) {
    var pref = st.quiz ? GOALS[st.quiz.goal].size : ["Fat Loss"];
    for (var i = 0; i < pref.length; i++) { var s = m.sizes.filter(function (z) { return z.name === pref[i]; })[0]; if (s) return s; }
    return m.sizes[0];
  }
  // For snacks and sides, say exactly how much of the pack or container is counted on this day, and where the rest went
  function unitName(m, n) {
    var u = m.kind === "side" ? "serving" : /bite/i.test(m.name) ? "bite" : /cookie/i.test(m.name) ? "cookie" : /burrito/i.test(m.name) ? "burrito" : "piece";
    return n + " " + u + (n > 1 ? "s" : "");
  }
  function portionLine(g, d) {
    var m = info(g.p).m;
    if (m.serv <= 1) return "";
    var pack = m.kind === "side" ? m.serv + "-serving container" : (info(g.p).sz.name || m.serv + "-pack").toLowerCase();
    var mates = st.pieces.filter(function (x) { return x.pid === g.p.pid && x.day !== d; });
    // days in week order, "Fri ×2" when more than one lands on a day
    var count = {};
    mates.forEach(function (x) { count[x.day] = (count[x.day] || 0) + 1; });
    var order = Object.keys(count).map(Number).sort(function (a, b) { return (a < 0 ? 99 : a) - (b < 0 ? 99 : b); }).map(function (k) {
      return (k < 0 ? "not on a day yet" : DAYS[k].short) + (count[k] > 1 ? " ×" + count[k] : "");
    });
    return '<span class="rportion"><b>' + unitName(m, g.n) + " today</b> · from one " + esc(pack) + "</span>";
  }
  // Say their own answers back, tied to this exact week (Hormozi's diagnostic sale: the plan is the bridge from where
  // they are to where they said they want to be). Hours use the weekly recap's own estimate: 30 min a meal, 5 a snack.
  function weekStats() {
    var meals = st.pieces.filter(function (p) { return p.day >= 0 && ITEMS[p.id].kind === "meal"; });
    var snacks = st.pieces.filter(function (p) { return p.day >= 0 && ITEMS[p.id].kind !== "meal"; }).length;
    var nM = meals.length;
    var days = DAYS.map(function (_, i) { return dayTotals(i); }).filter(function (T) { return T.on.length; });
    return {
      nM: nM,
      snackPacks: st.packs.filter(function (k) { return ITEMS[k.id].kind !== "meal"; }).length,
      hours: Math.round((nM * Q2.MIN_PER_MEAL + snacks * 5) / 60),
      mealCost: nM ? meals.reduce(function (t, p) { return t + info(p).sz.price; }, 0) / nM : 0,
      dishes: meals.reduce(function (u, p) { if (u.indexOf(p.id) < 0) u.push(p.id); return u; }, []).length,
      proDay: days.length ? Math.round(days.reduce(function (t, T) { return t + T.pro; }, 0) / days.length) : 0
    };
  }
  function heardYou() {
    var q = st.quiz; if (!q || !q.block) return "";
    var w = weekStats(), nM = w.nM; if (!nM) return "";
    var hours = w.hours, mealCost = w.mealCost, dishes = w.dishes, proDay = w.proDay;
    var first = {
      hate: "You said you hate cooking. This week is <b>" + nM + " meals you never cook</b>: no shopping, no pans, no dishes.",
      what: "You said you never know what to eat. This week <b>" + nM + " meals are already picked</b>, " + dishes + " different dishes built around your goal.",
      cook: "You said you don't know how to cook the right foods. This week is <b>" + nM + " meals made by our chefs</b>, " + dishes + " different dishes built around your goal.",
      time:"You said there's no time to cook. This week is <b>" + nM + " meals cooked for you</b>, about " + hours + " hours of cooking and dishes you get back.",
      out: "You said you end up eating out or grabbing whatever. This week puts <b>" + nM + " ready meals in your fridge</b>, about $" + mealCost.toFixed(2) + " each.",
      bored: "You said the meals get boring. This week has <b>" + dishes + " different dishes</b>, and the menu changes every week.",
      protein: "You said protein is hard to hit. This week gives you about <b>" + proDay + "g a day from us</b>, already counted."
    }[q.block] || "";
    var picks = goodLabels(q);
    if (picks.length) return first + " You wanted " + esc(joinList(picks.map(lowerFirst))) + ".";
    var second = q.want === q.block || (q.want === "easy" && q.block === "what") ? "" : {
      health: " Every meal is real food, portioned and counted, so eating well isn't a guess.",
      recovery: " About " + proDay + "g of protein a day from us, so you recover between workouts.",
      time: " No cooking, so your evenings are yours.",
      protein: " Your protein is planned before the week starts.",
      progress: " Each week is built around your goal, so you're not starting over every Monday.",
      easy: " Dinner is decided before Monday."
    }[q.want] || "";
    return first + second;
  }
  function drawDayView() {
    var box = $(R, "#reveal"), d = st.view, D = DAYS[d], T = dayTotals(d);
    // same item twice on a day (e.g. two protein bites) shows once with ×2
    var groups = [], seen = {};
    T.on.forEach(function (p) { var k = p.id + "|" + p.opt; if (seen[k]) { seen[k].n++; return; } seen[k] = { p: p, n: 1 }; groups.push(seen[k]); });
    var html = '<div class="rdots">' + DAYS.map(function (X, i) {
      // two bites on one day count as one item, like the card that shows them
      var n = dayTotals(i).on.reduce(function (u, p) { var k = p.id + "|" + p.opt; if (u.indexOf(k) < 0) u.push(k); return u; }, []).length;
      return '<button class="rday zone' + (i === d ? " on" : "") + (n ? " has" : "") + '" data-a="rday" data-day="' + i + '"><b>' + X.short + "</b><span>" + X.n + "</span><em>" + (n ? n + " item" + (n > 1 ? "s" : "") : "none") + "</em></button>";
    }).join("") + "</div>";
    html += '<div class="rhead"><h3>' + D.long + "</h3><p>" + D.mon + " " + D.n + "</p></div>";
    if (justBuilt && st.quiz) {
      var said = heardYou();
      var why = [GOALS[st.quiz.goal].label.toLowerCase()].concat(st.quiz.avoid.map(function (a) { return a + " free"; }));
      if (said && quizV2()) {
        var ws = weekStats(), mp = st.pieces.filter(function (x) { return x.day >= 0 && ITEMS[x.id].kind === "meal"; });
        var avg = mp.length ? Math.round(mp.reduce(function (t, x) { return t + info(x).sz.cal; }, 0) / mp.length) : 0;
        var qaKeep = qa; qa = st.quiz;
        said = said + calSwap({ meals: ws.nM, mealCal: avg, hours: ws.hours });
        qa = qaKeep;
      }
      html += (said ? (quizV2() ? lukeSays(said) : '<p class="rheard">' + said + "</p>") : "") + ASSURE +
        '<p class="rwhy">Built for you: <b>' + esc(why.join(", ")) + "</b>. Tap a day to see it. Nothing is charged until you check out" +
        (DATA.deadline ? ", and you can change it until " + esc(DATA.deadline) + " at midnight." : ".") + "</p>";
    }
    if (!groups.length) html += '<p class="rempty">Nothing planned for ' + D.long + ". Add something below, or leave it for your own cooking.</p>";
    groups.forEach(function (g) {
      var x = info(g.p), m = x.m, sizeTxt = m.kind === "meal" && m.sizes.length > 1 ? " · " + esc(x.sz.name) : "";
      html += '<div class="rcard" data-uid="' + g.p.uid + '">' + photoHtml(m, "rimg") + '<div class="rbody"><b>' + esc(m.short) + "</b>" +
        (m.with && m.serv === 1 ? '<span class="rwith">' + esc(m.with) + "</span>" : "") +
        portionLine(g, d) +
        '<span class="rmac">' + fmt(x.sz.cal * g.n) + " cal · " + fmt(x.sz.protein * g.n) + "g protein" + sizeTxt + "</span>" +
        '<span class="racts"><button class="rswap" data-a="swap" data-uid="' + g.p.uid + '">' + (swapFor === g.p.uid ? "Keep it" : "Swap") + "</button>" +
        '<button class="rswap rrm" data-a="remove" data-uid="' + g.p.uid + '">Remove</button></span></div></div>';
      if (swapFor === g.p.uid) {
        html += '<div class="ralts">';
        alternatives(g.p).forEach(function (a) {
          var dpro = a.sz.protein - x.sz.protein;
          html += '<button class="ralt" data-a="pickalt" data-uid="' + g.p.uid + '" data-id="' + a.m.id + '" data-opt="' + a.sz.option_id + '">' + photoHtml(a.m, "raimg") +
            "<span><b>" + esc(a.m.short) + "</b><small>" + a.sz.cal + " cal · " + a.sz.protein + "g" + (dpro ? " (" + (dpro > 0 ? "+" : "") + dpro + "g)" : "") + "</small></span></button>";
        });
        html += "</div>";
      }
    });
    html += '<button class="radd" data-a="addopen">' + (addOpen ? "Close" : "+ Add food to " + D.long) + "</button>";
    if (addOpen) {
      html += '<div class="addtabs">' + ADD_TABS.map(function (t, i) { return '<button data-a="addtab" data-i="' + i + '" aria-pressed="' + (i === addTab) + '">' + t[1] + "</button>"; }).join("") + '</div><div class="ralts addlist">';
      DATA.items.filter(function (m) { return m.kind === ADD_TABS[addTab][0]; }).forEach(function (m) {
        var s = defaultSize(m);
        html += '<button class="ralt" data-a="addto" data-id="' + m.id + '" data-opt="' + s.option_id + '">' + photoHtml(m, "raimg") +
          "<span><b>" + esc(m.short) + "</b><small>" + s.cal + " cal · " + s.protein + "g protein" + (m.kind === "meal" && m.sizes.length > 1 ? " · " + esc(s.name) : "") +
          (m.serv > 1 ? " · " + m.serv + (m.kind === "side" ? " servings" : " pieces") : "") + '</small></span><i class="plus">+</i></button>';
      });
      html += "</div>";
    }
    var lc = st.cal - T.cal, lp = Math.max(0, st.pro - T.pro);
    html += '<div class="rtot"><div><span>From us ' + D.short + "</span><b>" + fmt(T.cal) + " cal · " + fmt(T.pro) + "g</b></div>" +
      "<div><span>" + (lc < 0 ? "Over your day by" : "Left for you") + "</span><b>" + (lc < 0 ? fmt(-lc) + " cal" : fmt(lc) + " cal · " + fmt(lp) + "g") + "</b></div></div>";
    var spare = st.pieces.filter(function (p) { return p.day < 0; }).length;
    if (spare) html += '<p class="rempty">' + spare + " extra serving" + (spare > 1 ? "s" : "") + " in your order " + (spare > 1 ? "aren't" : "isn't") + " on a day yet. Eat them whenever you like.</p>";
    html += '<p class="rtip">Tip: press and hold any item and drag it onto another day.</p>';
    html += '<button class="rfull" data-a="mode">Open the full builder</button>';
    box.innerHTML = html;
  }

  function render() {
    if (!R) return;
    var simple = isSimple(), IN = $(R, ".in");
    IN.classList.toggle("simple", simple);
    $(R, "#reveal").hidden = !simple;
    if (simple) drawDayView();
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
    // new visitors see the first-order ladder; signed-in customers see the membership line
    var newbie = offerShown(), r = rungFor(total), nx = nextRung(total), locked = getOffer();
    var ladder = '<div class="member offer">' + (r
        ? "<b>✓ " + esc(r.label) + "</b>" +
          (nx ? " <span>· add $" + (nx.min - total).toFixed(2) + " for " + moreFor(nx) + "</span>" : "") + " <span>· first order" + (locked ? " · locked in" : "") + "</span>"
        : "Add <b>$" + (nx.min - total).toFixed(2) + "</b> for free delivery on your first order") + "</div>" +
      '<div class="member offer mstack">+ <b>Basic membership, first month free</b>: 5% more off <span>(−$' + (total * 0.05).toFixed(2) + ") · add it at checkout</span></div>";
    var w = weekStats(), why = "";
    if (st.quiz && w.nM) {
      var lead = {
        hate: w.nM + " meals you never cook",
        what: w.nM + " meals already picked for you",
        cook: w.nM + " meals made by our chefs",
        time: "about " + w.hours + " hours of cooking back",
        out: "about $" + w.mealCost.toFixed(2) + " a meal",
        bored: w.dishes + " different dishes",
        protein: "about " + w.proDay + "g protein a day"
      }[st.quiz.block] || "about " + w.hours + " hours of cooking back";
      why = '<div class="pwhy">' + lead.charAt(0).toUpperCase() + lead.slice(1) + "</div>";
    }
    var paid = newbie && r && r.pct ? total * (1 - r.pct / 100) : null;
    var v2 = quizV2();
    var priceHtml = paid !== null && !v2 ? '<s class="pold">$' + total.toFixed(2) + "</s> <b>$" + paid.toFixed(2) + "</b>" : "<b>$" + total.toFixed(2) + "</b>";
    var head = st.quiz && w.nM
      ? priceHtml + " for your week · " + w.nM + " meal" + (w.nM > 1 ? "s" : "") + (w.snackPacks ? " + " + w.snackPacks + " snack" + (w.snackPacks > 1 ? "s" : "") : "")
      : "<b>" + st.packs.length + "</b> item" + (st.packs.length > 1 ? "s" : "") + " · <b>$" + total.toFixed(2) + "</b>";
    $(R, "#sum").innerHTML = st.packs.length
      ? head + why +
        (newbie && v2 ? (r ? savingsLine(total, r) : ladder.split('<div class="member offer mstack">')[0]) + (r && nx ? '<div class="member offer"><span>Add $' + (nx.min - total).toFixed(2) + " for " + moreFor(nx) + "</span></div>" : "")
          : newbie ? ladder
          : '<div class="member">With a <b>Basic membership</b>: <b>$' + (total - save5).toFixed(2) + "</b> <span>(save $" + save5.toFixed(2) + " this week · first month free · add it at checkout)</span></div>")
      : "Nothing picked yet";
    $(R, "#lockin").hidden = !(newbie && r && !locked && st.packs.length);
    $(R, ".tocart").disabled = !st.packs.length || busy;
    pill.style.display = st.pieces.length ? "block" : "none";
    pill.innerHTML = '<span style="display:block;font-size:11px;font-weight:800;letter-spacing:.1em;color:#d9b46f">MY WEEK</span>' + planned + " day" + (planned === 1 ? "" : "s") + " planned" + (left.length ? " · " + left.length + " to place" : "");
    save();
  }

  function popAt(day, p) {
    if (day < 0 || !p || reduced()) return;
    var target = isSimple() ? R.querySelector('.rday[data-day="' + day + '"]') : $(R, "#cell" + day);
    if (!target) return;
    var r = target.getBoundingClientRect(), sz = info(p).sz;
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
      if (a.dataset.a === "rday") { st.view = +a.dataset.day; swapFor = null; addOpen = false; justBuilt = false; render(); }
      if (a.dataset.a === "addopen") { addOpen = !addOpen; swapFor = null; render(); }
      if (a.dataset.a === "addtab") { addTab = +a.dataset.i; render(); }
      if (a.dataset.a === "addto") { var np = takePiece(+a.dataset.id, +a.dataset.opt, st.view); addOpen = false; render(); popAt(st.view, np); }
    });
    $(R, ".scrim").addEventListener("click", close);
    ["gCal", "gPro"].forEach(function (id) {
      $(R, "#" + id).addEventListener("input", function (e) { var v = Math.max(0, +e.target.value || 0); if (id === "gCal") st.cal = v; else st.pro = v; render(); });
    });
    R.addEventListener("pointerdown", function (e) {
      if (e.target.closest("button") || e.button > 0) return;   // buttons inside chips and cards keep their own click
      var c = e.target.closest(".chip, .rcard[data-uid]");
      if (!c) return;
      // a day-view card is big, so on touch a drag starts only after a short press-and-hold; a plain swipe still scrolls
      var card = c.classList.contains("rcard");
      drag = { uid: c.dataset.uid, el: c, x: e.clientX, y: e.clientY, moved: false, ghost: null, hot: null, card: card, armed: !card || e.pointerType === "mouse" };
      if (!drag.armed) {
        var mine = drag;
        drag.timer = setTimeout(function () { if (drag === mine && !mine.moved) { mine.armed = true; c.classList.add("held"); try { c.setPointerCapture(e.pointerId); } catch (x) { /* fine */ } } }, 350);
      } else c.setPointerCapture(e.pointerId);
    });
    // once a card is held, stop the page from scrolling under the finger
    R.addEventListener("touchmove", function (e) { if (drag && drag.card && drag.armed) e.preventDefault(); }, { passive: false });
    document.addEventListener("pointermove", function (e) {
      if (!drag) return;
      if (!drag.armed) { if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) { clearTimeout(drag.timer); drag = null; } return; }
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) {
        drag.moved = true;
        var r = drag.el.getBoundingClientRect();
        if (drag.card) {
          var cx = info(st.pieces.filter(function (x) { return x.uid === drag.uid; })[0]);
          drag.ghost = el("div", "chip " + cx.m.kind + " ghost", "<b>" + esc(cx.m.short) + "</b>");
          drag.ox = 20; drag.oy = 18;
        } else {
          drag.ox = e.clientX - r.left; drag.oy = e.clientY - r.top;
          drag.ghost = drag.el.cloneNode(true); drag.ghost.classList.add("ghost"); drag.ghost.style.width = Math.max(r.width, 120) + "px";
        }
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
      clearTimeout(drag.timer);
      if (drag.card && !drag.moved) { drag.el.classList.remove("held"); drag = null; return; }   // a tap on a card does nothing
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

  var opened = false;
  function open() {
    if (!opened) { opened = true; track("open"); }
    checkKnown().then(function () { if (R && st.packs) render(); });
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
    if (PLAN_INFO[q.perDay]) return [GOALS[q.goal].label, (quizV2() ? "Your plan" : PLAN_INFO[q.perDay].name) + ": " + PLAN_INFO[q.perDay].what].concat(q.avoid.map(function (a) { return a + " free"; })).join(" · ");
    return [GOALS[q.goal].label, q.perDay + " meal" + (q.perDay > 1 ? "s" : "") + " a day", d].concat(q.avoid.map(function (a) { return a + " free"; })).join(" · ");
  }
  function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }
  // Luke 11/18: no checkbox. Checking out from the planner saves their goals, so the Thursday menu email can show
  // "your week is built". A browser Klaviyo already knows (current customers) saves to its own profile; a new visitor's
  // email goes to Klaviyo only once KLAVIYO_LOCKIN is switched on.
  function saveWeekly() {
    if (!st.quiz || !window.klaviyo || !window.klaviyo.identify) return Promise.resolve();
    var props;
    try { props = emailProps(); } catch (e) { props = { planner_code: goalsCode(), planner_summary: goalsSummary(), planner_saved: new Date().toISOString().slice(0, 10) }; }
    if (!knownVisitor && !signedIn()) {   // signed-in new customers are known to Klaviyo already, no email needed
      if (!OFFER.KLAVIYO_LOCKIN || !getOffer() || !getOffer().email) return Promise.resolve();
      props.email = getOffer().email;
    }
    var sent;
    try { sent = Promise.resolve(window.klaviyo.identify(props)); } catch (e) { return Promise.resolve(); }
    // never hold up checkout for more than a moment if Klaviyo is slow
    return Promise.race([sent.catch(function () {}), new Promise(function (ok) { setTimeout(ok, 1500); })]);
  }
  var skipOffer = false;
  // Lock-in: subscribe the email to the Build Your Week list with the whole week on the profile (same public subscribe
  // call the popup uses), then tell the onsite Klaviyo script who this browser is. The lock-in holds on this device either way.
  function lockIn(email) {
    setOffer({ email: email, at: Date.now() });
    if (!OFFER.KLAVIYO_LOCKIN) return;
    var props;
    try { props = emailProps(); } catch (e) { props = { planner_code: goalsCode() }; }
    props.lead_source = "build-your-week"; props.signup_page = location.pathname;
    var body = { data: { type: "subscription", attributes: { custom_source: "Build Your Week planner",
      profile: { data: { type: "profile", attributes: { email: email, properties: props } } } },
      relationships: { list: { data: { type: "list", id: OFFER.LIST } } } } };
    try {
      fetch("https://a.klaviyo.com/client/subscriptions/?company_id=" + OFFER.COMPANY, {
        method: "POST", keepalive: true, headers: { "Content-Type": "application/vnd.api+json", revision: "2024-10-15" }, body: JSON.stringify(body)
      }).then(function (r) { note("Build Your Week preview: saved to Klaviyo (" + r.status + ")", 6000); }, function () { /* offline: still locked in here */ });
    } catch (e) { /* fine */ }
    try { if (window.klaviyo && window.klaviyo.identify) window.klaviyo.identify({ email: email }); } catch (e) { /* fine */ }
  }
  function checkout() {
    if (!busy) track("checkout_click");
    if (busy || !st.packs.length) return;
    var total = st.packs.reduce(function (t, k) { return t + info(k).sz.price; }, 0), r = rungFor(total);
    if (offerShown() && r && !getOffer() && !skipOffer && !(signupOn() && !signedIn() && !SU.skip)) {   // sign-up asks for the email itself
      var li = $(R, "#liEmail"), v = li.value.trim();
      if (validEmail(v)) { lockIn(v); render(); }
      else {
        msg("Add your email to lock in " + r.label.toLowerCase() + " on your first order.", true);
        var box = $(R, "#choice"); box.hidden = false; box.innerHTML = "";
        var b = el("button", "", "Check out without the savings");
        b.addEventListener("click", function () { skipOffer = true; box.hidden = true; msg(""); checkout(); });
        box.appendChild(b); li.focus();
        return;
      }
    }
    // Luke 11/20: not signed in = make the account here first, then fill the cart and go straight to checkout
    if (signupOn() && !signedIn() && !SU.done && !SU.skip) { showSignup(); return; }
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
      st.pushed = true; st.pushedAt = Date.now(); save(); track("cart_filled");
      if (window.TSKP_ON_CHECKOUT) { busy = false; msg(""); render(); window.TSKP_ON_CHECKOUT(); return; }
      if (SU.done) { msg("Done. Taking you to checkout…"); location.href = "/checkout"; return; }   // account made in the planner
      // the cart, not /checkout: guests can see the cart, while /checkout sends them to Log In first (Luke 11/18)
      msg("Done. Taking you to your cart…");
      location.href = "/cart";
    }).catch(function (e) {
      busy = false; render();
      msg("Something went wrong putting your plan in the cart: " + e.message + ". Your plan is saved; try again, or add items from the menu.", true);
    });
  }

  // ------------------------------------------------------------------ sign-up inside the planner (Luke 11/20: "build account creation into checkout")
  // A guest who presses Check out makes their account here in 3 short screens instead of on /register. It posts the
  // site's own sign-up form (same fields, same CSRF token, same Cloudflare check), then fills the cart and goes
  // straight to /checkout signed in. Cloudflare's widget can't draw inside the shadow DOM, so it lives in a light-DOM
  // div that a <slot> shows inside the sheet. Off for customers until Luke has tried it: ?tsksignup=1 turns it on in
  // one browser, ?tsksignup=0 off. OFFER.SIGNUP = true turns it on for everyone.
  var TS_KEY = "0x4AAAAAAEnzYuZnkKqbMIZ7";   // the site's own Turnstile site key (from /register)
  var HEARD = ["Google Search", "Social Media", "Friend or Family", "Email/Newsletter", "Drove/Walked By", "Event or Festival", "Other"];
  var PW_RULES = [["12 or more characters", /^.{12,}$/], ["An uppercase letter", /[A-Z]/], ["A lowercase letter", /[a-z]/], ["A number", /[0-9]/], ["A symbol like ! ? # or @", /[!@#$%^&*(),.?":{}|<>]/]];
  var SU = { step: 1, f: {}, done: false, skip: false, busy: false, err: "", tsId: null, tsTok: "", slot: null, wired: false };
  (function () {
    var m = /[?&]tsksignup=([01])/.exec(location.search);
    if (m) try { if (m[1] === "1") localStorage.setItem("tskpSignupTest", "1"); else localStorage.removeItem("tskpSignupTest"); } catch (e) { /* fine */ }
  })();
  function signupOn() {
    if (OFFER.SIGNUP) return true;
    try { return localStorage.getItem("tskpSignupTest") === "1"; } catch (e) { return false; }
  }
  function showSignup() {
    var o = getOffer(), li = R && $(R, "#liEmail");
    if (!SU.f.email) SU.f.email = (o && o.email) || (li && li.value.trim()) || "";
    if (SU.f.news == null) SU.f.news = !!(o && o.email);   // they already gave us their email for the savings
    SU.step = 1; SU.err = "";
    if (!SU.wired) {
      SU.wired = true;
      R.addEventListener("input", function (e) { if (e.target && e.target.id === "suPw") pwList(); });
      R.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && e.target && /^su/.test(e.target.id || "") && e.target.type !== "checkbox") { e.preventDefault(); var n = $(R, '[data-q="sunext"]'); if (n) n.click(); }
      });
    }
    track("signup_open");
    $(R, ".in").classList.add("quizzing"); $(R, "#quiz").hidden = false; $(R, "#built").hidden = true;
    drawSignup();
  }
  function suInput(id, type, label, key, extra) {
    return '<label class="sul"><span>' + label + '</span><input id="' + id + '" type="' + type + '" value="' + esc(SU.f[key] || "") + '"' + (extra || "") + "></label>";
  }
  function drawSignup() {
    var q = $(R, "#quiz"), f = SU.f, body;
    var dots = '<div class="qdots">' + [1, 2, 3].map(function (i) { return '<i class="' + (i <= SU.step ? "on" : "") + '"></i>'; }).join("") + "</div>";
    var back = '<button class="qback" data-q="suback">← Back</button>';
    if (SU.step === 1) {
      body = '<span class="qkick">Last step</span><h3>Make your account</h3><p>Your week, your cart and your savings come with it. Three quick screens, then checkout.</p>' +
        '<div class="sugrid">' + suInput("suFirst", "text", "First name", "first", ' autocomplete="given-name"') + suInput("suLast", "text", "Last name", "last", ' autocomplete="family-name"') + "</div>" +
        suInput("suEmail", "email", "Email", "email", ' inputmode="email" autocomplete="email"') +
        suInput("suPhone", "tel", "Phone (for delivery texts)", "phone", ' inputmode="tel" autocomplete="tel"');
    } else if (SU.step === 2) {
      body = "<h3>Two quick ones</h3>" + suInput("suBday", "date", "Your birthday", "bday", ' autocomplete="bday" max="' + new Date().toISOString().slice(0, 10) + '"') +
        '<p class="sulab">How did you hear about us?</p><div class="suchips">' + HEARD.map(function (h) {
          return '<button data-q="suheard" data-v="' + esc(h) + '" aria-pressed="' + (f.heard === h) + '">' + esc(h) + "</button>";
        }).join("") + "</div>" +
        (f.heard === "Other" ? suInput("suOther", "text", "Where?", "other") : "");
    } else {
      body = "<h3>Pick a password</h3>" +
        '<label class="sul"><span>Password</span><span class="supw"><input id="suPw" type="' + (SU.show ? "text" : "password") + '" value="' + esc(f.pw || "") + '" autocomplete="new-password"><button data-q="sushow">' + (SU.show ? "Hide" : "Show") + "</button></span></label>" +
        '<ul class="surules" id="suRules"></ul>' +
        '<label class="suck"><input id="suTerms" type="checkbox"' + (f.terms ? " checked" : "") + '><span>I agree to the <a href="/policies" target="_blank" rel="noopener">Terms &amp; Conditions</a></span></label>' +
        '<label class="suck"><input id="suNews" type="checkbox"' + (f.news ? " checked" : "") + "><span>Sign me up for the Strong Kitchen email list.</span></label>" +
        '<label class="suck"><input id="suSms" type="checkbox"' + (f.sms ? " checked" : "") + "><span>I consent to SMS messaging (order notifications and marketing). Reply STOP to any text to stop them all.</span></label>" +
        '<div class="suts"><slot name="ts"></slot></div>';
    }
    var next = SU.step < 3 ? "Next" : SU.busy ? "Making your account…" : "Make my account and check out";
    body += '<p class="qerr" id="suErr"' + (SU.err ? "" : " hidden") + ">" + SU.err + "</p>" +
      '<button class="qnext" data-q="sunext"' + (SU.busy ? " disabled" : "") + ">" + next + "</button>";
    if (SU.step === 1) body += '<a class="qlink" href="/login">I already have an account. Log in</a>' +
      '<button class="qlink" data-q="suskip">Skip, I\'ll sign up on the site</button>';
    q.innerHTML = dots + back + body;
    if (SU.step === 3) { pwList(); mountTurnstile(); }
  }
  function pwList() {
    var ul = $(R, "#suRules"), pw = $(R, "#suPw"); if (!ul || !pw) return;
    ul.innerHTML = PW_RULES.map(function (r) { return '<li class="' + (r[1].test(pw.value) ? "ok" : "") + '">' + r[0] + "</li>"; }).join("");
  }
  function readSignup() {
    var f = SU.f, v = function (id) { var e = $(R, "#" + id); return e ? (e.type === "checkbox" ? e.checked : e.value.trim()) : null; };
    [["suFirst", "first"], ["suLast", "last"], ["suEmail", "email"], ["suPhone", "phone"], ["suBday", "bday"], ["suOther", "other"], ["suTerms", "terms"], ["suNews", "news"], ["suSms", "sms"]]
      .forEach(function (p) { var x = v(p[0]); if (x !== null) f[p[1]] = x; });
    var pw = $(R, "#suPw"); if (pw) f.pw = pw.value;   // never trimmed
  }
  function suFail(text, step) { SU.err = text; if (step && step !== SU.step) SU.step = step; drawSignup(); var e = $(R, "#suErr"); if (e && e.scrollIntoView) e.scrollIntoView({ block: "nearest" }); }
  function checkStep() {
    var f = SU.f, today = new Date().toISOString().slice(0, 10);
    if (SU.step === 1) {
      if (!f.first || !f.last) return "Add your first and last name.";
      if (!validEmail(f.email || "")) return "That email doesn't look right.";
      if ((f.phone || "").replace(/\D/g, "").length < 10) return "Add a 10-digit phone number.";
    } else if (SU.step === 2) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.bday || "") || f.bday > today) return "Add your birthday.";
      if (!f.heard) return "Pick how you heard about us.";
      if (f.heard === "Other" && !f.other) return "Tell us where you heard about us.";
    } else {
      var miss = PW_RULES.filter(function (r) { return !r[1].test(f.pw || ""); });
      if (miss.length) return "Your password still needs: " + miss.map(function (r) { return r[0].toLowerCase(); }).join(", ") + ".";
      if (!f.terms) return "Tick the box to agree to the Terms &amp; Conditions.";
      if (!SU.tsTok) return "Finish the Cloudflare check above the button (it shows you're a person).";
    }
    return "";
  }
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (!SU.tsLoad) SU.tsLoad = new Promise(function (ok, no) {
      var s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; s.async = true;
      s.onload = function () { ok(window.turnstile); };
      s.onerror = function () { SU.tsLoad = null; no(new Error("The Cloudflare check didn't load")); };
      document.head.appendChild(s);
    });
    return SU.tsLoad;
  }
  function mountTurnstile() {
    if (!SU.slot) { SU.slot = document.createElement("div"); SU.slot.slot = "ts"; host.appendChild(SU.slot); }
    if (SU.tsId != null) return;
    SU.tsId = "loading";
    loadTurnstile().then(function (ts) {
      SU.tsId = ts.render(SU.slot, {
        sitekey: TS_KEY, size: "flexible",
        callback: function (t) { SU.tsTok = t; },
        "expired-callback": function () { SU.tsTok = ""; },
        "error-callback": function () { SU.tsTok = ""; }
      });
    }, function (e) { SU.tsId = null; suFail(e.message + ". Check your connection, press Back, then Next."); });
  }
  function resetTurnstile() { SU.tsTok = ""; try { if (window.turnstile && SU.tsId != null && SU.tsId !== "loading") window.turnstile.reset(SU.tsId); } catch (e) { /* fine */ } }
  // field name the site uses -> which of our screens it is on
  var SU_STEP_OF = { billing_first_name: 1, billing_last_name: 1, email: 1, phone: 1, birthday: 2, how_heard: 2, password: 3, password_confirmation: 3, terms_accepted: 3, "cf-turnstile-response": 3 };
  function submitSignup() {
    var f = SU.f, fd = new FormData();
    fd.append("_token", csrf());
    fd.append("billing_first_name", f.first); fd.append("billing_last_name", f.last);
    fd.append("email", f.email); fd.append("phone", f.phone);
    fd.append("password", f.pw); fd.append("password_confirmation", f.pw);
    fd.append("birthday", f.bday);
    fd.append("how_heard", f.heard === "Other" ? f.other : f.heard);
    fd.append("terms_accepted", "1");
    if (f.news) fd.append("email_signup", "1");
    if (f.sms) fd.append("sms_consent", "1");
    fd.append("cf-turnstile-response", SU.tsTok);
    SU.busy = true; SU.err = ""; drawSignup(); track("signup_submit");
    fetch("/register", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", "X-CSRF-TOKEN": csrf() }, body: fd })
      .then(function (r) {
        if (r.status === 422) return r.json().then(function (j) { throw { form: (j && j.errors) || {} }; });
        if (r.status === 419) throw { text: "The page sat open too long. Tick the Cloudflare box again and press the button.", refresh: true };
        if (!r.ok) throw { text: "The site said no (" + r.status + "). Try again in a minute." };
        // signed in now? The account pages send a guest to /login.
        return fetch("/account/orders", { credentials: "same-origin" }).then(function (a) {
          if (!a.ok || /\/login/.test(a.url)) throw { text: 'Your account was made, but you\'re not signed in yet. <a href="/login">Log in</a> and your plan will be waiting.' };
        });
      })
      .then(refreshToken)
      .then(function () {
        SU.busy = false; SU.done = true; track("signup_done");
        if (!getOffer()) { if (f.news) lockIn(f.email); else setOffer({ email: "", via: "account", at: Date.now() }); }
        endQuiz(); render(); checkout();
      })
      .catch(function (e) {
        SU.busy = false; resetTurnstile();
        if (e && e.form) {
          var keys = Object.keys(e.form); track("signup_error_" + (keys[0] || "unknown"));
          if (e.form.email && /taken|exists/i.test(e.form.email.join(" "))) return suFail('That email already has an account. <a href="/login">Log in</a> and your plan will be waiting.', 1);
          var first = keys.filter(function (k) { return k !== "cf-turnstile-response"; })[0];
          if (!first) return suFail("The Cloudflare check timed out. Tick it again, then press the button.", 3);
          return suFail(esc(e.form[first][0]), SU_STEP_OF[first] || 3);
        }
        track("signup_error_other");
        (e && e.refresh ? refreshToken() : Promise.resolve()).then(function () { suFail((e && e.text) || "Something went wrong. Check your connection and try again."); });
      });
  }
  // Signing in gives the visit a new security token; the cart calls need the new one.
  function refreshToken() {
    return fetch("/cart", { credentials: "same-origin" }).then(function (r) { return r.text(); }).then(function (t) {
      var m = /<meta name="csrf-token" content="([^"]+)"/.exec(t), meta = document.querySelector('meta[name="csrf-token"]');
      if (m && meta) meta.content = m[1];
    }, function () { /* keep the old one */ });
  }
  function signupClick(a, b) {
    readSignup();
    if (a === "suback") { SU.err = ""; if (SU.step === 1) { endQuiz(); render(); return; } SU.step--; return drawSignup(); }
    if (a === "suskip") { track("signup_skip"); SU.skip = true; endQuiz(); render(); return checkout(); }
    if (a === "sushow") { SU.show = !SU.show; return drawSignup(); }
    if (a === "suheard") { SU.f.heard = b.dataset.v; SU.err = ""; drawSignup(); var o = $(R, "#suOther"); if (o) o.focus(); return; }
    if (a === "sunext") {
      if (SU.busy) return;
      var bad = checkStep(); if (bad) return suFail(bad);
      SU.err = "";
      if (SU.step < 3) { SU.step++; track("signup_step" + SU.step); drawSignup(); var i = $(R, "#quiz input"); if (i) i.focus(); return; }
      submitSignup();
    }
  }

  // ------------------------------------------------------------------ order confirmation page: the plan download
  function successPage() {
    if (!st.pushed || !st.pieces || !st.pieces.some(function (p) { return p.day >= 0; })) return;
    if (st.pushedAt && Date.now() - st.pushedAt > 3 * 864e5) return;   // only right after the planned checkout
    if (!st.orderTracked) { st.orderTracked = true; save(); track("order"); }
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
