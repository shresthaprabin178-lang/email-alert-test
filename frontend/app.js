import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore, collection, addDoc, query, where, deleteDoc, doc, onSnapshot, getDoc, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyCCzyvBtibx9ag-EU6SUsKRHtBiwcnaFTE",
    authDomain: "emailalerttest-9660b.firebaseapp.com",
    projectId: "emailalerttest-9660b",
    storageBucket: "emailalerttest-9660b.firebasestorage.app",
    messagingSenderId: "513472297656",
    appId: "1:513472297656:web:640376e1166a2890d5524d",
    measurementId: "G-C8RDGDY8ZC"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// State
let currentUser = null;
let liveMarketData = [];
let hlMarketData = []; // 52 week data
let transactionsData = [];
let watchlistData = [];
let currentCash = 0;
let totalDeposited = 0;

const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') 
    ? 'http://localhost:5000' 
    : 'https://email-alert-backend-z097.onrender.com';

// DOM Elements - General
const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const googleLoginBtn = document.getElementById('google-login-btn');
const logoutBtn = document.getElementById('logout-btn');
const userNameEl = document.getElementById('user-name');
const userAvatarEl = document.getElementById('user-avatar');
const themeToggleBtn = document.getElementById('theme-toggle-btn');
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const navLinks = document.querySelectorAll('.nav-links li');
const tabContents = document.querySelectorAll('.tab-content');
const tabTitle = document.getElementById('current-tab-title');

// DOM Elements - Tables & Forms
const txForm = document.getElementById('transaction-form');
const txTypeSelect = document.getElementById('tx-type');
const holdingPeriodGroup = document.getElementById('holding-period-group');
const historyTableBody = document.getElementById('history-table-body');
const portfolioTableBody = document.getElementById('portfolio-table-body');
const liveTableBody = document.getElementById('live-table-body');
const watchlistTableBody = document.getElementById('watchlist-table-body');
const hlTableBody = document.getElementById('hl-table-body');
const wlForm = document.getElementById('watchlist-form');

// --- Theme Persistence & Initialization ---
const savedTheme = localStorage.getItem('theme') || 'theme-dark';
document.body.className = savedTheme;
if (savedTheme === 'theme-light') {
    themeToggleBtn.innerHTML = '<i class="ph ph-moon"></i> <span>Dark Mode</span>';
} else {
    themeToggleBtn.innerHTML = '<i class="ph ph-sun"></i> <span>Light Mode</span>';
}

themeToggleBtn.addEventListener('click', () => {
    const body = document.body;
    const isLight = body.classList.contains('theme-light');
    if (isLight) {
        body.className = 'theme-dark';
        themeToggleBtn.innerHTML = '<i class="ph ph-sun"></i> <span>Light Mode</span>';
        localStorage.setItem('theme', 'theme-dark');
    } else {
        body.className = 'theme-light';
        themeToggleBtn.innerHTML = '<i class="ph ph-moon"></i> <span>Dark Mode</span>';
        localStorage.setItem('theme', 'theme-light');
    }
});

mobileMenuBtn.addEventListener('click', () => {
    sidebar.classList.add('open');
    sidebarOverlay.classList.add('active');
});

sidebarOverlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('active');
});

// --- Tab Navigation ---
navLinks.forEach(link => {
    link.addEventListener('click', () => {
        navLinks.forEach(l => l.classList.remove('active'));
        tabContents.forEach(t => t.classList.remove('active'));

        link.classList.add('active');
        const tabId = link.getAttribute('data-tab');
        document.getElementById(`tab-${tabId}`).classList.add('active');

        const titles = { 'live': 'Live Market', 'portfolio': 'Portfolio', 'transactions': 'Transactions', 'watchlist': 'Watchlist', '52week': '52-Week H/L Screener' };
        tabTitle.textContent = titles[tabId];

        if (window.innerWidth <= 768) {
            sidebar.classList.remove('open');
            sidebarOverlay.classList.remove('active');
        }

        if (tabId === '52week' && hlMarketData.length === 0) {
            fetch52WeekData();
        }
    });
});

