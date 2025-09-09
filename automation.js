// automation.js — multi-project batch, single session, navigate by internal clicks (no direct goto to list/details)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---- STATIC login selectors (as you asked) ----
const USERNAME_SELECTOR = '#username';
const PASSWORD_PRIMARY_SELECTOR = '#password';
const PASSWORD_FALLBACKS = ['input[name="password"]', 'input[type="password"]'];

// ---- Form/modal selectors ----
const SEL_COMM_TYPE = '#communication_type';
const SEL_COMM_WITH_CLIENT = '#communicate_does_not';
const SEL_MEETING_TYPE = '#meeting_type'; // multiple
const SEL_COMMENTS = '#comments';

async function ensureDir(p){ if(!fs.existsSync(p)) fs.mkdirSync(p,{recursive:true}); }
async function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
function isOnLoginPage(page){ return /\/manager\/login\b/i.test(page.url()); }
function originFrom(urlStr){ const u=new URL(urlStr); return `${u.protocol}//${u.host}`; }
function detailsPathFromURL(projectURL){ const u=new URL(projectURL); return u.pathname+(u.search||'')+(u.hash||''); }
function toArray(v){ if(!v) return []; if(Array.isArray(v)) return v; return String(v).split(/[;,]/).map(s=>s.trim()).filter(Boolean); }
function normalizeCommWithClient(v){
  if(!v) return v;
  const x=String(v).trim().toLowerCase();
  if(['successfully communicated','successfully communicate','communicated successfully'].includes(x)) return 'Successfully Communicate';
  if(['communicate cannot be done','communicate can not be done'].includes(x)) return 'Communicate Can Not Be Done';
  return v;
}

async function clickOne(page, candidates){
  for(const c of candidates){
    try{
      if(typeof c==='object' && c.role==='button'){
        await page.getByRole('button',{name:c.name}).first().click({timeout:c.timeout||5000});
        console.log(`CLICK OK → role:button name=${c.name}`); return true;
      }
      if(typeof c==='string'){
        await page.locator(c).first().click({timeout:5000});
        console.log(`CLICK OK → ${c}`); return true;
      }
    }catch{}
  }
  return false;
}

async function assertLoggedIn(page, artifactsDir, stageLabel){
  // We’re “logged in” only if we are NOT at /manager/login and we can see any app chrome.
  if (!isOnLoginPage(page)) {
    // extra sanity: page has any /manager/ link or a sidebar/header
    const anyLink = await page.locator('a[href*="/manager/"]').count().catch(()=>0);
    console.log(`LOGIN SANITY (${stageLabel}): url=${page.url()} title="${await page.title()}" linksToManager=${anyLink}`);
    if (anyLink>0) return;
  }
  // Dump for debug then throw
  const stamp = Date.now();
  const html = path.join(artifactsDir, `login-still-${stageLabel}-${stamp}.html`);
  const png  = path.join(artifactsDir, `login-still-${stageLabel}-${stamp}.png`);
  await fs.promises.writeFile(html, await page.content()).catch(()=>{});
  await page.screenshot({path: png, fullPage:true}).catch(()=>{});
  console.log('Saved debug (still on login):', html, png);
  throw new Error(`Still on login page after ${stageLabel}`);
}

