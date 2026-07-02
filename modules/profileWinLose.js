/**
 * @name Snooze-ProfileWinLose
 * @version 1.0.0
 * @author Yimikami (ported) - github@ReformedDoge
 * @description Shows a summoner's win/loss record, win rate, and KDA on their profile page.
 * @link https://github.com/Yimikami/pengu-plugins/
 */
import Utils from './generalUtils.js';

const MODULE_KEY = 'profileWinLose';

// Queue ids actually seen in the current profile's last "games to analyze"
// window (recomputed on every stats fetch) - null until the first fetch, in
// which case the dropdown falls back to showing every known queue.
let recentQueueIds = null;
const mountedQueueSelects = new Set();

// Queue list is pulled live from Utils.GameData.Assets.queues (LCU's own
// /lol-game-queues/v1/queues) instead of a hardcoded map, so Arena, ARAM,
// URF, and any rotating/event queues show up automatically. Trimmed down to
// queues actually present in the recent games window, to cut dropdown bloat.
function getAvailableQueues() {
    const all = Utils.GameData.Assets.queues || [];
    const filtered = recentQueueIds
        ? all.filter(q => recentQueueIds.has(String(q.id)) || String(q.id) === String(selectedQueue))
        : all;
    // If narrowing down to "recent" queues would leave nothing to show (stale/
    // empty cached data, Assets.queues not loaded yet, etc.), fall back to the
    // full list rather than presenting a dropdown with nothing useful in it.
    const relevant = filtered.length > 0 ? filtered : all;
    return [{ id: 'all', name: 'All Queues' }, ...relevant];
}

// Native <select> elements don't ellipsis-truncate their closed-box text
// reliably, so long localized queue names (e.g. custom-mode names in other
// languages) get clipped with no way to read the rest - mirror the full
// label as a `title` tooltip instead.
function updateSelectTitle(select) {
    select.title = select.options[select.selectedIndex]?.textContent || '';
}

function refreshQueueSelectOptions() {
    mountedQueueSelects.forEach((select) => {
        if (!document.body.contains(select)) {
            mountedQueueSelects.delete(select);
            return;
        }
        select.innerHTML = '';
        getAvailableQueues().forEach((q) => {
            const opt = document.createElement('option');
            opt.value = String(q.id);
            opt.textContent = formatQueueLabel(q);
            opt.title = formatQueueLabel(q);
            select.appendChild(opt);
        });
        select.value = String(selectedQueue);
        updateSelectTitle(select);
    });
}

function updateRecentQueueIds(games) {
    const ids = new Set(games.filter(g => g.queueId > 0).map(g => String(g.queueId)));
    Utils.Debug.log(`[ProfileWinLose] recent games: ${games.length}, unique queues: ${ids.size}`);

    // A zero-game result is inconclusive (could be a transient/empty fetch,
    // not proof the player has no recent games) - don't let it overwrite a
    // previously-known-good set and permanently narrow the dropdown to nothing.
    if (ids.size === 0) return;

    const unchanged = recentQueueIds && ids.size === recentQueueIds.size && [...ids].every(id => recentQueueIds.has(id));
    if (unchanged) return;

    recentQueueIds = ids;
    Utils.Store.set(MODULE_KEY, 'recentQueueIds', Array.from(ids));
    refreshQueueSelectOptions();
}

function formatQueueLabel(q) {
    return q.id === 'all' ? q.name : `${q.name} [${q.id}]`;
}

function getQueueName(selected) {
    if (selected === 'all') return 'All Queues';
    const q = (Utils.GameData.Assets.queues || []).find(x => String(x.id) === String(selected));
    return q ? formatQueueLabel(q) : 'All Queues';
}

const SEASON_START_MS = new Date('2026-01-09T00:00:00Z').getTime(); // Season 16 start
const CACHE_EXPIRY_MS = 5 * 60 * 1000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const CHECK_THROTTLE_MS = 1000;

let isEnabled = true;
let gamesCount = 40;
let selectedQueue = 'all';
let showKda = true;
let seasonFilterOn = true;

let checkRafId = null;
let isMounted = false;
let currentPuuid = null;
let statsContainer = null;
let styleElement = null;
let lastCheckTime = 0;

const cache = new Map();

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function toast(kind, message) {
    if (window.Toast && typeof window.Toast[kind] === 'function') {
        window.Toast[kind](message);
    }
}

