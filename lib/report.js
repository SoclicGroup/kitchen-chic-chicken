// Kitchen Chic Chicken — rapport hebdomadaire (calculs + PDF)
// Utilisé par la fonction Supabase "weekly-report". Aucune dépendance sauf pdf-lib (passé en paramètre).

export const TZ = "Europe/Zurich";
const REASON_FR = { time: "Temps dépassé", overcooked: "Trop cuit / sec", dropped: "Tombé", other: "Autre" };

/* ---------- Dates en heure suisse ---------- */
export function zParts(date) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  const o = {}; for (const p of f.formatToParts(date)) o[p.type] = p.value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[o.weekday];
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, min: +o.minute, wd };
}
// minuit (heure suisse) du jour y-m-d, en instant UTC
export function zMidnight(y, m, d) {
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) { const p = zParts(new Date(t)); const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min); t = t - (asUTC - Date.UTC(y, m - 1, d)); }
  return new Date(t);
}
// semaine précédente complète (lundi 00:00 → lundi 00:00), et celle d'avant
export function lastWeekRange(now = new Date()) {
  const p = zParts(now);
  const back = (p.wd + 6) % 7; // jours depuis lundi
  const thisMon = new Date(Date.UTC(p.y, p.m - 1, p.d - back));
  const mk = (offsetDays) => { const x = new Date(thisMon.getTime() + offsetDays * 86400000); return zMidnight(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()); };
  return { start: mk(-7), end: mk(0), prevStart: mk(-14) };
}
export function lastYearRange(now = new Date()) {
  const y = zParts(now).y;
  return { start: zMidnight(y - 1, 1, 1), end: zMidnight(y, 1, 1), prevStart: zMidnight(y - 2, 1, 1), year: y - 1 };
}
const pad = (n) => String(n).padStart(2, "0");
const WD = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
export function weekBuckets(range) {
  return Array.from({ length: 7 }, (_, i) => {
    const p = zParts(new Date(range.start.getTime() + i * 86400000 + 6 * 3600000));
    return { key: `${p.y}-${pad(p.m)}-${pad(p.d)}`, label: `${WD[p.wd]} ${p.d}` };
  });
}
const MONTHS = ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin", "Juil", "Août", "Sep", "Oct", "Nov", "Déc"];
export const MONTHS_LONG = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
export function yearBuckets(year) { return MONTHS.map((l, i) => ({ key: `${year}-${pad(i + 1)}`, label: l })); }
// même agrégat que la fonction SQL agg_events (utile en test)
export function aggregateLocal(events, grain) {
  const m = new Map();
  for (const e of events) {
    const z = zParts(new Date(e.created_at));
    const bucket = grain === "hour" ? String(z.h) : grain === "month" ? `${z.y}-${pad(z.m)}` : `${z.y}-${pad(z.m)}-${pad(z.d)}`;
    const k = [bucket, e.restaurant_id, e.product_id, e.type, e.reason || "", e.label || ""].join("|");
    const r = m.get(k) || { bucket, restaurant_id: e.restaurant_id, product_id: e.product_id, product_name: e.product_name, type: e.type, reason: e.reason || null, label: e.label || null, n: 0, pieces: 0, late_n: 0, late_sum: 0, late_ontime: 0, late5: 0 };
    r.n++; r.pieces += e.pieces;
    if (e.late_seconds != null) { r.late_n++; r.late_sum += e.late_seconds; if (e.late_seconds <= 120) r.late_ontime++; if (e.late_seconds > 300) r.late5++; }
    m.set(k, r);
  }
  return [...m.values()];
}
export const dd = (date) => { const p = zParts(date); return `${String(p.d).padStart(2, "0")}.${String(p.m).padStart(2, "0")}.${p.y}`; };