async function login(page, env, artifactsDir){
  console.log('STEP 1: goto login', env.LOGIN_URL);
  await page.goto(env.LOGIN_URL, { waitUntil: 'domcontentloaded' });

  console.log('STEP 2: wait for username', USERNAME_SELECTOR);
  await page.waitForSelector(USERNAME_SELECTOR, { timeout: 30000 });

  console.log('STEP 3: fill username');
  await page.fill(USERNAME_SELECTOR, env.LOGIN_USERNAME);

  console.log('STEP 4: fill password (primary then fallbacks)');
  let filled=false;
  try { await page.fill(PASSWORD_PRIMARY_SELECTOR, env.LOGIN_PASSWORD, {timeout:8000}); filled=true; console.log('PASSWORD OK → #password'); } catch{}
  if(!filled){
    for(const fb of PASSWORD_FALLBACKS){
      try { await page.fill(fb, env.LOGIN_PASSWORD, {timeout:5000}); filled=true; console.log(`PASSWORD OK (fallback) → ${fb}`); break; } catch{}
    }
  }
  if(!filled) throw new Error('Could not locate password field');

  console.log('STEP 8: click Login (multiple strategies)');
  const clicked = await clickOne(page, [
    { role:'button', name:/login/i },
    'button[type="submit"]',
    'input[type="submit"]',
    'text=/^\\s*Login\\s*$/i',
  ]);
  if(!clicked) throw new Error('Could not find Login submit');

  await page.waitForLoadState('networkidle', { timeout: 20000 });
  // POSITIVE assertion we’re actually logged in:
  await assertLoggedIn(page, artifactsDir, 'submit');
  console.log('LOGIN OK');
}

async function reloginIfKicked(page, env, artifactsDir){
  if(!isOnLoginPage(page)) return false;
  console.log('INFO: Redirected to login — re-authenticating…');
  await login(page, env, artifactsDir);
  return true;
}

/**
 * Open the Project List by clicking an internal menu/anchor (NOT by goto).
 * You can set PROJECT_LIST_MENU_SELECTOR to force a selector, otherwise we try common candidates.
 */
async function openProjectListByClick(page, env, artifactsDir){
  const origin = originFrom(env.LOGIN_URL);
  const candidates = [
    env.PROJECT_LIST_MENU_SELECTOR, // exact selector provided by you (optional)
    'a[href*="/manager/project"]',
    'a:has-text("Project")',
    'a:has-text("Projects")',
    'nav a:has-text("Project")',
    'nav a:has-text("Projects")',
    'aside a:has-text("Project")',
    'aside a:has-text("Projects")',
  ].filter(Boolean);

  // Try to find a visible candidate
  let foundSel = null;
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state:'visible', timeout: 4000 });
      // Prefer links that actually go to our origin
      const href = await loc.getAttribute('href').catch(()=>null);
      if (href && /^https?:\/\//i.test(href) && !href.startsWith(origin)) {
        // skip cross-origin
      }
      foundSel = sel;
      // Click with navigation wait
      console.log('OPEN LIST: clicking', sel, 'href=', href);
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 30000 }),
        loc.click({ timeout: 5000 })
      ]);
      break;
    } catch {}
  }

  // If nothing visible yet, try expanding any hamburger/menus then retry once
  if (!foundSel) {
    console.log('OPEN LIST: expanding menus (if any) then retry…');
    const expanders = [
      'button.navbar-toggler',
      'button:has-text("Menu")',
      'button[aria-label="Menu"]',
      '.dropdown-toggle',
      'button:has-text("More")'
    ];
    for (const ex of expanders) {
      try {
        if (await page.locator(ex).first().isVisible({ timeout: 1000 })) {
          await page.locator(ex).first().click({ timeout: 1000 }).catch(()=>{});
        }
      } catch {}
    }
    for (const sel of candidates) {
      try {
        const loc = page.locator(sel).first();
        await loc.waitFor({ state:'visible', timeout: 3000 });
        const href = await loc.getAttribute('href').catch(()=>null);
        console.log('OPEN LIST: clicking', sel, 'href=', href);
        await Promise.all([
          page.waitForLoadState('networkidle', { timeout: 30000 }),
          loc.click({ timeout: 5000 })
        ]);
        foundSel = sel;
        break;
      } catch {}
    }
  }

  if (!foundSel) {
    const stamp = Date.now();
    const html = path.join(artifactsDir, `no-list-link-${stamp}.html`);
    const png  = path.join(artifactsDir, `no-list-link-${stamp}.png`);
    await fs.promises.writeFile(html, await page.content()).catch(()=>{});
    await page.screenshot({ path: png, fullPage:true }).catch(()=>{});
    console.log('Saved debug (no list link found):', html, png);
    throw new Error('Could not find a Project List menu/link in the UI');
  }

  // After click, confirm we are not on login
  if (await reloginIfKicked(page, env, artifactsDir)) {
    // If we were bounced and re-logged, try clicking the menu once more
    console.log('OPEN LIST RETRY: clicking menu again after re-login');
    await openProjectListByClick(page, env, artifactsDir);
    return;
  }

  console.log('DEBUG (list) URL:', page.url());
  console.log('DEBUG (list) TITLE:', await page.title());

  // Optional readiness selector for the list page
  if (env.PROJECT_LIST_READY_SELECTOR && env.PROJECT_LIST_READY_SELECTOR.trim()) {
    const readySel = env.PROJECT_LIST_READY_SELECTOR.trim();
    console.log('CHECK: PROJECT_LIST_READY_SELECTOR →', readySel);
    try {
      await page.waitForSelector(readySel, { timeout: 12000 });
      console.log('READY OK →', readySel);
    } catch (e) {
      console.log('READY WARN →', readySel, e.message);
      const stamp = Date.now();
      await page.screenshot({ path: path.join(artifactsDir, `list-not-ready-${stamp}.png`), fullPage:true }).catch(()=>{});
    }
  }
}

