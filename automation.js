// automation.js — multi-project, single login, navigate via Project List (internal click flow)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---- STATIC login selectors ----
const USERNAME_SELECTOR = '#username';
const PASSWORD_PRIMARY_SELECTOR = '#password';
const PASSWORD_FALLBACKS = ['input[name="password"]', 'input[type="password"]'];

// ---- Modal field selectors ----
const SEL_COMM_TYPE = '#communication_type';
const SEL_COMM_WITH_CLIENT = '#communicate_does_not';
const SEL_MEETING_TYPE = '#meeting_type';   // multiple
const SEL_COMMENTS = '#comments';

async function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
async function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

function originFrom(urlStr) { const u = new URL(urlStr); return `${u.protocol}//${u.host}`; }
function defaultProjectListURL(loginURL) { return `${originFrom(loginURL)}/manager/project`; }
function isOnLoginPage(page) { return /\/manager\/login/i.test(page.url()); }

function normalizeCommWithClient(v) {
  if (!v) return v;
  const x = String(v).trim().toLowerCase();
  if (x === 'successfully communicated' || x === 'successfully communicate' || x === 'communicated successfully')
    return 'Successfully Communicate';
  if (x === 'communicate cannot be done' || x === 'communicate can not be done')
    return 'Communicate Can Not Be Done';
  return v;
}
function toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return String(val).split(/[;,]/).map(s => s.trim()).filter(Boolean);
}
function detailsPathFromURL(projectURL) {
  // e.g. https://host/manager/project/details/MTQ2Mg== -> /manager/project/details/MTQ2Mg==
  const u = new URL(projectURL);
  return u.pathname + (u.search || '') + (u.hash || '');
}

async function clickOne(page, candidates) {
  for (const sel of candidates) {
    if (!sel) continue;
    try {
      if (typeof sel === 'object' && sel.role === 'button') {
        await page.getByRole('button', { name: sel.name }).first().click({ timeout: sel.timeout || 5000 });
        console.log(`CLICK OK → role:button name=${sel.name}`); return sel;
      } else if (typeof sel === 'string') {
        await page.locator(sel).first().click({ timeout: 5000 });
        console.log(`CLICK OK → ${sel}`); return sel;
      }
    } catch {}
  }
  return null;
}

async function login(page, env) {
  console.log('STEP 1: goto login', env.LOGIN_URL);
  await page.goto(env.LOGIN_URL, { waitUntil: 'domcontentloaded' });

  console.log('STEP 2: wait for username', USERNAME_SELECTOR);
  await page.waitForSelector(USERNAME_SELECTOR, { timeout: 30000 });

  console.log('STEP 3: fill username');
  await page.fill(USERNAME_SELECTOR, env.LOGIN_USERNAME);

  console.log('STEP 4: fill password');
  let passFilled = false;
  try { await page.fill(PASSWORD_PRIMARY_SELECTOR, env.LOGIN_PASSWORD, { timeout: 8000 }); passFilled = true; console.log(`PASSWORD OK → ${PASSWORD_PRIMARY_SELECTOR}`);} catch {}
  if (!passFilled) {
    for (const fb of PASSWORD_FALLBACKS) {
      try { await page.fill(fb, env.LOGIN_PASSWORD, { timeout: 5000 }); passFilled = true; console.log(`PASSWORD OK (fallback) → ${fb}`); break; } catch {}
    }
  }
  if (!passFilled) throw new Error('Could not locate password field');

  if (env.WORKPLACE) {
    console.log('STEP 5: select Work Place =', env.WORKPLACE);
    try { await page.selectOption('select[name*="work" i], select#workplace', { label: env.WORKPLACE }); console.log('WORKPLACE OK'); }
    catch { console.log('WORKPLACE WARN: could not select (continuing)'); }
  }
  if (env.DESK_NUMBER) {
    console.log('STEP 6: fill Desk Number =', env.DESK_NUMBER);
    try { await page.fill('input[name*="desk" i], #desk_number', String(env.DESK_NUMBER)); console.log('DESK OK'); }
    catch { console.log('DESK WARN: not found (continuing)'); }
  }
  if (env.REMEMBER_ME) {
    const want = env.REMEMBER_ME === 'true' || env.REMEMBER_ME === 'yes';
    console.log('STEP 7: set Remember Me =', want);
    try {
      const cb = page.getByLabel('Remember Me', { exact: true });
      const checked = await cb.isChecked().catch(() => false);
      if (want && !checked) await cb.check();
      if (!want && checked) await cb.uncheck();
    } catch { console.log('Remember Me not found (ok)'); }
  }

  console.log('STEP 8: click Login');
  const clickedLogin = await clickOne(page, [
    { role: 'button', name: /login/i },
    'button[type="submit"]',
    'input[type="submit"]',
    'text=/^\\s*Login\\s*$/i',
    'text=/Sign in|Sign In/i'
  ]);
  if (!clickedLogin) throw new Error('Could not find Login submit button');

  await page.waitForLoadState('networkidle', { timeout: 20000 });
  if (env.POST_LOGIN_READY_SELECTOR) {
    console.log('STEP 9: wait for post-login selector', env.POST_LOGIN_READY_SELECTOR);
    await page.waitForSelector(env.POST_LOGIN_READY_SELECTOR, { timeout: 15000 });
  }
  console.log('LOGIN OK');
}