async function retry(fn, attemptsLeft = RETRY_ATTEMPTS) {
    try {
        return await fn();
    } catch (err) {
        if (attemptsLeft > 0) {
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (RETRY_ATTEMPTS - attemptsLeft + 1)));
            return retry(fn, attemptsLeft - 1);
        }
        throw err;
    }
}

function findTargetProfile() {
    const profileElements = document.querySelectorAll('lol-regalia-profile-v2-element');
    const searched = Array.from(profileElements).find(el => el.getAttribute('is-searched') === 'true');
    return searched || profileElements[0] || null;
}

function injectStyles() {
    if (styleElement) return;
    styleElement = document.createElement('style');
    styleElement.id = 'sm-profile-winlose-styles';
    styleElement.textContent = `
        #sm-profile-winlose-container { display: flex; flex-direction: row; justify-content: center; position: absolute; top: 655px; width: 100%; }
        .sm-profile-winlose-stats { display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 8px 15px; font-size: 14px; font-weight: 600; letter-spacing: 0.5px; font-family: "LoL Display", "LoL Body", sans-serif; max-width: 280px; }
        .sm-profile-winlose-stats .stats-row { display: flex; gap: 15px; white-space: nowrap; }
        .sm-profile-winlose-stats .queue-type { color: #c8aa6e; text-shadow: 0 0 3px rgba(200, 170, 110, 0.3); margin-bottom: 2px; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: default; }
        .sm-profile-winlose-stats .wins { color: #0acbe6; text-shadow: 0 0 3px rgba(10, 203, 230, 0.3); }
        .sm-profile-winlose-stats .losses { color: #ff4b4b; text-shadow: 0 0 3px rgba(255, 75, 75, 0.3); }
        .sm-profile-winlose-stats .winrate { color: #f0e6d2; text-shadow: 0 0 3px rgba(240, 230, 210, 0.3); }
        .sm-profile-winlose-stats .kda { color: #c8aa6e; text-shadow: 0 0 3px rgba(200, 170, 110, 0.3); }
        .sm-profile-winlose-stats .loading { color: #c8aa6e; text-shadow: 0 0 3px rgba(200, 170, 110, 0.3); animation: sm-pwl-pulse 1.5s infinite; }
        @keyframes sm-pwl-pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
    `;
    document.head.appendChild(styleElement);
}

function createStatsContainer() {
    document.getElementById('sm-profile-winlose-container')?.remove();

    const targetProfile = findTargetProfile();
    if (!targetProfile) {
        statsContainer = null;
        return;
    }

    const targetElement = targetProfile.querySelector('.style-profile-summoner-status-icons');
    if (!targetElement) {
        statsContainer = null;
        return;
    }

    statsContainer = document.createElement('div');
    statsContainer.id = 'sm-profile-winlose-container';
    targetElement.parentNode.insertBefore(statsContainer, targetElement.nextSibling);
}

function displayLoading() {
    if (!statsContainer) createStatsContainer();
    if (!statsContainer) return;
    const content = document.createElement('div');
    content.className = 'sm-profile-winlose-stats';
    content.innerHTML = `<span class="loading">Loading...</span>`;
    statsContainer.replaceChildren(content);
}

function displayError() {
    if (!statsContainer) createStatsContainer();
    if (!statsContainer) return;
    const content = document.createElement('div');
    content.className = 'sm-profile-winlose-stats';
    content.innerHTML = `<span>Stats unavailable</span>`;
    statsContainer.replaceChildren(content);
}

function displayStats({ wins, losses, winRate, kda }) {
    if (!statsContainer) createStatsContainer();
    if (!statsContainer) return;
    const queueLabel = getQueueName(selectedQueue);
    const content = document.createElement('div');
    content.className = 'sm-profile-winlose-stats';
    content.innerHTML = `
        <div class="queue-type" title="${escapeHtml(queueLabel)}">${escapeHtml(queueLabel)}</div>
        <div class="stats-row">
            <span class="wins">${wins}W</span>
            <span class="losses">${losses}L</span>
            <span class="winrate">${winRate}%</span>
            ${showKda ? `<span class="kda">${kda} KDA</span>` : ''}
        </div>
    `;
    statsContainer.replaceChildren(content);
}

