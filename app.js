import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------- storage helpers ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};

/* ---------- state (same JSON shape as the Android app) ---------- */
function normalize(o) {
  const s = { people: [], expenses: [], cur: "$" };
  if (!o || typeof o !== "object") return s;
  if (Array.isArray(o.people)) s.people = o.people.filter(p => p && p.id).map(p => ({ id: String(p.id), name: String(p.name ?? "") }));
  if (Array.isArray(o.expenses)) s.expenses = o.expenses.filter(e => e && e.id).map(e => ({
    id: String(e.id), desc: String(e.desc ?? ""), cents: Number(e.cents) || 0, payer: String(e.payer ?? ""),
    among: Array.isArray(e.among) ? e.among.map(String) : [],
    paid: e.paid && typeof e.paid === "object" ? Object.fromEntries(Object.entries(e.paid).map(([k, v]) => [k, Number(v) || 0])) : {}
  }));
  if (typeof o.cur === "string") s.cur = o.cur;
  return s;
}
function loadState() { try { return normalize(JSON.parse(LS.get("state", "null"))); } catch { return normalize(null); } }
function saveLocal() { LS.set("state", JSON.stringify(S)); }

let S = loadState();
let groupId = LS.get("groupId", "");
let isAdmin = LS.get("isAdmin", "0") === "1";
let isOwner = false;
let cloudStatus = "Connecting to cloud…";
let msg = "";
const ui = {
  pname: "", desc: "", amount: "", payer: "", excluded: {}, groupInput: "", adminCodeInput: "",
  newAdminCode: "", editing: {}, editSel: {}, editPayer: {}, pay: {},
  collapsed: (() => { try { return JSON.parse(LS.get("collapsed", "{}")) || {}; } catch { return {}; } })(),
  hintDismissed: LS.get("hintDismissed", "0") === "1"
};
const TITLES = ["Shared group · Admin controls", "Total spent", "People", "Add expense", "Settle up", "Pending payments", "Balances", "Expenses"];

/* ---------- logic ---------- */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = c => S.cur + (c / 100).toFixed(2);
const nameOf = id => S.people.find(p => p.id === id)?.name ?? "Removed";
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const parseCents = t => Math.round((parseFloat(String(t).replace(",", ".")) || 0) * 100);

function shareOf(e, i) {
  const n = e.among.length; if (!n) return 0;
  const base = Math.floor(e.cents / n), rem = e.cents - base * n;
  return base + (i < rem ? 1 : 0);
}
function balances() {
  const b = {}; S.people.forEach(p => b[p.id] = 0);
  S.expenses.forEach(e => {
    if (!e.among.length) return;
    b[e.payer] = (b[e.payer] ?? 0) + e.cents;
    e.among.forEach((id, i) => { b[id] = (b[id] ?? 0) - shareOf(e, i); });
  });
  return b;
}
function settle(b) {
  const cr = Object.entries(b).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]);
  const db = Object.entries(b).filter(([, v]) => v < 0).map(([k, v]) => [k, -v]).sort((x, y) => y[1] - x[1]);
  const out = []; let i = 0, j = 0;
  while (i < cr.length && j < db.length) {
    const m = Math.min(cr[i][1], db[j][1]);
    out.push({ from: db[j][0], to: cr[i][0], v: m });
    cr[i][1] -= m; db[j][1] -= m;
    if (cr[i][1] === 0) i++;
    if (db[j][1] === 0) j++;
  }
  return out;
}
function pending() {
  const p = {};
  S.expenses.forEach(e => e.among.forEach((id, i) => {
    if (id === e.payer) return;
    const sh = shareOf(e, i), left = sh - Math.min(Math.max(e.paid[id] ?? 0, 0), sh);
    if (left > 0) p[id] = (p[id] ?? 0) + left;
  }));
  return p;
}

/* ---------- cloud ---------- */
let auth = null, db = null, cloudReady = false, unsub = null;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const configMissing = () => /PASTE_/.test(firebaseConfig.apiKey + firebaseConfig.appId);