// --- Auth Logic ---
onAuthStateChanged(auth, async (user) => {
    if (user) {
        currentUser = user;
        userNameEl.textContent = user.displayName || user.email;
        userAvatarEl.src = user.photoURL || 'https://via.placeholder.com/40';

        loginScreen.classList.remove('active');
        dashboardScreen.classList.add('active');

        await initUserData();
        listenToTransactions();
        listenToWatchlist();
        fetchLivePrices();
    } else {
        currentUser = null;
        loginScreen.classList.add('active');
        dashboardScreen.classList.remove('active');
    }
});

googleLoginBtn.addEventListener('click', async () => {
    const provider = new GoogleAuthProvider();
    try { await signInWithPopup(auth, provider); } 
    catch (error) { alert("Failed to login: " + error.message); }
});

logoutBtn.addEventListener('click', () => signOut(auth));

// --- User Data (Cash) ---
async function initUserData() {
    const userRef = doc(db, "users", currentUser.uid);
    const docSnap = await getDoc(userRef);
    
    if (docSnap.exists()) {
        const data = docSnap.data();
        currentCash = data.cashBalance || 0;
        totalDeposited = data.totalDeposited || 0;
    } else {
        await setDoc(userRef, { email: currentUser.email, cashBalance: 0, totalDeposited: 0 });
        currentCash = 0;
        totalDeposited = 0;
    }
    updateCashDisplay();
}

async function updateCashBalance(amount, actionType) {
    let newBalance = currentCash;
    let newTotalDeposited = totalDeposited;

    if (actionType === 'deposit') {
        newBalance += amount;
        newTotalDeposited += amount;
    } else if (actionType === 'withdraw') {
        if (amount > newBalance) return false;
        newBalance -= amount;
        newTotalDeposited -= amount; // Withdrawing reduces your principal investment base
    } else if (actionType === 'buy') {
        if (amount > newBalance) return false;
        newBalance -= amount;
    } else if (actionType === 'sell') {
        newBalance += amount;
    }

    await updateDoc(doc(db, "users", currentUser.uid), { 
        cashBalance: newBalance,
        totalDeposited: newTotalDeposited
    });
    
    currentCash = newBalance;
    totalDeposited = newTotalDeposited;
    updateCashDisplay();
    updatePortfolio(); // Re-trigger portfolio update since P&L depends on these
    return true;
}

function updateCashDisplay() {
    document.getElementById('portfolio-cash').textContent = `Rs ${currentCash.toFixed(2)}`;
    const initEl = document.getElementById('portfolio-initial-invested');
    if (initEl) initEl.textContent = `Rs ${totalDeposited.toFixed(2)}`;
}

// Cash Modals
const cashModal = document.getElementById('cash-modal');
const cashForm = document.getElementById('cash-form');

document.getElementById('add-cash-btn').addEventListener('click', () => {
    document.getElementById('cash-action-type').value = 'add';
    document.getElementById('cash-modal-title').textContent = 'Add Cash';
    cashModal.classList.add('active');
});

document.getElementById('withdraw-cash-btn').addEventListener('click', () => {
    document.getElementById('cash-action-type').value = 'withdraw';
    document.getElementById('cash-modal-title').textContent = 'Withdraw Cash';
    cashModal.classList.add('active');
});

cashForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = document.getElementById('cash-action-type').value; // 'add' or 'withdraw'
    const amount = parseFloat(document.getElementById('cash-amount').value);
    
    const actionType = type === 'add' ? 'deposit' : 'withdraw';
    
    if (actionType === 'withdraw' && amount > currentCash) {
        alert("Insufficient funds to withdraw.");
        return;
    }
    
    await updateCashBalance(amount, actionType);
    cashModal.classList.remove('active');
    cashForm.reset();
});

// --- Modal Helpers ---
document.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.target.closest('.modal-overlay').classList.remove('active');
    });
});

// --- NEPSE Tax & Fee Calculator ---
function calculateNepseFees(type, qty, price, wacc = 0, isLongTerm = false) {
    if (type === 'BONUS') {
        return { brokerComm: 0, sebonFee: 0, dpFee: 0, cgt: 0, totalAmount: qty * 100 };
    }

    const amount = qty * price;
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
        const profit = grossReceivable - (qty * wacc);
        
        if (profit > 0) {
            cgt = profit * (isLongTerm ? 0.05 : 0.075);
        }
        totalCostOrNet = grossReceivable - cgt;
    }

    return { brokerComm, sebonFee, dpFee, cgt, totalAmount: totalCostOrNet };
}

