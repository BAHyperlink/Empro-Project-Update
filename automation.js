// automation.js
// End-to-end Playwright script:
// 1) Login to portal (static selectors for username/password)
// 2) Open project URL
// 3) Click "Call Log"
// 4) Fill fields (Communication Type, Communicate With Client, Call Type, Comments)
// 5) Submit
//
// ---- REQUIRED ENV VARS ----
//   LOGIN_URL          e.g. https://reporting.hyperlinkinfosystem.net.in/manager/login
//   LOGIN_USERNAME     (GitHub Secret)
//   LOGIN_PASSWORD     (GitHub Secret)
//   PROJECT_URL        e.g. https://.../manager/project/details/<id>
// ---- OPTIONAL ENV VARS ----
//   WORKPLACE                e.g. "Work From Home"
//   DESK_NUMBER              e.g. "0"
//   REMEMBER_ME              "true" | "false" | "yes" | "no"
//   POST_LOGIN_READY_SELECTOR   CSS for element that proves login succeeded (optional)
//
//   COMM_TYPE                e.g. "Microsoft Team"
//   COMM_WITH_CLIENT         e.g. "Successfully Communicated"
//   CALL_TYPE                e.g. "Call"
//   COMMENTS                 e.g. "I had call with client"
//   CALL_LOG_BUTTON_SELECTOR override button selector (optional)
//   FORM_SUBMIT_SELECTOR     override submit selector (optional)
//   CONFIRM_SELECTOR         CSS/text of success message (optional)
//
// Debug:
//   PWDEBUG="1"  -> run headed (useful locally)
// ---------------------------------------------------------------------

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---- STATIC SELECTORS (as requested) ----
const USERNAME_SELECTOR = '#username';
const PASSWORD_PRIMARY_SELECTOR = '#password';
const PASSWORD_FALLBACKS = ['input[name="password"]', 'input[type="password"]'];

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
    } catch (e) {
      // try next
    }
  }
  return null;
}

async function selectByLabelOrAny(page, label, value) {
  try {
    await page.getByLabel(label, { exact: true }).selectOption({ label: String(value) });
    console.log(`SELECT OK → [${label}] = "${value}" (by label)`);
    return true;
  } catch {}
  try {
    await page.selectOption('select', { label: String(value) });
    console.log(`SELECT OK → any <select> label "${value}" (fallback)`);
    return true;
  } catch {}
  console.log(`SELECT WARN → could not set [${label}] = "${value}"`);
  return false;
}

async function fillByLabelOrFallback(page, label, value, fallbacks = []) {
  try {
    await page.getByLabel(label, { exact: true }).fill(String(value ?? ''));
    console.log(`FILL OK → [${label}]`);
    return true;
  } catch {}
  for (const f of fallbacks) {
    try { await page.fill(f, String(value ?? '')); console.log(`FALLBACK FILL OK → ${f}`); return true; } catch {}
  }
  console.log(`FILL WARN → could not fill [${label}]`);
  return false;
}

