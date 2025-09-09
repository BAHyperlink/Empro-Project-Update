// automation.js — HLIS EmPro: login once, loop projects, submit Call Log
// Playwright + rich logs + artifacts on fail

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/* ============================== Utilities ============================== */

async function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();

function isOnLoginUrl(url) { return /\/manager\/login\b/i.test(url); }
function originFrom(urlStr) { const u = new URL(urlStr); return `${u.protocol}//${u.host}`; }
function detailsPath(projectURL) { const u = new URL(projectURL); return u.pathname + (u.search || '') + (u.hash || ''); }
const toArray = (v) => !v ? [] : Array.isArray(v) ? v : String(v).split(/[;,]/).map(s => s.trim()).filter(Boolean);

function normalizeCommWithClient(v) {
  if (!v) return v;
  const x = String(v).trim().toLowerCase();
  if (['successfully communicated', 'successfully communicate', 'communicated successfully'].includes(x)) return 'Successfully Communicate';
  if (['communicate cannot be done', 'communicate can not be done'].includes(x)) return 'Communicate Can Not Be Done';
  return v;
}

async function dumpArtifacts(page, artifactsDir, tag) {
  const stamp = `${tag}-${Date.now()}`;
  const html = path.join(artifactsDir, `${stamp}.html`);
  const png  = path.join(artifactsDir, `${stamp}.png`);
  try { await fs.promises.writeFile(html, await page.content()); } catch {}
  try { await page.screenshot({ path: png, fullPage: true }); } catch {}
  console.log(`[${now()}] ARTIFACTS: ${html}  ${png}`);
}

async function assertNotLogin(page, artifactsDir, stageLabel) {
  if (!isOnLoginUrl(page.url())) return;
  console.log(`[${now()}] ASSERT FAIL: Still on login after ${stageLabel}. url=${page.url()}`);
  await dumpArtifacts(page, artifactsDir, `login-still-${stageLabel}`);
  throw new Error(`Still on login page after ${stageLabel}`);
}

/* ============================== CSRF Helpers ============================== */

// Inject hidden CSRF input(s) into #login_form using cookie value.
// Works when the backend expects "double-submit" (cookie + form field).
async function injectCsrfHidden(page, {
  formSelector = '#login_form',
  cookieNames = [process.env.CSRF_COOKIE_NAME, 'ci_csrf_token', 'csrf_cookie_name'].filter(Boolean),
  fieldNames = ['ci_csrf_token', 'csrf_test_name'] // CodeIgniter common names
} = {}) {
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  await sleep(200);

  const cookies = await page.context().cookies();
  let token = '';
  for (const name of cookieNames) {
    const c = cookies.find(c => c.name === name);
    if (c?.value) { token = c.value; break; }
  }
  if (!token) {
    const any = cookies.find(c => /csrf/i.test(c.name));
    token = any?.value || '';
  }

  if (!token) {
    console.log(`[${now()}] CSRF WARN: No CSRF cookie found. Cookies= ${cookies.map(c => c.name).join(', ')}`);
    return false;
  }

  const ok = await page.evaluate(({ token, fieldNames, formSelector }) => {
    const form = document.querySelector(formSelector);
    if (!form) return false;

    let input = form.querySelector('input[type="hidden"][name*="csrf" i]');
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = fieldNames[0]; // 'ci_csrf_token'
      form.appendChild(input);
    }
    input.value = token;

    // Also add second common name to be safe
    if (!form.querySelector(`input[type="hidden"][name="${fieldNames[1]}"]`)) {
      const alt = document.createElement('input');
      alt.type = 'hidden';
      alt.name = fieldNames[1]; // 'csrf_test_name'
      alt.value = token;
      form.appendChild(alt);
    }

    form.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { token, fieldNames, formSelector });

  console.log(`[${now()}] CSRF INJECT: ${ok ? `OK (len=${token.length})` : 'FAIL'}`);
  return ok;
}

