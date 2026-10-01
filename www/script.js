// === Payments: Stripe Payment Links (no backend needed) ===
// Rezzy Rate Stripe account acct_1UJfqSDWfERCS4K5. Each link sends the buyer back to
// https://rezzyrate.com/?paid=N&session_id=cs_... and the site adds N scans once per session.
const PAYMENT_LINKS = {
  3:  "https://buy.stripe.com/cNi4gzg8VdKE6nkg4xdnW03",   // 3 Scans  $4.99
  15: "https://buy.stripe.com/5kQ14n6yl8qk9zwbOhdnW04",   // 15 Scans $12.99
  25: "https://buy.stripe.com/9B63cv2i57mg7ro7y1dnW05"    // 25 Scans $17.99
};
// Old packs (1/10/20). Still honored on return so anyone mid-checkout during the
// switch gets their scans. Safe to remove once the old links are deactivated in Stripe.
const LEGACY_PAID = [1, 10, 20];
const CANONICAL_HOST = "rezzyrate.com";
// Only used for the job-search backend now
const API_BASE_URL = "https://gyw1n7b24m.execute-api.us-east-2.amazonaws.com/Prod";

console.log("Version: 3");

/* ==================== One site address ====================
   Credits live in browser storage, which is separate for www.rezzyrate.com and
   rezzyrate.com. Payment Links return to rezzyrate.com, so send www visitors
   there too (and bring any credits they already have). */
(function canonicalHost(){
  if (location.hostname !== 'www.' + CANONICAL_HOST) return;
  let carry = 0;
  try {
    carry = parseInt(localStorage.getItem('rc_credits') || '0', 10) || 0;
    if (carry > 0) localStorage.setItem('rc_credits', '0');
  } catch {}
  const url = new URL(location.href);
  url.hostname = CANONICAL_HOST;
  if (carry > 0) url.searchParams.set('carry', String(carry));
  location.replace(url.toString());
})();

/* ==================== UTIL: persistent credit token ==================== */
function getOrCreateToken(){
  const k = 'credit_token_v1';
  let t = null;
  try { t = localStorage.getItem(k); } catch {}
  if (!t){
    t = (globalThis.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Date.now()) + Math.random().toString(16).slice(2);
    try { localStorage.setItem(k, t); } catch {}
  }
  return t;
}
const CREDIT_TOKEN = getOrCreateToken();

let stripe, elements, paymentElement, clientSecret;

