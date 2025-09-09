// automation.js
// Login → open project → open "Call Log" modal → fill Communication Type / Communicate With Client / Call Type(s) / Comments → submit
//
// Required ENV:
//   LOGIN_URL, LOGIN_USERNAME, LOGIN_PASSWORD, PROJECT_URL
// Optional ENV:
//   WORKPLACE, DESK_NUMBER, REMEMBER_ME, POST_LOGIN_READY_SELECTOR
//   COMM_TYPE, COMM_WITH_CLIENT, CALL_TYPE (single) OR CALL_TYPES ("A,B,C")
//   COMMENTS, CALL_LOG_BUTTON_SELECTOR, FORM_SUBMIT_SELECTOR, CONFIRM_SELECTOR
// Debug:
//   PWDEBUG="1"  -> run headed locally
//
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---- STATIC login selectors (as requested) ----
const USERNAME_SELECTOR = '#username';
const PASSWORD_PRIMARY_SELECTOR = '#password';
const PASSWORD_FALLBACKS = ['input[name="password"]', 'input[type="password"]'];

// ---- Modal field selectors (from your HTML) ----
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

// Normalize sheet values to exact site labels where needed
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
function parseCallTypes(envSingle, envMany) {
  const raw = envMany && envMany.trim() !== '' ? envMany : envSingle;
  if (!raw) return [];
  return raw.split(/[;,]/).map(s => s.trim()).filter(Boolean);
}

