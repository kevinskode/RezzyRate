// === Stripe config ===
// TEST KEY
// const STRIPE_PUBLISHABLE_KEY = "pk_test_51RzkyvChKVWsJZcWlClLjJ1xACdszPyCjKmX1HTudOaqq5VKOM2rAdc2a9qusAWjskbaGba2IEzLhDGaBJb2NAYM00yaemtAQf";  // <-- your TEST publishable key

// LIVE KEY
const STRIPE_PUBLISHABLE_KEY = "pk_live_51RzkynCoSH0U9UtKSQSfYVQH6NAm4UG2xzSKeiH7JqQM8g1EnzRtQTR7F5gh9rXHpurl9zLfDjdWiCkvuetrn6m900Ij2YCcfT";
const API_BASE_URL = "https://gyw1n7b24m.execute-api.us-east-2.amazonaws.com/Prod"; // <-- your API

console.log("Version: 1");

/* ==================== UTIL: persistent credit token ==================== */
function getOrCreateToken(){
  const k = 'credit_token_v1';
  let t = localStorage.getItem(k);
  if (!t){
    t = (globalThis.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Date.now()) + Math.random().toString(16).slice(2);
    try { localStorage.setItem(k, t); } catch {}
  }
  return t;
}
const CREDIT_TOKEN = getOrCreateToken();

/* ==================== STRIPE PRICE IDS ==================== */
// TEST IDS
// const PRICE_IDS = {
//   1:  "price_1S5dgPChKVWsJZcWk9kacziD",
//   10: "price_1S5dhfChKVWsJZcWJdjIkpfx",
//   20: "price_1S5di8ChKVWsJZcWTxpXycQ0"
// };

// LIVE IDS
const PRICE_IDS = {
  1:  "price_1SMcGTCoSH0U9UtKFpwoWFBI",   // $2.99
  10: "price_1SMcH5CoSH0U9UtKnxQ3onfb",   // $9.99
  20: "price_1SMcHxCoSH0U9UtKePKIwwb1"    // $14.99
};

let stripe, elements, paymentElement, clientSecret;

/* ==================== STRIPE INIT ==================== */
document.addEventListener('DOMContentLoaded', () => {
  if (!window.Stripe) {
    console.error('Stripe.js failed to load (CSP or network)');
    return;
  }
  stripe = Stripe(STRIPE_PUBLISHABLE_KEY);

  // make sure your price labels render on load too
  if (typeof updatePricingUI === 'function') {
    updatePricingUI();
  }
});

/* ==================== iPHONE MODAL HELPERS (NEW) ==================== */
// Close the bottom-sheet hint if it’s open (prevents overlay stacking weirdness)
function hideMobileHintIfOpen(){
  const hint = document.getElementById('mobile-hint');
  if (hint && hint.classList.contains('open')){
    hint.classList.remove('open');
    hint.setAttribute('aria-hidden', 'true');
  }
}

// Basic focus trap so keyboard stays in the checkout/paywall modal on iPhone
let modalLastFocus = null;
function trapFocus(modal){
  if (!modal) return;
  const focusable = modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];

  function loop(e){
    if (e.key !== 'Tab') return;
    if (e.shiftKey && document.activeElement === first){
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last){
      e.preventDefault(); first.focus();
    }
  }
  modal.addEventListener('keydown', loop);
  modal.__untrap = () => modal.removeEventListener('keydown', loop);
}

