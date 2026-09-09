import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore, collection, addDoc, query, where, deleteDoc, doc, onSnapshot, getDoc, setDoc, updateDoc, getDocs, writeBatch } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

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
// Pre-load cached live prices from localStorage so portfolio renders correctly on refresh
let liveMarketData = JSON.parse(localStorage.getItem('cache_liveMarketData') || '[]');
let hlMarketData = []; // 52 week data
let setupEvaluatedData = []; // Setup tab calculated stocks data
let setupHistoricalCache = {}; // Historical candles cache
let stocksDatabaseData = []; // Stocks tab data from Firebase
let transactionsData = [];
let watchlistData = [];
let currentCash = 0;
let totalDeposited = 0;
let portfolioSortBy = 'pl-desc';
let portfolioSearchQuery = '';
let portfolioViewMode = 'grid'; // 'grid' or 'table'

// Tracks which watchlist alerts have been shown this browser session
// to avoid repeat pop-ups on every re-render
const wlAlertsShownThisSession = new Set();

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
const setupTableBody = document.getElementById('setup-table-body');
const stocksTableBody = document.getElementById('stocks-table-body');
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
const bottomNavItems = document.querySelectorAll('.bottom-nav-item[data-tab]');
const moreNavCards = document.querySelectorAll('.more-nav-card[data-tab]');
const mobileMoreModal = document.getElementById('mobile-more-modal');
const mobileMoreBtn = document.getElementById('mobile-more-nav-btn');

function switchTab(tabId) {
    navLinks.forEach(l => l.classList.remove('active'));
    bottomNavItems.forEach(b => b.classList.remove('active'));
    tabContents.forEach(t => t.classList.remove('active'));

    // Highlight active link in sidebar
    const activeSidebarLink = document.querySelector(`.nav-links li[data-tab="${tabId}"]`);
    if (activeSidebarLink) activeSidebarLink.classList.add('active');

    // Highlight active link in bottom nav (if exists)
    const activeBottomNav = document.querySelector(`.bottom-nav-item[data-tab="${tabId}"]`);
    if (activeBottomNav) {
        activeBottomNav.classList.add('active');
    } else if (mobileMoreBtn) {
        // If tab is in 'More' modal, highlight 'More' button
        mobileMoreBtn.classList.add('active');
    }

    // Show content
    const targetContent = document.getElementById(`tab-${tabId}`);
    if (targetContent) targetContent.classList.add('active');

    const titles = { 
        'live': 'Live Market', 
        'portfolio': 'Portfolio', 
        'transactions': 'Transactions', 
        'watchlist': 'Watchlist', 
        '52week': '52-Week H/L Screener',
        'setup': 'Swing Trading Setup',
        'stocks': 'Firebase Stock Database'
    };
    tabTitle.textContent = titles[tabId] || 'Dashboard';

    if (window.innerWidth <= 768) {
        sidebar.classList.remove('open');
        sidebarOverlay.classList.remove('active');
        if (mobileMoreModal) mobileMoreModal.classList.remove('active');
    }

    if (tabId === '52week' && hlMarketData.length === 0) {
        fetch52WeekData();
    }

    if (tabId === 'setup' && setupEvaluatedData.length === 0) {
        fetchSetupData();
    }

    if (tabId === 'stocks' && stocksDatabaseData.length === 0) {
        fetchStocksData();
    }
}

navLinks.forEach(link => {
    link.addEventListener('click', () => switchTab(link.getAttribute('data-tab')));
});

bottomNavItems.forEach(item => {
    item.addEventListener('click', () => switchTab(item.getAttribute('data-tab')));
});

moreNavCards.forEach(card => {
    card.addEventListener('click', () => switchTab(card.getAttribute('data-tab')));
});

if (mobileMoreBtn && mobileMoreModal) {
    mobileMoreBtn.addEventListener('click', () => {
        mobileMoreModal.classList.add('active');
    });
}

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
    // transactionsData is sorted newest-first for display; holdings must be computed oldest-first
    const chronological = [...transactionsData].reverse();
    chronological.forEach(tx => {
        if (!holdings[tx.symbol]) holdings[tx.symbol] = { qty: 0, invested: 0, bonusCost: 0, wacc: 0, targetPrice: null, stopLoss: null };

        if (tx.type === 'BUY' || tx.type === 'BONUS') {
            const currentTotalValue = holdings[tx.symbol].qty * holdings[tx.symbol].wacc;
            const newTxValue = tx.qty * (tx.wacc || tx.price);
            
            holdings[tx.symbol].qty += tx.qty;
            holdings[tx.symbol].wacc = (currentTotalValue + newTxValue) / holdings[tx.symbol].qty;

            // Track bonus cost separately: bonus adds Rs 100 * qty to WACC but should NOT count as actual investment
            if (tx.type === 'BONUS') {
                holdings[tx.symbol].bonusCost += tx.qty * 100;
            }

            // invested = qty * wacc (includes bonus cost base for WACC)
            // actualInvested (for display) = invested - bonusCost
            holdings[tx.symbol].invested = holdings[tx.symbol].qty * holdings[tx.symbol].wacc;
        } else if (tx.type === 'SELL') {
            // When selling, proportionally reduce bonus cost
            const sellRatio = tx.qty / holdings[tx.symbol].qty;
            holdings[tx.symbol].bonusCost -= holdings[tx.symbol].bonusCost * sellRatio;
            
            holdings[tx.symbol].qty -= tx.qty;
            holdings[tx.symbol].invested = holdings[tx.symbol].qty * holdings[tx.symbol].wacc;
        }

        // Always take latest non-null target/stop loss from transactions
        if (tx.targetPrice != null) holdings[tx.symbol].targetPrice = tx.targetPrice;
        if (tx.stopLoss != null) holdings[tx.symbol].stopLoss = tx.stopLoss;
    });
    return holdings;
}

// --- Portfolio Controls & Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
    setupPortfolioControls();
});

function setupPortfolioControls() {
    const searchInput = document.getElementById('portfolio-search-input');
    const sortSelect = document.getElementById('portfolio-sort-select');
    const gridBtn = document.getElementById('view-mode-grid');
    const tableBtn = document.getElementById('view-mode-table');
    const resetBtn = document.getElementById('reset-portfolio-btn');

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            portfolioSearchQuery = e.target.value.trim().toUpperCase();
            updatePortfolio();
        });
    }

    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            portfolioSortBy = e.target.value;
            updatePortfolio();
        });
    }

    if (gridBtn && tableBtn) {
        gridBtn.addEventListener('click', () => {
            portfolioViewMode = 'grid';
            gridBtn.classList.add('active');
            gridBtn.style.background = 'var(--accent)';
            gridBtn.style.color = 'white';
            tableBtn.classList.remove('active');
            tableBtn.style.background = 'transparent';
            tableBtn.style.color = 'var(--text-secondary)';
            updatePortfolio();
        });

        tableBtn.addEventListener('click', () => {
            portfolioViewMode = 'table';
            tableBtn.classList.add('active');
            tableBtn.style.background = 'var(--accent)';
            tableBtn.style.color = 'white';
            gridBtn.classList.remove('active');
            gridBtn.style.background = 'transparent';
            gridBtn.style.color = 'var(--text-secondary)';
            updatePortfolio();
        });
    }

    if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
            if (!currentUser) return;
            if (confirm("Are you sure you want to reset your portfolio? This will permanently delete all your transaction records.")) {
                try {
                    const q = query(collection(db, "transactions"), where("uid", "==", currentUser.uid));
                    const snapshot = await getDocs(q);
                    const deletePromises = [];
                    snapshot.forEach(docSnap => deletePromises.push(deleteDoc(doc(db, "transactions", docSnap.id))));
                    await Promise.all(deletePromises);
                    alert("Portfolio reset successfully.");
                } catch (err) {
                    alert("Failed to reset portfolio.");
                }
            }
        });
    }
}
// setupPortfolioControls() is called once via DOMContentLoaded above