// Fetches, season-filters, and slices to the "games to analyze" window -
// independent of the selected queue filter, so the queue dropdown can be
// trimmed to whatever queues actually show up in that window.
async function fetchRecentGames(puuid, forceRefresh = false) {
    const cacheKey = `raw_${puuid}_${seasonFilterOn}_${gamesCount}`;
    if (!forceRefresh) {
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY_MS) {
            return cached.data;
        }
    }

    const data = await retry(() => Utils.LCU.get(
        `/lol-match-history/v1/products/lol/${puuid}/matches?begIndex=0&endIndex=${gamesCount - 1}`
    ));

    let games = data?.games?.games || [];
    if (seasonFilterOn) {
        games = games.filter(g => g.gameCreation >= SEASON_START_MS);
    }
    games = games.slice(0, gamesCount);

    cache.set(cacheKey, { data: games, timestamp: Date.now() });
    return games;
}

async function fetchStats(puuid) {
    const recentGames = await fetchRecentGames(puuid);
    updateRecentQueueIds(recentGames);

    const games = selectedQueue === 'all'
        ? recentGames
        : recentGames.filter(g => String(g.queueId) === String(selectedQueue));

    const totals = games.reduce((acc, game) => {
        const player = game.participants[0];
        const teamWin = game.teams[player.teamId === 100 ? 0 : 1].win === 'Win';
        return {
            wins: acc.wins + (teamWin ? 1 : 0),
            losses: acc.losses + (teamWin ? 0 : 1),
            kills: acc.kills + (player.stats.kills || 0),
            deaths: acc.deaths + (player.stats.deaths || 0),
            assists: acc.assists + (player.stats.assists || 0)
        };
    }, { wins: 0, losses: 0, kills: 0, deaths: 0, assists: 0 });

    const totalGames = totals.wins + totals.losses;
    const kda = totals.deaths === 0
        ? (totals.kills + totals.assists).toFixed(1)
        : ((totals.kills + totals.assists) / totals.deaths).toFixed(1);

    return {
        wins: totals.wins,
        losses: totals.losses,
        winRate: totalGames === 0 ? 0 : ((totals.wins / totalGames) * 100).toFixed(1),
        kda
    };
}

async function updateStats(puuid) {
    try {
        displayLoading();
        const stats = await fetchStats(puuid);
        displayStats(stats);
    } catch (err) {
        Utils.Debug.warn('[ProfileWinLose] Failed to fetch stats:', err);
        displayError();
    }
}

function refreshCurrentProfile() {
    if (currentPuuid) updateStats(currentPuuid);
}

function checkCurrentProfile() {
    if (statsContainer && document.contains(statsContainer)) return;

    const targetProfile = findTargetProfile();
    if (!targetProfile) return;

    const puuid = targetProfile.getAttribute('puuid');
    if (!puuid) return;

    if (puuid !== currentPuuid || !statsContainer || !document.contains(statsContainer)) {
        currentPuuid = puuid;
        createStatsContainer();
        updateStats(puuid);
    }
}

function mountFeature() {
    if (isMounted) return;
    isMounted = true;
    injectStyles();

    // A raw MutationObserver watching document.body with childList+subtree
    // fires on every DOM mutation client-wide (chat, tooltips, other Ember
    // components), not just profile changes - the 1s-throttled poll below
    // already catches both a new profile element and a puuid/is-searched
    // change within at most CHECK_THROTTLE_MS, so it covers this without
    // the constant whole-document churn.
    setTimeout(checkCurrentProfile, 100);

    const tick = () => {
        if (!isMounted) return;
        const now = Date.now();
        if (now - lastCheckTime >= CHECK_THROTTLE_MS) {
            lastCheckTime = now;
            checkCurrentProfile();
        }
        checkRafId = requestAnimationFrame(tick);
    };
    checkRafId = requestAnimationFrame(tick);
}

function unmountFeature() {
    isMounted = false;
    if (checkRafId) cancelAnimationFrame(checkRafId);
    checkRafId = null;
    document.getElementById('sm-profile-winlose-container')?.remove();
    styleElement?.remove();
    styleElement = null;
    statsContainer = null;
    currentPuuid = null;
    cache.clear();
}

function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set(MODULE_KEY, 'enabled', enabled);
    if (enabled) mountFeature(); else unmountFeature();
}

function setGamesCount(next) {
    const clamped = Math.min(200, Math.max(1, next));
    gamesCount = clamped;
    Utils.Store.set(MODULE_KEY, 'gamesCount', clamped);
    cache.clear();
    toast('success', `Games to analyze updated to ${clamped}`);
    refreshCurrentProfile();
}

function setSelectedQueue(next) {
    selectedQueue = next;
    Utils.Store.set(MODULE_KEY, 'selectedQueue', next);
    cache.clear();
    toast('success', `Queue filter updated to ${getQueueName(next)}`);
    if (statsContainer) { statsContainer.remove(); statsContainer = null; }
    if (currentPuuid) { createStatsContainer(); updateStats(currentPuuid); }
}

