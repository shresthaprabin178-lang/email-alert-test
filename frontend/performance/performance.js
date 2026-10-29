/**
 * Trading Performance & Analytics Module
 * Location: frontend/performance/performance.js
 * 
 * Analyzes trade history, calculates positive (winning) vs negative (losing) trades,
 * computes professional trading metrics (Win Rate, Profit Factor, Expectancy),
 * and renders interactive, visually appealing Chart.js visual graphs.
 */

// Module state
let perfTransactions = [];
let perfLiveMarket = [];
let perfActiveFilter = 'all'; // 'all', 'win', 'loss', 'even'
let perfActiveTimeframe = 'all'; // 'all', 'month', '30d', 'year'
let perfSearchQuery = '';
let perfSortBy = 'date-desc';
let perfViewMode = 'closed'; // 'closed' or 'open'

// Chart instances
let donutChartInstance = null;
let equityChartInstance = null;
let pnlBarsChartInstance = null;

/**
 * Initialize Performance module
 */
export function initPerformanceModule() {
    setupPerformanceEventListeners();
}

/**
 * Update performance data when transactions or live market prices change
 */
export function updatePerformanceData(transactions, liveMarket) {
    perfTransactions = Array.isArray(transactions) ? transactions : [];
    perfLiveMarket = Array.isArray(liveMarket) ? liveMarket : [];
    renderPerformanceView();
}

/**
 * Notify module of theme changes to adapt chart colors
 */
export function refreshPerformanceTheme() {
    renderPerformanceView();
}

// Make accessible on window for convenience
if (typeof window !== 'undefined') {
    window.PerformanceModule = {
        init: initPerformanceModule,
        update: updatePerformanceData,
        refreshTheme: refreshPerformanceTheme,
        setFilter: (filter) => {
            perfActiveFilter = filter;
            renderPerformanceView();
        },
        setTimeframe: (tf) => {
            perfActiveTimeframe = tf;
            renderPerformanceView();
        },
        setViewMode: (mode) => {
            perfViewMode = mode;
            renderPerformanceView();
        }
    };
}

/**
 * Reconstruct closed round-trip trades from transactions
 */
export function calculateClosedTrades(rawTransactions) {
    if (!rawTransactions || rawTransactions.length === 0) return [];

    // Clone and sort chronologically (oldest first)
    const txList = [...rawTransactions].sort((a, b) => {
        const timeA = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : (new Date(a.dateString || a.createdAt || 0)).getTime();
        const timeB = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : (new Date(b.dateString || b.createdAt || 0)).getTime();
        return timeA - timeB;
    });

    const holdingsMap = {};
    const closedTrades = [];

    txList.forEach((tx, idx) => {
        const symbol = String(tx.symbol || '').toUpperCase().trim();
        if (!symbol) return;

        const txType = (tx.type || 'BUY').toUpperCase();
        const txQty = parseInt(tx.qty, 10) || 0;
        const txPrice = parseFloat(tx.price) || 0;
        const txDate = tx.createdAt?.toDate ? tx.createdAt.toDate() : new Date(tx.dateString || tx.createdAt || Date.now());

        if (!holdingsMap[symbol]) {
            holdingsMap[symbol] = {
                qty: 0,
                invested: 0,
                wacc: 0,
                buyLots: [] // { date, qty, price, wacc }
            };
        }

        const h = holdingsMap[symbol];

        if (txType === 'BUY' || txType === 'BONUS') {
            const currentTotal = h.qty * h.wacc;
            const newTxValue = txQty * (parseFloat(tx.wacc) || txPrice);
            h.qty += txQty;
            h.wacc = h.qty > 0 ? (currentTotal + newTxValue) / h.qty : 0;
            h.invested = h.qty * h.wacc;

            h.buyLots.push({
                date: txDate,
                qty: txQty,
                price: txPrice,
                wacc: parseFloat(tx.wacc) || txPrice
            });
        } else if (txType === 'SELL') {
            // A SELL execution constitutes a closed trade!
            const sellQty = txQty;
            const entryWacc = parseFloat(tx.wacc) || (h.wacc > 0 ? h.wacc : txPrice);
            const totalCostBasis = sellQty * entryWacc;
            const grossProceeds = sellQty * txPrice;

            // Determine Net Proceeds after Broker Commission, SEBON fee, DP fee, CGT
            let netProceeds = 0;
            if (tx.netReceivable !== undefined && tx.netReceivable !== null && !isNaN(parseFloat(tx.netReceivable)) && parseFloat(tx.netReceivable) > 0) {
                netProceeds = parseFloat(tx.netReceivable);
            } else {
                // Calculate NEPSE fees accurately if not stored
                netProceeds = calculateNepseSellReceivable(sellQty, txPrice, entryWacc);
            }

            const netProfit = netProceeds - totalCostBasis;
            const returnPerc = totalCostBasis > 0 ? (netProfit / totalCostBasis) * 100 : 0;

            // Determine Trade Status
            let status = 'WIN';
            if (netProfit < -0.01) {
                status = 'LOSS';
            } else if (Math.abs(netProfit) <= 0.01) {
                status = 'BREAKEVEN';
            }

            // Estimate holding duration from FIFO buy lots
            let holdingDays = 0;
            if (h.buyLots.length > 0) {
                const earliestBuy = h.buyLots[0];
                const diffMs = txDate.getTime() - earliestBuy.date.getTime();
                holdingDays = Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
            }

            closedTrades.push({
                id: tx.id || `trade-${idx}`,
                tradeNumber: closedTrades.length + 1,
                symbol,
                date: txDate,
                qty: sellQty,
                entryPrice: entryWacc,
                exitPrice: txPrice,
                costBasis: totalCostBasis,
                grossProceeds,
                netProceeds,
                netProfit,
                returnPerc,
                status,
                cgtPaid: parseFloat(tx.cgtPaid) || 0,
                holdingDays,
                rawTx: tx
            });

            // Update remaining inventory & buy lots
            let remainingToSell = sellQty;
            while (h.buyLots.length > 0 && remainingToSell > 0) {
                const lot = h.buyLots[0];
                if (lot.qty <= remainingToSell) {
                    remainingToSell -= lot.qty;
                    h.buyLots.shift();
                } else {
                    lot.qty -= remainingToSell;
                    remainingToSell = 0;
                }
            }

            h.qty = Math.max(0, h.qty - sellQty);
            h.invested = h.qty * h.wacc;
            if (h.qty === 0) {
                h.wacc = 0;
                h.buyLots = [];
            }
        }
    });

    return closedTrades;
}