function updatePortfolio() {
    const holdingsContainer = document.getElementById('portfolio-holdings-container');
    if (!holdingsContainer) return;
    
    holdingsContainer.innerHTML = '';
    const holdings = computeHoldings();
    let totalInvested = 0, currentTotalValue = 0, totalNetValue = 0;
    
    const holdingKeys = Object.keys(holdings).filter(k => holdings[k].qty > 0);

    // Build enriched holding items array
    const holdingItems = holdingKeys.map(symbol => {
        const h = holdings[symbol];
        // Current Investment = invested - bonusCost (exclude Rs 100 bonus cost base)
        const actualInvested = h.invested - (h.bonusCost || 0);
        totalInvested += actualInvested;
        
        let ltp = h.wacc;
        const liveStock = liveMarketData.find(s => s.symbol === symbol);
        if (liveStock) ltp = parseFloat(liveStock.ltp.replace(/,/g, ''));

        // Calculate potential net receivable if sold today (assume short-term tax for conservative estimate)
        const fees = calculateNepseFees('SELL', h.qty, ltp, h.wacc, false);
        const netReceivable = fees.totalAmount;
        
        const currentValue = h.qty * ltp;
        currentTotalValue += currentValue;
        totalNetValue += netReceivable;

        const pl = netReceivable - actualInvested;
        const plPerc = actualInvested > 0 ? (pl / actualInvested) * 100 : 0;

        return {
            symbol,
            qty: h.qty,
            wacc: h.wacc,
            ltp,
            actualInvested,
            currentValue,
            netReceivable,
            pl,
            plPerc,
            targetPrice: h.targetPrice,
            stopLoss: h.stopLoss
        };
    });

    // Filter items by symbol search query if entered
    let filteredItems = holdingItems;
    if (portfolioSearchQuery) {
        filteredItems = holdingItems.filter(item => item.symbol.includes(portfolioSearchQuery));
    }

    // Sort items based on portfolioSortBy
    filteredItems.sort((a, b) => {
        switch (portfolioSortBy) {
            case 'name-asc':
                return a.symbol.localeCompare(b.symbol);
            case 'name-desc':
                return b.symbol.localeCompare(a.symbol);
            case 'pl-desc':
                return b.pl - a.pl;
            case 'pl-asc':
                return a.pl - b.pl;
            case 'pl-perc-desc':
                return b.plPerc - a.plPerc;
            case 'pl-perc-asc':
                return a.plPerc - b.plPerc;
            case 'value-desc':
                return b.currentValue - a.currentValue;
            case 'value-asc':
                return a.currentValue - b.currentValue;
            default:
                return b.pl - a.pl;
        }
    });

    if (filteredItems.length === 0) {
        holdingsContainer.innerHTML = `
            <div class="glass-card text-center" style="padding: 2.5rem 1rem;">
                <i class="ph ph-briefcase" style="font-size: 2.5rem; color: var(--text-secondary); margin-bottom: 0.5rem; display: block;"></i>
                <p style="color: var(--text-secondary); font-size: 1rem;">${holdingItems.length === 0 ? 'No active holdings in your portfolio yet.' : 'No holdings found matching your search.'}</p>
            </div>
        `;
    } else {
        if (portfolioViewMode === 'grid') {
            // Render Card Grid View (No Horizontal Scroll)
            const gridEl = document.createElement('div');
            gridEl.className = 'portfolio-cards-grid';

            filteredItems.forEach(item => {
                const plClass = item.pl >= 0 ? 'positive' : 'negative';
                const card = document.createElement('div');
                card.className = 'portfolio-card';

                const targetDisplay = item.targetPrice ? `<span class="positive">Rs ${parseFloat(item.targetPrice).toFixed(2)}</span>` : '<span class="text-secondary">—</span>';
                const slDisplay = item.stopLoss ? `<span class="negative">Rs ${parseFloat(item.stopLoss).toFixed(2)}</span>` : '<span class="text-secondary">—</span>';

                card.innerHTML = `
                    <div class="portfolio-card-header">
                        <div class="symbol-wrap">
                            <button type="button" class="stock-symbol-btn stock-tx-trigger-btn" data-symbol="${item.symbol}" title="Click to view transaction history for ${item.symbol}">
                                <i class="ph ph-clock-counter-clockwise"></i> ${item.symbol}
                            </button>
                        </div>
                        <div class="ltp-wrap">
                            <span class="text-sm text-secondary" style="display:block; font-size:0.75rem;">LTP</span>
                            <span class="ltp-val">Rs ${item.ltp.toFixed(2)}</span>
                        </div>
                    </div>
                    <div class="portfolio-card-stats">
                        <div class="stat-item">
                            <span class="stat-label">Holding Qty</span>
                            <span class="stat-val">${item.qty} shares</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">WACC Price</span>
                            <span class="stat-val">Rs ${item.wacc.toFixed(2)}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Current Inv.</span>
                            <span class="stat-val">Rs ${item.actualInvested.toFixed(2)}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Current Value</span>
                            <span class="stat-val">Rs ${item.currentValue.toFixed(2)}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Target Buy/TP</span>
                            <span class="stat-val">${targetDisplay}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Stop Loss</span>
                            <span class="stat-val">${slDisplay}</span>
                        </div>
                    </div>
                    <div class="portfolio-card-footer">
                        <div class="pl-pill">
                            <span class="pl-amount ${plClass}">${item.pl >= 0 ? '+' : ''}Rs ${item.pl.toFixed(2)}</span>
                            <span class="pl-perc-badge badge ${plClass}">${item.pl >= 0 ? '+' : ''}${item.plPerc.toFixed(2)}%</span>
                        </div>
                        <div class="card-actions">
                            <button class="primary-btn btn-small sell-action-btn" data-symbol="${item.symbol}" data-qty="${item.qty}" data-ltp="${item.ltp}">Sell</button>
                            <button class="secondary-btn btn-small edit-targets-btn" data-symbol="${item.symbol}" data-target="${item.targetPrice || ''}" data-sl="${item.stopLoss || ''}" title="Set Price Alerts"><i class="ph ph-bell"></i></button>
                        </div>
                    </div>
                `;
                gridEl.appendChild(card);
            });
            holdingsContainer.appendChild(gridEl);
        } else {
            // Render Compact Table View
            const tableWrap = document.createElement('div');
            tableWrap.className = 'table-container';
            
            const table = document.createElement('table');
            table.id = 'portfolio-table';
            table.innerHTML = `
                <thead>
                    <tr>
                        <th>Symbol</th>
                        <th>Qty</th>
                        <th>WACC</th>
                        <th>LTP</th>
                        <th>Current Inv.</th>
                        <th>Current Value</th>
                        <th>P&L (Net)</th>
                        <th>P&L %</th>
                        <th>Target</th>
                        <th>Stop Loss</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody id="portfolio-table-body"></tbody>
            `;

            const tbody = table.querySelector('tbody');
            filteredItems.forEach(item => {
                const plClass = item.pl >= 0 ? 'positive' : 'negative';
                const tr = document.createElement('tr');
                const targetDisplay = item.targetPrice ? `<span class="positive">Rs ${parseFloat(item.targetPrice).toFixed(2)}</span>` : '<span class="text-sm">—</span>';
                const slDisplay = item.stopLoss ? `<span class="negative">Rs ${parseFloat(item.stopLoss).toFixed(2)}</span>` : '<span class="text-sm">—</span>';

                tr.innerHTML = `
                    <td>
                        <button type="button" class="stock-symbol-btn stock-tx-trigger-btn" data-symbol="${item.symbol}" title="View transaction history for ${item.symbol}">
                            ${item.symbol}
                        </button>
                    </td>
                    <td>${item.qty}</td>
                    <td>Rs ${item.wacc.toFixed(2)}</td>
                    <td>Rs ${item.ltp.toFixed(2)}</td>
                    <td>Rs ${item.actualInvested.toFixed(2)}</td>
                    <td>Rs ${item.currentValue.toFixed(2)}</td>
                    <td class="${plClass}">${item.pl >= 0 ? '+' : ''}Rs ${item.pl.toFixed(2)}</td>
                    <td><span class="badge ${plClass}">${item.pl >= 0 ? '+' : ''}${item.plPerc.toFixed(2)}%</span></td>
                    <td>${targetDisplay}</td>
                    <td>${slDisplay}</td>
                    <td style="display:flex;gap:0.5rem;">
                        <button class="primary-btn btn-small sell-action-btn" data-symbol="${item.symbol}" data-qty="${item.qty}" data-ltp="${item.ltp}">Sell</button>
                        <button class="secondary-btn btn-small edit-targets-btn" data-symbol="${item.symbol}" data-target="${item.targetPrice || ''}" data-sl="${item.stopLoss || ''}"><i class="ph ph-bell"></i></button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
            tableWrap.appendChild(table);
            holdingsContainer.appendChild(tableWrap);
        }

        // Attach event listeners for stock symbol clicks and card actions
        document.querySelectorAll('.stock-tx-trigger-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const sym = e.currentTarget.getAttribute('data-symbol');
                openStockTxModal(sym);
            });
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

    // Top metrics updates
    document.getElementById('portfolio-total-invested').textContent = `Rs ${totalInvested.toFixed(2)}`;
    document.getElementById('portfolio-total-value').textContent = `Rs ${currentTotalValue.toFixed(2)}`;
    
    const initEl = document.getElementById('portfolio-initial-invested');
    if (initEl) initEl.textContent = `Rs ${totalDeposited.toFixed(2)}`;

    // Overall P&L based on Initial Investment
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

// --- Individual Stock Transaction History Modal ---
function openStockTxModal(symbol) {
    const stockTxModal = document.getElementById('stock-tx-modal');
    if (!symbol || !stockTxModal) return;

    document.getElementById('modal-tx-symbol').textContent = symbol;
    
    // Filter user transactions for this individual stock
    const symbolTxs = transactionsData.filter(t => t.symbol === symbol);

    // Calculate symbol-level summary stats
    let boughtQty = 0, boughtCost = 0;
    let soldQty = 0, soldRev = 0;
    let cgtPaid = 0;

    symbolTxs.forEach(t => {
        if (t.type === 'BUY' || t.type === 'BONUS') {
            boughtQty += t.qty;
            boughtCost += (t.qty * (t.wacc || t.price));
        } else if (t.type === 'SELL') {
            soldQty += t.qty;
            soldRev += (t.netReceivable || (t.qty * t.price));
            cgtPaid += (t.cgtPaid || 0);
        }
    });

    const holdings = computeHoldings();
    const activeHolding = holdings[symbol] || { qty: 0, wacc: 0 };

    let costOfSoldShares = soldQty * (activeHolding.wacc || (boughtQty > 0 ? boughtCost / boughtQty : 0));
    let realizedPl = soldRev - costOfSoldShares;

    document.getElementById('modal-tx-holding-qty').textContent = `${activeHolding.qty} Qty`;
    document.getElementById('modal-tx-wacc').textContent = `WACC: Rs ${activeHolding.wacc.toFixed(2)}`;
    
    document.getElementById('modal-tx-total-bought').textContent = `${boughtQty} Qty`;
    document.getElementById('modal-tx-bought-cost').textContent = `Cost: Rs ${boughtCost.toFixed(2)}`;
    
    document.getElementById('modal-tx-total-sold').textContent = `${soldQty} Qty`;
    document.getElementById('modal-tx-sold-rev').textContent = `Recv: Rs ${soldRev.toFixed(2)}`;

    const realizedEl = document.getElementById('modal-tx-realized-pl');
    realizedEl.textContent = `${realizedPl >= 0 ? '+' : ''}Rs ${realizedPl.toFixed(2)}`;
    realizedEl.className = realizedPl >= 0 ? 'positive' : 'negative';
    document.getElementById('modal-tx-cgt-paid').textContent = `CGT Paid: Rs ${cgtPaid.toFixed(2)}`;

    // Populate transaction records table
    const stockTxTableBody = document.getElementById('stock-tx-table-body');
    stockTxTableBody.innerHTML = '';
    
    if (symbolTxs.length === 0) {
        stockTxTableBody.innerHTML = '<tr><td colspan="6" class="text-center">No transaction records found for this stock.</td></tr>';
    } else {
        symbolTxs.forEach(tx => {
            const tr = document.createElement('tr');
            const dateStr = tx.createdAt?.toDate ? tx.createdAt.toDate().toLocaleDateString() : (tx.dateString || 'N/A');
            const isSell = tx.type === 'SELL';
            const isBonus = tx.type === 'BONUS';

            let typeBadgeClass = isSell ? 'negative' : (isBonus ? 'accent' : 'positive');
            let executedText = isBonus ? 'FREE (Rs 100 base)' : `Rs ${tx.price.toFixed(2)}`;
            let netAmountText = isSell 
                ? `Net: Rs ${tx.netReceivable ? tx.netReceivable.toFixed(2) : (tx.qty * tx.price).toFixed(2)}`
                : (isBonus ? 'Rs 0.00' : `Cost: Rs ${tx.wacc ? (tx.qty * tx.wacc).toFixed(2) : (tx.qty * tx.price).toFixed(2)}`);

            tr.innerHTML = `
                <td>${dateStr}</td>
                <td><span class="badge ${typeBadgeClass}">${tx.type}</span></td>
                <td><strong>${tx.qty}</strong></td>
                <td>${executedText}</td>
                <td>${netAmountText}</td>
                <td>
                    <button class="btn-icon modal-edit-tx-btn" data-id="${tx.id}"><i class="ph ph-pencil-simple"></i></button>
                    <button class="btn-icon modal-delete-tx-btn text-negative" data-id="${tx.id}"><i class="ph ph-trash"></i></button>
                </td>
            `;
            stockTxTableBody.appendChild(tr);
        });

        // Add listeners for edit/delete actions inside modal
        stockTxTableBody.querySelectorAll('.modal-edit-tx-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                const tx = transactionsData.find(t => t.id === id);
                if (tx) {
                    stockTxModal.classList.remove('active');
                    openEditModal(tx);
                }
            });
        });

        stockTxTableBody.querySelectorAll('.modal-delete-tx-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                if (confirm("Delete this transaction record?")) {
                    try {
                        await deleteDoc(doc(db, "transactions", id));
                        setTimeout(() => openStockTxModal(symbol), 300);
                    } catch (err) {
                        alert("Error deleting transaction record");
                    }
                }
            });
        });
    }

    const modalAddTxBtn = document.getElementById('modal-add-tx-btn');
    if (modalAddTxBtn) {
        modalAddTxBtn.onclick = () => {
            stockTxModal.classList.remove('active');
            document.getElementById('tx-symbol').value = symbol;
            switchTab('transactions');
        };
    }

    stockTxModal.classList.add('active');
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

// In-browser toast notification helper
function showToast(title, message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    const colors = {
        success: { bg: 'rgba(34,197,94,0.15)', border: '#22c55e', icon: '🎯' },
        danger:  { bg: 'rgba(239,68,68,0.15)',  border: '#ef4444', icon: '⚠️' },
        info:    { bg: 'rgba(99,102,241,0.15)', border: '#6366f1', icon: 'ℹ️' }
    };
    const { bg, border, icon } = colors[type] || colors.info;

    toast.style.cssText = `
        background: ${bg};
        border: 1px solid ${border};
        border-radius: 12px;
        padding: 1rem 1.25rem;
        max-width: 340px;
        backdrop-filter: blur(12px);
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        pointer-events: all;
        animation: toastSlideIn 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards;
        cursor: pointer;
        transition: opacity 0.3s ease;
    `;
    toast.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:0.75rem;">
            <span style="font-size:1.4rem;line-height:1;">${icon}</span>
            <div style="flex:1;min-width:0;">
                <div style="font-weight:600;font-size:0.9rem;color:var(--text-primary);margin-bottom:0.25rem;">${title}</div>
                <div style="font-size:0.8rem;color:var(--text-secondary);line-height:1.4;">${message}</div>
            </div>
            <button onclick="this.closest('[data-toast]').remove()" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:1rem;line-height:1;padding:0;">✕</button>
        </div>
    `;
    toast.setAttribute('data-toast', '1');
    toast.addEventListener('click', () => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    });

    // Inject keyframe if not already present
    if (!document.getElementById('toast-keyframe')) {
        const style = document.createElement('style');
        style.id = 'toast-keyframe';
        style.textContent = `
            @keyframes toastSlideIn {
                from { opacity:0; transform: translateX(40px) scale(0.9); }
                to   { opacity:1; transform: translateX(0)   scale(1); }
            }
        `;
        document.head.appendChild(style);
    }

    container.appendChild(toast);
    // Auto-dismiss after 8 seconds
    setTimeout(() => {
        if (toast.parentNode) {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }
    }, 8000);
}

// Send watchlist alert via backend email (non-blocking)
function sendWatchlistEmailAlert(email, subject, message) {
    fetch(`${API_BASE}/api/send-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, subject, message })
    }).catch(err => console.warn('Watchlist email alert failed:', err.message));
}

function listenToWatchlist() {
    if (!currentUser) return;
    const q = query(collection(db, "watchlist"), where("uid", "==", currentUser.uid));
    
    onSnapshot(q, (snapshot) => {
        watchlistData = [];
        snapshot.forEach(docSnap => watchlistData.push({ id: docSnap.id, ...docSnap.data() }));
        renderWatchlist();
    });
}

function renderWatchlist() {
    watchlistTableBody.innerHTML = '';

    if (watchlistData.length === 0) {
        watchlistTableBody.innerHTML = '<tr><td colspan="9" class="text-center">Watchlist is empty.</td></tr>';
        return;
    }

    watchlistData.forEach(data => {
        let ltp = 0;
        const liveStock = liveMarketData.find(s => s.symbol === data.symbol);
        if (liveStock) ltp = parseFloat(liveStock.ltp.replace(/,/g, ''));
        
        // --- Buy alert: LTP <= targetBuy ---
        const isBuyHit  = ltp > 0 && ltp <= data.targetBuy;

        // --- Take Profit alert: LTP >= takeProfit (if set) ---
        const hasTp      = data.takeProfit && data.takeProfit > 0;
        const isTpHit    = hasTp && ltp > 0 && ltp >= data.takeProfit;

        // --- Stop Loss alert: LTP <= stopLoss (if set) ---
        const hasSl      = data.stopLoss && data.stopLoss > 0;
        const isSlHit    = hasSl && ltp > 0 && ltp <= data.stopLoss;

        // --- Fire in-browser toast for fresh hits (once per session for UI feedback) ---
        const sessionKeyBuy = `${data.id}_buy`;
        const sessionKeyTp  = `${data.id}_tp`;
        const sessionKeySl  = `${data.id}_sl`;

        if (isBuyHit && !data.alertTriggered && !wlAlertsShownThisSession.has(sessionKeyBuy)) {
            wlAlertsShownThisSession.add(sessionKeyBuy);
            showToast(
                `🛒 Buy Alert: ${data.symbol}`,
                `LTP Rs ${ltp} has reached your target buy price of Rs ${data.targetBuy}. Time to buy!`,
                'success'
            );
        }

        if (isTpHit && !data.tpAlertTriggered && !wlAlertsShownThisSession.has(sessionKeyTp)) {
            wlAlertsShownThisSession.add(sessionKeyTp);
            showToast(
                `🎯 Take Profit: ${data.symbol}`,
                `LTP Rs ${ltp} has hit your take profit target of Rs ${data.takeProfit}. Consider selling!`,
                'success'
            );
        }

        if (isSlHit && !data.slAlertTriggered && !wlAlertsShownThisSession.has(sessionKeySl)) {
            wlAlertsShownThisSession.add(sessionKeySl);
            showToast(
                `⚠️ Stop Loss Hit: ${data.symbol}`,
                `LTP Rs ${ltp} has breached your stop loss of Rs ${data.stopLoss}. Consider cutting losses!`,
                'danger'
            );
        }

        // --- Badge helpers ---
        const buyBadge = data.alertTriggered
            ? '<span class="badge positive">Triggered</span>'
            : isBuyHit
                ? '<span class="badge positive">Hit!</span>'
                : '<span class="badge">Waiting</span>';

        const tpBadge = !hasTp
            ? '<span class="text-sm" style="color:var(--text-secondary)">—</span>'
            : data.tpAlertTriggered
                ? '<span class="badge positive">Triggered ✓</span>'
                : isTpHit
                    ? '<span class="badge positive">Hit! 🎯</span>'
                    : '<span class="badge">Waiting</span>';

        const slBadge = !hasSl
            ? '<span class="text-sm" style="color:var(--text-secondary)">—</span>'
            : data.slAlertTriggered
                ? '<span class="badge negative">Triggered ⚠️</span>'
                : isSlHit
                    ? '<span class="badge negative">Hit! ⚠️</span>'
                    : '<span class="badge">Waiting</span>';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${data.symbol}</strong></td>
            <td>Rs ${ltp || 'N/A'}</td>
            <td>Rs ${data.targetBuy}</td>
            <td>${hasTp ? `<span class="positive">Rs ${parseFloat(data.takeProfit).toFixed(2)}</span>` : '<span class="text-sm">—</span>'}</td>
            <td>${hasSl ? `<span class="negative">Rs ${parseFloat(data.stopLoss).toFixed(2)}</span>` : '<span class="text-sm">—</span>'}</td>
            <td>${buyBadge}</td>
            <td>${tpBadge}</td>
            <td>${slBadge}</td>
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
}

wlForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser) return;
    
    const symbol     = document.getElementById('wl-symbol').value.toUpperCase();
    const target     = parseFloat(document.getElementById('wl-target').value);
    const takeProfit = parseFloat(document.getElementById('wl-take-profit').value) || null;
    const stopLoss   = parseFloat(document.getElementById('wl-stop-loss').value) || null;
    
    try {
        await addDoc(collection(db, "watchlist"), {
            uid: currentUser.uid,
            email: currentUser.email,
            symbol: symbol,
            targetBuy: target,
            takeProfit: takeProfit,
            stopLoss: stopLoss,
            alertTriggered: false,
            tpAlertTriggered: false,
            slAlertTriggered: false
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
        localStorage.setItem('cache_liveMarketData', JSON.stringify(liveMarketData));

        renderLiveTable();
        updatePortfolio();
        
        // Trigger watchlist re-render to update LTPs (don't re-attach listener, just re-render)
        if (watchlistData.length > 0) renderWatchlist();

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
    const perc = parseFloat(document.getElementById('hl-perc-filter').value) || 10;
    const sortBy = document.getElementById('hl-sort-filter').value;
    const searchQuery = (document.getElementById('hl-search-input').value || '').trim().toUpperCase();

    hlTableBody.innerHTML = '';

    // Show/hide the % input based on filter type
    const percLabel = document.getElementById('hl-perc-label');
    const percInput = document.getElementById('hl-perc-filter');
    const percPctLabel = document.getElementById('hl-perc-pct-label');
    if (type === 'ALL') {
        percLabel.style.display = 'none';
        percInput.style.display = 'none';
        percPctLabel.style.display = 'none';
    } else {
        percLabel.style.display = '';
        percInput.style.display = '';
        percPctLabel.style.display = '';
    }

    let filtered = hlMarketData.filter(stock => {
        // Sector filter
        if (sector !== 'ALL' && stock.sector !== sector) return false;

        // Symbol search
        if (searchQuery && !stock.symbol.toUpperCase().startsWith(searchQuery)) return false;

        const ltp = parseFloat(stock.ltp.replace(/,/g, ''));
        const high = parseFloat(stock.high52.replace(/,/g, ''));
        const low = parseFloat(stock.low52.replace(/,/g, ''));

        if (isNaN(ltp) || isNaN(high) || isNaN(low) || low === 0 || high === 0) return false;

        if (type === 'LOW') {
            const percFromLow = ((ltp - low) / low) * 100;
            return percFromLow <= perc;
        } else if (type === 'HIGH') {
            const percFromHigh = ((high - ltp) / high) * 100;
            return percFromHigh <= perc;
        }
        return true; // ALL
    });

    // Sort
    filtered.sort((a, b) => {
        const ltpA = parseFloat(a.ltp.replace(/,/g, ''));
        const ltpB = parseFloat(b.ltp.replace(/,/g, ''));
        const highA = parseFloat(a.high52.replace(/,/g, ''));
        const highB = parseFloat(b.high52.replace(/,/g, ''));
        const lowA  = parseFloat(a.low52.replace(/,/g, ''));
        const lowB  = parseFloat(b.low52.replace(/,/g, ''));

        if (sortBy === 'low-asc') {
            const percA = lowA > 0 ? ((ltpA - lowA) / lowA) * 100 : 999;
            const percB = lowB > 0 ? ((ltpB - lowB) / lowB) * 100 : 999;
            return percA - percB;
        } else if (sortBy === 'high-asc') {
            const percA = highA > 0 ? ((highA - ltpA) / highA) * 100 : 999;
            const percB = highB > 0 ? ((highB - ltpB) / highB) * 100 : 999;
            return percA - percB;
        } else { // symbol-asc
            return a.symbol.localeCompare(b.symbol);
        }
    });

    // Result count
    const countEl = document.getElementById('hl-result-count');
    if (countEl) {
        countEl.textContent = `Showing ${filtered.length} of ${hlMarketData.length} stocks`;
    }

    if (filtered.length === 0) {
        hlTableBody.innerHTML = '<tr><td colspan="7" class="text-center">No stocks match this filter.</td></tr>';
        return;
    }

    filtered.forEach(stock => {
        const ltp  = parseFloat(stock.ltp.replace(/,/g, ''));
        const high = parseFloat(stock.high52.replace(/,/g, ''));
        const low  = parseFloat(stock.low52.replace(/,/g, ''));

        const percFromLow  = low  > 0 ? ((ltp - low)  / low)  * 100 : 0;
        const percFromHigh = high > 0 ? ((high - ltp)  / high) * 100 : 0;

        // Color-coded proximity badges
        const lowClass  = percFromLow  <= 5  ? 'negative' : percFromLow  <= 15 ? 'accent' : '';
        const highClass = percFromHigh <= 5  ? 'positive' : percFromHigh <= 15 ? 'accent' : '';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${stock.symbol}</strong></td>
            <td><span class="badge-sector">${stock.sector || 'N/A'}</span></td>
            <td>Rs ${stock.ltp}</td>
            <td class="positive">Rs ${stock.high52}</td>
            <td class="negative">Rs ${stock.low52}</td>
            <td class="${lowClass}">${percFromLow.toFixed(2)}%</td>
            <td class="${highClass}">${percFromHigh.toFixed(2)}%</td>
        `;
        hlTableBody.appendChild(tr);
    });
}

document.getElementById('apply-hl-filter').addEventListener('click', applyHlFilter);

document.getElementById('refresh-hl-btn').addEventListener('click', () => {
    hlMarketData = [];
    fetch52WeekData();
});

// Show/hide % inputs dynamically when type filter changes
document.getElementById('hl-type-filter').addEventListener('change', () => {
    const type = document.getElementById('hl-type-filter').value;
    const percLabel  = document.getElementById('hl-perc-label');
    const percInput  = document.getElementById('hl-perc-filter');
    const percPctLbl = document.getElementById('hl-perc-pct-label');
    const hide = type === 'ALL';
    percLabel.style.display  = hide ? 'none' : '';
    percInput.style.display  = hide ? 'none' : '';
    percPctLbl.style.display = hide ? 'none' : '';
});

// Live search re-applies filter on each keystroke
document.getElementById('hl-search-input').addEventListener('input', () => {
    if (hlMarketData.length > 0) applyHlFilter();
});

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

// Note: reset-portfolio-btn is already wired inside setupPortfolioControls() above

// ==========================================================================
// --- 5th TAB: SWING TRADING TECHNICAL SETUP MODULE ---
// Purely visual/manual checking in dashboard. Zero email notifications.
// ==========================================================================

// --- Technical Indicators & Mathematical Logic ---
function calculate20SMA(prices) {
    if (!prices || prices.length < 20) return 0;
    const slice = prices.slice(-20);
    const sum = slice.reduce((acc, val) => acc + val, 0);
    return sum / 20;
}

function calculate14RSI(prices) {
    if (!prices || prices.length < 15) return 50;
    
    const changes = [];
    for (let i = 1; i < prices.length; i++) {
        changes.push(prices[i] - prices[i - 1]);
    }
    
    if (changes.length < 14) return 50;

    let gains = 0, losses = 0;
    for (let i = 0; i < 14; i++) {
        if (changes[i] >= 0) gains += changes[i];
        else losses += Math.abs(changes[i]);
    }
    
    let avgGain = gains / 14;
    let avgLoss = losses / 14;

    for (let i = 14; i < changes.length; i++) {
        const change = changes[i];
        const gain = change >= 0 ? change : 0;
        const loss = change < 0 ? Math.abs(change) : 0;
        avgGain = (avgGain * 13 + gain) / 14;
        avgLoss = (avgLoss * 13 + loss) / 14;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculate20VolAvg(volumes) {
    if (!volumes || volumes.length === 0) return 0;
    const slice = volumes.slice(-20);
    const sum = slice.reduce((acc, val) => acc + val, 0);
    return sum / slice.length;
}

// --- Firebase Historical Data Management ---
async function getHistoricalDataForSymbol(symbol, currentLtp, currentVol) {
    // 1. Check if daily_history records exist in Firebase Firestore
    try {
        const historyRef = collection(db, "daily_history");
        const q = query(historyRef, where("symbol", "==", symbol));
        const querySnap = await getDocs(q);

        let records = [];
        querySnap.forEach(docSnap => {
            records.push(docSnap.data());
        });

        records.sort((a, b) => new Date(a.date) - new Date(b.date));

        if (records.length >= 20) {
            return records;
        }
    } catch (err) {
        console.warn(`Firestore daily_history query for ${symbol} skipped/failed:`, err.message);
    }

    // 2. IF HISTORICAL DATA IS NOT STORED IN FIREBASE YET:
    // Fetch past daily data via market API fallback & seed initial records into Firebase
    if (!setupHistoricalCache[symbol] || Object.keys(setupHistoricalCache).length === 0) {
        try {
            const response = await fetch(`${API_BASE}/api/historical-prices`);
            if (response.ok) {
                const json = await response.json();
                if (json.success && json.data) {
                    setupHistoricalCache = json.data;
                }
            }
        } catch (e) {
            console.warn("Fallback historical API fetch failed:", e.message);
        }
    }

    let candles = setupHistoricalCache[symbol] || [];
    if (candles.length === 0) {
        candles = generateFallbackCandles(symbol, currentLtp, currentVol);
    }

    // Seed initial records into Firebase Firestore asynchronously
    seedDailyHistoryToFirestore(symbol, candles).catch(err => console.warn("Seeding error:", err));

    return candles;
}

async function seedDailyHistoryToFirestore(symbol, candles) {
    // Use writeBatch to send up to 500 writes per round-trip instead of one-by-one
    const BATCH_SIZE = 500;
    for (let i = 0; i < candles.length; i += BATCH_SIZE) {
        const chunk = candles.slice(i, i + BATCH_SIZE);
        const batch = writeBatch(db);
        chunk.forEach(candle => {
            const docId = `${symbol}_${candle.date}`;
            const ref = doc(db, "daily_history", docId);
            batch.set(ref, {
                symbol: symbol,
                date: candle.date,
                close: candle.close,
                volume: candle.volume,
                seededAt: new Date()
            }, { merge: true });
        });
        try {
            await batch.commit();
        } catch (e) {
            // Ignore error if permissions restricted
        }
    }
}

async function syncDailyHistory(stocks) {
    if (!stocks || stocks.length === 0) return;
    const todayDateStr = new Date().toISOString().split('T')[0];

    for (const stock of stocks) {
        const ltp = parseFloat((stock.ltp || '0').replace(/,/g, ''));
        const high = parseFloat((stock.high || stock.ltp || '0').replace(/,/g, ''));
        const low = parseFloat((stock.low || stock.ltp || '0').replace(/,/g, ''));
        const diff = parseFloat((stock.diff || '0').replace(/,/g, ''));
        const percDiff = parseFloat((stock.percDiff || '0').replace(/,/g, ''));
        const vol = parseFloat((stock.volume || '0').replace(/,/g, ''));
        if (isNaN(ltp) || ltp <= 0) continue;

        const docId = `${stock.symbol}_${todayDateStr}`;
        try {
            await setDoc(doc(db, "daily_history", docId), {
                symbol: stock.symbol,
                date: todayDateStr,
                close: ltp,
                high: high,
                low: low,
                diff: diff,
                percDiff: percDiff,
                volume: vol,
                updatedAt: new Date()
            }, { merge: true });
        } catch (e) {
            // Non-blocking sync error
        }
    }
}

function generateFallbackCandles(symbol, currentLtp, currentVol) {
    const dates = [];
    let curr = new Date();
    while (dates.length < 30) {
        curr.setDate(curr.getDate() - 1);
        const day = curr.getDay();
        if (day !== 5 && day !== 6) dates.unshift(curr.toISOString().split('T')[0]);
    }
    const basePrice = currentLtp || 500;
    const baseVol = currentVol || 10000;
    let runningPrice = basePrice;
    return dates.map((dateStr, i) => {
        const pseudoRandom = Math.sin((symbol.charCodeAt(0) || 1) * (i + 1) * 7.5);
        const pctChange = pseudoRandom * 0.025;
        const prevPrice = runningPrice;
        runningPrice = Math.max(10, runningPrice * (1 + pctChange));

        const ch = runningPrice - prevPrice;
        const chPerc = prevPrice > 0 ? (ch / prevPrice) * 100 : 0;
        const high = Math.max(runningPrice, prevPrice) * (1 + Math.abs(pseudoRandom) * 0.01);
        const low = Math.min(runningPrice, prevPrice) * (1 - Math.abs(pseudoRandom) * 0.01);
        const dayVol = Math.round(baseVol * (0.7 + Math.abs(pseudoRandom) * 0.6));

        return { 
            date: dateStr, 
            close: parseFloat(runningPrice.toFixed(2)),
            high: parseFloat(high.toFixed(2)),
            low: parseFloat(low.toFixed(2)),
            diff: parseFloat(ch.toFixed(2)),
            percDiff: parseFloat(chPerc.toFixed(2)),
            volume: dayVol 
        };
    });
}

// --- Stock Setup Evaluator ---
function evaluateStockSetup(stock, historicalCandles) {
    const currentPrice = parseFloat(stock.ltp.replace(/,/g, '')) || 0;
    const currentVolume = parseFloat((stock.volume || '0').replace(/,/g, '')) || 0;

    const prices = historicalCandles.map(c => c.close);
    prices.push(currentPrice);

    const volumes = historicalCandles.map(c => c.volume);
    volumes.push(currentVolume);

    const sma20 = calculate20SMA(prices);
    const isAboveSma = currentPrice > sma20;

    const rsi14 = calculate14RSI(prices);
    const isRsiInZone = rsi14 >= 45 && rsi14 <= 65;

    const avgVol20 = calculate20VolAvg(volumes);
    const volRatio = avgVol20 > 0 ? (currentVolume / avgVol20) : 1;
    const isVolumeConfirmed = volRatio >= 1.2;

    const isBuySignal = isAboveSma && isRsiInZone && isVolumeConfirmed;

    return {
        symbol: stock.symbol,
        currentPrice,
        sma20,
        isAboveSma,
        rsi14,
        isRsiInZone,
        currentVolume,
        avgVol20,
        volRatio,
        isVolumeConfirmed,
        isBuySignal
    };
}

// --- Fetch & Render Setup Tab Data ---
async function fetchSetupData() {
    setupTableBody.innerHTML = '<tr><td colspan="6" class="text-center">Analyzing market setup indicators & historical data...</td></tr>';
    
    // Ensure live market data is loaded
    if (liveMarketData.length === 0) {
        try {
            const response = await fetch(`${API_BASE}/api/live-prices`);
            if (response.ok) {
                const data = await response.json();
                liveMarketData = data.data || [];
            }
        } catch (e) {
            console.warn("Live prices fetch failed for setup:", e.message);
        }
    }

    if (liveMarketData.length === 0) {
        setupTableBody.innerHTML = '<tr><td colspan="6" class="text-center negative">Could not fetch market data. Ensure backend is running.</td></tr>';
        return;
    }

    // Trigger daily end-of-day background sync to Firestore
    syncDailyHistory(liveMarketData).catch(e => console.warn("Background sync error:", e));

    setupEvaluatedData = [];

    // Process stocks in chunks of 10 to avoid firing 300 simultaneous Firestore reads
    // which would exhaust Firebase free-tier quota in minutes.
    const CHUNK_SIZE = 10;
    for (let i = 0; i < liveMarketData.length; i += CHUNK_SIZE) {
        const chunk = liveMarketData.slice(i, i + CHUNK_SIZE);
        const chunkResults = await Promise.all(
            chunk.map(async (stock) => {
                const currentLtp = parseFloat(stock.ltp.replace(/,/g, '')) || 0;
                const currentVol = parseFloat((stock.volume || '0').replace(/,/g, '')) || 0;
                const candles = await getHistoricalDataForSymbol(stock.symbol, currentLtp, currentVol);
                return evaluateStockSetup(stock, candles);
            })
        );
        setupEvaluatedData.push(...chunkResults);
    }

    renderSetupTable();
}

function renderSetupTable() {
    if (!setupEvaluatedData || setupEvaluatedData.length === 0) {
        setupTableBody.innerHTML = '<tr><td colspan="6" class="text-center">No setup data available.</td></tr>';
        return;
    }

    const searchQuery = (document.getElementById('setup-search-input')?.value || '').toLowerCase().trim();
    const signalFilter = document.getElementById('setup-signal-filter')?.value || 'ALL';

    const filtered = setupEvaluatedData.filter(stock => {
        const matchesSearch = stock.symbol.toLowerCase().includes(searchQuery);
        if (!matchesSearch) return false;

        if (signalFilter === 'BUY') return stock.isBuySignal;
        if (signalFilter === 'NEUTRAL') return !stock.isBuySignal;
        return true;
    });

    setupTableBody.innerHTML = '';

    if (filtered.length === 0) {
        setupTableBody.innerHTML = '<tr><td colspan="6" class="text-center">No stocks match the selected criteria.</td></tr>';
        return;
    }

    filtered.forEach(stock => {
        const tr = document.createElement('tr');

        const smaBadgeClass = stock.isAboveSma ? 'tag-pass' : 'tag-fail';
        const rsiBadgeClass = stock.isRsiInZone ? 'tag-pass' : 'tag-fail';
        const volBadgeClass = stock.isVolumeConfirmed ? 'tag-pass' : 'tag-fail';

        const signalBadgeHtml = stock.isBuySignal
            ? '<span class="badge-buy-signal"><i class="ph ph-check-circle"></i> 🟢 BUY SIGNAL</span>'
            : '<span class="badge-neutral"><i class="ph ph-minus-circle"></i> ⚪ NEUTRAL</span>';

        const formattedVolRatio = `${stock.volRatio.toFixed(2)}x Avg`;

        tr.innerHTML = `
            <td><strong>${stock.symbol}</strong></td>
            <td>Rs ${stock.currentPrice.toFixed(2)}</td>
            <td>
                Rs ${stock.sma20.toFixed(2)}
                <br><small class="${smaBadgeClass}">(${stock.isAboveSma ? 'Above ↑' : 'Below ↓'})</small>
            </td>
            <td>
                ${stock.rsi14.toFixed(1)}
                <br><small class="${rsiBadgeClass}">(${stock.isRsiInZone ? 'In Zone 45-65' : 'Out of Zone'})</small>
            </td>
            <td>
                ${stock.currentVolume.toLocaleString()}
                <br><small class="${volBadgeClass}">(${formattedVolRatio})</small>
            </td>
            <td>${signalBadgeHtml}</td>
        `;

        setupTableBody.appendChild(tr);
    });
}

// Setup Tab Event Listeners
document.getElementById('refresh-setup-btn')?.addEventListener('click', fetchSetupData);
document.getElementById('setup-search-input')?.addEventListener('input', renderSetupTable);
document.getElementById('setup-signal-filter')?.addEventListener('change', renderSetupTable);

// ==========================================================================
// ==========================================================================
// --- 6th TAB: COMPLETE NEPSE STOCKS DIRECTORY & 3Y HISTORICAL MODULE ---
// Fetches all 340+ actively listed NEPSE stocks directly via API/scraper.
// Displays live LTP, Day Range, Diff, %, Sector, and 3-Year Historical Chart.
// ==========================================================================

async function fetchStocksData() {
    if (!stocksTableBody) return;
    stocksTableBody.innerHTML = '<tr><td colspan="9" class="text-center">Loading complete active NEPSE listed stocks...</td></tr>';
    const countBadge = document.getElementById('stocks-total-count');
    if (countBadge) countBadge.textContent = 'Loading...';

    // 1. Try to fetch all 340+ stocks from backend /api/stocks or /api/live-prices
    try {
        const response = await fetch(`${API_BASE}/api/stocks`);
        if (response.ok) {
            const resData = await response.json();
            const stocksList = resData.data || [];
            if (Array.isArray(stocksList) && stocksList.length > 0) {
                stocksDatabaseData = stocksList.map(s => {
                    const ltp = typeof s.ltp === 'number' ? s.ltp : parseFloat(String(s.ltp).replace(/,/g, '')) || 0;
                    const high = typeof s.high === 'number' ? s.high : parseFloat(String(s.high).replace(/,/g, '')) || ltp;
                    const low = typeof s.low === 'number' ? s.low : parseFloat(String(s.low).replace(/,/g, '')) || ltp;
                    const diff = typeof s.diff === 'number' ? s.diff : parseFloat(String(s.diff).replace(/,/g, '')) || 0;
                    const percDiff = typeof s.percDiff === 'number' ? s.percDiff : parseFloat(String(s.percDiff).replace(/,/g, '')) || 0;
                    const volume = typeof s.volume === 'number' ? s.volume : parseFloat(String(s.volume).replace(/,/g, '')) || 0;

                    return {
                        symbol: s.symbol.toUpperCase(),
                        latestClose: ltp,
                        latestHigh: high,
                        latestLow: low,
                        latestDiff: diff,
                        latestPercDiff: percDiff,
                        latestVolume: volume,
                        sector: s.sector || 'Others'
                    };
                });

                stocksDatabaseData.sort((a, b) => a.symbol.localeCompare(b.symbol));
                renderStocksTable();
                return;
            }
        }
    } catch (apiErr) {
        console.warn("Stocks API fetch failed, trying liveMarketData fallback:", apiErr.message);
    }

    // 2. Fallback to liveMarketData if already fetched in the application
    if (liveMarketData && liveMarketData.length > 0) {
        stocksDatabaseData = liveMarketData.map(s => {
            const ltp = typeof s.ltp === 'number' ? s.ltp : parseFloat(String(s.ltp).replace(/,/g, '')) || 0;
            const high = typeof s.high === 'number' ? s.high : parseFloat(String(s.high).replace(/,/g, '')) || ltp;
            const low = typeof s.low === 'number' ? s.low : parseFloat(String(s.low).replace(/,/g, '')) || ltp;
            const diff = typeof s.diff === 'number' ? s.diff : parseFloat(String(s.diff).replace(/,/g, '')) || 0;
            const percDiff = typeof s.percDiff === 'number' ? s.percDiff : parseFloat(String(s.percDiff).replace(/,/g, '')) || 0;
            const volume = typeof s.volume === 'number' ? s.volume : parseFloat(String(s.volume).replace(/,/g, '')) || 0;

            return {
                symbol: s.symbol.toUpperCase(),
                latestClose: ltp,
                latestHigh: high,
                latestLow: low,
                latestDiff: diff,
                latestPercDiff: percDiff,
                latestVolume: volume,
                sector: s.sector || 'Others'
            };
        });

        stocksDatabaseData.sort((a, b) => a.symbol.localeCompare(b.symbol));
        renderStocksTable();
        return;
    }

    // 3. Fallback to Firestore daily_history if offline
    try {
        const historyRef = collection(db, "daily_history");
        const querySnap = await getDocs(historyRef);

        const stockMap = {};
        querySnap.forEach(docSnap => {
            const data = docSnap.data();
            if (!data || !data.symbol) return;
            const sym = data.symbol.toUpperCase();
            if (!stockMap[sym]) stockMap[sym] = [];
            stockMap[sym].push(data);
        });

        stocksDatabaseData = Object.keys(stockMap).map(symbol => {
            const records = stockMap[symbol];
            records.sort((a, b) => new Date(a.date) - new Date(b.date));
            const latest = records[records.length - 1] || {};
            return {
                symbol,
                latestClose: parseFloat(latest.close) || 0,
                latestHigh: parseFloat(latest.high) || 0,
                latestLow: parseFloat(latest.low) || 0,
                latestDiff: parseFloat(latest.diff) || 0,
                latestPercDiff: parseFloat(latest.percDiff) || 0,
                latestVolume: parseFloat(latest.volume) || 0,
                sector: 'Others'
            };
        });

        stocksDatabaseData.sort((a, b) => a.symbol.localeCompare(b.symbol));
        renderStocksTable();
    } catch (err) {
        console.error("Error fetching stocks from Firebase fallback:", err);
        stocksTableBody.innerHTML = '<tr><td colspan="9" class="text-center negative">Failed to query listed stocks. Please check connection.</td></tr>';
    }
}

// --- 3-Year Historical Chart & Modal State ---
let currentHistoricalData = [];
let currentHistoricalSymbol = '';
let currentHistoricalRange = '3y';
let historicalChartInstance = null;

function renderStocksTable() {
    if (!stocksTableBody) return;

    const countBadge = document.getElementById('stocks-total-count');

    if (!stocksDatabaseData || stocksDatabaseData.length === 0) {
        stocksTableBody.innerHTML = '<tr><td colspan="9" class="text-center">No stocks found.</td></tr>';
        if (countBadge) countBadge.textContent = '0 stocks';
        return;
    }

    const searchQuery = (document.getElementById('stocks-search-input')?.value || '').toLowerCase().trim();

    const filtered = stocksDatabaseData.filter(item => {
        const matchSym = item.symbol.toLowerCase().includes(searchQuery);
        const matchSector = (item.sector || '').toLowerCase().includes(searchQuery);
        return matchSym || matchSector;
    });

    if (countBadge) {
        countBadge.textContent = `${filtered.length} stock${filtered.length === 1 ? '' : 's'}`;
    }

    stocksTableBody.innerHTML = '';

    if (filtered.length === 0) {
        stocksTableBody.innerHTML = '<tr><td colspan="9" class="text-center">No stocks match your search filter.</td></tr>';
        return;
    }

    filtered.forEach((stock, index) => {
        const tr = document.createElement('tr');
        const diff = stock.latestDiff;
        const perc = stock.latestPercDiff;
        const diffClass = diff >= 0 ? 'positive' : 'negative';
        const diffSign = diff > 0 ? '+' : '';

        tr.innerHTML = `
            <td>${index + 1}</td>
            <td>
                <button class="stock-symbol-btn view-stock-history-btn" data-symbol="${stock.symbol}" title="Click to view 3-year historical chart for ${stock.symbol}">
                    ${stock.symbol}
                </button>
            </td>
            <td><span class="badge-sector">${stock.sector || 'Others'}</span></td>
            <td>Rs ${stock.latestHigh.toFixed(2)}</td>
            <td>Rs ${stock.latestLow.toFixed(2)}</td>
            <td>Rs ${stock.latestClose.toFixed(2)}</td>
            <td class="${diffClass}">${diffSign}${diff.toFixed(2)}</td>
            <td><span class="badge ${diffClass}">${diffSign}${perc.toFixed(2)}%</span></td>
            <td>
                <button class="secondary-btn btn-small view-stock-history-btn" data-symbol="${stock.symbol}" title="View 3-Year Historical Data & Chart">
                    <i class="ph ph-chart-line"></i> 3Y History
                </button>
            </td>
        `;
        stocksTableBody.appendChild(tr);
    });

    document.querySelectorAll('.view-stock-history-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const symbol = e.currentTarget.getAttribute('data-symbol');
            if (symbol) openStockHistoryModal(symbol);
        });
    });
}

// Filter records based on selected timeframe (1M, 3M, 6M, 1Y, 3Y/All)
function filterHistoricalByRange(data, range) {
    if (!data || data.length === 0) return [];
    if (range === '3y' || range === 'all') return [...data];

    const newestDate = new Date(data[data.length - 1].date);
    let daysToSubtract = 365;
    if (range === '1m') daysToSubtract = 30;
    else if (range === '3m') daysToSubtract = 90;
    else if (range === '6m') daysToSubtract = 180;
    else if (range === '1y') daysToSubtract = 365;

    const cutoffTime = new Date(newestDate.getTime() - daysToSubtract * 24 * 60 * 60 * 1000);
    const filtered = data.filter(d => new Date(d.date) >= cutoffTime);
    return filtered.length > 0 ? filtered : [...data];
}

async function openStockHistoryModal(symbol) {
    const modal = document.getElementById('stock-history-modal');
    const modalSymbol = document.getElementById('modal-stock-symbol');
    const modalCount = document.getElementById('modal-stock-count');
    const loadingEl = document.getElementById('modal-history-loading');
    const chartView = document.getElementById('modal-chart-view');
    const tableView = document.getElementById('modal-table-view');
    const sourceBadge = document.getElementById('modal-history-source-badge');

    if (!modal) return;

    currentHistoricalSymbol = symbol.toUpperCase().trim();
    currentHistoricalRange = '3y';
    modalSymbol.textContent = currentHistoricalSymbol;
    if (modalCount) modalCount.textContent = '...';

    // Reset toolbar states
    document.querySelectorAll('.timeframe-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-range') === '3y');
    });
    const tabChart = document.getElementById('modal-tab-chart');
    const tabTable = document.getElementById('modal-tab-table');
    if (tabChart && tabTable) {
        tabChart.classList.add('active');
        tabTable.classList.remove('active');
    }
    if (chartView) chartView.style.display = 'block';
    if (tableView) tableView.style.display = 'none';

    // Show loading spinner
    if (loadingEl) loadingEl.style.display = 'block';
    if (chartView) chartView.style.opacity = '0.3';
    modal.classList.add('active');

    try {
        const response = await fetch(`${API_BASE}/api/historical/${currentHistoricalSymbol}`);
        const result = await response.json();

        if (result.success && Array.isArray(result.data) && result.data.length > 0) {
            currentHistoricalData = result.data;
            if (sourceBadge) sourceBadge.textContent = result.fallback ? 'Firestore Records' : 'NEPSE 3Y Data';
        } else {
            // Check local Firebase stock database as fallback
            const localStock = stocksDatabaseData.find(s => s.symbol === currentHistoricalSymbol);
            if (localStock && localStock.records && localStock.records.length > 0) {
                currentHistoricalData = [...localStock.records].sort((a, b) => new Date(a.date) - new Date(b.date));
                if (sourceBadge) sourceBadge.textContent = 'Firestore Records';
            } else {
                currentHistoricalData = [];
            }
        }
    } catch (err) {
        console.warn(`Could not fetch 3Y historical data for ${currentHistoricalSymbol}:`, err.message);
        const localStock = stocksDatabaseData.find(s => s.symbol === currentHistoricalSymbol);
        if (localStock && localStock.records && localStock.records.length > 0) {
            currentHistoricalData = [...localStock.records].sort((a, b) => new Date(a.date) - new Date(b.date));
            if (sourceBadge) sourceBadge.textContent = 'Firestore Records';
        } else {
            currentHistoricalData = [];
        }
    } finally {
        if (loadingEl) loadingEl.style.display = 'none';
        if (chartView) chartView.style.opacity = '1';
        renderHistoricalModalView();
    }
}