async function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// --------------- main flow ---------------
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

    const COMM_TYPE = process.env.COMM_TYPE || '';
    const COMM_WITH_CLIENT = process.env.COMM_WITH_CLIENT || '';
    const CALL_TYPE = process.env.CALL_TYPE || '';
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

    console.log('STEP 3: fill username with static selector', USERNAME_SELECTOR);
    await page.fill(USERNAME_SELECTOR, LOGIN_USERNAME);

    console.log('STEP 4: fill password (primary then fallbacks)');
    let passFilled = false;
    try {
      await page.fill(PASSWORD_PRIMARY_SELECTOR, LOGIN_PASSWORD, { timeout: 8000 });
      console.log(`PASSWORD OK → ${PASSWORD_PRIMARY_SELECTOR}`);
      passFilled = true;
    } catch {
      for (const fb of PASSWORD_FALLBACKS) {
        try {
          await page.fill(fb, LOGIN_PASSWORD, { timeout: 5000 });
          console.log(`PASSWORD OK (fallback) → ${fb}`);
          passFilled = true;
          break;
        } catch { /* next */ }
      }
    }
    if (!passFilled) throw new Error('Could not locate password field (tried #password and common fallbacks)');

    if (WORKPLACE) {
      console.log('STEP 5: select Work Place =', WORKPLACE);
      await selectByLabelOrAny(page, 'Work Place', WORKPLACE);
    }

    if (DESK_NUMBER) {
      console.log('STEP 6: fill Desk Number =', DESK_NUMBER);
      await fillByLabelOrFallback(page, 'Desk Number', DESK_NUMBER, ['input[name*="desk" i]']);
    }

    if (REMEMBER_ME) {
      const want = REMEMBER_ME === 'true' || REMEMBER_ME === 'yes';
      console.log('STEP 7: set Remember Me =', want);
      try {
        const cb = page.getByLabel('Remember Me', { exact: true });
        const checked = await cb.isChecked().catch(() => false);
        if (want && !checked) await cb.check();
        if (!want && checked) await cb.uncheck();
      } catch {
        console.log('Remember Me checkbox not found (ok to continue)');
      }
    }

    console.log('STEP 8: click Login (multiple strategies)');
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
      CALL_LOG_BUTTON_SELECTOR,                          // explicit override
      { role: 'button', name: /call\s*log/i },           // role-based by visible name
      'text=/\\bCall\\s*Log\\b/i'                        // text fallback
    ]);
    if (!clickedCallLog) throw new Error('Could not find the "Call Log" button');

    console.log('STEP 12: wait for modal/dialog or submit button');
    await Promise.race([
      page.getByRole('dialog', { name: /call\s*log/i }).waitFor({ state: 'visible', timeout: 10000 }),
      page.waitForSelector('button:has-text("SUBMIT DETAILS"), text=/SUBMIT DETAILS/i', { timeout: 10000 })
    ]).catch(() => {});

    // ----------- FILL FIELDS -----------
    console.log('STEP 13: set Communication Type:', COMM_TYPE);
    if (COMM_TYPE) await selectByLabelOrAny(page, 'Communication Type', COMM_TYPE);

    console.log('STEP 14: set Communicate With Client:', COMM_WITH_CLIENT);
    if (COMM_WITH_CLIENT) {
      let ok = await selectByLabelOrAny(page, 'Communicate With Client', COMM_WITH_CLIENT);
      if (!ok) {
        // Dual-list fallback (best-effort)
        try {
          const leftItem = page.locator(`div[role="listbox"] >> text=${JSON.stringify(COMM_WITH_CLIENT)}`);
          if (await leftItem.count()) {
            await leftItem.first().click();
            const transfer = page.locator('button:has-text(">"), [data-icon="chevron-right"], .mdi-chevron-right').first();
            await transfer.click({ timeout: 2000 }).catch(() => {});
            console.log('TRANSFER OK → moved item to selected list');
            ok = true;
          }
        } catch {}
      }
      if (!ok) console.log('WARN: could not set "Communicate With Client"');
    }

    console.log('STEP 15: set Call Type:', CALL_TYPE);
    if (CALL_TYPE) {
      let ok = false;
      try { await page.getByLabel('Call', { exact: true }).selectOption({ label: CALL_TYPE }); ok = true; } catch {}
      if (!ok) {
        try {
          const item = page.locator(`div[role="listbox"] >> text=${JSON.stringify(CALL_TYPE)}`);
          if (await item.count()) { await item.first().click(); ok = true; }
        } catch {}
      }
      if (!ok) console.log('WARN: could not set "Call"');
    }

    console.log('STEP 16: fill Comments:', COMMENTS ? '(provided)' : '(empty)');
    if (COMMENTS) {
      await fillByLabelOrFallback(page, 'Comments', COMMENTS, [
        'textarea',
        'input[name*="comment" i]'
      ]);
    }

    // ----------- SUBMIT -----------
    console.log('STEP 17: submit details');
    const clickedSubmit = await clickOne(page, [
      { role: 'button', name: /submit details/i },
      'text=/SUBMIT DETAILS/i',
      FORM_SUBMIT_SELECTOR,                    // explicit override
      'button[type="submit"]'
    ]);
    if (!clickedSubmit) throw new Error('Could not find "SUBMIT DETAILS" button');

    await page.waitForLoadState('networkidle', { timeout: 20000 });

    if (CONFIRM_SELECTOR) {
      console.log('STEP 18: wait for confirm', CONFIRM_SELECTOR);
      try {
        await page.locator(CONFIRM_SELECTOR).waitFor({ state: 'visible', timeout: 15000 });
        console.log('CONFIRM OK');
      } catch {
        console.log('WARN: confirm selector not seen (may still be fine)');
      }
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