function setShowKda(next) {
    showKda = next;
    Utils.Store.set(MODULE_KEY, 'kdaDisplay', next ? 'show' : 'hide');
    refreshCurrentProfile();
}

function setSeasonFilter(next) {
    seasonFilterOn = next;
    Utils.Store.set(MODULE_KEY, 'seasonFilter', next ? 'on' : 'off');
    cache.clear();
    refreshCurrentProfile();
}

// Manual bypass for the 5-minute match-history cache, so the queue dropdown
// can be brought up to date immediately (e.g. right after a new game in a
// queue that isn't listed yet) without waiting for the cache to expire.
async function refreshQueueListNow() {
    if (!currentPuuid) {
        toast('error', 'Open a summoner profile first');
        return;
    }
    try {
        // Assets.init() is a no-op if it already loaded queue data - but if
        // /lol-game-queues/v1/queues came back empty during the initial boot
        // (LCU game-data not warmed up yet), Assets resets its own cache so a
        // fresh call here actually retries it instead of staying empty for
        // the rest of the session.
        await Utils.GameData.Assets.init();
        const games = await fetchRecentGames(currentPuuid, true);
        updateRecentQueueIds(games);
        // Rebuild regardless of whether the queue-id set changed - the ids
        // could be identical to last time while Assets.queues (used to map
        // those ids to display names) has only just become available.
        refreshQueueSelectOptions();
        toast('success', 'Queue list refreshed');
    } catch (err) {
        Utils.Debug.warn('[ProfileWinLose] Failed to refresh queue list:', err);
        toast('error', 'Failed to refresh queue list');
    }
}

function createActionButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    Object.assign(button.style, {
        background: 'rgba(200,170,110,0.08)',
        border: '1px solid rgba(200,170,110,0.25)',
        color: '#c8aa6e',
        padding: '6px 14px',
        borderRadius: '2px',
        fontWeight: '700',
        fontSize: '12px',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        outline: 'none',
        alignSelf: 'flex-start'
    });
    button.addEventListener('mouseenter', () => {
        button.style.background = 'rgba(200,170,110,0.16)';
        button.style.color = '#f0e6d2';
    });
    button.addEventListener('mouseleave', () => {
        button.style.background = 'rgba(200,170,110,0.08)';
        button.style.color = '#c8aa6e';
    });
    button.addEventListener('click', onClick);
    return button;
}

function renderExtraSettings(container) {
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.alignItems = 'stretch';
    container.style.gap = '12px';
    container.style.paddingLeft = '20px';
    container.style.marginTop = '0';
    container.style.borderLeft = '2px solid #3e2e13';

    const gamesRow = document.createElement('div');
    gamesRow.style.display = 'flex';
    gamesRow.style.alignItems = 'center';
    gamesRow.style.gap = '10px';

    const gamesLabel = document.createElement('span');
    gamesLabel.textContent = 'Games to analyze:';
    gamesLabel.style.color = '#a09b8c';
    gamesLabel.style.fontSize = '13px';
    gamesLabel.style.flex = '1';

    const gamesInput = document.createElement('input');
    gamesInput.type = 'number';
    gamesInput.min = '1';
    gamesInput.max = '200';
    gamesInput.value = String(gamesCount);
    Object.assign(gamesInput.style, { background: '#111', color: '#f0e6d2', border: '1px solid #3e2e13', padding: '6px', borderRadius: '2px', width: '80px', textAlign: 'center', outline: 'none' });
    gamesInput.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10);
        if (!Number.isNaN(val) && val > 0 && val <= 200) {
            setGamesCount(val);
        } else {
            e.target.value = String(gamesCount);
            toast('error', 'Please enter a number between 1 and 200');
        }
    });

    gamesRow.appendChild(gamesLabel);
    gamesRow.appendChild(gamesInput);
    container.appendChild(gamesRow);

    const queueRow = document.createElement('div');
    queueRow.style.display = 'flex';
    queueRow.style.alignItems = 'center';
    queueRow.style.gap = '10px';

    const queueLabel = document.createElement('span');
    queueLabel.textContent = 'Queue type:';
    queueLabel.style.color = '#a09b8c';
    queueLabel.style.fontSize = '13px';
    queueLabel.style.flex = '1';

    const queueSelect = document.createElement('select');
    Object.assign(queueSelect.style, {
        background: '#111', color: '#f0e6d2', border: '1px solid #3e2e13', padding: '6px', borderRadius: '2px',
        width: '200px', outline: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
    });
    getAvailableQueues().forEach((q) => {
        const opt = document.createElement('option');
        opt.value = String(q.id);
        opt.textContent = formatQueueLabel(q);
        opt.title = formatQueueLabel(q);
        queueSelect.appendChild(opt);
    });
    queueSelect.value = String(selectedQueue);
    updateSelectTitle(queueSelect);
    queueSelect.addEventListener('change', (e) => {
        setSelectedQueue(e.target.value);
        updateSelectTitle(queueSelect);
    });
    mountedQueueSelects.add(queueSelect);

    queueRow.appendChild(queueLabel);
    queueRow.appendChild(queueSelect);
    container.appendChild(queueRow);

    const refreshBtn = createActionButton('Refresh Queues', () => refreshQueueListNow());
    container.appendChild(refreshBtn);
}

