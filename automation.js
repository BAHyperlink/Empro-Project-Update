// automation.js
// Usage (from CI or local):
// LOGIN_URL=... PROJECT_URL=... LOGIN_USERNAME=... LOGIN_PASSWORD=... \
// COMM_TYPE="PHONE CALL" COMM_WITH_CLIENT="Kick off call" CALL_TYPE="Follow up" COMMENTS="..." \
// node automation.js

const { chromium } = require('playwright');

async function fillByLabel(page, label, value, kind = 'text') {
  const loc = page.getByLabel(label, { exact: true });
  if (kind === 'select') {
    try { await loc.selectOption({ label: String(value) }); }
    catch { await loc.selectOption(String(value)); }
    return;
  }
  if (kind === 'checkbox') {
    const truthy = value === true || String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'yes';
    if (truthy) {
      await loc.check().catch(async () => { if (!(await loc.isChecked())) await loc.click(); });
    } else {
      await loc.uncheck().catch(async () => { if (await loc.isChecked()) await loc.click(); });
    }
    return;
  }
  await loc.fill(String(value ?? ''));
}

async function tryClick(page, selectorOrRole, nameRegex) {
  try {
    if (selectorOrRole === 'role:button') {
      await page.getByRole('button', { name: nameRegex }).first().click({ timeout: 5000 });
      return true;
    } else {
      await page.locator(selectorOrRole).first().click({ timeout: 5000 });
      return true;
    }
  } catch { return false; }
}

async function login(page) {
  const loginUrl = process.env.LOGIN_URL;
  const username = process.env.LOGIN_USERNAME;
  const password = process.env.LOGIN_PASSWORD;
  const workplace = process.env.WORKPLACE || '';   // e.g. "Work From Home"
  const desk = process.env.DESK_NUMBER || '';      // e.g. "0"
  const rememberMe = (process.env.REMEMBER_ME || '').toLowerCase() === 'true';
  const postLoginSel = process.env.POST_LOGIN_READY_SELECTOR || ''; // optional

  if (!loginUrl) throw new Error('LOGIN_URL is required');

  console.log('Navigating to login...');
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  // Labels on your page: Username, Password, Work Place, Desk Number, Remember Me
  await fillByLabel(page, 'Username', username);
  await fillByLabel(page, 'Password', password);
  if (workplace) await fillByLabel(page, 'Work Place', workplace, 'select');
  if (desk) await fillByLabel(page, 'Desk Number', desk);
  if (process.env.REMEMBER_ME) await fillByLabel(page, 'Remember Me', rememberMe, 'checkbox');

  // Submit login
  const clicked =
    (await tryClick(page, 'role:button', /login/i)) ||
    (await tryClick(page, 'button[type="submit"]')) ||
    (await tryClick(page, 'input[type="submit"]')) ||
    (await tryClick(page, 'text=Login'));
  if (!clicked) throw new Error('Could not find Login submit button');

  await page.waitForLoadState('networkidle');

  if (postLoginSel) await page.waitForSelector(postLoginSel, { timeout: 15000 });
  console.log('Login complete.');
}

async function openProject(page) {
  const projectUrl = process.env.PROJECT_URL;
  if (!projectUrl) throw new Error('PROJECT_URL is required');
  console.log('Opening project URL...');
  await page.goto(projectUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
}

async function openCallLogModal(page) {
  console.log('Opening Call Log modal...');
  const opened =
    (await tryClick(page, 'role:button', /call log/i)) ||
    (await tryClick(page, 'text=/^\\s*Call\\s*Log\\s*$/i')) ||
    (await tryClick(page, 'text=/Call Log/i'));
  if (!opened) throw new Error('Could not find the "Call Log" button');

  // Wait for modal to be visible (title "Call Log" and the submit button)
  await page.getByRole('dialog', { name: /call log/i }).waitFor({ state: 'visible', timeout: 10000 })
    .catch(async () => {
      // Some modals may not expose role=dialog; fallback: wait for Submit button in overlay
      await page.waitForSelector('button:has-text("SUBMIT DETAILS"), text=/SUBMIT DETAILS/i', { timeout: 10000 });
    });
}

async function fillCallLog(page) {
  // Values from environment (you will pass them from Google Sheets → GitHub Action)
  const commType = process.env.COMM_TYPE || '';                // e.g., "PHONE CALL"
  const commWithClient = process.env.COMM_WITH_CLIENT || '';   // e.g., "-- CHOOSE ONE --" or "Kick off call"
  const callType = process.env.CALL_TYPE || '';                // If there is another list/field like "Call"
  const comments = process.env.COMMENTS || '';                 // From "Update" column in Sheet2

  console.log('Filling modal...');

  // Communication Type * (left dropdown in your screenshot)
  if (commType) await fillByLabel(page, 'Communication Type', commType, 'select');

  // Communicate With Client * (right dropdown in your screenshot)
  // If the page sometimes shows a dual-list instead of a select, we handle both:
  if (commWithClient) {
    // Try select first
    let done = false;
    try {
      await fillByLabel(page, 'Communicate With Client', commWithClient, 'select');
      done = true;
    } catch {}
    if (!done) {
      // Fallback: dual list (left list → move arrow → right list)
      // Adjust selectors if your markup differs
      const leftList = page.locator('div[role="listbox"] >> text=' + JSON.stringify(commWithClient));
      if (await leftList.count()) {
        await leftList.first().click();
        // click the middle transfer arrow (assumes a single arrow between lists)
        const transfer =
          page.locator('button:has-text(">"), [data-icon="chevron-right"], .mdi-chevron-right').first();
        await transfer.click({ timeout: 5000 }).catch(() => {});
      }
    }
  }

  // If there is a separate "Call" list/field (your screenshot shows a list named "Call"):
  if (callType) {
    try {
      await fillByLabel(page, 'Call', callType, 'select');
    } catch {
      // maybe it's an input/listbox
      const item = page.locator('div[role="listbox"] >> text=' + JSON.stringify(callType));
      if (await item.count()) await item.first().click();
    }
  }

  // Comments *
  if (comments) await fillByLabel(page, 'Comments', comments, 'text');

  console.log('Submitting...');
  const submitted =
    (await tryClick(page, 'role:button', /submit details/i)) ||
    (await tryClick(page, 'text=/SUBMIT DETAILS/i')) ||
    (await tryClick(page, 'button[type="submit"]'));
  if (!submitted) throw new Error('Could not find "SUBMIT DETAILS" button');

  await page.waitForLoadState('networkidle');
  // Optional success wait (toast/snackbar)
  if (process.env.CONFIRM_SELECTOR) {
    await page.waitForSelector(process.env.CONFIRM_SELECTOR, { timeout: 15000 }).catch(() => {});
  }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await login(page);
    await openProject(page);
    await openCallLogModal(page);
    await fillCallLog(page);
    console.log('OK: Call log submitted');
    process.exit(0);
  } catch (err) {
    console.error('ERROR:', err?.message || err);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
