// automation.js (multi-project)
// Login once → loop over projects → for each: open project → open "Call Log" → fill → submit
//
// Single-project ENV (legacy, still supported):
//   LOGIN_URL, LOGIN_USERNAME, LOGIN_PASSWORD, PROJECT_URL
//   COMM_TYPE, COMM_WITH_CLIENT, CALL_TYPE or CALL_TYPES, COMMENTS
//
// Multi-project ENV (preferred):
//   PROJECTS_JSON = JSON string of [{ project_url, comm_type, comm_with_client, call_types, comments }, ...]
//
// Optional ENV (login/UI):
//   WORKPLACE, DESK_NUMBER, REMEMBER_ME, POST_LOGIN_READY_SELECTOR
//   CALL_LOG_BUTTON_SELECTOR, FORM_SUBMIT_SELECTOR, CONFIRM_SELECTOR
// Debug: PWDEBUG="1" to run headed locally
//
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

// ---------------- helpers ----------------
async function clickOne(page, candidates) {
  for (const sel of candidates) {
    if (!sel) continue;
    try {
      if (typeof sel === 'object' && sel.role === 'button') {
        await page.getByRole('button', { name: sel.name }).first().click({ timeout: sel.timeout || 5000 });
        console.log(`CLICK OK → role:button name=${sel.name}`);
      } else if (typeof sel === 'string' && sel.startsWith('text=')) {
        await page.locator(sel).first().click({ timeout: 5000 });
        console.log(`CLICK OK → ${sel}`);
      } else if (typeof sel === 'string') {
        await page.locator(sel).first().click({ timeout: 5000 });
        console.log(`CLICK OK → ${sel}`);
      } else {
        continue;
      }
      return sel;
    } catch { /* try next */ }
  }
  return null;
}
async function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function normalizeCommWithClient(v) {
  if (!v) return v;
  const x = String(v).trim().toLowerCase();
  if (x === 'successfully communicated' || x === 'successfully communicate' || x === 'communicated successfully') {
    return 'Successfully Communicate';
  }
  if (x === 'communicate cannot be done' || x === 'communicate can not be done') {
    return 'Communicate Can Not Be Done';
  }
  return v;
}
function toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return String(val).split(/[;,]/).map(s => s.trim()).filter(Boolean);
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