/* ---------- Calculs (sur agrégats) ---------- */
export function summarize(rows, hourRows, products, sides, buckets) {
  const cost = Object.fromEntries(products.map((p) => [p.id, Number(p.cost) || 0]));
  const sideBy = Object.fromEntries(sides.map((x) => [x.id, x]));
  const T = { batches: 0, cooked: 0, disc: 0, chf: 0, closeChf: 0 };
  const prod = {}, reasons = {}, closing = {}, proc = { n: 0, sum: 0, ontime: 0, late5: 0 };
  const series = new Map(buckets.map((b) => [b.key, { label: b.label, a: 0, b: 0 }]));
  const hours = Array.from({ length: 24 }, () => 0);
  for (const p of products) prod[p.id] = { name: p.name, color: p.color, batches: 0, cooked: 0, disc: 0, chf: 0 };
  T.siftN = 0; T.siftPieces = 0; T.siftLate = 0;
  for (const e of rows) {
    const n = Number(e.n), pc = Number(e.pieces);
    if (e.type === "sift") { T.siftN += n; T.siftPieces += pc; if (e.label === "late") T.siftLate += n; continue; }
    if (e.type === "closing") {
      const sd = sideBy[e.product_id], k = e.product_id + "|" + e.label;
      const c = closing[k] || (closing[k] = { name: sd ? sd.name : e.product_name, unit: e.label, qty: 0, chf: 0, n: 0 });
      const cc = (pc * (Number(sd && sd.cost) || 0)) / (e.label === "g" ? 100 : 1);
      c.qty += pc; c.chf += cc; c.n += n; T.closeChf += cc;
      continue;
    }
    const P = prod[e.product_id] || (prod[e.product_id] = { name: e.product_name, color: "#888888", batches: 0, cooked: 0, disc: 0, chf: 0 });
    const S = series.get(e.bucket);
    if (e.type === "cook" || e.type === "cancel") {
      const sg = e.type === "cancel" ? -1 : 1;
      for (const o of [T, P]) { o.batches += sg * n; o.cooked += sg * pc; }
      if (S) S.a += sg * pc;
    } else if (e.type === "discard") {
      const c = pc * (cost[e.product_id] || 0);
      for (const o of [T, P]) { o.disc += pc; o.chf += c; }
      if (S) S.b += pc;
      const r = e.reason || "other"; reasons[r] = (reasons[r] || 0) + pc;
    }
    if (e.type === "discard" || e.type === "close") {
      proc.n += Number(e.late_n); proc.sum += Number(e.late_sum); proc.ontime += Number(e.late_ontime); proc.late5 += Number(e.late5);
    }
  }
  for (const e of hourRows || []) if (e.type === "discard") hours[Number(e.bucket)] += Number(e.pieces);
  return { T, closing: Object.values(closing).sort((a, b) => b.chf - a.chf || b.qty - a.qty), prod: Object.values(prod).filter((p) => p.batches || p.disc),
    reasons, series: [...series.values()], hours, proc };
}

