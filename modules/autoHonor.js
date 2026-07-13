/**
 * @name Snooze-AutoHonor
 * @version 1.0.2
 * @author SnoozeFest - github@ReformedDoge
 * @description Automatically honor players after matches with optional contribution-based selection and score display.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';

let isEnabled = false;
let honorAttemptedForCurrentGame = false;
let eogStatsCache = null;

function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set('autoHonor', 'enabled', enabled);
}

function getDelay() {
    return Utils.Store.get('autoHonor', 'delayMs') || 200;
}

function uncheckToggleRow(row) {
    const cb = row?.querySelector('input[type="checkbox"]');
    if (cb) {
        cb.checked = false;
        const wrapper = cb.closest('lol-uikit-flat-checkbox');
        if (wrapper) wrapper.classList.remove('checked');
    }
}

async function getEogStatsBlock() {
    if (eogStatsCache) return eogStatsCache;
    const data = await Utils.LCU.get('/lol-end-of-game/v1/eog-stats-block').catch(() => null);
    if (data?.teams?.length) {
        eogStatsCache = data;
        Utils.Debug.log('[AutoHonor] eogStatsBlock cached successfully.');
    }
    return eogStatsCache;
}

function getScores(eogStats) {
    // Returns a Map<puuid, { score, kda, kills, deaths, assists, _scoreRatio }>
    if (!eogStats?.teams?.length) return new Map();
    return Utils.Scoring.computeScores(Utils.Scoring.normalizeEogStats(eogStats));
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

    // Delay between votes
    const delayRow = document.createElement('div');
    Object.assign(delayRow.style, { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '5px' });

    const delayLabel = document.createElement('span');
    delayLabel.textContent = 'Delay between votes (ms)';
    Object.assign(delayLabel.style, { color: '#a09b8c', fontSize: '12px', whiteSpace: 'nowrap' });

    const delayInput = document.createElement('input');
    delayInput.type = 'number';
    delayInput.min = '0';
    delayInput.max = '5000';
    delayInput.step = '50';
    delayInput.value = String(getDelay());
    Object.assign(delayInput.style, {
        background: '#111',
        border: '1px solid #3e2e13',
        color: '#f0e6d2',
        padding: '5px 8px',
        borderRadius: '2px',
        outline: 'none',
        width: '70px',
        fontSize: '13px'
    });

    delayInput.addEventListener('click', (e) => e.stopPropagation());
    delayInput.addEventListener('change', () => {
        let v = parseInt(delayInput.value, 10);
        if (!isFinite(v)) v = 0;
        v = Math.min(5000, Math.max(0, v));
        delayInput.value = String(v);
        Utils.Store.set('autoHonor', 'delayMs', v);
    });

    delayRow.appendChild(delayLabel);
    delayRow.appendChild(delayInput);
    container.appendChild(delayRow);

    // Skip Honor toggle
    const skipRow = Utils.Settings.createToggleRow('Skip Honor', Utils.Store.get('autoHonor', 'skip') || false, (next) => {
        Utils.Store.set('autoHonor', 'skip', next);
        if (next) {
            Utils.Store.set('autoHonor', 'prioritizeByContribution', false);
            uncheckToggleRow(container.querySelector('.ah-prioritize-toggle'));
        }
    });
    skipRow.classList.add('ah-skip-honor-row');
    container.appendChild(skipRow);

    // Prioritize by Contribution toggle (mutually exclusive with Skip Honor)
    const prioRow = Utils.Settings.createToggleRow('Prioritize by Contribution', Utils.Store.get('autoHonor', 'prioritizeByContribution') || false, (next) => {
        Utils.Store.set('autoHonor', 'prioritizeByContribution', next);
        if (next) {
            Utils.Store.set('autoHonor', 'skip', false);
            uncheckToggleRow(container.querySelector('.ah-skip-honor-row'));
        }
    });
    prioRow.classList.add('ah-prioritize-toggle');
    container.appendChild(prioRow);
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

    const showScoreOnCard = Utils.Store.get('autoHonor', 'showScoreOnCard') || false;

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
                },
                {
                    type: 'toggle',
                    id: 'sm:showScoreOnCard',
                    label: 'Show KDA & Score on Honor Card',
                    value: showScoreOnCard,
                    onChange: (val) => Utils.Store.set('autoHonor', 'showScoreOnCard', val)
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

            const scoreRow = Utils.Settings.createToggleRow('Show KDA & Score on Honor Card', showScoreOnCard, (next) => {
                Utils.Store.set('autoHonor', 'showScoreOnCard', next);
            });
            scoreRow.classList.add('plugins-settings-row');
            scoreRow.style.marginTop = '10px';
            plugin.appendChild(scoreRow);
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
        const prioritize = Utils.Store.get('autoHonor', 'prioritizeByContribution') || false;

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
                let selectedCandidates = candidates;

                if (prioritize) {
                    Utils.Debug.log('[AutoHonor] Prioritize by Contribution enabled. Fetching stats...');
                    const eogStats = await getEogStatsBlock();
                    if (eogStats) {
                        const scoresMap = getScores(eogStats);
                        selectedCandidates = candidates.map(c => {
                            const s = scoresMap.get(c.puuid);
                            return {
                                ...c,
                                _score: s?.score || 0,
                                _kda: s?.kda || '0.0'
                            };
                        });
                        selectedCandidates.sort((a, b) => b._score - a._score);
                        Utils.Debug.log('[AutoHonor] Priority order:', selectedCandidates.map(c =>
                            `${c.summonerName || c.gameName || c.puuid}: score=${c._score} KDA=${c._kda}`
                        ));
                    } else {
                        Utils.Debug.warn('[AutoHonor] Could not fetch eogStatsBlock for scoring. Falling back to random selection.');
                    }
                }

                if (!prioritize || !selectedCandidates[0]?._score) {
                    selectedCandidates = [...selectedCandidates].sort(() => 0.5 - Math.random());
                }

                const totalVotes = Math.min(voteCount, selectedCandidates.length);

                // Cast votes sequentially. Multi-vote ballots (voteCount > 1) share a
                // single ballot version, so firing the POSTs in parallel can have the
                // LCU reject/ignore votes cast against a stale version. A small gap
                // between votes lets each one commit before the next.
                for (let i = 0; i < totalVotes; i++) {
                    if (cancelled) {
                        Utils.Debug.log('[AutoHonor] Vote loop aborted via Panic Key.');
                        return;
                    }

                    const target = selectedCandidates[i];
                    const targetName = target.summonerName || target.gameName || target.puuid;
                    const scoreInfo = target._score ? ` (score: ${target._score}, KDA: ${target._kda})` : '';

                    Utils.Debug.info(`[AutoHonor] [Vote ${i + 1}/${totalVotes}] Casting HEART vote for: ${targetName}${scoreInfo}`);

                    try {
                        await Utils.LCU.post('/lol-honor/v1/honor', {
                            honorType: 'HEART',
                            recipientPuuid: target.puuid
                        });
                        Utils.Debug.log(`[AutoHonor] Successfully cast vote for: ${targetName}`);
                    } catch (err) {
                        Utils.Debug.error(`[AutoHonor] Vote failed for: ${targetName}`, err);
                    }

                    if (i < totalVotes - 1) await new Promise(r => setTimeout(r, getDelay()));
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

function scoreColor(ratio) {
    // ratio 0 = worst (red), 0.5 = neutral (grey), 1 = best (vivid green)
    if (ratio >= 0.5) {
        const t = (ratio - 0.5) * 2;
        return `rgb(${Math.round(160 - t * 160)}, ${Math.round(160 + t * 60)}, ${Math.round(160 - t * 20)})`;
    } else {
        const t = ratio * 2;
        return `rgb(${Math.round(220 - t * 60)}, ${Math.round(60 + t * 100)}, ${Math.round(70 + t * 90)})`;
    }
}

function injectScoreOnHonorCard(element, puuid) {
    if (!element || !element.isConnected) return;
    if (element.querySelector('.ah-score-badge')) return;

    (async () => {
        try {
            if (!element || !element.isConnected) return;
            const eogStats = await getEogStatsBlock();
            if (!eogStats) return;
            if (!element || !element.isConnected) return;

            const scoresMap = getScores(eogStats);
            const rating = scoresMap.get(puuid);
            if (!rating) return;

            if (!element || !element.isConnected) return;
            if (element.querySelector('.ah-score-badge')) return;

            const wrapper = element.querySelector('.vote-ceremony-candidate-champ-image-wrapper');
            if (!wrapper) return;

            const color = scoreColor(rating._scoreRatio);

            const chip = document.createElement('div');
            chip.className = 'ah-score-badge';
            chip.style.cssText = 'position:absolute;top:6px;right:6px;background:rgba(10,10,22,0.75);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);border-radius:4px;padding:4px 7px;text-align:center;line-height:1.4;pointer-events:none;z-index:10;';

            chip.innerHTML = `
                <div style="color:#e8d5a3;font-weight:700;font-size:11px;letter-spacing:0.3px;text-shadow:0 0 4px rgba(0,0,0,0.9),0 0 2px rgba(0,0,0,0.9);">${rating.kills}/${rating.deaths}/${rating.assists}</div>
                <div style="font-size:9px;display:flex;gap:6px;justify-content:center;">
                    <span style="font-weight:600;text-shadow:0 0 3px rgba(0,0,0,0.9);color:#c0b89a;">${rating.kda} KDA</span>
                    <span style="color:${color};font-weight:700;text-shadow:0 0 3px rgba(0,0,0,0.9),0 0 6px ${color}80;">Score: ${rating.score}</span>
                </div>
            `;

            wrapper.style.position = 'relative';
            wrapper.appendChild(chip);
        } catch (e) {
            Utils.Debug.warn('[AutoHonor] Score injection failed:', e);
        }
    })();
}

export function load() {
    Utils.Debug.log('[AutoHonor] Module loaded.');

    // Inject badge font to resist theme font overrides
    if (!document.getElementById('ah-badge-font')) {
        const s = document.createElement('style');
        s.id = 'ah-badge-font';
        s.textContent = '.ah-score-badge,.ah-score-badge *{font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif !important}';
        document.head.appendChild(s);
    }

    const scoreOnCard = () => Utils.Store.get('autoHonor', 'showScoreOnCard');

    // Pre-populate eogStatsBlock cache via WS observation (fast path) — only
    // subscribe when there's a reason to (matches the project's convention of
    // not firing unneeded LCU/WS listeners while a feature is off).
    if (Utils.LCU?.observe && (Utils.Store.get('autoHonor', 'enabled') || scoreOnCard())) {
        const statsUnsub = Utils.LCU.observe('/lol-end-of-game/v1/eog-stats-block', (event) => {
            if (event.data?.teams?.length) {
                eogStatsCache = event.data;
                Utils.Debug.log('[AutoHonor] eogStatsBlock cached via WS push.');
                statsUnsub();
            }
        });
    }

    if (Utils.LCU && Utils.LCU.observe) {
        Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', e => {
            //Utils.Debug.log('[AutoHonor] Gameflow phase transition detected:', e.data);

            const isHonorPhase = e.data === 'PreEndOfGame' || e.data === 'EndOfGame';
            if (!isHonorPhase && e.data !== 'WaitingForStats') {
                /* if (honorAttemptedForCurrentGame) {
                    Utils.Debug.log('[AutoHonor] Transitioned out of postgame. Clearing active session tracking flags.');
                } */
                honorAttemptedForCurrentGame = false;
                eogStatsCache = null;
            }

            // Try to eagerly cache eogStatsBlock when phase changes
            if (['PreEndOfGame', 'WaitingForStats', 'EndOfGame'].includes(e.data) && !eogStatsCache) {
                Utils.LCU.get('/lol-end-of-game/v1/eog-stats-block').then(data => {
                    if (data?.teams?.length) eogStatsCache = data;
                }).catch(() => {});
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

    // Register Ember hook for showing KDA/score on honor cards — only when toggle is on
    if (Utils.Hooks?.Ember?.registerRule && scoreOnCard()) {
        Utils.Hooks.Ember.registerRule({
            name: 'ah-honor-card-score',
            matcher: (args) => {
                for (const a of args) {
                    if (a && typeof a === 'object' && a.baseClassName === 'vote-ceremony-player-card') {
                        return true;
                    }
                }
                return false;
            },
            mixin() {
                return {
                    didRender() {
                        this._super(...arguments);
                        if (!this.element || !scoreOnCard()) return;
                        if (this.element.querySelector('.ah-score-badge')) return;

                        const candidate = this.get && this.get('candidate');
                        if (!candidate?.puuid) return;

                        Utils.Debug.log('[AutoHonor] Injecting score badge for', candidate.puuid);
                        injectScoreOnHonorCard(this.element, candidate.puuid);
                    }
                };
            }
        });
        Utils.Debug.log('[AutoHonor] Honor card score display hook registered.');
    }
}