/**
 * Standard NEPSE exit calculations helper
 */
function calculateNepseSellReceivable(qty, price, wacc) {
    const gross = qty * price;
    let brokerComm = 0;
    if (gross <= 50000) brokerComm = Math.max(10, gross * 0.0036);
    else if (gross <= 500000) brokerComm = gross * 0.0033;
    else if (gross <= 2000000) brokerComm = gross * 0.0031;
    else if (gross <= 10000000) brokerComm = gross * 0.0027;
    else brokerComm = gross * 0.0024;

    const sebon = gross * 0.00015;
    const dp = 25;
    const grossReceivable = gross - (brokerComm + sebon + dp);
    const profit = grossReceivable - (qty * wacc);

    let cgt = 0;
    if (profit > 0) {
        cgt = profit * 0.075; // Default short-term 7.5%
    }
    return Math.max(0, grossReceivable - cgt);
}

/**
 * Filter trades based on user criteria
 */
function filterTrades(trades) {
    const now = new Date();

    return trades.filter(t => {
        // Status filter
        if (perfActiveFilter === 'win' && t.status !== 'WIN') return false;
        if (perfActiveFilter === 'loss' && t.status !== 'LOSS') return false;
        if (perfActiveFilter === 'even' && t.status !== 'BREAKEVEN') return false;

        // Search query
        if (perfSearchQuery && !t.symbol.includes(perfSearchQuery)) return false;

        // Timeframe filter
        if (perfActiveTimeframe !== 'all') {
            const tradeDate = new Date(t.date);
            if (perfActiveTimeframe === '30d') {
                const diffDays = (now - tradeDate) / (1000 * 60 * 60 * 24);
                if (diffDays > 30) return false;
            } else if (perfActiveTimeframe === 'month') {
                if (tradeDate.getMonth() !== now.getMonth() || tradeDate.getFullYear() !== now.getFullYear()) return false;
            } else if (perfActiveTimeframe === 'year') {
                if (tradeDate.getFullYear() !== now.getFullYear()) return false;
            }
        }

        return true;
    });
}

/**
 * Calculate detailed aggregate analytics from closed trades
 */