// --- Firestore: Transactions ---
function listenToTransactions() {
    if (!currentUser) return;
    const q = query(collection(db, "transactions"), where("uid", "==", currentUser.uid));
    
    onSnapshot(q, (snapshot) => {
        transactionsData = [];
        historyTableBody.innerHTML = '';
        
        if (snapshot.empty) {
            historyTableBody.innerHTML = '<tr><td colspan="6" class="text-center">No transactions found.</td></tr>';
            updatePortfolio();
            return;
        }

        let rawDocs = [];
        snapshot.forEach(doc => rawDocs.push({ id: doc.id, ...doc.data() }));
        
        // Sort descending
        rawDocs.sort((a, b) => {
            const timeA = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : (new Date(a.dateString)).getTime();
            const timeB = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : (new Date(b.dateString)).getTime();
            return timeB - timeA;
        });

        rawDocs.forEach(data => {
            transactionsData.push(data);
            const tr = document.createElement('tr');
            
            const dateStr = data.createdAt?.toDate ? data.createdAt.toDate().toLocaleDateString() : data.dateString;
            let displayPrice = data.type === 'BUY' ? `WACC: Rs ${data.wacc?.toFixed(2)}` : (data.type === 'BONUS' ? 'FREE' : `Net: Rs ${(data.netReceivable/data.qty).toFixed(2)}`);
            
            tr.innerHTML = `
                <td>${dateStr || 'N/A'}</td>
                <td><strong>${data.symbol}</strong></td>
                <td class="${data.type === 'SELL' ? 'negative' : 'positive'}">${data.type}</td>
                <td>${data.qty}</td>
                <td>Rs ${data.price.toFixed(2)}<br><small style="color:var(--text-secondary)">${displayPrice}</small></td>
                <td>
                    <button class="btn-icon edit-history-btn" data-id="${data.id}"><i class="ph ph-pencil-simple"></i></button>
                    <button class="btn-icon delete-btn text-negative" data-id="${data.id}"><i class="ph ph-trash"></i></button>
                </td>
            `;
            historyTableBody.appendChild(tr);
        });

        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                if (confirm("Delete this transaction? Warning: Cash balance won't be automatically refunded for deletions.")) {
                    try {
                        await deleteDoc(doc(db, "transactions", id));
                        // The onSnapshot will automatically re-run and call updatePortfolio()
                    } catch(err) {
                        alert("Error deleting transaction");
                    }
                }
            });
        });

        document.querySelectorAll('.edit-history-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                const tx = transactionsData.find(t => t.id === id);
                if(tx) openEditModal(tx);
            });
        });

        updatePortfolio();
    });
}

// --- Add Transaction ---
txTypeSelect.addEventListener('change', (e) => {
    holdingPeriodGroup.style.display = e.target.value === 'SELL' ? 'block' : 'none';
    const priceInput = document.getElementById('tx-price');
    if(e.target.value === 'BONUS') {
        priceInput.value = 100;
        priceInput.setAttribute('readonly', 'true');
    } else {
        priceInput.removeAttribute('readonly');
    }
    updateLiveCalc();
});

