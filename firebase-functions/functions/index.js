const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// CRON JOB: Fires every 5 minutes completely independently of Render/Vercel state
exports.sendScheduledAlert = onSchedule("every 5 minutes", async (event) => {
  logger.log("Cron wake-up: Checking offline automated queue...");

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: "YOUR_TEST_RECEIVER_EMAIL@gmail.com", // Destination test address
    subject: "⏰ Firebase Independent Cron Alert",
    text: "Verification complete! This notification confirms that background engine alerts remain online while frontend and backend nodes are fully shut down."
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.log("Offline background email successfully routed.");
  } catch (error) {
    logger.error("Background runner failure logging:", error);
  }
});