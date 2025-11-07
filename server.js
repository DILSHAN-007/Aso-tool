// server.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const UserAgent = require('user-agents');

puppeteerExtra.use(StealthPlugin());
puppeteerExtra.use(AdblockerPlugin({ blockTrackers: true }));

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json());

const PORT = process.env.PORT || 5173;
const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox'];

// Optional proxy: set env PROXY="http://username:pass@host:port"
const PROXY = process.env.PROXY || null;
if (PROXY) {
  LAUNCH_ARGS.push(`--proxy-server=${PROXY}`);
}

const TITLE_BOOST = 3;
const REQUEST_DELAY_MS = 700; // base delay between page fetches
const EXTRA_DELAY_VARIATION = 600; // add up to this much random delay

function randDelay() {
  return REQUEST_DELAY_MS + Math.floor(Math.random() * EXTRA_DELAY_VARIATION);
}

function parseInstallString(s) {
  if (!s) return null;
  // remove non digits and + then try to convert to number estimate
  const normalized = s.replace(/[^\dKMkmb\.]/g, '').toUpperCase();
  // common Play Store formats like "1,000+", "10M", "1,000,000+"
  if (/M/.test(normalized)) {
    return parseFloat(normalized.replace('M', '')) * 1_000_000;
  } else if (/K/.test(normalized)) {
    return parseFloat(normalized.replace('K', '')) * 1_000;
  } else {
    const digits = normalized.replace(/[,+]/g, '');
    const n = parseInt(digits, 10);
    return isNaN(n) ? null : n;
  }
}

// small helper: clean text
function cleanText(s) {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

// GET /api/suggest?q=photo editor
app.get('/api/suggest', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ suggestions: [] });
    // Google suggest for apps: ds=apps
    const suggestUrl = `https://suggestqueries.google.com/complete/search?client=firefox&ds=apps&q=${encodeURIComponent(q)}`;
    const r = await fetch(suggestUrl, { timeout: 10000 });
    const txt = await r.text();
    try {
      const data = JSON.parse(txt);
      return res.json({ suggestions: Array.isArray(data[1]) ? data[1] : [] });
    } catch (e) {
      // fallback: extract via regex
      const m = txt.match(/\[".*?",\s*(\[[^\]]+\])/);
      if (m) {
        return res.json({ suggestions: JSON.parse(m[1]) });
      }
      return res.json({ suggestions: [] });
    }
  } catch (err) {
    console.warn('Suggest error', err && err.message);
    return res.status(500).json({ error: 'Suggest failed', detail: err.message });
  }
});

