// === Stripe config ===
const STRIPE_PUBLISHABLE_KEY = "pk_test_51RzkyvChKVWsJZcWlClLjJ1xACdszPyCjKmX1HTudOaqq5VKOM2rAdc2a9qusAWjskbaGba2IEzLhDGaBJb2NAYM00yaemtAQf";  // <-- your TEST publishable key
const API_BASE_URL = "https://gyw1n7b24m.execute-api.us-east-2.amazonaws.com/Prod"; // <-- your API

function getOrCreateToken(){
  const k = 'credit_token_v1';
  let t = localStorage.getItem(k);
  if (!t){
    t = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    localStorage.setItem(k, t);
  }
  return t;
}
const CREDIT_TOKEN = getOrCreateToken();

// one Price per bundle (set these to your real Price IDs from Stripe)
const PRICE_IDS = {
  1:  "price_1S5dgPChKVWsJZcWk9kacziD",   // $0.49
  10: "price_1S5dhfChKVWsJZcWJdjIkpfx",   // $3.99
  20: "price_1S5di8ChKVWsJZcWTxpXycQ0"    // $5.99
};


let stripe, elements, paymentElement, clientSecret;

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

function openCheckout(){
  const modal = document.getElementById('checkout-modal');
  modal.classList.add('open');
  document.body.classList.add('modal-open');

  // reset button state + message every time the modal opens
  const payBtn = document.getElementById('pay-now');
  const msg    = document.getElementById('checkout-msg');
  if (payBtn) payBtn.disabled = false;
  if (msg) msg.textContent = '';
}

