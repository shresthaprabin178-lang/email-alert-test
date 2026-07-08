const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const cron = require('node-cron');
const admin = require('firebase-admin');
require('dotenv').config();

/*// --- Firebase Admin Setup ---
const serviceAccount = require('./serviceAccountKey.json');
const { getFirestore } = require('firebase-admin/firestore');
admin.initializeApp({
    credential: admin.cert(serviceAccount)
});
const db = getFirestore();*/
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

// --- Email Sender via Gmail REST API (works on Render - no SMTP ports needed) ---
// Uses Google OAuth2 app password via Gmail API POST over HTTPS (port 443)
async function sendEmail(to, subject, text) {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        },
        connectionTimeout: 10000,   // fail fast: 10s
        greetingTimeout: 10000,
        socketTimeout: 15000
    });
    await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to,
        subject,
        text
    });
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