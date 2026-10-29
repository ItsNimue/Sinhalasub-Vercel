import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';

const fastify = Fastify({ logger: false });
const BASE_URL = (process.env.BASE_URL || 'https://sinhalasub.lk').replace(/\/+$/, '');
const SITE_HOST = new URL(BASE_URL).hostname.replace(/^www\./, '');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': `${BASE_URL}/`
};
const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

// resolve එක වේගවත් කරන්න: හැම network step එකකටම tight timeout
const PORTAL_TIMEOUT = 12000;   // portal page එක ගන්න
const PROBE_TIMEOUT = 8000;     // candidate link එකක් probe කරන්න

fastify.get('/', async () => ({
    status: true,
    message: 'SinhalaSub TV API is running successfully!',
    endpoints: [
        '/api/search?q=hanna[&type=tv|movie|all]',
        '/api/tv?url=<tvshow url>',
        '/api/tv/season?url=<tvshow url>&season=1',
        '/api/tv/episode?url=<episode url>[&resolve=1]',
        '/api/info?url=<tvshow url>',
        '/api/seasoninfo?url=<tvshow url>&season=1',
        '/api/resolve?url=<sinhalasub.lk/links/... url>[&debug=1]'
    ]
}));

// <<PURE-START>>
// ============================================================
// PURE HELPERS (DOM / network නැතුව test කරන්න පුළුවන් ඒවා)
// ============================================================

const cleanText = (v = '') => String(v).replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const isSiteUrl = (u) => { const h = hostOf(u); return h === SITE_HOST || h.endsWith(`.${SITE_HOST}`); };

function absoluteUrl(href, baseUrl) {
    try { return new URL(String(href || '').trim(), baseUrl).href; } catch { return null; }
}