export function init(context) {
    Utils.Settings.inject(context, {
        name: 'profile-winlose-settings',
        titleKey: 'snooze_profile-winlose',
        titleName: 'Profile Win/Loss',
        capitalTitleKey: 'snooze_profile-winlose_capital',
        capitalTitleName: 'PROFILE WIN/LOSS',
        class: 'profile-winlose-settings'
    });

    isEnabled = Utils.Store.get(MODULE_KEY, 'enabled') ?? true;
    gamesCount = Utils.Store.get(MODULE_KEY, 'gamesCount') || 40;
    const storedQueue = Utils.Store.get(MODULE_KEY, 'selectedQueue');
    selectedQueue = (storedQueue === 'all' || /^\d+$/.test(String(storedQueue))) ? storedQueue : 'all';
    showKda = (Utils.Store.get(MODULE_KEY, 'kdaDisplay') ?? 'show') === 'show';
    seasonFilterOn = (Utils.Store.get(MODULE_KEY, 'seasonFilter') ?? 'on') === 'on';

    const storedRecentQueueIds = Utils.Store.get(MODULE_KEY, 'recentQueueIds');
    recentQueueIds = Array.isArray(storedRecentQueueIds) ? new Set(storedRecentQueueIds) : null;

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'profileWinLose',
            name: 'Profile Win/Loss',
            description: "Shows a summoner's win/loss record, win rate, and KDA on their profile page.",
            settings: [
                {
                    type: 'toggle',
                    id: 'sm:profileWinLoseEnabled',
                    label: 'Enable Profile Win/Loss',
                    description: 'Adds a win/loss, win rate, and KDA line to summoner profiles',
                    value: isEnabled,
                    onChange: (val) => toggleFeature(val)
                },
                {
                    type: 'toggle',
                    id: 'sm:profileWinLoseKda',
                    label: 'Show KDA',
                    description: 'Adds an average KDA figure next to the win/loss line',
                    value: showKda,
                    onChange: (val) => setShowKda(val)
                },
                {
                    type: 'toggle',
                    id: 'sm:profileWinLoseSeasonFilter',
                    label: 'Filter by Current Season',
                    description: 'Only counts games played since the current season started',
                    value: seasonFilterOn,
                    onChange: (val) => setSeasonFilter(val)
                },
                {
                    type: 'custom',
                    render: (row) => renderExtraSettings(row)
                }
            ]
        });
    } else {
        Utils.DOM.observer.observe('lol-uikit-scrollable.profile-winlose-settings', (plugin) => {
            plugin.innerHTML = '';

            plugin.appendChild(Utils.Settings.createToggleRow('Enable Profile Win/Loss', isEnabled, (next) => {
                toggleFeature(next);
            }));

            plugin.appendChild(Utils.Settings.createToggleRow('Show KDA', showKda, (next) => {
                setShowKda(next);
            }));

            plugin.appendChild(Utils.Settings.createToggleRow('Filter by Current Season', seasonFilterOn, (next) => {
                setSeasonFilter(next);
            }));

            const row = document.createElement('div');
            row.classList.add('plugins-settings-row');
            row.style.marginLeft = '0';
            row.style.paddingLeft = '0';
            renderExtraSettings(row);
            plugin.appendChild(row);
        });
    }
}

export async function load() {
    // Ensure the live queue list is available for the settings dropdown and
    // for match filtering, regardless of whether index.js already awaited
    // this (manager mode) or this module is running standalone.
    await Utils.GameData.Assets.init();
    if (isEnabled) mountFeature();
}