async function reloginIfKicked(page, env) {
  if (!isOnLoginPage(page)) return false;
  console.log('INFO: Redirected to login — re-authenticating...');
  await login(page, env);
  return true;
}

// NEW: Navigate via Project List page and click the internal link to details
async function goToProjectViaList(page, env, projectURL) {
  const listURL = env.PROJECT_LIST_URL || defaultProjectListURL(env.LOGIN_URL);
  const pathToken = detailsPathFromURL(projectURL); // e.g. /manager/project/details/MTQ2Mg==
  console.log('NAV: Project List →', listURL);
  await page.goto(listURL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 45000 });

  // If bounced, re-login once and re-open list
  if (isOnLoginPage(page)) {
    const relogged = await reloginIfKicked(page, env);
    if (relogged) {
      console.log('NAV RETRY: Project List after re-login');
      await page.goto(listURL, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 45000 });
    }
  }

  // Try to find an anchor whose href contains the details path token
  console.log('FIND: anchor with href containing:', pathToken);
  const linkSel = `a[href*="${pathToken.replace(/"/g, '\\"')}"]`;
  let count = 0;
  try { count = await page.locator(linkSel).count(); } catch { count = 0; }
  console.log(`FOUND ${count} matching link(s)`);

  // Optional: if there is a search box, try to filter by id/name (best-effort, non-fatal)
  if (count === 0) {
    // Heuristic: filter inputs commonly used in list pages
    const searchCandidates = ['input[type="search"]', 'input[name*="search" i]', 'input[placeholder*="Search" i]'];
    for (const sc of searchCandidates) {
      try {
        if (await page.locator(sc).first().isVisible({ timeout: 2000 })) {
          // Try searching by Base64 token and numeric id (if any)
          const base64Token = pathToken.split('/').pop();
          await page.fill(sc, base64Token);
          await wait(300);
          count = await page.locator(linkSel).count();
          console.log(`SEARCH "${base64Token}" → links: ${count}`);
          if (count > 0) break;
          // If base64 decodes cleanly into a number, try that
          try {
            const decoded = Buffer.from(base64Token, 'base64').toString('utf8');
            const maybeId = decoded.replace(/\D+/g,'');
            if (maybeId) {
              await page.fill(sc, maybeId);
              await wait(300);
              count = await page.locator(linkSel).count();
              console.log(`SEARCH "${maybeId}" → links: ${count}`);
              if (count > 0) break;
            }
          } catch {}
        }
      } catch {}
    }
  }

  if (count === 0) throw new Error('Project link not found on the Project List page');

  // Click the first link
  for (let i = 1; i <= 4; i++) {
    try {
      const link = page.locator(linkSel).first();
      await link.waitFor({ state: 'visible', timeout: 5000 });
      await link.scrollIntoViewIfNeeded().catch(()=>{});
      await wait(120);
      await link.click({ timeout: 4000 });
      console.log(`CLICK OK → list link (try ${i}/4)`);
      break;
    } catch (e) {
      console.log(`CLICK RETRY ${i}/4 list link:`, e.message);
      if (i === 4) throw e;
      await wait(300);
    }
  }

  await page.waitForLoadState('networkidle', { timeout: 45000 });
  console.log('DEBUG URL (after click):', page.url());
  console.log('DEBUG TITLE (after click):', await page.title());

  // As a guard, ensure we actually reached the details page path
  if (!page.url().includes(pathToken)) {
    throw new Error('After clicking list link, did not reach project details');
  }
}