function updateLiveCalc() {
    const type = document.getElementById('tx-type').value;
    const qty = parseInt(document.getElementById('tx-qty').value);
    const price = parseFloat(document.getElementById('tx-price').value);
    const symbol = document.getElementById('tx-symbol').value.toUpperCase();
    const liveCalcBox = document.getElementById('live-calc-box');
    
    if (!qty || !price || isNaN(qty) || isNaN(price) || qty <= 0 || price <= 0) {
        liveCalcBox.style.display = 'none'; return;
    }
    liveCalcBox.style.display = 'block';

    let currentWacc = price;
    if (type === 'SELL') {
        const holdings = computeHoldings();
        if (holdings[symbol] && holdings[symbol].wacc) currentWacc = holdings[symbol].wacc;
    }
    
    const isLongTerm = document.querySelector('input[name="holding-period"]:checked')?.value === 'long';
    const fees = calculateNepseFees(type, qty, price, currentWacc, isLongTerm);

    document.getElementById('calc-broker').textContent = fees.brokerComm.toFixed(2);
    document.getElementById('calc-sebon-dp').textContent = (fees.sebonFee + fees.dpFee).toFixed(2);
    const cgtRow = document.getElementById('calc-cgt-row');
    
    if (type === 'BUY' || type === 'BONUS') {
        cgtRow.style.display = 'none';
        document.getElementById('calc-total-label').textContent = 'Total Cost:';
        document.getElementById('calc-total').textContent = fees.totalAmount.toFixed(2);
        document.getElementById('calc-total').className = 'positive';
        document.getElementById('calc-wacc-label').textContent = 'WACC per share:';
        document.getElementById('calc-wacc').textContent = (fees.totalAmount / qty).toFixed(2);
    } else {
        cgtRow.style.display = 'flex';
        document.getElementById('calc-cgt').textContent = fees.cgt.toFixed(2);
        document.getElementById('calc-total-label').textContent = 'Net Receivable:';
        document.getElementById('calc-total').textContent = fees.totalAmount.toFixed(2);
        document.getElementById('calc-total').className = 'negative';
        document.getElementById('calc-wacc-label').textContent = 'Profit/Loss:';
        const pl = fees.totalAmount - (qty * currentWacc);
        document.getElementById('calc-wacc').textContent = (pl >= 0 ? '+' : '') + pl.toFixed(2);
    }
}
['tx-qty', 'tx-price', 'tx-symbol'].forEach(id => document.getElementById(id).addEventListener('input', updateLiveCalc));
document.querySelectorAll('input[name="holding-period"]').forEach(r => r.addEventListener('change', updateLiveCalc));

txForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser) return;
    
    const type = document.getElementById('tx-type').value;
    const qty = parseInt(document.getElementById('tx-qty').value);
    const price = parseFloat(document.getElementById('tx-price').value);
    const symbol = document.getElementById('tx-symbol').value.toUpperCase();

    const holdings = computeHoldings();
    let currentWacc = holdings[symbol] ? holdings[symbol].wacc : price;
    const isLongTerm = document.querySelector('input[name="holding-period"]:checked')?.value === 'long';
    
    const fees = calculateNepseFees(type, qty, price, currentWacc, isLongTerm);

    // Cash Verification
    if (type === 'BUY' || type === 'BONUS') {
        if (fees.totalAmount > currentCash && type === 'BUY') {
            alert(`Insufficient cash. You need Rs ${fees.totalAmount.toFixed(2)} but have Rs ${currentCash.toFixed(2)}.`);
            return;
        }
    } else if (type === 'SELL') {
        if (!holdings[symbol] || holdings[symbol].qty < qty) {
            alert(`You do not have enough quantity to sell ${qty} ${symbol}.`);
            return;
        }
    }

    const txData = {
        uid: currentUser.uid,
        email: currentUser.email,
        symbol, type, qty, price,
        createdAt: new Date(),
        wacc: type !== 'SELL' ? (fees.totalAmount / qty) : currentWacc,
        netReceivable: type === 'SELL' ? fees.totalAmount : 0,
        cgtPaid: fees.cgt || 0
    };

    try {
        await addDoc(collection(db, "transactions"), txData);
        // Update Cash
        if (type === 'BUY') await updateCashBalance(fees.totalAmount, 'buy');
        if (type === 'SELL') await updateCashBalance(fees.totalAmount, 'sell');

        txForm.reset();
        document.getElementById('live-calc-box').style.display = 'none';
        navLinks[1].click(); // Go to portfolio
    } catch (err) { alert("Failed to save transaction."); }
});

// --- Portfolio Computation ---
function computeHoldings() {
    const holdings = {};
    transactionsData.forEach(tx => {
        if (!holdings[tx.symbol]) holdings[tx.symbol] = { qty: 0, invested: 0, wacc: 0, targetPrice: null, stopLoss: null };

        if (tx.type === 'BUY' || tx.type === 'BONUS') {
            const currentTotalValue = holdings[tx.symbol].qty * holdings[tx.symbol].wacc;
            const newTxValue = tx.qty * (tx.wacc || tx.price);
            
            holdings[tx.symbol].qty += tx.qty;
            holdings[tx.symbol].wacc = (currentTotalValue + newTxValue) / holdings[tx.symbol].qty;
            holdings[tx.symbol].invested = holdings[tx.symbol].qty * holdings[tx.symbol].wacc;
        } else if (tx.type === 'SELL') {
            holdings[tx.symbol].qty -= tx.qty;
            holdings[tx.symbol].invested = holdings[tx.symbol].qty * holdings[tx.symbol].wacc;
        }

        // Always take latest non-null target/stop loss from transactions
        if (tx.targetPrice != null) holdings[tx.symbol].targetPrice = tx.targetPrice;
        if (tx.stopLoss != null) holdings[tx.symbol].stopLoss = tx.stopLoss;
    });
    return holdings;
}