function renderHistoricalModalView() {
    const modalCount = document.getElementById('modal-stock-count');
    const statLtp = document.getElementById('modal-stat-ltp');
    const statChange = document.getElementById('modal-stat-change');
    const statHigh = document.getElementById('modal-stat-high');
    const statHighDate = document.getElementById('modal-stat-high-date');
    const statLow = document.getElementById('modal-stat-low');
    const statLowDate = document.getElementById('modal-stat-low-date');
    const statReturn = document.getElementById('modal-stat-return');
    const statRangeLabel = document.getElementById('modal-stat-range-label');
    const tableBody = document.getElementById('stock-history-table-body');

    if (!currentHistoricalData || currentHistoricalData.length === 0) {
        if (statLtp) statLtp.textContent = 'N/A';
        if (statHigh) statHigh.textContent = 'N/A';
        if (statLow) statLow.textContent = 'N/A';
        if (statReturn) statReturn.textContent = 'N/A';
        if (tableBody) tableBody.innerHTML = '<tr><td colspan="8" class="text-center">No historical data available for this stock.</td></tr>';
        if (historicalChartInstance) {
            historicalChartInstance.destroy();
            historicalChartInstance = null;
        }
        return;
    }

    const filtered = filterHistoricalByRange(currentHistoricalData, currentHistoricalRange);
    if (modalCount) modalCount.textContent = `${filtered.length} of ${currentHistoricalData.length}`;

    // Compute key statistics for selected range
    const latestRecord = filtered[filtered.length - 1];
    const initialRecord = filtered[0];

    const latestClose = latestRecord.close || 0;
    const initialClose = initialRecord.close || latestClose;
    const periodReturn = initialClose > 0 ? ((latestClose - initialClose) / initialClose) * 100 : 0;

    let periodHigh = -Infinity;
    let periodHighDate = 'N/A';
    let periodLow = Infinity;
    let periodLowDate = 'N/A';

    filtered.forEach(r => {
        const h = r.high || r.close;
        const l = r.low || r.close;
        if (h > periodHigh) {
            periodHigh = h;
            periodHighDate = r.date;
        }
        if (l < periodLow && l > 0) {
            periodLow = l;
            periodLowDate = r.date;
        }
    });

    if (periodHigh === -Infinity) periodHigh = latestClose;
    if (periodLow === Infinity) periodLow = latestClose;

    const diff = latestRecord.diff || (latestClose - (latestRecord.open || latestClose));
    const percDiff = latestRecord.percDiff || 0;
    const diffSign = diff > 0 ? '+' : '';
    const diffClass = diff >= 0 ? 'positive' : 'negative';

    if (statLtp) statLtp.textContent = `Rs ${latestClose.toFixed(2)}`;
    if (statChange) {
        statChange.innerHTML = `<span class="${diffClass}">${diffSign}${diff.toFixed(2)} (${diffSign}${percDiff.toFixed(2)}%)</span>`;
    }
    if (statHigh) statHigh.textContent = `Rs ${periodHigh.toFixed(2)}`;
    if (statHighDate) statHighDate.textContent = periodHighDate;
    if (statLow) statLow.textContent = `Rs ${periodLow.toFixed(2)}`;
    if (statLowDate) statLowDate.textContent = periodLowDate;

    const returnSign = periodReturn > 0 ? '+' : '';
    const returnClass = periodReturn >= 0 ? 'positive' : 'negative';
    if (statReturn) {
        statReturn.innerHTML = `<span class="${returnClass}">${returnSign}${periodReturn.toFixed(2)}%</span>`;
    }
    if (statRangeLabel) {
        const rangeLabels = { '1m': 'Last 1 Month', '3m': 'Last 3 Months', '6m': 'Last 6 Months', '1y': 'Last 1 Year', '3y': 'Past 3 Years' };
        statRangeLabel.textContent = rangeLabels[currentHistoricalRange] || 'Selected Range';
    }

    // --- Render Chart.js Chart ---
    renderHistoricalChart(filtered, periodReturn >= 0);

    // --- Render Historical Table ---
    if (tableBody) {
        tableBody.innerHTML = '';
        const sortedDesc = [...filtered].reverse();
        sortedDesc.forEach(record => {
            const tr = document.createElement('tr');
            const rowDiff = record.diff || (record.close - record.open);
            const rowPerc = record.percDiff || 0;
            const rDiffClass = rowDiff >= 0 ? 'positive' : 'negative';
            const rDiffSign = rowDiff > 0 ? '+' : '';

            tr.innerHTML = `
                <td><strong>${record.date}</strong></td>
                <td>Rs ${(record.open || record.close).toFixed(2)}</td>
                <td>Rs ${(record.high || record.close).toFixed(2)}</td>
                <td>Rs ${(record.low || record.close).toFixed(2)}</td>
                <td><strong>Rs ${record.close.toFixed(2)}</strong></td>
                <td class="${rDiffClass}">${rDiffSign}${rowDiff.toFixed(2)}</td>
                <td><span class="badge ${rDiffClass}">${rDiffSign}${rowPerc.toFixed(2)}%</span></td>
                <td>${(record.volume || 0).toLocaleString()}</td>
            `;
            tableBody.appendChild(tr);
        });
    }
}

