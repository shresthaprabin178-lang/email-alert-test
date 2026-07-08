import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore, collection, addDoc, query, where, deleteDoc, doc, onSnapshot, orderBy, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyCCzyvBtibx9ag-EU6SUsKRHtBiwcnaFTE",
    authDomain: "emailalerttest-9660b.firebaseapp.com",
    projectId: "emailalerttest-9660b",
    storageBucket: "emailalerttest-9660b.firebasestorage.app",
    messagingSenderId: "513472297656",
    appId: "1:513472297656:web:640376e1166a2890d5524d",
    measurementId: "G-C8RDGDY8ZC"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// State
let currentUser = null;
let liveMarketData = []; // To cache live prices
let transactionsData = [];

// DOM Elements
const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const googleLoginBtn = document.getElementById('google-login-btn');
const logoutBtn = document.getElementById('logout-btn');
const userNameEl = document.getElementById('user-name');
const userAvatarEl = document.getElementById('user-avatar');

const navLinks = document.querySelectorAll('.nav-links li');
const tabContents = document.querySelectorAll('.tab-content');
const tabTitle = document.getElementById('current-tab-title');

const txForm = document.getElementById('transaction-form');
const historyTableBody = document.getElementById('history-table-body');
const portfolioTableBody = document.getElementById('portfolio-table-body');
const liveTableBody = document.getElementById('live-table-body');
const refreshLiveBtn = document.getElementById('refresh-live-btn');
const liveSearchInput = document.getElementById('live-search-input');
const txTypeSelect = document.getElementById('tx-type');
const holdingPeriodGroup = document.getElementById('holding-period-group');

txTypeSelect.addEventListener('change', (e) => {
    if (e.target.value === 'SELL') {
        holdingPeriodGroup.style.display = 'block';
    } else {
        holdingPeriodGroup.style.display = 'none';
    }
});

// --- Auth Logic ---
onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        userNameEl.textContent = user.displayName || user.email;
        userAvatarEl.src = user.photoURL || 'https://via.placeholder.com/40';

        loginScreen.classList.remove('active');
        dashboardScreen.classList.add('active');

        // Load user data
        listenToTransactions();
        fetchLivePrices();
    } else {
        currentUser = null;
        loginScreen.classList.add('active');
        dashboardScreen.classList.remove('active');
    }
});

googleLoginBtn.addEventListener('click', async () => {
    const provider = new GoogleAuthProvider();
    try {
        await signInWithPopup(auth, provider);
    } catch (error) {
        console.error("Login Error:", error);
        alert("Failed to login: " + error.message);
    }
});

logoutBtn.addEventListener('click', () => {
    signOut(auth);
});

// --- Tab Navigation ---
navLinks.forEach(link => {
    link.addEventListener('click', () => {
        // Remove active class
        navLinks.forEach(l => l.classList.remove('active'));
        tabContents.forEach(t => t.classList.remove('active'));

        // Add active class
        link.classList.add('active');
        const tabId = link.getAttribute('data-tab');
        document.getElementById(`tab-${tabId}`).classList.add('active');

        // Update Title
        const titles = { 'live': 'Live Market', 'portfolio': 'Portfolio', 'transactions': 'Transactions' };
        tabTitle.textContent = titles[tabId];
    });
});