async function cloudInit() {
  if (configMissing()) { cloudStatus = "Firebase config missing: edit firebase-config.js"; return; }
  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app); db = getFirestore(app);
    const user = await new Promise(res => { const un = onAuthStateChanged(auth, u => { un(); res(u); }); });
    if (!user) await signInAnonymously(auth);
    cloudReady = true; cloudStatus = "Cloud connected";
    if (groupId) { listen(groupId); checkAdmin(); }
  } catch (e) { cloudStatus = e.message || "Cloud setup required"; }
  render();
}
function listen(id) {
  if (unsub) unsub();
  unsub = onSnapshot(doc(db, "groups", id), snap => {
    if (!snap.exists()) { cloudStatus = "Group not found"; scheduleRender(); return; }
    if (snap.metadata.hasPendingWrites) return;
    try { S = normalize(JSON.parse(snap.data().stateJson)); saveLocal(); scheduleRender(); }
    catch { cloudStatus = "Could not read shared group data"; scheduleRender(); }
  }, err => { cloudStatus = err.message || "Sync error"; scheduleRender(); });
}
async function cloudSave(state) {
  try {
    await updateDoc(doc(db, "groups", groupId), { stateJson: JSON.stringify(state), updatedAt: Date.now() });
    cloudStatus = "Synced";
  } catch { cloudStatus = "Only a group admin can make changes"; }
  scheduleRender();
}
async function checkAdmin() {
  try {
    const uid = auth.currentUser.uid;
    const g = await getDoc(doc(db, "groups", groupId));
    isOwner = g.exists() && g.data().ownerUid === uid;
    let admin = isOwner;
    if (!admin) { const c = await getDoc(doc(db, "groups", groupId, "coadmin", "current")); admin = c.exists() && c.data().uid === uid; }
    setAdmin(admin);
  } catch {}
  scheduleRender();
}
function setAdmin(v) { isAdmin = v; LS.set("isAdmin", v ? "1" : "0"); }
function saveGroup(id) { groupId = id; LS.set("groupId", id); }

/* ---------- actions ---------- */
function update(n) {
  if (groupId && !isAdmin) { msg = "View-only access: only the group admin can edit."; render(); return false; }
  S = n; saveLocal();
  if (groupId && cloudReady) cloudSave(n);
  render(); return true;
}
const needCloud = () => { if (!cloudReady) { cloudStatus = configMissing() ? "Firebase config missing: edit firebase-config.js" : "Cloud is not ready yet"; render(); return false; } return true; };