// Request-level safety net: append CSRF to POST body when hitting /manager/login/signin
// Request-level safety net: append CSRF to POST body when hitting /manager/login/signin
async function addCsrfOnSigninPost(page) {
  await page.route('**/manager/login/signin', async (route) => {
    const req = route.request();
    const origBody = req.postData() || '';
    const params = new URLSearchParams(origBody);

    // Try to pick up a CSRF cookie if present
    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find(c => /csrf/i.test(c.name));
    const token = csrfCookie?.value || '';

    if (token) {
      if (!params.has('ci_csrf_token')) params.append('ci_csrf_token', token);
      if (!params.has('csrf_test_name')) params.append('csrf_test_name', token);
    } else {
      console.log(`[${now()}] CSRF ROUTE WARN: no CSRF cookie during POST intercept.`);
    }

    const newBody = params.toString();

    // Merge headers and set correct content-type; remove content-length so PW recalculates
    const headers = { ...req.headers() };
    delete headers['content-length'];
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers['origin'] = 'https://reporting.hyperlinkinfosystem.net.in';
    headers['referer'] = 'https://reporting.hyperlinkinfosystem.net.in/manager/login';

    console.log(`[${now()}] ROUTE /signin: appended CSRF=${!!token}; bodyLen ${origBody.length} -> ${newBody.length}`);

    await route.continue({
      method: 'POST',
      headers,
      postData: newBody,   // <-- continue with modified body
    });
  });
}

/* ============================== Core Steps ============================== */

async function login(page, env, artifactsDir) {
  console.log(`[${now()}] STEP 1: goto login ${env.LOGIN_URL}`);
  await page.goto(env.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Intercept login POST to force CSRF in body (belt & suspenders)
  await addCsrfOnSigninPost(page);

  console.log(`[${now()}] STEP 2: wait for #username`);
  await page.waitForSelector('#username', { timeout: 30000 });

  console.log(`[${now()}] STEP 3: fill username`);
  await page.fill('#username', env.LOGIN_USERNAME);

  console.log(`[${now()}] STEP 4: fill password`);
  await page.fill('#password', env.LOGIN_PASSWORD);

  console.log(`[${now()}] STEP 5: select Work Place = ${env.WORKPLACE || '(none)'}`);
  if (env.WORKPLACE) {
    let selected = false;
    try {
      await page.selectOption('#work_place', { label: env.WORKPLACE });
      selected = true;
    } catch {
      try { await page.selectOption('#work_place', { value: env.WORKPLACE }); selected = true; } catch {}
    }
    if (!selected) console.log(`[${now()}] WORKPLACE WARN: could not select`);
    await page.evaluate(() => {
      const el = document.querySelector('#work_place');
      if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  console.log(`[${now()}] STEP 6: fill Desk Number = ${env.DESK_NUMBER || '(none)'}`);
  if (String(env.DESK_NUMBER || '').length) {
    try { await page.fill('#desk_number', String(env.DESK_NUMBER)); } catch {}
    await page.evaluate(() => {
      const el = document.querySelector('#desk_number');
      if (el) { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
    });
  }

  console.log(`[${now()}] STEP 7: set Remember Me = ${env.REMEMBER_ME}`);
  if (/^(true|yes|1)$/i.test(String(env.REMEMBER_ME || ''))) {
    const cb = page.locator('#rememberme');
    try { if (await cb.count()) await cb.check(); } catch {}
  }

  // Inject CSRF hidden input(s) (form has none in DOM)
  console.log(`[${now()}] STEP 7b: Inject CSRF hidden inputs (if needed)`);
  await injectCsrfHidden(page);

  // Debug current form snapshot
  try {
    const uname = await page.inputValue('#username').catch(() => '');
    const pLen = (await page.inputValue('#password').catch(() => '') || '').length;
    const workplace = await page.inputValue('#work_place').catch(() => '');
    const desk = await page.inputValue('#desk_number').catch(() => '');
    const hasCsrf = await page.locator('#login_form input[type="hidden"][name*="csrf" i]').count();
    console.log(`[${now()}] DEBUG FORM: { username:"${uname}", password_length:${pLen}, work_place:"${workplace}", desk_number:"${desk}", csrf_hidden_inputs:${hasCsrf} }`);
  } catch {}

  console.log(`[${now()}] STEP 8: click SIGN IN`);
  const submit = page.locator('input[type="submit"][value="SIGN IN"], input[type="submit"], button[type="submit"]');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
    submit.first().click({ timeout: 7000 }).catch(()=>{})
  ]);

  // Network idle for any follow-up redirects
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});

  // If still on login, dump and fail
  await assertNotLogin(page, artifactsDir, 'submit');
  console.log(`[${now()}] LOGIN OK → ${page.url()}`);
}

async function reloginIfNeeded(page, env, artifactsDir) {
  if (!isOnLoginUrl(page.url())) return false;
  console.log(`[${now()}] INFO: redirected to login, re-authenticating…`);
  await login(page, env, artifactsDir);
  return true;
}

async function openProjectListByClick(page, env, artifactsDir) {
  const origin = originFrom(env.LOGIN_URL);
  const candidates = [
    env.PROJECT_LIST_MENU_SELECTOR,
    'a[href*="/manager/project"]',
    'a:has-text("Project")',
    'a:has-text("Projects")',
    'nav a:has-text("Project")',
    'nav a:has-text("Projects")',
    'aside a:has-text("Project")',
    'aside a:has-text("Projects")',
  ].filter(Boolean);

  console.log(`[${now()}] STEP 10: open Project List via menu click`);
  let clicked = false;
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout: 4000 });
      const href = await loc.getAttribute('href').catch(() => null);
      if (href && /^https?:\/\//i.test(href) && !href.startsWith(origin)) {
        continue; // skip cross-origin
      }
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 30000 }),
        loc.click({ timeout: 5000 })
      ]);
      console.log(`[${now()}] CLICK OK → ${sel} (href=${href || '(n/a)'})`);
      clicked = true;
      break;
    } catch {}
  }

  if (!clicked) {
    console.log(`[${now()}] OPEN LIST: expand menus and retry…`);
    const expanders = ['button.navbar-toggler', 'button[aria-label="Menu"]', 'button:has-text("Menu")', '.dropdown-toggle'];
    for (const ex of expanders) { try { if (await page.locator(ex).first().isVisible()) await page.locator(ex).first().click().catch(()=>{}); } catch {} }
    for (const sel of candidates) {
      try {
        const loc = page.locator(sel).first();
        await loc.waitFor({ state: 'visible', timeout: 3000 });
        await Promise.all([
          page.waitForLoadState('networkidle', { timeout: 30000 }),
          loc.click({ timeout: 5000 })
        ]);
        console.log(`[${now()}] CLICK OK → ${sel}`);
        clicked = true;
        break;
      } catch {}
    }
  }

  if (!clicked) {
    await dumpArtifacts(page, artifactsDir, 'no-project-list-link');
    throw new Error('Could not find a Project List link in the UI');
  }

  if (await reloginIfNeeded(page, env, artifactsDir)) {
    console.log(`[${now()}] REOPEN list after re-login…`);
    return openProjectListByClick(page, env, artifactsDir);
  }

  if (env.PROJECT_LIST_READY_SELECTOR?.trim()) {
    const readySel = env.PROJECT_LIST_READY_SELECTOR.trim();
    try {
      await page.waitForSelector(readySel, { timeout: 12000 });
      console.log(`[${now()}] LIST READY: ${readySel}`);
    } catch (e) {
      console.log(`[${now()}] LIST READY WARN: ${readySel} → ${e.message}`);
      await dumpArtifacts(page, artifactsDir, 'list-not-ready');
    }
  }
  console.log(`[${now()}] LIST URL: ${page.url()}`);
}