function updatePortfolio() {
    portfolioTableBody.innerHTML = '';
    const holdings = computeHoldings();
    let totalInvested = 0, currentTotalValue = 0, totalNetValue = 0;
    
    const holdingKeys = Object.keys(holdings).filter(k => holdings[k].qty > 0);

    if (holdingKeys.length === 0) {
        portfolioTableBody.innerHTML = '<tr><td colspan="10" class="text-center">No active holdings.</td></tr>';
    } else {
        holdingKeys.forEach(symbol => {
            const h = holdings[symbol];
            totalInvested += h.invested;
            
            let ltp = h.wacc;
            const liveStock = liveMarketData.find(s => s.symbol === symbol);
            if (liveStock) ltp = parseFloat(liveStock.ltp.replace(/,/g, ''));

            // Calculate potential net receivable if sold today (assume short-term tax for conservative estimate)
            const fees = calculateNepseFees('SELL', h.qty, ltp, h.wacc, false);
            const netReceivable = fees.totalAmount;
            
            const currentValue = h.qty * ltp;
            currentTotalValue += currentValue;
            totalNetValue += netReceivable;

            const pl = netReceivable - h.invested;
            const plPerc = (pl / h.invested) * 100;
            const plClass = pl >= 0 ? 'positive' : 'negative';

            const tr = document.createElement('tr');
            const targetDisplay = h.targetPrice ? `<span class="positive">Rs ${parseFloat(h.targetPrice).toFixed(2)}</span>` : '<span class="text-sm">—</span>';
            const slDisplay = h.stopLoss ? `<span class="negative">Rs ${parseFloat(h.stopLoss).toFixed(2)}</span>` : '<span class="text-sm">—</span>';
            tr.innerHTML = `
                <td><strong>${symbol}</strong></td>
                <td>${h.qty}</td>
                <td>Rs ${h.wacc.toFixed(2)}</td>
                <td>Rs ${ltp.toFixed(2)}</td>
                <td>Rs ${currentValue.toFixed(2)}</td>
                <td class="${plClass}">${pl > 0 ? '+' : ''}Rs ${pl.toFixed(2)}</td>
                <td><span class="badge ${plClass}">${pl > 0 ? '+' : ''}${plPerc.toFixed(2)}%</span></td>
                <td>${targetDisplay}</td>
                <td>${slDisplay}</td>
                <td style="display:flex;gap:0.5rem;">
                    <button class="primary-btn btn-small sell-action-btn" data-symbol="${symbol}" data-qty="${h.qty}" data-ltp="${ltp}">Sell</button>
                    <button class="secondary-btn btn-small edit-targets-btn" data-symbol="${symbol}" data-target="${h.targetPrice || ''}" data-sl="${h.stopLoss || ''}"><i class="ph ph-bell"></i></button>
                </td>
            `;
            portfolioTableBody.appendChild(tr);
        });

        document.querySelectorAll('.sell-action-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const sym = e.currentTarget.getAttribute('data-symbol');
                const qty = e.currentTarget.getAttribute('data-qty');
                const ltp = e.currentTarget.getAttribute('data-ltp');
                openSellModal(sym, qty, ltp);
            });
        });

        document.querySelectorAll('.edit-targets-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const sym = e.currentTarget.getAttribute('data-symbol');
                const target = e.currentTarget.getAttribute('data-target');
                const sl = e.currentTarget.getAttribute('data-sl');
                openEditTargetsModal(sym, target, sl);
            });
        });
    }

    document.getElementById('portfolio-total-invested').textContent = `Rs ${totalInvested.toFixed(2)}`;
    document.getElementById('portfolio-total-value').textContent = `Rs ${currentTotalValue.toFixed(2)}`;
    
    const initEl = document.getElementById('portfolio-initial-invested');
    if (initEl) initEl.textContent = `Rs ${totalDeposited.toFixed(2)}`;

    // Feature 1 & 4: Overall P&L based on Initial Investment
    // Formula: ((Available Cash + Current Value of Holdings) - Initial Investment) / Initial Investment
    const totalAssetValue = currentTotalValue + currentCash;
    const totalPl = totalAssetValue - totalDeposited;
    
    let totalPlPerc = 0;
    if (totalDeposited > 0) {
        totalPlPerc = (totalPl / totalDeposited) * 100;
    }
    
    const plEl = document.getElementById('portfolio-pl');
    const plPercEl = document.getElementById('portfolio-pl-perc');
    
    plEl.textContent = `${totalPl >= 0 ? '+' : ''} Rs ${totalPl.toFixed(2)}`;
    plEl.className = totalPl >= 0 ? 'positive' : 'negative';
    plPercEl.textContent = `${totalPl >= 0 ? '+' : ''}${totalPlPerc.toFixed(2)}%`;
    plPercEl.className = `badge ${totalPl >= 0 ? 'positive' : 'negative'}`;
}