const actions = {
  collapseAll() { TITLES.forEach(t => ui.collapsed[t] = true); LS.set("collapsed", JSON.stringify(ui.collapsed)); render(); },
  expandAll() { TITLES.forEach(t => ui.collapsed[t] = false); LS.set("collapsed", JSON.stringify(ui.collapsed)); render(); },
  toggle(el) { const k = el.dataset.key; ui.collapsed[k] = !ui.collapsed[k]; LS.set("collapsed", JSON.stringify(ui.collapsed)); render(); },
  dismissHint() { ui.hintDismissed = true; LS.set("hintDismissed", "1"); render(); },

  async createGroup() {
    if (!needCloud()) return;
    const id = uuid().replace(/-/g, "");
    try {
      await setDoc(doc(db, "groups", id), { ownerUid: auth.currentUser.uid, stateJson: JSON.stringify(S), updatedAt: Date.now() });
      saveGroup(id); setAdmin(true); isOwner = true; listen(id);
      cloudStatus = "Group created · share code below";
    } catch (e) { cloudStatus = e.message || "Could not create group"; }
    render();
  },
  async joinGroup() {
    if (!needCloud()) return;
    const id = ui.groupInput.trim(); if (!id) return;
    try {
      const g = await getDoc(doc(db, "groups", id));
      if (!g.exists()) { cloudStatus = "Group link not found"; render(); return; }
      saveGroup(id); setAdmin(false); isOwner = false; ui.groupInput = ""; listen(id); checkAdmin();
      cloudStatus = "Joined · view only";
    } catch (e) { cloudStatus = e.message || "Could not join group"; }
    render();
  },
  async createInvite() {
    if (!needCloud()) return;
    const r = crypto.getRandomValues(new Uint8Array(8));
    const code = Array.from(r, x => ALPHABET[x % ALPHABET.length]).join("");
    try {
      await setDoc(doc(db, "groups", groupId, "invites", code), { expiresAt: Date.now() + 24 * 3600 * 1000 });
      ui.newAdminCode = code; cloudStatus = "Admin code created (valid 24h, one use)";
    } catch { cloudStatus = "Only the group owner can create an admin code"; }
    render();
  },
  async claimAdmin() {
    if (!needCloud()) return;
    const code = ui.adminCodeInput.trim().toUpperCase(); if (!code) return;
    try {
      const batch = writeBatch(db);
      batch.set(doc(db, "groups", groupId, "coadmin", "current"), { uid: auth.currentUser.uid, inviteCode: code });
      batch.delete(doc(db, "groups", groupId, "invites", code));
      await batch.commit();
      setAdmin(true); ui.adminCodeInput = ""; cloudStatus = "You are now an admin";
    } catch { cloudStatus = "Code is invalid, expired, already used, or an admin already exists"; }
    render();
  },
  async removeCoAdmin() {
    if (!needCloud()) return;
    try {
      const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
      await deleteDoc(doc(db, "groups", groupId, "coadmin", "current")); cloudStatus = "Co-admin removed";
    } catch (e) { cloudStatus = e.message || "Could not remove co-admin"; }
    render();
  },
  leave() {
    if (unsub) { unsub(); unsub = null; }
    groupId = ""; LS.del("groupId"); setAdmin(false); isOwner = false; ui.newAdminCode = ""; cloudStatus = "Disconnected"; render();
  },
  shareCode() { share("Join my SplitTracker group. Enter this code in the app: " + groupId); },
  shareAdmin() { share("SplitTracker admin code (one use, expires in 24h): " + ui.newAdminCode); },

  addPerson() {
    const n = ui.pname.trim(); if (!n) return;
    if (S.people.some(p => p.name.toLowerCase() === n.toLowerCase())) { msg = "That name is already added."; render(); return; }
    if (update({ ...S, people: [...S.people, { id: uuid(), name: n }] })) { ui.pname = ""; msg = ""; render(); }
  },
  removePerson(el) {
    const id = el.dataset.id;
    if (S.expenses.some(e => e.payer === id || e.among.includes(id))) { msg = "Tap Edit on their expenses to remove them (or delete those expenses) first."; render(); return; }
    if (update({ ...S, people: S.people.filter(p => p.id !== id) })) { msg = ""; render(); }
  },
  toggleExcl(el) { const id = el.dataset.id; ui.excluded[id] = !ui.excluded[id]; },
  addExpense() {
    const cents = parseCents(ui.amount);
    const among = S.people.filter(p => !ui.excluded[p.id]).map(p => p.id);
    const payerId = S.people.some(p => p.id === ui.payer) ? ui.payer : (S.people[0]?.id ?? "");
    msg = S.people.length < 2 ? "Add at least two people first."
      : !ui.desc.trim() ? "Enter what the expense was for."
      : cents <= 0 ? "Enter an amount above zero."
      : !among.length ? "Pick who shares this expense." : "";
    if (msg) { render(); return; }
    if (update({ ...S, expenses: [...S.expenses, { id: uuid(), desc: ui.desc.trim(), cents, payer: payerId, among, paid: {} }] })) {
      ui.desc = ""; ui.amount = ""; render();
    }
  },
  toggleEdit(el) {
    const id = el.dataset.id, e = S.expenses.find(x => x.id === id); if (!e) return;
    if (ui.editing[id]) { ui.editing[id] = false; }
    else { ui.editing[id] = true; ui.editSel[id] = Object.fromEntries(e.among.map(a => [a, true])); ui.editPayer[id] = e.payer; }
    render();
  },
  editToggleSel(el) { const id = el.dataset.id, pid = el.dataset.pid; ui.editSel[id][pid] = !ui.editSel[id][pid]; render(); },
  saveEdit(el) {
    const id = el.dataset.id, sel = ui.editSel[id] || {};
    const among = S.people.map(p => p.id).filter(p => sel[p]); if (!among.length) return;
    const payer = ui.editPayer[id];
    if (update({ ...S, expenses: S.expenses.map(x => x.id === id ? { ...x, among, payer } : x) })) { ui.editing[id] = false; render(); }
  },
  delExpense(el) { update({ ...S, expenses: S.expenses.filter(x => x.id !== el.dataset.id) }); },
  addPay(el) {
    const eid = el.dataset.id, pid = el.dataset.pid, key = eid + "_" + pid;
    const e = S.expenses.find(x => x.id === eid); if (!e) return;
    const share = shareOf(e, e.among.indexOf(pid)), paid = Math.min(Math.max(e.paid[pid] ?? 0, 0), share);
    const c = parseCents(ui.pay[key] || ""); if (c <= 0) return;
    if (update({ ...S, expenses: S.expenses.map(x => x.id === eid ? { ...x, paid: { ...x.paid, [pid]: Math.min(paid + c, share) } } : x) })) { ui.pay[key] = ""; render(); }
  },
  fullPay(el) {
    const eid = el.dataset.id, pid = el.dataset.pid;
    const e = S.expenses.find(x => x.id === eid); if (!e) return;
    const share = shareOf(e, e.among.indexOf(pid)), paid = Math.min(Math.max(e.paid[pid] ?? 0, 0), share);
    update({ ...S, expenses: S.expenses.map(x => x.id === eid ? { ...x, paid: { ...x.paid, [pid]: paid >= share ? 0 : share } } : x) });
  },
  shareSummary() {
    const pays = settle(balances()), pend = pending();
    let t = `Split summary - total ${money(S.expenses.reduce((a, e) => a + e.cents, 0))}\n`;
    if (!pays.length) t += "Everyone is square.\n";
    pays.forEach(p => t += `${nameOf(p.from)} pays ${nameOf(p.to)} ${money(p.v)}\n`);
    Object.entries(pend).forEach(([id, v]) => t += `${nameOf(id)} still to pay ${money(v)}\n`);
    share(t);
  },
  clearAll() { if (confirm("Clear everything? This deletes all people and expenses.")) update({ people: [], expenses: [], cur: S.cur }); }
};