async function submitCallLogForProject(page, env, proj, idxTag, artifactsDir) {
  const nowTag = new Date().toISOString().replace(/[:.]/g, '-');
  const COMM_WITH_CLIENT = normalizeCommWithClient(proj.comm_with_client || '');
  const CALL_TYPES = toArray(proj.call_types || proj.call_type);

  console.log(`\n=== PROJECT ${idxTag}: ${proj.project_url} ===`);
  console.log('STEP 10: navigate via Project List and click details link');
  try {
    await goToProjectViaList(page, env, proj.project_url);
  } catch (e) {
    // Save page for diagnostics
    const htmlPath = path.join(artifactsDir, `list-fail-${idxTag}-${nowTag}.html`);
    await fs.promises.writeFile(htmlPath, await page.content()).catch(()=>{});
    console.log('Saved Project List HTML for debug:', htmlPath);
    throw e;
  }

  // ----------- OPEN CALL LOG MODAL -----------
  console.log('STEP 11: open Call Log modal');
  const btnSelector = env.CALL_LOG_BUTTON_SELECTOR || 'button[data-target="#call_log_model"]';

  await page.evaluate(() => window.scrollTo(0, 0)).catch(()=>{});
  try { await page.locator('.header.align-right').first().scrollIntoViewIfNeeded().catch(()=>{}); } catch {}
  const btnCount = await page.locator(btnSelector).count().catch(() => 0);
  console.log(`STEP 11a: found ${btnCount} "Call Log" button(s) with selector: ${btnSelector}`);

  let opened = false;
  for (let i = 1; i <= 4 && !opened; i++) {
    try {
      await page.locator(btnSelector).first().waitFor({ state: 'visible', timeout: 4000 });
      await page.locator(btnSelector).first().scrollIntoViewIfNeeded().catch(()=>{});
      await wait(120);
      await page.locator(btnSelector).first().click({ timeout: 3000 });
      console.log(`CLICK OK → ${btnSelector} (try ${i}/4)`);
      opened = true;
    } catch (e) {
      console.log(`CLICK RETRY ${i}/4 → ${btnSelector}: ${e.message}`);
      await wait(300);
    }
  }
  if (!opened) {
    opened = await (async () => { try { await page.getByRole('button', { name: /call\s*log/i }).first().click({ timeout: 3000 }); console.log('CLICK OK → role:button Call Log'); return true; } catch { return false; }})();
  }
  if (!opened) {
    const headerHtml = await page.locator('.header.align-right').first().innerHTML().catch(()=>null);
    if (headerHtml) {
      const htmlPath = path.join(artifactsDir, `header-${idxTag}-${nowTag}.html`);
      await fs.promises.writeFile(htmlPath, headerHtml).catch(()=>{});
      console.log('Saved header HTML:', htmlPath);
    }
    throw new Error('Could not find the "Call Log" button');
  }

  console.log('STEP 12: wait for modal');
  await Promise.race([
    page.getByRole('dialog', { name: /call\s*log/i }).waitFor({ state: 'visible', timeout: 10000 }),
    page.waitForSelector('button:has-text("SUBMIT DETAILS"), text=/SUBMIT DETAILS/i', { timeout: 10000 })
  ]).catch(() => {});
  await page.screenshot({ path: path.join(artifactsDir, `modal-${idxTag}-${nowTag}.png`) }).catch(()=>{});
  console.log('Saved modal screenshot');

  // ----------- FILL FIELDS -----------
  if (proj.comm_type) {
    console.log('STEP 13: set Communication Type:', proj.comm_type);
    try {
      await page.selectOption(SEL_COMM_TYPE, { label: proj.comm_type });
      await page.locator('[data-id="communication_type"] .filter-option').getByText(proj.comm_type, { exact: false }).waitFor({ timeout: 2000 }).catch(()=>{});
      console.log('COMM_TYPE OK');
    } catch (e) { console.log('COMM_TYPE WARN:', e.message); }
  } else { console.log('STEP 13: Communication Type: (none)'); }

  if (COMM_WITH_CLIENT) {
    console.log('STEP 14: set Communicate With Client:', COMM_WITH_CLIENT);
    try {
      await page.selectOption(SEL_COMM_WITH_CLIENT, { label: COMM_WITH_CLIENT });
      await page.locator('[data-id="communicate_does_not"] .filter-option').getByText(COMM_WITH_CLIENT, { exact: false }).waitFor({ timeout: 2000 }).catch(()=>{});
      console.log('COMM_WITH_CLIENT OK');
    } catch (e) { console.log('COMM_WITH_CLIENT WARN:', e.message); }
  } else { console.log('STEP 14: Communicate With Client: (none)'); }

  const callTypes = toArray(CALL_TYPES);
  console.log('STEP 15: set Call Type(s):', callTypes.length ? callTypes.join(', ') : '(none)');
  if (callTypes.length) {
    try {
      await page.selectOption(SEL_MEETING_TYPE, callTypes.map(label => ({ label })));
      console.log('CALL TYPES OK');
    } catch (e) {
      console.log('CALL TYPES fallback: clicking list items');
      for (const label of callTypes) {
        const item = page.locator('.ms-container .ms-selectable .ms-elem-selectable span', { hasText: label });
        try { await item.first().click({ timeout: 1500 }); console.log('Clicked ms item:', label); }
        catch { console.log('Could not click ms item:', label); }
      }
    }
  }

  if (proj.comments) {
    console.log('STEP 16: fill Comments');
    try { await page.fill(SEL_COMMENTS, proj.comments); console.log('COMMENTS OK'); }
    catch (e) {
      console.log('COMMENTS WARN (fallbacks):', e.message);
      const fallbacks = ['textarea[name="comments"]', 'textarea', 'input[name*="comment" i]'];
      let ok = false;
      for (const sel of fallbacks) {
        try { await page.fill(sel, proj.comments, { timeout: 1000 }); console.log('COMMENTS fallback OK →', sel); ok = true; break; } catch {}
      }
      if (!ok) console.log('COMMENTS FAIL: not filled');
    }
  } else { console.log('STEP 16: Comments: (empty)'); }

  // SUBMIT
  console.log('STEP 17: submit details');
  const clickedSubmit = await clickOne(page, [
    { role: 'button', name: /submit details/i },
    'text=/SUBMIT DETAILS/i',
    env.FORM_SUBMIT_SELECTOR,
    'button[type="submit"]'
  ]);
  if (!clickedSubmit) throw new Error('Could not find "SUBMIT DETAILS" button');

  await page.waitForLoadState('networkidle', { timeout: 20000 });
  if (env.CONFIRM_SELECTOR) {
    console.log('STEP 18: wait for confirm', env.CONFIRM_SELECTOR);
    try { await page.locator(env.CONFIRM_SELECTOR).waitFor({ state: 'visible', timeout: 15000 }); console.log('CONFIRM OK'); }
    catch { console.log('WARN: confirm not seen (may still be fine)'); }
  }

  console.log(`DONE: Project ${idxTag} submitted`);
}