// Smoothly ensure the Pay button is visible above the keyboard/home bar
function keepPayVisible(){
  const btn = document.getElementById('pay-now');
  if (!btn) return;
  try { btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {}
}

/* ==================== CHECKOUT MODAL OPEN/CLOSE ==================== */
function openCheckout(){
  hideMobileHintIfOpen();
  const modal = document.getElementById('checkout-modal');
  if (!modal) return;

  modal.classList.add('open');
  document.body.classList.add('modal-open');

  // reset button state + message every time the modal opens
  const payBtn = document.getElementById('pay-now');
  const msg    = document.getElementById('checkout-msg');
  if (payBtn) payBtn.disabled = false;
  if (msg) msg.textContent = '';

  modalLastFocus = document.activeElement;
  trapFocus(modal);
  setTimeout(keepPayVisible, 120);
}

function closeCheckout(){
  const modal = document.getElementById('checkout-modal');
  if (!modal) return;

  modal.classList.remove('open');
  document.body.classList.remove('modal-open');

  // untrap focus + restore previous focus
  if (modal.__untrap) modal.__untrap();
  if (modalLastFocus) { try { modalLastFocus.focus(); } catch {} }
  modalLastFocus = null;

  // unmount Element if present
  try { if (paymentElement) paymentElement.unmount(); } catch(_) {}
  const mount = document.getElementById('payment-element');
  if (mount) mount.innerHTML = '';

  // clear handler + re-enable button for next time
  const payBtn = document.getElementById('pay-now');
  if (payBtn) { payBtn.onclick = null; payBtn.disabled = false; }

  // clear state
  elements = paymentElement = clientSecret = null;
  const msg = document.getElementById('checkout-msg');
  if (msg) msg.textContent = '';
}

(() => {
  const closeBtn = document.getElementById('closeCheckoutBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeCheckout);
})();

/* ==================== PRICING ==================== */
const PRICES = { single: 2.99, pack10: 9.99, pack20: 14.99 };
const fmt = n => `$${n.toFixed(2)}`;
function updatePricingUI(){
  const p1 = fmt(PRICES.single), p10 = fmt(PRICES.pack10), p20 = fmt(PRICES.pack20);
  const lead = document.getElementById('paywallLeadText');
  if (lead) lead.innerHTML = `You used your free daily scan. Buy additional scans for <strong>${p1}</strong> or save with a pack.`;
  const setBtn = (id, qty, price) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<span class="btn-label">${qty} ${qty===1?'Scan':'Scans'}</span><span class="btn-price">${price}</span>`;
  };
  setBtn('btnBuy1Top', 1,  p1); setBtn('btnBuy10Top',10, p10); setBtn('btnBuy20Top',20, p20);
  setBtn('btnBuy1Modal', 1,  p1); setBtn('btnBuy10Modal',10, p10); setBtn('btnBuy20Modal',20, p20);
}

/* ==================== METERING & PAYWALL ==================== */
const LS_KEYS = { lastDate:'rc_lastDate', dailyUsed:'rc_dailyUsed', credits:'rc_credits', unlimitedUntil:'rc_unlimited_until' };
(function handleUnlimitedFlag(){
  const params = new URLSearchParams(location.search);
  const hours = 48;
  if (params.get('unlimited') === '1'){
    try {
      localStorage.setItem(LS_KEYS.unlimitedUntil, String(Date.now() + hours*60*60*1000));
      history.replaceState(null,'',location.pathname);
    } catch {}
  } else if (params.get('unlimited') === '0'){
    try {
      localStorage.removeItem(LS_KEYS.unlimitedUntil);
      history.replaceState(null,'',location.pathname);
    } catch {}
  }
})();
function isUnlimited(){ const until = parseInt(localStorage.getItem(LS_KEYS.unlimitedUntil)||'0',10); return Date.now() < until; }
const todayStr = () => { const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
function readMeter(){
  const today = todayStr();
  const last = localStorage.getItem(LS_KEYS.lastDate);
  if (last !== today){ try { localStorage.setItem(LS_KEYS.lastDate, today); localStorage.setItem(LS_KEYS.dailyUsed, '0'); } catch{} }
  const freeUsed = parseInt(localStorage.getItem(LS_KEYS.dailyUsed)||'0',10);
  const credits = parseInt(localStorage.getItem(LS_KEYS.credits)||'0',10);
  return { freeLeft: Math.max(0, 1 - freeUsed), credits };
}
function writeMeter({freeConsumed=0, creditConsumed=0, creditAdd=0}={}){
  const used = parseInt(localStorage.getItem(LS_KEYS.dailyUsed)||'0',10) + freeConsumed;
  const credits = Math.max(0, parseInt(localStorage.getItem(LS_KEYS.credits)||'0',10) - creditConsumed + creditAdd);
  try {
    localStorage.setItem(LS_KEYS.dailyUsed, String(used));
    localStorage.setItem(LS_KEYS.credits, String(credits));
  } catch {}
  updateMeterUI();
}
function updateMeterUI(){
  const {freeLeft, credits} = readMeter();
  const creditBadge = document.getElementById('creditBadge');
  const freeBadge = document.getElementById('freeBadge');
  if (creditBadge) creditBadge.textContent = `Paid credits: ${credits}`;
  if (freeBadge) freeBadge.textContent = isUnlimited() ? 'Free scans left today: ∞ (temp)' : `Free scans left today: ${freeLeft}`;
}
function canConsumeScan(){
  if (isUnlimited()) return { ok:true, mode:'unlimited' };
  const {freeLeft, credits} = readMeter();
  if (freeLeft > 0) return { ok:true, mode:'free' };
  if (credits > 0) return { ok:true, mode:'credit' };
  return { ok:false, mode:'pay' };
}
function consumeScan(mode){ if (mode==='free') writeMeter({freeConsumed:1}); else if (mode==='credit') writeMeter({creditConsumed:1}); }

/* ==================== HEURISTIC SCORING ==================== */
const STOPWORDS = new Set(["the","a","an","and","or","but","if","then","else","of","to","in","for","on","at","with","by","from","as","that","this","these","those","is","are","was","were","be","been","being","it","its","your","you","i","me","my","we","our","they","their"]);
const SECTION_HINTS = ["experience","education","skills","projects","certifications","summary","contact","awards"];
const normalize = t => (t||"").replace(/\u2022/g,"-").replace(/[\t\r]/g," ").trim();
const tokenize = t => normalize(t).toLowerCase().replace(/[^a-z0-9%$+\-\s]/g," ").split(/\s+/).filter(Boolean);
const wordFreq = t => { const f=new Map(); for(const w of tokenize(t)){ if(STOPWORDS.has(w)||w.length<3) continue; f.set(w,(f.get(w)||0)+1);} return f; };
const extractKeywords = (t,n=15)=> [...wordFreq(t).entries()].sort((a,b)=>b[1]-a[1]).slice(0,n).map(([w])=>w);
const unique = a => [...new Set(a.filter(Boolean))];
const countNumbers = t => (t.match(/(^|\s)(\$?\d+[\d,]*(\.?\d+)?%?)/g)||[]).length;
function bulletStats(t){ const lines=normalize(t).split(/\n+/); return { bullets:lines.filter(l=>/^\s*[-•*]/.test(l)).length, exclam:(t.match(/!/g)||[]).length, capsWords:(t.match(/\b[A-Z]{4,}\b/g)||[]).length, longLines:lines.filter(l=>l.length>160).length }; }
const passiveVoiceCount = t => (t.match(/\b(?:was|were|is|are|been|being|be)\s+[a-z]+ed\b/gi)||[]).length;
function fleschReadingEase(t){ const s=(t.match(/[.!?]+/g)||["."]).length; const words=tokenize(t); const wc=Math.max(words.length,1); const syl=words.reduce((sum,w)=>sum+ (w.match(/[aeiouy]{1,2}/g)||[]).length,0); const ASL=wc/s; const ASW=syl/wc; return Math.max(0,Math.min(100,Math.round(206.835-1.015*ASL-84.6*ASW))); }
const presenceScore = t => Math.min(15, Math.round((SECTION_HINTS.filter(s=> normalize(t).toLowerCase().includes(s)).length/5)*15));
function keywordScore(resume,keywords){
  const rTokens=new Set(tokenize(resume));
  const list=unique(keywords.map(k=>k.toLowerCase().trim()).filter(k=>k.length>0));
  const present=[]; const missing=[];
  for(const k of list){ (rTokens.has(k)?present:missing).push(k); }
  const coverage=list.length?present.length/list.length:0;
  return { score:Math.round(40*coverage), missing, present, coverage, total:list.length };
}
/* FIX: words/numbers separation in details */
function professionalismScore(r){
  const {bullets,exclam,capsWords,longLines}=bulletStats(r);
  const pv=passiveVoiceCount(r);
  const words=tokenize(r).length;
  const nums=countNumbers(r);
  let score=35;
  if(exclam>0)score-=Math.min(5,exclam*2);
  score-=Math.min(5,Math.floor(capsWords/5));
  score-=Math.min(5,Math.floor(pv/4));
  score-=Math.min(5,longLines);
  if(bullets>=5)score+=2;
  if(nums>=3)score+=3;
  if(words>=250&&words<=900)score+=2;
  return {score:Math.max(0,Math.min(35,Math.round(score))), details:{bullets,exclam,capsWords,longLines,passive:pv,words, numbers:nums}};
}
const readabilityScore = r => Math.round((fleschReadingEase(r)/100)*10);
function scoreResume(resume,jd,userKeywords){
  const extracted=extractKeywords(jd||"");
  const combined=unique([...(userKeywords||[]),...extracted]);
  const kw=keywordScore(resume,combined);
  const prof=professionalismScore(resume);
  const pres=presenceScore(resume);
  const read=readabilityScore(resume);
  const total=Math.max(0,Math.min(100,Math.round(kw.score+prof.score+pres+read)));
  return{
    total,
    breakdown:{ats_keywords:kw.score,professionalism:prof.score,structure:pres,readability:read},
    coverage:kw.coverage, missingKeywords:kw.missing, presentKeywords:kw.present, totalKeywords:kw.total,
    extractedKeywords:extracted,
    profDetails:prof.details,
    sectionPresence: SECTION_HINTS.reduce((acc,s)=>{ acc[s]=normalize(resume).toLowerCase().includes(s); return acc; },{})
  };
}
const pct = (val,max)=> Math.round((max?val/max:0)*100);
function classifyScore(total){ if(total>=85) return "Excellent"; if(total>=70) return "Strong"; if(total>=55) return "Fair"; return "Needs work"; }
function gradeReadability(r){ if(r>=8) return "Very easy to skim"; if(r>=6) return "Plain & readable"; if(r>=5) return "Somewhat dense"; if(r>=3) return "Hard to read"; return "Very hard to read"; }

/* ---------- Top Fixes (human-friendly) ---------- */
function friendlyFixes(result, fre){
  const tips = [];
  const present = (result.presentKeywords || []);
  const missing = (result.missingKeywords || []);
  const totalKW = result.totalKeywords || (present.length + missing.length);
  const perKw = totalKW ? Math.max(1, Math.round(40 / totalKW)) : 0;
  const tag = (p) =>
    p === 'high' ? '<span class="pill p-high">Quick win</span>' :
    p === 'med'  ? '<span class="pill p-med">Worth doing</span>' :
                   '<span class="pill p-low">Nice to have</span>';
  const addTip = (priority, title, body) =>
    tips.push(`<li>
      <div class="fix-row">${tag(priority)}<span class="fix-title">${title}</span></div>
      <p class="fix-body">${body}</p>
    </li>`);
  if (missing.length){
    const show = missing.slice(0, 10);
    addTip('high','Add a few missing keywords',`Work in the terms the job uses — ${show.join(', ')}. Each one should bump your ATS score by about +${perKw}.`);
  }
  if (result.profDetails.numbers < 3){
    addTip('high','Show the impact with numbers',`You’ve got ${result.profDetails.numbers}. Aim for 3–5 clear wins like “cut processing time 30%,” “saved $50K,” or “reduced variance 18%.”`);
  }
  const missingSections =
    Object.entries(result.sectionPresence).filter(([, v]) => !v).map(([k]) => k);
  if (missingSections.length){
    addTip('med','Fill the missing sections',`Add ${missingSections.join(', ')} so recruiters (and ATS) can find the essentials fast.`);
  }
  if (!result.sectionPresence.summary){
    addTip('med','Write a short summary',`Two–three lines: your title, core tools, and one impact line. Example: “Business Data Analyst • SQL, Python, Tableau • automate reporting and improve forecast accuracy.”`);
  }
  if (result.profDetails.passive > 3){
    addTip('med','Use active verbs',`I spotted ${result.profDetails.passive} passive phrases. Swap “was built / were automated” for “Built,” “Automated,” “Forecasted.”`);
  }
  if (result.profDetails.bullets < 5){
    addTip('med','Add a few more bullets',`You have ${result.profDetails.bullets}. Aim ~5–7 bullets for recent roles and ~3–5 for older ones.`);
  }
  if (result.breakdown.readability <= 5 || fre < 55){
    addTip('med','Smooth the reading flow',`Your Flesch score is ${fre}. Keep sentences ~12–18 words, split long lines into bullets, and prefer clear wording. Aim for 60+.`);
  }
  if (result.profDetails.longLines > 0){
    addTip('low','Break up long lines',`${result.profDetails.longLines} line(s) are quite long. Keep bullets under ~160 characters.`);
  }
  if (result.profDetails.capsWords > 6){
    addTip('low','Dial back ALL CAPS',`${result.profDetails.capsWords} ALL-CAPS words found.`);
  }
  if (result.profDetails.exclam > 0){
    addTip('low','Skip exclamation marks','You don’t need them — the results can carry the energy.');
  }
  if (result.profDetails.words < 300){
    addTip('low','Add a bit more substance',`${result.profDetails.words} words now. A one-pager usually lands around 400–700 words.`);
  } else if (result.profDetails.words > 950){
    addTip('low','Tighten the length',`${result.profDetails.words} words total.`);
  }
  addTip('low','Keep it ATS-friendly','Use a single column, simple headings, and export to a text-based PDF.');
  if (present.length && missing.length){
    addTip('low','Match the job’s phrasing','Mirror wording when it makes sense so scanners don’t miss it.');
  }
  return tips.slice(0, 12);
}

/* ==================== Render helpers (visuals) ==================== */
function scoreBand(pct){           // overall 0–100
  return pct >= 85 ? 'good' : pct >= 55 ? 'warn' : 'bad';
}
function kpiBand(value, max){      // individual KPI 0–max
  const pct = Math.round((value / max) * 100);
  return scoreBand(pct);
}
function bandColor(band){          // returns CSS var()
  return band === 'good' ? 'var(--ok)' : band === 'warn' ? 'var(--warn)' : 'var(--bad)';
}

/* Donut SVG (allows band override to color-match label) */
function donutSVG(percent, label, opts = {}){
  const r = 28, c = 2 * Math.PI * r, off = c * (1 - percent / 100);
  const band = opts.band || scoreBand(percent);
  const stroke = bandColor(band);
  return `
    <div class="donut" role="img" aria-label="Score ${percent}%">
      <svg viewBox="0 0 72 72">
        <circle cx="36" cy="36" r="${r}" fill="none" stroke="rgba(148,163,184,.25)" stroke-width="8"></circle>
        <circle cx="36" cy="36" r="${r}" fill="none" stroke="${stroke}" stroke-width="8"
                stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}"
                transform="rotate(-90 36 36)"></circle>
      </svg>
      <div class="center">${label}</div>
    </div>`;
}

/* Tip bubble helper */
const tipHTML = inner => `
  <span class="tip">
    <button class="tip-btn" type="button" aria-label="More info">i</button>
    <span class="tip-bubble" role="tooltip">${inner}<span class="arrow" aria-hidden="true"></span></span>
  </span>`;

/* ==================== getSnippet (clean sentence slicing) ==================== */
function getSnippet(src, rx, { around = 140, max = 260 } = {}) {
  if (!src || !rx) return "";
  const text = String(src).replace(/\s+/g, " ").trim();

  const m = rx.exec(text);
  if (!m) return "";

  let start = Math.max(0, m.index - around);
  let end   = Math.min(text.length, m.index + m[0].length + around);

  const lastPeriod = Math.max(
    text.lastIndexOf(". ", start),
    text.lastIndexOf("! ", start),
    text.lastIndexOf("? ", start)
  );
  if (lastPeriod !== -1) start = lastPeriod + 2;
  else {
    const lastSpace = text.lastIndexOf(" ", start);
    if (lastSpace !== -1) start = lastSpace + 1;
  }

  const after = text.slice(end);
  const sentMatch = after.match(/^[^.!?]*[.!?](?:["’”])?\s/);
  if (sentMatch) end += sentMatch[0].length;
  else {
    const nextSpace = text.indexOf(" ", end);
    if (nextSpace !== -1) end = nextSpace;
  }

  let snippet = text.slice(start, end).trim();
  if (snippet.length > max) {
    const cut = snippet.search(/([.!?](?:["’”])?\s)[^.!?]*$/);
    snippet = (cut > 0 ? snippet.slice(0, cut + 1) : snippet.slice(0, max)).trim();
  }

  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${snippet}${suffix}`;
}

/* ==================== Ghost Job analysis ==================== */
function mapScoreToRank(realness){
  if (realness <= 30) return { label: "Likely Ghost", band: "bad", next:
    "Proceed carefully. Ask whether the req is funded, who’s actively hiring, and the target start date. Consider networking into the team before applying." };
  if (realness <= 55) return { label: "Unclear", band: "warn", next:
    "Mixed signals. Confirm timeline, hiring manager, interview stages, and whether this is backfill or pipeline building." };
  return { label: "Seems Real", band: "good", next:
    "Looks active. Apply soon, mirror the job’s wording for key tools, and follow up with the hiring manager/recruiter within a week." };
}

function analyzeGhostJob(jdRaw = "", resumeRaw = "") {
  const jd = (jdRaw || "").trim();
  if (!jd) return null;

  const pos = [
    { w:14, rx:/\b(?:salary|compensation|pay range|base pay|usd|\$\s*\d)/i,  label:'Lists salary or pay range' },
    { w:10, rx:/\b(?:remote|hybrid|on[-\s]?site)\b|[A-Za-z .'-]+,\s*[A-Z]{2}\b/i, label:'Clear location or work mode' },
    { w:10, rx:/\b(?:apply by|deadline|closes on|closing date|applications close|by \w+ \d{1,2})\b/i, label:'Has an application deadline' },
    { w: 6, rx:/\b(?:report(?:s)? to|hiring manager|team|department)\b/i, label:'Mentions team or hiring manager' },
    { w: 6, rx:/\b(?:interview|round|assessment|timeline|start date)\b/i, label:'Describes interview process/timeline' },
    { w: 5, rx:/\b\d{1,2}\+?\s*(?:years|yrs)\b/i, label:'Specific years of experience' },
    { w: 4, rx:/\b(sql|python|react|tableau|power\s*bi|excel|etl|terraform|kubernetes|aws|gcp|azure|java(script)?)\b/i, label:'Concrete tools/tech named' },
  ];

  const neg = [
    { w:18, rx:/\b(accepting applications|future opportunities|talent pool|pipeline of candidates|evergreen|ongoing basis|rolling basis|open until filled|always hiring|not actively hiring)\b/i, label:'Evergreen/pipeline phrasing' },
    { w:10, rx:/\b(responsible for|duties include|requirements include)\b/i, label:'Very vague responsibilities' },
    { w:10, rx:/\b(staffing agency|recruiting agency|on behalf of our client|third[-\s]?party|3rd[-\s]?party)\b/i, label:'Agency/on-behalf-of wording' },
    { w: 8, rx:/\b(unpaid|volunteer|commission[-\s]?only)\b/i, label:'Unpaid/commission-only language' },
    { w: 6, rx:/\b(contract|contract[-\s]?to[-\s]?hire|w[-\s]?2|1099|temp)\b/i, label:'Contract terms with few specifics' },
    { w: 6, eval:(txt)=>((txt.match(/^\s*[-•*]/gm)||[]).length>=15), label:'Very long generic bullet list' },
    { w: 4, rx:/\b(no sponsorship|work authorization required|h-?1b|opt|cpt)\b/i, label:'Visa/sponsorship caveat' },
  ];

  let ghostiness = 50;
  const hitsPos = [];
  const hitsNeg = [];

  for (const s of pos){
    let matched = false, snippet = "";
    if (s.rx && s.rx.test(jd)){
      matched = true;
      snippet = getSnippet(
        jd,
        new RegExp(s.rx.source, s.rx.flags.replace('g',''))
      );
    }
    if (s.eval && s.eval(jd)){ matched = true; }
    if (matched){ ghostiness -= s.w; hitsPos.push({title:s.label, snippet}); }
  }
  for (const s of neg){
    let matched = false, snippet = "";
    if (s.rx && s.rx.test(jd)){
      matched = true;
      snippet = getSnippet(
        jd,
        new RegExp(s.rx.source, s.rx.flags.replace('g',''))
      );
    }
    if (s.eval && s.eval(jd)){ matched = true; }
    if (matched){ ghostiness += s.w; hitsNeg.push({title:s.label, snippet}); }
  }

  ghostiness = Math.max(0, Math.min(100, Math.round(ghostiness)));
  const realness = 100 - ghostiness;

  const totalSignals = pos.length + neg.length;
  const matched = hitsPos.length + hitsNeg.length;
  const confidence = totalSignals
    ? Math.min(1, Math.max(0.2, matched / totalSignals))
    : 0.4;
  const confLabel = confidence >= 0.75 ? 'High'
                   : confidence >= 0.5 ? 'Medium'
                   : 'Low';

  const { label, band, next } = mapScoreToRank(realness);
  return {
    score: realness,
    ghostiness,
    label, band, confLabel, next,
    reasonsPos: hitsPos, reasonsNeg: hitsNeg
  };
}

/* ==================== Lead-word styler ==================== */
function styleSummaryLeads(html){
  return html.replace(
    /<p>\s*\*\*([^*]+?)\s*:\s*\*\*\s*([\s\S]*?)<\/p>/g,
    '<p class="os-p"><span class="os-key">$1</span><span class="os-body">$2</span></p>'
  );
}

/* ==================== Job Reality Check UI ==================== */
function jobRealitySectionHTML(ghost) {
  if (!ghost) return "";
  const { score, ghostiness, label, band, confLabel, next, reasonsPos = [], reasonsNeg = [] } = ghost;

  const realness = score;
  const donut = donutSVG(realness, `${realness}`, { band });
  const labelClass = band === 'good' ? 'good' : band === 'warn' ? 'warn' : 'bad';

  const li = (icon, r) => `<li class="ghost-li">
      <div class="fix-row"><span class="pill ${icon==='✅'?'good':'bad'}">${icon}</span>
      <span class="fix-title">${r.title}</span></div>
      ${r.snippet ? `<p class="fix-body"><em>“${r.snippet}”</em></p>` : ``}
    </li>`;

  const posList = reasonsPos.slice(0,5).map(r => li('✅', r)).join('');
  const negList = reasonsNeg.slice(0,5).map(r => li('⚠️', r)).join('');

  const summaryChips = `
  <div class="stat-chips" role="list">
    <span class="stat-chip" role="listitem"><b>${realness}%</b><span>Realness</span></span>
    <span class="stat-chip" role="listitem"><b>${ghostiness}/100</b><span>Ghostiness</span></span>
    <span class="stat-chip" role="listitem"><b>${confLabel}</b><span>Confidence</span></span>
    <span class="stat-chip" role="listitem"><b>${reasonsPos.length}</b><span>Hiring signals</span></span>
    <span class="stat-chip" role="listitem"><b>${reasonsNeg.length}</b><span>Red flags</span></span>
  </div>`;

  return `
    <h3 class="card-title" style="margin:14px 0 6px">Job Ad Reality Check</h3>
    <div class="ghost-wrap">
      <div class="results-head" style="margin-bottom:8px">
        <div class="score-block">
          <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
            <div class="rating ${labelClass}" aria-label="Ghost likelihood">${label}</div>
            ${donut}
          </div>
          <div>
            <div class="helper">This shows how “real” the ad looks. Higher is better.</div>
            ${summaryChips}
          </div>
        </div>
      </div>

      <h4 class="card-title" style="margin:8px 0 6px">Why this rating</h4>
      <ul class="list-tight list-mini">
        ${negList}${posList || `<li class="ghost-li"><div class="fix-row"><span class="pill p-med">Note</span><span class="fix-title">Not many explicit hiring signals found</span></div></li>`}
      </ul>

      <h4 class="card-title" style="margin:10px 0 6px">Next step</h4>
      <p class="helper" style="margin:0">${next}</p>
    </div>
  `;
}

/* ==================== Overall Summary ==================== */
function generateOverallSummary(result, fre, ghost, resumeText, jdText){
  const rank = classifyScore(result.total);
  const covPct  = Math.round((result.coverage||0)*100);
  const present = result.presentKeywords || [];
  const missing = result.missingKeywords || [];
  const missingPreview = missing.slice(0, 10);
  const presentPreview = present.slice(0, 12);
  const read10 = result.breakdown.readability;
  const readLabel = gradeReadability(read10);

  const presentSections = Object.entries(result.sectionPresence).filter(([,v])=>v).map(([k])=>k);
  const missingSections = Object.entries(result.sectionPresence).filter(([,v])=>!v).map(([k])=>k);

  const ghostNote = ghost ? (() => {
    const tone =
      ghost.band === 'good' ? "looks active and worth applying to" :
      ghost.band === 'warn' ? "has mixed signals—apply, but clarify timing and process" :
                              "may be a placeholder or ‘evergreen’ post—proceed thoughtfully";
    return `The job ad reality check lands at ${ghost.score}% realness (${ghost.label}). In plain English: it ${tone}.`;
  })() : "";

  const kwHint = missing.length
    ? `You’re already aligned on ${present.length} of ${present.length + missing.length} keywords. If you can naturally weave in even a few of the missing terms — like ${missingPreview.join(', ')} — your ATS score should lift.`
    : `Nice: there aren’t obvious keyword gaps for this post. Keep mirroring the job’s exact phrasing where it feels natural.`;

  const p = result.profDetails;
  const impactTip = p.numbers >= 3
    ? `Good use of measurable impact (${p.numbers} data points).`
    : `Try to add clearer impact (aim for 3–5 concrete numbers).`;
  const passiveTip = p.passive > 3
    ? `I noticed ${p.passive} passive constructions — swapping to active verbs will help.`
    : `Voice reads mostly active, which keeps your accomplishments punchy.`;
  const bulletsTip = p.bullets < 5
    ? `Consider a few more bullets in your most recent role so each result stands on its own.`
    : `Bullet density looks healthy — it’s skimmable.`;

  const readNote = `Readability translates to a ${read10}/10 (“${readLabel}”). For most roles, shorter sentences (about 12–18 words) and one idea per bullet help both humans and ATS.`;

  const structureNote = missingSections.length
    ? `Structure wise, you’re missing ${missingSections.join(', ')}. Adding those headers helps recruiters (and ATS) find the essentials fast.`
    : `Your structure covers the common sections — nice foundation.`;

  const paragraphs = [
    `**Overall:** Your resume scores <b>${result.total}/100</b> (${rank}). That combines ATS keyword alignment (${result.breakdown.ats_keywords}/40), professionalism (${result.breakdown.professionalism}/35), section structure (${result.breakdown.structure}/15), and readability (${result.breakdown.readability}/10).`,
    `**Keyword fit:** Coverage sits at <b>${covPct}%</b>. ${kwHint} ${presentPreview.length ? `Strong overlaps include: ${presentPreview.join(', ')}.` : ''}`,
    `**Professional polish:** ${impactTip} ${passiveTip} ${bulletsTip}`,
    `**Readability:** Flesch score is <b>${fre}</b>, which maps to "${readLabel}". ${readNote}`,
    `**Structure:** ${structureNote}`,
    ghost ? `**Job ad reality check:** ${ghostNote} ${ghost.next ? `Next move: ${ghost.next}` : ''}` : '',
    `**What to do next:** Pick 2–3 bullets in your most recent role and tie them to the job’s language (especially the missing keywords). Add one quantified improvement per bullet — time saved, accuracy improved, revenue influenced, costs reduced. Keep each bullet single-idea, ~1–2 lines, and lead with an action verb (Built, Automated, Forecasted, Reduced).`
  ].filter(Boolean);

  return styleSummaryLeads(`
    <div class="overall-summary">
      ${paragraphs.map(p => `<p>${p}</p>`).join('')}
    </div>
  `);
}

/* ==================== Analyze ==================== */
function analyze(){
  const gate = canConsumeScan(); 
  if (!gate.ok){ openPaywall(); return; }

  const resumeEl  = document.getElementById('resume');
  const jdEl      = document.getElementById('jd');
  const kwEl      = document.getElementById('keywords');
  const out       = document.getElementById('results');

  const resume = (resumeEl && resumeEl.value) || '';
  const jd     = (jdEl && jdEl.value) || '';
  const keywords = ((kwEl && kwEl.value) || '')
    .split(/,|\n/).map(s=>s.trim()).filter(Boolean);

  const result = scoreResume(resume, jd, keywords);

  consumeScan(gate.mode);

  const present = (result.presentKeywords||[]);
  const missing = (result.missingKeywords||[]);
  const covPct  = Math.round((result.coverage||0)*100);
  const fre     = fleschReadingEase(resume);

  const presentSections = Object.entries(result.sectionPresence).filter(([,v])=>v).map(([k])=>k);
  const missingSections = Object.entries(result.sectionPresence).filter(([,v])=>!v).map(([k])=>k);

  const bullets     = result.profDetails.bullets;
  const exclam      = result.profDetails.exclam;
  const capsWords   = result.profDetails.capsWords;
  const longLines   = result.profDetails.longLines;
  const passiveHits = result.profDetails.passive;
  const wordCount   = result.profDetails.words;
  const numbersUsed = result.profDetails.numbers;

  const readScore10 = result.breakdown.readability;
  const readLabel   = gradeReadability(readScore10);

  const tipOverall = tipHTML(`
    <div style="font-weight:800;margin-bottom:6px">Overall Score (0–100)</div>
    <div style="margin-bottom:6px">
      Your resume’s composite rating. It’s the sum of ATS keywords (0–40) + Professionalism (0–35) +
      Structure (0–15) + Readability (0–10).
    </div>
    <div style="margin-bottom:6px"><b>What “good” means:</b> 85–100 = ready to send, 70–84 = solid but room to polish, 55–69 = fair, &lt;55 = needs work.</div>
    <div><b>How to lift it:</b> add job-specific keywords, quantify impact, and keep bullets short and skimmable.</div>
  `);

  const tipATS = tipHTML(`
    <div style="font-weight:800;margin-bottom:6px">ATS Keywords (0–40)</div>
    <div style="margin-bottom:6px">
      Measures how well your wording matches the job’s required tools, skills, and titles. We scan the JD,
      merge with any custom keywords, and check coverage in your resume.
    </div>
    <div style="margin-bottom:6px"><b>Your scan:</b> ${present.length} matched of ${present.length + missing.length} (${covPct}% coverage).</div>
    <div style="margin-bottom:6px"><b>What “good” means:</b> 30–40 = strong alignment; 20–29 = partial; &lt;20 = likely under-aligned.</div>
    <div style="margin-bottom:6px">
      <b>Quick wins:</b> mirror exact phrases from the JD (e.g., “SQL” vs. “MySQL” if the JD says SQL); keep acronyms & full names
      (e.g., “AWS” and “Amazon Web Services”).
    </div>
    ${missing.length ? `<div><b>Missing examples:</b> <i>${missing.slice(0,10).join(', ')}</i></div>` : `<div><b>Nice:</b> no obvious gaps detected.</div>`}
  `);

  const tipPRO = tipHTML(`
    <div style="font-weight:800;margin-bottom:6px">Professionalism (0–35)</div>
    <div style="margin-bottom:6px">
      Clarity and polish signals recruiters notice: use of numbers, active voice, reasonable bullet length,
      limited ALL-CAPS, and no shouty punctuation.
    </div>
    <ul style="margin:6px 0 6px 18px; padding:0">
      <li>Bullets: <b>${bullets}</b> (aim ~5–7 for recent roles)</li>
      <li>Metrics used: <b>${numbersUsed}</b> (target 3–5+ quantified wins)</li>
      <li>Passive phrases: <b>${passiveHits}</b> (reduce with action verbs: Built, Automated, Reduced)</li>
      <li>ALL-CAPS words: <b>${capsWords}</b> (use sparingly)</li>
      <li>Very long lines: <b>${longLines}</b> (keep bullets &lt;~160 chars)</li>
      <li>Word count: <b>${wordCount}</b> (sweet spot ≈ 400–700 for a one-pager)</li>
      <li>Exclamation marks: <b>${exclam}</b> (avoid)</li>
    </ul>
    <div><b>What “good” means:</b> 28–35 = polished; 20–27 = decent; &lt;20 = distracting issues present.</div>
  `);

  const tipSTRUCT = tipHTML(`
    <div style="font-weight:800;margin-bottom:6px">Structure (0–15)</div>
    <div style="margin-bottom:6px">
      Checks for core sections so humans (and ATS) can find the basics fast: experience, education, skills,
      projects, certifications, summary, contact, awards.
    </div>
    <div style="margin-bottom:6px"><b>Present:</b> ${presentSections.length ? presentSections.join(', ') : '—'}</div>
    <div style="margin-bottom:6px"><b>Missing:</b> ${missingSections.length ? `<i>${missingSections.join(', ')}</i>` : 'None — great!'}</div>
    <div><b>What “good” means:</b> 12–15 = complete; 8–11 = partial; &lt;8 = key sections likely missing.</div>
  `);

  const tipREAD = tipHTML(`
    <div style="font-weight:800;margin-bottom:6px">Readability (0–10)</div>
    <div style="margin-bottom:6px">
      Based on Flesch Reading Ease and layout cues. Short, clear sentences and one idea per bullet help both humans and ATS.
    </div>
    <div style="margin-bottom:6px"><b>Score:</b> Flesch <b>${fre}</b> → <b>${readScore10}/10</b> (<i>${readLabel}</i>).</div>
    <div><b>What “good” means:</b> 8–10 = very easy to skim; 6–7 = plain & readable; 5 = somewhat dense; &lt;5 = hard to read.</div>
  `);

  const breakdown = [
    { label:'ATS',            val:result.breakdown.ats_keywords, max:40, short:'ATS' },
    { label:'Professionalism',val:result.breakdown.professionalism, max:35, short:'Prof.' },
    { label:'Structure',      val:result.breakdown.structure, max:15, short:'Struct.' },
    { label:'Readability',    val:result.breakdown.readability, max:10, short:'Read.' },
  ];

  const bhtml = breakdown.map(d=>{
    const band = kpiBand(d.val, d.max);
    const pctW = Math.round((d.val / d.max) * 100);
    const tipMap = { 'ATS':tipATS, 'Professionalism':tipPRO, 'Structure':tipSTRUCT, 'Readability':tipREAD };
    return `
      <div class="kpi ${band}" data-pct="${pctW}">
        <div class="kpi-row">
          <span class="kpi-label">
            <span class="kpi-dot"></span>
            <span class="kpi-text" data-short="${d.short}">${d.label}</span>
            ${tipMap[d.label]}
          </span>
          <b>${d.val}/${d.max}</b>
        </div>
        <div class="bar"><div class="bar-fill" style="width:${pctW}%"></div></div>
      </div>`;
  }).join('');

  const sectionPills = Object.entries(result.sectionPresence)
    .map(([name,isOn])=>`<span class="pill ${isOn?'good':'bad'}">${name}</span>`).join('');

  const fixes = friendlyFixes(result, fre).join('') 
    || '<li><div class="fix-row"><span class="pill p-low">Nice!</span><span class="fix-title">You’re in solid shape</span></div><p class="fix-body">Tailor a couple bullets to the job post.</p></li>';

  const ghost = analyzeGhostJob(jd, resume);
  const ghostHTML = jobRealitySectionHTML(ghost);

  const summaryHTML = generateOverallSummary(result, fre, ghost, resume, jd);

  if (out) {
    out.innerHTML = `
      <div>
        <div class="results-head">
          <div class="score-block">
            ${donutSVG(result.total, `${result.total}`)}
            <div>
              <h2 class="card-title" style="margin:0;display:flex;align-items:center;gap:6px">Overall Score ${tipOverall}</h2>
              <div class="rating">${classifyScore(result.total)}</div>
            </div>
          </div>
          <span class="pill">${
            gate.mode==='free' ? 'Free scan used'
            : gate.mode==='credit' ? '1 paid credit used'
            : 'Unlimited (temp)'
          }</span>
        </div>

        <div class="kpi-grid">${bhtml}</div>

        <h3 class="card-title" style="margin:14px 0 6px">Structure Checklist</h3>
        <div class="section-pills">${sectionPills}</div>

        <h3 class="card-title" style="margin:14px 0 6px">Extracted from Job Description</h3>
        <div>${result.extractedKeywords.map(k=>`<span class='pill good'>${k}</span>`).join('')}</div>

        <h3 class="card-title" style="margin:14px 0 6px">Matched Keywords</h3>
        <div>${present.map(k=>`<span class='pill good'>${k}</span>`).join('') || '<span class="pill bad">No matches yet</span>'}</div>

        <h3 class="card-title" style="margin:14px 0 6px">Missing Keywords</h3>
        <div>${missing.map(k=>`<span class='pill bad'>${k}</span>`).join('') || '<span class="pill good">No gaps detected</span>'}</div>

        <div class="metrics">
          <div class="metric"><b>${present.length}</b> matched</div>
          <div class="metric"><b>${missing.length}</b> missing</div>
          <div class="metric"><b>${covPct}%</b> coverage</div>
        </div>

        <h3 class="card-title" style="margin:14px 0 6px">Readability & Tone</h3>
        <p class="helper" style="margin:0 0 8px">
          ${gradeReadability(result.breakdown.readability)}. Bullets: <b>${result.profDetails.bullets}</b>,
          metrics used: <b>${result.profDetails.numbers}</b>, passive uses: <b>${result.profDetails.passive}</b>.
        </p>

        <h3 class="card-title" style="margin:14px 0 6px">Top Fixes</h3>
        <ul class="list-tight">${fixes}</ul>

        ${ghostHTML}

        <h3 class="card-title" style="margin:16px 0 8px">Overall Summary</h3>
        ${summaryHTML}
      </div>`;
  }

  const ratingEl = out?.querySelector('.results-head .rating');
  if (ratingEl){
    ratingEl.classList.remove('good','warn','bad');
    ratingEl.classList.add(scoreBand(result.total));
  }

  // Similar jobs (best-effort; safe if JOBS_API not set)
  (async () => {
    const jdText = jd || "";
    const kw = keywords || [];
    const q = buildJobsQuery({ jd: jdText, keywords: kw });
    const whereGuess = guessLocationFromText(jdText);
    const jobs = await fetchSimilarJobs({ q, where: whereGuess, limit: 12 });
    renderSimilarJobs(jobs);
  })();
}

/* ==================== Upload handling ==================== */
const fileInput = document.getElementById('resumeFile');
const fileLabel = document.getElementById('fileLabel');
const dropzone  = document.getElementById('dropzone');
const scanSpinner = document.getElementById('scanSpinner');
const scanText = document.getElementById('scanText');

(() => {
  const btnPick = document.getElementById('btnPick');
  if (btnPick) btnPick.addEventListener('click', ()=> fileInput && fileInput.click());

  if (fileInput) {
    fileInput.addEventListener('change', e => { if (e.target.files?.[0]) handleResumeFile(e.target.files[0]); });
  }
  if (dropzone) {
    ['dragenter','dragover'].forEach(ev=> dropzone.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.add('drag'); }));
    ['dragleave','drop'].forEach(ev=> dropzone.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.remove('drag'); }));
    dropzone.addEventListener('drop', e=>{ const f = e.dataTransfer?.files?.[0]; if (f) handleResumeFile(f); });
  }
})();