async function main() {
  const headless = process.env.PWDEBUG ? false : true;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const nowTag = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactsDir = path.join(process.cwd(), 'artifacts');
  await ensureDir(artifactsDir);

  try {
    console.log('BOOT: starting automation.js');

    // ----------- ENV -----------
    const LOGIN_URL = process.env.LOGIN_URL;
    const LOGIN_USERNAME = process.env.LOGIN_USERNAME;
    const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD;
    const PROJECT_URL = process.env.PROJECT_URL;

    const WORKPLACE = process.env.WORKPLACE || '';
    const DESK_NUMBER = process.env.DESK_NUMBER || '';
    const REMEMBER_ME = (process.env.REMEMBER_ME || '').toLowerCase();
    const POST_LOGIN_READY_SELECTOR = process.env.POST_LOGIN_READY_SELECTOR || '';

    const COMM_TYPE = process.env.COMM_TYPE || '';                         // e.g. "Microsoft Team"
    const COMM_WITH_CLIENT_RAW = process.env.COMM_WITH_CLIENT || '';       // e.g. "Successfully Communicated" (sheet)
    const COMM_WITH_CLIENT = normalizeCommWithClient(COMM_WITH_CLIENT_RAW);// → "Successfully Communicate" (site)
    const CALL_TYPES = parseCallTypes(process.env.CALL_TYPE || '', process.env.CALL_TYPES || ''); // e.g. "Call, Follow up"
    const COMMENTS = process.env.COMMENTS || '';

    const CALL_LOG_BUTTON_SELECTOR = process.env.CALL_LOG_BUTTON_SELECTOR || null;
    const FORM_SUBMIT_SELECTOR = process.env.FORM_SUBMIT_SELECTOR || null;
    const CONFIRM_SELECTOR = process.env.CONFIRM_SELECTOR || null;

    if (!LOGIN_URL || !LOGIN_USERNAME || !LOGIN_PASSWORD || !PROJECT_URL) {
      throw new Error('Missing required env: LOGIN_URL, LOGIN_USERNAME, LOGIN_PASSWORD, PROJECT_URL');
    }

    // ----------- LOGIN -----------
    console.log('STEP 1: goto login', LOGIN_URL);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    console.log('STEP 2: wait for username', USERNAME_SELECTOR);
    await page.waitForSelector(USERNAME_SELECTOR, { timeout: 30000 });

    console.log('STEP 3: fill username');
    await page.fill(USERNAME_SELECTOR, LOGIN_USERNAME);

    console.log('STEP 4: fill password');
    let passFilled = false;
    try { await page.fill(PASSWORD_PRIMARY_SELECTOR, LOGIN_PASSWORD, { timeout: 8000 }); passFilled = true; console.log(`PASSWORD OK → ${PASSWORD_PRIMARY_SELECTOR}`);} catch {}
    if (!passFilled) {
      for (const fb of PASSWORD_FALLBACKS) {
        try { await page.fill(fb, LOGIN_PASSWORD, { timeout: 5000 }); passFilled = true; console.log(`PASSWORD OK (fallback) → ${fb}`); break; } catch {}
      }
    }
    if (!passFilled) throw new Error('Could not locate password field');

    if (WORKPLACE) {
      console.log('STEP 5: select Work Place =', WORKPLACE);
      try { await page.selectOption('select[name*="work" i], select#workplace', { label: WORKPLACE }); console.log('WORKPLACE OK'); }
      catch { console.log('WORKPLACE WARN: could not select (continuing)'); }
    }
    if (DESK_NUMBER) {
      console.log('STEP 6: fill Desk Number =', DESK_NUMBER);
      try { await page.fill('input[name*="desk" i], #desk_number', String(DESK_NUMBER)); console.log('DESK OK'); }
      catch { console.log('DESK WARN: not found (continuing)'); }
    }
    if (REMEMBER_ME) {
      const want = REMEMBER_ME === 'true' || REMEMBER_ME === 'yes';
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
    if (POST_LOGIN_READY_SELECTOR) {
      console.log('STEP 9: wait for post-login selector', POST_LOGIN_READY_SELECTOR);
      await page.waitForSelector(POST_LOGIN_READY_SELECTOR, { timeout: 15000 });
    }
    console.log('LOGIN OK');

    // ----------- OPEN PROJECT -----------
    console.log('STEP 10: goto project', PROJECT_URL);
    await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 });

    // ----------- OPEN CALL LOG MODAL -----------
    console.log('STEP 11: open Call Log modal');
    const clickedCallLog = await clickOne(page, [
      CALL_LOG_BUTTON_SELECTOR,
      { role: 'button', name: /call\s*log/i },
      'text=/\\bCall\\s*Log\\b/i'
    ]);
    if (!clickedCallLog) throw new Error('Could not find the "Call Log" button');

    console.log('STEP 12: wait for modal');
    await Promise.race([
      page.getByRole('dialog', { name: /call\s*log/i }).waitFor({ state: 'visible', timeout: 10000 }),
      page.waitForSelector('button:has-text("SUBMIT DETAILS"), text=/SUBMIT DETAILS/i', { timeout: 10000 })
    ]).catch(() => {});
    await page.screenshot({ path: `artifacts/modal-${nowTag}.png` }).catch(()=>{});
    console.log('Saved modal screenshot');

    // ----------- FILL FIELDS (using exact IDs) -----------
    console.log('STEP 13: set Communication Type:', COMM_TYPE || '(none)');
    if (COMM_TYPE) {
      try {
        await page.selectOption(SEL_COMM_TYPE, { label: COMM_TYPE });
        // Wait for Bootstrap-Select button text to update
        await page.locator('[data-id="communication_type"] .filter-option').getByText(COMM_TYPE, { exact: false }).waitFor({ timeout: 2000 }).catch(()=>{});
        console.log('COMM_TYPE OK');
      } catch (e) {
        console.log('COMM_TYPE WARN:', e.message);
      }
    }

    console.log('STEP 14: set Communicate With Client (single):', COMM_WITH_CLIENT || '(none)');
    if (COMM_WITH_CLIENT) {
      try {
        await page.selectOption(SEL_COMM_WITH_CLIENT, { label: COMM_WITH_CLIENT });
        await page.locator('[data-id="communicate_does_not"] .filter-option').getByText(COMM_WITH_CLIENT, { exact: false }).waitFor({ timeout: 2000 }).catch(()=>{});
        console.log('COMM_WITH_CLIENT OK');
      } catch (e) {
        console.log('COMM_WITH_CLIENT WARN:', e.message);
      }
    }

    const callTypes = CALL_TYPES;
    console.log('STEP 15: set Call Type(s):', callTypes.length ? callTypes.join(', ') : '(none)');
    if (callTypes.length) {
      try {
        // Underlying <select multiple id="meeting_type"> exists; select by labels
        await page.selectOption(SEL_MEETING_TYPE, callTypes.map(label => ({ label })));
        console.log('CALL TYPES OK');
      } catch (e) {
        // Fallback: click items in the left list (ms-elem-selectable)
        console.log('CALL TYPES fallback: clicking list items');
        for (const label of callTypes) {
          const item = page.locator('.ms-container .ms-selectable .ms-elem-selectable span', { hasText: label });
          try { await item.first().click({ timeout: 1500 }); console.log('Clicked ms item:', label); }
          catch { console.log('Could not click ms item:', label); }
        }
      }
    }

    console.log('STEP 16: fill Comments');
    if (COMMENTS) {
      try {
        await page.fill(SEL_COMMENTS, COMMENTS);
        console.log('COMMENTS OK');
      } catch (e) {
        console.log('COMMENTS WARN (trying fallbacks):', e.message);
        const fallbacks = ['textarea[name="comments"]', 'textarea', 'input[name*="comment" i]'];
        let ok = false;
        for (const sel of fallbacks) {
          try { await page.fill(sel, COMMENTS, { timeout: 1000 }); console.log('COMMENTS fallback OK →', sel); ok = true; break; } catch {}
        }
        if (!ok) console.log('COMMENTS FAIL: not filled');
      }
    }

    // ----------- SUBMIT -----------
    console.log('STEP 17: submit details');
    const clickedSubmit = await clickOne(page, [
      { role: 'button', name: /submit details/i },
      'text=/SUBMIT DETAILS/i',
      FORM_SUBMIT_SELECTOR,
      'button[type="submit"]'
    ]);
    if (!clickedSubmit) throw new Error('Could not find "SUBMIT DETAILS" button');

    await page.waitForLoadState('networkidle', { timeout: 20000 });

    if (CONFIRM_SELECTOR) {
      console.log('STEP 18: wait for confirm', CONFIRM_SELECTOR);
      try { await page.locator(CONFIRM_SELECTOR).waitFor({ state: 'visible', timeout: 15000 }); console.log('CONFIRM OK'); }
      catch { console.log('WARN: confirm not seen (may still be fine)'); }
    }

    console.log('DONE: Call log submitted');
    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error('FATAL:', err && err.stack ? err.stack : err);
    try {
      const file = path.join(artifactsDir, `error-${nowTag}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log('Saved error screenshot:', file);
    } catch {}
    await browser.close();
    process.exit(1);
  }
}

main();
