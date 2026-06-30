const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");
const axios = require("axios");
const cheerio = require("cheerio");

admin.initializeApp();
const db = admin.firestore();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Helper to scrape directly in the background function
async function getLivePrices() {
    const url = 'https://www.sharesansar.com/today-share-price';
    const response = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 10000
    });
    const $ = cheerio.load(response.data);
    const stocks = {};
    $('table.table-bordered tbody tr').each((index, element) => {
        const tds = $(element).find('td');
        if (tds.length > 5) {
            const symbol = $(tds[1]).text().trim();
            const ltp = $(tds[6]).text().trim().replace(/,/g, '');
            if(symbol && ltp) stocks[symbol] = parseFloat(ltp);
        }
    });
    return stocks;
}

// CRON JOB: Fires every 5 minutes
exports.sendScheduledAlert = onSchedule("every 5 minutes", async (event) => {
  logger.log("Cron wake-up: Checking stock alerts...");

  try {
      // 1. Get Live Prices
      const livePrices = await getLivePrices();
      
      // 2. Get active transactions with targets/stop-losses from Firestore
      const snapshot = await db.collection('transactions')
          .where('alertTriggered', '==', false)
          .get();
          
      if (snapshot.empty) {
          logger.log("No pending alerts.");
          return;
      }

      // 3. Check conditions
      for (const doc of snapshot.docs) {
          const tx = doc.data();
          const ltp = livePrices[tx.symbol];
          
          if (!ltp) continue;
          
          let alertMsg = null;
          
          if (tx.targetPrice && ltp >= tx.targetPrice) {
              alertMsg = `🎯 TARGET HIT: ${tx.symbol} is currently at Rs ${ltp} (Target: Rs ${tx.targetPrice})`;
          } else if (tx.stopLoss && ltp <= tx.stopLoss) {
              alertMsg = `⚠️ STOP LOSS HIT: ${tx.symbol} is currently at Rs ${ltp} (Stop Loss: Rs ${tx.stopLoss})`;
          }
          
          if (alertMsg) {
              // Send Email
              await transporter.sendMail({
                  from: process.env.EMAIL_USER,
                  to: tx.email, 
                  subject: `Stock Alert: ${tx.symbol}`,
                  text: `${alertMsg}\n\nTransaction Details:\nType: ${tx.type}\nQty: ${tx.qty}\nBought at: Rs ${tx.price}`
              });
              
              // Mark as triggered so we don't spam
              await db.collection('transactions').doc(doc.id).update({
                  alertTriggered: true
              });
              
              logger.log(`Alert sent for ${tx.symbol} to ${tx.email}`);
          }
      }
      
  } catch (error) {
      logger.error("Background runner failure:", error);
  }
});