export function computePerformanceMetrics(trades) {
    const totalTrades = trades.length;
    const positiveTrades = trades.filter(t => t.status === 'WIN');
    const negativeTrades = trades.filter(t => t.status === 'LOSS');
    const breakevenTrades = trades.filter(t => t.status === 'BREAKEVEN');

    const winCount = positiveTrades.length;
    const lossCount = negativeTrades.length;
    const evenCount = breakevenTrades.length;

    const winRate = totalTrades > 0 ? (winCount / totalTrades) * 100 : 0;
    const lossRate = totalTrades > 0 ? (lossCount / totalTrades) * 100 : 0;

    const totalWonAmount = positiveTrades.reduce((sum, t) => sum + t.netProfit, 0);
    const totalLostAmount = Math.abs(negativeTrades.reduce((sum, t) => sum + t.netProfit, 0));
    const netRealizedPL = totalWonAmount - totalLostAmount;

    const profitFactor = totalLostAmount > 0 
        ? (totalWonAmount / totalLostAmount) 
        : (totalWonAmount > 0 ? 99.0 : 0);

    const avgTradePL = totalTrades > 0 ? (netRealizedPL / totalTrades) : 0;
    const avgWin = winCount > 0 ? (totalWonAmount / winCount) : 0;
    const avgLoss = lossCount > 0 ? (totalLostAmount / lossCount) : 0;
    const riskRewardRatio = avgLoss > 0 ? (avgWin / avgLoss) : 0;

    // Best & Worst trades
    let bestTrade = null;
    let worstTrade = null;
    if (totalTrades > 0) {
        bestTrade = [...trades].sort((a, b) => b.netProfit - a.netProfit)[0];
        worstTrade = [...trades].sort((a, b) => a.netProfit - b.netProfit)[0];
    }

    // Symbol Breakdown (Leaderboard)
    const symbolMap = {};
    trades.forEach(t => {
        if (!symbolMap[t.symbol]) {
            symbolMap[t.symbol] = {
                symbol: t.symbol,
                tradesCount: 0,
                wins: 0,
                losses: 0,
                netPL: 0
            };
        }
        symbolMap[t.symbol].tradesCount++;
        symbolMap[t.symbol].netPL += t.netProfit;
        if (t.status === 'WIN') symbolMap[t.symbol].wins++;
        if (t.status === 'LOSS') symbolMap[t.symbol].losses++;
    });

    const symbolLeaderboard = Object.values(symbolMap).sort((a, b) => b.netPL - a.netPL);

    return {
        totalTrades,
        winCount,
        lossCount,
        evenCount,
        winRate,
        lossRate,
        totalWonAmount,
        totalLostAmount,
        netRealizedPL,
        profitFactor,
        avgTradePL,
        avgWin,
        avgLoss,
        riskRewardRatio,
        bestTrade,
        worstTrade,
        symbolLeaderboard
    };
}

/**
 * Main Render Function
 */
export function renderPerformanceView() {
    const container = document.getElementById('tab-performance');
    if (!container) return;

    const allClosedTrades = calculateClosedTrades(perfTransactions);
    const filteredTrades = filterTrades(allClosedTrades);
    const metrics = computePerformanceMetrics(filteredTrades);
    const overallMetrics = computePerformanceMetrics(allClosedTrades);

    // Render HTML Structure
    container.innerHTML = generatePerformanceHTML(allClosedTrades, filteredTrades, metrics, overallMetrics);

    // Wire up dynamic events
    bindDynamicEvents();

    // Render Charts if trades exist
    if (allClosedTrades.length > 0) {
        renderCharts(allClosedTrades, filteredTrades, metrics);
    }
}

/**
 * Generate complete HTML for Performance Tab
 */
function generatePerformanceHTML(allClosedTrades, filteredTrades, metrics, overallMetrics) {
    const isDark = !document.body.classList.contains('theme-light');
    const hasTrades = allClosedTrades.length > 0;

    const pnlSign = metrics.netRealizedPL >= 0 ? '+' : '';
    const pnlClass = metrics.netRealizedPL >= 0 ? 'positive' : 'negative';

    return `
    <div class="performance-container">
        <!-- Banner Header -->
        <div class="perf-header-banner">
            <div class="perf-header-left">
                <div class="perf-header-icon">
                    <i class="ph ph-chart-donut"></i>
                </div>
                <div class="perf-header-title">
                    <h3>Trading Performance & Analytics</h3>
                    <p>Track closed buy/sell trades, win-loss ratio, profit curve, and strategic trade statistics</p>
                </div>
            </div>
            <div class="perf-header-actions">
                <div class="perf-tab-pills">
                    <button type="button" class="perf-pill-btn ${perfViewMode === 'closed' ? 'active' : ''}" id="perf-mode-closed">
                        <i class="ph ph-check-circle"></i> Closed Trades (${allClosedTrades.length})
                    </button>
                    <button type="button" class="perf-pill-btn ${perfViewMode === 'open' ? 'active' : ''}" id="perf-mode-open">
                        <i class="ph ph-clock"></i> Open Holdings
                    </button>
                </div>
            </div>
        </div>

        ${!hasTrades ? renderEmptyState() : renderActiveDashboard(filteredTrades, metrics, overallMetrics)}
    </div>
    `;
}

/**
 * Render Empty State when no SELL trades have been executed yet
 */
function renderEmptyState() {
    return `
    <div class="glass-card perf-empty-state">
        <div class="perf-empty-icon">
            <i class="ph ph-trend-up"></i>
        </div>
        <h3>No Closed Trades Yet</h3>
        <p>
            When you sell shares of any stock from your <strong>Portfolio</strong> or <strong>Transactions</strong> tab,
            your trade will be completed and counted here. You'll see your positive vs negative trades, 
            win rate, cumulative profit graph, and full performance analytics automatically.
        </p>
        <button type="button" class="primary-btn mt-1" onclick="document.querySelector('[data-tab=portfolio]')?.click()">
            <i class="ph ph-briefcase"></i> View Your Portfolio Holdings
        </button>
    </div>
    `;
}