async function clickProjectFromList(page, projectURL) {
  const token = detailsPath(projectURL); // e.g. /manager/project/details/MTQ2Mg==
  const selector = `a[href*="${token.replace(/"/g, '\\"')}"]`;
  const allSel = 'a[href*="/manager/project/details/"]';

  const total = await page.locator(allSel).count().catch(() => 0);
  console.log(`[${now()}] SCAN: details links total=${total}`);

  const count = await page.locator(selector).count().catch(() => 0);
  console.log(`[${now()}] FIND: selector "${selector}" count=${count}`);
  if (count === 0) throw new Error('Project link not found on the Project List page');

  for (let i = 1; i <= 3; i++) {
    try {
      const link = page.locator(selector).first();
      await link.waitFor({ state: 'visible', timeout: 4000 });
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 45000 }),
        link.click({ timeout: 5000 })
      ]);
      console.log(`[${now()}] CLICK OK → project details (try ${i}/3)`);
      break;
    } catch (e) {
      console.log(`[${now()}] CLICK RETRY ${i}/3: ${e.message}`);
      if (i === 3) throw e;
    }
  }

  if (!page.url().includes(token)) {
    console.log(`[${now()}] URL AFTER CLICK: ${page.url()}`);
    throw new Error('After click, not on project details page');
  }
}