// --- Sell Modal Logic ---
const sellModal = document.getElementById('sell-modal');
const sellForm = document.getElementById('sell-form');

function openSellModal(symbol, maxQty, ltp) {
    document.getElementById('sell-symbol').value = symbol;
    document.getElementById('sell-avail-qty').value = maxQty;
    document.getElementById('sell-qty').value = maxQty;
    document.getElementById('sell-qty').max = maxQty;
    document.getElementById('sell-price').value = ltp;
    sellModal.classList.add('active');
}

sellForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const symbol = document.getElementById('sell-symbol').value;
    const qty = parseInt(document.getElementById('sell-qty').value);
    const price = parseFloat(document.getElementById('sell-price').value);
    const isLongTerm = document.querySelector('input[name="sell-holding"]:checked').value === 'long';
    
    const holdings = computeHoldings();
    const currentWacc = holdings[symbol].wacc;
    
    const fees = calculateNepseFees('SELL', qty, price, currentWacc, isLongTerm);
    
    const txData = {
        uid: currentUser.uid, email: currentUser.email,
        symbol, type: 'SELL', qty, price,
        createdAt: new Date(), wacc: currentWacc,
        netReceivable: fees.totalAmount, cgtPaid: fees.cgt
    };

    try {
        await addDoc(collection(db, "transactions"), txData);
        await updateCashBalance(fees.totalAmount, 'sell');
        sellModal.classList.remove('active');
        sellForm.reset();
    } catch (err) { alert("Sell failed"); }
});

// --- Edit Targets Logic ---
const editTargetsModal = document.getElementById('edit-targets-modal');
const editTargetsForm = document.getElementById('edit-targets-form');

function openEditTargetsModal(symbol, currentTarget, currentSl) {
    document.getElementById('edit-targets-symbol').textContent = symbol;
    document.getElementById('edit-targets-symbol-val').value = symbol;
    document.getElementById('edit-targets-target').value = currentTarget || '';
    document.getElementById('edit-targets-sl').value = currentSl || '';
    editTargetsModal.classList.add('active');
}

editTargetsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const symbol = document.getElementById('edit-targets-symbol-val').value;
    const targetPrice = parseFloat(document.getElementById('edit-targets-target').value) || null;
    const stopLoss = parseFloat(document.getElementById('edit-targets-sl').value) || null;

    try {
        // Update all BUY transactions for this symbol with the new target/sl
        const txToUpdate = transactionsData.filter(tx => tx.symbol === symbol && tx.type === 'BUY');
        for (const tx of txToUpdate) {
            await updateDoc(doc(db, 'transactions', tx.id), {
                targetPrice,
                stopLoss,
                alertTriggered: false // Reset so alert can fire again
            });
        }
        editTargetsModal.classList.remove('active');
        editTargetsForm.reset();
    } catch (err) {
        alert('Failed to update alerts.');
    }
});

// --- Edit Transaction Logic ---
const editModal = document.getElementById('edit-tx-modal');
const editForm = document.getElementById('edit-tx-form');

function openEditModal(tx) {
    document.getElementById('edit-tx-id').value = tx.id;
    document.getElementById('edit-tx-symbol').value = tx.symbol;
    document.getElementById('edit-tx-qty').value = tx.qty;
    document.getElementById('edit-tx-price').value = tx.price;
    
    let dateStr = "";
    if (tx.createdAt?.toDate) {
        dateStr = tx.createdAt.toDate().toISOString().split('T')[0];
    } else if (tx.dateString) {
        dateStr = new Date(tx.dateString).toISOString().split('T')[0];
    }
    document.getElementById('edit-tx-date').value = dateStr;
    
    editModal.classList.add('active');
}

editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-tx-id').value;
    const symbol = document.getElementById('edit-tx-symbol').value.toUpperCase();
    const qty = parseInt(document.getElementById('edit-tx-qty').value);
    const price = parseFloat(document.getElementById('edit-tx-price').value);
    const dateStr = document.getElementById('edit-tx-date').value;
    
    // Simplification: We don't recalculate cash retroactively for edits to avoid complexity,
    // we just update the record for portfolio math.
    const oldTx = transactionsData.find(t => t.id === id);
    const type = oldTx.type;
    const fees = calculateNepseFees(type, qty, price, type === 'SELL' ? oldTx.wacc : 0, false);

    try {
        await updateDoc(doc(db, "transactions", id), {
            symbol, qty, price,
            wacc: type !== 'SELL' ? (fees.totalAmount / qty) : oldTx.wacc,
            netReceivable: type === 'SELL' ? fees.totalAmount : 0,
            dateString: dateStr // Override date
        });
        editModal.classList.remove('active');
    } catch (err) { alert("Update failed"); }
});

// --- Watchlist ---
function listenToWatchlist() {
    if (!currentUser) return;
    const q = query(collection(db, "watchlist"), where("uid", "==", currentUser.uid));
    
    onSnapshot(q, (snapshot) => {
        watchlistData = [];
        watchlistTableBody.innerHTML = '';
        
        if (snapshot.empty) {
            watchlistTableBody.innerHTML = '<tr><td colspan="5" class="text-center">Watchlist is empty.</td></tr>';
            return;
        }

        snapshot.forEach(doc => watchlistData.push({ id: doc.id, ...doc.data() }));

        watchlistData.forEach(data => {
            let ltp = 0;
            const liveStock = liveMarketData.find(s => s.symbol === data.symbol);
            if (liveStock) ltp = parseFloat(liveStock.ltp.replace(/,/g, ''));
            
            const isTriggered = ltp > 0 && ltp <= data.targetBuy;
            
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${data.symbol}</strong></td>
                <td>Rs ${ltp || 'N/A'}</td>
                <td>Rs ${data.targetBuy}</td>
                <td>${data.alertTriggered ? '<span class="badge positive">Triggered</span>' : (isTriggered ? '<span class="badge positive">Hit!</span>' : '<span class="badge">Waiting</span>')}</td>
                <td>
                    <button class="btn-icon delete-wl-btn text-negative" data-id="${data.id}"><i class="ph ph-trash"></i></button>
                </td>
            `;
            watchlistTableBody.appendChild(tr);
        });

        document.querySelectorAll('.delete-wl-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                await deleteDoc(doc(db, "watchlist", e.currentTarget.getAttribute('data-id')));
            });
        });
    });
}

wlForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser) return;
    
    const symbol = document.getElementById('wl-symbol').value.toUpperCase();
    const target = parseFloat(document.getElementById('wl-target').value);
    
    try {
        await addDoc(collection(db, "watchlist"), {
            uid: currentUser.uid,
            email: currentUser.email,
            symbol: symbol,
            targetBuy: target,
            alertTriggered: false
        });
        wlForm.reset();
    } catch (err) { alert("Failed to add to watchlist."); }
});


// --- Live Market API Fetching ---
async function fetchLivePrices() {
    const sysStatus = document.getElementById('system-status');
    sysStatus.textContent = 'Fetching data...';

    try {
        const response = await fetch(`${API_BASE}/api/live-prices`);
        if (!response.ok) throw new Error("Backend error");

        const data = await response.json();
        liveMarketData = data.data || [];

        renderLiveTable();
        updatePortfolio();
        
        // Trigger watchlist re-render to update LTPs
        if (watchlistData.length > 0) listenToWatchlist(); 

        sysStatus.textContent = 'System Online';
    } catch (err) {
        sysStatus.textContent = 'Backend Offline';
        liveTableBody.innerHTML = '<tr><td colspan="6" class="text-center negative">Could not connect to backend.</td></tr>';
    }
}

function renderLiveTable() {
    liveTableBody.innerHTML = '';
    if (liveMarketData.length === 0) return;

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

document.getElementById('refresh-live-btn').addEventListener('click', fetchLivePrices);

document.getElementById('live-search-input').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    liveTableBody.querySelectorAll('tr').forEach(row => {
        if (row.cells.length < 6) return;
        row.style.display = row.cells[0].textContent.toLowerCase().includes(query) ? '' : 'none';
    });
});

// --- 52 Week H/L Data ---
async function fetch52WeekData() {
    hlTableBody.innerHTML = '<tr><td colspan="7" class="text-center">Fetching 52-Week Data...</td></tr>';
    try {
        const response = await fetch(`${API_BASE}/api/52week-prices`);
        if (!response.ok) throw new Error();
        const data = await response.json();
        hlMarketData = data.data || [];
        applyHlFilter();
    } catch (e) {
        hlTableBody.innerHTML = '<tr><td colspan="7" class="text-center negative">Failed to fetch data. Ensure backend is running.</td></tr>';
    }
}

function applyHlFilter() {
    if (hlMarketData.length === 0) return;
    const sector = document.getElementById('hl-sector-filter').value;
    const type = document.getElementById('hl-type-filter').value;
    const perc = parseFloat(document.getElementById('hl-perc-filter').value);

    hlTableBody.innerHTML = '';
    
    const filtered = hlMarketData.filter(stock => {
        if (sector !== 'ALL' && stock.sector !== sector) return false;
        
        const ltp = parseFloat(stock.ltp.replace(/,/g, ''));
        const high = parseFloat(stock.high52.replace(/,/g, ''));
        const low = parseFloat(stock.low52.replace(/,/g, ''));
        
        if (isNaN(ltp) || isNaN(high) || isNaN(low)) return false;

        if (type === 'LOW') {
            const percFromLow = ((ltp - low) / low) * 100;
            return percFromLow <= perc;
        } else {
            const percFromHigh = ((high - ltp) / high) * 100;
            return percFromHigh <= perc;
        }
    });

    if (filtered.length === 0) {
        hlTableBody.innerHTML = '<tr><td colspan="7" class="text-center">No stocks match this filter.</td></tr>';
        return;
    }

    filtered.forEach(stock => {
        const ltp = parseFloat(stock.ltp.replace(/,/g, ''));
        const high = parseFloat(stock.high52.replace(/,/g, ''));
        const low = parseFloat(stock.low52.replace(/,/g, ''));
        
        const percFromLow = ((ltp - low) / low) * 100;
        const percFromHigh = ((high - ltp) / high) * 100;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${stock.symbol}</strong></td>
            <td>${stock.sector || 'N/A'}</td>
            <td>Rs ${stock.ltp}</td>
            <td>Rs ${stock.high52}</td>
            <td>Rs ${stock.low52}</td>
            <td class="${percFromLow <= 5 ? 'negative' : ''}">${percFromLow.toFixed(2)}%</td>
            <td class="${percFromHigh <= 5 ? 'positive' : ''}">${percFromHigh.toFixed(2)}%</td>
        `;
        hlTableBody.appendChild(tr);
    });
}

document.getElementById('apply-hl-filter').addEventListener('click', applyHlFilter);

// --- Reset Portfolio ---
async function resetPortfolio() {
    if (!currentUser) return;
    
    const confirmFirst = confirm("⚠️ WARNING: This will permanently delete all your transaction history and reset your cash balance & initial investment to Rs 0.00.\n\nAre you sure you want to proceed?");
    if (!confirmFirst) return;
    
    const confirmSecond = confirm("🚨 FINAL CONFIRMATION: This action CANNOT be undone. Are you absolutely sure?");
    if (!confirmSecond) return;

    try {
        // Delete all transactions from Firestore
        const deletePromises = transactionsData.map(tx => deleteDoc(doc(db, "transactions", tx.id)));
        await Promise.all(deletePromises);

        // Reset cash in database
        await updateDoc(doc(db, "users", currentUser.uid), { 
            cashBalance: 0,
            totalDeposited: 0
        });

        currentCash = 0;
        totalDeposited = 0;
        updateCashDisplay();
        
        alert("Portfolio reset successfully!");
    } catch (error) {
        console.error("Error resetting portfolio:", error);
        alert("Failed to reset portfolio: " + error.message);
    }
}

document.getElementById('reset-portfolio-btn').addEventListener('click', resetPortfolio);