/**
 * On the Project List page, click the anchor whose href contains the specific details token.
 * (Again, using click navigation, not goto)
 */
async function clickProjectDetailsFromList(page, projectURL){
  const token = detailsPathFromURL(projectURL); // e.g. /manager/project/details/MTQ2Mg==
  const selector = `a[href*="${token.replace(/"/g,'\\"')}"]`;

  // Quick scan log
  const allDetailsSel = 'a[href*="/manager/project/details/"]';
  const total = await page.locator(allDetailsSel).count().catch(()=>0);
  console.log(`SCAN: total details links via ${allDetailsSel} = ${total}`);

  let count = await page.locator(selector).count().catch(()=>0);
  console.log(`FIND: "${selector}" = ${count}`);
  if (count === 0) throw new Error('Project link not found on the Project List page');

  // Click with navigation wait
  for (let i=1; i<=3; i++) {
    try {
      const link = page.locator(selector).first();
      await link.waitFor({ state:'visible', timeout: 4000 });
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 45000 }),
        link.click({ timeout: 5000 })
      ]);
      console.log(`CLICK OK → project details link (try ${i}/3)`);
      break;
    } catch (e) {
      console.log(`CLICK RETRY ${i}/3 →`, e.message);
      if (i===3) throw e;
    }
  }

  console.log('DEBUG URL (after click):', page.url());
  console.log('DEBUG TITLE (after click):', await page.title());
  if (!page.url().includes(token)) throw new Error('After click, not on project details page');
}