function setScanStatus(msg, spinning=false){
  const led = document.getElementById('statusLed');
  const spin = document.getElementById('scanSpinner');
  const txt  = document.getElementById('scanText');
  const m = String(msg||'').toLowerCase();
  if (led) led.classList.remove('ready','scanning','done','error');
  if (spinning){ led?.classList.add('scanning'); spin?.classList.add('show'); }
  else {
    spin?.classList.remove('show');
    if (/(error|unsupported|fail)/.test(m)) led?.classList.add('error');
    else if (/(extracted|success|done|✓|scored)/.test(m)) led?.classList.add('done');
    else led?.classList.add('ready');
  }
  if (txt) txt.textContent = msg;
}

async function handleResumeFile(file){
  if (fileLabel) fileLabel.textContent = file.name;
  setScanStatus('Scanning...', true);
  try{
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let text = '';
    if (ext === 'pdf'){ text = await extractTextFromPDF(file); }
    else if (ext === 'docx'){ text = await extractTextFromDOCX(file); }
    else if (ext === 'txt'){ text = await file.text(); }
    else if (ext === 'rtf'){
      const raw = await file.text();
      text = raw.replace(/\\'[0-9a-fA-F]{2}/g,' ').replace(/\\[a-z]+\d*/g,' ').replace(/[{}]/g,' ').replace(/\\par/g,'\n');
    } else { setScanStatus('Unsupported file type. Use PDF, DOCX, or TXT.', false); return; }
    text = (text||'').trim();
    const resumeEl = document.getElementById('resume');
    if (text.length < 20){
      setScanStatus('Could not extract much text — is it a scanned image PDF?', false);
      if (resumeEl) resumeEl.value = text; 
      return;
    }
    if (resumeEl) resumeEl.value = text;
    setScanStatus('Text extracted ✓', false);
    analyze();
  } catch(err){
    console.error(err);
    setScanStatus('Error reading file. Try another format.', false);
  }
}

async function extractTextFromPDF(file){
  if (!window.pdfjsLib) throw new Error('PDF.js not loaded');
  const buf = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({data: buf});
  const pdf = await loadingTask.promise;
  let fullText = '';
  for (let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const strings = content.items.map(it => ('str' in it ? it.str : it?.toString()) || '');
    fullText += strings.join(' ') + '\n';
  }
  return fullText.replace(/\s+\n/g,'\n').replace(/\n{3,}/g,'\n\n');
}

async function extractTextFromDOCX(file){
  if (!window.mammoth) throw new Error('Mammoth not loaded');
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({arrayBuffer});
  return (result.value || '').replace(/\r/g,'').trim();
}

/* ==================== Paywall & misc (with iPhone focus trap) ==================== */
function openPaywall(n=1){
  hideMobileHintIfOpen();
  window.__desiredCredits = n;
  const modal = document.getElementById('paywall');
  if (!modal) return;
  modal.classList.add('open');
  document.body.classList.add('modal-open');
  modalLastFocus = document.activeElement;
  trapFocus(modal);
}
function closePaywall(){
  const modal = document.getElementById('paywall');
  if (!modal) return;
  modal.classList.remove('open');
  document.body.classList.remove('modal-open');
  if (modal.__untrap) modal.__untrap();
  if (modalLastFocus) { try { modalLastFocus.focus(); } catch {} }
  modalLastFocus = null;
}

/* ==================== Checkout flow ==================== */
/* ==================== Checkout flow ==================== */
async function startCheckout(n = 1){
  if (!stripe) {
    alert('Payment library not loaded yet. Please retry.');
    return;
  }
  const priceId = PRICE_IDS[n];
  if (!priceId){
    alert('Unknown product');
    return;
  }

  // Close paywall, open checkout in "loading" state
  closePaywall();
  openCheckout();

  const payBtn = document.getElementById('pay-now');
  const msg    = document.getElementById('checkout-msg');

  if (payBtn) payBtn.disabled = true;
  if (msg) msg.textContent = 'Preparing secure checkout…';

  let data;
  try {
    const res = await fetch(`${API_BASE_URL}/create-payment-intent`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        priceId,
        quantity: 1,
        token: CREDIT_TOKEN,
        credits: n
      })
    });

    // Try to parse JSON but don't crash if it fails
    data = await res.json().catch(() => ({}));

    if (!res.ok || !data.client_secret){
      const errText = data && data.error ? data.error : 'Error creating payment intent.';
      console.error('Create payment intent failed', res.status, errText);
      if (msg) {
        msg.textContent =
          'Checkout error: ' +
          errText +
          ' (If you are testing locally, this may be a CORS issue on the server.)';
      }
      if (payBtn) payBtn.disabled = false;
      return;
    }
  } catch (err) {
    console.error('Network/CORS error creating payment intent', err);
    if (msg) {
      msg.textContent =
        'Could not reach the payment server. If you are on 127.0.0.1 / localhost, update the API CORS to allow this origin.';
    }
    if (payBtn) payBtn.disabled = false;
    return;
  }

  clientSecret = data.client_secret;

  // Reset any previous Stripe Element
  try { if (paymentElement) paymentElement.unmount(); } catch (_) {}
  paymentElement = null;
  elements = null;

  elements = stripe.elements({
    clientSecret,
    appearance: {
      theme: 'night',
      variables: {
        colorPrimary: '#b2ff92',
        colorPrimaryText: '#0b1020',
        colorBackground: '#0d1422',
        colorText: '#f7f9ff',
        colorTextSecondary: '#aeb7c6',
        colorDanger: '#ef4444',
        fontFamily: "'Inter', system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
        borderRadius: '16px'
      },
      rules: {
        '.Input': {
          backgroundColor: '#0b1220',
          border: '1px solid rgba(168,179,197,.18)',
          color: '#f7f9ff'
        },
        '.Input:focus': {
          borderColor: '#21c7b7',
          boxShadow: '0 0 0 3px rgba(33,199,183,.22)'
        }
      }
    }
  });

  paymentElement = elements.create('payment');
  paymentElement.mount('#payment-element');

  // Ready for user to pay
  if (msg) msg.textContent = '';
  if (payBtn) payBtn.disabled = false;
  if (!payBtn || !msg) return;

  let paying = false;
  payBtn.onclick = async () => {
    if (paying) return;
    paying = true;
    payBtn.disabled = true;
    msg.textContent = 'Processing…';

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: window.location.origin + '/success.html' },
      redirect: 'if_required'
    });

    if (error){
      msg.textContent = error.message || 'Payment failed.';
      payBtn.disabled = false;
      paying = false;
      return;
    }

    msg.textContent = 'Payment succeeded!';
    const granted = await claimCredits();
    if (!granted) setTimeout(() => claimCredits(), 1500);

    setTimeout(() => {
      paying = false;
      closeCheckout();
    }, 1200);
  };
}