function closeCheckout(){
  const modal = document.getElementById('checkout-modal');
  modal.classList.remove('open');
  document.body.classList.remove('modal-open');

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

document.getElementById('closeCheckoutBtn').addEventListener('click', closeCheckout);

    
    /* ===== Prices ===== */
    const PRICES = { single: 0.50, pack10: 3.99, pack20: 5.99 };
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
    
    /* ===== Metering & Paywall ===== */
    const LS_KEYS = { lastDate:'rc_lastDate', dailyUsed:'rc_dailyUsed', credits:'rc_credits', unlimitedUntil:'rc_unlimited_until', savedJobs:'rc_saved_jobs' };
    (function handleUnlimitedFlag(){
      const params = new URLSearchParams(location.search);
      const hours = 48;
      if (params.get('unlimited') === '1'){
        localStorage.setItem(LS_KEYS.unlimitedUntil, String(Date.now() + hours*60*60*1000));
        try{ history.replaceState(null,'',location.pathname); }catch(e){}
      } else if (params.get('unlimited') === '0'){
        localStorage.removeItem(LS_KEYS.unlimitedUntil);
        try{ history.replaceState(null,'',location.pathname); }catch(e){}
      }
    })();
    function isUnlimited(){ const until = parseInt(localStorage.getItem(LS_KEYS.unlimitedUntil)||'0',10); return Date.now() < until; }
    const todayStr = () => { const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
    function readMeter(){
      const today = todayStr();
      const last = localStorage.getItem(LS_KEYS.lastDate);
      if (last !== today){ localStorage.setItem(LS_KEYS.lastDate, today); localStorage.setItem(LS_KEYS.dailyUsed, '0'); }
      const freeUsed = parseInt(localStorage.getItem(LS_KEYS.dailyUsed)||'0',10);
      const credits = parseInt(localStorage.getItem(LS_KEYS.credits)||'0',10);
      return { freeLeft: Math.max(0, 1 - freeUsed), credits };
    }
    function writeMeter({freeConsumed=0, creditConsumed=0, creditAdd=0}={}){
      const used = parseInt(localStorage.getItem(LS_KEYS.dailyUsed)||'0',10) + freeConsumed;
      const credits = Math.max(0, parseInt(localStorage.getItem(LS_KEYS.credits)||'0',10) - creditConsumed + creditAdd);
      localStorage.setItem(LS_KEYS.dailyUsed, String(used));
      localStorage.setItem(LS_KEYS.credits, String(credits));
      updateMeterUI();
    }
    function updateMeterUI(){
      const {freeLeft, credits} = readMeter();
      document.getElementById('creditBadge').textContent = `Paid credits: ${credits}`;
      document.getElementById('freeBadge').textContent = isUnlimited() ? 'Free scans left today: ∞ (temp)' : `Free scans left today: ${freeLeft}`;
    }
    function canConsumeScan(){
      if (isUnlimited()) return { ok:true, mode:'unlimited' };
      const {freeLeft, credits} = readMeter();
      if (freeLeft > 0) return { ok:true, mode:'free' };
      if (credits > 0) return { ok:true, mode:'credit' };
      return { ok:false, mode:'pay' };
    }
    function consumeScan(mode){ if (mode==='free') writeMeter({freeConsumed:1}); else if (mode==='credit') writeMeter({creditConsumed:1}); }
    
    /* ===== Heuristic scoring ===== */
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
    function professionalismScore(r){
      const {bullets,exclam,capsWords,longLines}=bulletStats(r);
      const pv=passiveVoiceCount(r);
      const words=tokenize(r).length;
      let score=35;
      if(exclam>0)score-=Math.min(5,exclam*2);
      score-=Math.min(5,Math.floor(capsWords/5));
      score-=Math.min(5,Math.floor(pv/4));
      score-=Math.min(5,longLines);
      if(bullets>=5)score+=2;
      if(countNumbers(r)>=3)score+=3;
      if(words>=250&&words<=900)score+=2;
      return {score:Math.max(0,Math.min(35,Math.round(score))), details:{bullets,exclam,capsWords,longLines,passive:pv,words,numbers:countNumbers(r)}};
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
      const missingSections = Object.entries(result.sectionPresence).filter(([, v]) => !v).map(([k]) => k);
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

    /* ===== Jobs ===== */
    const CANON_SKILLS = ["sql","python","tableau","power bi","excel","etl","forecasting","dashboard","dashboards","pipeline","pipelines","bi","powerbi","power"];
    const ROLE_TEMPLATES = [
      {title:"Data Analyst", bucket:"Data"},
      {title:"Senior Data Analyst", bucket:"Data"},
      {title:"Lead Data Analyst", bucket:"Data"},
      {title:"Business Data Analyst", bucket:"Data"},
      {title:"Business Intelligence Analyst", bucket:"BI"},
      {title:"Reporting Analyst (SQL/Tableau)", bucket:"BI"},
      {title:"Analytics Engineer", bucket:"Eng"},
      {title:"Junior Analytics Engineer", bucket:"Eng"},
      {title:"Product Analyst (Data)", bucket:"Product"},
      {title:"Growth / Marketing Analyst", bucket:"Marketing"},
      {title:"Financial Data Analyst", bucket:"Finance"},
      {title:"Revenue / FP&A Analyst", bucket:"Finance"},
      {title:"Operations Data Analyst", bucket:"Ops"},
      {title:"Supply Chain Data Analyst", bucket:"Ops"}
    ];
    const SENIORITY_BY_TITLE = (t)=> /lead|senior/i.test(t) ? "Senior" : /junior/i.test(t) ? "Entry" : "Mid";

    function pickLocationFromResume(t){
      const m = (t.match(/[A-Za-z .'-]+,\s*[A-Z]{2}/) || [])[0];
      return m ? m.replace(/\s+/g,' ').trim() : "Remote";
    }
    function topSkillsFromResume(t){
      const low = t.toLowerCase();
      const found = CANON_SKILLS.filter(s => low.includes(s));
      const pretty = s => s
        .replace('power bi','Power BI').replace('powerbi','Power BI')
        .replace(/^sql$/i,'SQL').replace(/^etl$/i,'ETL').replace(/^bi$/i,'BI')
        .replace(/^python$/i,'Python').replace(/^excel$/i,'Excel').replace(/^tableau$/i,'Tableau')
        .replace(/^pipeline(s)?$/i,'Pipelines').replace(/^dashboard(s)?$/i,'Dashboards')
        .replace(/^forecasting$/i,'Forecasting').replace(/^power$/i,'Power BI');
      return Array.from(new Set(found.map(pretty)));
    }

    const ALLOWED_JOB_HOST_PATTERNS = [/(\.|^)linkedin\.com\/jobs/i, /(\.|^)indeed\.com/i];
    const RELEVANCE_TOKENS = ["data","analyst","analytics","bi","business-intelligence","sql","python","tableau","power-bi","powerbi","etl","reporting","dashboard","pipelines","forecast"];
    function urlLooksLegitAndRelevant(urlStr){
      let u; try{ u = new URL(urlStr); }catch{ return {ok:false, reason:"Invalid URL"}; }
      const ok = ALLOWED_JOB_HOST_PATTERNS.some(rx => rx.test((u.hostname+u.pathname).toLowerCase()));
      if (!ok) return {ok:false, reason:"Only LinkedIn and Indeed links are accepted"};
      const hay = (u.pathname + " " + u.search).toLowerCase();
      if (!RELEVANCE_TOKENS.some(t => hay.includes(t))) return {ok:false, reason:"URL path lacks relevant analyst/data keywords"};
      return {ok:true};
    }

    const JOB_OVERRIDES_KEY = 'rc_job_overrides';
    const getOverrides = () => { try { return JSON.parse(localStorage.getItem(JOB_OVERRIDES_KEY) || '{}'); } catch { return {}; } };
    const saveOverrides = map => localStorage.setItem(JOB_OVERRIDES_KEY, JSON.stringify(map || {}));

    function setExactPosting(title){
      const map = getOverrides();
      const cur = map[title] || {};
      const url = prompt('Paste the exact job link (LinkedIn or Indeed only):', cur.url || '');
      if (!url){ delete map[title]; saveOverrides(map); renderJobsGrid(); return; }
      const check = urlLooksLegitAndRelevant(url);
      if (!check.ok){ alert(`Rejected: ${check.reason}`); return; }
      const city = prompt('City, ST as shown on the posting (e.g., Detroit, MI):', cur.city || '');
      const pay  = prompt('Salary range exactly as posted (e.g., $83k–$113k or $40–$55/hr):', cur.pay || '');
      const mode = prompt('Work mode (Remote / Hybrid / On-site):', cur.mode || '');
      map[title] = { url, city, pay, mode };
      saveOverrides(map);
      renderJobsGrid();
    }

    function openAddLinks(){
      const msg = `Paste 1–10 job links (each on a new line).\n\nAccepted: LinkedIn Jobs and Indeed only.`;
      const raw = prompt(msg, ""); if (!raw) return;
      const urls = raw.split(/\s*\n+\s*/).map(s=>s.trim()).filter(Boolean).slice(0,10);
      const map = getOverrides(); let added = 0, rejected = 0;
      const titles = JOBS_STATE.all.map(j => j.title);
      const lowerTitle = t => t.toLowerCase();
      urls.forEach(u=>{
        const v = urlLooksLegitAndRelevant(u); if (!v.ok){ rejected++; return; }
        const tokenized = (new URL(u).pathname.toLowerCase()).split(/[^a-z]+/g);
        const pick = titles.find(t=>{
          const toks = lowerTitle(t).split(/[^a-z]+/g);
          return toks.some(x => x && tokenized.includes(x));
        }) || titles[0];
        const cur = map[pick] || {};
        map[pick] = { url: u, city: cur.city || "", pay: cur.pay || "", mode: cur.mode || "" };
        added++;
      });
      saveOverrides(map); renderJobsGrid();
      alert(`Added ${added} link(s). ${rejected ? rejected + ' rejected (must be LinkedIn or Indeed and relevant).' : ''}`);
    }

    function roleLine(skills){
      const s = skills.slice(0,3);
      const map = {
        "SQL":"own SQL pipelines","Python":"automate reporting in Python","Tableau":"ship Tableau dashboards",
        "Power BI":"build Power BI reports","Forecasting":"improve forecasting accuracy","ETL":"maintain ETL workflows",
        "Pipelines":"scale data pipelines","Dashboards":"design executive dashboards","Excel":"analyze in Excel"
      };
      const bits = s.map(x=>map[x]||`use ${x}`); return bits.slice(0,2).join(", ")+(bits[2]?`, ${bits[2]}`:"");
    }
    function matchScoreFor(role, skills, presentKeywords){
      const roleTokens = role.toLowerCase().split(/[^a-z]+/g);
      const skillSet = new Set(skills.map(s=>s.toLowerCase()));
      (presentKeywords||[]).forEach(k=>skillSet.add((k||"").toLowerCase()));
      const hits = roleTokens.filter(t=>skillSet.has(t) || ["data","analyst","analytics","bi","sql","python"].includes(t)).length;
      const base = 65 + Math.min(25, skills.length*4) + hits*2;
      return Math.max(60, Math.min(96, base));
    }
    function expandRoles(){
      const flavors = ["", " (SQL/Tableau)", " (Python/ETL)", " (Power BI)"];
      const out = [];
      ROLE_TEMPLATES.forEach(rt=>{
        flavors.forEach(f=>{
          const title = (rt.title + f).replace(/\s+/g,' ').trim();
          out.push({ title, bucket: rt.bucket, seniority: SENIORITY_BY_TITLE(title) });
        });
      });
      return out.slice(0, 60);
    }
    function recommendJobs(resumeText, presentKeywords=[]){
      const loc = pickLocationFromResume(resumeText);
      const skills = topSkillsFromResume(resumeText);
      const tags = Array.from(new Set([...(skills||[]), ...(presentKeywords||[]).slice(0,3).map(k=>k[0]?.toUpperCase()+k.slice(1))])).slice(0,6);
      const jobs = expandRoles().map(meta=>{
        const score = matchScoreFor(meta.title, skills, presentKeywords);
        const line = roleLine(skills);
        return { ...meta, tags, score, line, softLocation: loc, softMode: loc.toLowerCase().includes('remote') ? 'Remote' : 'Hybrid' };
      });
      return jobs.sort((a,b)=>b.score-a.score).slice(0,50);
    }

    /* Related job ads (search links) */
    const mkQuery = (title, skills=[]) => encodeURIComponent(`${title} ${skills.slice(0,2).join(' ')}`.trim());
    const mkLoc   = (loc="") => encodeURIComponent(loc || "Remote");
    function liSearchUrl(title, loc, skills){ return `https://www.linkedin.com/jobs/search/?keywords=${mkQuery(title, skills)}&location=${mkLoc(loc)}`; }
    function indeedSearchUrl(title, loc, skills){ return `https://www.indeed.com/jobs?q=${mkQuery(title, skills)}&l=${mkLoc(loc)}`; }

    function relatedJobsSectionHTML(jobs){
      const top = jobs.slice(0,8);
      const cards = top.map(j=>{
        const li = liSearchUrl(j.title, j.softLocation, j.tags);
        const indd = indeedSearchUrl(j.title, j.softLocation, j.tags);
        return `
          <div class="job-card" data-bucket="${j.bucket}">
            <div class="job-head">
              <h4 class="job-title">${j.title}</h4>
              <div class="job-meta">
                <span class="badge-mini">${j.softLocation}</span>
                <span class="badge-mini">${j.seniority}</span>
                <span class="chip mini">${j.softMode}</span>
              </div>
            </div>
            <div class="job-line">${j.line}; scan current openings and apply fast.</div>
            <div class="job-tags">${(j.tags||[]).map(t=>`<span class="pill">${t}</span>`).join('')}</div>
            <div class="job-footer">
              <a class="job-btn brand" href="${li}"   target="_blank" rel="noopener"><span class="label">Open on LinkedIn</span></a>
              <a class="job-btn"        href="${indd}" target="_blank" rel="noopener"><span class="label">Open on Indeed</span></a>
              <div class="job-aux"></div>
            </div>
          </div>`;
      }).join('');
      return `
        <div class="jobs-wrap">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
            <div>
              <h3 class="card-title" style="margin:14px 0 6px">Related Job Ads</h3>
              <p class="card-sub" style="margin-top:0">Direct searches on <b>LinkedIn</b> and <b>Indeed</b>, based on your resume.</p>
            </div>
          </div>
          <div class="jobs" id="relatedJobsGrid">${cards}</div>
        </div>`;
    }

    let JOB_FILTER = { mode:"any", bucket:"any" };
    const JOBS_STATE = { all:[], page:0, pageSize:12 };
    function jobsToolbarHTML(){
      const btn = (label, key, val)=>`<button type="button" data-key="${key}" data-val="${val}">${label}</button>`;
      return `
        <div class="jobs-toolbar">
          <div class="seg" id="modeSeg">
            ${btn('All modes','mode','any')}${btn('Remote','mode','Remote')}${btn('Hybrid','mode','Hybrid')}${btn('On-site','mode','On-site')}
          </div>
          <div class="seg" id="bucketSeg">
            ${btn('All roles','bucket','any')}${btn('Data','bucket','Data')}${btn('BI','bucket','BI')}${btn('Eng','bucket','Eng')}${btn('Finance','bucket','Finance')}${btn('Ops','bucket','Ops')}${btn('Product','bucket','Product')}${btn('Marketing','bucket','Marketing')}
          </div>
          <span class="helper">Only exact postings from <b>LinkedIn</b> and <b>Indeed</b> are shown.</span>
        </div>`;
    }
    function buildJobCardHTML(j){
      const overrides = getOverrides()[j.title] || {};
      if (!overrides.url) return "";
      const validation = urlLooksLegitAndRelevant(overrides.url);
      if (!validation.ok) return "";
      const accurateCity = overrides.city || '';
      const accuratePay  = overrides.pay  || '—';
      const accurateMode = overrides.mode || j.softMode || '—';
      return `
        <div class="job-card" data-mode="${accurateMode}" data-bucket="${j.bucket}">
          <div class="job-head">
            <h4 class="job-title">${j.title}</h4>
            <div class="job-meta">
              <span class="badge-mini">${accurateCity || j.softLocation}</span>
              <span class="badge-mini">${j.seniority}</span>
              <span class="chip mini">${accuratePay}</span>
              <span class="chip mini">${accurateMode}</span>
              <span class="chip mini ok" title="Verified job posting">Verified</span>
            </div>
          </div>
          <div class="job-line">${j.line}; define KPIs, set up quality checks, and present insights to stakeholders to drive decisions.</div>
          <div class="job-tags">${(j.tags||[]).map(t=>`<span class="pill">${t}</span>`).join('')}</div>
          <div class="job-footer">
            <a class="job-btn brand" href="${overrides.url}" target="_blank" rel="noopener"><span class="label">View job</span></a>
            <div class="job-aux">
              <button class="file-btn" title="Edit posting details" onclick="setExactPosting('${j.title.replace(/'/g, "\\'")}')">Edit</button>
            </div>
          </div>
        </div>`;
    }
    function jobsSectionHTML(jobs){
      JOBS_STATE.all = jobs;
      JOBS_STATE.page = 0;
      return `
        <div class="jobs-wrap">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
            <div>
              <h3 class="card-title" style="margin:14px 0 6px">Verified Job Postings</h3>
              <p class="card-sub" style="margin-top:0">Only real postings from <b>LinkedIn</b> and <b>Indeed</b>. One link per card.</p>
            </div>
            <div class="flex" style="display:flex;gap:8px">
              <button class="btn-secondary btn-compact" onclick="openAddLinks()">Paste LinkedIn/Indeed links</button>
            </div>
          </div>
          ${jobsToolbarHTML()}
          <div class="jobs" id="jobsGrid"></div>
          <div class="load-more"><button id="loadMoreBtn" class="btn-secondary">Load more</button></div>
        </div>`;
    }
    function renderJobsGrid(){
      const grid = document.getElementById('jobsGrid');
      if (!grid) return;
      const filtered = JOBS_STATE.all.filter(j => {
        const o = getOverrides()[j.title] || {};
        if (!o.url) return false;
        const v = urlLooksLegitAndRelevant(o.url);
        if (!v.ok) return false;
        const modeNow = (o.mode || j.softMode);
        return (JOB_FILTER.mode==='any'   || modeNow===JOB_FILTER.mode) &&
               (JOB_FILTER.bucket==='any' || j.bucket===JOB_FILTER.bucket);
      });
      const end = Math.min(filtered.length, (JOBS_STATE.page+1)*JOBS_STATE.pageSize);
      const html = filtered.slice(0, end).map(buildJobCardHTML).join('');
      grid.innerHTML = html || `
        <div class="helper" style="text-align:center;padding:18px">
          No verified job ads yet. Click <b>Paste LinkedIn/Indeed links</b> to add exact postings.
        </div>`;
      const btn = document.getElementById('loadMoreBtn');
      if (btn){
        btn.style.display = end < filtered.length ? '' : 'none';
        btn.onclick = () => { JOBS_STATE.page++; renderJobsGrid(); };
      }
    }
    function wireToolbar(){
      const bindSeg = (segId, key) => {
        const seg = document.getElementById(segId); if (!seg) return;
        seg.querySelectorAll('button').forEach(btn=>{
          const v = btn.getAttribute('data-val');
          const setActive = () => {
            seg.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
            btn.classList.add('active');
          };
          if ((JOB_FILTER[key]==='any' && v==='any') || JOB_FILTER[key]===v) setActive();
          btn.onclick = () => { JOB_FILTER[key]=v; setActive(); JOBS_STATE.page = 0; renderJobsGrid(); };
        });
      };
      bindSeg('modeSeg','mode'); bindSeg('bucketSeg','bucket');
    }

    /* ===== Render results ===== */
function donutSVG(percent, label){
  const r = 28, c = 2 * Math.PI * r, off = c * (1 - percent / 100);
  const stroke = bandColor(scoreBand(percent));
  return `
    <div class="donut" role="img" aria-label="Score ${percent}%">
      <svg viewBox="0 0 72 72">
        <circle cx="36" cy="36" r="${r}" fill="none" stroke="rgba(148,163,184,.25)" stroke-width="8"/>
        <circle cx="36" cy="36" r="${r}" fill="none" stroke="${stroke}" stroke-width="8"
                stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}"
                transform="rotate(-90 36 36)"/>
      </svg>
      <div class="center">${label}</div>
    </div>`;
}

    const tipHTML = inner => `
      <span class="tip">
        <button class="tip-btn" type="button" aria-label="More info">i</button>
        <span class="tip-bubble" role="tooltip">${inner}<span class="arrow" aria-hidden="true"></span></span>
      </span>`;


/* === Color helpers for score visuals === */
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

/* Colorized donut (solid ring in green/yellow/red) */
function donutSVG(percent, label){
  const r = 28, c = 2 * Math.PI * r, off = c * (1 - percent / 100);
  const stroke = bandColor(scoreBand(percent));
  return `
    <svg class="donut" viewBox="0 0 72 72" role="img" aria-label="Score ${percent}%">
      <circle cx="36" cy="36" r="${r}" fill="none" stroke="rgba(148,163,184,.25)" stroke-width="8"/>
      <circle cx="36" cy="36" r="${r}" fill="none" stroke="${stroke}" stroke-width="8" stroke-linecap="round"
              stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 36 36)"/>
    </svg>
    <div class="center">${label}</div>`;
}




    function analyze(){
      const gate = canConsumeScan(); if (!gate.ok){ openPaywall(); return; }

      const resume=document.getElementById('resume').value;
      const jd=document.getElementById('jd').value;
      const keywords=(document.getElementById('keywords').value||'').split(/,|\n/).map(s=>s.trim()).filter(Boolean);
      const result=scoreResume(resume,jd,keywords);

      consumeScan(gate.mode);

      const present=(result.presentKeywords||[]);
      const missing=(result.missingKeywords||[]);
      const totalKW = present.length + missing.length;
      const covPct = Math.round((result.coverage||0)*100);
      const fre = fleschReadingEase(resume);

      // --- Friendlier, detailed tooltips ---
const presentSections = Object.entries(result.sectionPresence).filter(([,v])=>v).map(([k])=>k);
const missingSections = Object.entries(result.sectionPresence).filter(([,v])=>!v).map(([k])=>k);

const bullets      = result.profDetails.bullets;
const exclam       = result.profDetails.exclam;
const capsWords    = result.profDetails.capsWords;
const longLines    = result.profDetails.longLines;
const passiveHits  = result.profDetails.passive;
const wordCount    = result.profDetails.words;
const numbersUsed  = result.profDetails.numbers;

const readScore10  = result.breakdown.readability; // 0–10
const readLabel    = gradeReadability(readScore10);

const tipOverall = tipHTML(`
  <div style="font-weight:800;margin-bottom:4px">Overall score (0–100)</div>
  <div style="margin-bottom:8px">
    This is a weighted mix of everything below:<br>
    <b>ATS</b> (up to 40) + <b>Professionalism</b> (up to 35) + <b>Structure</b> (up to 15) + <b>Readability</b> (up to 10).
  </div>
  <div style="margin-bottom:6px">
    <b>How we color it</b>: 85–100 = green, 55–84 = yellow, &lt;55 = red.
  </div>
  <div>
    Aim for green overall. Yellow usually means “a few targeted fixes will push this over the line.”
  </div>
`);

const tipATS = tipHTML(`
  <div style="font-weight:800;margin-bottom:4px">ATS keywords (0–40)</div>
  <div style="margin-bottom:8px">
    <b>What it means</b>: How well your wording matches the job post.<br>
    <b>How we score</b>: <b>40 × keyword coverage</b> (matches ÷ total keywords).
  </div>
  <div style="margin-bottom:8px">
    <b>Your scan</b>: ${present.length} matched of ${totalKW} (${covPct}% coverage). 
    ${missing.length ? `Missing examples: <i>${missing.slice(0,8).join(', ')}</i>.` : `No obvious gaps—nice!`}
  </div>
  <div>
    <b>Human tip</b>: Mirror the job’s phrasing exactly where it’s natural. If they say “<i>Power BI</i>,” prefer that over “BI dashboards.” Work those terms into bullets that describe real outcomes.
  </div>
`);

const tipPRO = tipHTML(`
  <div style="font-weight:800;margin-bottom:4px">Professionalism (0–35)</div>
  <div style="margin-bottom:8px">
    <b>What helps</b>: clear bullets, real numbers, sensible length.<br>
    <b>What hurts</b>: shouty ALL-CAPS, passive voice, extra-long lines, exclamation marks.
  </div>
  <div style="margin-bottom:8px">
    <b>Your scan</b>:
    <ul style="margin:6px 0 0 18px; padding:0">
      <li>Bullets: <b>${bullets}</b> (aim ~5–7 for recent roles)</li>
      <li>Metrics used: <b>${numbersUsed}</b> (aim 3–5 wins like “cut cycle time 30%”)</li>
      <li>Passive phrases: <b>${passiveHits}</b> (keep &lt; 3; prefer “Built/Automated/Improved”)</li>
      <li>ALL-CAPS words: <b>${capsWords}</b> (minimize)</li>
      <li>Very long lines (&gt;160 chars): <b>${longLines}</b> (break into bullets)</li>
      <li>Word count: <b>${wordCount}</b> (sweet spot ≈ 400–700 for a one-pager)</li>
      <li>Exclamation marks: <b>${exclam}</b> (skip them—let results carry the energy)</li>
    </ul>
  </div>
  <div>
    <b>Human tip</b>: Start bullets with strong verbs, then impact + metric (who/what/how much). Keep one idea per bullet.
  </div>
`);

const tipSTRUCT = tipHTML(`
  <div style="font-weight:800;margin-bottom:4px">Structure (0–15)</div>
  <div style="margin-bottom:8px">
    <b>What it checks</b>: the essential sections are there and easy to spot.
  </div>
  <div style="margin-bottom:8px">
    <b>Present</b>: ${presentSections.length ? presentSections.join(', ') : '—'}<br>
    <b>Missing</b>: ${missingSections.length ? `<i>${missingSections.join(', ')}</i>` : 'None—great!'}
  </div>
  <div>
    <b>Human tip</b>: Use simple headings (no fancy templates), one column, and consistent formatting. Export to a text-based PDF.
  </div>
`);

const tipREAD = tipHTML(`
  <div style="font-weight:800;margin-bottom:4px">Readability (0–10)</div>
  <div style="margin-bottom:8px">
    We convert the Flesch Reading Ease (0–100) to a 0–10 score.<br>
    <b>Your Flesch</b>: <b>${fre}</b> → <b>${readScore10}/10</b> (<i>${readLabel}</i>).
  </div>
  <div>
    <b>Human tip</b>: Keep sentences ~12–18 words, trim filler, split long lines into bullets, and prefer everyday words over jargon. If a line feels breathy when you read it out loud, break it up.
  </div>
`);


      const breakdown = [
  { label:'ATS',            val:result.breakdown.ats_keywords, max:40, short:'ATS' },
  { label:'Professionalism',val:result.breakdown.professionalism, max:35, short:'Prof.' },
  { label:'Structure',      val:result.breakdown.structure, max:15, short:'Struct.' },
  { label:'Readability',    val:result.breakdown.readability, max:10, short:'Read.' },
];

const bhtml = breakdown.map(d=>{
  const band = kpiBand(d.val, d.max);              // good | warn | bad
  const pctW = Math.round((d.val / d.max) * 100);  // width for bar
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

      const fixes = friendlyFixes(result, fre).join('') || '<li><div class="fix-row"><span class="pill p-low">Nice!</span><span class="fix-title">You’re in solid shape</span></div><p class="fix-body">Tailor a couple bullets to the job post.</p></li>';

      const jobs = recommendJobs(resume, result.presentKeywords);
      const relatedHTML = relatedJobsSectionHTML(jobs);
      const verifiedHTML = jobsSectionHTML(jobs);
      
      const out=document.getElementById('results');
      out.innerHTML=`
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

          <div style="margin-top:12px">
            <h3 class="card-title" style="margin:10px 0 6px">Keyword Coverage</h3>
            <div class="stack" aria-label="Keyword coverage stacked bar">
              <div class="ok" style="width:${covPct}%"></div><div class="gap" style="width:${100-covPct}%"></div>
            </div>
            <div class="metrics">
              <div class="metric"><b>${present.length}</b> matched</div>
              <div class="metric"><b>${missing.length}</b> missing</div>
              <div class="metric"><b>${covPct}%</b> coverage</div>
            </div>
          </div>

          <h3 class="card-title" style="margin:14px 0 6px">Structure Checklist</h3>
          <div class="section-pills">${sectionPills}</div>

          <h3 class="card-title" style="margin:14px 0 6px">Extracted from Job Description</h3>
          <div>${result.extractedKeywords.map(k=>`<span class='pill good'>${k}</span>`).join('')}</div>

          <h3 class="card-title" style="margin:14px 0 6px">Matched Keywords</h3>
          <div>${present.map(k=>`<span class='pill good'>${k}</span>`).join('') || '<span class="pill bad">No matches yet</span>'}</div>

          <h3 class="card-title" style="margin:14px 0 6px">Missing Keywords</h3>
          <div>${missing.map(k=>`<span class='pill bad'>${k}</span>`).join('') || '<span class="pill good">No gaps detected</span>'}</div>

          <h3 class="card-title" style="margin:14px 0 6px">Readability & Tone</h3>
          <p class="helper" style="margin:0 0 8px">
            ${gradeReadability(result.breakdown.readability)}. Bullets: <b>${result.profDetails.bullets}</b>,
            metrics used: <b>${result.profDetails.numbers}</b>, passive uses: <b>${result.profDetails.passive}</b>.
          </p>

          <h3 class="card-title" style="margin:14px 0 6px">Top Fixes</h3>
          <ul class="list-tight">${fixes}</ul>

          ${relatedHTML}
          ${verifiedHTML}
        </div>`;

// After:  <div class="rating">...</div> is rendered
const ratingEl = out.querySelector('.results-head .rating');
if (ratingEl){
  ratingEl.classList.remove('good','warn','bad');
  ratingEl.classList.add(scoreBand(result.total));
}





      wireToolbar();
      renderJobsGrid();
    }

    /* ===== Upload handling ===== */
    const fileInput = document.getElementById('resumeFile');
    const fileLabel = document.getElementById('fileLabel');
    const dropzone  = document.getElementById('dropzone');
    const scanSpinner = document.getElementById('scanSpinner');
    const scanText = document.getElementById('scanText');
    document.getElementById('btnPick').addEventListener('click', ()=> fileInput.click());
    fileInput.addEventListener('change', e => { if (e.target.files?.[0]) handleResumeFile(e.target.files[0]); });
    ['dragenter','dragover'].forEach(ev=> dropzone.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.add('drag'); }));
    ['dragleave','drop'].forEach(ev=> dropzone.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.remove('drag'); }));
    dropzone.addEventListener('drop', e=>{ const f = e.dataTransfer?.files?.[0]; if (f) handleResumeFile(f); });

    function setScanStatus(msg, spinning=false){
      const led = document.getElementById('statusLed');
      const spin = document.getElementById('scanSpinner');
      const txt  = document.getElementById('scanText');
      const m = String(msg||'').toLowerCase();
      led.classList.remove('ready','scanning','done','error');
      if (spinning){ led.classList.add('scanning'); spin.classList.add('show'); }
      else { spin.classList.remove('show'); if (/(error|unsupported|fail)/.test(m)) led.classList.add('error'); else if (/(extracted|success|done|✓|scored)/.test(m)) led.classList.add('done'); else led.classList.add('ready'); }
      txt.textContent = msg;
    }

    async function handleResumeFile(file){
      fileLabel.textContent = file.name;
      setScanStatus('Scanning...', true);
      try{
        const ext = file.name.split('.').pop().toLowerCase();
        let text = '';
        if (ext === 'pdf'){ text = await extractTextFromPDF(file); }
        else if (ext === 'docx'){ text = await extractTextFromDOCX(file); }
        else if (ext === 'txt'){ text = await file.text(); }
        else if (ext === 'rtf'){
          const raw = await file.text();
          text = raw.replace(/\\'[0-9a-fA-F]{2}/g,' ').replace(/\\[a-z]+\d*/g,' ').replace(/[{}]/g,' ').replace(/\\par/g,'\n');
        } else { setScanStatus('Unsupported file type. Use PDF, DOCX, or TXT.', false); return; }
        text = (text||'').trim();
        if (text.length < 20){
          setScanStatus('Could not extract much text — is it a scanned image PDF?', false);
          document.getElementById('resume').value = text; return;
        }
        document.getElementById('resume').value = text;
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

    /* ===== Paywall & misc ===== */
  function openPaywall(n=1){
    window.__desiredCredits = n;
    document.getElementById('paywall').classList.add('open');
    document.body.classList.add('modal-open');   // lock background scroll (iOS friendly)
  }
  function closePaywall(){
    document.getElementById('paywall').classList.remove('open');
    document.body.classList.remove('modal-open'); // unlock
  }

async function startCheckout(n = 1){
  if (!stripe) { alert('Payment library not loaded yet. Please retry.'); return; }
  const priceId = PRICE_IDS[n];
  if (!priceId){ alert('Unknown product'); return; }

  // close the paywall; we’ll show the Stripe overlay
  closePaywall();

  // 1) Create PaymentIntent via your Lambda (server looks up Price and sets the amount)
  const res = await fetch(`${API_BASE_URL}/create-payment-intent`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ 
      priceId, 
      quantity: 1,
      token: CREDIT_TOKEN,          // NEW
      credits: n                    // NEW: 1, 10, or 20
    })
  });
  const data = await res.json();
  if (!res.ok || !data.client_secret){
    alert(data.error || 'Error creating payment'); 
    return;
  }
  clientSecret = data.client_secret;

  // ensure any previous instance is gone
  try { if (paymentElement) paymentElement.unmount(); } catch(_) {}
  paymentElement = null;
  elements = null;

  // 2) Mount Payment Element inside our checkout modal
  elements = stripe.elements({
  clientSecret,
  appearance: {
    theme: 'night',
    variables: {
      colorPrimary: '#f26e8c',      // --accent
      colorPrimaryText: '#0b1020',
      colorBackground: '#0d1422',   // --panel
      colorText: '#f7f9ff',         // --text
      colorTextSecondary: '#aeb7c6',// --muted
      colorDanger: '#ef4444',       // --bad
      fontFamily: "'Inter', system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
      borderRadius: '16px'          // --radius
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

  openCheckout();

  // 3) Wire the Pay Now button (idempotently)
  const payBtn = document.getElementById('pay-now');
const msg    = document.getElementById('checkout-msg');

let paying = false;
payBtn.onclick = async () => {
  if (paying) return;            // prevent double submit
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

  // small delay so the user sees success, then clean close
  setTimeout(() => { paying = false; closeCheckout(); }, 1200);
};

}

async function claimCredits({ retries = 6, delay = 400 } = {}) {
  const url = `${API_BASE_URL}/credits?token=${encodeURIComponent(CREDIT_TOKEN)}`;

  for (let i = 0; i < retries; i++) {
    const r = await fetch(url, { cache: 'no-store' });
    if (r.ok) {
      const { credits = 0 } = await r.json();
      if (credits > 0) {
        // add to your local balance
        if (typeof addCredits === 'function') addCredits(credits);

        // force badge/pill redraw if you have a renderer
        if (typeof renderCreditBadges === 'function') renderCreditBadges();
        if (typeof updateCreditUI === 'function') updateCreditUI();

        return credits;
      }
    }
    // webhook may not have written yet — wait and try again
    await new Promise(res => setTimeout(res, delay));
    delay = Math.min(delay * 1.6, 3000); // backoff up to 3s
  }
  return 0;
}


    function addCredits(n){ writeMeter({creditAdd:n}); }
    function clearAll(){
      document.getElementById('resume').value='';
      document.getElementById('jd').value='';
      document.getElementById('keywords').value='';
      document.getElementById('results').innerHTML = `
        <div style="text-align:center;color:var(--muted)">
          <div style="width:44px;height:44px;border-radius:9999px;margin:8px auto;background:linear-gradient(135deg,#ffd34d,#f26e8c)"></div>
          <h3 style="margin:6px 0 4px;color:var(--text)">Ready to score your resume</h3>
          <div class="helper">Paste your resume and click <b>Analyze</b>.</div>
        </div>`;
      fileInput.value = '';
      fileLabel.textContent = 'Choose PDF, DOCX, or TXT';
      setScanStatus('Ready', false);
    }

    updateMeterUI();
    updatePricingUI();
    setScanStatus('Ready', false);
    document.addEventListener('DOMContentLoaded', () => { claimCredits(); });

