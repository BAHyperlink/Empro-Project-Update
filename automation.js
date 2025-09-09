async function findFill(pageOrFrame, candidates, value) {
  for (const sel of candidates.filter(Boolean)) {
    try {
      const loc = sel.startsWith('label:')
        ? pageOrFrame.getByLabel(sel.replace(/^label:/, ''), { exact: true })
        : pageOrFrame.locator(sel);
      await loc.first().waitFor({ state: 'visible', timeout: 2000 });
      await loc.first().fill(String(value ?? ''), { timeout: 5000 });
      return true;
    } catch (_) { /* try next */ }
  }
  return false;
}
//Add this comment
async function login(page) {
  const loginUrl   = process.env.LOGIN_URL;
  const username   = process.env.LOGIN_USERNAME;
  const password   = process.env.LOGIN_PASSWORD;
  const workplace  = process.env.WORKPLACE || '';
  const desk       = process.env.DESK_NUMBER || '';
  const rememberMe = (process.env.REMEMBER_ME || '').toLowerCase() === 'true';
  const postLogin  = process.env.POST_LOGIN_READY_SELECTOR || '';

  if (!loginUrl) throw new Error('LOGIN_URL is required');

  console.log('Navigating to login…');
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  // Try top-level frame first, then any iframes (some auth pages render inside an iframe)
  const frames = [page, ...page.frames()];

  const userCandidates = [
  '#username',                 // <— hardcode exact selector
  process.env.USERNAME_SELECTOR,
  'label:Username', 'label:User Name',
  '[name="username"]', '#UserName',
  'input[autocomplete="username"]',
  'input[placeholder*="user" i]',
  'input[type="email"]', 'input[type="text"]'
];

const passCandidates = [
  '#password',                 
  process.env.PASSWORD_SELECTOR,
  'label:Password',
  '[name="password"]', '#Password',
  'input[autocomplete="current-password"]',
  'input[placeholder*="pass" i]',
  'input[type="password"]'
];

  let filledUser = false, filledPass = false;
  for (const f of frames) {
    if (!filledUser) filledUser = await findFill(f, userCandidates, username);
    if (!filledPass) filledPass = await findFill(f, passCandidates, password);
  }
  if (!filledUser) throw new Error('Could not locate the username field');
  if (!filledPass) throw new Error('Could not locate the password field');

  // Optional fields on your login page
  if (workplace) {
    for (const f of frames) {
      try { await f.getByLabel('Work Place', { exact: true }).selectOption({ label: workplace }); break; } catch {}
      try { await f.locator('select[name*="work" i]').selectOption({ label: workplace }); break; } catch {}
    }
  }
  if (desk) {
    for (const f of frames) {
      try { await f.getByLabel('Desk Number', { exact: true }).fill(String(desk)); break; } catch {}
      try { await f.locator('input[name*="desk" i]').fill(String(desk)); break; } catch {}
    }
  }
  if (process.env.REMEMBER_ME) {
    for (const f of frames) {
      try {
        const cb = f.getByLabel('Remember Me', { exact: true });
        const want = rememberMe;
        const checked = await cb.isChecked().catch(() => false);
        if (want && !checked) await cb.check({ timeout: 2000 });
        if (!want && checked) await cb.uncheck({ timeout: 2000 });
        break;
      } catch {}
    }
  }

  // Click Login (several fallbacks)
  const clicked =
    (await tryClick(page, 'role:button', /login/i)) ||
    (await tryClick(page, 'button[type="submit"]')) ||
    (await tryClick(page, 'input[type="submit"]')) ||
    (await tryClick(page, 'text=/^\\s*Login\\s*$/i')) ||
    (await tryClick(page, 'text=/Sign in|Sign In/i'));
  if (!clicked) throw new Error('Could not find Login submit button');

  await page.waitForLoadState('networkidle');
  if (postLogin) {
    await page.waitForSelector(postLogin, { timeout: 15000 });
  }
  console.log('Login complete.');
}