async function share(text) {
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
    await navigator.clipboard.writeText(text); cloudStatus = "Copied to clipboard";
  } catch { /* user cancelled */ }
  render();
}

/* ---------- rendering ---------- */
let dirty = false;
function scheduleRender() {
  const a = document.activeElement;
  if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) dirty = true; else render();
}
document.addEventListener("focusout", () => { if (dirty) setTimeout(() => { if (!/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "")) { dirty = false; render(); } }, 80); });

const section = (title, body) => {
  const c = !!ui.collapsed[title];
  return `<section class="card"><button class="sec-head" data-action="toggle" data-key="${esc(title)}" aria-expanded="${!c}">
    <span>${esc(title)}</span><span class="chev">${c ? "▸" : "▾"}</span></button>${c ? "" : `<div class="sec-body">${body}</div>`}</section>`;
};
const line = (label, note, value) => `<div class="row"><div class="grow"><div>${esc(label)}</div>${note ? `<div class="sub">${esc(note)}</div>` : ""}</div><div class="strong">${esc(value)}</div></div>`;
const peopleSelect = (bind, selected) => `<select data-bind="${bind}">${S.people.map(p => `<option value="${esc(p.id)}"${p.id === selected ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>`;

function groupSection() {
  let h = `<div class="sub">${esc(cloudStatus)}</div>`;
  if (!groupId) {
    h += `<button class="btn" data-action="createGroup">Create shared group (admin)</button>
      <div><label class="field">Enter friend's group code</label><input type="text" data-bind="groupInput" value="${esc(ui.groupInput)}" autocapitalize="off" autocomplete="off" autocorrect="off"></div>
      <button class="btn outline" data-action="joinGroup">Join shared group (view only)</button>`;
  } else {
    h += `<div>${isAdmin ? (isOwner ? "You are the owner/admin. Friends have view-only access." : "You are an admin of this group.") : "You are viewing this group. Editing is disabled."}</div>
      <div class="small">Group code: ${esc(groupId)}</div>`;
    if (isOwner) {
      h += `<button class="btn outline" data-action="createInvite">Create one-time admin code</button>`;
      if (ui.newAdminCode) h += `<div class="strong">Admin code: ${esc(ui.newAdminCode)}</div><button class="btn outline" data-action="shareAdmin">Share admin code</button>`;
      h += `<button class="btn text" data-action="removeCoAdmin">Remove co-admin</button>`;
    } else if (!isAdmin) {
      h += `<div><label class="field">Have an admin code?</label><input type="text" data-bind="adminCodeInput" value="${esc(ui.adminCodeInput)}" autocapitalize="characters" autocomplete="off" autocorrect="off"></div>
        <button class="btn outline" data-action="claimAdmin">Become admin</button>`;
    }
    h += `<div class="row"><button class="btn outline" data-action="shareCode">Share invite</button><button class="btn text" data-action="leave">Leave group</button></div>`;
  }
  return h;
}

function expenseRow(e) {
  const editing = !!ui.editing[e.id];
  let h = `<div class="exp"><div class="row"><div class="grow"><div class="strong">${esc(e.desc)}</div>
    <div class="sub">${esc(nameOf(e.payer))} paid · split ${e.among.length} ways</div></div>
    <div class="strong">${esc(money(e.cents))}</div></div>
    <div class="row"><button class="btn text small-btn" data-action="toggleEdit" data-id="${e.id}">${editing ? "Cancel" : "Edit"}</button>
    <button class="btn text danger small-btn" data-action="delExpense" data-id="${e.id}">Delete</button></div>`;
  if (editing) {
    const sel = ui.editSel[e.id] || {};
    h += `<div><label class="field">Paid by</label>${peopleSelect("editPayer." + e.id, ui.editPayer[e.id])}</div><div class="sub">Split equally between</div>`;
    S.people.forEach(p => { h += `<label class="check"><input type="checkbox" data-action="editToggleSel" data-id="${e.id}" data-pid="${p.id}"${sel[p.id] ? " checked" : ""}>${esc(p.name)}</label>`; });
    h += `<div><button class="btn" data-action="saveEdit" data-id="${e.id}">Save</button></div>`;
  } else {
    e.among.forEach((id, i) => {
      if (id === e.payer) return;
      const sh = shareOf(e, i), paid = Math.min(Math.max(e.paid[id] ?? 0, 0), sh), key = e.id + "_" + id;
      const status = paid >= sh ? "Paid" : paid > 0 ? `paid ${money(paid)}, left ${money(sh - paid)}` : "Not paid";
      h += `<div class="sub">${esc(nameOf(id))}: share ${esc(money(sh))} · ${esc(status)}</div>
        <div class="row"><input class="pay-in" type="text" inputmode="decimal" placeholder="Payment" data-bind="pay.${key}" value="${esc(ui.pay[key] || "")}">
        <button class="btn outline small-btn" data-action="addPay" data-id="${e.id}" data-pid="${id}">Add</button>
        <button class="btn outline small-btn" data-action="fullPay" data-id="${e.id}" data-pid="${id}">${paid >= sh ? "Reset" : "Full"}</button></div>`;
    });
  }
  return h + "</div>";
}

function render() {
  const bal = balances(), pays = settle(bal), pend = pending();
  const payerId = S.people.some(p => p.id === ui.payer) ? ui.payer : (S.people[0]?.id ?? "");
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  let h = `<h1>SplitTracker</h1>
    <div class="row"><button class="btn outline" data-action="collapseAll">Minimise all</button><button class="btn outline" data-action="expandAll">Maximise all</button></div>`;
  if (isIOS && !standalone && !ui.hintDismissed)
    h += `<div class="hint">Install on iPhone: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>. <button class="btn text small-btn" data-action="dismissHint">Dismiss</button></div>`;
  h += section(TITLES[0], groupSection());
  if (msg) h += `<div class="err">${esc(msg)}</div>`;
  if (groupId && !isAdmin) h += `<div class="banner">VIEW ONLY · Only the admin can add, edit, delete or mark payments.</div>`;

  h += section(TITLES[1], `<div class="row"><div class="big grow">${esc(money(S.expenses.reduce((a, e) => a + e.cents, 0)))}</div>
    <div style="width:110px"><label class="field">Currency</label><input type="text" maxlength="4" data-change="cur" value="${esc(S.cur)}"></div></div>`);

  h += section(TITLES[2], `<div class="row"><div class="grow"><label class="field">Name</label><input type="text" maxlength="30" data-bind="pname" value="${esc(ui.pname)}" autocomplete="off"></div>
    <button class="btn" style="align-self:flex-end" data-action="addPerson">Add</button></div>
    ${S.people.length ? "" : "<div>Add at least two people to start.</div>"}
    ${S.people.map(p => `<div class="row"><div class="grow">${esc(p.name)}</div><button class="btn text" data-action="removePerson" data-id="${p.id}">Remove</button></div>`).join("")}`);

  h += section(TITLES[3], `<div><label class="field">What was it for?</label><input type="text" maxlength="60" data-bind="desc" value="${esc(ui.desc)}" autocomplete="off"></div>
    <div><label class="field">Amount</label><input type="text" inputmode="decimal" data-bind="amount" value="${esc(ui.amount)}"></div>
    ${S.people.length ? `<div><label class="field">Paid by</label>${peopleSelect("payer", payerId)}</div>` : ""}
    <div class="sub">Split equally between</div>
    ${S.people.map(p => `<label class="check"><input type="checkbox" data-action="toggleExcl" data-id="${p.id}"${ui.excluded[p.id] ? "" : " checked"}>${esc(p.name)}</label>`).join("")}
    <div><button class="btn" data-action="addExpense">Add expense</button></div>`);

  h += section(TITLES[4], pays.length ? pays.map(p => line(`${nameOf(p.from)} pays ${nameOf(p.to)}`, "", money(p.v))).join("")
    : `<div>${S.expenses.length ? "Everyone is square." : "Nothing to settle yet."}</div>`);

  const pe = Object.entries(pend);
  h += section(TITLES[5], pe.length ? pe.map(([id, v]) => line(nameOf(id), "still to pay", money(v))).join("")
    : `<div>${S.expenses.length ? "Everyone has paid." : "Nothing pending yet."}</div>`);

  h += section(TITLES[6], S.people.length ? S.people.map(p => { const v = bal[p.id] ?? 0; return line(p.name, v > 0 ? "is owed" : v < 0 ? "owes" : "settled", money(Math.abs(v))); }).join("")
    : "<div>No people yet.</div>");

  h += section(TITLES[7], `${S.expenses.length ? [...S.expenses].reverse().map(expenseRow).join("") : "<div>No expenses yet.</div>"}
    <div class="row"><button class="btn" data-action="shareSummary">Share summary</button><button class="btn text danger" data-action="clearAll">Clear everything</button></div>`);

  document.getElementById("app").innerHTML = h;
}

/* ---------- events ---------- */
function setPath(path, val) {
  const i = path.indexOf(".");
  if (i < 0) ui[path] = val; else ui[path.slice(0, i)][path.slice(i + 1)] = val;
}
document.addEventListener("input", e => { const b = e.target.dataset?.bind; if (b) setPath(b, e.target.value); });
document.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset?.bind) setPath(t.dataset.bind, t.value);
  if (t.dataset?.change === "cur") update({ ...S, cur: t.value.slice(0, 4) });
  if (t.type === "checkbox" && t.dataset.action === "toggleExcl") actions.toggleExcl(t);
  if (t.type === "checkbox" && t.dataset.action === "editToggleSel") actions.editToggleSel(t);
});
document.addEventListener("click", e => {
  const el = e.target.closest("[data-action]");
  if (!el || el.type === "checkbox") return;
  const fn = actions[el.dataset.action]; if (fn) fn(el);
});

if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
render();
cloudInit();
