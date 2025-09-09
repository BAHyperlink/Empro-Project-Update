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
    'nav
