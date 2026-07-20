/**
 * @name Snooze-AutoQueue
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Automatically re-queues after a game ends using your chosen queue and delay.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';

// Arm on WaitingForStats/PreEndOfGame, fire on EndOfGame
let _armed = false;
// Prevent double-firing
let _queuing = false;

let _availableQueues = []; // [{ id, name }] fetched from LCU once
let _onQueuesLoaded = null; // set by renderSettings; re-renders the select once fetchQueues() resolves

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

function log(...args) {
    Utils.Debug.log('[AutoQueue]', ...args);
}

function toast(kind, message) {
    if (window.Toast && typeof window.Toast[kind] === 'function') {
        window.Toast[kind](message);
    }
}

// Retries a request a few times with increasing delay - the load()-time call
// races the LCU's game-data service warming up right after client start, so
// a single attempt reliably 500s/404s on a fresh login.
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

// Queue list

// Returns whether the fetch produced a usable queue list, so callers (e.g.
// the manual refresh button) can tell success from failure - fetchQueues()
// itself never throws, it just leaves _availableQueues untouched on error.
async function fetchQueues() {
    log('Fetching available queues from LCU...');
    try {
        const queues = await retry(() => Utils.LCU.get('/lol-game-queues/v1/queues'));
        if (!Array.isArray(queues)) {
            log('WARN: /lol-game-queues/v1/queues did not return an array:', queues);
            return false;
        }
        _availableQueues = queues
            .filter(q => q.queueAvailability === 'Available' && q.isVisible)
            .map(q => ({ id: q.id, name: q.name || q.description || String(q.id) }))
            .sort((a, b) => a.id - b.id);
        log(`Loaded ${_availableQueues.length} queues:`, _availableQueues.map(q => `${q.name}(${q.id})`).join(', '));
        if (_onQueuesLoaded) _onQueuesLoaded();
        return _availableQueues.length > 0;
    } catch (e) {
        Utils.Debug.warn('[AutoQueue] Failed to fetch queue list:', e);
        return false;
    }
}

// Manual bypass for when the initial load()-time fetch ran before the LCU's
// game-data service had warmed up (or the request otherwise failed) and left
// the dropdown stuck on "Loading queues..." with nothing to retry it.
async function refreshQueuesNow() {
    const ok = await fetchQueues();
    if (ok) {
        toast('success', 'Queue list refreshed');
    } else {
        toast('error', 'Failed to refresh queue list');
    }
}

// Core re-queue logic 

async function reQueue() {
    if (_queuing) {
        log('reQueue() called but already queuing — skipped.');
        return;
    }
    _queuing = true;
    try {
        const queueId = Utils.Store.get('autoQueue', 'queueId');
        const delay   = Utils.Store.get('autoQueue', 'delay') || 5;
        const enabled = Utils.Store.get('autoQueue', 'enabled');

        log(`reQueue() — enabled=${enabled}, queueId=${queueId}, delay=${delay}s`);

        if (!queueId) {
            log('No queue selected in settings — aborting re-queue.');
            return;
        }

        const delayMs = delay * 1000;
        if (delayMs > 0) {
            log(`Waiting ${delay}s before re-queuing...`);
            let isCancelled = false;
            const unregisterPanic = Utils.Panic.register(() => {
                isCancelled = true;
            });
            await new Promise(r => setTimeout(r, delayMs));
            unregisterPanic();
            
            if (isCancelled) {
                log('Cancelled via Panic Key - aborting.');
                return;
            }
            if (!Utils.Store.get('autoQueue', 'enabled')) {
                log('Feature was disabled during delay - aborting.');
                return;
            }
        }

        // Play-again dismisses the EOG screen and returns us to a lobby.
        // Immediately overwrite the lobby with the chosen queue.
        log('POST /lol-lobby/v2/play-again');
        try {
            await Utils.LCU.post('/lol-lobby/v2/play-again');
            log('play-again accepted.');
        } catch (e) {
            log('ERROR on play-again (may already be in lobby):', e?.message ?? e);
            // if we're already past EOG the endpoint will 404, continue anyway
        }

        // Small settle pause so the lobby is fully created before we mutate it
        await new Promise(r => setTimeout(r, 500));

        log(`POST /lol-lobby/v2/lobby  { queueId: ${queueId} }`);
        try {
            const lobbyRes = await Utils.LCU.post('/lol-lobby/v2/lobby', { queueId: Number(queueId) });
            log('Lobby created:', JSON.stringify(lobbyRes)?.slice(0, 120));
        } catch (e) {
            log('ERROR creating lobby:', e?.message ?? e);
            return;
        }

        log('POST /lol-lobby/v2/lobby/matchmaking/search');
        try {
            await Utils.LCU.post('/lol-lobby/v2/lobby/matchmaking/search');
            log('Matchmaking search started — waiting for ready check.');
        } catch (e) {
            log('ERROR starting matchmaking search:', e?.message ?? e);
        }
    } finally {
        _queuing = false;
    }
}

// Settings UI helpers 

function renderSettings(container) {
    container.style.flexDirection = 'column';
    container.style.alignItems = 'stretch';
    container.style.gap = '12px';
    container.style.paddingLeft = '20px';
    container.style.marginTop = '0';
    container.style.borderLeft = '2px solid #3e2e13';

    // Queue selector
    const queueRow = document.createElement('div');
    Object.assign(queueRow.style, { display: 'flex', alignItems: 'center', gap: '10px' });

    const queueLabel = document.createElement('span');
    queueLabel.textContent = 'Queue';
    Object.assign(queueLabel.style, { color: '#a09b8c', fontSize: '12px', whiteSpace: 'nowrap' });

    const queueSelect = document.createElement('select');
    Object.assign(queueSelect.style, {
        background: '#111', color: '#f0e6d2', border: '1px solid #3e2e13',
        padding: '5px 8px', borderRadius: '2px', flex: '1', outline: 'none', fontSize: '13px'
    });

    function populateQueueSelect() {
        queueSelect.innerHTML = '';
        const savedId = Utils.Store.get('autoQueue', 'queueId');
        if (_availableQueues.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'Loading queues...';
            queueSelect.appendChild(opt);
            return;
        }
        _availableQueues.forEach(q => {
            const opt = document.createElement('option');
            opt.value = String(q.id);
            opt.textContent = `${q.name} [${q.id}]`;
            if (String(q.id) === String(savedId)) opt.selected = true;
            queueSelect.appendChild(opt);
        });
        // If nothing saved yet, save the first option as default
        if (!savedId && _availableQueues.length > 0) {
            Utils.Store.set('autoQueue', 'queueId', _availableQueues[0].id);
            queueSelect.value = String(_availableQueues[0].id);
        }
    }

    populateQueueSelect();
    _onQueuesLoaded = populateQueueSelect;
    // Settings render lazily (only once this tab is opened), so this is also
    // the first safe point to fetch the queue list instead of doing it in load().
    if (_availableQueues.length === 0) fetchQueues();

    queueSelect.addEventListener('click', (e) => e.stopPropagation());
    queueSelect.addEventListener('change', (e) => {
        Utils.Store.set('autoQueue', 'queueId', Number(e.target.value));
    });

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.textContent = 'Refresh';
    Object.assign(refreshBtn.style, {
        background: 'rgba(200,170,110,0.08)',
        border: '1px solid rgba(200,170,110,0.25)',
        color: '#c8aa6e',
        padding: '5px 10px',
        borderRadius: '2px',
        fontWeight: '700',
        fontSize: '12px',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        outline: 'none',
        whiteSpace: 'nowrap'
    });
    refreshBtn.addEventListener('mouseenter', () => {
        refreshBtn.style.background = 'rgba(200,170,110,0.16)';
        refreshBtn.style.color = '#f0e6d2';
    });
    refreshBtn.addEventListener('mouseleave', () => {
        refreshBtn.style.background = 'rgba(200,170,110,0.08)';
        refreshBtn.style.color = '#c8aa6e';
    });
    refreshBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (refreshBtn.disabled) return;
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Refreshing...';
        await refreshQueuesNow();
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh';
    });

    queueRow.appendChild(queueLabel);
    queueRow.appendChild(queueSelect);
    queueRow.appendChild(refreshBtn);
    container.appendChild(queueRow);

    // Delay input
    const delayRow = document.createElement('div');
    Object.assign(delayRow.style, { display: 'flex', alignItems: 'center', gap: '10px' });

    const delayLabel = document.createElement('span');
    delayLabel.textContent = 'Delay before re-queue (seconds)';
    Object.assign(delayLabel.style, { color: '#a09b8c', fontSize: '12px', whiteSpace: 'nowrap' });

    const delayInput = document.createElement('input');
    delayInput.type = 'number';
    delayInput.min = '0';
    delayInput.max = '60';
    delayInput.step = '1';
    delayInput.value = String(Utils.Store.get('autoQueue', 'delay') || 0);
    Object.assign(delayInput.style, {
        background: '#111', border: '1px solid #3e2e13', color: '#f0e6d2',
        padding: '5px 8px', borderRadius: '2px', outline: 'none', width: '60px', fontSize: '13px'
    });

    delayInput.addEventListener('click', (e) => e.stopPropagation());
    delayInput.addEventListener('change', () => {
        let v = parseInt(delayInput.value, 10);
        if (!isFinite(v) || v < 0) v = 0;
        if (v > 60) v = 60;
        delayInput.value = String(v);
        Utils.Store.set('autoQueue', 'delay', v);
    });

    delayRow.appendChild(delayLabel);
    delayRow.appendChild(delayInput);
    container.appendChild(delayRow);

    // Automation tip
    const tipBox = document.createElement('div');
    Object.assign(tipBox.style, {
        marginTop: '8px',
        padding: '10px',
        background: 'rgba(0,0,0,0.2)',
        border: '1px solid rgba(255,255,255,0.05)',
        borderRadius: '4px',
        color: '#8a9aaa',
        fontSize: '12px',
        lineHeight: '1.5'
    });
    tipBox.innerHTML = `<span style="color:#c8aa6e;font-weight:600;">Full Automation Guide:</span> For a completely hands-free journey from queue to game, make sure to also enable <b>Auto Accept</b>, <b>Auto Lock Champion</b>, and <b>Auto Honor</b> (with the <i>'Skip Honor'</i> option checked).`;
    
    container.appendChild(tipBox);

    // Panic key lives in the Settings tab (shared with the menu shortcut); note it here
    const panicNote = document.createElement('div');
    Object.assign(panicNote.style, { color: '#8a9aaa', fontSize: '12px', marginTop: '12px', lineHeight: '1.4' });
    const panicKey = Utils.Store.get('global', 'panicKey') || 'F2';
    panicNote.textContent = `Panic Key (${panicKey}): press it during the queue countdown to cancel auto-queue (only works with a Delay greater than 0). Set the key in the Settings tab.`;
    container.appendChild(panicNote);
}

// Module lifecycle 

export function init(context) {
    Utils.Settings.inject(context, {
        name: 'auto-queue-settings',
        titleKey: 'snooze_auto-queue',
        titleName: 'Auto Queue',
        capitalTitleKey: 'snooze_auto-queue_capital',
        capitalTitleName: 'AUTO QUEUE',
        class: 'auto-queue-settings'
    });

    let isEnabled = Utils.Store.get('autoQueue', 'enabled') || false;

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'autoQueue',
            category: 'Matchmaking',
            name: 'Auto Queue',
            description: 'Automatically re-queues into your chosen game mode after a match ends, with configurable delay.',
            settings: [
                {
                    type: 'toggle',
                    label: 'Enable Auto Queue',
                    description: 'Starts a new search into your chosen queue once a game finishes',
                    value: isEnabled,
                    onChange: (val) => {
                        isEnabled = val;
                        Utils.Store.set('autoQueue', 'enabled', val);
                    }
                },
                {
                    type: 'custom',
                    render: (row) => renderSettings(row)
                }
            ]
        });
    } else {
        // Native settings UI injection
        Utils.DOM.observer.observe("lol-uikit-scrollable.auto-queue-settings", (plugin) => {
            plugin.appendChild(Utils.Settings.createToggleRow("Enable Auto Queue", isEnabled, (next) => {
                isEnabled = next;
                Utils.Store.set('autoQueue', 'enabled', isEnabled);
            }));

            const extraRow = document.createElement("div");
            extraRow.classList.add("plugins-settings-row");
            extraRow.style.marginTop = "10px";
            renderSettings(extraRow);
            plugin.appendChild(extraRow);
        });
    }
}

export async function load() {
    log('load() called — subscribing to gameflow phase.');
    // Queue list is only needed to populate the settings dropdown, which now renders
    // lazily on first tab open (see renderSettings()) - no need to fetch it here too.

    if (!Utils.LCU || !Utils.LCU.observe) {
        log('ERROR: Utils.LCU.observe not available — module inactive.');
        return;
    }

    Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', (e) => {
        const isEnabled = Utils.Store.get('autoQueue', 'enabled');
        if (!isEnabled) {
            _armed = false;
            return;
        }

        const phase = e.data;
        log(`Phase → "${phase}"  |  armed=${_armed}  queuing=${_queuing}  enabled=${isEnabled}`);

        // Arm on early end-of-game phases
        if (phase === 'WaitingForStats' || phase === 'PreEndOfGame') {
            if (!_armed) log(`Arming on "${phase}".`);
            _armed = true;
            return;
        }

        // Fire on EndOfGame, but only if we actually saw an arming phase first -
        // a stray/duplicate EndOfGame push (e.g. on plugin reload mid-postgame)
        // shouldn't trigger a re-queue.
        if (phase === 'EndOfGame') {
            if (!_armed) {
                log('"EndOfGame" reached without arming - ignoring.');
                return;
            }
            log('"EndOfGame" reached while armed — triggering re-queue.');
            _armed = false;
            reQueue();
            return;
        }

        // Anything else: disarm. Don't touch _queuing here - reQueue()'s own
        // finally block owns that guard, and reQueue() itself causes phase
        // transitions (e.g. to "Lobby") while still in flight.
        if (_armed) log(`Phase "${phase}" — disarming.`);
        _armed = false;
    });
}