/* ---------- PDF ---------- */
const hex = (rgb, h) => { const n = parseInt(h.replace("#", ""), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
const safe = (s) => String(s).replace(/[−–]/g, "-").replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/★/g, "*").replace(/[^\x20-\x7E\xA0-\xFF•…]/g, "?");
const pct = (a, b) => (b > 0 ? (100 * a) / b : 0);
const nf = (n, dec = 0) => { const s = (Math.round(n * 10 ** dec) / 10 ** dec).toFixed(dec); const [i, f] = s.split("."); return i.replace(/\B(?=(\d{3})+(?!\d))/g, "'") + (f ? "." + f : ""); };
const chf = (n) => "CHF " + nf(n, 2);
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

export async function buildPdf(PDFLib, { resto, title: repTitle, period, cur, prev, generatedAt, seriesTitle, prevLabel }) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const C = {
    ink: hex(rgb, "#16180F"), muted: hex(rgb, "#6B7160"), line: hex(rgb, "#E3E6DA"), paper: hex(rgb, "#FFFFFF"), soft: hex(rgb, "#F5F7EE"),
    dark: hex(rgb, "#0D0E0B"), lime: hex(rgb, "#D6F24A"), limeDeep: hex(rgb, "#8BA515"), red: hex(rgb, "#E5352B"), redSoft: hex(rgb, "#FDE8E6"),
    green: hex(rgb, "#1F9D55"), greenSoft: hex(rgb, "#E3F6EA"), amber: hex(rgb, "#D98A00"), amberSoft: hex(rgb, "#FFF3D6"), white: hex(rgb, "#FFFFFF"),
  };
  const doc = await PDFDocument.create();
  doc.setTitle(safe(`Kitchen Chic Chicken - ${repTitle} - ${resto.name}`));
  const page = doc.addPage([595.28, 841.89]);
  const W = 595.28, H = 841.89, M = 36;
  const F = await doc.embedFont(StandardFonts.Helvetica), FB = await doc.embedFont(StandardFonts.HelveticaBold);
  const text = (s, x, y, o = {}) => page.drawText(safe(s), { x, y, size: o.size || 10, font: o.bold ? FB : F, color: o.color || C.ink });
  const tw = (s, size, bold) => (bold ? FB : F).widthOfTextAtSize(safe(s), size);
  const textR = (s, xr, y, o = {}) => text(s, xr - tw(s, o.size || 10, o.bold), y, o);
  const rect = (x, y, w, h, color, o = {}) => page.drawRectangle({ x, y, width: w, height: h, color, borderColor: o.border, borderWidth: o.border ? 1 : 0 });

  // ---- Bandeau
  rect(0, H - 118, W, 118, C.dark);
  const lx = M + 26, ly = H - 58; // logo minuteur
  page.drawRectangle({ x: lx - 8, y: ly + 31, width: 16, height: 7, color: C.lime });
  page.drawRectangle({ x: lx - 2.5, y: ly + 24, width: 5, height: 8, color: C.white });
  page.drawCircle({ x: lx, y: ly, size: 24, borderColor: C.white, borderWidth: 5 });
  page.drawSvgPath("M 0 0 L 0 -19 A 19 19 0 0 1 16.45 9.5 Z", { x: lx, y: ly, color: C.lime });
  page.drawCircle({ x: lx, y: ly, size: 3.5, color: C.white });
  text("KITCHEN", M + 62, H - 50, { size: 20, bold: true, color: C.white });
  const kw = tw("KITCHEN", 20, true);
  rect(M + 62 + kw + 6, H - 55, tw("CHIC CHICKEN", 20, true) + 12, 26, C.lime);
  text("CHIC CHICKEN", M + 62 + kw + 12, H - 50, { size: 20, bold: true, color: C.dark });
  text(`${repTitle} · ${resto.name}`, M + 62, H - 76, { size: 13, bold: true, color: C.lime });
  text(period, M + 62, H - 94, { size: 10.5, color: hex(rgb, "#C9CEBC") });

  let y = H - 140;
  const T = cur.T, P = prev.T, sold = T.cooked - T.disc, soldP = P.cooked - P.disc;
  const loss = pct(T.disc, T.cooked), lossP = pct(P.disc, P.cooked);

  // ---- Cartes chiffres
  const cards = [
    { l: "Pièces cuites", v: nf(T.cooked), d: T.cooked - P.cooked, good: 0, bg: C.soft, fg: C.ink },
    { l: "Pièces vendues", v: nf(sold), d: sold - soldP, good: 1, bg: C.greenSoft, fg: C.green },
    { l: "Pièces jetées", v: nf(T.disc), d: T.disc - P.disc, good: -1, bg: C.redSoft, fg: C.red },
    { l: "Taux de perte", v: nf(loss, 1) + " %", d: loss - lossP, good: -1, bg: C.redSoft, fg: C.red, unit: " pt" , dec: 1 },
    { l: "Perte totale CHF", v: chf(T.chf + T.closeChf), d: (T.chf + T.closeChf) - (P.chf + (P.closeChf || 0)), good: -1, bg: C.redSoft, fg: C.red, money: 1 },
  ];
  const gap = 8, cw = (W - 2 * M - gap * (cards.length - 1)) / cards.length, ch = 66;
  cards.forEach((c, i) => {
    const x = M + i * (cw + gap);
    rect(x, y - ch, cw, ch, c.bg);
    text(c.l.toUpperCase(), x + 9, y - 16, { size: 7, bold: true, color: C.muted });
    let vs = 22; while (tw(c.v, vs, true) > cw - 16 && vs > 11) vs -= 1;
    text(c.v, x + 9, y - 40, { size: vs, bold: true, color: c.fg });
    if (prev.has) {
      const dv = c.d, sign = dv > 0 ? "+" : dv < 0 ? "-" : "±";
      const val = c.money ? chf(Math.abs(dv)) : nf(Math.abs(dv), c.dec || 0) + (c.unit || "");
      const better = c.good === 0 ? null : (c.good > 0 ? dv > 0 : dv < 0);
      const col = dv === 0 || better === null ? C.muted : better ? C.green : C.red;
      text(`${sign}${val} ${prevLabel}`, x + 9, y - 56, { size: 7, bold: true, color: col });
    } else text("Pas de comparaison", x + 9, y - 56, { size: 7, color: C.muted });
  });
  y -= ch + 22;

  const title = (t) => { text(t.toUpperCase(), M, y, { size: 11, bold: true }); page.drawLine({ start: { x: M, y: y - 6 }, end: { x: W - M, y: y - 6 }, thickness: 1, color: C.line }); y -= 22; };

  // ---- Par jour
  title(seriesTitle);
  const chH = 92, chY = y - chH, chW = W - 2 * M;
  const maxV = Math.max(1, ...cur.series.map((d) => Math.max(d.a, d.b)));
  for (let g = 0; g <= 4; g++) { const gy = chY + 14 + (g * (chH - 24)) / 4; page.drawLine({ start: { x: M, y: gy }, end: { x: W - M, y: gy }, thickness: 0.5, color: C.line }); }
  const slot = chW / cur.series.length;
  cur.series.forEach((d, i) => {
    const cx = M + i * slot + slot / 2, bw = Math.min(20, slot / 3.2), base = chY + 14, hs = chH - 30;
    const ha = (hs * Math.max(0, d.a)) / maxV, hb = (hs * d.b) / maxV;
    rect(cx - bw - 1, base, bw, Math.max(ha, 0.5), C.limeDeep);
    rect(cx + 1, base, bw, Math.max(hb, 0.5), C.red);
    const fs = cur.series.length > 8 ? 6 : 7;
    if (d.a) { const s = nf(d.a); text(s, cx - bw / 2 - 1 - tw(s, fs, true) / 2, base + ha + 3, { size: fs, bold: true, color: C.limeDeep }); }
    if (d.b) { const s = nf(d.b); text(s, cx + 1 + bw / 2 - tw(s, fs, true) / 2, base + hb + 3 + (ha - hb < 9 && d.a ? 8 : 0), { size: fs, bold: true, color: C.red }); }
    const lab = d.label;
    text(lab, cx - tw(lab, 8) / 2, chY + 2, { size: 8, color: C.muted });
  });
  y = chY - 12;
  rect(M, y, 8, 8, C.limeDeep); text("Pièces cuites", M + 12, y + 1, { size: 8, color: C.muted });
  rect(M + 90, y, 8, 8, C.red); text("Pièces jetées", M + 102, y + 1, { size: 8, color: C.muted });
  y -= 22;

  // ---- Par produit
  title("Par produit");
  const cols = [{ t: "Produit", x: M + 18 }, { t: "Fournées", r: M + 210 }, { t: "Cuites", r: M + 268 }, { t: "Jetées", r: M + 322 }, { t: "Vendues", r: M + 380 }, { t: "Perte", r: M + 435 }, { t: "Perte CHF", r: W - M - 6 }];
  rect(M, y - 4, W - 2 * M, 18, C.dark);
  cols.forEach((c) => (c.r ? textR(c.t, c.r, y + 1, { size: 8, bold: true, color: C.white }) : text(c.t, c.x - 12, y + 1, { size: 8, bold: true, color: C.white })));
  y -= 20;
  const rows = cur.prod.length ? cur.prod : [{ name: "Aucune activité", color: "#CCCCCC", batches: 0, cooked: 0, disc: 0, chf: 0 }];
  rows.forEach((o, i) => {
    if (i % 2) rect(M, y - 5, W - 2 * M, 17, C.soft);
    page.drawCircle({ x: M + 9, y: y + 3, size: 4, color: hex(rgb, o.color || "#888888") });
    text(o.name, M + 18, y, { size: 9.5, bold: true });
    const lp = pct(o.disc, o.cooked);
    const lc = lp >= 10 ? C.red : lp >= 5 ? C.amber : C.green;
    [nf(o.batches), nf(o.cooked), nf(o.disc), nf(o.cooked - o.disc)].forEach((v, k) => textR(v, cols[k + 1].r, y, { size: 9.5 }));
    textR(nf(lp, 1) + " %", cols[5].r, y, { size: 9.5, bold: true, color: lc });
    textR(chf(o.chf), cols[6].r, y, { size: 9.5, bold: true, color: o.chf > 0 ? C.red : C.muted });
    y -= 17;
  });
  y -= 6;
  // ---- Fermeture
  title("Pertes à la fermeture");
  if (!cur.closing.length) { text("Rien n'a été saisi en fin de service sur cette période.", M, y, { size: 9.5, color: C.muted }); y -= 22; }
  else {
    const per = Math.min(4, cur.closing.length), cw2 = (W - 2 * M - 8 * (per - 1)) / per;
    cur.closing.slice(0, 8).forEach((c, i) => {
      const col = i % per, row = Math.floor(i / per), x = M + col * (cw2 + 8), yy = y - row * 50;
      rect(x, yy - 38, cw2, 46, C.amberSoft);
      text(c.name.toUpperCase(), x + 8, yy - 6, { size: 8, bold: true, color: C.muted });
      text(`${nf(c.qty)} ${c.unit === "g" ? "g" : c.unit}`, x + 8, yy - 22, { size: 13, bold: true, color: C.amber });
      text(chf(c.chf), x + 8, yy - 33, { size: 8, bold: true, color: c.chf > 0 ? C.red : C.muted });
    });
    y -= Math.ceil(Math.min(8, cur.closing.length) / per) * 50 + 6;
    textR(`Total fermeture : ${chf(T.closeChf)}`, W - M, y + 2, { size: 9, bold: true, color: C.red });
    y -= 20;
  }

  // ---- Deux colonnes : raisons + procédure
  const colW = (W - 2 * M - 18) / 2, xL = M, xR = M + colW + 18, yTop = y;
  text("POURQUOI ON JETTE", xL, y, { size: 11, bold: true });
  text("RESPECT DE LA PROCÉDURE", xR, y, { size: 11, bold: true });
  page.drawLine({ start: { x: xL, y: y - 6 }, end: { x: xL + colW, y: y - 6 }, thickness: 1, color: C.line });
  page.drawLine({ start: { x: xR, y: y - 6 }, end: { x: xR + colW, y: y - 6 }, thickness: 1, color: C.line });
  let yl = y - 24;
  const rt = Object.values(cur.reasons).reduce((a, b) => a + b, 0);
  if (!rt) text("Aucune pièce jetée sur cette période.", xL, yl, { size: 9.5, color: C.green, bold: true });
  Object.entries(cur.reasons).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    text(REASON_FR[k] || k, xL, yl, { size: 9 });
    const bx = xL + 92, bw2 = colW - 92 - 70;
    rect(bx, yl - 1, bw2, 9, C.soft); rect(bx, yl - 1, Math.max(2, (bw2 * v) / rt), 9, C.red);
    textR(`${nf(v)} · ${Math.round((100 * v) / rt)} %`, xL + colW, yl, { size: 9, bold: true });
    yl -= 16;
  });
  let yr = y - 24;
  const pr = cur.proc;
  if (!pr.n) text("Aucun minuteur arrivé à zéro.", xR, yr, { size: 9.5, color: C.muted });
  else {
    const ontime = pct(pr.ontime, pr.n), ok = ontime >= 80;
    rect(xR, yr - 30, colW, 42, ok ? C.greenSoft : C.redSoft);
    text(ok ? "PROCÉDURE RESPECTÉE" : "PROCÉDURE À RENFORCER", xR + 10, yr - 2, { size: 9, bold: true, color: ok ? C.green : C.red });
    text(`${nf(ontime)} % des minuteurs traités en moins de 2 min`, xR + 10, yr - 18, { size: 9, color: C.ink });
    yr -= 50;
    [["Minuteurs arrivés à zéro", nf(pr.n), C.ink], ["Réaction moyenne après l'alarme", mmss(pr.sum / pr.n) + " min", pr.sum / pr.n <= 120 ? C.green : C.amber], ["Plus de 5 min de retard", nf(pr.late5) + " fois", pr.late5 ? C.red : C.green],
      ...(T.siftN ? [["Panure filtrée", `${nf(T.siftN)} fois${T.siftLate ? ` (${nf(T.siftLate)} en retard)` : ""}`, T.siftLate ? C.red : C.green]] : [])]
      .forEach(([l, v, c]) => { text(l, xR, yr, { size: 9 }); textR(v, xR + colW, yr, { size: 9, bold: true, color: c }); yr -= 15; });
  }
  y = Math.min(yl, yr) - 10;

  // ---- À retenir
  title("À retenir");
  const tips = [];
  const worstP = [...cur.prod].sort((a, b) => b.disc - a.disc)[0];
  if (worstP && worstP.disc) tips.push(`${worstP.name} : ${nf(worstP.disc)} pièces jetées (${nf(pct(worstP.disc, worstP.cooked), 1)} %), soit ${chf(worstP.chf)}. Lancer des quantités plus petites aux heures creuses.`);
  const hrs = cur.hours.map((v, h) => [h, v]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (hrs.length) tips.push(`Heures où l'on jette le plus : ${hrs.map(([h, v]) => `${h}h (${nf(v)} pièces)`).join(", ")}.`);
  const wd = [...cur.series].sort((a, b) => b.b - a.b)[0];
  if (wd && wd.b) tips.push(`${seriesTitle === "Par mois" ? "Mois" : "Jour"} le plus coûteux en pertes : ${wd.label} (${nf(wd.b)} pièces jetées).`);
  if (pr.n && pr.late5) tips.push(`${nf(pr.late5)} fois, un minuteur est resté rouge plus de 5 minutes : rappeler la procédure à l'équipe.`);
  if (cur.closing.length && cur.closing[0].chf > 0) tips.push(`À la fermeture, ${cur.closing[0].name.toLowerCase()} est la plus grosse perte (${chf(cur.closing[0].chf)}) : préparer moins en fin de soirée.`);
  if (prev.has && T.disc < P.disc) tips.push(`Bonne nouvelle : ${nf(P.disc - T.disc)} pièces jetées de moins que la période précédente.`);
  if (!tips.length) tips.push("Pas assez d'activité sur cette période pour tirer des conclusions.");
  for (const t of tips) {
    if (y < 58) break;
    page.drawCircle({ x: M + 4, y: y + 3, size: 2.5, color: C.limeDeep });
    // retour à la ligne simple
    const words = safe(t).split(" "); let line = "", first = true;
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (tw(test, 9.5) > W - 2 * M - 14) { text(line, M + 14, y, { size: 9.5 }); y -= 13; line = w; first = false; } else line = test;
    }
    if (line) { text(line, M + 14, y, { size: 9.5 }); y -= 18; }
  }

  // ---- Pied de page
  page.drawLine({ start: { x: M, y: 40 }, end: { x: W - M, y: 40 }, thickness: 0.5, color: C.line });
  text(`Généré le ${dd(generatedAt)} · Dashboard : soclicgroup.github.io/kitchen-chic-chicken/#admin`, M, 26, { size: 7.5, color: C.muted });
  textR("Kitchen Chic Chicken", W - M, 26, { size: 7.5, bold: true, color: C.muted });

  return await doc.save();
}

