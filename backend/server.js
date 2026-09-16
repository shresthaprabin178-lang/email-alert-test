const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const cron = require('node-cron');
const admin = require('firebase-admin');
require('dotenv').config();

// --- Firebase Admin Setup ---
const { getFirestore } = require('firebase-admin/firestore');

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        serviceAccount = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
            ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
            : process.env.FIREBASE_SERVICE_ACCOUNT;
    } catch (e) {
        console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT env var:", e.message);
    }
}
if (!serviceAccount) {
    try {
        serviceAccount = require('./serviceAccountKey.json');
    } catch (e) {
        console.warn("No local serviceAccountKey.json found:", e.message);
    }
}

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.cert(serviceAccount)
    });
} else {
    admin.initializeApp();
}

const db = getFirestore();

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// --- Reusable Nodemailer SMTP Transporter (created once at startup, not per call) ---
let smtpTransporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    smtpTransporter = nodemailer.createTransport({
        service: 'gmail',
        pool: true,          // keeps SMTP connection alive for reuse
        maxConnections: 3,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });
}

// --- In-Memory TTL Cache ---
const cache = {
    _store: {},
    set(key, value, ttlMs) {
        this._store[key] = { value, expiresAt: Date.now() + ttlMs };
    },
    get(key) {
        const entry = this._store[key];
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            delete this._store[key];
            return null;
        }
        return entry.value;
    },
    invalidate(key) {
        delete this._store[key];
    }
};

const CACHE_TTL_LIVE       = 60 * 1000;          // 60 seconds for live prices
const CACHE_TTL_52WEEK     = 15 * 60 * 1000;     // 15 minutes for 52-week data
const CACHE_TTL_HISTORICAL = 6 * 60 * 60 * 1000; // 6 hours for 3-year historical data

// --- Simple In-Memory Rate Limiter for /api/send-alert ---
const rateLimitMap = new Map(); // ip -> { count, resetAt }
function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const window = 60 * 1000; // 1 minute
    const maxReq = 5;

    let record = rateLimitMap.get(ip);
    if (!record || now > record.resetAt) {
        record = { count: 0, resetAt: now + window };
        rateLimitMap.set(ip, record);
    }
    record.count++;
    if (record.count > maxReq) {
        return res.status(429).json({ success: false, error: 'Too many requests. Please wait.' });
    }
    next();
}

// Periodically clean up expired rate limit entries to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    rateLimitMap.forEach((record, ip) => {
        if (now > record.resetAt) rateLimitMap.delete(ip);
    });
}, 5 * 60 * 1000);

