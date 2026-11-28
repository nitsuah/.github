// Per-app happy paths. Clicks and navigation only: nothing here writes to a
// server. lifefire state lives in this throwaway browser profile's localStorage.
const visible = async (loc, msg) => { await loc.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => { throw new Error(msg); }); };

export const journeys = {
  'nitsuah-io': async ({ page, base, step, shot }) => {
    await step('home renders hero + featured projects', async () => {
      await page.goto(base + '/'); await visible(page.getByRole('heading', { name: /Austin J\. Hardy/ }), 'hero h1 missing');
      await visible(page.getByText('Featured Projects'), 'Featured Projects missing');
    });
    for (const [label, path] of [['ABOUT', '/about'], ['RESUME', '/resume'], ['PROJECTS', '/projects']]) {
      await step(`nav ${label} -> ${path}`, async () => {
        await page.goto(base + '/');
        // Nav items are <a href><button>about</button></a> (button nested in link); target the link.
        await page.locator(`a[href="${path}"]`).filter({ hasText: new RegExp(label, 'i') }).first().click();
        await page.waitForURL((u) => u.pathname.replace(/\/$/, '') === path, { timeout: 10000 });
      });
    }
    await step('blog index -> first post renders', async () => {
      await page.goto(base + '/projects/blogs');
      const a = page.locator('a[href*="/projects/blogs/"]').first(); await visible(a, 'no blog post links');
      await a.click(); await page.waitForURL(/\/projects\/blogs\/.+/, { timeout: 10000 });
      const len = (await page.locator('main').innerText()).length; if (len < 500) throw new Error(`blog post body only ${len} chars`);
    });
    await step('theme toggle flips', async () => {
      await page.goto(base + '/');
      const b = page.getByRole('button', { name: /Switch to (light|dark) mode/ }); await visible(b, 'no theme toggle');
      const before = await b.getAttribute('aria-label'); await b.click(); await page.waitForTimeout(300);
      const after = await page.getByRole('button', { name: /Switch to (light|dark) mode/ }).getAttribute('aria-label');
      if (before === after) throw new Error('theme toggle label did not change');
    });
    await step('no broken images on /projects', async () => {
      await page.goto(base + '/projects', { waitUntil: 'load' }); await page.waitForTimeout(1500);
      const broken = await page.$$eval('img', (is) => is.filter((i) => i.complete && i.naturalWidth === 0 && i.loading !== 'lazy').map((i) => i.src));
      if (broken.length) throw new Error('broken images: ' + broken.slice(0, 5).join(', '));
    });
    await step('phone width: nav reachable', async () => {
      await page.setViewportSize({ width: 390, height: 844 }); await page.goto(base + '/');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      await shot('phone'); await page.setViewportSize({ width: 1280, height: 800 });
      if (overflow > 2) throw new Error(`horizontal overflow ${overflow}px at 390px wide`);
    });
  },

  vhs: async ({ page, base, step, shot }) => {
    await step('anon home renders shelf chrome', async () => { await page.goto(base + '/'); await visible(page.getByRole('heading', { name: 'VHS Box' }), 'no VHS Box heading'); });
    await step('sign-in link targets /auth/google', async () => {
      const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
      if (!hrefs.includes('/auth/google')) throw new Error('no /auth/google link for signed-out user');
    });
    await step('AI badge shows a live backend (not NO AI)', async () => {
      await page.waitForTimeout(2000); const t = await page.locator('body').innerText();
      if (/NO AI/.test(t)) throw new Error('header still reads NO AI for signed-out user');
      if (!/WORKERS AI/i.test(t)) throw new Error('no WORKERS AI badge visible');
    });
    await step('Settings opens with Scan backend picker', async () => {
      if (!(await page.locator('#btn-settings').isVisible())) await page.getByRole('button', { name: '☰' }).click();
      await page.locator('button:visible', { hasText: 'Settings' }).first().click();
      await visible(page.getByText(/Scan backend/i), 'Scan backend picker not in Settings');
      await shot('settings'); await page.keyboard.press('Escape');
    });
    await step('Help (?) opens keyboard shortcuts', async () => {
      if (!(await page.locator('button:visible', { hasText: /Help/ }).count())) await page.getByRole('button', { name: '☰' }).click();
      await page.locator('button:visible', { hasText: /Help/ }).first().click();
      await visible(page.getByText(/Keyboard Shortcuts/), 'help dialog missing'); await page.keyboard.press('Escape');
    });
    await step('phone width: no horizontal overflow', async () => {
      await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await page.waitForTimeout(1000);
      const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); await shot('phone');
      await page.setViewportSize({ width: 1280, height: 800 }); if (o > 2) throw new Error(`horizontal overflow ${o}px`);
    });
  },

  lifefire: async ({ page, base, step, shot }) => {
    await step('first visit: privacy modal -> accept', async () => {
      await page.goto(base + '/');
      const accept = page.getByRole('button', { name: /I Understand.*Continue/i });
      await visible(accept, 'privacy accept button missing'); await accept.click();
    });
    for (const tab of ['Financial Overview', 'Expenses', 'Insights', 'Side Hustle Hub', 'Projections', 'Settings', 'Dashboard']) {
      await step(`tab: ${tab}`, async () => {
        await page.getByRole('button', { name: tab, exact: true }).first().click(); await page.waitForTimeout(600);
        const vis = await page.locator('main, #app, body').first().innerText(); if (vis.length < 200) throw new Error('tab rendered almost nothing');
      });
    }
    await step('Settings shows sync connectors (eBay/Etsy/Plaid/Drive)', async () => {
      await page.getByRole('button', { name: 'Settings', exact: true }).first().click(); await page.waitForTimeout(800);
      const t = await page.locator('body').innerText(); const miss = ['eBay', 'Etsy', 'Plaid', 'Drive'].filter((k) => !t.includes(k));
      await shot('settings'); if (miss.length) throw new Error('missing connector cards: ' + miss.join(', '));
    });
  },

  darkmoon: async ({ page, base, step, shot }) => {
    await step('landing renders CTA', async () => { await page.goto(base + '/'); await visible(page.getByRole('button', { name: /START PLAYING/ }), 'START PLAYING missing'); });
    await step('start solo practice -> WebGL canvas', async () => {
      await page.getByRole('button', { name: /START PLAYING|Play Now/ }).first().click(); await page.waitForTimeout(800);
      const solo = page.getByRole('button', { name: /Solo Practice/ }); if (await solo.isVisible().catch(() => false)) await solo.click();
      await visible(page.locator('canvas'), 'no game canvas after starting'); await page.waitForTimeout(2500); await shot('solo');
    });
  },

  kryptos: async ({ page, base, step, shot }) => {
    await step('K4 grid renders 97 cells', async () => {
      await page.goto(base + '/'); await page.waitForTimeout(1500); const n = await page.locator('[aria-label^="position "]').count();
      if (n !== 97) throw new Error(`expected 97 K4 cells, got ${n}`);
    });
    for (const h of ['ledger', 'attacks', 'lab', 'system', 'k4']) {
      await step(`module #${h} via deep link`, async () => {
        await page.goto(base + '/#' + h); await page.waitForTimeout(1200);
        const t = await page.locator('body').innerText(); if (t.length < 100) throw new Error('module rendered almost nothing');
        const label = await page.locator('[aria-live], .sr-only').allInnerTexts().catch(() => []);
        await shot('mod-' + h);
      });
    }
    await step('Next module arrow cycles', async () => {
      await page.goto(base + '/'); const b = page.getByRole('button', { name: 'Next module' }); await visible(b, 'Next module button missing');
      const before = page.url(); await b.click(); await page.waitForTimeout(500); if (page.url() === before) throw new Error('hash did not change after Next module');
    });
  },

  arcade: async ({ page, base, step, shot }) => {
    const games = [['Asteroid', '/asteroid'], ['Tank Battle', '/fps'], ['Breakout', '/breakout'], ['Invaders', '/space-invaders'], ['Flappy', '/flappy'], ['Snake', '/snake'], ['Pong', '/pong'], ['Memory Match', '/memory-match'], ['Dodge Blocks', '/dodge-blocks']];
    for (const [name, path] of games) {
      await step(`carousel ${name} -> ${path}`, async () => {
        await page.goto(base + '/'); await page.getByRole('button', { name, exact: true }).click();
        await page.waitForURL((u) => u.pathname === path, { timeout: 10000 }); await page.waitForTimeout(1200);
        const hasPlayfield = await page.locator('canvas, [data-testid], button').count(); if (!hasPlayfield) throw new Error('game page has no canvas/controls');
        await shot(path.slice(1));
      });
    }
  },
  vigil: async ({ page, base, step, shot }) => {
    // Cookie-bearing load: a regression here is the OpenNext cookie-parse 1101 (#499).
    await step('home with a Cookie header stays up', async () => {
      const res = await page.context().request.get(base + '/', { headers: { cookie: 'qa=1' } });
      if (res.status() !== 200) throw new Error('GET / with cookie returned ' + res.status());
    });
    await step('login page renders GitHub sign-in', async () => {
      await page.goto(base + '/login');
      const t = await page.locator('body').innerText();
      if (!/sign in|github/i.test(t)) throw new Error('login page missing sign-in copy');
      await shot('login');
    });
  },
};
