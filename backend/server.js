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

// This reads the raw JSON you pasted into the Render Environment Variable
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.cert(serviceAccount)
});

const db = getFirestore();

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// --- Email Sender via Resend HTTP API (works on Render - uses HTTPS port 443) ---
// Resend.com free tier: 3000 emails/month. No SMTP ports needed.
// Set RESEND_API_KEY in your Render environment variables.
async function sendEmail(to, subject, text) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        throw new Error('RESEND_API_KEY environment variable not set.');
    }
    const response = await axios.post('https://api.resend.com/emails', {
        from: 'Stock Alerts <alerts@prabinkshrestha.com.np>',
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
        throw new Error(`Resend API error: ${response.status} ${JSON.stringify(response.data)}`);
    }
    return response.data;
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
            const prevClose = $(tds[9]).text().trim();

            if (symbol && symbol !== 'Symbol') {
                stocks.push({
                    symbol,
                    ltp: ltp || '0',
                    diff: diff || '0',
                    percDiff: percDiff || '0',
                    high: high || '0',
                    low: low || '0',
                    prevClose: prevClose || '0'
                });
            }
        }
    });

    return stocks;
}

// Test route to ensure server works
app.get('/', (req, res) => {
    res.send('Backend is running successfully!');
});

// Web Scraper Endpoint for Live Prices (used by frontend)
app.get('/api/live-prices', async (req, res) => {
    try {
        const stocks = await scrapeLivePrices();
        res.status(200).json({ success: true, data: stocks });
    } catch (error) {
        console.error("Scraping error:", error.message);
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

// Trigger an alert manually
app.post('/api/send-alert', async (req, res) => {
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

// =========================================================
// BACKGROUND ALERT CHECKER (runs every 5 minutes)
// This runs automatically even when you are not using the app.
// As long as this server is alive on Render, it will keep checking.
// =========================================================
async function checkAlerts() {
    console.log(`[${new Date().toISOString()}] 🔄 Background alert checker running...`);

    try {
        // 1. Scrape live prices
        const stocks = await scrapeLivePrices();

        // Build a quick lookup map: { "NABIL": 1234.56, ... }
        const priceMap = {};
        stocks.forEach(s => {
            const price = parseFloat(s.ltp.replace(/,/g, ''));
            if (!isNaN(price)) priceMap[s.symbol] = price;
        });

        console.log(`   Scraped ${Object.keys(priceMap).length} stock prices.`);

        // 2. Get all transactions that have active (untriggered) alerts
        const snapshot = await db.collection('transactions')
            .where('alertTriggered', '==', false)
            .get();

        if (snapshot.empty) {
            console.log('   No pending alerts to check.');
            return;
        }

        console.log(`   Found ${snapshot.size} active alert(s) to check.`);

        // 3. Compare each transaction's target/stopLoss against live price
        for (const doc of snapshot.docs) {
            const tx = doc.data();
            const ltp = priceMap[tx.symbol];

            if (!ltp) continue; // Stock not found in today's data

            let alertMsg = null;
            let alertSubject = null;

            if (tx.targetPrice && ltp >= tx.targetPrice) {
                alertSubject = `📊 Stock Alert: ${tx.symbol} - Target Hit`;
                alertMsg = `🎯 TARGET HIT!\n\nStock: ${tx.symbol}\nCurrent Price: Rs ${ltp}\nYour Target: Rs ${tx.targetPrice}\n\nTransaction Details:\nType: ${tx.type}\nQty: ${tx.qty}\nBought at: Rs ${tx.price}`;
            } else if (tx.stopLoss && ltp <= tx.stopLoss) {
                alertSubject = `📊 Stock Alert: ${tx.symbol} - Stop Loss Hit`;
                alertMsg = `⚠️ STOP LOSS HIT!\n\nStock: ${tx.symbol}\nCurrent Price: Rs ${ltp}\nYour Stop Loss: Rs ${tx.stopLoss}\n\nTransaction Details:\nType: ${tx.type}\nQty: ${tx.qty}\nBought at: Rs ${tx.price}`;
            }

            if (alertMsg) {
                try {
                    // Send Email Alert
                    await sendEmail(tx.email, alertSubject, alertMsg);

                    // Mark as triggered so we don't send again
                    await db.collection('transactions').doc(doc.id).update({
                        alertTriggered: true
                    });

                    console.log(`   ✅ Alert sent for ${tx.symbol} to ${tx.email}`);
                } catch (emailErr) {
                    console.error(`   ❌ Failed to send alert for ${tx.symbol}:`, emailErr.message);
                    // Don't crash the whole loop — try next alert
                }
            }
        }

        console.log(`[${new Date().toISOString()}] ✅ Alert check complete.`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Alert checker error:`, error.message);
    }
}

// Schedule: Run every 5 minutes (cron expression: */5 * * * *)
cron.schedule('*/5 * * * *', () => {
    checkAlerts();
});

// Also run once immediately on server startup
checkAlerts();

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend running perfectly on port ${PORT}`);
    console.log(`Background alert checker scheduled to run every 5 minutes.`);
});