/**
 * Render Active Dashboard with KPIs, Charts, Filters, and Table
 */
function renderActiveDashboard(filteredTrades, metrics, overallMetrics) {
    const isWinRateGood = metrics.winRate >= 50;
    const pnlSign = metrics.netRealizedPL >= 0 ? '+' : '';
    const pnlClass = metrics.netRealizedPL >= 0 ? 'positive' : 'negative';

    return `
    <!-- Top KPI Metrics Cards -->
    <div class="perf-metrics-grid">
        <!-- Win Rate -->
        <div class="glass-card perf-stat-card card-win">
            <div class="perf-stat-top">
                <span class="perf-stat-label">Win Rate</span>
                <div class="perf-stat-icon win"><i class="ph ph-trophy"></i></div>
            </div>
            <div class="perf-stat-val ${isWinRateGood ? 'positive' : 'negative'}">
                ${metrics.winRate.toFixed(1)}%
            </div>
            <div class="perf-stat-sub">
                <span class="positive"><i class="ph ph-arrow-up-right"></i> ${metrics.winCount} Won</span>
                <span>•</span>
                <span class="negative"><i class="ph ph-arrow-down-right"></i> ${metrics.lossCount} Lost</span>
            </div>
        </div>

        <!-- Net Realized P&L -->
        <div class="glass-card perf-stat-card card-pnl">
            <div class="perf-stat-top">
                <span class="perf-stat-label">Net Realized P&L</span>
                <div class="perf-stat-icon pnl"><i class="ph ph-wallet"></i></div>
            </div>
            <div class="perf-stat-val ${pnlClass}">
                ${pnlSign}Rs ${formatNumber(metrics.netRealizedPL)}
            </div>
            <div class="perf-stat-sub">
                <span>Gross Gains: <strong class="positive">+Rs ${formatNumber(metrics.totalWonAmount)}</strong></span>
            </div>
        </div>

        <!-- Total Trades Taken -->
        <div class="glass-card perf-stat-card card-total">
            <div class="perf-stat-top">
                <span class="perf-stat-label">Total Trades Taken</span>
                <div class="perf-stat-icon total"><i class="ph ph-arrows-left-right"></i></div>
            </div>
            <div class="perf-stat-val">
                ${metrics.totalTrades}
            </div>
            <div class="perf-stat-sub">
                <span>Completed Round-Trip Trades</span>
            </div>
        </div>

        <!-- Profit Factor -->
        <div class="glass-card perf-stat-card card-loss">
            <div class="perf-stat-top">
                <span class="perf-stat-label">Profit Factor</span>
                <div class="perf-stat-icon ${metrics.profitFactor >= 1.5 ? 'win' : 'loss'}">
                    <i class="ph ph-scales"></i>
                </div>
            </div>
            <div class="perf-stat-val ${metrics.profitFactor >= 1.0 ? 'positive' : 'negative'}">
                ${metrics.profitFactor >= 90 ? '∞' : metrics.profitFactor.toFixed(2)}
            </div>
            <div class="perf-stat-sub">
                <span>Total Losses: <strong class="negative">-Rs ${formatNumber(metrics.totalLostAmount)}</strong></span>
            </div>
        </div>
    </div>

    <!-- Secondary Advanced Analytics Strip -->
    <div class="perf-secondary-grid">
        <div class="glass-card perf-mini-stat">
            <span class="perf-mini-label">Avg Trade Return</span>
            <span class="perf-mini-val ${metrics.avgTradePL >= 0 ? 'positive' : 'negative'}">
                ${metrics.avgTradePL >= 0 ? '+' : ''}Rs ${formatNumber(metrics.avgTradePL)}
            </span>
            <span class="perf-mini-sub">Expectancy per closed trade</span>
        </div>
        <div class="glass-card perf-mini-stat">
            <span class="perf-mini-label">Avg Winning Trade</span>
            <span class="perf-mini-val positive">+Rs ${formatNumber(metrics.avgWin)}</span>
            <span class="perf-mini-sub">${metrics.winCount} profitable trades</span>
        </div>
        <div class="glass-card perf-mini-stat">
            <span class="perf-mini-label">Avg Losing Trade</span>
            <span class="perf-mini-val negative">-Rs ${formatNumber(metrics.avgLoss)}</span>
            <span class="perf-mini-sub">${metrics.lossCount} loss trades</span>
        </div>
        <div class="glass-card perf-mini-stat">
            <span class="perf-mini-label">Best Trade</span>
            <span class="perf-mini-val positive">
                ${metrics.bestTrade ? `${metrics.bestTrade.symbol} (+Rs ${formatNumber(metrics.bestTrade.netProfit)})` : '—'}
            </span>
            <span class="perf-mini-sub">${metrics.bestTrade ? `+${metrics.bestTrade.returnPerc.toFixed(1)}% gain` : 'None'}</span>
        </div>
        <div class="glass-card perf-mini-stat">
            <span class="perf-mini-label">Worst Trade</span>
            <span class="perf-mini-val negative">
                ${metrics.worstTrade && metrics.worstTrade.netProfit < 0 ? `${metrics.worstTrade.symbol} (-Rs ${formatNumber(Math.abs(metrics.worstTrade.netProfit))})` : 'None'}
            </span>
            <span class="perf-mini-sub">${metrics.worstTrade && metrics.worstTrade.netProfit < 0 ? `${metrics.worstTrade.returnPerc.toFixed(1)}% loss` : 'Zero losses'}</span>
        </div>
    </div>

    <!-- Visual Graphs Row 1: Donut Ratio & Equity Curve -->
    <div class="perf-charts-row">
        <!-- Donut Ratio Chart -->
        <div class="glass-card perf-chart-card">
            <div class="perf-chart-header">
                <div>
                    <h4><i class="ph ph-chart-pie-slice" style="color:var(--accent)"></i> Trade Outcome Ratio</h4>
                    <span class="perf-chart-header-sub">Positive vs Negative Trades</span>
                </div>
            </div>
            
            <div class="donut-chart-wrapper">
                <canvas id="perf-donut-chart"></canvas>
                <div class="donut-center-text">
                    <span class="donut-center-val ${metrics.winRate >= 50 ? 'positive' : 'negative'}">
                        ${metrics.winRate.toFixed(0)}%
                    </span>
                    <span class="donut-center-lbl">Win Rate</span>
                </div>
            </div>

            <div class="perf-donut-legend">
                <div class="donut-legend-item">
                    <div class="legend-item-left">
                        <span class="legend-dot win"></span>
                        <span>Positive Trades</span>
                    </div>
                    <span class="legend-item-right positive">${metrics.winCount} (${metrics.totalTrades > 0 ? (metrics.winCount/metrics.totalTrades*100).toFixed(0) : 0}%)</span>
                </div>
                <div class="donut-legend-item">
                    <div class="legend-item-left">
                        <span class="legend-dot loss"></span>
                        <span>Negative Trades</span>
                    </div>
                    <span class="legend-item-right negative">${metrics.lossCount} (${metrics.totalTrades > 0 ? (metrics.lossCount/metrics.totalTrades*100).toFixed(0) : 0}%)</span>
                </div>
                ${metrics.evenCount > 0 ? `
                <div class="donut-legend-item">
                    <div class="legend-item-left">
                        <span class="legend-dot even"></span>
                        <span>Breakeven Trades</span>
                    </div>
                    <span class="legend-item-right">${metrics.evenCount}</span>
                </div>` : ''}
            </div>
        </div>

        <!-- Cumulative Performance Equity Curve -->
        <div class="glass-card perf-chart-card">
            <div class="perf-chart-header">
                <div>
                    <h4><i class="ph ph-trend-up" style="color:var(--green-500)"></i> Cumulative Profit Curve</h4>
                    <span class="perf-chart-header-sub">Equity growth trajectory across completed trades</span>
                </div>
            </div>
            <div class="perf-canvas-box">
                <canvas id="perf-equity-chart"></canvas>
            </div>
        </div>
    </div>

    <!-- Visual Graphs Row 2: Trade-by-Trade P&L Bars & Leaderboard -->
    <div class="perf-charts-row">
        <!-- Trade-by-Trade Bars -->
        <div class="glass-card perf-chart-card" style="grid-column: 1 / -1;">
            <div class="perf-chart-header">
                <div>
                    <h4><i class="ph ph-chart-bar" style="color:#8b5cf6"></i> Trade-by-Trade Performance (P&L per Trade)</h4>
                    <span class="perf-chart-header-sub">Individual profit/loss for each closed trade</span>
                </div>
            </div>
            <div class="perf-canvas-box" style="height: 250px;">
                <canvas id="perf-bars-chart"></canvas>
            </div>
        </div>
    </div>

    <!-- Stock Leaderboard Row -->
    <div class="perf-leaderboard-grid">
        <!-- Top Winning Stocks -->
        <div class="glass-card">
            <h4><i class="ph ph-crown" style="color:var(--green-500); margin-right: 0.4rem;"></i> Top Profitable Stocks</h4>
            <div class="perf-leader-list">
                ${metrics.symbolLeaderboard.filter(s => s.netPL > 0).slice(0, 5).map((s, idx) => `
                    <div class="perf-leader-item">
                        <div class="perf-leader-left">
                            <span class="perf-leader-rank">${idx + 1}</span>
                            <div>
                                <div class="perf-leader-sym">${s.symbol}</div>
                                <div class="perf-leader-trades">${s.wins} Win${s.wins === 1 ? '' : 's'} • ${s.tradesCount} Trade${s.tradesCount === 1 ? '' : 's'}</div>
                            </div>
                        </div>
                        <div class="perf-leader-right">
                            <div class="perf-leader-pnl positive">+Rs ${formatNumber(s.netPL)}</div>
                        </div>
                    </div>
                `).join('') || '<div class="text-secondary text-sm" style="padding:1rem 0;">No profitable stock sales yet.</div>'}
            </div>
        </div>

        <!-- Loss Stocks -->
        <div class="glass-card">
            <h4><i class="ph ph-shield-warning" style="color:var(--red-500); margin-right: 0.4rem;"></i> Loss Incurred Stocks</h4>
            <div class="perf-leader-list">
                ${metrics.symbolLeaderboard.filter(s => s.netPL < 0).slice(0, 5).map((s, idx) => `
                    <div class="perf-leader-item">
                        <div class="perf-leader-left">
                            <span class="perf-leader-rank">${idx + 1}</span>
                            <div>
                                <div class="perf-leader-sym">${s.symbol}</div>
                                <div class="perf-leader-trades">${s.losses} Loss${s.losses === 1 ? '' : 'es'} • ${s.tradesCount} Trade${s.tradesCount === 1 ? '' : 's'}</div>
                            </div>
                        </div>
                        <div class="perf-leader-right">
                            <div class="perf-leader-pnl negative">-Rs ${formatNumber(Math.abs(s.netPL))}</div>
                        </div>
                    </div>
                `).join('') || '<div class="text-secondary text-sm" style="padding:1rem 0;">No losing stocks recorded! Excellent risk management.</div>'}
            </div>
        </div>
    </div>

    <!-- Closed Trades Journal Table -->
    <div class="glass-card">
        <!-- Filter Toolbar -->
        <div class="perf-toolbar">
            <div class="perf-toolbar-left">
                <button type="button" class="perf-filter-btn ${perfActiveFilter === 'all' ? 'active' : ''}" data-filter="all">
                    All Trades <span class="perf-filter-count">${overallMetrics.totalTrades}</span>
                </button>
                <button type="button" class="perf-filter-btn ${perfActiveFilter === 'win' ? 'active' : ''}" data-filter="win">
                    <i class="ph ph-arrow-up-right positive"></i> Positive Only <span class="perf-filter-count">${overallMetrics.winCount}</span>
                </button>
                <button type="button" class="perf-filter-btn ${perfActiveFilter === 'loss' ? 'active' : ''}" data-filter="loss">
                    <i class="ph ph-arrow-down-right negative"></i> Negative Only <span class="perf-filter-count">${overallMetrics.lossCount}</span>
                </button>
            </div>

            <div class="perf-toolbar-right">
                <div class="search-box">
                    <i class="ph ph-magnifying-glass"></i>
                    <input type="text" id="perf-search-input" placeholder="Search Symbol..." value="${perfSearchQuery}">
                </div>
                <div class="filter-group">
                    <select id="perf-timeframe-select" class="auto-width" style="padding: 0.55rem 0.8rem;">
                        <option value="all" ${perfActiveTimeframe === 'all' ? 'selected' : ''}>All Time</option>
                        <option value="30d" ${perfActiveTimeframe === '30d' ? 'selected' : ''}>Last 30 Days</option>
                        <option value="month" ${perfActiveTimeframe === 'month' ? 'selected' : ''}>This Month</option>
                        <option value="year" ${perfActiveTimeframe === 'year' ? 'selected' : ''}>This Year</option>
                    </select>
                </div>
            </div>
        </div>

        <!-- Table -->
        <div class="perf-table-wrapper">
            <table class="perf-table">
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Date</th>
                        <th>Symbol</th>
                        <th>Qty Sold</th>
                        <th>Entry WACC</th>
                        <th>Exit Price</th>
                        <th>Cost Basis</th>
                        <th>Net Received</th>
                        <th>Net P&L</th>
                        <th>Return %</th>
                        <th>Result</th>
                    </tr>
                </thead>
                <tbody>
                    ${filteredTrades.length === 0 ? `
                        <tr>
                            <td colspan="11" class="text-center" style="padding: 2.5rem; color: var(--text-secondary);">
                                No trades match the selected filter.
                            </td>
                        </tr>
                    ` : [...filteredTrades].reverse().map(trade => {
                        const isWin = trade.status === 'WIN';
                        const isLoss = trade.status === 'LOSS';
                        const sign = trade.netProfit >= 0 ? '+' : '';
                        const dateFormatted = trade.date.toLocaleDateString();

                        return `
                        <tr>
                            <td><span style="color:var(--text-secondary)">#${trade.tradeNumber}</span></td>
                            <td>${dateFormatted}</td>
                            <td>
                                <span class="perf-symbol-pill">
                                    <i class="ph ph-tag"></i> ${trade.symbol}
                                </span>
                            </td>
                            <td><strong>${trade.qty}</strong></td>
                            <td>Rs ${trade.entryPrice.toFixed(2)}</td>
                            <td>Rs ${trade.exitPrice.toFixed(2)}</td>
                            <td>Rs ${formatNumber(trade.costBasis)}</td>
                            <td>Rs ${formatNumber(trade.netProceeds)}</td>
                            <td class="${isWin ? 'positive' : (isLoss ? 'negative' : '')}">
                                <strong>${sign}Rs ${formatNumber(trade.netProfit)}</strong>
                            </td>
                            <td>
                                <span class="badge ${isWin ? 'positive' : (isLoss ? 'negative' : '')}">
                                    ${sign}${trade.returnPerc.toFixed(2)}%
                                </span>
                            </td>
                            <td>
                                <span class="perf-badge ${isWin ? 'win' : (isLoss ? 'loss' : 'even')}">
                                    <i class="ph ${isWin ? 'ph-check' : (isLoss ? 'ph-x' : 'ph-minus')}"></i>
                                    ${trade.status}
                                </span>
                            </td>
                        </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
    </div>
    `;
}

/**
 * Render Interactive Charts using Chart.js
 */
function renderCharts(allTrades, filteredTrades, metrics) {
    if (typeof window.Chart === 'undefined') return;

    const isLight = document.body.classList.contains('theme-light');
    const isMidnight = document.body.classList.contains('theme-midnight');
    const textColor = isLight ? '#475569' : (isMidnight ? '#8da2c0' : '#94a3b8');
    const gridColor = isLight ? 'rgba(0, 0, 0, 0.06)' : (isMidnight ? 'rgba(21, 88, 201, 0.15)' : 'rgba(255, 255, 255, 0.06)');
    const winColor = isMidnight ? '#d4ff24' : '#10b981';
    const tooltipBg = isLight ? '#ffffff' : (isMidnight ? '#030407' : '#0f172a');
    const tooltipTitle = isLight ? '#0f172a' : (isMidnight ? '#d4ff24' : '#f8fafc');
    const tooltipBody = isLight ? '#475569' : (isMidnight ? '#f8fafc' : '#cbd5e1');
    const tooltipBorder = isLight ? 'rgba(0,0,0,0.1)' : (isMidnight ? 'rgba(21, 88, 201, 0.4)' : 'rgba(255,255,255,0.1)');

    // 1. Donut Chart (Outcome Ratio)
    const donutEl = document.getElementById('perf-donut-chart');
    if (donutEl) {
        if (donutChartInstance) donutChartInstance.destroy();

        const dataVals = [metrics.winCount, metrics.lossCount];
        const colors = [winColor, '#ef4444'];
        if (metrics.evenCount > 0) {
            dataVals.push(metrics.evenCount);
            colors.push('#94a3b8');
        }

        donutChartInstance = new window.Chart(donutEl, {
            type: 'doughnut',
            data: {
                labels: ['Positive (Wins)', 'Negative (Losses)', ...(metrics.evenCount > 0 ? ['Breakeven'] : [])],
                datasets: [{
                    data: dataVals,
                    backgroundColor: colors,
                    borderColor: isLight ? '#ffffff' : (isMidnight ? '#030407' : '#1e293b'),
                    borderWidth: 3,
                    hoverOffset: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '74%',
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: tooltipBg,
                        titleColor: tooltipTitle,
                        bodyColor: tooltipBody,
                        borderColor: tooltipBorder,
                        borderWidth: 1,
                        padding: 10,
                        callbacks: {
                            label: (ctx) => ` ${ctx.label}: ${ctx.raw} trade${ctx.raw === 1 ? '' : 's'}`
                        }
                    }
                }
            }
        });
    }

    // 2. Cumulative Equity Line Chart
    const equityEl = document.getElementById('perf-equity-chart');
    if (equityEl) {
        if (equityChartInstance) equityChartInstance.destroy();

        // Calculate cumulative running P&L over time across all trades chronologically
        const labels = ['Start'];
        const dataPoints = [0];
        let runningPL = 0;

        filteredTrades.forEach((trade, idx) => {
            runningPL += trade.netProfit;
            labels.push(`${trade.symbol} (#${trade.tradeNumber})`);
            dataPoints.push(Math.round(runningPL * 100) / 100);
        });

        const finalPL = dataPoints[dataPoints.length - 1];
        const isOverallPositive = finalPL >= 0;
        const mainColor = isOverallPositive ? winColor : '#ef4444';

        const ctx = equityEl.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 240);
        gradient.addColorStop(0, isOverallPositive ? (isMidnight ? 'rgba(212, 255, 36, 0.35)' : 'rgba(16, 185, 129, 0.35)') : 'rgba(239, 68, 68, 0.35)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0.0)');

        equityChartInstance = new window.Chart(equityEl, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Cumulative Net P&L (Rs)',
                    data: dataPoints,
                    borderColor: mainColor,
                    borderWidth: 2.5,
                    backgroundColor: gradient,
                    fill: true,
                    tension: 0.35,
                    pointBackgroundColor: mainColor,
                    pointBorderColor: '#ffffff',
                    pointBorderWidth: 1.5,
                    pointRadius: dataPoints.length > 30 ? 2 : 4,
                    pointHoverRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: 'index'
                },
                scales: {
                    x: {
                        grid: { color: gridColor },
                        ticks: { color: textColor, maxTicksLimit: 8, font: { family: 'Outfit', size: 11 } }
                    },
                    y: {
                        grid: { color: gridColor },
                        ticks: {
                            color: textColor,
                            font: { family: 'Outfit', size: 11 },
                            callback: (v) => `${v >= 0 ? '+' : ''}${formatCompact(v)}`
                        }
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: tooltipBg,
                        titleColor: tooltipTitle,
                        bodyColor: tooltipBody,
                        borderColor: tooltipBorder,
                        borderWidth: 1,
                        padding: 12,
                        callbacks: {
                            label: (ctx) => ` Cumulative P&L: ${ctx.raw >= 0 ? '+' : ''}Rs ${formatNumber(ctx.raw)}`
                        }
                    }
                }
            }
        });
    }

    // 3. Trade-by-Trade Bars Chart
    const barsEl = document.getElementById('perf-bars-chart');
    if (barsEl) {
        if (pnlBarsChartInstance) pnlBarsChartInstance.destroy();

        const barLabels = filteredTrades.map(t => `${t.symbol} (#${t.tradeNumber})`);
        const barData = filteredTrades.map(t => Math.round(t.netProfit * 100) / 100);
        const barColors = filteredTrades.map(t => t.status === 'WIN' ? winColor : '#ef4444');

        pnlBarsChartInstance = new window.Chart(barsEl, {
            type: 'bar',
            data: {
                labels: barLabels,
                datasets: [{
                    label: 'Trade P&L (Rs)',
                    data: barData,
                    backgroundColor: barColors,
                    borderRadius: 6,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: textColor, maxTicksLimit: 15, font: { family: 'Outfit', size: 11 } }
                    },
                    y: {
                        grid: { color: gridColor },
                        ticks: {
                            color: textColor,
                            font: { family: 'Outfit', size: 11 },
                            callback: (v) => `${v >= 0 ? '+' : ''}${formatCompact(v)}`
                        }
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: tooltipBg,
                        titleColor: tooltipTitle,
                        bodyColor: tooltipBody,
                        borderColor: tooltipBorder,
                        borderWidth: 1,
                        padding: 12,
                        callbacks: {
                            label: (ctx) => {
                                const trade = filteredTrades[ctx.dataIndex];
                                const sign = trade.netProfit >= 0 ? '+' : '';
                                return [
                                    ` Result: ${sign}Rs ${formatNumber(trade.netProfit)} (${sign}${trade.returnPerc.toFixed(1)}%)`,
                                    ` Entry WACC: Rs ${trade.entryPrice.toFixed(2)}`,
                                    ` Exit Price: Rs ${trade.exitPrice.toFixed(2)}`,
                                    ` Qty Sold: ${trade.qty}`
                                ];
                            }
                        }
                    }
                }
            }
        });
    }
}