function loadProjectsFromEnv() {
  if (!process.env.PROJECTS_JSON || !process.env.PROJECTS_JSON.trim()) {
    throw new Error('PROJECTS_JSON is required (non-empty array).');
  }
  let arr;
  try { arr = JSON.parse(process.env.PROJECTS_JSON); }
  catch (e) { throw new Error('Invalid PROJECTS_JSON: ' + e.message); }
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('PROJECTS_JSON must be a non-empty array.');
  return arr.map(o => ({
    project_url: o.project_url || o.PROJECT_URL || o.url,
    comm_type: o.comm_type || o.COMM_TYPE,
    comm_with_client: o.comm_with_client || o.COMM_WITH_CLIENT,
    call_types: o.call_types ?? o.CALL_TYPES ?? o.call_type ?? o.CALL_TYPE,
    comments: o.comments || o.COMMENTS
  })).filter(p => p.project_url);
}

(async () => {
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
    POST_LOGIN_READY_SELECTOR: process.env.POST_LOGIN_READY_SELECTOR || '',
    CALL_LOG_BUTTON_SELECTOR: process.env.CALL_LOG_BUTTON_SELECTOR || null,
    FORM_SUBMIT_SELECTOR: process.env.FORM_SUBMIT_SELECTOR || null,
    CONFIRM_SELECTOR: process.env.CONFIRM_SELECTOR || null,
    PROJECT_LIST_URL: process.env.PROJECT_LIST_URL || ''
  };

  const results = [];
  try {
    console.log('BOOT: starting automation.js');
    const projects = loadProjectsFromEnv();
    console.log(`BATCH: ${projects.length} project(s) to process`);

    if (!env.LOGIN_URL || !env.LOGIN_USERNAME || !env.LOGIN_PASSWORD) {
      throw new Error('Missing required env: LOGIN_URL, LOGIN_USERNAME, LOGIN_PASSWORD');
    }

    // Login ONCE
    await login(page, env);

    // Loop projects using SAME session
    for (let i = 0; i < projects.length; i++) {
      const proj = projects[i];
      const idxTag = `${i + 1}/${projects.length}`;
      try {
        await submitCallLogForProject(page, env, proj, idxTag, artifactsDir);
        results.push({ project_url: proj.project_url, ok: true });
      } catch (e) {
        console.error(`ERROR: Project ${idxTag} failed:`, e.message || e);
        try {
          const snap = path.join(artifactsDir, `error-${i + 1}.png`);
          await page.screenshot({ path: snap, fullPage: true }).catch(()=>{});
          console.log('Saved error screenshot:', snap);
          const htmlPath = path.join(artifactsDir, `page-${i + 1}.html`);
          await fs.promises.writeFile(htmlPath, await page.content()).catch(()=>{});
          console.log('Saved page HTML:', htmlPath);
        } catch {}
        results.push({ project_url: proj.project_url, ok: false, error: e.message || String(e) });
      }
    }

    // Summary
    const okCount = results.filter(r => r.ok).length;
    const failCount = results.length - okCount;
    console.log('\n=== SUMMARY ===');
    console.log('Succeeded:', okCount);
    console.log('Failed   :', failCount);
    results.forEach((r, idx) => console.log(`${idx + 1}. ${r.ok ? 'OK    ' : 'FAILED'} – ${r.project_url}${r.error ? ' – ' + r.error : ''}`));

    await browser.close();
    process.exit(failCount > 0 ? 1 : 0);
  } catch (err) {
    console.error('FATAL:', err && err.stack ? err.stack : err);
    try {
      const file = path.join(artifactsDir, `fatal-${Date.now()}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log('Saved fatal screenshot:', file);
    } catch {}
    await browser.close();
    process.exit(1);
  }
})();
