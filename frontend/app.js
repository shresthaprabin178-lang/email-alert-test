// Wait for the DOM to fully load before running the script
document.addEventListener('DOMContentLoaded', () => {
    const sendBtn = document.getElementById('sendBtn');
    const statusText = document.getElementById('status');

    // Prevent crashing if elements are missing from the HTML
    if (!sendBtn || !statusText) {
        console.error("Error: 'sendBtn' or 'status' element not found in the HTML layout.");
        return;
    }

    sendBtn.addEventListener('click', async () => {
        statusText.innerText = "Processing delivery request...";
        statusText.style.color = "#666";

        try {
            // Live Render Backend Endpoint
            const BACKEND_URL = 'https://email-alert-backend-z097.onrender.com/api/send-alert';

            const response = await fetch(BACKEND_URL, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({
                    email: 'your_actual_email@gmail.com', // 💡 REPLACE THIS with your real personal email address!
                    message: 'Success confirmation! The Render active backend pipeline is working perfectly.'
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                statusText.innerText = "✅ Dispatch complete! Check your inbox.";
                statusText.style.color = "green";
            } else {
                statusText.innerText = "❌ Backend error: " + (data.error || "Unknown server error");
                statusText.style.color = "red";
            }
        } catch (err) {
            console.error("Network Error Details:", err);
            statusText.innerText = "❌ Network error. Is your backend server active?";
            statusText.style.color = "red";
        }
    });
});