document.addEventListener('DOMContentLoaded', () => {
  if (typeof updatePricingUI === 'function') updatePricingUI();
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
const PRICES = { pack3: 4.99, pack15: 12.99, pack25: 17.99 };
const fmt = n => `$${n.toFixed(2)}`;

/* --- NEW: transaction cost / total helpers --- */
const PRICE_MAP = {
  3: PRICES.pack3,
  15: PRICES.pack15,
  25: PRICES.pack25
};

// Adjust these if you want different fee assumptions
const FEE_RATE  = 0.029; // 2.9%
const FEE_FIXED = 0.30;  // $0.30 per transaction

function calcTotalsForCredits(n) {
  const base = PRICE_MAP[n] || 0;
  const fee  = base * FEE_RATE + FEE_FIXED;
  const total = base + fee;
  return { base, fee, total };
}

function updateCheckoutSummary(n) {
  const el = document.getElementById('checkout-summary');
  if (!el) return;

  const { base, fee, total } = calcTotalsForCredits(n);
  if (!base) {
    el.textContent = '';
    return;
  }

  el.innerHTML = `
    You’re buying <b>${n}</b> ${n === 1 ? 'scan' : 'scans'} for <b>${fmt(base)}</b>.<br>
    
  `;
}
/* --- END NEW HELPERS --- */

function updatePricingUI(){
  const p3 = fmt(PRICES.pack3), p15 = fmt(PRICES.pack15), p25 = fmt(PRICES.pack25);
  const lead = document.getElementById('paywallLeadText');
  if (lead) lead.innerHTML = `You used your free daily scan. Get 3 more scans for <strong>${p3}</strong> or save with a bigger pack.`;
  const setBtn = (id, qty, price) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<span class="btn-label">${qty} ${qty===1?'Scan':'Scans'}</span><span class="btn-price">${price}</span>`;
  };
  setBtn('btnBuy3Top', 3,  p3); setBtn('btnBuy15Top',15, p15); setBtn('btnBuy25Top',25, p25);
  setBtn('btnBuy3Modal', 3,  p3); setBtn('btnBuy15Modal',15, p15); setBtn('btnBuy25Modal',25, p25);
}

/* ==================== METERING & PAYWALL ==================== */
const LS_KEYS = { lastDate:'rc_lastDate', dailyUsed:'rc_dailyUsed', credits:'rc_credits', unlimitedUntil:'rc_unlimited_until' };
(function handleUnlimitedFlag(){
  const params = new URLSearchParams(location.search);
  const hours = 48;
  const isDev = /^(localhost|127\.0\.0\.1|)$/.test(location.hostname);
  if (!isDev) return;   // ?unlimited=1 used to work on the live site, so anyone could skip paying
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
  if (creditBadge) creditBadge.textContent = `${credits} credit${credits === 1 ? '' : 's'}`;
  if (freeBadge) freeBadge.textContent = isUnlimited() ? 'Test mode: unlimited' : (freeLeft ? `${freeLeft} free scan today` : 'Free scan used');
  const note = document.getElementById('scanNote');
  if (note) note.textContent = isUnlimited() ? 'Test mode: scans are unlimited'
    : freeLeft ? 'Uses your free scan for today'
    : credits ? `Uses 1 of your ${credits} credit${credits === 1 ? '' : 's'}`
    : 'Free scan used today. Buy scans to continue';
  try { renderJobsAccess(); } catch {}
}

/* ==================== Jobs access (paid feature) ====================
   Matching jobs are part of the paid report. Access is open when the visitor has
   credits, is in test mode, or ran a paid scan in the last 24 hours (so spending
   their last credit doesn't immediately lock the jobs for that report). */
const JOBS_PASS_KEY = 'rz_jobs_pass_until';
const JOBS_PASS_MS  = 24 * 60 * 60 * 1000;
function grantJobsPass(){
  try { localStorage.setItem(JOBS_PASS_KEY, String(Date.now() + JOBS_PASS_MS)); } catch {}
}
function hasJobsAccess(){
  if (isUnlimited()) return true;
  try { if (Date.now() < parseInt(localStorage.getItem(JOBS_PASS_KEY) || '0', 10)) return true; } catch {}
  return readMeter().credits > 0;
}
function renderJobsAccess(){
  const card = document.getElementById('similar-jobs');
  const grid = document.getElementById('jobsGrid');
  if (!card || !grid) return;
  const open = hasJobsAccess();
  card.classList.toggle('is-locked', !open);

  const badge = document.getElementById('jobsBadge');
  if (badge){
    badge.className = open ? 'badge badge-free' : 'lock-tag';
    badge.innerHTML = open ? 'Included' : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>Full report';
  }
  const btn = document.getElementById('btnFindJobs');
  if (btn) btn.textContent = open ? 'Find jobs' : 'Unlock jobs';

  if (!open){
    if (grid.querySelector('.jobs-locked')) return;
    const skills = document.getElementById('jobSkills'); if (skills) skills.innerHTML = '';
    const meta = document.getElementById('jobsMeta'); if (meta) meta.textContent = '';
    grid.innerHTML = `
      <div class="jobs-locked">
        <div class="jobs-locked-preview" aria-hidden="true">${'<div class="job-card skeleton"><i></i><i></i><i></i></div>'.repeat(3)}</div>
        <div class="locked-cta">
          <p><b>See live jobs that fit your resume.</b><br>Included with every paid scan. Search as much as you like for 24 hours after your scan.</p>
          <button type="button" class="btn btn-primary btn-sm" data-buy="3">Unlock matching jobs</button>
        </div>
      </div>`;
    if (typeof window.__rezzyBindBuyButtons === 'function') window.__rezzyBindBuyButtons();
  } else if (grid.querySelector('.jobs-locked')) {
    grid.innerHTML = '<div class="jobs-empty"><b>Find roles that fit your resume.</b><span>We’ll read your title, skills and location, then pull live postings.</span></div>';
  }
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
// Generic words that show up in every job post and aren't real skills
const JD_FILLER = new Set(["seek","seeking","looking","build","building","create","creating","experience","experienced","required","requirements","require","preferred","ability","able","strong","excellent","work","working","team","teams","role","position","candidate","candidates","job","company","including","include","responsible","responsibilities","must","will","who","our","plus","years","year","skills","skill","knowledge","using","use","other","such","well","within","across","help","support","ensure","new","make","based","etc","about","have","has","not","can","all","any","into","more","also","what","when","where","which","while","join","opportunity","apply","please","day","days","per","level","high"]);
const extractKeywords = (t,n=15)=> [...wordFreq(t).entries()].filter(([w])=>!JD_FILLER.has(w)).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([w])=>w);
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
    addTip('med','Use active verbs',`I noticed ${result.profDetails.passive} passive phrases. Swap “was built / were automated” for “Built,” “Automated,” “Forecasted.”`);
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
  return pct >= 70 ? 'good' : pct >= 55 ? 'warn' : 'bad';   // matches classifyScore (70+ = Strong)
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
        <circle cx="36" cy="36" r="${r}" fill="none" stroke="var(--line)" stroke-width="8"></circle>
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

/* ==================== Premium lock overlay helper ==================== */
function premiumOverlayHTML(message){
  return `
    <div class="lock-overlay">
      <div class="lock-overlay-inner"
           style="display:flex;flex-direction:column;align-items:center;text-align:center;">

        <div aria-hidden="true"
             style="width:58px;height:58px;margin:2px auto 14px;opacity:.65;">
          <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none"
               stroke="rgba(255,255,255,0.85)" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M7 10V7.5A5 5 0 0 1 12 3a5 5 0 0 1 5 4.5V10" />
            <rect x="4" y="10" width="16" height="11" rx="2.5" />
            <circle cx="12" cy="16" r="1.7" />
          </svg>
        </div>

        <p style="max-width:25rem;margin:0 auto 1rem;font-size:.86rem;line-height:1.55;
                  color:rgba(235,240,255,.92);font-weight:400;">
          ${message}
        </p>

        <button type="button" class="btn brand" data-buy="1"
                style="padding:.22rem .7rem;font-size:.68rem;border-radius:10px;background:var(--accent);">
          Unlock
        </button>

      </div>
    </div>
  `;
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

  // mark whether we just used the free scan or a paid/ unlimited one
  consumeScan(gate.mode);
  if (gate.mode !== 'free') grantJobsPass();   // paid scans include matching jobs
  const lockAdvanced = (gate.mode === 'free' && !isUnlimited());
  window.__rezzyLastScanWasFree = lockAdvanced;

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
    .map(([name,isOn])=>`<span class="pill ${isOn?'good':'bad'}">${isOn?'✓':'✕'} ${name}</span>`).join('');

  const fixList = friendlyFixes(result, fre);
  const fixes = fixList.join('')
    || '<li><div class="fix-row"><span class="pill p-low">Nice!</span><span class="fix-title">You’re in solid shape</span></div><p class="fix-body">Tailor a couple bullets to the job post.</p></li>';

  const ghost = analyzeGhostJob(jd, resume);
  const ghostHTML = jobRealitySectionHTML(ghost);
  const summaryHTML = generateOverallSummary(result, fre, ghost, resume, jd);

  const band = scoreBand(result.total);
  const verdict = {
    'Excellent':  'Ready to send. Tailor a few bullets to each job and you’re set.',
    'Strong':     'Solid resume. A few targeted fixes will push it into the top tier.',
    'Fair':       'Decent foundation, but gaps could cost you interviews. Start with the fixes below.',
    'Needs work': 'Needs work before you apply. Start with the top fixes below.'
  }[classifyScore(result.total)];

  // Free scans get a teaser. Paid content is NOT rendered into the page at all
  // (previously it was only blurred, so anyone could read it in dev tools).
  const lockedSection = (key, title, teaser, skeletonKind = 'lines') => `
    <section class="rsec locked" data-section="${key}">
      <header class="rsec-head">
        <h3>${title}</h3>
        <span class="lock-tag"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>Full report</span>
      </header>
      <div class="rsec-body">
        <div class="locked-preview ${skeletonKind}" aria-hidden="true">${skeletonKind === 'pills' ? '<i></i>'.repeat(9) : '<i></i><i></i><i></i>'}</div>
        <div class="locked-cta">
          <p>${teaser}</p>
          <button type="button" class="btn btn-primary btn-sm" data-buy="3">Unlock full report</button>
        </div>
      </div>
    </section>`;

  const section = (key, title, meta, body) => `
    <section class="rsec" data-section="${key}">
      <header class="rsec-head"><h3>${title}</h3>${meta ? `<span class="rsec-meta">${meta}</span>` : ''}</header>
      <div class="rsec-body">${body}</div>
    </section>`;

  const ACRO = new Set(['sql','etl','aws','gcp','api','apis','bi','crm','erp','kpi','kpis','seo','sem','ui','ux','qa','hr','it','ai','ml','sap','css','html','php','saas','b2b','b2c','cpa','pmp','gaap','vba','sas']);
  const kw = k => escapeHTML(ACRO.has(String(k).toLowerCase()) ? String(k).toUpperCase() : String(k).charAt(0).toUpperCase() + String(k).slice(1));
  const kwTotal = present.length + missing.length;
  const keywordsBody = `
    <div class="kw-summary">
      <div class="metric"><b>${present.length}</b><span>matched</span></div>
      <div class="metric"><b>${missing.length}</b><span>missing</span></div>
      <div class="metric"><b>${covPct}%</b><span>coverage</span></div>
    </div>
    <h4 class="sub-h">Missing, so add these if they apply to you</h4>
    <div class="pill-wrap">${missing.map(k=>`<span class="pill bad">${kw(k)}</span>`).join('') || '<span class="pill good">No gaps detected</span>'}</div>
    <h4 class="sub-h">Already on your resume</h4>
    <div class="pill-wrap">${present.map(k=>`<span class="pill good">${kw(k)}</span>`).join('') || '<span class="muted">No matches yet</span>'}</div>
    ${result.extractedKeywords.length ? `<details class="more"><summary>All keywords we pulled from the job post</summary><div class="pill-wrap">${result.extractedKeywords.map(k=>`<span class="pill">${kw(k)}</span>`).join('')}</div></details>` : ''}`;

  const readLine = `<p class="muted small" style="margin:0 0 10px">${gradeReadability(result.breakdown.readability)} · ${bullets} bullets · ${numbersUsed} metrics · ${passiveHits} passive phrases</p>`;

  let sectionsHTML = '';
  if (lockAdvanced) {
    const hiddenFixes = Math.max(0, fixList.length - 1);
    sectionsHTML += `
      <div class="upsell">
        <div>
          <b>You’re viewing the free preview.</b>
          <span>Unlock ${kwTotal ? `your ${missing.length} missing keyword${missing.length===1?'':'s'}, ` : ''}${hiddenFixes ? `${hiddenFixes} more fix${hiddenFixes===1?'':'es'}, ` : ''}the structure checklist${ghost ? ', the job ad reality check' : ''} and a written summary.</span>
        </div>
        <button type="button" class="btn btn-primary btn-sm" data-buy="10">See pricing</button>
      </div>`;
    // Top fix #1 is free, which shows the value of the rest
    sectionsHTML += section('fixes', 'Top fixes', `${fixList.length} found`,
      readLine + `<ul class="list-tight">${fixList.find(f => !f.includes('missing keywords')) || fixList[0] || fixes}</ul>` +
      (hiddenFixes ? `<div class="more-locked"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>${hiddenFixes} more fix${hiddenFixes===1?'':'es'} in the full report <button type="button" class="link-btn" data-buy="1">Unlock</button></div>` : ''));
    sectionsHTML += lockedSection('keywords', 'Keyword match',
      kwTotal ? `We found <b>${missing.length} keyword${missing.length===1?'':'s'}</b> from this job that your resume is missing, and ${present.length} you already cover.` : 'See which job keywords you match, which you’re missing, and your coverage.', 'pills');
    sectionsHTML += lockedSection('structure', 'Structure checklist', 'See which core sections (experience, skills, summary and more) are present or missing.', 'pills');
    if (ghost) sectionsHTML += lockedSection('ghost', 'Job ad reality check', 'See how “real” this job post looks, with hiring signals and red flags called out.');
    sectionsHTML += lockedSection('summary', 'Summary & next steps', 'A plain-English write-up of your strengths, gaps and exactly what to do next.');
  } else {
    sectionsHTML += section('keywords', 'Keyword match', kwTotal ? `${present.length}/${kwTotal} matched` : '', keywordsBody);
    sectionsHTML += section('fixes', 'Top fixes', `${fixList.length} found`, readLine + `<ul class="list-tight">${fixes}</ul>`);
    sectionsHTML += section('structure', 'Structure checklist', '', `<div class="pill-wrap">${sectionPills}</div>`);
    if (ghostHTML) sectionsHTML += section('ghost', 'Job ad reality check', '', ghostHTML);
    sectionsHTML += section('summary', 'Summary & next steps', '', summaryHTML);
  }

  if (out) {
    out.innerHTML = `
      <div class="results-root report ${lockAdvanced ? 'mode-free' : 'mode-paid'}">
        <div class="results-head report-head">
          ${donutSVG(result.total, `${result.total}`)}
          <div class="rh-text">
            <div class="rh-label">Overall score ${tipOverall}</div>
            <div class="rh-line"><span class="rating ${band}">${classifyScore(result.total)}</span>
              <span class="scan-tag">${gate.mode==='free' ? 'Free scan' : gate.mode==='credit' ? '1 credit used' : 'Test mode'}</span></div>
            <p class="rh-sub">${verdict}</p>
          </div>
        </div>

        <div class="kpi-grid">${bhtml}</div>

        ${sectionsHTML}

        <div class="report-foot">
          <button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById('jobs').scrollIntoView({behavior:'smooth'})">See matching jobs ↓</button>
        </div>
      </div>`;
  }

  // On phones the report sits below the form, so bring it into view
  if (out && window.matchMedia('(max-width: 979px)').matches) {
    setTimeout(() => out.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }
  try { gtag('event', 'analyze', { mode: gate.mode, score: result.total }); } catch {}

  // re-bind any "Unlock with a paid scan" buttons we just injected
  if (typeof window.__rezzyBindBuyButtons === 'function') {
    window.__rezzyBindBuyButtons();
  }

  // Similar live jobs based on the resume (paid feature, best-effort)
  renderJobsAccess();
  if (hasJobsAccess()) findSimilarJobs({ fromAnalyze: true });
}


/* ==================== Upload handling ==================== */
const fileInput = document.getElementById('resumeFile');
const fileLabel = document.getElementById('fileLabel');
const dropzone  = document.getElementById('dropzone');
const scanSpinner = document.getElementById('scanSpinner');
const scanText = document.getElementById('scanText');

(()=>{
  const btnPick = document.getElementById('btnPick');
  if (btnPick) btnPick.addEventListener('click', e=>{ e.stopPropagation(); fileInput && fileInput.click(); });

  if (fileInput) {
    fileInput.addEventListener('change', e => { if (e.target.files?.[0]) handleResumeFile(e.target.files[0]); });
  }
  if (dropzone) {
    ['dragenter','dragover'].forEach(ev=> dropzone.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.add('drag'); }));
    ['dragleave','drop'].forEach(ev=> dropzone.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.remove('drag'); }));
    dropzone.addEventListener('drop', e=>{ const f = e.dataTransfer?.files?.[0]; if (f) handleResumeFile(f); });
    dropzone.addEventListener('click', e=>{ if (e.target.closest('#btnPick')) return; fileInput && fileInput.click(); });
    dropzone.addEventListener('keydown', e=>{ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput && fileInput.click(); } });
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
    if (fileLabel) fileLabel.textContent = `${file.name} ✓`;
    toast('Resume loaded. Add the job description, then click Analyze.');
    document.getElementById('jd')?.focus({ preventScroll: true });
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
function openPaywall(n=3){
  hideMobileHintIfOpen();
  window.__desiredCredits = n;
  const lead = document.getElementById('paywallLeadText');
  if (lead) lead.innerHTML = readMeter().freeLeft > 0 || isUnlimited()
    ? 'Get the full report: every missing keyword, all fixes, the structure checklist, the job ad reality check and a written summary.'
    : 'You’ve used today’s free scan. Pick a pack to keep going. Bigger packs cost less per scan.';
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
function startCheckout(n = 3){
  const link = PAYMENT_LINKS[n];
  if (!link){ toast('Something went wrong. Please refresh and try again.'); return; }
  try { gtag('event', 'begin_checkout', { value: n }); } catch {}
  // client_reference_id ties the Stripe payment to this browser (handy for support)
  const url = new URL(link);
  url.searchParams.set('client_reference_id', CREDIT_TOKEN);
  toast('Opening secure checkout…');
  location.href = url.toString();
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

/* ==================== Small UI helpers ==================== */
let __toastTimer;
function toast(message){
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(__toastTimer);
  __toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

const SAMPLE_RESUME = `JOHN DOE
Detroit, MI • john.doe@email.com • (313) 555-1212

SUMMARY
Data-driven analyst with 5+ years improving KPI visibility and reducing cycle time across finance and operations.

EXPERIENCE
Acme Corp — Senior Analyst (2021–Present)
• Led dashboard rebuild, improving reporting speed by 35%.
• Automated monthly close with Python, saving 12 hours per cycle.
• Partnered with sales to forecast pipeline; reduced variance by 18%.

EDUCATION
B.S. in Information Systems, Michigan State University

SKILLS
SQL, Python, Tableau, Excel, Power BI, Forecasting, ETL`;
const SAMPLE_JD = `We seek a Business Data Analyst to build SQL pipelines, automate reporting in Python, and create Tableau dashboards. Experience with forecasting, ETL, and stakeholder communication required.`;
function fillSample(){
  const r = document.getElementById('resume'), j = document.getElementById('jd');
  if (r) r.value = SAMPLE_RESUME;
  if (j) j.value = SAMPLE_JD;
  toast('Sample loaded. Click Analyze to see a report.');
}

const RESULTS_EMPTY_HTML = document.getElementById('results')?.innerHTML || '';
function clearAll(){
  const resume = document.getElementById('resume');
  const jd = document.getElementById('jd');
  const keywords = document.getElementById('keywords');
  const out = document.getElementById('results');

  if (resume) resume.value='';
  if (jd) jd.value='';
  if (keywords) keywords.value='';
  if (out && RESULTS_EMPTY_HTML) out.innerHTML = RESULTS_EMPTY_HTML;
  if (fileInput) fileInput.value = '';
  if (fileLabel) fileLabel.textContent = 'Drop your resume here';
  ['jobTitle','jobWhere'].forEach(id => { const el = document.getElementById(id); if (el){ el.value = ''; delete el.dataset.touched; } });
  const jr = document.getElementById('jobRemote'); if (jr){ jr.checked = false; delete jr.dataset.touched; }
  renderSkillChips([]);
  const jm = document.getElementById('jobsMeta'); if (jm) jm.textContent = '';
  setJobsState(JOBS_EMPTY_HTML);
  renderJobsAccess();
  setScanStatus('Ready', false);
}

/* =================== SIMILAR LIVE JOBS FEATURE =================== */
// Free for everyone. Reads the resume, figures out the role / skills / location,
// then asks our /jobs Lambda (an Adzuna proxy) for live postings and ranks them.
const JOBS_API = `${API_BASE_URL}/jobs`;

const ROLE_NOUNS = "Analyst|Engineer|Developer|Designer|Scientist|Manager|Specialist|Coordinator|Consultant|Administrator|Architect|Director|Accountant|Technician|Nurse|Representative|Associate|Assistant|Officer|Supervisor|Teacher|Recruiter|Strategist|Writer|Editor|Producer|Planner|Buyer|Auditor|Therapist|Pharmacist|Programmer|Controller|Advisor|Agent|Operator|Mechanic|Electrician|Paralegal|Attorney|Marketer|Tester|Lead";
const SENIORITY = "Senior|Sr\\.?|Junior|Jr\\.?|Lead|Principal|Staff|Chief|Head of";
const TITLE_RX = new RegExp(`\\b(?:(?:${SENIORITY})\\s+)?(?:[A-Z][A-Za-z&/+.-]*\\s+){0,3}(?:${ROLE_NOUNS})s?\\b`, "g");
const SENIORITY_RX = new RegExp(`^(?:${SENIORITY})\\s+`, "i");

// Common skills we can spot anywhere in a resume (in addition to a SKILLS section)
const KNOWN_SKILLS = ["SQL","Python","R","Java","JavaScript","TypeScript","C#","C++","Go","Ruby","PHP","Swift","Kotlin",
  "React","Angular","Vue","Node.js","Django","Flask",".NET","AWS","Azure","GCP","Docker","Kubernetes","Terraform","Linux",
  "Git","Tableau","Power BI","Looker","Excel","VBA","SAS","SPSS","Snowflake","Databricks","Spark","Hadoop","ETL","Airflow",
  "Salesforce","HubSpot","SAP","Oracle","NetSuite","QuickBooks","Figma","Sketch","Adobe XD","Photoshop","Illustrator",
  "InDesign","HTML","CSS","SEO","Google Analytics","Jira","Agile","Scrum","Machine Learning","Forecasting","Budgeting",
  "Project Management","Six Sigma","Lean","AutoCAD","SolidWorks","Microsoft 365","Active Directory","ServiceNow",
  "Customer Service","Sales","Recruiting","Payroll","GAAP","CPA","PMP","Copywriting","Social Media"];

function _escRx(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
// Short skills like "R" or "Go" must match case exactly, or "go" / "r" in normal text would count
function _skillRx(k, exactCase = false){ return new RegExp(`(^|[^A-Za-z0-9+#])${_escRx(k)}(?=$|[^A-Za-z0-9+#])`, (exactCase || k.length <= 2) ? "" : "i"); }

function guessJobTitleFromText(t) {
  const text = String(t || "");
  // Prefer the first title inside EXPERIENCE (most recent role); fall back to the whole doc
  const expIdx = text.search(/^\s*(professional\s+)?experience\b/im);
  const zones = expIdx >= 0 ? [text.slice(expIdx), text] : [text];
  for (const z of zones) {
    const m = z.match(TITLE_RX);
    if (m && m.length) return m[0].replace(/\s+/g, " ").trim();
  }
  return "";
}

function guessLocationFromText(t) {
  if (!t) return "";
  const head = String(t).split(/\n/).slice(0, 8).join("\n");
  const citySt = head.match(/\b([A-Z][a-zA-Z.' -]{1,30},\s*[A-Z]{2})\b/);
  if (citySt) return citySt[1].trim();
  return /\bremote\b/i.test(head) ? "Remote" : "";
}

function extractResumeSkills(t) {
  const text = String(t || "");
  const out = [];
  // 1) A SKILLS / TOOLS / COMPETENCIES section
  const lines = text.split(/\n/);
  const i = lines.findIndex(l => /^\s*(technical\s+)?(skills|tools|technologies|core competencies|competencies)\b\s*:?/i.test(l));
  if (i >= 0) {
    const chunk = [lines[i].replace(/^[^:]*:?/, "")];
    for (let k = i + 1; k < lines.length && k < i + 8; k++) {
      const l = lines[k];
      if (/^\s*[A-Z][A-Z &/]{3,}\s*$/.test(l)) break;   // next ALL-CAPS header
      chunk.push(l);
    }
    chunk.join(",").split(/[,•|;·\n]+/).map(s => s.replace(/^[-*\s]+/, "").trim())
      .filter(s => s && s.length <= 30 && s.split(/\s+/).length <= 3)
      .forEach(s => out.push(s));
  }
  // 2) Known skills mentioned anywhere
  // (exact case, so everyday words like "partnered with sales" don't count as the skill "Sales")
  for (const k of KNOWN_SKILLS) if (_skillRx(k, true).test(text)) out.push(k);
  const seen = new Set();
  return out.filter(s => { const key = s.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}

function profileFromResume(resume, jd) {
  let title = guessJobTitleFromText(resume);
  const jdTitle = guessJobTitleFromText(jd);
  // "Senior Analyst" is vague — if the job post names the same role more specifically, use that
  const bare = title.replace(SENIORITY_RX, "");
  if (jdTitle && (!title || (bare.split(/\s+/).length < 2 && jdTitle.toLowerCase().endsWith(bare.toLowerCase())))) {
    title = jdTitle;
  }
  return {
    title: title.replace(/s$/, "") || "",
    skills: extractResumeSkills(resume).slice(0, 12),
    location: guessLocationFromText(resume),
  };
}

function escapeHTML(s){ return String(s||"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }
function safeUrl(u){ try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : "#"; } catch { return "#"; } }

async function fetchSimilarJobs({ q, skills = [], where = "", remote = false, limit = 12 }) {
  const url = new URL(JOBS_API);
  if (q) url.searchParams.set("q", q);
  if (skills.length) url.searchParams.set("skills", skills.slice(0, 8).join(","));
  if (where && !remote) url.searchParams.set("where", where);
  if (remote) url.searchParams.set("remote", "1");
  url.searchParams.set("limit", String(limit));
  const r = await fetch(url.toString(), { cache: "no-store" });
  if (!r.ok) throw new Error(`Jobs API ${r.status}`);
  const data = await r.json();
  return Array.isArray(data.jobs) ? data.jobs : [];
}

// 0–100 fit: skill overlap (60%) + title similarity (40%)
function scoreJobMatch(job, profile) {
  const hay = `${job.title} ${job.desc}`;
  const skills = profile.skills.slice(0, 10);
  const hits = skills.filter(s => _skillRx(s).test(hay));
  const skillPart = skills.length ? hits.length / Math.min(skills.length, 5) : 0.5;
  const tWords = (profile.title || "").toLowerCase().replace(SENIORITY_RX, "").split(/\s+/).filter(w => w.length > 2);
  const jt = (job.title || "").toLowerCase();
  const titlePart = tWords.length ? tWords.filter(w => jt.includes(w)).length / tWords.length : 0.5;
  const score = Math.round(100 * (0.6 * Math.min(1, skillPart) + 0.4 * titlePart));
  return { score: Math.max(5, Math.min(99, score)), hits };
}

function _money(n){ return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`; }
function _salary(j){
  const lo = Number(j.salary_min) || 0, hi = Number(j.salary_max) || 0;
  if (!lo && !hi) return "";
  const txt = lo && hi && Math.abs(hi - lo) > 500 ? `${_money(lo)}–${_money(hi)}` : _money(hi || lo);
  return j.salary_predicted ? `~${txt} est.` : txt;
}
function _ago(iso){
  const d = Date.parse(iso); if (!d) return "";
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days <= 0) return "Today"; if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`; if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(d).toLocaleDateString();
}

const JOBS_EMPTY_HTML = `<div class="jobs-empty"><b>Find roles that fit your resume.</b><span>We’ll read your title, skills and location, then pull live postings.</span></div>`;
function setJobsState(html){
  const grid = document.getElementById("jobsGrid");
  if (grid) grid.innerHTML = html;
}

function renderSimilarJobs(jobs = [], profile = { skills: [] }) {
  const grid = document.getElementById("jobsGrid");
  const meta = document.getElementById("jobsMeta");
  if (!grid) return;

  if (!jobs.length) {
    if (meta) meta.textContent = "";
    setJobsState(`<div class="jobs-empty"><b>No live matches right now.</b><span>Try a broader title (e.g. “Analyst”), a nearby city, or switch on Remote.</span></div>`);
    return;
  }

  const ranked = jobs.map(j => ({ ...j, _m: scoreJobMatch(j, profile) }))
    .sort((a, b) => b._m.score - a._m.score || (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0))
    .slice(0, 12);

  if (meta) meta.textContent = `${ranked.length} live posting${ranked.length === 1 ? "" : "s"}, ranked by fit`;

  grid.innerHTML = ranked.map(j => {
    const d = (j.desc || "").replace(/\s+/g, " ").trim();
    const snippet = d.length > 200 ? d.slice(0, 200).replace(/\s+\S*$/, "") + "…" : d;
    const m = j._m;
    const band = m.score >= 70 ? "good" : m.score >= 45 ? "warn" : "low";
    const sal = _salary(j);
    const when = _ago(j.created);
    return `
      <article class="job-card">
        <div class="job-top">
          <div class="job-head">
            <h4 class="job-title">${escapeHTML(j.title || "Untitled role")}</h4>
            <div class="job-company">${escapeHTML(j.company || "Company not listed")}</div>
          </div>
          <div class="job-match ${band}" title="How closely this posting matches your resume">
            <b>${m.score}%</b><span>match</span>
          </div>
        </div>
        <div class="job-meta">
          ${j.location ? `<span class="badge-mini">📍 ${escapeHTML(j.location)}</span>` : ""}
          ${sal ? `<span class="badge-mini">${escapeHTML(sal)}</span>` : ""}
          ${j.contract_time ? `<span class="badge-mini">${escapeHTML(j.contract_time.replace("_", "-"))}</span>` : ""}
          ${when ? `<span class="badge-mini">${escapeHTML(when)}</span>` : ""}
        </div>
        ${snippet ? `<p class="job-line">${escapeHTML(snippet)}</p>` : ""}
        ${m.hits.length ? `<div class="job-skills">${m.hits.slice(0, 5).map(s => `<span class="chip mini ok">${escapeHTML(s)}</span>`).join("")}</div>` : ""}
        <div class="job-footer">
          <a class="job-btn brand" href="${escapeHTML(safeUrl(j.url))}" target="_blank" rel="noopener nofollow">View posting ↗</a>
        </div>
      </article>`;
  }).join("");
}

let __jobsReq = 0;
async function findSimilarJobs({ fromAnalyze = false } = {}) {
  const resume = document.getElementById("resume")?.value || "";
  const jd = document.getElementById("jd")?.value || "";
  const titleEl = document.getElementById("jobTitle");
  const whereEl = document.getElementById("jobWhere");
  const remoteEl = document.getElementById("jobRemote");
  const btn = document.getElementById("btnFindJobs");

  // Matching jobs are part of the paid report
  if (!hasJobsAccess()) {
    renderJobsAccess();
    if (!fromAnalyze) openPaywall(3);
    return;
  }

  const auto = profileFromResume(resume, jd);
  // Fill the inputs from the resume unless the user has typed their own
  if (titleEl && (!titleEl.dataset.touched || !titleEl.value)) titleEl.value = auto.title;
  if (whereEl && (!whereEl.dataset.touched || !whereEl.value)) whereEl.value = auto.location === "Remote" ? "" : auto.location;
  if (remoteEl && !remoteEl.dataset.touched && auto.location === "Remote") remoteEl.checked = true;

  const profile = {
    title: (titleEl?.value || auto.title).trim(),
    skills: auto.skills,
    location: (whereEl?.value || "").trim(),
    remote: !!remoteEl?.checked,
  };
  renderSkillChips(profile.skills);

  if (!profile.title && !profile.skills.length) {
    if (!fromAnalyze) setJobsState(`<div class="jobs-empty"><b>Add your resume first.</b><span>Paste or upload it above and we’ll find roles that fit.</span></div>`);
    return;
  }

  const req = ++__jobsReq;
  if (btn) { btn.disabled = true; btn.classList.add("loading"); }
  setJobsState(Array.from({ length: 6 }, () => `<div class="job-card skeleton"><i></i><i></i><i></i></div>`).join(""));
  document.getElementById("jobsMeta") && (document.getElementById("jobsMeta").textContent = "Searching live postings…");

  try {
    const jobs = await fetchSimilarJobs({ q: profile.title, skills: profile.skills, where: profile.location, remote: profile.remote, limit: 12 });
    if (req !== __jobsReq) return;       // a newer search started
    renderSimilarJobs(jobs, profile);
    try { gtag && gtag("event", "similar_jobs", { results: jobs.length }); } catch {}
  } catch (e) {
    if (req !== __jobsReq) return;
    console.warn("Jobs fetch failed:", e);
    document.getElementById("jobsMeta") && (document.getElementById("jobsMeta").textContent = "");
    setJobsState(`<div class="jobs-empty"><b>Couldn’t load jobs right now.</b><span>Please try again in a minute.</span></div>`);
  } finally {
    if (req === __jobsReq && btn) { btn.disabled = false; btn.classList.remove("loading"); }
  }
}

function renderSkillChips(skills = []) {
  const el = document.getElementById("jobSkills");
  if (!el) return;
  el.innerHTML = skills.length
    ? `<span class="helper">Matching on:</span> ` + skills.slice(0, 8).map(s => `<span class="chip mini">${escapeHTML(s)}</span>`).join("")
    : "";
}

(() => {
  ["jobTitle", "jobWhere", "jobRemote"].forEach(id => {
    const el = document.getElementById(id);
    el && el.addEventListener("input", () => { el.dataset.touched = "1"; });
    el && el.addEventListener("change", () => { el.dataset.touched = "1"; });
  });
  document.getElementById("jobsForm")?.addEventListener("submit", e => { e.preventDefault(); findSimilarJobs(); });
})();
/* ================= END SIMILAR LIVE JOBS FEATURE ================= */

updateMeterUI();
updatePricingUI();
setScanStatus('Ready', false);
/* ==================== Returning from Stripe checkout ==================== */
(function handlePaymentReturn(){
  const params = new URLSearchParams(location.search);
  const paid = parseInt(params.get('paid') || '0', 10);
  const session = params.get('session_id') || '';
  const carry = parseInt(params.get('carry') || '0', 10);
  if (!paid && !carry) return;

  // tidy the address bar so a refresh or shared link doesn't re-trigger anything
  try { history.replaceState(null, '', location.pathname + location.hash); } catch {}

  if (carry > 0 && carry <= 1000) {
    addCredits(carry);
  }

  if ((!PAYMENT_LINKS[paid] && !LEGACY_PAID.includes(paid)) || !/^cs_(live|test)_[A-Za-z0-9]+$/.test(session)) return;

  let claimed = [];
  try { claimed = JSON.parse(localStorage.getItem('rz_claimed_sessions') || '[]'); } catch {}
  if (claimed.includes(session)) return;           // already added for this purchase
  claimed.push(session);
  try { localStorage.setItem('rz_claimed_sessions', JSON.stringify(claimed.slice(-50))); } catch {}

  addCredits(paid);
  try { gtag('event', 'purchase', { transaction_id: session, value: paid }); } catch {}
  document.addEventListener('DOMContentLoaded', () =>
    toast(`Payment received. ${paid} scan${paid === 1 ? '' : 's'} added. Thank you!`));
})();

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

      const credits = parseInt(btn.getAttribute('data-buy'), 10) || 3;

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

  window.openPaywall = function(n = 3){
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