async function submitCallLogForProject(page, env, proj, idxTag, artifactsDir) {
  const nowTag = new Date().toISOString().replace(/[:.]/g, '-');
  const COMM_WITH_CLIENT = normalizeCommWithClient(proj.comm_with_client || '');
  const CALL_TYPES = toArray(proj.call_types || proj.call_type);

  console.log(`\n=== PROJECT ${idxTag}: ${proj.project_url} ===`);
  console.log('STEP 10:', 'goto project');
  await page.goto(proj.project_url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 });

  console.log('STEP 11: open Call Log modal');
  const clickedCallLog = await clickOne(page, [
    env.CALL_LOG_BUTTON_SELECTOR,
    { role: 'button', name: /call\s*log/i },
    'text=/\\bCall\\s*Log\\b/i'
  ]);
  if (!clickedCallLog) throw new Error('Could not find the "Call Log" button');

  console.log('STEP 12: wait for modal');
  await Promise.race([
    page.getByRole('dialog', { name: /call\s*log/i }).waitFor({ state: 'visible', timeout: 10000 }),
    page.waitForSelector('button:has-text("SUBMIT DETAILS"), text=/SUBMIT DETAILS/i', { timeout: 10000 })
  ]).catch(() => {});
  await page.screenshot({ path: path.join(artifactsDir, `modal-${idxTag}-${nowTag}.png`) }).catch(()=>{});
  console.log('Saved modal screenshot');

  // COMM TYPE
  if (proj.comm_type) {
    console.log('STEP 13: set Communication Type:', proj.comm_type);
    try {
      await page.selectOption(SEL_COMM_TYPE, { label: proj.comm_type });
      await page.locator('[data-id="communication_type"] .filter-option').getByText(proj.comm_type, { exact: false }).waitFor({ timeout: 2000 }).catch(()=>{});
      console.log('COMM_TYPE OK');
    } catch (e) { console.log('COMM_TYPE WARN:', e.message); }
  } else { console.log('STEP 13: Communication Type: (none)'); }

  // COMM WITH CLIENT (single)
  if (COMM_WITH_CLIENT) {
    console.log('STEP 14: set Communicate With Client:', COMM_WITH_CLIENT);
    try {
      await page.selectOption(SEL_COMM_WITH_CLIENT, { label: COMM_WITH_CLIENT });
      await page.locator('[data-id="communicate_does_not"] .filter-option').getByText(COMM_WITH_CLIENT, { exact: false }).waitFor({ timeout: 2000 }).catch(()=>{});
      console.log('COMM_WITH_CLIENT OK');
    } catch (e) { console.log('COMM_WITH_CLIENT WARN:', e.message); }
  } else { console.log('STEP 14: Communicate With Client: (none)'); }

  // CALL TYPES (multiple)
  console.log('STEP 15: set Call Type(s):', CALL_TYPES.length ? CALL_TYPES.join(', ') : '(none)');
  if (CALL_TYPES.length) {
    try {
      await page.selectOption(SEL_MEETING_TYPE, CALL_TYPES.map(label => ({ label })));
      console.log('CALL TYPES OK');
    } catch (e) {
      console.log('CALL TYPES fallback: clicking list items');
      for (const label of CALL_TYPES) {
        const item = page.locator('.ms-container .ms-selectable .ms-elem-selectable span', { hasText: label });
        try { await item.first().click({ timeout: 1500 }); console.log('Clicked ms item:', label); }
        catch { console.log('Could not click ms item:', label); }
      }
    }
  }

  // COMMENTS
  if (proj.comments) {
    console.log('STEP 16: fill Comments');
    try {
      await page.fill(SEL_COMMENTS, proj.comments);
      console.log('COMMENTS OK');
    } catch (e) {
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
  // Prefer PROJECTS_JSON
  if (process.env.PROJECTS_JSON && process.env.PROJECTS_JSON.trim() !== '') {
    try {
      const arr = JSON.parse(process.env.PROJECTS_JSON);
      if (!Array.isArray(arr)) throw new Error('PROJECTS_JSON must be an array');
      // Normalize keys
      return arr.map((o, i) => ({
        project_url: o.project_url || o.PROJECT_URL || o.url,
        comm_type: o.comm_type || o.COMM_TYPE,
        comm_with_client: o.comm_with_client || o.COMM_WITH_CLIENT,
        call_types: o.call_types ?? o.CALL_TYPES ?? o.call_type ?? o.CALL_TYPE,
        comments: o.comments || o.COMMENTS
      })).filter(p => p.project_url);
    } catch (e) {
      throw new Error('Invalid PROJECTS_JSON: ' + e.message);
    }
  }
  // Fallback to single project envs
  if (process.env.PROJECT_URL) {
    return [{
      project_url: process.env.PROJECT_URL,
      comm_type: process.env.COMM_TYPE || '',
      comm_with_client: process.env.COMM_WITH_CLIENT || '',
      call_types: process.env.CALL_TYPES || process.env.CALL_TYPE || '',
      comments: process.env.COMMENTS || ''
    }];
  }
  throw new Error('Provide PROJECTS_JSON (preferred) or PROJECT_URL (single).');
}

(async () => {
  const headless = process.env.PWDEBUG ? false : true;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
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
    CONFIRM_SELECTOR: process.env.CONFIRM_SELECTOR || null
  };

  const results = [];
  try {
    console.log('BOOT: starting automation.js');
    const projects = loadProjectsFromEnv();
    console.log(`BATCH: ${projects.length} project(s) to process`);

    // Required env check
    if (!env.LOGIN_URL || !env.LOGIN_USERNAME || !env.LOGIN_PASSWORD) {
      throw new Error('Missing required env: LOGIN_URL, LOGIN_USERNAME, LOGIN_PASSWORD');
    }

    // Login once
    await login(page, env);

    // Process each project
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
        } catch {}
        results.push({ project_url: proj.project_url, ok: false, error: e.message || String(e) });
        // Continue to next project
      }
    }

    // Summary
    const okCount = results.filter(r => r.ok).length;
    const failCount = results.length - okCount;
    console.log('\n=== SUMMARY ===');
    console.log('Succeeded:', okCount);
    console.log('Failed   :', failCount);
    results.forEach((r, idx) => {
      console.log(`${idx + 1}. ${r.ok ? 'OK    ' : 'FAILED'} – ${r.project_url}${r.error ? ' – ' + r.error : ''}`);
    });

    await browser.close();
    // Exit non-zero if any failed (optional; comment out if you prefer always-0)
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