// GET /api/analyze?keyword=photo%20editor&country=us&limit=20
app.get('/api/analyze', async (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  const country = (req.query.country || 'us').trim();
  const limit = Math.min(50, parseInt(req.query.limit || '20', 10));

  if (!keyword) return res.status(400).json({ error: 'keyword required' });

  // launch browser per request (for simplicity). For production use a browser pool.
  let browser;
  try {
    browser = await puppeteerExtra.launch({
      headless: true,
      args: LAUNCH_ARGS
    });

    const page = await browser.newPage();

    // set a realistic user-agent
    const userAgent = new UserAgent();
    await page.setUserAgent(userAgent.toString());
    await page.setViewport({ width: 1200, height: 800 });

    // navigate to Play Store search
    const searchUrl = `https://play.google.com/store/search?q=${encodeURIComponent(keyword)}&c=apps&hl=en&gl=${encodeURIComponent(country)}`;

    // Some pages render lazy; waitForNavigation not always needed; try goto then wait for content
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000 + Math.floor(Math.random() * 800));

    // get HTML and parse first N package ids using cheerio (or evaluate)
    const searchHtml = await page.content();
    const $ = cheerio.load(searchHtml);
    const pkgSet = new Set();
    // search for links with /store/apps/details?id=
    $('a[href*="/store/apps/details?id="]').each((i, el) => {
      if (pkgSet.size >= limit) return;
      const href = $(el).attr('href');
      const m = href && href.match(/\/store\/apps\/details\?id=([^&/]+)/);
      if (m && m[1]) pkgSet.add(m[1]);
    });

    // fallback regex on raw HTML if not enough
    if (pkgSet.size < limit) {
      const regex = /\/store\/apps\/details\?id=([\w\.]+)/g;
      let match;
      while ((match = regex.exec(searchHtml)) && pkgSet.size < limit) {
        pkgSet.add(match[1]);
      }
    }

    const packages = Array.from(pkgSet).slice(0, limit);

    const results = [];
    // fetch each app page sequentially with small random delays (safe)
    for (let i = 0; i < packages.length; i++) {
      const pkg = packages[i];
      const detailUrl = `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=${encodeURIComponent(country)}`;

      try {
        const detailPage = await browser.newPage();
        await detailPage.setUserAgent(new UserAgent().toString());
        await detailPage.setViewport({ width: 1200, height: 900 });
        await detailPage.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // wait for a likely selector (title element) or a small timeout
        try {
          await detailPage.waitForSelector('h1', { timeout: 5000 });
        } catch (e) { /* ignore */ }

        // extract data via DOM
        const meta = await detailPage.evaluate(() => {
          const out = {};
          // Try ld+json
          const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s => s.innerText).join('\n');
          out.ld = ld;
          // Title
          const h1 = document.querySelector('h1 span');
          out.title = h1 ? h1.innerText.trim() : (document.querySelector('h1') ? document.querySelector('h1').innerText.trim() : null);
          // Description
          const descSelector = document.querySelector('[itemprop="description"]');
          out.description = descSelector ? descSelector.innerText.trim() : (document.querySelector('meta[name="description"]') ? document.querySelector('meta[name="description"]').getAttribute('content') : null);
          // Rating
          const ratingEl = document.querySelector('[aria-label*="Rated"]') || document.querySelector('div[role="img"][aria-label*="star"]');
          out.rating = ratingEl ? ratingEl.getAttribute('aria-label') : null;
          // installs: might be in meta or text
          const inst = Array.from(document.querySelectorAll('div')).map(d => d.innerText).find(t => /installs/i.test(t) || /downloads/i.test(t));
          out.installs = inst || null;
          // developer
          const dev = document.querySelector('a[href*="/store/apps/dev"]');
          out.developer = dev ? dev.innerText.trim() : null;
          return out;
        });

        // also get raw html small
        const detailHtml = await detailPage.content();

        // try to parse some fields from ld+json or html with cheerio
        const $d = cheerio.load(detailHtml);
        let description = meta.description || null;
        if (!description) {
          // try to read possible description container
          const descNode = $d('[itemprop="description"]').text();
          description = descNode ? cleanText(descNode) : description;
        }

        // parse installs from meta or text
        let installs = null;
        const instTextCandidates = [
          meta.installs,
          $d('div:contains("Downloads"), div:contains("Downloads")').text(),
          $d('meta[itemprop="interactionCount"]').attr('content'),
          $d('div:contains("+ downloads")').text()
        ].filter(Boolean).join(' | ');
        if (instTextCandidates) {
          // try regex like "1,000,000+" or "1M+"
          const im = instTextCandidates.match(/[\d,.]+(?:\+)?\s*(?:downloads|installs)?|[\d\.]+\s*M|\d+\s*K/i);
          installs = im ? im[0] : instTextCandidates;
        }

        // rating numeric
        let rating = null;
        if (meta.rating) {
          const m = meta.rating.match(/([\d.]+)\s*out of\s*5/i) || meta.rating.match(/([\d.]+)\s*star/i) || meta.rating.match(/Rated\s*([\d.]+)/i);
          if (m) rating = m[1];
        }

        // final cleanup
        description = description ? cleanText(description) : '';
        const title = meta.title ? cleanText(meta.title) : (meta.title === '' ? null : meta.title);
        installs = parseInstallString(installs) || null;
        rating = rating ? parseFloat(rating) : (rating === null ? null : null);

        results.push({
          package: pkg,
          title: title || pkg,
          description,
          installs,
          rating,
          developer: meta.developer || null,
          raw: undefined // don't send big html
        });

        await detailPage.close();
      } catch (err) {
        // push minimal record
        console.warn('detail fetch error', packages[i], err && err.message);
        results.push({ package: packages[i], title: packages[i], description: '', installs: null, rating: null, developer: null });
      }

      // polite delay
      await new Promise(r => setTimeout(r, randDelay()));
    }

    // Close browser
    await browser.close();

    // Keyword extraction (title boosted)
    // tokenization & frequency
    const stopwords = new Set([
      'the','and','for','with','from','this','that','have','your','more','what','when','where','which','will',
      'app','apps','android','mobile','free','pro','plus','-','a','an','in','on','of','to','by','is','are'
    ]);

    function tokenize(s) {
      if (!s) return [];
      return s.toLowerCase().replace(/[\u2018\u2019\u201c\u201d]/g, "'").replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).map(x => x.trim()).filter(Boolean);
    }

    const freqMap = new Map();
    for (const r of results) {
      // title tokens (boost)
      const tTokens = tokenize(r.title || '');
      for (const tk of tTokens) {
        if (tk.length < 3 || stopwords.has(tk)) continue;
        freqMap.set(tk, (freqMap.get(tk) || 0) + TITLE_BOOST);
      }
      // description tokens (normal)
      const dTokens = tokenize(r.description || '');
      for (const tk of dTokens) {
        if (tk.length < 3 || stopwords.has(tk)) continue;
        freqMap.set(tk, (freqMap.get(tk) || 0) + 1);
      }
    }

    // incorporate keyword itself as high priority
    const baseTokens = keyword.split(/\s+/).map(x=>x.trim().toLowerCase()).filter(Boolean);
    for (const t of baseTokens) {
      if (t.length >= 3) freqMap.set(t, (freqMap.get(t) || 0) + TITLE_BOOST * 2);
    }

    // convert freqMap to sorted array
    const freqArr = Array.from(freqMap.entries()).map(([k,v]) => ({ keyword: k, score: v })).sort((a,b) => b.score - a.score);

    // simple difficulty heuristic:
    // difficulty ~ (average installs of top apps) / (appearance count)
    const installsList = results.map(r => r.installs || 0).filter(n => n > 0);
    const avgInstalls = installsList.length ? (installsList.reduce((a,b)=>a+b,0) / installsList.length) : 0;
    // Normalize difficulty into 1-100 scale
    // For each suggested keyword, compute difficulty = clamp( (avgInstalls / (1 + score)) / scaleFactor )
    const scale = Math.max(1, avgInstalls / 100000); // scale factor depends on installs magnitude
    const suggestions = freqArr.slice(0, 120).map(sug => {
      const difficultyRaw = (avgInstalls / (1 + sug.score)) / Math.max(1, scale);
      let difficulty = Math.round(Math.min(100, difficultyRaw));
      if (!isFinite(difficulty) || difficulty <= 0) difficulty = Math.min(100, Math.max(1, Math.round(50 / (1 + sug.score))));
      return { keyword: sug.keyword, score: sug.score, difficulty };
    });

    // prepare response:
    return res.json({
      keyword,
      country,
      limit,
      topCount: results.length,
      avgInstalls: Math.round(avgInstalls),
      competitors: results.map((r,i)=>({ rank: i+1, package: r.package, title: r.title, rating: r.rating, installs: r.installs, developer: r.developer })),
      suggestions
    });

  } catch (err) {
    console.error('analyze error', err && err.message);
    if (browser) try { await browser.close(); } catch(e){}
    return res.status(500).json({ error: 'analyze failed', detail: err && err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ASO scraper API listening on http://localhost:${PORT}`);
  if (PROXY) console.log(`Using proxy: ${PROXY}`);
});
