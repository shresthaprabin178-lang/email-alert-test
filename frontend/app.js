document.getElementById('sendBtn').addEventListener('click', async () => {
    const statusText = document.getElementById('status');
    statusText.innerText = "Processing delivery request...";
    statusText.style.color = "#666";

    try {
        // NOTE: Replace this URL with your live Render Web Service URL after deployment
        /*const BACKEND_URL = 'http://localhost:5000/api/send-alert'; */
        const BACKEND_URL = 'https://email-alert-backend-z097.onrender.com/api/send-alert';

        const response = await fetch(BACKEND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'YOUR_TEST_RECEIVER_EMAIL@gmail.com', // Put your personal test email here
                message: 'Success confirmation! The Render active backend pipeline is working perfectly.'
            })
        });
        
        const data = await response.json();
        if (data.success) {
            statusText.innerText = "✅ Dispatch complete! Check your inbox.";
            statusText.style.color = "green";
        } else {
            statusText.innerText = "❌ Backend error: " + data.error;
            statusText.style.color = "red";
        }
    } catch (err) {
        statusText.innerText = "❌ Network error. Is your backend server active?";
        statusText.style.color = "red";
    }
});