/* ---------- E-mail récapitulatif (HTML) ---------- */
export function emailHtml(rows, heading, intro) {
  const tr = rows.map((r) => {
    const T = r.cur.T, loss = pct(T.disc, T.cooked), lc = loss >= 10 ? "#E5352B" : loss >= 5 ? "#D98A00" : "#1F9D55";
    const ont = r.cur.proc.n ? Math.round(pct(r.cur.proc.ontime, r.cur.proc.n)) + " %" : "–";
    return `<tr><td style="padding:10px 12px;border-bottom:1px solid #E3E6DA;font-weight:700">${String(r.resto.name).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))}</td>
<td style="padding:10px 12px;border-bottom:1px solid #E3E6DA;text-align:right">${nf(T.cooked)}</td>
<td style="padding:10px 12px;border-bottom:1px solid #E3E6DA;text-align:right;color:#1F9D55;font-weight:700">${nf(T.cooked - T.disc)}</td>
<td style="padding:10px 12px;border-bottom:1px solid #E3E6DA;text-align:right;color:#E5352B;font-weight:700">${nf(T.disc)}</td>
<td style="padding:10px 12px;border-bottom:1px solid #E3E6DA;text-align:right;color:${lc};font-weight:700">${nf(loss, 1)} %</td>
<td style="padding:10px 12px;border-bottom:1px solid #E3E6DA;text-align:right;color:#E5352B">${chf(T.chf + T.closeChf)}</td>
<td style="padding:10px 12px;border-bottom:1px solid #E3E6DA;text-align:right">${ont}</td></tr>`;
  }).join("");
  const th = (t, l) => `<th style="padding:9px 12px;text-align:${l ? "left" : "right"};font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#FFFFFF;background:#0D0E0B">${t}</th>`;
  return `<!doctype html><html><body style="margin:0;background:#F5F7EE;font-family:Arial,Helvetica,sans-serif;color:#16180F">
<div style="max-width:720px;margin:0 auto;padding:24px 16px">
<div style="background:#0D0E0B;border-radius:14px;padding:22px 24px">
<div style="font-size:22px;font-weight:800;color:#FFFFFF;letter-spacing:.03em">KITCHEN <span style="background:#D6F24A;color:#0D0E0B;padding:1px 8px;border-radius:6px">CHIC CHICKEN</span></div>
<div style="color:#D6F24A;font-weight:700;margin-top:10px">${heading}</div></div>
<p style="font-size:15px;line-height:1.5">Bonjour,<br>${intro}</p>
<table style="width:100%;border-collapse:collapse;background:#FFFFFF;border-radius:10px;overflow:hidden;font-size:14px">
<tr>${th("Restaurant", 1)}${th("Cuites")}${th("Vendues")}${th("Jetées")}${th("Perte")}${th("Perte CHF (total)")}${th("À temps")}</tr>${tr}</table>
<p style="font-size:12px;color:#6B7160;margin-top:18px">« À temps » = minuteurs traités moins de 2 minutes après l'alarme.<br>
Tous les rapports sont archivés dans le dashboard, onglet Rapports : <a href="https://soclicgroup.github.io/kitchen-chic-chicken/#admin" style="color:#16180F">soclicgroup.github.io/kitchen-chic-chicken/#admin</a></p>
</div></body></html>`;
}