async function openCallLogAndSubmit(page, env, proj, idxTag, artifactsDir) {
  const COMM_WITH_CLIENT = normalizeCommWithClient(proj.comm_with_client || '');
  const CALL_TYPES = toArray(proj.call_types || proj.call_type);

  console.log(`[${now()}] STEP 11: open Call Log modal`);
  const btnSelector = env.CALL_LOG_BUTTON_SELECTOR || 'button[data-target="#call_log_model"]';

  // Try primary button, then role/name fallback
  let opened = false;
  for (let i = 1; i <= 4 && !opened; i++) {
    try {
      await page.locator(btnSelector).first().waitFor({ state: 'visible', timeout: 3000 });
      await page.locator(btnSelector).first().click({ timeout: 3000 });
      console.log(`[${now()}] CLICK OK → ${btnSelector} (try ${i}/4)`);
      opened = true;
    } catch (e) {
      console.log(`[${now()}] CLICK RETRY ${i}/4: ${e.message}`);
      await sleep(250);
    }
  }
  if (!opened) {
    try { await page.getByRole('button', { name: /call\s*log/i }).first().click({ timeout: 3000 }); console.log(`[${now()}] CLICK OK → role:button "Call Log"`); opened = true; } catch {}
  }
  if (!opened) {
    await dumpArtifacts(page, artifactsDir, `no-calllog-btn-${idxTag}`);
    throw new Error('Could not find the "Call Log" button');
  }

  console.log(`[${now()}] STEP 12: wait for modal`);
  await Promise.race([
    page.getByRole('dialog', { name: /call\s*log/i }).waitFor({ state: 'visible', timeout: 10000 }),
    page.waitForSelector('button:has-text("SUBMIT DETAILS"), text=/SUBMIT DETAILS/i', { timeout: 10000 })
  ]).catch(() => {});
  await dumpArtifacts(page, artifactsDir, `modal-${idxTag}`);

  // Form field selectors (from your earlier mapping)
  const SEL_COMM_TYPE = '#communication_type';
  const SEL_COMM_WITH_CLIENT = '#communicate_does_not';
  const SEL_MEETING_TYPE = '#meeting_type'; // multi-select
  const SEL_COMMENTS = '#comments';

  if (proj.comm_type) {
    console.log(`[${now()}] STEP 13: set Communication Type: "${proj.comm_type}"`);
    try {
      await page.selectOption(SEL_COMM_TYPE, { label: proj.comm_type });
      // bootstrap-select visual confirmation (best-effort)
      await page.locator('[data-id="communication_type"] .filter-option').getByText(proj.comm_type, { exact: false }).waitFor({ timeout: 2000 }).catch(() => {});
      console.log(`[${now()}] COMM_TYPE OK`);
    } catch (e) { console.log(`[${now()}] COMM_TYPE WARN: ${e.message}`); }
  }

  if (COMM_WITH_CLIENT) {
    console.log(`[${now()}] STEP 14: set Communicate With Client: "${COMM_WITH_CLIENT}"`);
    try {
      await page.selectOption(SEL_COMM_WITH_CLIENT, { label: COMM_WITH_CLIENT });
      await page.locator('[data-id="communicate_does_not"] .filter-option').getByText(COMM_WITH_CLIENT, { exact: false }).waitFor({ timeout: 2000 }).catch(() => {});
      console.log(`[${now()}] COMM_WITH_CLIENT OK`);
    } catch (e) { console.log(`[${now()}] COMM_WITH_CLIENT WARN: ${e.message}`); }
  }

  console.log(`[${now()}] STEP 15: set Call Type(s): ${CALL_TYPES.length ? CALL_TYPES.join(', ') : '(none)'}`);
  if (CALL_TYPES.length) {
    try { await page.selectOption(SEL_MEETING_TYPE, CALL_TYPES.map(label => ({ label }))); console.log(`[${now()}] CALL TYPES OK`); }
    catch (e) {
      console.log(`[${now()}] CALL TYPES fallback: try clickable list items → ${e.message}`);
      for (const label of CALL_TYPES) {
        const item = page.locator('.ms-container .ms-selectable .ms-elem-selectable span', { hasText: label });
        try { await item.first().click({ timeout: 1500 }); console.log(`[${now()}] CLICKED ms item: ${label}`); }
        catch { console.log(`[${now()}] Could not click ms item: ${label}`); }
      }
    }
  }

  if (proj.comments) {
    console.log(`[${now()}] STEP 16: fill Comments (${proj.comments.length} chars)`);
    try { await page.fill(SEL_COMMENTS, proj.comments); console.log(`[${now()}] COMMENTS OK`); }
    catch (e) {
      console.log(`[${now()}] COMMENTS WARN: ${e.message}`);
      const fb = ['textarea[name="comments"]', 'textarea', 'input[name*="comment" i]'];
      for (const sel of fb) { try { await page.fill(sel, proj.comments, { timeout: 1000 }); console.log(`[${now()}] COMMENTS fallback OK → ${sel}`); break; } catch {} }
    }
  }

  console.log(`[${now()}] STEP 17: submit details`);
  const submitOk = await (async () => {
    const tries = [
      { role: 'button', name: /submit details/i },
      'text=/SUBMIT DETAILS/i',
      env.FORM_SUBMIT_SELECTOR,
      'button[type="submit"]'
    ].filter(Boolean);
    for (const t of tries) {
      try {
        if (typeof t === 'string') {
          await page.locator(t).first().click({ timeout: 5000 });
          console.log(`[${now()}] CLICK OK → ${t}`); return true;
        }
        await page.getByRole('button', { name: t.name }).first().click({ timeout: 5000 });
        console.log(`[${now()}] CLICK OK → role:button ${String(t.name)}`); return true;
      } catch {}
    }
    return false;
  })();

  if (!submitOk) throw new Error('Could not find "SUBMIT DETAILS"');

  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});
  if (env.CONFIRM_SELECTOR) {
    console.log(`[${now()}] STEP 18: wait for confirm ${env.CONFIRM_SELECTOR}`);
    try { await page.locator(env.CONFIRM_SELECTOR).waitFor({ state: 'visible', timeout: 15000 }); console.log(`[${now()}] CONFIRM OK`); }
    catch { console.log(`[${now()}] WARN: confirm not seen`); }
  }
  console.log(`[${now()}] DONE: call log submitted for ${idxTag}`);
}