async function openCallLogAndSubmit(page, env, proj, idxTag, artifactsDir){
  const nowTag = new Date().toISOString().replace(/[:.]/g,'-');
  const COMM_WITH_CLIENT = normalizeCommWithClient(proj.comm_with_client||'');
  const CALL_TYPES = toArray(proj.call_types||proj.call_type);

  // Open Call Log modal
  console.log('STEP 11: open Call Log modal');
  const btnSelector = env.CALL_LOG_BUTTON_SELECTOR || 'button[data-target="#call_log_model"]';
  await page.evaluate(()=>window.scrollTo(0,0)).catch(()=>{});
  try { await page.locator('.header.align-right').first().scrollIntoViewIfNeeded().catch(()=>{});} catch {}
  let opened=false;
  for(let i=1;i<=4 && !opened;i++){
    try{
      await page.locator(btnSelector).first().waitFor({state:'visible',timeout:4000});
      await page.locator(btnSelector).first().click({timeout:3000});
      console.log(`CLICK OK → ${btnSelector} (try ${i}/4)`);
      opened=true;
    }catch(e){ console.log(`CLICK RETRY ${i}/4 → ${e.message}`); await wait(250); }
  }
  if(!opened){
    try{ await page.getByRole('button',{name:/call\s*log/i}).first().click({timeout:3000}); console.log('CLICK OK → role:button Call Log'); opened=true; }catch{}
  }
  if(!opened){
    const headerHtml = await page.locator('.header.align-right').first().innerHTML().catch(()=>null);
    if(headerHtml){
      const f = path.join(artifactsDir,`header-${idxTag}-${nowTag}.html`);
      await fs.promises.writeFile(f, headerHtml).catch(()=>{});
      console.log('Saved header HTML:', f);
    }
    throw new Error('Could not find the "Call Log" button');
  }

  console.log('STEP 12: wait for modal');
  await Promise.race([
    page.getByRole('dialog',{name:/call\s*log/i}).waitFor({state:'visible',timeout:10000}),
    page.waitForSelector('button:has-text("SUBMIT DETAILS"), text=/SUBMIT DETAILS/i',{timeout:10000})
  ]).catch(()=>{});
  await page.screenshot({ path: path.join(artifactsDir, `modal-${idxTag}-${nowTag}.png`) }).catch(()=>{});
  console.log('Saved modal screenshot');

  // Fill fields
  if (proj.comm_type) {
    console.log('STEP 13: set Communication Type:', proj.comm_type);
    try {
      await page.selectOption(SEL_COMM_TYPE, { label: proj.comm_type });
      await page.locator('[data-id="communication_type"] .filter-option').getByText(proj.comm_type,{exact:false}).waitFor({timeout:2000}).catch(()=>{});
      console.log('COMM_TYPE OK');
    } catch(e){ console.log('COMM_TYPE WARN:', e.message); }
  }
  if (COMM_WITH_CLIENT) {
    console.log('STEP 14: set Communicate With Client:', COMM_WITH_CLIENT);
    try {
      await page.selectOption(SEL_COMM_WITH_CLIENT, { label: COMM_WITH_CLIENT });
      await page.locator('[data-id="communicate_does_not"] .filter-option').getByText(COMM_WITH_CLIENT,{exact:false}).waitFor({timeout:2000}).catch(()=>{});
      console.log('COMM_WITH_CLIENT OK');
    } catch(e){ console.log('COMM_WITH_CLIENT WARN:', e.message); }
  }
  const callTypes = CALL_TYPES;
  console.log('STEP 15: set Call Type(s):', callTypes.length?callTypes.join(', '):'(none)');
  if (callTypes.length) {
    try { await page.selectOption(SEL_MEETING_TYPE, callTypes.map(label=>({label}))); console.log('CALL TYPES OK'); }
    catch(e){
      console.log('CALL TYPES fallback: clicking list items');
      for(const label of callTypes){
        const item = page.locator('.ms-container .ms-selectable .ms-elem-selectable span', {hasText:label});
        try { await item.first().click({timeout:1500}); console.log('Clicked ms item:', label); } catch { console.log('Could not click ms item:', label); }
      }
    }
  }
  if (proj.comments) {
    console.log('STEP 16: fill Comments');
    try { await page.fill(SEL_COMMENTS, proj.comments); console.log('COMMENTS OK'); }
    catch(e){
      console.log('COMMENTS WARN:', e.message);
      const fb=['textarea[name="comments"]','textarea','input[name*="comment" i]'];
      for(const sel of fb){ try { await page.fill(sel, proj.comments, {timeout:1000}); console.log('COMMENTS fallback OK →', sel); break; } catch{} }
    }
  }

  // Submit
  console.log('STEP 17: submit details');
  const okSubmit = await clickOne(page, [
    { role:'button', name:/submit details/i },
    'text=/SUBMIT DETAILS/i',
    env.FORM_SUBMIT_SELECTOR,
    'button[type="submit"]'
  ]);
  if(!okSubmit) throw new Error('Could not find "SUBMIT DETAILS"');

  await page.waitForLoadState('networkidle', { timeout: 20000 });
  if (env.CONFIRM_SELECTOR) {
    console.log('STEP 18: wait for confirm', env.CONFIRM_SELECTOR);
    try { await page.locator(env.CONFIRM_SELECTOR).waitFor({state:'visible',timeout:15000}); console.log('CONFIRM OK'); }
    catch { console.log('WARN: confirm not seen'); }
  }

  console.log('DONE: call log submitted');
}

