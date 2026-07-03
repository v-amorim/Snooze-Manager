/**
 * @name Snooze-AutoHonor
 * @version 1.0.1
 * @author SnoozeFest - github@ReformedDoge
 * @description Automatically honor players after matches using configurable target selection.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';

let isEnabled = false;
let honorAttemptedForCurrentGame = false;

function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set('autoHonor', 'enabled', enabled);
}

function renderExtraSettings(container) {
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.alignItems = 'stretch';
    container.style.gap = '10px';
    container.style.paddingLeft = '20px';
    container.style.marginTop = '0';
    container.style.borderLeft = '2px solid #3e2e13';

    const selectRow = document.createElement('div');
    selectRow.style.display = 'flex';
    selectRow.style.width = '100%';
    
    const select = document.createElement('select');
    Object.assign(select.style, { background: '#111', color: '#f0e6d2', border: '1px solid #3e2e13', padding: '6px', borderRadius: '2px', flex: '1', outline: 'none' });
    
    const optAllies = document.createElement('option');
    optAllies.value = 'allies'; optAllies.textContent = 'Honor Allies';
    const optEnemies = document.createElement('option');
    optEnemies.value = 'enemies'; optEnemies.textContent = 'Honor Enemies';
    const optRandom = document.createElement('option');
    optRandom.value = 'random'; optRandom.textContent = 'Honor Random (Any)';

    select.appendChild(optAllies); 
    select.appendChild(optEnemies);
    select.appendChild(optRandom);
    
    select.value = Utils.Store.get('autoHonor', 'mode') || 'allies';
    select.addEventListener('change', (e) => Utils.Store.set('autoHonor', 'mode', e.target.value));
    selectRow.appendChild(select);

    container.appendChild(selectRow);
    container.appendChild(Utils.Settings.createToggleRow('Skip Honor', Utils.Store.get('autoHonor', 'skip') || false, (next) => {
        Utils.Store.set('autoHonor', 'skip', next);
    }));
}

export function init(context) {
    Utils.Settings.inject(context, {
        name: "auto-honor-settings",
        titleKey: "snooze_auto-honor",
        titleName: "Auto Honor",
        capitalTitleKey: "snooze_auto-honor_capital",
        capitalTitleName: "AUTO HONOR",
        class: "auto-honor-settings"
    });

    isEnabled = Utils.Store.get('autoHonor', 'enabled') || false;

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'autoHonor',
            category: 'In-Game & Post-Game',
            name: 'Auto Honor',
            description: 'Automatically honors a teammate, enemy, or random player when the game finishes.',
            settings: [
                {
                    type: 'toggle',
                    id: 'sm:autoHonor',
                    label: 'Enable Auto Honor',
                    description: 'Casts honor votes at end of game based on the mode set below',
                    value: isEnabled,
                    onChange: (val) => toggleFeature(val)
                },
                {
                    type: 'custom',
                    render: (row) => renderExtraSettings(row)
                }
            ]
        });
    } else {
        Utils.DOM.observer.observe("lol-uikit-scrollable.auto-honor-settings", (plugin) => {
            const mainToggle = Utils.Settings.createToggleRow('Enable Auto Honor', isEnabled, (next) => {
                isEnabled = next;
                toggleFeature(next);
            });
            mainToggle.classList.add('plugins-settings-row');
            plugin.appendChild(mainToggle);

            const extraRow = document.createElement("div");
            extraRow.classList.add("plugins-settings-row");
            extraRow.style.marginTop = "10px";
            renderExtraSettings(extraRow);
            plugin.appendChild(extraRow);
        });
    }
}

/**
 * If the ballot is not immediately ready, we register a WebSocket observer and resolve & unsubscribe the moment the LCU populates it.
 */
function getValidBallot() {
    return new Promise(async (resolve) => {
        let settled = false;
        let disconnect = null;
        const isValid = (b) => !!(b && (b.eligibleAllies?.length || b.eligibleOpponents?.length));
        const finish = (ballot) => {
            if (settled) return;
            settled = true;
            if (disconnect) disconnect();
            resolve(ballot);
        };

        const initialBallot = await Utils.LCU.get('/lol-honor-v2/v1/ballot').catch(() => null);
        if (isValid(initialBallot)) {
            Utils.Debug.log('[AutoHonor] Ballot already loaded and valid.');
            finish(initialBallot);
            return;
        }

        Utils.Debug.log('[AutoHonor] Ballot not ready yet. Subscribing to LCU WebSocket...');
        disconnect = Utils.LCU.observe('/lol-honor-v2/v1/ballot', (event) => {
            if (isValid(event.data)) {
                Utils.Debug.log('[AutoHonor] Socket event received: Ballot populated.');
                finish(event.data);
            }
        });

        // Re-check once after subscribing: the ballot can populate in the gap between
        // the initial GET returning empty and the observer attaching, which would
        // otherwise leave this promise waiting for an event that already fired.
        const recheck = await Utils.LCU.get('/lol-honor-v2/v1/ballot').catch(() => null);
        if (isValid(recheck)) {
            Utils.Debug.log('[AutoHonor] Ballot populated during subscribe window (re-check).');
            finish(recheck);
            return;
        }

        // Fallback so the honor sequence never hangs forever if no event arrives.
        setTimeout(() => {
            if (settled) return;
            Utils.Debug.warn('[AutoHonor] Ballot wait timed out; resolving with last known ballot.');
            finish(recheck || initialBallot);
        }, 5000);
    });
}