/**
 * Bind interactive controls
 */
function bindDynamicEvents() {
    // Mode switcher: Closed vs Open
    document.getElementById('perf-mode-closed')?.addEventListener('click', () => {
        perfViewMode = 'closed';
        renderPerformanceView();
    });
    document.getElementById('perf-mode-open')?.addEventListener('click', () => {
        // Navigate to portfolio or toggle open holdings view
        document.querySelector('.nav-links li[data-tab="portfolio"]')?.click();
    });

    // Filter buttons (All, Win, Loss)
    document.querySelectorAll('.perf-filter-btn[data-filter]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            perfActiveFilter = e.currentTarget.getAttribute('data-filter');
            renderPerformanceView();
        });
    });

    // Timeframe dropdown
    const tfSelect = document.getElementById('perf-timeframe-select');
    if (tfSelect) {
        tfSelect.addEventListener('change', (e) => {
            perfActiveTimeframe = e.target.value;
            renderPerformanceView();
        });
    }

    // Search input
    const searchInput = document.getElementById('perf-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            perfSearchQuery = e.target.value.toUpperCase().trim();
            renderPerformanceView();
        });
    }
}

/**
 * Number formatting utilities
 */
function formatNumber(num) {
    if (isNaN(num) || num === null || num === undefined) return '0.00';
    return Number(num).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCompact(num) {
    if (Math.abs(num) >= 100000) {
        return (num / 100000).toFixed(1) + 'L';
    } else if (Math.abs(num) >= 1000) {
        return (num / 1000).toFixed(1) + 'k';
    }
    return num.toFixed(0);
}

function setupPerformanceEventListeners() {
    // Ready
}