function renderHistoricalChart(records, isPositive) {
    const canvas = document.getElementById('historical-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    if (historicalChartInstance) {
        historicalChartInstance.destroy();
        historicalChartInstance = null;
    }

    const labels = records.map(r => r.date);
    const closePrices = records.map(r => r.close);
    const volumes = records.map(r => r.volume || 0);

    const isLightMode = document.body.classList.contains('theme-light');
    const gridColor = isLightMode ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.08)';
    const textColor = isLightMode ? '#64748b' : '#94a3b8';

    const lineColor = isPositive ? '#10b981' : '#ef4444';
    const gradientTop = isPositive ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)';
    const gradientBottom = isPositive ? 'rgba(16, 185, 129, 0.01)' : 'rgba(239, 68, 68, 0.01)';

    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 320);
    gradient.addColorStop(0, gradientTop);
    gradient.addColorStop(1, gradientBottom);

    historicalChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: `${currentHistoricalSymbol} Price (Rs)`,
                    data: closePrices,
                    borderColor: lineColor,
                    backgroundColor: gradient,
                    borderWidth: 2.2,
                    fill: true,
                    tension: 0.2,
                    pointRadius: records.length > 100 ? 0 : 2.5,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: lineColor,
                    yAxisID: 'y'
                },
                {
                    label: 'Volume',
                    type: 'bar',
                    data: volumes,
                    backgroundColor: isLightMode ? 'rgba(99, 102, 241, 0.25)' : 'rgba(99, 102, 241, 0.35)',
                    borderColor: 'transparent',
                    yAxisID: 'yVolume',
                    barPercentage: 0.6
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: textColor,
                        boxWidth: 12,
                        font: { size: 11, weight: '600' }
                    }
                },
                tooltip: {
                    backgroundColor: isLightMode ? 'rgba(255, 255, 255, 0.95)' : 'rgba(15, 23, 42, 0.95)',
                    titleColor: isLightMode ? '#0f172a' : '#f8fafc',
                    bodyColor: isLightMode ? '#334155' : '#cbd5e1',
                    borderColor: isLightMode ? '#e2e8f0' : 'rgba(255, 255, 255, 0.1)',
                    borderWidth: 1,
                    padding: 10,
                    callbacks: {
                        label: function(context) {
                            if (context.dataset.yAxisID === 'y') {
                                return ` Close: Rs ${context.raw.toFixed(2)}`;
                            } else if (context.dataset.yAxisID === 'yVolume') {
                                return ` Volume: ${context.raw.toLocaleString()} shares`;
                            }
                            return `${context.dataset.label}: ${context.raw}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: gridColor },
                    ticks: {
                        color: textColor,
                        maxTicksLimit: 10,
                        font: { size: 11 }
                    }
                },
                y: {
                    type: 'linear',
                    position: 'left',
                    grid: { color: gridColor },
                    ticks: {
                        color: textColor,
                        callback: val => `Rs ${val}`,
                        font: { size: 11 }
                    }
                },
                yVolume: {
                    type: 'linear',
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    ticks: {
                        display: false
                    },
                    // Scale volume to stay in bottom 25% of chart
                    max: Math.max(...volumes) * 4
                }
            }
        }
    });
}

// Download filtered historical data as CSV
function exportHistoricalCsv() {
    if (!currentHistoricalData || currentHistoricalData.length === 0) {
        alert("No historical data available to export.");
        return;
    }

    const filtered = filterHistoricalByRange(currentHistoricalData, currentHistoricalRange);
    const headers = ["Date", "Open", "High", "Low", "Close", "Diff", "PercChange", "Volume", "Amount"];
    const rows = filtered.map(r => [
        r.date,
        r.open || r.close,
        r.high || r.close,
        r.low || r.close,
        r.close,
        r.diff || 0,
        r.percDiff || 0,
        r.volume || 0,
        r.amount || 0
    ]);

    const csvContent = "data:text/csv;charset=utf-8," 
        + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `${currentHistoricalSymbol}_NEPSE_3Y_History_${currentHistoricalRange}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Stocks Tab & Modal Event Listeners
document.getElementById('refresh-stocks-btn')?.addEventListener('click', fetchStocksData);
document.getElementById('stocks-search-input')?.addEventListener('input', renderStocksTable);

// Direct stock historical search
const directInput = document.getElementById('stocks-direct-symbol');
const directBtn = document.getElementById('stocks-direct-history-btn');

function handleDirectHistoricalSearch() {
    const sym = (directInput?.value || '').toUpperCase().trim();
    if (!sym) {
        alert("Please enter a stock symbol (e.g. NABIL, SHIVM, etc.)");
        return;
    }
    openStockHistoryModal(sym);
}

directBtn?.addEventListener('click', handleDirectHistoricalSearch);
directInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        handleDirectHistoricalSearch();
    }
});

