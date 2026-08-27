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

    // Nodemailer fallback (using Gmail App password or custom SMTP)
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        return await transporter.sendMail({
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
        const stocks = await scrape52WeekData();
        if (stocks.length === 0) {
            return res.status(503).json({ success: false, error: 'No data fetched. Market may be closed or site unavailable.' });
        }
        // Attach sector from static map
        const data52 = stocks.map(s => ({
            ...s,
            sector: SECTOR_MAP[s.symbol] || 'Others'
        }));
        console.log(`[52W] Fetched ${data52.length} stocks from Sharesansar.`);
        res.status(200).json({ success: true, count: data52.length, data: data52 });
    } catch (error) {
        console.error('52W error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch 52-week data: ' + error.message });
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
async function checkAlerts() {
    const today = getNepalDateString();
    console.log(`[${new Date().toISOString()}] 🔄 Background alert checker running (Date: ${today})...`);

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

        // ---------------------------------------------------------------
        // PART A: Portfolio / Transaction alerts (target price + stop loss)
        // ---------------------------------------------------------------
        const txSnapshot = await db.collection('transactions').get();
        let txAlertsSent = 0;

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
                try {
                    await sendEmail(tx.email, alertSubject, alertMsg);
                    await db.collection('transactions').doc(docSnap.id).update(updates);
                    txAlertsSent++;
                    console.log(`   ✅ Portfolio alert sent for ${tx.symbol} to ${tx.email}`);
                } catch (emailErr) {
                    console.error(`   ❌ Failed to send portfolio alert for ${tx.symbol}:`, emailErr.message);
                }
            }
        }

        // ---------------------------------------------------------------
        // PART B: Watchlist alerts (Target Buy, Take Profit, Stop Loss)
        // Sent AT MOST ONCE PER DAY per condition
        // ---------------------------------------------------------------
        const wlSnapshot = await db.collection('watchlist').get();
        let wlChecked = 0;
        let wlAlertsSent = 0;

        for (const docSnap of wlSnapshot.docs) {
            const wl = docSnap.data();
            const ltp = priceMap[wl.symbol];
            if (!ltp || !wl.email) continue;

            const updates = {};

            // 1. Target Buy alert (LTP <= targetBuy) - once per day
            if (wl.targetBuy && wl.targetBuy > 0 && ltp <= wl.targetBuy) {
                if (wl.lastBuyAlertDate !== today) {
                    const subject = `🛒 Watchlist Alert: ${wl.symbol} reached Target Buy (Rs ${ltp})`;
                    const msg = `🛒 TARGET BUY HIT!\n\nStock: ${wl.symbol}\nCurrent Price: Rs ${ltp}\nYour Target Buy Price: Rs ${wl.targetBuy}\nDate: ${today}\n\nLog in to your portfolio to act on this alert.`;
                    try {
                        await sendEmail(wl.email, subject, msg);
                        updates.lastBuyAlertDate = today;
                        updates.alertTriggered = true;
                        updates.lastBuyAlertAt = new Date().toISOString();
                        wlAlertsSent++;
                        console.log(`   ✅ Watchlist Buy alert sent for ${wl.symbol} to ${wl.email}`);
                    } catch (emailErr) {
                        console.error(`   ❌ Failed to send watchlist Buy alert for ${wl.symbol}:`, emailErr.message);
                    }
                }
            }

            // 2. Take Profit alert (LTP >= takeProfit) - once per day
            if (wl.takeProfit && wl.takeProfit > 0 && ltp >= wl.takeProfit) {
                if (wl.lastTpAlertDate !== today) {
                    const subject = `🎯 Watchlist Alert: ${wl.symbol} hit Take Profit (Rs ${ltp})`;
                    const msg = `🎯 TAKE PROFIT TARGET HIT!\n\nStock: ${wl.symbol}\nCurrent Price: Rs ${ltp}\nYour Take Profit Target: Rs ${wl.takeProfit}\nDate: ${today}\n\nLog in to your portfolio to secure your profits.`;
                    try {
                        await sendEmail(wl.email, subject, msg);
                        updates.lastTpAlertDate = today;
                        updates.tpAlertTriggered = true;
                        updates.lastTpAlertAt = new Date().toISOString();
                        wlAlertsSent++;
                        console.log(`   ✅ Watchlist TP alert sent for ${wl.symbol} to ${wl.email}`);
                    } catch (emailErr) {
                        console.error(`   ❌ Failed to send watchlist TP alert for ${wl.symbol}:`, emailErr.message);
                    }
                }
            }

            // 3. Stop Loss alert (LTP <= stopLoss) - once per day
            if (wl.stopLoss && wl.stopLoss > 0 && ltp <= wl.stopLoss) {
                if (wl.lastSlAlertDate !== today) {
                    const subject = `⚠️ Watchlist Alert: ${wl.symbol} hit Stop Loss (Rs ${ltp})`;
                    const msg = `⚠️ STOP LOSS BREACHED!\n\nStock: ${wl.symbol}\nCurrent Price: Rs ${ltp}\nYour Stop Loss Price: Rs ${wl.stopLoss}\nDate: ${today}\n\nLog in to your portfolio to manage your risk.`;
                    try {
                        await sendEmail(wl.email, subject, msg);
                        updates.lastSlAlertDate = today;
                        updates.slAlertTriggered = true;
                        updates.lastSlAlertAt = new Date().toISOString();
                        wlAlertsSent++;
                        console.log(`   ✅ Watchlist SL alert sent for ${wl.symbol} to ${wl.email}`);
                    } catch (emailErr) {
                        console.error(`   ❌ Failed to send watchlist SL alert for ${wl.symbol}:`, emailErr.message);
                    }
                }
            }

            if (Object.keys(updates).length > 0) {
                await db.collection('watchlist').doc(docSnap.id).update(updates);
            }
            wlChecked++;
        }

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

// Schedule: Run every 5 minutes 24/7 (cron expression: */5 * * * *)
cron.schedule('*/5 * * * *', () => {
    checkAlerts();
});

// Also run once immediately on server startup
checkAlerts();

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend running perfectly on port ${PORT}`);
    console.log(`Background alert checker scheduled to run 24/7 every 5 minutes.`);
});