/* ==================== Credit claim ==================== */
async function claimCredits({ retries = 6, delay = 400 } = {}) {
  const url = `${API_BASE_URL}/credits?token=${encodeURIComponent(CREDIT_TOKEN)}`;

  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) {
        const { credits = 0 } = await r.json();
        if (credits > 0) {
          if (typeof addCredits === 'function') addCredits(credits);
          if (typeof renderCreditBadges === 'function') renderCreditBadges();
          if (typeof updateCreditUI === 'function') updateCreditUI();
          return credits;
        }
      }
    } catch {}
    await new Promise(res => setTimeout(res, delay));
    delay = Math.min(delay * 1.6, 3000);
  }
  return 0;
}

function addCredits(n){ writeMeter({creditAdd:n}); }
function clearAll(){
  const resume = document.getElementById('resume');
  const jd = document.getElementById('jd');
  const keywords = document.getElementById('keywords');
  const out = document.getElementById('results');

  if (resume) resume.value='';
  if (jd) jd.value='';
  if (keywords) keywords.value='';
  if (out) {
    out.innerHTML = `
    <div style="text-align:center;color:var(--muted)">
      <div style="width:44px;height:44px;border-radius:9999px;margin:8px auto;background:linear-gradient(135deg,#ffd34d,#f26e8c)"></div>
      <h3 style="margin:6px 0 4px;color:var(--text)">Ready to score your resume</h3>
      <div class="helper">Paste your resume and click <b>Analyze</b>.</div>
    </div>`;
  }
  if (fileInput) fileInput.value = '';
  if (fileLabel) fileLabel.textContent = 'Choose PDF, DOCX, or TXT';
  setScanStatus('Ready', false);
}