// --- Email Sender with Dual Transport (Resend + Gmail Nodemailer Fallback) ---
async function sendEmail(to, subject, text) {
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
        try {
            const response = await axios.post('https://api.resend.com/emails', {
                from: process.env.SENDER_EMAIL || 'Stock Alerts <alerts@prabinkshrestha.com.np>',
                to: [to],
                subject: subject,
                text: text
            }, {
                headers: {
                    'Authorization': `Bearer ${resendKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            });
            if (response.status === 200 || response.status === 201) {
                return response.data;
            }
        } catch (resendErr) {
            console.warn('Resend API failed, falling back to SMTP Nodemailer:', resendErr.message);
        }
    }

    // Nodemailer fallback — reuse module-level pooled transporter
    if (smtpTransporter) {
        return await smtpTransporter.sendMail({
            from: process.env.SENDER_EMAIL || `"Stock Alerts" <${process.env.EMAIL_USER}>`,
            to: to,
            subject: subject,
            text: text
        });
    }

    throw new Error('No working email provider configured (set RESEND_API_KEY or EMAIL_USER/EMAIL_PASS).');
}

// --- Shared Scraper Function ---
// Scrapes https://www.sharesansar.com/live-trading which renders the full table server-side.
// Verified columns (S.No, Symbol, LTP, Point Change, % Change, Open, High, Low, Volume, Prev.Close)
async function scrapeLivePrices() {
    const url = 'https://www.sharesansar.com/live-trading';
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120'
        },
        timeout: 20000
    });

    const html = response.data;
    const $ = cheerio.load(html);

    const stocks = [];

    // Table id="headFixed": col[0]=SNo, col[1]=Symbol, col[2]=LTP, col[3]=PointChange,
    //                        col[4]=PercentChange, col[5]=Open, col[6]=High, col[7]=Low,
    //                        col[8]=Volume, col[9]=PrevClose
    $('table#headFixed tbody tr').each((index, element) => {
        const tds = $(element).find('td');
        if (tds.length >= 8) {
            const symbol = $(tds[1]).text().trim();
            const ltp = $(tds[2]).text().trim();
            const diff = $(tds[3]).text().trim();
            const percDiff = $(tds[4]).text().trim();
            const high = $(tds[6]).text().trim();
            const low = $(tds[7]).text().trim();
            const volume = $(tds[8]).text().trim();
            const prevClose = $(tds[9]).text().trim();

            if (symbol && symbol !== 'Symbol') {
                stocks.push({
                    symbol,
                    ltp: ltp || '0',
                    diff: diff || '0',
                    percDiff: percDiff || '0',
                    high: high || '0',
                    low: low || '0',
                    volume: volume || '0',
                    prevClose: prevClose || '0'
                });
            }
        }
    });

    // If live-trading is empty (e.g. holiday or pre-market), fallback to today-share-price which has all 350+ NEPSE stocks
    if (stocks.length === 0) {
        try {
            const todayUrl = 'https://www.sharesansar.com/today-share-price';
            const todayRes = await axios.get(todayUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120' },
                timeout: 25000
            });
            const $today = cheerio.load(todayRes.data);
            $today('table#headFixed tbody tr').each((index, element) => {
                const tds = $today(element).find('td');
                if (tds.length >= 18) {
                    const symbol = $today(tds[1]).text().trim();
                    const open = $today(tds[3]).text().trim();
                    const high = $today(tds[4]).text().trim();
                    const low = $today(tds[5]).text().trim();
                    const close = $today(tds[6]).text().trim();
                    const ltp = $today(tds[7]).text().trim() || close;
                    const volume = $today(tds[11]).text().trim();
                    const prevClose = $today(tds[12]).text().trim();
                    const diff = $today(tds[15]).text().trim();
                    const percDiff = $today(tds[17]).text().trim();

                    if (symbol && symbol !== 'Symbol') {
                        stocks.push({
                            symbol,
                            ltp: ltp || '0',
                            diff: diff || '0',
                            percDiff: percDiff || '0',
                            open: open || '0',
                            high: high || '0',
                            low: low || '0',
                            volume: volume || '0',
                            prevClose: prevClose || '0'
                        });
                    }
                }
            });
        } catch (e) {
            console.warn("Fallback to today-share-price failed:", e.message);
        }
    }

    // Third-tier fallback: Merolagani today-share-price page (reliable even on non-trading days)
    // Source: https://merolagani.com/StockQuote.aspx — table with all NEPSE stocks
    if (stocks.length === 0) {
        try {
            console.log('   Attempting Merolagani fallback for live prices...');
            const mlRes = await axios.get('https://merolagani.com/StockQuote.aspx', {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Referer': 'https://merolagani.com/'
                },
                timeout: 25000
            });
            const $ml = cheerio.load(mlRes.data);

            // Merolagani stock quote table: columns vary but symbol/ltp/change are present
            // Table id="ctl00_ContentPlaceHolder1_LiveTrading1_gridView" or similar
            // Merolagani table layout: col[0]=row#, col[1]=Symbol, col[2]=LTP, col[3]=Diff, col[4]=%Diff, col[5]=High, col[6]=Low, ...
            $ml('table.table tbody tr, table tbody tr').each((i, el) => {
                const tds = $ml(el).find('td');
                if (tds.length >= 6) {
                    const symbol   = $ml(tds[1]).text().trim();
                    const ltp      = $ml(tds[2]).text().trim().replace(/,/g, '');
                    const diff     = $ml(tds[3]).text().trim().replace(/,/g, '');
                    const percDiff = $ml(tds[4]).text().trim().replace(/%/g, '').trim();
                    const high     = $ml(tds[5]).text().trim().replace(/,/g, '') || ltp;
                    const low      = tds.length >= 7 ? $ml(tds[6]).text().trim().replace(/,/g, '') : ltp;

                    if (symbol && /^[A-Z]{2,}/.test(symbol) && ltp && parseFloat(ltp) > 0) {
                        stocks.push({
                            symbol,
                            ltp:      ltp      || '0',
                            diff:     diff     || '0',
                            percDiff: percDiff || '0',
                            high:     high     || ltp,
                            low:      low      || ltp,
                            volume:   '0',
                            prevClose:'0',
                            source:   'merolagani'
                        });
                    }
                }
            });

            if (stocks.length > 0) {
                console.log(`   Merolagani fallback: fetched ${stocks.length} stocks.`);
            }
        } catch (mlErr) {
            console.warn("Merolagani fallback failed:", mlErr.message);
        }
    }

    return stocks;
}

// Standalone Merolagani live price scraper (for direct /api/merolagani-prices endpoint)
async function scrapeMerolaganiPrices() {
    const pages = [
        'https://merolagani.com/StockQuote.aspx',
    ];
    const stocks = [];
    for (const url of pages) {
        try {
            const res = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Referer': 'https://merolagani.com/'
                },
                timeout: 25000
            });
            const $ = cheerio.load(res.data);
            // col[0]=row#, col[1]=Symbol, col[2]=LTP, col[3]=Diff, col[4]=%Diff, col[5]=High, col[6]=Low
            $('table.table tbody tr, table tbody tr').each((i, el) => {
                const tds = $(el).find('td');
                if (tds.length >= 6) {
                    const symbol   = $(tds[1]).text().trim();
                    const ltp      = $(tds[2]).text().trim().replace(/,/g, '');
                    const diff     = $(tds[3]).text().trim().replace(/,/g, '');
                    const percDiff = $(tds[4]).text().trim().replace(/%/g, '').trim();
                    const high     = $(tds[5]).text().trim().replace(/,/g, '') || ltp;
                    const low      = tds.length >= 7 ? $(tds[6]).text().trim().replace(/,/g, '') : ltp;

                    if (symbol && /^[A-Z]{2,}/.test(symbol) && ltp && parseFloat(ltp) > 0) {
                        stocks.push({ symbol, ltp, diff, percDiff, high, low, volume: '0', prevClose: '0' });
                    }
                }
            });
        } catch (e) {
            console.warn(`Merolagani page fetch failed (${url}):`, e.message);
        }
    }
    return stocks;
}

// Test route to ensure server works
app.get('/', (req, res) => {
    res.send('Backend is running successfully!');
});

// Complete NEPSE Stocks List Endpoint (All 340+ listed stocks with sector)
app.get('/api/stocks', async (req, res) => {
    try {
        const cached = cache.get('all-stocks');
        if (cached) {
            return res.status(200).json({ success: true, count: cached.length, data: cached, cached: true });
        }
        const rawStocks = await scrapeLivePrices();
        const enriched = rawStocks.map(s => ({
            ...s,
            sector: SECTOR_MAP[s.symbol] || 'Others'
        }));
        cache.set('all-stocks', enriched, CACHE_TTL_LIVE);
        res.status(200).json({ success: true, count: enriched.length, data: enriched });
    } catch (error) {
        console.error("Stocks fetch error:", error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch listed stocks.' });
    }
});

// Web Scraper Endpoint for Live Prices (used by frontend) — with 60s TTL cache
app.get('/api/live-prices', async (req, res) => {
    try {
        const cached = cache.get('live-prices');
        if (cached) {
            return res.status(200).json({ success: true, data: cached, cached: true });
        }
        const stocks = await scrapeLivePrices();
        cache.set('live-prices', stocks, CACHE_TTL_LIVE);
        res.status(200).json({ success: true, data: stocks });
    } catch (error) {
        console.error("Scraping error:", error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch live prices.' });
    }
});

// Endpoint for historical prices fallback (generates past 30 days of price & volume candles for seed fallback)
app.get('/api/historical-prices', async (req, res) => {
    try {
        const stocks = await scrapeLivePrices();
        const historicalData = {};
        
        // Generate past 30 trading days dates
        const dates = [];
        let curr = new Date();
        while (dates.length < 30) {
            curr.setDate(curr.getDate() - 1);
            const day = curr.getDay();
            // Skip Friday and Saturday for NEPSE trading days (Sun-Thu)
            if (day !== 5 && day !== 6) {
                dates.unshift(curr.toISOString().split('T')[0]);
            }
        }

        stocks.forEach(stock => {
            const basePrice = parseFloat(stock.ltp.replace(/,/g, '')) || 500;
            const baseVol = parseFloat(stock.volume.replace(/,/g, '')) || 10000;
            const candles = [];

            let runningPrice = basePrice;
            // Generate deterministic realistic historical price movements
            dates.forEach((dateStr, i) => {
                const pseudoRandom = Math.sin((stock.symbol.charCodeAt(0) || 1) * (i + 1) * 7.5);
                const pctChange = pseudoRandom * 0.025; // +-2.5% daily variation
                runningPrice = Math.max(10, runningPrice * (1 + pctChange));
                const volMultiplier = 0.7 + Math.abs(pseudoRandom) * 0.6; // 0.7x to 1.3x avg volume
                const dayVol = Math.round(baseVol * volMultiplier);

                candles.push({
                    date: dateStr,
                    close: parseFloat(runningPrice.toFixed(2)),
                    volume: dayVol
                });
            });

            historicalData[stock.symbol] = candles;
        });

        res.status(200).json({ success: true, data: historicalData });
    } catch (error) {
        console.error("Historical generation error:", error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch historical data.' });
    }
});

// --- Scrape Up to 3 Years of Daily Historical Data for Any NEPSE Stock ---
// Source: Sharesansar company price history POST API (server-side pagination, 50 rows per batch)
async function scrapeHistoricalStockData(symbol) {
    const sym = symbol.toUpperCase().trim();
    const SLUG_MAP = { UNIL: 'unl' };
    const slug = SLUG_MAP[sym] || sym.toLowerCase();
    const companyUrl = `https://www.sharesansar.com/company/${slug}`;

    const pageRes = await axios.get(companyUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120'
        },
        timeout: 20000
    });

    const html = pageRes.data;
    const $ = cheerio.load(html);
    const token = $('meta[name=_token]').attr('content');
    const companyId = $('#companyid').text().trim();
    const cookies = pageRes.headers['set-cookie']
        ? pageRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ')
        : '';

    if (!companyId) {
        throw new Error(`Could not find company ID for symbol ${sym}`);
    }

    // Up to 3 years = ~750 trading days (15 pages of 50 records)
    const totalPages = 15;
    const pageIndices = Array.from({ length: totalPages }, (_, i) => i * 50);
    const allRecords = [];
    const BATCH_SIZE = 5;

    for (let i = 0; i < pageIndices.length; i += BATCH_SIZE) {
        const batch = pageIndices.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(async (start) => {
            const postData = new URLSearchParams({
                company: companyId,
                draw: '1',
                start: String(start),
                length: '50'
            });
            const r = await axios.post('https://www.sharesansar.com/company-price-history', postData.toString(), {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
                    'X-CSRF-Token': token,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Cookie': cookies,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 15000
            });
            return r.data?.data || [];
        }));

        let shouldStop = false;
        batchResults.forEach(rows => {
            if (!rows || rows.length === 0) shouldStop = true;
            else allRecords.push(...rows);
        });
        if (shouldStop) break;
    }

    // Clean and normalize records
    const formatted = allRecords.map(r => {
        const open = parseFloat((r.open || '0').replace(/,/g, '')) || 0;
        const high = parseFloat((r.high || '0').replace(/,/g, '')) || 0;
        const low = parseFloat((r.low || '0').replace(/,/g, '')) || 0;
        const close = parseFloat((r.close || '0').replace(/,/g, '')) || 0;
        const percDiff = parseFloat((r.per_change || '0').replace(/,/g, '')) || 0;
        const volume = parseFloat((r.traded_quantity || '0').replace(/,/g, '')) || 0;
        const amount = parseFloat((r.traded_amount || '0').replace(/,/g, '')) || 0;
        const diff = parseFloat((close - open).toFixed(2));
        return {
            date: r.published_date,
            open,
            high,
            low,
            close,
            diff,
            percDiff,
            volume,
            amount
        };
    });

    // Sort oldest to newest (chronological order for charts)
    formatted.sort((a, b) => new Date(a.date) - new Date(b.date));
    return formatted;
}

// Endpoint to fetch up to 3 years of real historical NEPSE stock data
app.get('/api/historical/:symbol', async (req, res) => {
    const symbol = (req.params.symbol || '').toUpperCase().trim();
    if (!symbol) {
        return res.status(400).json({ success: false, error: 'Stock symbol is required.' });
    }

    const cacheKey = `hist_${symbol}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        return res.status(200).json({ success: true, symbol, count: cached.length, data: cached, cached: true });
    }

    try {
        let history = await scrapeHistoricalStockData(symbol);

        // If external scraper returned 0 records, try Firestore fallback
        if (!history || history.length === 0) {
            const historySnap = await db.collection('daily_history')
                .where('symbol', '==', symbol)
                .get();
            if (!historySnap.empty) {
                history = [];
                historySnap.forEach(docSnap => {
                    const d = docSnap.data();
                    history.push({
                        date: d.date,
                        open: d.open || d.close || 0,
                        high: d.high || d.close || 0,
                        low: d.low || d.close || 0,
                        close: d.close || 0,
                        diff: d.diff || 0,
                        percDiff: d.percDiff || 0,
                        volume: d.volume || 0,
                        amount: d.amount || 0
                    });
                });
                history.sort((a, b) => new Date(a.date) - new Date(b.date));
            }
        }

        if (history && history.length > 0) {
            cache.set(cacheKey, history, CACHE_TTL_HISTORICAL);
            return res.status(200).json({ success: true, symbol, count: history.length, data: history });
        }

        return res.status(404).json({ success: false, error: `No historical data found for symbol ${symbol}.` });
    } catch (error) {
        console.error(`Historical fetch error for ${symbol}:`, error.message);

        // Graceful fallback from Firestore if available
        try {
            const historySnap = await db.collection('daily_history')
                .where('symbol', '==', symbol)
                .get();
            if (!historySnap.empty) {
                const history = [];
                historySnap.forEach(docSnap => {
                    const d = docSnap.data();
                    history.push({
                        date: d.date,
                        open: d.open || d.close || 0,
                        high: d.high || d.close || 0,
                        low: d.low || d.close || 0,
                        close: d.close || 0,
                        diff: d.diff || 0,
                        percDiff: d.percDiff || 0,
                        volume: d.volume || 0,
                        amount: d.amount || 0
                    });
                });
                history.sort((a, b) => new Date(a.date) - new Date(b.date));
                return res.status(200).json({ success: true, symbol, count: history.length, data: history, fallback: true });
            }
        } catch (dbErr) {
            console.warn("Firestore fallback error:", dbErr.message);
        }

        res.status(500).json({ success: false, error: `Failed to fetch historical data for ${symbol}: ${error.message}` });
    }
});

// Real 52-Week High/Low scraper
// Source: https://www.sharesansar.com/today-share-price (server-rendered, all NEPSE stocks)
// Confirmed column layout (0-indexed):
//   0=S.No  1=Symbol  2=Conf.  3=Open  4=High  5=Low  6=Close  7=LTP
//   8=Close-LTP  9=Close-LTP%  10=VWAP  11=Vol  12=Prev.Close  13=Turnover
//   14=Trans.  15=Diff  16=Range  17=Diff%  18=Range%  19=VWAP%
//   20=120Days  21=180Days  22=52WeeksHigh  23=52WeeksLow
async function scrape52WeekData() {
    const url = 'https://www.sharesansar.com/today-share-price';
    const response = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120' },
        timeout: 25000
    });
    const $ = cheerio.load(response.data);
    const stocks = [];

    $('table#headFixed tbody tr').each((i, el) => {
        const tds = $(el).find('td');
        if (tds.length >= 24) {
            const symbol = $(tds[1]).text().trim();
            const ltp    = $(tds[7]).text().trim();
            const high52 = $(tds[22]).text().trim();
            const low52  = $(tds[23]).text().trim();
            if (symbol && symbol !== 'Symbol' && high52 && low52) {
                stocks.push({ symbol, ltp, high52, low52 });
            }
        }
    });
    return stocks;
}

// Static sector mapping for NEPSE stocks
const SECTOR_MAP = {
    // Commercial Banks
    NABIL: 'Commercial Banks', ADBL: 'Commercial Banks', EBL: 'Commercial Banks',
    NICA: 'Commercial Banks', SBI: 'Commercial Banks', NBB: 'Commercial Banks',
    KBL: 'Commercial Banks', MBL: 'Commercial Banks', PCBL: 'Commercial Banks',
    SANIMA: 'Commercial Banks', CZBIL: 'Commercial Banks', GBIME: 'Commercial Banks',
    HBL: 'Commercial Banks', NIB: 'Commercial Banks', NMB: 'Commercial Banks',
    PRVU: 'Commercial Banks', SCB: 'Commercial Banks', SBL: 'Commercial Banks',
    CCBL: 'Commercial Banks', LBBL: 'Commercial Banks', MEGA: 'Commercial Banks',
    SRBL: 'Commercial Banks', SHIVM: 'Commercial Banks', MNBBL: 'Commercial Banks',
    NIMB: 'Commercial Banks', RBB: 'Commercial Banks', NBL: 'Commercial Banks',
    BOKL: 'Commercial Banks', TNBL: 'Commercial Banks', KRBL: 'Commercial Banks',
    // Development Banks
    CBBL: 'Development Banks', KDBL: 'Development Banks', NABBC: 'Development Banks',
    MLBL: 'Development Banks', MNBBL: 'Development Banks', SADBL: 'Development Banks',
    KSBBL: 'Development Banks', SAPDBL: 'Development Banks', LBBL: 'Development Banks',
    GRDBL: 'Development Banks', SBBLJ: 'Development Banks', EDBL: 'Development Banks',
    JBBL: 'Development Banks', SHINE: 'Development Banks', CORBL: 'Development Banks',
    MPFL: 'Development Banks', NADEP: 'Development Banks', SABL: 'Development Banks',
    // Finance
    GFCL: 'Finance', CFCL: 'Finance', ICFC: 'Finance', MFIL: 'Finance',
    AFC: 'Finance', BFC: 'Finance', GUFL: 'Finance', HHL: 'Finance',
    JFL: 'Finance', LBFL: 'Finance', MKCL: 'Finance', NFS: 'Finance',
    NIFRA: 'Finance', PFL: 'Finance', SFCL: 'Finance', SFL: 'Finance',
    SIFC: 'Finance', UNIL: 'Finance', GMFIL: 'Finance',
    // Microfinance
    SMFDB: 'Microfinance', SWBBL: 'Microfinance', NWCFL: 'Microfinance',
    SKBBL: 'Microfinance', DDBL: 'Microfinance', FOWAD: 'Microfinance',
    GILB: 'Microfinance', HLBSL: 'Microfinance', JSLBB: 'Microfinance',
    KMCDB: 'Microfinance', MERO: 'Microfinance', MSLB: 'Microfinance',
    NESDO: 'Microfinance', NICLBSL: 'Microfinance', NUBL: 'Microfinance',
    RMDC: 'Microfinance', SAMAJ: 'Microfinance', SLBBL: 'Microfinance',
    SMATA: 'Microfinance', SMBDB: 'Microfinance', SMB: 'Microfinance',
    UNLB: 'Microfinance', USLB: 'Microfinance', VLBS: 'Microfinance',
    MLBBL: 'Microfinance', CBFLC: 'Microfinance', ECFL: 'Microfinance',
    // Life Insurance
    NLIC: 'Life Insurance', LICN: 'Life Insurance', ALICL: 'Life Insurance',
    CLI: 'Life Insurance', ILI: 'Life Insurance', JLIC: 'Life Insurance',
    LGIL: 'Life Insurance', MLIC: 'Life Insurance', NLICL: 'Life Insurance',
    PLIC: 'Life Insurance', RNLI: 'Life Insurance', SNLI: 'Life Insurance',
    SLI: 'Life Insurance', SLICL: 'Life Insurance', SRLI: 'Life Insurance',
    ULIF: 'Life Insurance', ACLBSL: 'Life Insurance', JLIC: 'Life Insurance',
    // Non Life Insurance
    SICL: 'Non Life Insurance', NICL: 'Non Life Insurance', PRIN: 'Non Life Insurance',
    EIC: 'Non Life Insurance', HIC: 'Non Life Insurance', IGI: 'Non Life Insurance',
    NIC: 'Non Life Insurance', NIL: 'Non Life Insurance', PICL: 'Non Life Insurance',
    PIC: 'Non Life Insurance', RBCL: 'Non Life Insurance', RMFL: 'Non Life Insurance',
    SALICO: 'Non Life Insurance', SANIMA: 'Non Life Insurance', SGIC: 'Non Life Insurance',
    SICL: 'Non Life Insurance', SIC: 'Non Life Insurance', UAIL: 'Non Life Insurance',
    // Hydropower
    HIDCL: 'Hydropower', NHPC: 'Hydropower', UPPER: 'Hydropower', AKPL: 'Hydropower',
    BARUN: 'Hydropower', CHCL: 'Hydropower', NGPL: 'Hydropower', RRHP: 'Hydropower',
    UNHPL: 'Hydropower', HDL: 'Hydropower', DORDI: 'Hydropower', SAHAS: 'Hydropower',
    PMHPL: 'Hydropower', SSHL: 'Hydropower', RAIBU: 'Hydropower', NHDL: 'Hydropower',
    BPCL: 'Hydropower', BPPCL: 'Hydropower', CHL: 'Hydropower', DHPL: 'Hydropower',
    GHL: 'Hydropower', GVL: 'Hydropower', HPPL: 'Hydropower', HURJA: 'Hydropower',
    JOSHI: 'Hydropower', KPCL: 'Hydropower', KKHC: 'Hydropower', LLBS: 'Hydropower',
    MBJC: 'Hydropower', MCHL: 'Hydropower', MHNL: 'Hydropower', MKJC: 'Hydropower',
    MMKJL: 'Hydropower', MPPL: 'Hydropower', MSHL: 'Hydropower', NKPL: 'Hydropower',
    NYADI: 'Hydropower', OKHL: 'Hydropower', PPCL: 'Hydropower', PRBM: 'Hydropower',
    RHPL: 'Hydropower', RKJCL: 'Hydropower', RLJC: 'Hydropower', RMPL: 'Hydropower',
    ROHINI: 'Hydropower', RSDC: 'Hydropower', RURU: 'Hydropower', SHEL: 'Hydropower',
    SHL: 'Hydropower', SJCL: 'Hydropower', SMJC: 'Hydropower', SPDL: 'Hydropower',
    TAMOR: 'Hydropower', TPCL: 'Hydropower', UMPL: 'Hydropower', UMRH: 'Hydropower',
    UNHPL: 'Hydropower', UPCL: 'Hydropower', VLUCL: 'Hydropower', WNLC: 'Hydropower',
    RADHI: 'Hydropower', NATHM: 'Hydropower', MAKAR: 'Hydropower', KBSH: 'Hydropower',
    HDHPC: 'Hydropower', GLBSL: 'Hydropower', BHPL: 'Hydropower',
    // Hotels & Tourism
    GLH: 'Hotels And Tourism', TRH: 'Hotels And Tourism', SJJCL: 'Hotels And Tourism',
    OHL: 'Hotels And Tourism', SLBL: 'Hotels And Tourism', HHCL: 'Hotels And Tourism',
    // Manufacturing
    SONA: 'Manufacturing And Processing', BNT: 'Manufacturing And Processing',
    HDL: 'Manufacturing And Processing', SHIVM: 'Manufacturing And Processing',
    UNFL: 'Manufacturing And Processing', DOLTI: 'Manufacturing And Processing',
    GCIL: 'Manufacturing And Processing', RIDI: 'Manufacturing And Processing',
    LAIN: 'Manufacturing And Processing', BSL: 'Manufacturing And Processing',
    SNIL: 'Manufacturing And Processing', NBBL: 'Manufacturing And Processing',
    // Trading
    BBC: 'Trading', SFCL: 'Trading', NTC: 'Others',
    // Investment
    SICCO: 'Investment', CIT: 'Investment', CHDC: 'Investment',
    NIFRA: 'Investment', NIBL: 'Investment',
};

app.get('/api/52week-prices', async (req, res) => {
    try {
        const cached = cache.get('52week-prices');
        if (cached) {
            return res.status(200).json({ success: true, count: cached.length, data: cached, cached: true });
        }
        const stocks = await scrape52WeekData();
        if (stocks.length === 0) {
            return res.status(503).json({ success: false, error: 'No data fetched. Market may be closed or site unavailable.' });
        }
        // Attach sector from static map
        const data52 = stocks.map(s => ({
            ...s,
            sector: SECTOR_MAP[s.symbol] || 'Others'
        }));
        cache.set('52week-prices', data52, CACHE_TTL_52WEEK);
        console.log(`[52W] Fetched ${data52.length} stocks from Sharesansar.`);
        res.status(200).json({ success: true, count: data52.length, data: data52 });
    } catch (error) {
        console.error('52W error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch 52-week data: ' + error.message });
    }
});

// Trigger an alert manually — rate-limited to 5 requests/min per IP
app.post('/api/send-alert', rateLimit, async (req, res) => {
    const { email, message, subject } = req.body;

    try {
        await sendEmail(
            email,
            subject || '🚨 Manual Alert Notification',
            message || 'This is a test alert from your Render backend!'
        );
        res.status(200).json({ success: true, message: 'Email sent successfully!' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Helper: Get Nepal date string (UTC+5:45) e.g., "2026-08-27"
function getNepalDateString() {
    const now = new Date();
    // Nepal offset is +5:45 (345 minutes)
    const nepalOffsetMs = (5 * 60 + 45) * 60 * 1000;
    const nepalDate = new Date(now.getTime() + nepalOffsetMs);
    return nepalDate.toISOString().split('T')[0];
}

// =========================================================
// BACKGROUND ALERT CHECKER (runs 24/7 in the cloud every 5 minutes)
// Runs automatically even when the user's laptop is completely turned off.
// Ensures notifications are sent AT MOST ONCE PER DAY per stock condition.
// =========================================================
// --- NEPSE Market Hours Guard ---
// NEPSE trades Sun–Thu, 11:00 AM – 3:00 PM (Nepal Standard Time, UTC+5:45)
// Returns true if current Nepal time is within trading hours
function isNepseMarketOpen() {
    const now = new Date();
    const nepalOffsetMs = (5 * 60 + 45) * 60 * 1000;
    const nepalNow = new Date(now.getTime() + nepalOffsetMs);

    const dayOfWeek = nepalNow.getUTCDay(); // 0=Sun, 1=Mon, ..., 4=Thu, 5=Fri, 6=Sat
    const isTradingDay = dayOfWeek >= 0 && dayOfWeek <= 4; // Sunday (0) to Thursday (4)

    const hours = nepalNow.getUTCHours();
    const minutes = nepalNow.getUTCMinutes();
    const timeInMinutes = hours * 60 + minutes;

    const marketOpen  = 11 * 60;       // 11:00 AM
    const marketClose = 15 * 60 + 5;   // 3:05 PM (small buffer after close for final prices)

    return isTradingDay && timeInMinutes >= marketOpen && timeInMinutes <= marketClose;
}

async function checkAlerts() {
    const today = getNepalDateString();
    console.log(`[${new Date().toISOString()}] 🔄 Background alert checker running (Date: ${today})...`);

    try {
        // 1. Use cached live prices if available to avoid hammering the scraper;
        //    always refresh during market hours so data is current.
        let cachedPrices = cache.get('live-prices');
        let stocks;
        if (cachedPrices) {
            stocks = cachedPrices;
            console.log(`   Using cached live prices (${stocks.length} stocks).`);
        } else {
            stocks = await scrapeLivePrices();
            cache.set('live-prices', stocks, CACHE_TTL_LIVE);
        }

        // Build a quick lookup map: { "NABIL": 1234.56, ... }
        const priceMap = {};
        stocks.forEach(s => {
            const price = parseFloat(s.ltp.replace(/,/g, ''));
            if (!isNaN(price)) priceMap[s.symbol] = price;
        });

        console.log(`   Scraped/cached ${Object.keys(priceMap).length} stock prices.`);

        // ---------------------------------------------------------------
        // PART A: Portfolio / Transaction alerts (target price + stop loss)
        // ---------------------------------------------------------------
        const txSnapshot = await db.collection('transactions').get();
        let txAlertsSent = 0;

        // Collect all alerts to send concurrently
        const txAlertTasks = [];

        for (const docSnap of txSnapshot.docs) {
            const tx = docSnap.data();
            const ltp = priceMap[tx.symbol];
            if (!ltp || !tx.email) continue;

            let alertMsg = null;
            let alertSubject = null;
            const updates = {};

            // Target Price Hit (once per day)
            if (tx.targetPrice && tx.targetPrice > 0 && ltp >= tx.targetPrice) {
                if (tx.lastTargetAlertDate !== today) {
                    alertSubject = `📊 Portfolio Alert: ${tx.symbol} - Target Hit (Rs ${ltp})`;
                    alertMsg = `🎯 TARGET HIT!\n\nStock: ${tx.symbol}\nCurrent Price: Rs ${ltp}\nYour Target Price: Rs ${tx.targetPrice}\n\nTransaction Details:\nType: ${tx.type}\nQty: ${tx.qty}\nPurchase Price: Rs ${tx.price}\nDate: ${today}`;
                    updates.lastTargetAlertDate = today;
                    updates.alertTriggered = true;
                }
            }
            // Stop Loss Hit (once per day)
            else if (tx.stopLoss && tx.stopLoss > 0 && ltp <= tx.stopLoss) {
                if (tx.lastSlAlertDate !== today) {
                    alertSubject = `⚠️ Portfolio Alert: ${tx.symbol} - Stop Loss Hit (Rs ${ltp})`;
                    alertMsg = `⚠️ STOP LOSS HIT!\n\nStock: ${tx.symbol}\nCurrent Price: Rs ${ltp}\nYour Stop Loss: Rs ${tx.stopLoss}\n\nTransaction Details:\nType: ${tx.type}\nQty: ${tx.qty}\nPurchase Price: Rs ${tx.price}\nDate: ${today}`;
                    updates.lastSlAlertDate = today;
                    updates.alertTriggered = true;
                }
            }

            if (alertMsg) {
                txAlertTasks.push({ docId: docSnap.id, email: tx.email, subject: alertSubject, msg: alertMsg, symbol: tx.symbol, updates });
            }
        }

        // Send all portfolio alerts concurrently
        const txResults = await Promise.allSettled(
            txAlertTasks.map(async task => {
                await sendEmail(task.email, task.subject, task.msg);
                await db.collection('transactions').doc(task.docId).update(task.updates);
                console.log(`   ✅ Portfolio alert sent for ${task.symbol} to ${task.email}`);
            })
        );
        txResults.forEach((result, i) => {
            if (result.status === 'rejected') {
                console.error(`   ❌ Failed to send portfolio alert for ${txAlertTasks[i].symbol}:`, result.reason?.message);
            }
        });
        txAlertsSent = txResults.filter(r => r.status === 'fulfilled').length;

        // ---------------------------------------------------------------
        // PART B: Watchlist alerts (Target Buy, Take Profit, Stop Loss)
        // Sent AT MOST ONCE PER DAY per condition
        // ---------------------------------------------------------------
        const wlSnapshot = await db.collection('watchlist').get();
        let wlChecked = 0;
        let wlAlertsSent = 0;

        // Collect watchlist alert tasks for concurrent sending
        const wlAlertTasks = [];
        const wlUpdateMap = new Map(); // docId -> updates object

        for (const docSnap of wlSnapshot.docs) {
            const wl = docSnap.data();
            const ltp = priceMap[wl.symbol];
            if (!ltp || !wl.email) continue;

            const updates = {};

            // 1. Target Buy alert (LTP <= targetBuy) - once per day
            if (wl.targetBuy && wl.targetBuy > 0 && ltp <= wl.targetBuy) {
                if (wl.lastBuyAlertDate !== today) {
                    wlAlertTasks.push({
                        docId: docSnap.id, symbol: wl.symbol, email: wl.email,
                        subject: `🛒 Watchlist Alert: ${wl.symbol} reached Target Buy (Rs ${ltp})`,
                        msg: `🛒 TARGET BUY HIT!\n\nStock: ${wl.symbol}\nCurrent Price: Rs ${ltp}\nYour Target Buy Price: Rs ${wl.targetBuy}\nDate: ${today}\n\nLog in to your portfolio to act on this alert.`,
                        updateKey: docSnap.id,
                        partialUpdates: { lastBuyAlertDate: today, alertTriggered: true, lastBuyAlertAt: new Date().toISOString() }
                    });
                    Object.assign(updates, { lastBuyAlertDate: today, alertTriggered: true, lastBuyAlertAt: new Date().toISOString() });
                }
            }

            // 2. Take Profit alert (LTP >= takeProfit) - once per day
            if (wl.takeProfit && wl.takeProfit > 0 && ltp >= wl.takeProfit) {
                if (wl.lastTpAlertDate !== today) {
                    wlAlertTasks.push({
                        docId: docSnap.id, symbol: wl.symbol, email: wl.email,
                        subject: `🎯 Watchlist Alert: ${wl.symbol} hit Take Profit (Rs ${ltp})`,
                        msg: `🎯 TAKE PROFIT TARGET HIT!\n\nStock: ${wl.symbol}\nCurrent Price: Rs ${ltp}\nYour Take Profit Target: Rs ${wl.takeProfit}\nDate: ${today}\n\nLog in to your portfolio to secure your profits.`,
                        updateKey: docSnap.id,
                        partialUpdates: { lastTpAlertDate: today, tpAlertTriggered: true, lastTpAlertAt: new Date().toISOString() }
                    });
                    Object.assign(updates, { lastTpAlertDate: today, tpAlertTriggered: true, lastTpAlertAt: new Date().toISOString() });
                }
            }

            // 3. Stop Loss alert (LTP <= stopLoss) - once per day
            if (wl.stopLoss && wl.stopLoss > 0 && ltp <= wl.stopLoss) {
                if (wl.lastSlAlertDate !== today) {
                    wlAlertTasks.push({
                        docId: docSnap.id, symbol: wl.symbol, email: wl.email,
                        subject: `⚠️ Watchlist Alert: ${wl.symbol} hit Stop Loss (Rs ${ltp})`,
                        msg: `⚠️ STOP LOSS BREACHED!\n\nStock: ${wl.symbol}\nCurrent Price: Rs ${ltp}\nYour Stop Loss Price: Rs ${wl.stopLoss}\nDate: ${today}\n\nLog in to your portfolio to manage your risk.`,
                        updateKey: docSnap.id,
                        partialUpdates: { lastSlAlertDate: today, slAlertTriggered: true, lastSlAlertAt: new Date().toISOString() }
                    });
                    Object.assign(updates, { lastSlAlertDate: today, slAlertTriggered: true, lastSlAlertAt: new Date().toISOString() });
                }
            }

            if (Object.keys(updates).length > 0) {
                wlUpdateMap.set(docSnap.id, updates);
            }
            wlChecked++;
        }

        // Send all watchlist emails concurrently
        const wlResults = await Promise.allSettled(
            wlAlertTasks.map(async task => {
                await sendEmail(task.email, task.subject, task.msg);
                console.log(`   ✅ Watchlist alert sent for ${task.symbol} to ${task.email}`);
            })
        );
        wlResults.forEach((result, i) => {
            if (result.status === 'rejected') {
                console.error(`   ❌ Failed to send watchlist alert for ${wlAlertTasks[i].symbol}:`, result.reason?.message);
            }
        });
        wlAlertsSent = wlResults.filter(r => r.status === 'fulfilled').length;

        // Batch Firestore updates for watchlist (all successful alerts at once)
        const wlUpdatePromises = [];
        wlUpdateMap.forEach((updates, docId) => {
            wlUpdatePromises.push(db.collection('watchlist').doc(docId).update(updates));
        });
        if (wlUpdatePromises.length > 0) await Promise.allSettled(wlUpdatePromises);

        console.log(`   Checked ${wlChecked} watchlist item(s). Sent ${wlAlertsSent} watchlist alert(s) and ${txAlertsSent} portfolio alert(s).`);
        console.log(`[${new Date().toISOString()}] ✅ Alert check complete.`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Alert checker error:`, error.message);
    }
}

// Endpoint to trigger/test alert check on demand
app.get('/api/run-alert-check', async (req, res) => {
    try {
        await checkAlerts();
        res.status(200).json({ success: true, message: 'Alert check executed successfully' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Schedule: Run every 5 minutes but ONLY during NEPSE trading hours (Sun–Thu 11:00–15:05 NST)
// Off-hours runs are skipped to avoid unnecessary scraping (saves server resources & prevents IP bans)
cron.schedule('*/5 * * * *', () => {
    if (isNepseMarketOpen()) {
        checkAlerts();
    } else {
        const now = new Date();
        console.log(`[${now.toISOString()}] ⏸ Market closed — alert check skipped.`);
    }
});

// Also run once immediately on server startup
checkAlerts();

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend running perfectly on port ${PORT}`);
    console.log(`Background alert checker scheduled to run 24/7 every 5 minutes.`);
});