// /episodes/hanna-s01e01/  ->  { season: 1, episode: 1 }   (s1e1 / s01e01 / 1x01)
function parseEpisodeUrl(url) {
    const u = String(url || '');
    const m = u.match(/[-_/]s0*(\d{1,2})[-_]?e0*(\d{1,3})(?:[-_/?#]|$)/i) ||
              u.match(/[-_/]0*(\d{1,2})x0*(\d{1,3})(?:[-_/?#]|$)/i);
    return m ? { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) } : null;
}

// ?season=2  |  #Season2  |  /Season02  |  explicit param
function parseSeasonRef(url, explicit) {
    if (explicit !== undefined && explicit !== null && /^\d+$/.test(String(explicit).trim())) return parseInt(explicit, 10);
    const u = String(url || '');
    const m = u.match(/[?&]season=0*(\d+)/i) || u.match(/#season[-_]?0*(\d+)/i) || u.match(/\/Season0*(\d+)\/?$/i);
    return m ? parseInt(m[1], 10) : null;
}

function stripSeasonRef(url) {
    let u = String(url || '').replace(/#.*$/, '');
    try { const x = new URL(u); x.searchParams.delete('season'); u = x.href; } catch {}
    return u.replace(/\/Season0*\d+\/?$/i, '/').replace(/\/?$/, '/');
}

// "FHD 1080p | 1.17 GB"  ->  { res: 1080, tag: 'FHD', size: '1.17 GB' }
function qualityInfo(text) {
    const t = String(text || '');
    const res = t.match(/(\d{3,4})\s*p(?![a-z])/i);
    const tag = t.match(/(?<![A-Za-z])(UHD|FHD|HD|SD)(?![A-Za-z])/i);
    const size = t.match(/(\d+(?:\.\d+)?)\s*(MB|GB)(?![a-z])/i);
    return {
        res: res ? parseInt(res[1], 10) : 0,
        tag: tag ? tag[1].toUpperCase() : '',
        size: size ? `${size[1]} ${size[2].toUpperCase()}` : ''
    };
}

function qualityLabel(q) {
    const left = [q.tag, q.res ? `${q.res}p` : ''].filter(Boolean).join(' ');
    return `${left}${q.size ? ` - ${q.size}` : ''}`.trim();
}

// DLServer-01 / DLServer-02 / Telagram / Subtitles
function classifyServer(label, favicon) {
    const s = `${label} ${favicon}`.toLowerCase();
    if (/telegram|telagram|t\.me/.test(s)) return 'telegram';
    if (/subtitle|baiscope|\bsrt\b/.test(s)) return 'subtitle';
    const m = s.match(/dlserver[-\s]*0*(\d+)/);
    return m ? `dl${m[1]}` : 'other';
}

// "Season 3(6 Episodes)Season 2(8 Episodes)" -> Map(3 => 6, 2 => 8)
function parseSeasonCounts(text) {
    const out = new Map();
    for (const m of String(text || '').matchAll(/Season\s*0*(\d{1,2})\s*\(\s*(\d+)\s*Episodes?\s*\)/gi)) {
        out.set(parseInt(m[1], 10), parseInt(m[2], 10));
    }
    return out;
}

// "1 Episode 01Nov. 23, 2021"  ->  { title: 'Episode 01', date: 'Nov. 23, 2021' }
const MONTHS = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?';
function parseEpisodeAnchorText(text, episode) {
    let t = cleanText(text);
    let date = '';
    const dm = t.match(new RegExp(`(${MONTHS}\\s*\\d{1,2},\\s*\\d{4})\\s*$`, 'i'));
    if (dm) { date = dm[1]; t = t.slice(0, dm.index).trim(); }
    t = t.replace(new RegExp(`^0*${episode}(?=\\D)\\s*`), '').trim();
    return { title: t || `Episode ${String(episode).padStart(2, '0')}`, date };
}

// image.tmdb.org/t/p/w154/x.jpg -> w500 (poster එක ලොකුවට)
function tmdbUpgrade(url, size = 'w500') {
    return String(url || '').replace(/\/t\/p\/(?:w\d+|original)\//, `/t/p/${size}/`);
}

function cleanTitle(raw) {
    return cleanText(raw).replace(/\s*[–|-]\s*SinhalaSub\.?LK.*$/i, '').trim();
}

// "Hanna (2019-2021) Sinhala Subtitles | සිංහල උපසිරසි සමඟ" -> "Hanna (2019-2021)"
function showTitle(raw) {
    return cleanText(raw).replace(/\s*(?:Sinhala\s*Subtitles?|සිංහල\s*උපසිරසි).*$/i, '').trim();
}

const BAD_HOST = /(^|\.)(sinhalasub\.lk|tmdb\.org|themoviedb\.org|googleusercontent\.com|google\.com|gstatic\.com|googleapis\.com|w3\.org|schema\.org|jquery\.com|cloudflare\.com|jsdelivr\.net|facebook\.com|twitter\.com|x\.com|pinterest\.com|tumblr\.com|wp\.com|wordpress\.org|youtube\.com|gravatar\.com)$/i;

const isDirectFileUrl = (u) => /\.(mp4|mkv|m4v|webm|avi)(?:$|[?#])/i.test(String(u || ''));

// portal page එකේ HTML (+ script, base64, percent-encoded variants) ඇතුළෙන් හැම URL එකක්ම එකතු කරනවා
function collectUrlCandidates(html) {
    const raw = String(html || '');
    const variants = new Set([raw, raw.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&')]);

    for (const m of raw.matchAll(/["']([A-Za-z0-9+/_-]{24,}={0,2})["']/g)) {
        try {
            const d = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
            if (/https?:\/\//i.test(d)) variants.add(d);
        } catch {}
    }
    for (const m of raw.matchAll(/https?%3A%2F%2F[^"'\s<>\\]+/gi)) {
        try { variants.add(decodeURIComponent(m[0])); } catch {}
    }

    const urls = new Set();
    for (const v of variants) {
        for (const m of v.matchAll(/https?:\/\/(?:[^\s"'<>\\()\]}]|\([^\s"'<>\\()]*\))+/gi)) urls.add(m[0].replace(/[.,;]+$/, ''));
    }
    return [...urls];
}

// candidates අතරින් real download file URL විතරක් (cdn/ddl.sinhalasub.net මුලින්ම)
function pickFinalUrls(urls) {
    const out = [];
    for (const u of urls) {
        const h = hostOf(u);
        if (!h) continue;
        // Pixeldrain: /u/<id>  ->  direct API link
        const pd = u.match(/^https?:\/\/(?:www\.)?pixeldrain\.(?:com|net|dev)\/(?:u|api\/file)\/([A-Za-z0-9_-]+)/i);
        if (pd) { out.push({ url: `https://pixeldrain.com/api/file/${pd[1]}`, rank: 1 }); continue; }
        
        let path = '';
        try { path = new URL(u).pathname; } catch { continue; }

        const isSiteCdn = /(^|\.)sinhalasub\.net$/i.test(h) && path.length > 1 && !/\.(js|css|png|jpe?g|gif|svg|ico|woff2?)$/i.test(path);
        const isFile = isDirectFileUrl(u) && !BAD_HOST.test(h);
        if (isSiteCdn || isFile) out.push({ url: u, rank: /^(cdn|ddl)\.sinhalasub\.net$/i.test(h) ? 0 : isFile ? 1 : 2 });
    }
    out.sort((a, b) => a.rank - b.rank);
    return [...new Set(out.map(x => x.url))];
}
// <<PURE-END>>

// ============================================================
// HTTP HELPERS
// ============================================================

// network / 5xx / 429 errors වලට retry කරනවා (404 වගේ ඒවට නෑ)
async function getWithRetry(url, options = {}, tries = 3) {
    let lastErr;
    for (let i = 1; i <= tries; i++) {
        try {
            return await axios.get(url, { httpsAgent, timeout: 20000, maxRedirects: 10, headers, ...options });
        } catch (err) {
            lastErr = err;
            const status = err.response?.status;
            if (status && status < 500 && status !== 429) break;
            if (i < tries) await sleep(700 * i);
        }
    }
    throw lastErr;
}

const pageCache = new Map();
const PAGE_TTL = 3 * 60 * 1000;

// season / episode / info endpoints එකම TV page එක share කරන නිසා විනාඩි 3ක් cache කරනවා
async function getPage(url) {
    const hit = pageCache.get(url);
    if (hit && Date.now() - hit.t < PAGE_TTL) return hit.v;

    const res = await getWithRetry(url);
    const v = { html: String(res.data || ''), url: res.request?.res?.responseUrl || url };

    if (pageCache.size > 200) pageCache.delete(pageCache.keys().next().value);
    pageCache.set(url, { t: Date.now(), v });
    return v;
}

// ============================================================
// PAGE PARSERS
// ============================================================

function pageTitle($) {
    const t = $('meta[property="og:title"]').attr('content') || $('title').first().text() || $('h1').first().text();
    return cleanTitle(t);
}

function descriptionOf($) {
    const preferred = cleanText($('.wp-content p, [itemprop="description"] p, .description p').first().text());
    if (preferred.length >= 20) return preferred;

    let best = '';
    $('p').each((_, el) => {
        const t = cleanText($(el).text());
        if (t.length > best.length && t.length >= 40 && !/logged in|email address|redirect/i.test(t)) best = t;
    });
    return best;
}

// TV / movie synopsis: .details-desc ඇතුළේ <p> ටික (title line එක අයින්), නැත්නම් හිස්
function synopsisOf($) {
    return $('.details-desc p')
        .map((_, p) => cleanText($(p).text()))
        .get()
        .filter(t => t && !/\(\d{4}(?:-\d{4})?\)\s*Sinhala\s*Subtitles/i.test(t))
        .join('\n\n');
}

function taxonomy($, re, group = 0) {
    const out = [];
    $('a[href]').each((_, el) => {
        const m = String($(el).attr('href') || '').match(re);
        const text = cleanText($(el).text());
        if (m && text && !out.includes(text)) out.push(group ? m[group] : text);
    });
    return out;
}

function showPoster($) {
    let poster = '';
    $('img').each((_, el) => {
        if (poster) return;
        const src = $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('src') || '';
        const label = $(el).attr('title') || $(el).attr('alt') || '';
        if (/image\.tmdb\.org\/t\/p\//.test(src) && /sinhala/i.test(label)) poster = src;
    });
    if (!poster) {
        const p = $('.poster img').first();
        poster = p.attr('data-src') || p.attr('src') || '';
    }
    if (!poster) poster = $('meta[property="og:image"]').attr('content') || '';
    return tmdbUpgrade(poster);
}

function parseEpisodes($, baseUrl) {
    const map = new Map();

    $('a[href*="/episodes/"]').each((_, el) => {
        const link = absoluteUrl($(el).attr('href'), baseUrl);
        if (!link || !isSiteUrl(link) || !/\/episodes\/[^/?#]+\/?$/.test(link)) return;

        const se = parseEpisodeUrl(link);
        if (!se) return;

        const { title, date } = parseEpisodeAnchorText($(el).text(), se.episode);
        const key = link.replace(/\/?$/, '/');
        const prev = map.get(key);

        // එකම episode එකට anchors දෙකක් (image / text) තිබුණොත් text තියෙන එක තියාගන්නවා
        if (!prev || (prev.date === '' && date) || title.length > prev.title.length) {
            map.set(key, { season: se.season, episode: se.episode, title, date, link: key });
        }
    });

    return [...map.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function buildSeasons($, episodes) {
    const counts = parseSeasonCounts($('body').text());
    const numbers = new Set([...counts.keys(), ...episodes.map(e => e.season)]);

    // Episodes list එක නැත්නම් "Seasons: 03" field එකෙන් අඩුම තරමින් seasons ගණන
    if (numbers.size === 0) {
        const m = cleanText($('body').text()).match(/Seasons\s*:\s*0*(\d{1,2})/i);
        if (m) for (let i = 1; i <= parseInt(m[1], 10); i++) numbers.add(i);
    }

    return [...numbers].sort((a, b) => a - b).map(n => ({
        season: n,
        episodes: counts.get(n) ?? episodes.filter(e => e.season === n).length
    }));
}

function parseShow($, pageUrl) {
    const fullTitle = pageTitle($);
    const episodes = parseEpisodes($, pageUrl);
    return {
        fullTitle,
        title: showTitle(fullTitle),
        poster: showPoster($),
        description: synopsisOf($),
        year: taxonomy($, /\/release\/(\d{4})\/?$/, 1)[0] || '',
        country: taxonomy($, /\/ztcountry\/[^/]+\/?$/),
        genres: taxonomy($, /\/genre\/[^/]+\/?$/),
        creator: taxonomy($, /\/creator\/[^/]+\/?$/),
        cast: taxonomy($, /\/cast\/[^/]+\/?$/),
        networks: taxonomy($, /\/network\/[^/]+\/?$/),
        studios: taxonomy($, /\/studio\/[^/]+\/?$/),
        episodes,
        seasons: buildSeasons($, episodes)
    };
}

// episode page එකේ links tables (DLServer-01 / DLServer-02 / Telagram / Subtitles)
function parseDownloadRows($, pageUrl) {
    const rows = [];
    const seen = new Set();

    $('a[href]').each((_, el) => {
        const link = absoluteUrl($(el).attr('href'), pageUrl);
        if (!link || !isSiteUrl(link) || !/\/links\/[A-Za-z0-9_-]+\/?$/.test(link)) return;

        const portal = link.replace(/\/?$/, '/');
        if (seen.has(portal)) return;
        seen.add(portal);

        const label = cleanText($(el).text());
        const row = $(el).closest('tr');
        const favicon = (row.length ? row : $(el).parent()).find('img').first().attr('src') || '';
        const cells = row.length
            ? row.find('td').map((_, td) => cleanText($(td).text())).get()
            : [cleanText($(el).parent().text())];

        const q = qualityInfo(cells.join(' | '));
        const hostMatch = favicon.match(/[?&]domain=([^&]+)/);

        rows.push({
            label,
            server: classifyServer(label, favicon),
            host: hostMatch ? decodeURIComponent(hostMatch[1]) : '',
            ...q,
            link: portal
        });
    });

    return rows;
}

// DLServer-01 මුලින්ම, ඊට පස්සේ DLServer-02. Telegram / Subtitles ඉවත් කරනවා.
function buildDlLinks(rows) {
    const rank = (s) => (s === 'dl1' ? 0 : s === 'dl2' ? 1 : 2);
    const usable = rows
        .filter(r => r.server !== 'telegram' && r.server !== 'subtitle' && r.res > 0)
        .sort((a, b) => rank(a.server) - rank(b.server));

    const seenQuality = new Map();
    return usable.map(r => {
        const base = qualityLabel(r);
        const count = (seenQuality.get(base) || 0) + 1;
        seenQuality.set(base, count);

        return {
            quality: count === 1 ? base : `${base} (Option ${count})`,
            size: r.size,
            server: r.label,
            host: r.host,
            link: r.link,
            links: [],
            page: r.link,
            resolved: false
        };
    });
}

// ============================================================
// LINK RESOLVER
// episode page -> sinhalasub.lk/links/<id>/ (Secure Download Portal) -> cdn.sinhalasub.net/...mp4
// ============================================================

const isPortalUrl = (u) => isSiteUrl(u) && /\/links\/[A-Za-z0-9_-]+\/?$/.test(String(u || ''));

const MIN_VIDEO_BYTES = 5 * 1024 * 1024;

// URL එක ඇත්තටම video file එකක්ද (bytes 0-1023 විතරක් ඉල්ලලා) බලනවා
async function probeUrl(url, timeout = PROBE_TIMEOUT) {
    try {
        const res = await axios.get(url, {
            httpsAgent,
            responseType: 'stream',
            timeout,
            maxRedirects: 8,
            validateStatus: s => s >= 200 && s < 400,
            headers: { 'User-Agent': UA, 'Range': 'bytes=0-1023', 'Referer': `${BASE_URL}/` }
        });
        res.data.destroy();

        const type = String(res.headers['content-type'] || '').toLowerCase();
        const range = String(res.headers['content-range'] || '');
        const total = range.includes('/') ? parseInt(range.split('/')[1], 10) : parseInt(res.headers['content-length'] || '0', 10);
        const finalUrl = res.request?.res?.responseUrl || url;

        if (type.includes('text/html') || type.includes('json') || type.startsWith('text/')) return { ok: false, definite: true, reason: `HTML page (${type})` };
        if (!total || total < MIN_VIDEO_BYTES) return { ok: false, definite: true, reason: `size too small (${total || 0} bytes)` };
        return { ok: true, url: finalUrl, size: total, type };
    } catch (err) {
        return { ok: false, definite: false, reason: err.message };
    }
}

// portal page එකේ structure එක බලාගන්න (/api/resolve?debug=1)
function portalDebug($, html) {
    const attrsOf = (el) => Object.fromEntries(Object.entries(el.attribs || {}).filter(([k]) => /^(data-|on|href|src|id|class|type|name|value)/.test(k)).map(([k, v]) => [k, String(v).slice(0, 200)]));

    return {
        htmlLength: html.length,
        scripts: $('script').map((_, el) => {
            const src = $(el).attr('src');
            return src ? { src } : { inline: ($(el).html() || '').slice(0, 3000) };
        }).get().slice(0, 14),
        links: $('a[href]').map((_, el) => ({ href: $(el).attr('href'), text: cleanText($(el).text()).slice(0, 60) })).get()
            .filter(a => a.href && !/^(javascript:|#)/i.test(a.href)).slice(0, 40),
        buttons: $('button, [data-url], [data-link], [data-href], [onclick]').map((_, el) => ({
            tag: el.tagName, text: cleanText($(el).text()).slice(0, 60), attrs: attrsOf(el)
        })).get().slice(0, 20),
        forms: $('form').map((_, el) => ({
            action: $(el).attr('action'), method: $(el).attr('method'),
            inputs: $(el).find('input, select, textarea').map((_, i) => attrsOf(i)).get().slice(0, 12)
        })).get().slice(0, 6),
        hints: {
            ajax: [...new Set(html.match(/[^"'\s]*admin-ajax\.php[^"'\s]*/g) || [])].slice(0, 5),
            actions: [...new Set([...html.matchAll(/action['"]?\s*[:=]\s*['"]([\w-]+)['"]/g)].map(m => m[1]))].slice(0, 10),
            urls: collectUrlCandidates(html).filter(u => !/tmdb|googleusercontent|w3\.org/i.test(u)).slice(0, 40)
        }
    };
}

// ------------------------------------------------------------
// RESOLVE  (portal -> cdn link)  -  වේගවත් කරපු version
//
//  පරණ විදිහ: candidates 6ක් දක්වා එකින් එක probe කළා, verified එකක් හම්බුණාට නවතින්නේ නෑ.
//             hang වෙන candidate එකකට තත්පර 20 බැගින් -> විනාඩි ගණනක්.
//  අලුත් විදිහ: candidates එකවර probe කරනවා, මුලින්ම verify වෙන එකෙන් නවතිනවා (cdn host මුලින්).
//             ඒ වගේම විනාඩි 10ක් cache කරනවා, එකම link එකට එකවර requests දෙකක් ආවොත් එක resolve එකයි.
// ------------------------------------------------------------
const RESOLVE_TTL = 10 * 60 * 1000;
const resolveCache = new Map();      // portal url -> { t, v }
const resolveInflight = new Map();   // portal url -> Promise

const isCdnHost = (u) => /^(cdn|ddl)\.sinhalasub\.net$/i.test(hostOf(u));

function firstWorking(urls, timeout = PROBE_TIMEOUT) {
    return new Promise((resolve) => {
        const unverified = [];
        let pending = urls.length;
        let finished = false;
        if (!pending) return resolve({ verified: null, unverified });

        for (const url of urls) {
            // probe එක hang වුණත් timeout + 2s ට වඩා බලාගෙන ඉන්නේ නෑ
            Promise.race([
                probeUrl(url, timeout),
                sleep(timeout + 2000).then(() => ({ ok: false, definite: false, reason: 'timeout' }))
            ])
                .then((probe) => {
                    if (finished) return;
                    if (probe.ok) { finished = true; return resolve({ verified: probe, unverified }); }
                    if (!probe.definite) unverified.push({ url });
                })
                .catch(() => {})
                .finally(() => {
                    pending--;
                    if (!finished && pending === 0) { finished = true; resolve({ verified: null, unverified }); }
                });
        }
    });
}

async function resolvePortalRaw(portalUrl, { debug = false } = {}) {
    const t0 = Date.now();
    const fail = (extra = {}) => ({ link: portalUrl, links: [], page: portalUrl, resolved: false, ms: Date.now() - t0, ...extra });

    if (!portalUrl || !/^https?:\/\//i.test(portalUrl)) return fail();

    // දැනටමත් direct file එකක් (cdn.sinhalasub.net/...mp4)
    if (!isSiteUrl(portalUrl) && (isDirectFileUrl(portalUrl) || /(^|\.)sinhalasub\.net$/i.test(hostOf(portalUrl)))) {
        return { link: portalUrl, links: [portalUrl], page: null, resolved: true, ms: 0 };
    }
    if (!isPortalUrl(portalUrl)) return fail({ error: 'Not a sinhalasub.lk /links/ URL' });

    const res = await getWithRetry(portalUrl, { headers: { ...headers, Referer: `${BASE_URL}/` }, timeout: PORTAL_TIMEOUT }, 2);
    const html = String(res.data || '');
    const landed = res.request?.res?.responseUrl;

    const candidates = [];
    if (landed && landed !== portalUrl && isDirectFileUrl(landed)) candidates.push(landed);
    candidates.push(...pickFinalUrls(collectUrlCandidates(html)));

    const unique = [...new Set(candidates)].slice(0, 6);
    const cdn = unique.filter(isCdnHost);
    const others = unique.filter((u) => !isCdnHost(u));

    // 1) cdn/ddl.sinhalasub.net  2) ඒවා fail නම් විතරක් අනිත් ඒවා
    let outcome = await firstWorking(cdn);
    if (!outcome.verified && others.length) {
        const more = await firstWorking(others);
        outcome = { verified: more.verified, unverified: [...outcome.unverified, ...more.unverified] };
    }

    const found = outcome.verified
        ? [{ url: outcome.verified.url, size: outcome.verified.size }]
        : outcome.unverified.map((x) => ({ url: x.url }));

    const result = found.length
        ? { link: found[0].url, links: found.map(f => f.url), size: found[0].size || null, verified: !!outcome.verified, page: portalUrl, resolved: true, probed: unique.length, ms: Date.now() - t0 }
        : fail({ error: 'Final download link not found on portal page', probed: unique.length });

    if (debug) result.debug = portalDebug(cheerio.load(html), html);
    console.log(`resolve ${portalUrl} -> ${result.resolved ? (result.verified ? 'ok' : 'unverified') : 'FAIL'} ${result.ms}ms (candidates: ${unique.length})`);
    return result;
}

// Any link -> { link, links, page, resolved }
async function resolvePortal(portalUrl, { debug = false } = {}) {
    if (debug) return resolvePortalRaw(portalUrl, { debug });

    const hit = resolveCache.get(portalUrl);
    if (hit && Date.now() - hit.t < RESOLVE_TTL) return { ...hit.v, cached: true };

    if (resolveInflight.has(portalUrl)) return resolveInflight.get(portalUrl);

    const p = resolvePortalRaw(portalUrl)
        .then((v) => {
            if (v.resolved && v.verified) {
                if (resolveCache.size > 500) resolveCache.delete(resolveCache.keys().next().value);
                resolveCache.set(portalUrl, { t: Date.now(), v });
            }
            return v;
        })
        .finally(() => resolveInflight.delete(portalUrl));

    resolveInflight.set(portalUrl, p);
    return p;
}

// default: resolve කරනවා (cinesubz වගේ). ?resolve=0 දුන්නොත් විතරක් portal links ආපහු දෙනවා
const shouldResolve = (q) => !['0', 'false', 'no'].includes(String(q.resolve ?? '1').toLowerCase());

async function resolveAll(dlLinks) {
    await Promise.all(dlLinks.map(async (item) => {
        try {
            const r = await resolvePortal(item.link);
            // size ("1.17 GB") overwrite වෙන්න දෙන්නේ නෑ, real bytes වෙනම field එකක
            Object.assign(item, { link: r.link, links: r.links, page: r.page, resolved: r.resolved, verified: !!r.verified, bytes: r.size || null });
        } catch (err) {
            console.error('Resolve error:', err.message);
        }
    }));
    return dlLinks;
}

// ============================================================
// ENDPOINTS
// ============================================================

const bad = (reply, msg, code = 400) => reply.status(code).send({ status: false, error: msg });

// ---- Search ------------------------------------------------
const GENERIC_TITLE = /^(watch|view|play|more|read more|details|open|download|trailer)$/i;

function parseSearch(html, query, type) {
    const $ = cheerio.load(html);
    const found = new Map();

    $('a[href]').each((_, el) => {
        const href = absoluteUrl($(el).attr('href'), BASE_URL);
        const m = href && href.match(/^https?:\/\/(?:www\.)?[^/]+\/(tvshows|movies)\/([^/?#]+)\/?$/i);
        if (!m || !isSiteUrl(href)) return;

        const kind = m[1].toLowerCase() === 'tvshows' ? 'tv' : 'movie';
        if (type !== 'all' && kind !== type) return;

        const img = $(el).find('img').first();
        const card = $(el).closest('article, .result-item, li').first();
        const image = img.attr('data-src') || img.attr('data-lazy-src') || img.attr('src') ||
            card.find('img').first().attr('data-src') || card.find('img').first().attr('src') || '';

        let title = cleanText(img.attr('alt') || img.attr('title') || $(el).attr('title') || $(el).text());
        if (!title || GENERIC_TITLE.test(title)) title = cleanText(card.find('h1, h2, h3, .title').first().text());
        if (!title) title = m[2].replace(/-/g, ' ');

        // එකම result එකට anchors කීපයක් (poster / title / "Watch" button) තියෙන නිසා හොඳම title + image එක තියාගන්නවා
        const key = href.replace(/\/?$/, '/');
        const prev = found.get(key);
        const goodPrev = prev && prev.title && !GENERIC_TITLE.test(prev.title);
        const goodNew = title && !GENERIC_TITLE.test(title);
        found.set(key, {
            title: goodPrev ? prev.title : (goodNew ? title : (prev?.title || title)),
            link: key,
            image: prev?.image || tmdbUpgrade(image, 'w342'),
            type: kind
        });
    });

    let results = [...found.values()];

    // Search page එක නෙවෙයි (home page එකට redirect වුනා වගේ) නම් query එකට ගැලපෙන ඒවා විතරක්
    const looksLikeSearch = /search|searched/i.test($('title').text()) || cleanText($('title').text()).toLowerCase().includes(String(query).toLowerCase());
    if (!looksLikeSearch) {
        const tokens = String(query).toLowerCase().split(/\s+/).filter(t => t.length > 1);
        results = results.filter(r => tokens.some(t => `${r.title} ${r.link}`.toLowerCase().includes(t)));
    }
    return results;
}

// HTML search වලින් කිසිවක් නැත්නම් WordPress REST search එක
async function wpSearch(query, type) {
    const subtype = type === 'movie' ? 'movies' : type === 'all' ? '' : 'tvshows';
    const url = `${BASE_URL}/wp-json/wp/v2/search?search=${encodeURIComponent(query)}&per_page=20${subtype ? `&subtype=${subtype}` : ''}&_fields=title,url,subtype`;
    try {
        const { data } = await getWithRetry(url, { headers: { ...headers, Accept: 'application/json' }, timeout: 15000 }, 2);
        if (!Array.isArray(data)) return [];
        return data
            .filter(d => d?.url && /\/(tvshows|movies)\//.test(d.url))
            .map(d => ({
                title: cleanText(String(d.title || '').replace(/&#8211;|&#8217;|&amp;/g, m => ({ '&#8211;': '–', '&#8217;': '’', '&amp;': '&' }[m]))),
                link: d.url.replace(/\/?$/, '/'),
                image: '',
                type: /\/tvshows\//.test(d.url) ? 'tv' : 'movie'
            }));
    } catch {
        return [];
    }
}

fastify.get('/api/search', async (request, reply) => {
    try {
        const query = cleanText(request.query.q);
        if (!query) return bad(reply, 'Query required');

        const type = ['tv', 'movie', 'all'].includes(String(request.query.type || 'all').toLowerCase())
            ? String(request.query.type || 'all').toLowerCase() : 'all';

        let results = [];
        try {
            const { html } = await getPage(`${BASE_URL}/?s=${encodeURIComponent(query)}`);
            results = parseSearch(html, query, type);
        } catch (err) {
            console.error('Search HTML error:', err.message);
        }
        if (results.length === 0) results = await wpSearch(query, type);

        return { status: true, count: results.length, result: results };
    } catch (err) {
        console.error('Search Error:', err.message);
        return bad(reply, err.message, 500);
    }
});

// ---- TV show -----------------------------------------------
async function loadShow(rawUrl) {
    const showUrl = stripSeasonRef(rawUrl);
    const page = await getPage(showUrl);
    const $ = cheerio.load(page.html);
    return { showUrl: stripSeasonRef(page.url), show: parseShow($, page.url) };
}

const isShowUrl = (u) => isSiteUrl(u) && /\/tvshows\/[^/?#]+/i.test(String(u || ''));

fastify.get('/api/tv', async (request, reply) => {
    try {
        const url = request.query.url;
        if (!url) return bad(reply, 'URL required');
        if (!isShowUrl(url)) return bad(reply, 'Invalid TV Show URL');

        const { showUrl, show } = await loadShow(url);

        return {
            status: true,
            result: {
                title: show.title,
                poster: show.poster,
                seasons: show.seasons.map(s => ({
                    season: s.season,
                    title: `Season ${String(s.season).padStart(2, '0')}`,
                    episodes: s.episodes,
                    link: `${showUrl}?season=${s.season}`
                }))
            }
        };
    } catch (err) {
        console.error('TV Details Error:', err.message);
        return bad(reply, err.message, 500);
    }
});

fastify.get('/api/tv/season', async (request, reply) => {
    try {
        const url = request.query.url;
        if (!url) return bad(reply, 'URL required');
        if (!isShowUrl(url)) return bad(reply, 'Invalid Season URL');

        const season = parseSeasonRef(url, request.query.season);
        if (season === null) return bad(reply, 'Season number not found (use ?season=1)');

        const { show } = await loadShow(url);
        const episodes = show.episodes.filter(e => e.season === season);
        if (episodes.length === 0) return bad(reply, `Season ${season} episodes not found`, 404);

        return { status: true, result: { title: show.title, season, episodes } };
    } catch (err) {
        console.error('TV Season Error:', err.message);
        return bad(reply, err.message, 500);
    }
});

// ---- Episode -----------------------------------------------
// ?resolve=1 නැත්නම් links resolve කරන්නේ නෑ (portal එකට එක්කෙනාට තත්පර ගණනක් යන නිසා).
// Bot එක download කරන වෙලාවේ /api/resolve?url=<page> එකෙන් real link එක ගන්නවා.
fastify.get('/api/tv/episode', async (request, reply) => {
    try {
        const url = request.query.url;
        if (!url) return bad(reply, 'URL required');
        if (!isSiteUrl(url) || !/\/episodes\/[^/?#]+/i.test(url)) return bad(reply, 'Invalid Episode URL');

        const page = await getPage(url);
        const $ = cheerio.load(page.html);

        const body = cleanText($('body').text());
        const epTitle = body.match(/Episode\s*Title\s*:\s*(.*?)(?=\s*(?:Serie\s*:|Share\s*\d*|Links\b|$))/i);
        const serie = body.match(/Serie\s*:\s*(.*?)(?=\s*(?:Share\s*\d*|Links\b|$))/i);
        const se = parseEpisodeUrl(page.url) || parseEpisodeUrl(url);

        const rows = parseDownloadRows($, page.url);
        let dlLinks = buildDlLinks(rows);

        if (shouldResolve(request.query)) await resolveAll(dlLinks);

        return {
            status: true,
            result: {
                title: pageTitle($),
                series: cleanText(serie?.[1] || ''),
                episodeTitle: cleanText(epTitle?.[1] || '') || (se ? `Episode ${String(se.episode).padStart(2, '0')}` : 'Episode'),
                season: se?.season ?? null,
                episode: se?.episode ?? null,
                poster: tmdbUpgrade($('meta[property="og:image"]').attr('content') || ''),
                description: descriptionOf($),
                subtitles: rows.filter(r => r.server === 'subtitle').map(r => r.link),
                dl_links: dlLinks
            }
        };
    } catch (err) {
        console.error('TV Episode Error:', err.message);
        return bad(reply, err.message, 500);
    }
});

// ---- Movie -------------------------------------------------
const isMovieUrl = (u) => isSiteUrl(u) && /\/movies\/[^/?#]+/i.test(String(u || ''));

// "Stars" සහ "Top Cast" දෙකේම එකම නළුවා එන නිසා slug එකෙන් duplicate අයින් කරලා කෙටි නම තියාගන්නවා
function castOf($) {
    const best = new Map();
    $('a[href]').each((_, el) => {
        const m = String($(el).attr('href') || '').match(/\/cast\/([^/?#]+)\/?$/);
        const name = cleanText($(el).text());
        if (!m || !name) return;
        const prev = best.get(m[1]);
        if (!prev || name.length < prev.length) best.set(m[1], name);
    });
    return [...best.values()];
}

function parseMovie($, pageUrl) {
    const fullTitle = pageTitle($);
    const body = cleanText($('body').text());

    // සාරාංශය: .details-desc ඇතුළේ <p> ටික (නැත්නම් හිස්)
    const plot = $('.details-desc p')
        .map((_, p) => cleanText($(p).text()))
        .get()
        .filter(t => t && !/Sinhala\s*Subtitles\s*$/i.test(t))   // "Title (2026) Sinhala Subtitles" line එක අයින්
        .join('\n\n');

    return {
        title: showTitle(fullTitle),
        poster: showPoster($),
        year: taxonomy($, /\/release\/(\d{4})\/?$/, 1)[0] || (fullTitle.match(/\((\d{4})\)/) || [])[1] || '',
        director: taxonomy($, /\/director\/[^/]+\/?$/).join(', '),
        country: taxonomy($, /\/ztcountry\/[^/]+\/?$/).join(', '),
        genres: taxonomy($, /\/genre\/[^/]+\/?$/),
        imdb: (body.match(/IMDb\s*:\s*(\d{1,2}(?:\.\d{1,2})?)/i) || [])[1] || null,
        cast: castOf($).join(', '),
        description: plot.length >= 20 ? plot : ''
    };
}

async function loadMovie(rawUrl) {
    const page = await getPage(String(rawUrl).replace(/#.*$/, ''));
    const $ = cheerio.load(page.html);
    return { $, page, movie: parseMovie($, page.url) };
}

fastify.get('/api/movie', async (request, reply) => {
    try {
        const url = request.query.url;
        if (!url) return bad(reply, 'URL required');
        if (!isMovieUrl(url)) return bad(reply, 'Invalid Movie URL');

        const { $, page, movie } = await loadMovie(url);

        // 1) links ටික වෙනම හදාගන්නවා
        const dlLinks = buildDlLinks(parseDownloadRows($, page.url));

        // 2) resolve කරනවා (පියවර 1 හි දාපු helper දෙක පාවිච්චි කරලා)
        if (shouldResolve(request.query)) await resolveAll(dlLinks);

        // 3) return එකේ dl_links: dlLinks
        return {
            status: true,
            result: {
                title: movie.title,
                poster: movie.poster,
                year: movie.year,
                imdb: movie.imdb,
                dl_links: dlLinks
            }
        };
    } catch (err) {
        console.error('Movie Error:', err.message);
        return bad(reply, err.message, 500);
    }
});

// ---- Info / Season info ------------------------------------
fastify.get('/api/info', async (request, reply) => {
    try {
        const url = request.query.url;
        if (!url) return bad(reply, 'URL required');
        if (isMovieUrl(url)) {
            const { movie } = await loadMovie(url);
            return {
                status: true,
                result: {
                    title: movie.title.replace(/\s*\(\d{4}\)\s*$/, ''),
                    poster: movie.poster,
                    director: movie.director,
                    year: movie.year,
                    imdb: movie.imdb,
                    country: movie.country,
                    genres: movie.genres,
                    cast: movie.cast,
                    description: movie.description
                }
            };
        }
        if (!isShowUrl(url)) return bad(reply, 'Invalid TV Show URL');

        const { show } = await loadShow(url);
        return {
            status: true,
            result: {
                title: show.title,
                poster: show.poster,
                year: show.year,
                country: show.country.join(', '),
                genres: show.genres,
                creator: show.creator.join(', '),
                cast: show.cast.join(', '),
                networks: show.networks.join(', '),
                studios: show.studios.join(', '),
                description: show.description,
                seasons: show.seasons,
                totalSeasons: show.seasons.length,
                totalEpisodes: show.seasons.reduce((n, s) => n + (s.episodes || 0), 0)
            }
        };
    } catch (err) {
        console.error('Info Error:', err.message);
        return bad(reply, err.message, 500);
    }
});

fastify.get('/api/seasoninfo', async (request, reply) => {
    try {
        const url = request.query.url;
        if (!url) return bad(reply, 'URL required');
        if (!isShowUrl(url)) return bad(reply, 'Invalid TV Show URL');

        const season = parseSeasonRef(url, request.query.season);
        if (season === null) return bad(reply, 'Season number not found (use ?season=1)');

        const { show } = await loadShow(url);
        const s = show.seasons.find(x => x.season === season);
        if (!s) return bad(reply, `Season ${season} not found`, 404);

        return {
            status: true,
            result: {
                title: show.title,
                poster: show.poster,
                year: show.year,
                country: show.country.join(', '),
                genres: show.genres,
                creator: show.creator.join(', '),
                cast: show.cast.join(', '),
                networks: show.networks.join(', '),
                studios: show.studios.join(', '),
                description: show.description,
                season,
                episodes: s.episodes
            }
        };
    } catch (err) {
        console.error('Season Info Error:', err.message);
        return bad(reply, err.message, 500);
    }
});

// ---- Resolve -----------------------------------------------
fastify.get('/api/resolve', async (request, reply) => {
    try {
        const url = request.query.url;
        if (!url) return bad(reply, 'URL required');

        const debug = ['1', 'true', 'yes'].includes(String(request.query.debug || '').toLowerCase());
        const result = await resolvePortal(url, { debug });
        return { status: result.resolved, result };
    } catch (err) {
        console.error('Resolve Error:', err.message);
        return bad(reply, err.message, 500);
    }
});

// Vercel එකේදී fastify.listen() කරන්නේ නෑ (serverless function එකක් විදිහට api/index.js
// හරහා request handle කරනවා). local/Railway වගේ සාමාන්‍ය server එකක් විදිහට run කරනකොටම listen කරනවා.
export default fastify;

if (!process.env.VERCEL) {
    const PORT = process.env.PORT ? process.env.PORT : 3000;
    fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
        if (err) console.error(err);
        else console.log(`🚀 API running on port ${PORT}`);
    });
}