// --- Firestore: Transactions ---
function listenToTransactions() {
    if (!currentUser) return;

    // Removed orderBy to prevent requiring a composite index in Firestore
    const q = query(
        collection(db, "transactions"),
        where("uid", "==", currentUser.uid)
    );

    onSnapshot(q, (snapshot) => {
        transactionsData = [];
        historyTableBody.innerHTML = '';

        if (snapshot.empty) {
            historyTableBody.innerHTML = '<tr><td colspan="8" class="text-center">No transactions found.</td></tr>';
            updatePortfolio();
            return;
        }

        let rawDocs = [];
        snapshot.forEach((doc) => {
            rawDocs.push({ id: doc.id, ...doc.data() });
        });

        // Sort in memory by createdAt descending
        rawDocs.sort((a, b) => {
            const timeA = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
            const timeB = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
            return timeB - timeA;
        });

        rawDocs.forEach((data) => {
            transactionsData.push(data);

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${new Date(data.createdAt?.toDate()).toLocaleDateString() || 'N/A'}</td>
                <td><strong>${data.symbol}</strong></td>
                <td class="${data.type === 'BUY' ? 'positive' : 'negative'}">${data.type}</td>
                <td>${data.qty}</td>
                <td>Rs ${parseFloat(data.price).toFixed(2)}<br><small style="color: #aaa;">${data.type === 'BUY' ? 'WACC: Rs ' + (data.wacc || data.price).toFixed(2) : 'Net: Rs ' + (data.netReceivable || (data.qty * data.price)).toFixed(2)}</small></td>
                <td>${data.targetPrice ? `Rs ${parseFloat(data.targetPrice).toFixed(2)}` : '-'}</td>
                <td>${data.stopLoss ? `Rs ${parseFloat(data.stopLoss).toFixed(2)}` : '-'}</td>
                <td><button class="btn-small delete-btn" data-id="${data.id}">Delete</button></td>
            `;
            historyTableBody.appendChild(tr);
        });

        // Add delete listeners
        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.target.getAttribute('data-id');
                if (confirm("Delete this transaction?")) {
                    await deleteDoc(doc(db, "transactions", id));
                }
            });
        });

        updatePortfolio();
    });
}

// --- NEPSE Tax & Fee Calculator ---
function calculateNepseFees(type, qty, price, wacc = 0, isLongTerm = false) {
    const amount = qty * price;
    
    // Broker Commission (Updated 2081/2024 rates)
    let brokerComm = 0;
    if (amount <= 50000) brokerComm = Math.max(10, amount * 0.0036);
    else if (amount <= 500000) brokerComm = amount * 0.0033;
    else if (amount <= 2000000) brokerComm = amount * 0.0031;
    else if (amount <= 10000000) brokerComm = amount * 0.0027;
    else brokerComm = amount * 0.0024;

    const sebonFee = amount * 0.00015;
    const dpFee = 25;

    let totalCostOrNet = 0;
    let cgt = 0;

    if (type === 'BUY') {
        totalCostOrNet = amount + brokerComm + sebonFee + dpFee;
    } else if (type === 'SELL') {
        const totalFees = brokerComm + sebonFee + dpFee;
        const grossReceivable = amount - totalFees;
        
        // Capital Gains Tax (CGT)
        const totalWaccCost = qty * wacc;
        const profit = grossReceivable - totalWaccCost;
        
        if (profit > 0) {
            cgt = profit * (isLongTerm ? 0.05 : 0.075);
        }
        
        totalCostOrNet = grossReceivable - cgt;
    }

    return {
        brokerComm,
        sebonFee,
        dpFee,
        cgt,
        totalAmount: totalCostOrNet
    };
}

txForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser) return;

    const submitBtn = txForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    const type = document.getElementById('tx-type').value;
    const qty = parseInt(document.getElementById('tx-qty').value);
    const price = parseFloat(document.getElementById('tx-price').value);
    const symbol = document.getElementById('tx-symbol').value.toUpperCase();

    let calculatedWacc = price;
    let netReceivable = 0;
    let cgtPaid = 0;

    if (type === 'BUY') {
        const fees = calculateNepseFees('BUY', qty, price);
        calculatedWacc = fees.totalAmount / qty;
    } else {
        const holdings = computeHoldings();
        const currentWacc = holdings[symbol] ? holdings[symbol].wacc : price;
        const isLongTerm = document.querySelector('input[name="holding-period"]:checked').value === 'long';
        
        const fees = calculateNepseFees('SELL', qty, price, currentWacc, isLongTerm);
        netReceivable = fees.totalAmount;
        cgtPaid = fees.cgt;
        calculatedWacc = currentWacc;
    }

    const txData = {
        uid: currentUser.uid,
        email: currentUser.email,
        symbol: symbol,
        type: type,
        qty: qty,
        price: price,
        targetPrice: parseFloat(document.getElementById('tx-target').value) || null,
        stopLoss: parseFloat(document.getElementById('tx-stoploss').value) || null,
        createdAt: new Date(),
        alertTriggered: false,
        wacc: calculatedWacc,
        netReceivable: netReceivable,
        cgtPaid: cgtPaid
    };

    try {
        await addDoc(collection(db, "transactions"), txData);
        txForm.reset();
        document.getElementById('live-calc-box').style.display = 'none';
        alert("Transaction added successfully!");
        // Switch to portfolio tab to see updates
        navLinks[1].click();
    } catch (error) {
        console.error("Error adding document: ", error);
        alert("Failed to save transaction.");
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save Transaction';
    }
});

// --- Live Calculation Update ---
function updateLiveCalc() {
    const type = document.getElementById('tx-type').value;
    const qtyStr = document.getElementById('tx-qty').value;
    const priceStr = document.getElementById('tx-price').value;
    const symbol = document.getElementById('tx-symbol').value.toUpperCase();
    
    const liveCalcBox = document.getElementById('live-calc-box');
    
    if (!qtyStr || !priceStr) {
        liveCalcBox.style.display = 'none';
        return;
    }
    
    const qty = parseInt(qtyStr);
    const price = parseFloat(priceStr);
    
    if (isNaN(qty) || isNaN(price) || qty <= 0 || price <= 0) {
        liveCalcBox.style.display = 'none';
        return;
    }

    liveCalcBox.style.display = 'block';

    let currentWacc = price;
    if (type === 'SELL') {
        const holdings = computeHoldings();
        if (holdings[symbol] && holdings[symbol].wacc) {
            currentWacc = holdings[symbol].wacc;
        }
    }
    
    const holdingRadio = document.querySelector('input[name="holding-period"]:checked');
    const isLongTerm = holdingRadio ? holdingRadio.value === 'long' : false;
    
    const fees = calculateNepseFees(type, qty, price, currentWacc, isLongTerm);

    document.getElementById('calc-broker').textContent = fees.brokerComm.toFixed(2);
    document.getElementById('calc-sebon-dp').textContent = (fees.sebonFee + fees.dpFee).toFixed(2);

    const calcCgtRow = document.getElementById('calc-cgt-row');
    const calcCgt = document.getElementById('calc-cgt');
    const calcTotalLabel = document.getElementById('calc-total-label');
    const calcTotal = document.getElementById('calc-total');
    const calcWaccLabel = document.getElementById('calc-wacc-label');
    const calcWacc = document.getElementById('calc-wacc');

    if (type === 'BUY') {
        calcCgtRow.style.display = 'none';
        calcTotalLabel.textContent = 'Total Cost:';
        calcTotal.textContent = fees.totalAmount.toFixed(2);
        calcTotal.style.color = '#4CAF50';
        calcWaccLabel.textContent = 'WACC per share:';
        calcWacc.textContent = (fees.totalAmount / qty).toFixed(2);
        calcWacc.style.color = '#2196F3';
    } else {
        calcCgtRow.style.display = 'flex';
        calcCgt.textContent = fees.cgt.toFixed(2);
        calcTotalLabel.textContent = 'Net Receivable:';
        calcTotal.textContent = fees.totalAmount.toFixed(2);
        calcTotal.style.color = '#F44336';
        calcWaccLabel.textContent = 'Profit/Loss:';
        const pl = fees.totalAmount - (qty * currentWacc);
        calcWacc.textContent = (pl >= 0 ? '+' : '') + pl.toFixed(2);
        calcWacc.style.color = pl >= 0 ? '#4CAF50' : '#F44336';
    }
}

document.getElementById('tx-type').addEventListener('change', updateLiveCalc);
document.getElementById('tx-qty').addEventListener('input', updateLiveCalc);
document.getElementById('tx-price').addEventListener('input', updateLiveCalc);
document.getElementById('tx-symbol').addEventListener('input', updateLiveCalc);
document.querySelectorAll('input[name="holding-period"]').forEach(r => r.addEventListener('change', updateLiveCalc));

// --- Portfolio Computation ---
function computeHoldings() {
    const holdings = {};

    transactionsData.forEach(tx => {
        if (!holdings[tx.symbol]) {
            holdings[tx.symbol] = { qty: 0, invested: 0, wacc: 0, targetPrice: null, stopLoss: null };
        }

        if (tx.type === 'BUY') {
            const currentTotalValue = holdings[tx.symbol].qty * holdings[tx.symbol].wacc;
            const newTxValue = tx.qty * (tx.wacc || tx.price);
            
            holdings[tx.symbol].qty += tx.qty;
            holdings[tx.symbol].wacc = (currentTotalValue + newTxValue) / holdings[tx.symbol].qty;
            holdings[tx.symbol].invested = holdings[tx.symbol].qty * holdings[tx.symbol].wacc;
        } else if (tx.type === 'SELL') {
            holdings[tx.symbol].qty -= tx.qty;
            holdings[tx.symbol].invested = holdings[tx.symbol].qty * holdings[tx.symbol].wacc; // WACC remains same on SELL
        }

        if (tx.targetPrice && !holdings[tx.symbol].targetPrice) holdings[tx.symbol].targetPrice = tx.targetPrice;
        if (tx.stopLoss && !holdings[tx.symbol].stopLoss) holdings[tx.symbol].stopLoss = tx.stopLoss;
    });

    return holdings;
}

function updatePortfolio() {
    portfolioTableBody.innerHTML = '';

    const holdings = computeHoldings();
    let totalInvested = 0;

    let currentTotalValue = 0;
    totalInvested = 0;

    const holdingKeys = Object.keys(holdings).filter(k => holdings[k].qty > 0);

    if (holdingKeys.length === 0) {
        portfolioTableBody.innerHTML = '<tr><td colspan="9" class="text-center">No active holdings.</td></tr>';
        document.getElementById('portfolio-total-value').textContent = 'Rs 0.00';
        document.getElementById('portfolio-total-invested').textContent = 'Rs 0.00';
        document.getElementById('portfolio-pl').textContent = 'Rs 0.00';
        document.getElementById('portfolio-pl').className = '';
        return;
    }

    holdingKeys.forEach(symbol => {
        const h = holdings[symbol];
        const wacc = h.wacc || 0;
        totalInvested += h.invested;

        // Find live price if available
        let ltp = wacc; // Fallback
        const liveStock = liveMarketData.find(s => s.symbol === symbol);
        if (liveStock) {
            ltp = parseFloat(liveStock.ltp.replace(/,/g, ''));
        }

        const currentValue = h.qty * ltp;
        currentTotalValue += currentValue;

        const pl = currentValue - h.invested;
        const plClass = pl >= 0 ? 'positive' : 'negative';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${symbol}</strong></td>
            <td>${h.qty}</td>
            <td>Rs ${wacc.toFixed(2)}</td>
            <td>Rs ${ltp.toFixed(2)}</td>
            <td>Rs ${currentValue.toFixed(2)}</td>
            <td class="${plClass}">${pl > 0 ? '+' : ''}Rs ${pl.toFixed(2)}</td>
            <td>${h.targetPrice ? `Rs ${h.targetPrice}` : '-'}</td>
            <td>${h.stopLoss ? `Rs ${h.stopLoss}` : '-'}</td>
            <td><button class="btn-small secondary-btn edit-target-btn" data-symbol="${symbol}" data-target="${h.targetPrice || ''}" data-sl="${h.stopLoss || ''}">Edit</button></td>
        `;
        portfolioTableBody.appendChild(tr);
    });

    // Add edit listeners
    document.querySelectorAll('.edit-target-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const symbol = e.target.getAttribute('data-symbol');
            const currentTarget = e.target.getAttribute('data-target');
            const currentSl = e.target.getAttribute('data-sl');

            const newTarget = prompt(`Enter new Target Price for ${symbol}:`, currentTarget);
            if (newTarget === null) return; // Cancelled

            const newSl = prompt(`Enter new Stop Loss for ${symbol}:`, currentSl);
            if (newSl === null) return; // Cancelled

            const parsedTarget = parseFloat(newTarget) || null;
            const parsedSl = parseFloat(newSl) || null;

            try {
                // Update all transactions for this symbol with the new target/sl
                const txToUpdate = transactionsData.filter(tx => tx.symbol === symbol);
                for (const tx of txToUpdate) {
                    await updateDoc(doc(db, "transactions", tx.id), {
                        targetPrice: parsedTarget,
                        stopLoss: parsedSl,
                        alertTriggered: false // Reset alert trigger since targets changed
                    });
                }
                alert(`Successfully updated targets for ${symbol}`);
            } catch (err) {
                console.error("Update error:", err);
                alert("Failed to update targets.");
            }
        });
    });

    // Update Top Metrics
    document.getElementById('portfolio-total-invested').textContent = `Rs ${totalInvested.toFixed(2)}`;
    document.getElementById('portfolio-total-value').textContent = `Rs ${currentTotalValue.toFixed(2)}`;

    const totalPl = currentTotalValue - totalInvested;
    const plEl = document.getElementById('portfolio-pl');
    plEl.textContent = `${totalPl >= 0 ? '+' : ''} Rs ${totalPl.toFixed(2)}`;
    plEl.className = totalPl >= 0 ? 'positive' : 'negative';
}