/* =================== SIMILAR LIVE JOBS FEATURE =================== */
const JOBS_API = "https://YOUR_API_GATEWAY_DOMAIN/jobs"; // <- TODO: set this

function guessJobTitleFromText(t) {
  const clean = (t||"").split(/\n+/).slice(0, 20).join(" ");
  const titleRx = /\b(?:(?:Data|Business|Product|Software|Marketing|Operations|Financial)\s+)?(?:Analyst|Engineer|Manager|Scientist|Developer|Specialist|Associate)\b/gi;
  const m = clean.match(titleRx);
  return m ? m[0].replace(/\s+/g, " ").trim() : "";
}
function guessLocationFromText(t) {
  if (!t) return "";
  const remote = t.match(/\b(remote|hybrid|on[-\s]?site)\b/i);
  const citySt = t.match(/\b([A-Z][a-zA-Z .'-]+,\s*[A-Z]{2})\b/);
  return (citySt && citySt[1]) || (remote && remote[1]) || "";
}
function buildJobsQuery({ jd, keywords }) {
  const title = guessJobTitleFromText(jd) || "Data Analyst";
  const key   = (keywords || []).slice(0, 4).join(" ");
  return [title, key].filter(Boolean).join(" ").trim();
}
function escapeHTML(s){ return String(s||"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }

async function fetchSimilarJobs({ q, where, limit = 12 }) {
  if (!JOBS_API || JOBS_API.includes("YOUR_API_GATEWAY_DOMAIN")) {
    console.warn("Set JOBS_API to your deployed jobs proxy URL.");
    return [];
  }
  const url = new URL(JOBS_API);
  url.searchParams.set("q", q || "");
  if (where) url.searchParams.set("where", where);
  url.searchParams.set("limit", String(limit));

  try {
    const r = await fetch(url.toString(), { cache: "no-store" });
    if (!r.ok) throw new Error(`Jobs API ${r.status}`);
    const data = await r.json();
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch (e) {
    console.warn("Jobs fetch failed:", e);
    return [];
  }
}

function renderSimilarJobs(jobs = []) {
  const sec = document.getElementById("similar-jobs");
  const grid = document.getElementById("jobsGrid");
  if (!sec || !grid) return;

  if (!jobs.length) {
    grid.innerHTML = `<div class="helper">No matching live jobs found right now. Try refining the job description or keywords.</div>`;
    sec.hidden = false;
    return;
  }

  const html = jobs.map(j => {
    const d = (j.desc || "").replace(/\s+/g," ").trim();
    const snippet = d.length > 220 ? d.slice(0, 220) + "…" : d;
    const when = j.created ? new Date(j.created).toLocaleDateString() : "";
    return `
      <article class="job-card">
        <div class="job-head">
          <h4 class="job-title">${escapeHTML(j.title || "Untitled role")}</h4>
          <div class="job-meta">
            ${j.company ? `<span class="badge-mini">${escapeHTML(j.company)}</span>` : ""}
            ${j.location ? `<span class="badge-mini">${escapeHTML(j.location)}</span>` : ""}
            ${when ? `<span class="badge-mini">Posted ${when}</span>` : ""}
          </div>
        </div>
        <p class="job-line">${escapeHTML(snippet)}</p>
        <div class="job-footer"> 
          <a class="job-btn brand" href="${j.url}" target="_blank" rel="noopener">View posting</a>
          <div class="job-aux">
            <span class="chip mini ok">Live</span>
          </div>
        </div>
      </article>`;
  }).join("");

  grid.innerHTML = html;
  sec.hidden = false;
}
/* ================= END SIMILAR LIVE JOBS FEATURE ================= */

updateMeterUI();
updatePricingUI();
setScanStatus('Ready', false);
document.addEventListener('DOMContentLoaded', () => { claimCredits(); });

/* ==================== Mobile "Use desktop" hint (8s delay) ==================== */
(function mobileHint(){
  const LS_KEY = 'rezzy_mobile_hint_v1';
  const HINT_DELAY_MS = 8000; // open after 8 seconds
  let hintTimer = null;
  let shownThisSession = false;

  const isSmallScreen = () => window.matchMedia('(max-width: 760px)').matches;
  const alreadyDismissed = () => {
    try { return localStorage.getItem(LS_KEY) === '1'; } catch { return false; }
  };

  function openHint(){
    const el = document.getElementById('mobile-hint');
    if (!el) return;
    clearTimeout(hintTimer); hintTimer = null;
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    shownThisSession = true;
  }

  function scheduleHint(){
    if (hintTimer || shownThisSession || alreadyDismissed() || !isSmallScreen()) return;
    hintTimer = setTimeout(openHint, HINT_DELAY_MS);
  }

  function cancelHint(){
    clearTimeout(hintTimer);
    hintTimer = null;
  }

  function closeHint({ persist = false } = {}){
    const el = document.getElementById('mobile-hint');
    if (!el) return;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    cancelHint();
    if (persist){
      try { localStorage.setItem(LS_KEY, '1'); } catch {}
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const ok = document.getElementById('mf-ok');
    const dismiss = document.getElementById('mf-dismiss');
    if (ok) ok.addEventListener('click', () => closeHint());
    if (dismiss) dismiss.addEventListener('click', () => closeHint({ persist: true }));

    // initial schedule with 8s delay if conditions are met
    scheduleHint();
  });

  // if they rotate/resize into mobile, respect the same 8s delay (once per session)
  let resizeDebounce;
  window.addEventListener('resize', () => {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      if (!isSmallScreen()) {
        cancelHint(); // cancel pending if they left mobile
        return;
      }
      if (!shownThisSession && !alreadyDismissed()) {
        scheduleHint();
      }
    }, 200);
  });
})();

/* ==================== Mobile tap fixes + iOS scroll lock ==================== */
(function mobilePurchaseFixes(){
  const IS_IOS =
    /iP(ad|hone|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // 1) Make all [data-buy] buttons safely start purchase flow
  function bindBuyButtons(){
    const btns = document.querySelectorAll('[data-buy]');
    btns.forEach(btn => {
      if (btn.__buyBound) return;
      btn.__buyBound = true;

      const credits = parseInt(btn.getAttribute('data-buy'), 10) || 1;

      const handler = (e) => {
        // prevent anchor jumps or default submits
        e.preventDefault();
        if (btn.__buyBusy) return;
        btn.__buyBusy = true;

        const insidePaywall = !!btn.closest('#paywall');

        Promise.resolve()
          .then(() => {
            // Outside paywall: open the paywall sheet first
            if (!insidePaywall) {
              openPaywall(credits);
            } else {
              // Inside paywall: go straight to Stripe checkout
              return startCheckout(credits);
            }
          })
          .catch(console.error)
          .finally(() => {
            setTimeout(() => { btn.__buyBusy = false; }, 400);
          });
      };

      // simple + reliable: click only
      btn.addEventListener('click', handler);
    });
  }

  // Ensure every relevant button is type="button" to avoid form submits
  function normalizeButtonTypes(){
    document.querySelectorAll('#paywall button, #checkout-modal button, [data-buy]')
      .forEach(b => { if (!b.getAttribute('type')) b.setAttribute('type','button'); });
  }

  // Strong scroll lock for iOS so fixed/sticky footers remain tappable
  let savedScrollY = 0;
  const orig = { position:'', top:'', width:'', left:'' };

  function lockScroll(){
    if (!IS_IOS || document.body.__locked) return;
    savedScrollY = window.scrollY || document.documentElement.scrollTop || 0;

    orig.position = document.body.style.position;
    orig.top      = document.body.style.top;
    orig.width    = document.body.style.width;
    orig.left     = document.body.style.left;

    document.body.style.position = 'fixed';
    document.body.style.top      = `-${savedScrollY}px`;
    document.body.style.left     = '0';
    document.body.style.width    = '100%';
    document.body.__locked = true;
  }

  function unlockScroll(){
    if (!IS_IOS || !document.body.__locked) return;

    document.body.style.position = orig.position;
    document.body.style.top      = orig.top;
    document.body.style.left     = orig.left;
    document.body.style.width    = orig.width;
    document.body.__locked = false;

    window.scrollTo(0, savedScrollY || 0);
  }

  // Safely wrap existing open/close functions
  const baseOpenPaywall   = window.openPaywall   || function(){};
  const baseClosePaywall  = window.closePaywall  || function(){};
  const baseOpenCheckout  = window.openCheckout  || function(){};
  const baseCloseCheckout = window.closeCheckout || function(){};

  window.openPaywall = function(n = 1){
    lockScroll();
    try { baseOpenPaywall(n); } catch (e) { console.error(e); }
  };

  window.closePaywall = function(){
    try { baseClosePaywall(); } catch (e) { console.error(e); }
    unlockScroll();
  };

  window.openCheckout = function(){
    lockScroll();
    try { baseOpenCheckout(); } catch (e) { console.error(e); }
  };

  window.closeCheckout = function(){
    try { baseCloseCheckout(); } catch (e) { console.error(e); }
    unlockScroll();
  };

  document.addEventListener('DOMContentLoaded', () => {
    normalizeButtonTypes();
    bindBuyButtons();
  });

  // Rebind helper if UI dynamically re-renders buttons
  window.__rezzyBindBuyButtons = bindBuyButtons;
})();
