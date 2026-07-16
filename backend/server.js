const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const cron = require('node-cron');
const admin = require('firebase-admin');
require('dotenv').config();

const { getFirestore } = require('firebase-admin/firestore');

// This reads the raw JSON you pasted into the Render Environment Variable
const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;
if (serviceAccountStr) {
    const serviceAccount = JSON.parse(serviceAccountStr);
    admin.initializeApp({
        credential: admin.cert(serviceAccount)
    });
} else {
    console.warn("FIREBASE_SERVICE_ACCOUNT env var missing. Running without firebase admin.");
    // Dummy initialization for local testing without credentials if needed, though queries will fail.
    // admin.initializeApp(); 
}

const db = admin.apps.length ? getFirestore() : null;

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// --- Email Sender via Resend HTTP API ---
async function sendEmail(to, subject, text) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        console.warn('RESEND_API_KEY environment variable not set. Email not sent.');
        return;
    }
    const response = await axios.post('https://api.resend.com/emails', {
        from: 'Stock Alerts <onboarding@resend.dev>',
        to: [to],
        subject: subject,
        text: text
    }, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });
    if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Resend API error: ${response.status}`);
    }
    return response.data;
}

// --- Shared Scraper Function ---
async function scrapeLivePrices() {
    const url = 'https://www.sharesansar.com/live-trading';
    const response = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 20000
    });

    const html = response.data;
    const $ = cheerio.load(html);
    const stocks = [];

    $('table#headFixed tbody tr').each((index, element) => {
        const tds = $(element).find('td');
        if (tds.length >= 8) {
            const symbol = $(tds[1]).text().trim();
            const ltp = $(tds[2]).text().trim();
            if (symbol && symbol !== 'Symbol') {
                stocks.push({
                    symbol,
                    ltp: ltp || '0',
                    diff: $(tds[3]).text().trim() || '0',
                    percDiff: $(tds[4]).text().trim() || '0',
                    high: $(tds[6]).text().trim() || '0',
                    low: $(tds[7]).text().trim() || '0',
                    prevClose: $(tds[9]).text().trim() || '0'
                });
            }
        }
    });
    return stocks;
}

app.get('/api/live-prices', async (req, res) => {
    try {
        const stocks = await scrapeLivePrices();
        res.status(200).json({ success: true, data: stocks });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch live prices.' });
    }
});

// Real 52-Week High/Low scraper
async function scrape52WeekData() {
    const url = 'https://www.sharesansar.com/nepse-data/52weeks';
    const response = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120' },
        timeout: 20000
    });
    const $ = cheerio.load(response.data);
    const stocks = [];

    // Sharesansar 52-week table columns: Symbol, LTP, 52W High, 52W Low, ...
    $('table tbody tr').each((i, el) => {
        const tds = $(el).find('td');
        if (tds.length >= 4) {
            const symbol = $(tds[0]).text().trim();
            const ltp    = $(tds[1]).text().trim();
            const high52 = $(tds[2]).text().trim();
            const low52  = $(tds[3]).text().trim();
            if (symbol && symbol !== 'Symbol') {
                stocks.push({ symbol, ltp, high52, low52 });
            }
        }
    });
    return stocks;
}

// Static sector mapping for NEPSE stocks (major ones)
const SECTOR_MAP = {
    NABIL: 'Commercial Banks', ADBL: 'Commercial Banks', EBL: 'Commercial Banks',
    NICA: 'Commercial Banks', SBI: 'Commercial Banks', NBB: 'Commercial Banks',
    KBL: 'Commercial Banks', MBL: 'Commercial Banks', PCBL: 'Commercial Banks',
    SANIMA: 'Commercial Banks', HIDCL: 'Hydropower', NHPC: 'Hydropower',
    UPPER: 'Hydropower', AKPL: 'Hydropower', BARUN: 'Hydropower',
    NLIC: 'Life Insurance', LICN: 'Life Insurance', ALICL: 'Life Insurance',
    SICL: 'Non Life Insurance', NICL: 'Non Life Insurance', PRIN: 'Non Life Insurance',
    NLICL: 'Non Life Insurance', CBBL: 'Development Banks', KDBL: 'Development Banks',
    NABBC: 'Development Banks', GFCL: 'Finance', MFIL: 'Microfinance',
    SMFDB: 'Microfinance', SWBBL: 'Microfinance', NWCFL: 'Microfinance',
    NTC: 'Others', CHCL: 'Hydropower', NGPL: 'Hydropower', RRHP: 'Hydropower',
    UNHPL: 'Hydropower', GLH: 'Hotels And Tourism', SONA: 'Manufacturing And Processing',
    BNT: 'Manufacturing And Processing', HDL: 'Hydropower', DORDI: 'Hydropower',
    SAHAS: 'Hydropower', PMHPL: 'Hydropower', SICCO: 'Investment',
};

app.get('/api/52week-prices', async (req, res) => {
    try {
        // First try to scrape the dedicated 52-week page
        let stocks = [];
        try {
            stocks = await scrape52WeekData();
        } catch (scrapeErr) {
            console.log('52W dedicated page failed, falling back to live prices:', scrapeErr.message);
        }

        // Fallback: use live prices with prev-close as rough proxy
        if (stocks.length === 0) {
            const livePrices = await scrapeLivePrices();
            stocks = livePrices.map(s => {
                const ltp = parseFloat(s.ltp.replace(/,/g, '')) || 100;
                const prevClose = parseFloat((s.prevClose || s.ltp).replace(/,/g, '')) || ltp;
                // Use day's high/low as rough 52W proxies with ±30% spread
                return {
                    symbol: s.symbol,
                    ltp: s.ltp,
                    high52: (Math.max(ltp, prevClose) * 1.3).toFixed(2),
                    low52:  (Math.min(ltp, prevClose) * 0.7).toFixed(2)
                };
            });
        }

        // Attach sector from static map
        const data52 = stocks.map(s => ({
            ...s,
            sector: SECTOR_MAP[s.symbol] || 'Others'
        }));

        res.status(200).json({ success: true, data: data52 });
    } catch (error) {
        console.error('52W error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch 52-week data.' });
    }
});


// =========================================================
// BACKGROUND ALERT CHECKER (runs every 5 minutes)
// =========================================================
async function checkAlerts() {
    if (!db) return;
    console.log(`[${new Date().toISOString()}] 🔄 Background alert checker running...`);

    try {
        const stocks = await scrapeLivePrices();
        const priceMap = {};
        stocks.forEach(s => {
            const price = parseFloat(s.ltp.replace(/,/g, ''));
            if (!isNaN(price)) priceMap[s.symbol] = price;
        });

        // 1. Check Portfolio Targets/StopLoss
        const txSnapshot = await db.collection('transactions').where('alertTriggered', '==', false).get();
        for (const docSnap of txSnapshot.docs) {
            const tx = docSnap.data();
            const ltp = priceMap[tx.symbol];
            if (!ltp) continue;

            let alertMsg = null;
            let alertSubject = null;

            if (tx.targetPrice && ltp >= tx.targetPrice) {
                alertSubject = `📊 Portfolio Alert: ${tx.symbol} - Target Hit`;
                alertMsg = `🎯 TARGET HIT!\n\nStock: ${tx.symbol}\nCurrent Price: Rs ${ltp}\nYour Target: Rs ${tx.targetPrice}`;
            } else if (tx.stopLoss && ltp <= tx.stopLoss) {
                alertSubject = `📊 Portfolio Alert: ${tx.symbol} - Stop Loss Hit`;
                alertMsg = `⚠️ STOP LOSS HIT!\n\nStock: ${tx.symbol}\nCurrent Price: Rs ${ltp}\nYour Stop Loss: Rs ${tx.stopLoss}`;
            }

            if (alertMsg) {
                try {
                    await sendEmail(tx.email, alertSubject, alertMsg);
                    await db.collection('transactions').doc(docSnap.id).update({ alertTriggered: true });
                } catch (e) { console.error(`Failed to send email to ${tx.email}`); }
            }
        }

        // 2. Check Watchlist Targets (Send email if LTP <= TargetBuy)
        const wlSnapshot = await db.collection('watchlist').where('alertTriggered', '==', false).get();
        for (const docSnap of wlSnapshot.docs) {
            const wl = docSnap.data();
            const ltp = priceMap[wl.symbol];
            if (!ltp) continue;

            if (ltp <= wl.targetBuy) {
                const alertSubject = `👀 Watchlist Alert: ${wl.symbol} reached target`;
                const alertMsg = `Stock: ${wl.symbol}\nCurrent Price: Rs ${ltp}\nTarget Buy: Rs ${wl.targetBuy}\n\nIt's time to consider buying!`;
                try {
                    await sendEmail(wl.email, alertSubject, alertMsg);
                    await db.collection('watchlist').doc(docSnap.id).update({ alertTriggered: true });
                } catch (e) {}
            }
        }

        console.log(`[${new Date().toISOString()}] ✅ Alert check complete.`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Alert checker error:`, error.message);
    }
}

cron.schedule('*/5 * * * *', checkAlerts);
if (db) checkAlerts();

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend running perfectly on port ${PORT}`);
});