async function autoHonorTeammate() {
    const currentEnabled = Utils.Store.get('autoHonor', 'enabled');
    if (!currentEnabled) {
        //Utils.Debug.log('[AutoHonor] Process skipped: Auto-honor is disabled in settings.');
        return;
    }
    if (!Utils.LCU) {
        Utils.Debug.error('[AutoHonor] Process aborted: LCU utilities context is uninitialized.');
        return;
    }

    Utils.Debug.log('[AutoHonor] Commencing auto-honor sequence...');

    let cancelled = false;
    const unregisterPanic = Utils.Panic.register(() => {
        cancelled = true;
        Utils.Debug.log('[AutoHonor] Panic triggered — aborting honor sequence.');
    });

    try {
        const skip = Utils.Store.get('autoHonor', 'skip') || false;

        // Wait for the LCU to populate the ballot
        const ballot = await getValidBallot();
        if (!ballot || cancelled) return;

        if (skip) {
            Utils.Debug.info('[AutoHonor] Skip Honor is active. Requesting direct skip via LCU...');
            await Utils.LCU.post('/lol-honor-v2/v1/honor-player', {
                honorCategory: '',
                summonerId: 0
            }).catch(err => {
                Utils.Debug.error('[AutoHonor] Skip request rejected by LCU:', err);
            });
        } else {
            // Pick candidates
            const mode = Utils.Store.get('autoHonor', 'mode') || 'allies';
            let candidates = [];
            
            if (mode === 'allies') candidates = ballot.eligibleAllies || [];
            else if (mode === 'enemies') candidates = ballot.eligibleOpponents || [];
            else if (mode === 'random') candidates = [...(ballot.eligibleAllies || []), ...(ballot.eligibleOpponents || [])];
            
            const voteCount = ballot.votePool?.votes || 1;
            Utils.Debug.log(`[AutoHonor] Target mode is set to: "${mode}". Total matches found: ${candidates.length}. Actionable votes: ${voteCount}`);

            if (candidates && candidates.length > 0) {
                // Shuffle candidates
                const shuffled = [...candidates].sort(() => 0.5 - Math.random());
                const totalVotes = Math.min(voteCount, shuffled.length);

                // Cast votes sequentially. Multi-vote ballots (voteCount > 1) share a
                // single ballot version, so firing the POSTs in parallel can have the
                // LCU reject/ignore votes cast against a stale version. A small gap
                // between votes lets each one commit before the next.
                for (let i = 0; i < totalVotes; i++) {
                    if (cancelled) {
                        Utils.Debug.log('[AutoHonor] Vote loop aborted via Panic Key.');
                        return;
                    }

                    const target = shuffled[i];
                    const targetName = target.summonerName || target.gameName || target.puuid;

                    Utils.Debug.info(`[AutoHonor] [Vote ${i + 1}/${totalVotes}] Casting HEART vote for: ${targetName}`);

                    try {
                        await Utils.LCU.post('/lol-honor/v1/honor', {
                            honorType: 'HEART',
                            recipientPuuid: target.puuid
                        });
                        Utils.Debug.log(`[AutoHonor] Successfully cast vote for: ${targetName}`);
                    } catch (err) {
                        Utils.Debug.error(`[AutoHonor] Vote failed for: ${targetName}`, err);
                    }

                    if (i < totalVotes - 1) await new Promise(r => setTimeout(r, 200));
                }
            } else {
                Utils.Debug.warn('[AutoHonor] No eligible candidates found matching the selected mode.');
            }
        }

        if (cancelled) return;

        // finalize the ballot
        Utils.Debug.log('[AutoHonor] Committing/Finalizing ballot...');
        await Utils.LCU.post('/lol-honor/v1/ballot').then(response => {
            Utils.Debug.log('[AutoHonor] Ballot finalized successfully.', response);
        }).catch(err => {
            Utils.Debug.error('[AutoHonor] Ballot finalization failed:', err);
        });

        // Automatically acknowledge honor level changes if pending
        await Utils.LCU.post('/lol-honor-v2/v1/level-change/ack').catch(() => {});

    } catch(err) {
        Utils.Debug.error('[AutoHonor] Critical error encountered during runtime:', err);
    } finally {
        unregisterPanic();
    }
}

export function load() {
    if (Utils.LCU && Utils.LCU.observe) {
        Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', e => {
            //Utils.Debug.log('[AutoHonor] Gameflow phase transition detected:', e.data);
            
            const isHonorPhase = e.data === 'PreEndOfGame' || e.data === 'EndOfGame';
            if (!isHonorPhase && e.data !== 'WaitingForStats') {
                /* if (honorAttemptedForCurrentGame) {
                    Utils.Debug.log('[AutoHonor] Transitioned out of postgame. Clearing active session tracking flags.');
                } */
                honorAttemptedForCurrentGame = false;
            }

            const currentEnabled = Utils.Store.get('autoHonor', 'enabled');
            if (!currentEnabled) return;
            if (isHonorPhase) {
                if (honorAttemptedForCurrentGame) {
                    //Utils.Debug.log('[AutoHonor] Postgame lobby detected, but action has already processed for this game session.');
                    return;
                }
                Utils.Debug.info('[AutoHonor] Reached Postgame! Directing execution thread to autoHonorTeammate().');
                honorAttemptedForCurrentGame = true;
                autoHonorTeammate();
            }
        });
    }
}