/* ---------- Journal détaillé d'une journée ---------- */
const TYPE_FR = { cook: "Lancé", discard: "Jeté", cancel: "Annulé", close: "Clôturé", closing: "Fermeture", sift: "Panure filtrée" };
export async function buildJournalPdf(PDFLib, { resto, dateLabel, events, products, sides, generatedAt }) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const C = { ink: hex(rgb, "#16180F"), muted: hex(rgb, "#6B7160"), line: hex(rgb, "#E3E6DA"), soft: hex(rgb, "#F5F7EE"), dark: hex(rgb, "#0D0E0B"), lime: hex(rgb, "#D6F24A"),
    green: hex(rgb, "#1F9D55"), greenSoft: hex(rgb, "#E3F6EA"), red: hex(rgb, "#E5352B"), redSoft: hex(rgb, "#FDE8E6"), amber: hex(rgb, "#B87400"), amberSoft: hex(rgb, "#FFF3D6"), blue: hex(rgb, "#2F6FD1"), blueSoft: hex(rgb, "#E6EEFB"), white: hex(rgb, "#FFFFFF") };
  const doc = await PDFDocument.create();
  doc.setTitle(safe(`Kitchen Chic Chicken - Journal ${dateLabel} - ${resto.name}`));
  const F = await doc.embedFont(StandardFonts.Helvetica), FB = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 36;
  let page, y, pageNo = 0;
  const text = (s, x, yy, o = {}) => page.drawText(safe(s), { x, y: yy, size: o.size || 9, font: o.bold ? FB : F, color: o.color || C.ink });
  const tw = (s, size, bold) => (bold ? FB : F).widthOfTextAtSize(safe(s), size);
  const textR = (s, xr, yy, o = {}) => text(s, xr - tw(s, o.size || 9, o.bold), yy, o);
  const rect = (x, yy, w, h, color) => page.drawRectangle({ x, y: yy, width: w, height: h, color });
  const cols = { time: M + 6, prod: M + 56, act: M + 210, qty: M + 330, pcs: M + 400, det: M + 412 };
  const head = () => {
    rect(M, y - 4, W - 2 * M, 18, C.dark);
    [["Heure", cols.time], ["Produit", cols.prod], ["Action", cols.act], ["Quantité", cols.qty, 1], ["Pièces", cols.pcs, 1], ["Détail", cols.det + 4]].forEach(([t, x, r]) => r ? textR(t, x, y + 1, { size: 8, bold: true, color: C.white }) : text(t, x, y + 1, { size: 8, bold: true, color: C.white }));
    y -= 20;
  };
  const newPage = (first) => {
    page = doc.addPage([W, H]); pageNo++;
    if (first) {
      rect(0, H - 92, W, 92, C.dark);
      text("KITCHEN", M, H - 40, { size: 18, bold: true, color: C.white });
      const kw = tw("KITCHEN", 18, true);
      rect(M + kw + 6, H - 45, tw("CHIC CHICKEN", 18, true) + 12, 24, C.lime);
      text("CHIC CHICKEN", M + kw + 12, H - 40, { size: 18, bold: true, color: C.dark });
      text(`Journal de la journée · ${resto.name}`, M, H - 62, { size: 12, bold: true, color: C.lime });
      text(dateLabel, M, H - 78, { size: 10, color: hex(rgb, "#C9CEBC") });
      y = H - 116;
    } else {
      text(`Journal ${dateLabel} · ${resto.name} (suite)`, M, H - 40, { size: 10, bold: true, color: C.muted });
      y = H - 64;
    }
    page.drawText(safe(`Page ${pageNo}`), { x: W - M - 40, y: 22, size: 7.5, font: F, color: C.muted });
    page.drawText(safe(`Généré le ${dd(generatedAt)} · Kitchen Chic Chicken`), { x: M, y: 22, size: 7.5, font: F, color: C.muted });
  };
  newPage(true);
  // résumé de la journée
  let cooked = 0, disc = 0, batches = 0, sifts = 0, closingN = 0;
  for (const e of events) {
    if (e.type === "cook") { cooked += e.pieces; batches++; } else if (e.type === "cancel") { cooked -= e.pieces; batches--; }
    else if (e.type === "discard") disc += e.pieces; else if (e.type === "sift") sifts++; else if (e.type === "closing") closingN++;
  }
  const sum = [["Fournées", nf(batches), C.soft, C.ink], ["Pièces cuites", nf(cooked), C.soft, C.ink], ["Vendues", nf(cooked - disc), C.greenSoft, C.green], ["Jetées", nf(disc), C.redSoft, C.red], ["Actions", nf(events.length), C.soft, C.ink]];
  const cw = (W - 2 * M - 8 * 4) / 5;
  sum.forEach(([l, v, bg, fg], i) => { const x = M + i * (cw + 8); rect(x, y - 44, cw, 50, bg); text(l.toUpperCase(), x + 8, y - 8, { size: 7, bold: true, color: C.muted }); text(v, x + 8, y - 32, { size: 18, bold: true, color: fg }); });
  y -= 70;
  if (!events.length) { text("Aucune action enregistrée ce jour-là.", M, y, { size: 11, color: C.muted }); return await doc.save(); }
  head();
  const sideBy = Object.fromEntries((sides || []).map((x) => [x.id, x]));
  const pill = { cook: [C.greenSoft, C.green], discard: [C.redSoft, C.red], cancel: [C.soft, C.muted], close: [C.soft, C.muted], closing: [C.blueSoft, C.blue], sift: [C.amberSoft, C.amber] };
  events.forEach((e, i) => {
    if (y < 48) { newPage(false); head(); }
    if (i % 2) rect(M, y - 4, W - 2 * M, 15, C.soft);
    const z = zParts(new Date(e.created_at));
    text(`${pad(z.h)}:${pad(z.min)}`, cols.time, y, { bold: true });
    text(String(e.product_name).slice(0, 28), cols.prod, y);
    const [bg, fg] = pill[e.type] || [C.soft, C.muted];
    const lab = TYPE_FR[e.type] || e.type;
    rect(cols.act - 3, y - 3, tw(lab, 8, true) + 8, 12, bg);
    text(lab, cols.act + 1, y, { size: 8, bold: true, color: fg });
    const unit = e.type === "closing" ? (e.label === "g" ? "g" : e.label) : "";
    textR(e.type === "closing" || e.type === "sift" ? "" : String(e.label || ""), cols.qty, y);
    textR(e.type === "closing" ? `${nf(e.pieces)} ${unit}` : e.type === "close" ? "0" : nf(e.pieces), cols.pcs, y, { bold: e.type === "discard", color: e.type === "discard" ? C.red : C.ink });
    const det = [e.reason ? REASON_FR[e.reason] : null, e.late_seconds != null ? `réaction ${mmss(e.late_seconds)}` : null, e.type === "sift" ? `${e.label === "late" ? "en retard" : "à temps"} · ${nf(e.pieces)} pièces avant` : null].filter(Boolean).join(" · ");
    if (det) text(det.slice(0, 48), cols.det + 4, y, { size: 7.5, color: C.muted });
    y -= 15;
  });
  return await doc.save();
}
export function dayRange(dateStr) { const [y, m, d] = dateStr.split("-").map(Number); const next = new Date(Date.UTC(y, m - 1, d + 1)); return { start: zMidnight(y, m, d), end: zMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()) }; }
export function yesterdayStr(now = new Date()) { const p = zParts(now); const x = new Date(Date.UTC(p.y, p.m - 1, p.d - 1)); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`; }