function loadProjectsFromEnv(){
  if(!process.env.PROJECTS_JSON || !process.env.PROJECTS_JSON.trim()) throw new Error('PROJECTS_JSON is required');
  let arr;
  try { arr = JSON.parse(process.env.PROJECTS_JSON); } catch(e){ throw new Error('Invalid PROJECTS_JSON: '+e.message); }
  if(!Array.isArray(arr) || arr.length===0) throw new Error('PROJECTS_JSON must be a non-empty array');
  return arr.map(o=>({
    project_url: o.project_url || o.PROJECT_URL || o.url,
    comm_type: o.comm_type || o.COMM_TYPE,
    comm_with_client: o.comm_with_client || o.COMM_WITH_CLIENT,
    call_types: o.call_types ?? o.CALL_TYPES ?? o.call_type ?? o.CALL_TYPE,
    comments: o.comments || o.COMMENTS
  })).filter(p=>p.project_url);
}

(async ()=>{
  const headless = process.env.PWDEBUG ? false : true;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const artifactsDir = path.join(process.cwd(), 'artifacts');
  await ensureDir(artifactsDir);

  const env = {
    LOGIN_URL: process.env.LOGIN_URL,
    LOGIN_USERNAME: process.env.LOGIN_USERNAME,
    LOGIN_PASSWORD: process.env.LOGIN_PASSWORD,
    WORKPLACE: process.env.WORKPLACE || '',
    DESK_NUMBER: process.env.DESK_NUMBER || '',
    REMEMBER_ME: (process.env.REMEMBER_ME || '').toLowerCase(),
    CALL_LOG_BUTTON_SELECTOR: process.env.CALL_LOG_BUTTON_SELECTOR || null,
    FORM_SUBMIT_SELECTOR: process.env.FORM_SUBMIT_SELECTOR || null,
    CONFIRM_SELECTOR: process.env.CONFIRM_SELECTOR || null,
    // NEW: allow forcing the menu selector to open the list (strongly recommended once you know it)
    PROJECT_LIST_MENU_SELECTOR: process.env.PROJECT_LIST_MENU_SELECTOR || '',
    PROJECT_LIST_READY_SELECTOR: process.env.PROJECT_LIST_READY_SELECTOR || ''
  };

  try{
    console.log('BOOT: starting automation.js');
    const projects = loadProjectsFromEnv();
    console.log(`BATCH: ${projects.length} project(s) to process`);

    if(!env.LOGIN_URL || !env.LOGIN_USERNAME || !env.LOGIN_PASSWORD) throw new Error('Missing LOGIN_* env');

    // Login once with positive assertion
    await login(page, env, artifactsDir);

    for (let i=0; i<projects.length; i++){
      const idxTag = `${i+1}/${projects.length}`;
      const proj = projects[i];
      try {
        console.log(`\n=== PROJECT ${idxTag}: ${proj.project_url} ===`);
        console.log('STEP 10: open Project List via internal click (no direct goto)');
        await openProjectListByClick(page, env, artifactsDir);
        await assertLoggedIn(page, artifactsDir, 'after-open-list');

        console.log('STEP 10b: click project details link from list');
        await clickProjectDetailsFromList(page, proj.project_url);
        await assertLoggedIn(page, artifactsDir, 'after-open-details');

        await openCallLogAndSubmit(page, env, proj, idxTag, artifactsDir);
      } catch(e){
        console.error(`ERROR: Project ${idxTag} failed:`, e.message || e);
        try{
          const snap = path.join(artifactsDir, `error-${i+1}.png`);
          await page.screenshot({ path: snap, fullPage: true }).catch(()=>{});
          console.log('Saved error screenshot:', snap);
          const html = path.join(artifactsDir, `page-${i+1}.html`);
          await fs.promises.writeFile(html, await page.content()).catch(()=>{});
          console.log('Saved page HTML:', html);
        }catch{}
      }
    }
  } catch(e){
    console.error('FATAL:', e && e.stack ? e.stack : e);
  } finally {
    await browser.close();
  }
})();