/* ============================== Orchestration ============================== */

function loadProjectsFromEnv() {
  const raw = process.env.PROJECTS_JSON;
  if (!raw || !raw.trim()) throw new Error('PROJECTS_JSON is required');
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { throw new Error('Invalid PROJECTS_JSON: ' + e.message); }
  if (!Array.isArray(arr) || !arr.length) throw new Error('PROJECTS_JSON must be a non-empty array');
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
    CALL_LOG_BUTTON_SELECTOR: process.env.CALL_LOG_BUTTON_SELECTOR || null,
    FORM_SUBMIT_SELECTOR: process.env.FORM_SUBMIT_SELECTOR || null,
    CONFIRM_SELECTOR: process.env.CONFIRM_SELECTOR || null,
    PROJECT_LIST_MENU_SELECTOR: process.env.PROJECT_LIST_MENU_SELECTOR || '',
    PROJECT_LIST_READY_SELECTOR: process.env.PROJECT_LIST_READY_SELECTOR || ''
  };

  console.log(`[${now()}] BOOT: starting automation.js`);

  try {
    const projects = loadProjectsFromEnv();
    console.log(`[${now()}] BATCH: ${projects.length} project(s) to process`);
    if (!env.LOGIN_URL || !env.LOGIN_USERNAME || !env.LOGIN_PASSWORD) throw new Error('Missing LOGIN_* env');

    await login(page, env, artifactsDir);

    for (let i = 0; i < projects.length; i++) {
      const idxTag = `${i + 1}/${projects.length}`;
      const proj = projects[i];
      try {
        console.log(`\n[${now()}] === PROJECT ${idxTag}: ${proj.project_url} ===`);
        await openProjectListByClick(page, env, artifactsDir);
        await reloginIfNeeded(page, env, artifactsDir);

        console.log(`[${now()}] STEP 10b: click project details link from list`);
        await clickProjectFromList(page, proj.project_url);
        await reloginIfNeeded(page, env, artifactsDir);

        await openCallLogAndSubmit(page, env, proj, idxTag, artifactsDir);
      } catch (e) {
        console.error(`[${now()}] ERROR: Project ${idxTag} failed → ${e.message || e}`);
        await dumpArtifacts(page, artifactsDir, `error-proj-${i + 1}`);
      }
    }
    console.log(`\n[${now()}] ALL DONE`);
  } catch (e) {
    console.error(`[${now()}] FATAL: ${e && e.stack ? e.stack : e}`);
    await dumpArtifacts(page, artifactsDir, 'fatal');
  } finally {
    await browser.close();
  }
})();