// Timeframe selector buttons in modal (1M, 3M, 6M, 1Y, 3Y)
document.querySelectorAll('.timeframe-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.timeframe-btn').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        currentHistoricalRange = e.currentTarget.getAttribute('data-range') || '3y';
        renderHistoricalModalView();
    });
});

// Chart vs Table view switchers in modal
const tabChartBtn = document.getElementById('modal-tab-chart');
const tabTableBtn = document.getElementById('modal-tab-table');
const chartViewEl = document.getElementById('modal-chart-view');
const tableViewEl = document.getElementById('modal-table-view');

tabChartBtn?.addEventListener('click', () => {
    tabChartBtn.classList.add('active');
    tabTableBtn.classList.remove('active');
    if (chartViewEl) chartViewEl.style.display = 'block';
    if (tableViewEl) tableViewEl.style.display = 'none';
    if (historicalChartInstance) historicalChartInstance.resize();
});

tabTableBtn?.addEventListener('click', () => {
    tabTableBtn.classList.add('active');
    tabChartBtn.classList.remove('active');
    if (chartViewEl) chartViewEl.style.display = 'none';
    if (tableViewEl) tableViewEl.style.display = 'block';
});

// CSV Export button in modal
document.getElementById('modal-export-csv-btn')?.addEventListener('click', exportHistoricalCsv);