// --- Live Market API Fetching ---
async function fetchLivePrices() {
    const sysStatus = document.getElementById('system-status');
    sysStatus.textContent = 'Fetching data...';

    try {
        // Will point to our backend endpoint
        /*const response = await fetch('http://localhost:5000/api/live-prices');*/
        // To this:
        const response = await fetch('https://email-alert-backend-z097.onrender.com/api/live-prices');
        if (!response.ok) throw new Error("Backend error");

        const data = await response.json();
        liveMarketData = data.data || [];

        renderLiveTable();
        updatePortfolio(); // Re-calculate portfolio with new LTPs

        sysStatus.textContent = 'System Online (Live Data)';
    } catch (err) {
        console.error("Live fetch error", err);
        sysStatus.textContent = 'Backend Offline';

        // Render empty or error state
        liveTableBody.innerHTML = '<tr><td colspan="6" class="text-center negative">Could not connect to backend. Please ensure local server is running.</td></tr>';
    }
}

function renderLiveTable() {
    liveTableBody.innerHTML = '';
    if (liveMarketData.length === 0) {
        liveTableBody.innerHTML = '<tr><td colspan="6" class="text-center">No data parsed.</td></tr>';
        return;
    }

    liveMarketData.forEach(stock => {
        const diff = parseFloat(stock.diff);
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${stock.symbol}</strong></td>
            <td>Rs ${stock.ltp}</td>
            <td class="${diff >= 0 ? 'positive' : 'negative'}">${stock.diff}</td>
            <td class="${diff >= 0 ? 'positive' : 'negative'}">${stock.percDiff}%</td>
            <td>Rs ${stock.high}</td>
            <td>Rs ${stock.low}</td>
        `;
        liveTableBody.appendChild(tr);
    });
}

refreshLiveBtn.addEventListener('click', fetchLivePrices);

liveSearchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    const rows = liveTableBody.querySelectorAll('tr');
    rows.forEach(row => {
        if (row.cells.length < 6) return; // Skip empty/loading row
        const symbol = row.cells[0].textContent.toLowerCase();
        if (symbol.includes(query)) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
});