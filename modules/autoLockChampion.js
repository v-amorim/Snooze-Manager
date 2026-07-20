/**
 * @name Snooze-AutoLockChampion
 * @version 1.0.1
 * @author SnoozeFest - github@ReformedDoge
 * @description Auto-locks priority champions during champ select with role-specific picks and bans.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';

let isEnabled = false;
let autoLockSessionUnsub = null;
let lastAutoLockKeys = new Map();
let lastBanDebugKey = '';

let currentSummonerId = null;
let currentPuuid = null;
let emberTimerMs = null;
let lastSessionData = null;
let emberTimerCrossed = false;
let unregisterPanic = null;
let panicActive = false;
let actionActiveStartTimes = new Map();
let bannableChampionSet = null;
let bannableChampUnsub = null;
let pickableChampionSet = null;
let pickableChampUnsub = null;
let teammateIntents = new Set(); // championPickIntent > 0 from teammates
let pluginPickSelectionId = null; // championId we last selected via PATCH (manual pick detection)
let manuallyOverriddenActionIds = new Set(); // action IDs the user manually changed (per-action override tracking)

const MAX_PRIORITY_CHAMPS = 3;
const PICK_PRIORITY_KEY = 'pickIds';
const BAN_PRIORITY_KEY = 'banIds';
const LOCK_MODE_KEY = 'lockMode';
const LOCK_TIME_KEY = 'lockTime';
const LOCK_TIME_MIN = 0;
const LOCK_TIME_MAX = 60;

function fetchCurrentSummoner() {
    if (currentSummonerId && currentPuuid) return;
    if (!Utils.LCU) return;
    Utils.LCU.get('/lol-summoner/v1/current-summoner').then(me => {
        if (me) {
            currentSummonerId = me.summonerId;
            currentPuuid = me.puuid;
        }
    }).catch(()=>{});
}

function getLockSettings() {
    const mode = Utils.Store.get('autoLockChampion', LOCK_MODE_KEY) === 'after' ? 'after' : 'before';
    const time = Number(Utils.Store.get('autoLockChampion', LOCK_TIME_KEY));
    const timeMs = isFinite(time) ? Math.min(LOCK_TIME_MAX, Math.max(LOCK_TIME_MIN, time)) * 1000 : 0;
    return { mode, timeMs };
}

function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set('autoLockChampion', 'enabled', enabled);
    if (enabled) mountAutoLockChampion();
    else unmountAutoLockChampion();
}

function asChampionList(value) {
    const raw = Array.isArray(value) ? value : (value ? [value] : []);
    const seen = new Set();
    const ids = [];

    raw.forEach((item) => {
        const id = Number(item);
        if (!id || seen.has(id)) return;
        seen.add(id);
        ids.push(id);
    });

    return ids.slice(0, MAX_PRIORITY_CHAMPS);
}

function getPriorityList(key, role = 'default') {
    const actualKey = role === 'default' ? key : `${key}_${role}`;
    const current = asChampionList(Utils.Store.get('autoLockChampion', actualKey));

    if (key === PICK_PRIORITY_KEY && current.length === 0 && role === 'default') {
        const legacyPick = Number(Utils.Store.get('autoLockChampion', 'legacyPickId'));
        if (legacyPick) {
            Utils.Store.set('autoLockChampion', actualKey, [legacyPick]);
            Utils.Store.remove('autoLockChampion', 'legacyPickId');
            return [legacyPick];
        }
    }

    return current;
}

function setPriorityList(key, role, ids) {
    const actualKey = role === 'default' ? key : `${key}_${role}`;
    Utils.Store.set('autoLockChampion', actualKey, asChampionList(ids));
}

function getChampionName(champions, id) {
    return champions.find((champ) => Number(champ.id) === Number(id))?.name || `Champion ${id}`;
}

function styleButton(button, compact = false) {
    Object.assign(button.style, {
        background: '#1e2328',
        color: '#c8aa6e',
        border: '1px solid #785a28',
        borderRadius: '2px',
        cursor: 'pointer',
        padding: compact ? '2px 6px' : '6px 10px',
        fontSize: compact ? '11px' : '12px',
        lineHeight: '1.2'
    });
}

function renderPriorityPicker(container, labelText, storeKey, role, champions) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '6px' });

    const label = document.createElement('div');
    label.textContent = labelText;
    Object.assign(label.style, { color: '#f0e6d2', fontSize: '12px', fontWeight: 'bold' });

    const chips = document.createElement('div');
    Object.assign(chips.style, { display: 'flex', gap: '6px', flexWrap: 'wrap', minHeight: '28px' });

    const controlRow = document.createElement('div');
    Object.assign(controlRow.style, { display: 'flex', gap: '6px', width: '100%' });

    const select = document.createElement('select');
    Object.assign(select.style, {
        background: '#111',
        color: '#f0e6d2',
        border: '1px solid #3e2e13',
        padding: '6px',
        borderRadius: '2px',
        flex: '1',
        outline: 'none',
        minWidth: '0'
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = 'Add';
    styleButton(addBtn);

    function paint() {
        const selected = getPriorityList(storeKey, role);
        chips.innerHTML = '';
        select.innerHTML = '';

        champions
            .filter((champ) => champ.id > 0 && !selected.includes(Number(champ.id)))
            .forEach((champ) => {
                const opt = document.createElement('option');
                opt.value = champ.id;
                opt.textContent = champ.name;
                select.appendChild(opt);
            });

        selected.forEach((id, index) => {
            const chip = document.createElement('span');
            Object.assign(chip.style, {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                background: '#111',
                color: '#f0e6d2',
                border: '1px solid #785a28',
                borderRadius: '2px',
                padding: '4px 6px',
                fontSize: '12px',
                maxWidth: '100%'
            });

            const rank = document.createElement('strong');
            rank.textContent = `${index + 1}`;
            Object.assign(rank.style, { color: '#0ac8b9', fontSize: '11px' });

            const name = document.createElement('span');
            name.textContent = getChampionName(champions, id);
            Object.assign(name.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

            const up = document.createElement('button');
            up.type = 'button';
            up.textContent = 'Up';
            up.title = 'Higher priority';
            styleButton(up, true);
            up.disabled = index === 0;
            up.style.opacity = up.disabled ? '0.35' : '1';
            up.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const next = selected.slice();
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                setPriorityList(storeKey, role, next);
                paint();
            };

            const down = document.createElement('button');
            down.type = 'button';
            down.textContent = 'Dn';
            down.title = 'Lower priority';
            styleButton(down, true);
            down.disabled = index === selected.length - 1;
            down.style.opacity = down.disabled ? '0.35' : '1';
            down.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const next = selected.slice();
                [next[index], next[index + 1]] = [next[index + 1], next[index]];
                setPriorityList(storeKey, role, next);
                paint();
            };

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = 'x';
            remove.title = 'Remove';
            styleButton(remove, true);
            remove.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                setPriorityList(storeKey, role, selected.filter((champId) => champId !== id));
                paint();
            };

            chip.appendChild(rank);
            chip.appendChild(name);
            chip.appendChild(up);
            chip.appendChild(down);
            chip.appendChild(remove);
            chips.appendChild(chip);
        });

        addBtn.disabled = selected.length >= MAX_PRIORITY_CHAMPS || select.options.length === 0;
        addBtn.style.opacity = addBtn.disabled ? '0.45' : '1';
    }

    addBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = Number(select.value);
        if (!id) return;
        const selected = getPriorityList(storeKey, role);
        if (selected.length >= MAX_PRIORITY_CHAMPS || selected.includes(id)) return;
        setPriorityList(storeKey, role, [...selected, id]);
        paint();
    };

    controlRow.appendChild(select);
    controlRow.appendChild(addBtn);
    wrap.appendChild(label);
    wrap.appendChild(chips);
    wrap.appendChild(controlRow);
    container.appendChild(wrap);
    paint();
}

function renderExtraSettings(container) {
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.alignItems = 'stretch';
    container.style.gap = '10px';
    container.style.paddingLeft = '20px';
    container.style.marginTop = '0';
    container.style.borderLeft = '2px solid #3e2e13';

    // Role Select
    const roleRow = document.createElement('div');
    Object.assign(roleRow.style, { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '5px' });

    const roleLabel = document.createElement('span');
    roleLabel.textContent = 'Configure Role:';
    Object.assign(roleLabel.style, { color: '#a09b8c', fontSize: '12px', whiteSpace: 'nowrap' });

    const roleSelect = document.createElement('select');
    Object.assign(roleSelect.style, {
        background: '#111',
        border: '1px solid #3e2e13',
        color: '#f0e6d2',
        padding: '5px 8px',
        borderRadius: '2px',
        outline: 'none',
        fontSize: '13px'
    });

    const ROLES = [
        { id: 'default', label: 'Default / Any' },
        { id: 'top', label: 'Top' },
        { id: 'jungle', label: 'Jungle' },
        { id: 'middle', label: 'Middle' },
        { id: 'bottom', label: 'Bottom' },
        { id: 'utility', label: 'Support' }
    ];

    ROLES.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = r.label;
        roleSelect.appendChild(opt);
    });

    roleRow.appendChild(roleLabel);
    roleRow.appendChild(roleSelect);
    container.appendChild(roleRow);

    const pickerHost = document.createElement('div');
    Object.assign(pickerHost.style, { display: 'flex', flexDirection: 'column', gap: '10px' });
    container.appendChild(pickerHost);

    let cachedChamps = [];
    let selectedRoleConfig = 'default';

    function updatePickers() {
        pickerHost.innerHTML = '';
        if (cachedChamps.length) {
            renderPriorityPicker(pickerHost, 'Pick Priority', PICK_PRIORITY_KEY, selectedRoleConfig, cachedChamps);
            renderPriorityPicker(pickerHost, 'Ban Priority', BAN_PRIORITY_KEY, selectedRoleConfig, cachedChamps);
        }
    }

    roleSelect.addEventListener('change', () => {
        selectedRoleConfig = roleSelect.value;
        updatePickers();
    });

    // Lock Timing Mode Row
    const lockModeRow = document.createElement('div');
    Object.assign(lockModeRow.style, { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '5px' });

    const lockModeLabel = document.createElement('span');
    lockModeLabel.textContent = 'Auto Lock Timing:';
    Object.assign(lockModeLabel.style, { color: '#a09b8c', fontSize: '12px', whiteSpace: 'nowrap' });

    const lockModeSelect = document.createElement('select');
    Object.assign(lockModeSelect.style, {
        background: '#111',
        border: '1px solid #3e2e13',
        color: '#f0e6d2',
        padding: '5px 8px',
        borderRadius: '2px',
        outline: 'none',
        fontSize: '13px'
    });

    const modeOptBefore = document.createElement('option');
    modeOptBefore.value = 'before';
    modeOptBefore.textContent = 'Before turn ends';
    const modeOptAfter = document.createElement('option');
    modeOptAfter.value = 'after';
    modeOptAfter.textContent = 'After turn starts';
    lockModeSelect.appendChild(modeOptBefore);
    lockModeSelect.appendChild(modeOptAfter);
    lockModeSelect.value = getLockSettings().mode;

    lockModeSelect.addEventListener('click', (e) => e.stopPropagation());
    lockModeSelect.addEventListener('change', () => {
        Utils.Store.set('autoLockChampion', LOCK_MODE_KEY, lockModeSelect.value);
        lockLabel.textContent = lockModeSelect.value === 'after'
            ? 'Lock X seconds after turn starts (0 = instant)'
            : 'Lock in X seconds before turn ends (0 = instant)';
    });

    lockModeRow.appendChild(lockModeLabel);
    lockModeRow.appendChild(lockModeSelect);
    container.appendChild(lockModeRow);

    // Lock Time Input Row
    const lockRow = document.createElement('div');
    Object.assign(lockRow.style, { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '5px' });

    const lockLabel = document.createElement('span');
    lockLabel.textContent = getLockSettings().mode === 'after'
        ? 'Lock X seconds after turn starts (0 = instant)'
        : 'Lock in X seconds before turn ends (0 = instant)';
    Object.assign(lockLabel.style, { color: '#a09b8c', fontSize: '12px', whiteSpace: 'nowrap' });

    const lockInput = document.createElement('input');
    lockInput.type = 'number';
    lockInput.min = String(LOCK_TIME_MIN);
    lockInput.max = String(LOCK_TIME_MAX);
    lockInput.step = '0.5';
    lockInput.value = String(getLockSettings().timeMs / 1000);
    Object.assign(lockInput.style, {
        background: '#111',
        border: '1px solid #3e2e13',
        color: '#f0e6d2',
        padding: '5px 8px',
        borderRadius: '2px',
        outline: 'none',
        width: '70px',
        fontSize: '13px'
    });

    lockInput.addEventListener('click', (e) => e.stopPropagation());
    lockInput.addEventListener('change', () => {
        let v = parseFloat(lockInput.value);
        if (!isFinite(v)) v = 0;
        v = Math.min(LOCK_TIME_MAX, Math.max(LOCK_TIME_MIN, v));
        v = Math.round(v * 10) / 10;
        lockInput.value = String(v);
        Utils.Store.set('autoLockChampion', LOCK_TIME_KEY, v);
    });

    lockRow.appendChild(lockLabel);
    lockRow.appendChild(lockInput);
    container.appendChild(lockRow);

    if (Utils.LCU) {
        Utils.LCU.get('/lol-game-data/assets/v1/champion-summary.json').then(champs => {
            if (champs && champs.length) {
                cachedChamps = champs.filter(c => c.id > 0).sort((a,b) => a.name.localeCompare(b.name));
                updatePickers();
            }
        }).catch(()=>{});
    }

    const pickToggleRow = document.createElement('div');
    Object.assign(pickToggleRow.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginTop: '10px' });
    pickToggleRow.appendChild(Utils.Settings.createToggleRow('Auto Lock-in Pick', Utils.Store.get('autoLockChampion', 'instantPick') !== false, (next) => {
        Utils.Store.set('autoLockChampion', 'instantPick', next);
    }));
    container.appendChild(pickToggleRow);

    const banToggleRow = document.createElement('div');
    Object.assign(banToggleRow.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginTop: '10px' });
    banToggleRow.appendChild(Utils.Settings.createToggleRow('Auto Lock-in Ban', Utils.Store.get('autoLockChampion', 'instantBan') !== false, (next) => {
        Utils.Store.set('autoLockChampion', 'instantBan', next);
    }));
    container.appendChild(banToggleRow);

    const intentRow = document.createElement('div');
    Object.assign(intentRow.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginTop: '10px' });
    intentRow.appendChild(Utils.Settings.createToggleRow('Respect Team Intent', Utils.Store.get('autoLockChampion', 'respectTeamIntent') !== false, (next) => {
        Utils.Store.set('autoLockChampion', 'respectTeamIntent', next);
    }));
    container.appendChild(intentRow);

    const manualPickRow = document.createElement('div');
    Object.assign(manualPickRow.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginTop: '10px' });
    manualPickRow.appendChild(Utils.Settings.createToggleRow('Allow Manual Pick', Utils.Store.get('autoLockChampion', 'respectManualPick') !== false, (next) => {
        Utils.Store.set('autoLockChampion', 'respectManualPick', next);
    }));
    container.appendChild(manualPickRow);

    // Panic key lives in the Settings tab (shared with the menu shortcut); note it here
    const panicNote = document.createElement('div');
    Object.assign(panicNote.style, { color: '#8a9aaa', fontSize: '12px', marginTop: '12px', lineHeight: '1.4' });
    const panicKey = Utils.Store.get('global', 'panicKey') || 'F2';
    panicNote.textContent = `Panic Key (${panicKey}): press it during champion select to cancel auto-lock for that champ select only. Set the key in the Settings tab.`;
    container.appendChild(panicNote);

}

async function completePendingActions() {
    if (!isEnabled) return;
    // Fetch fresh session data to avoid stale lastSessionData
    const s = await Utils.LCU.get('/lol-champ-select/v1/session').catch(() => null);
    if (!s) return;
    lastSessionData = s;
    const allActions = s.actions ? s.actions.flat(2) : [];
    const myActions = allActions.filter(a => {
        if (a.actorCellId !== s.localPlayerCellId || a.completed) return false;
        if (a.type !== 'pick' && a.type !== 'ban') return false;
        return isActionActive(a, s);
    });
    if (myActions.length === 0) return;
    const lockSettings = getLockSettings();
    if (lockSettings.timeMs <= 0) return;
    const myPosition = resolveMyPosition(s);
    for (const action of myActions) {
        const champId = chooseChampionForAction(s, action, myPosition);
        if (!champId) continue;
        const shouldComplete = shouldCompleteAction(s, action, true, true, lockSettings);
        if (!shouldComplete) continue;
        if (action.type === 'ban' && getChampSelectPhase(s) !== 'BAN_PICK') continue;
        const now = Date.now();
        const lastPatchTime = lastAutoLockKeys.get(action.id + '_time') || 0;
        if (now - lastPatchTime < 1500) continue;
        lastAutoLockKeys.set(action.id + '_time', now);
        Utils.Debug.log(`[AutoSelect] Ember timer triggered lock for action ${action.id}`);
        Utils.LCU.patch(`/lol-champ-select/v1/session/actions/${action.id}`, { championId: champId, completed: true }).catch(() => {});
    }
}

function installEmberTimerHook() {
    Utils.Debug.log('[AutoSelect] installing Ember timer hook');
    Utils.Hooks.Ember.registerRule({
        name: 'sm-auto-lock-timer',
        matcher: 'champion-select',
        mixin() {
            return {
                didInsertElement() {
                    this._super(...arguments);
                    const t = this.get('session.timer.timeRemainingInMs');
                    Utils.Debug.log('[AutoSelect] EmberHook didInsertElement: timer=', t, 'session=', this.get('session'));
                    emberTimerMs = t;
                    this._smUpdateTimer = () => {
                        const v = this.get('session.timer.timeRemainingInMs');
                        emberTimerMs = v;
                        if (isEnabled && !panicActive) {
                            const lockSettings = getLockSettings();
                            if (lockSettings.mode === 'before' && lockSettings.timeMs > 0 && v !== null && v !== undefined) {
                                if (v <= lockSettings.timeMs && !emberTimerCrossed) {
                                    emberTimerCrossed = true;
                                    Utils.Debug.log('[AutoSelect] Ember timer crossed threshold, triggering lock');
                                    completePendingActions();
                                } else if (v > lockSettings.timeMs) {
                                    emberTimerCrossed = false;
                                }
                            }
                        }
                    };
                    this.addObserver('session.timer.timeRemainingInMs', this, '_smUpdateTimer');
                },
                willDestroyElement() {
                    Utils.Debug.log('[AutoSelect] EmberHook willDestroyElement');
                    this.removeObserver('session.timer.timeRemainingInMs', this, '_smUpdateTimer');
                    this._super(...arguments);
                }
            };
        }
    });
}

export function init(context) {
    installEmberTimerHook();

    // Migrate legacy "instant" toggle
    if (Utils.Store.get('autoLockChampion', 'instant') !== undefined) {
        const legacyInstant = Utils.Store.get('autoLockChampion', 'instant');
        if (Utils.Store.get('autoLockChampion', 'instantPick') === undefined) {
            Utils.Store.set('autoLockChampion', 'instantPick', legacyInstant);
        }
        if (Utils.Store.get('autoLockChampion', 'instantBan') === undefined) {
            Utils.Store.set('autoLockChampion', 'instantBan', legacyInstant);
        }
        Utils.Store.remove('autoLockChampion', 'instant');
    }

    // Migrate legacy "lockBeforeEnd" to new lock mode system
    if (Utils.Store.get('autoLockChampion', LOCK_TIME_KEY) === undefined) {
        const legacy = Utils.Store.get('autoLockChampion', 'lockBeforeEnd');
        Utils.Store.set('autoLockChampion', LOCK_TIME_KEY, legacy !== undefined ? legacy : 0);
    }
    if (Utils.Store.get('autoLockChampion', LOCK_MODE_KEY) === undefined) {
        Utils.Store.set('autoLockChampion', LOCK_MODE_KEY, 'before');
    }

    Utils.Settings.inject(context, {
        name: "autolock-settings",
        titleKey: "snooze_autolock",
        titleName: "Auto Select Champ",
        capitalTitleKey: "snooze_autolock_capital",
        capitalTitleName: "AUTO SELECT CHAMP",
        class: "autolock-settings"
    });

    isEnabled = Utils.Store.get('autoLockChampion', 'enabled') || false;

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'autoLockChampion',
            category: 'Champion Select',
            name: 'Auto Select Champion',
            description: 'Automatically hovers, locks, or bans champions by priority & role in champion select, with separate top-3 priority lists per role.',
            settings: [
                {
                    type: 'toggle',
                    id: 'sm:autoLockChampion',
                    label: 'Enable Auto Select Champion',
                    description: 'Runs the pick and ban automation during champion select',
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
        Utils.DOM.observer.observe("lol-uikit-scrollable.autolock-settings", (plugin) => {
            const mainToggle = Utils.Settings.createToggleRow('Enable Auto Select Champion', isEnabled, (next) => {
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

function resolveMyPosition(s) {
    let myPosition = 'default';
    if (s.myTeam) {
        const me = s.myTeam.find(p =>
            (currentPuuid && p.puuid === currentPuuid) ||
            (currentSummonerId && p.summonerId === currentSummonerId) ||
            (p.cellId === s.localPlayerCellId)
        );
        if (me && me.assignedPosition) {
            myPosition = me.assignedPosition;
        }
    }
    return myPosition || 'default';
}

async function processChampSelectSession(s) {
    if (!isEnabled || !s) return;

    // Utils.Panic clears every registered callback (from any module) on a single
    // press, so re-arm here rather than only once at mount - otherwise pressing
    // panic for an unrelated auto-action permanently drops auto-lock's hook.
    unregisterPanic = Utils.Panic.register(panic);

    if (panicActive) {
        if (lastSessionData && s.gameId === lastSessionData.gameId) return;
        panicActive = false;
        Utils.Debug.log('[AutoSelect] New champ select session, auto-lock re-enabled');
    }

    if (manuallyOverriddenActionIds.size > 0 && lastSessionData && s.gameId !== lastSessionData.gameId) {
        manuallyOverriddenActionIds.clear();
        pluginPickSelectionId = null;
        Utils.Debug.log('[AutoSelect] New champ select session, manual override reset');
    }

    lastSessionData = s;

    Utils.Debug.log('[AutoSelect] processChampSelectSession: timer=', s?.timer, 'phase=', s?.phase);

    fetchCurrentSummoner();

    const myPosition = resolveMyPosition(s);

    // Collect teammate championPickIntent for team intent awareness
    teammateIntents = new Set();
    if (s.myTeam) {
        s.myTeam.forEach(p => {
            const isLocal = (currentPuuid && p.puuid === currentPuuid) ||
                (currentSummonerId && p.summonerId === currentSummonerId) ||
                (p.cellId === s.localPlayerCellId);
            if (!isLocal) {
                const intent = Number(p.championPickIntent);
                if (intent > 0) teammateIntents.add(intent);
            }
        });
    }

    // Check for manual user override (per-action: user changed a champion the plugin set)
    if (Utils.Store.get('autoLockChampion', 'respectManualPick') !== false) {
        const allActions = s.actions ? s.actions.flat(2) : [];
        for (const action of allActions) {
            if (action.actorCellId === s.localPlayerCellId && !action.completed && (action.type === 'pick' || action.type === 'ban')) {
                const currentId = Number(action.championId || 0);
                if (currentId && pluginPickSelectionId !== null && currentId !== pluginPickSelectionId) {
                    manuallyOverriddenActionIds.add(action.id);
                    Utils.Debug.log(`[AutoSelect] Manual override detected: action ${action.id} (${action.type}) championId=${currentId} !== plugin=${pluginPickSelectionId}, backing off`);
                }
            }
        }
    }

    const allActions = s.actions ? s.actions.flat(2) : [];
    logBanSessionState(s, allActions, myPosition);

    const myActions = allActions.filter(a => {
        if (a.actorCellId !== s.localPlayerCellId || a.completed) return false;
        if (a.type !== 'pick' && a.type !== 'ban') return false;

        if (isActionActive(a, s)) return true;
        if (a.type === 'pick' && getChampSelectPhase(s) === 'PLANNING') return true;

        return false;
    });

    if (myActions.length === 0) {
      lastAutoLockKeys.clear();
      actionActiveStartTimes.clear();
      return;
    }

    const instantPick = Utils.Store.get('autoLockChampion', 'instantPick') !== false;
    const instantBan = Utils.Store.get('autoLockChampion', 'instantBan') !== false;
    const lockSettings = getLockSettings();

    for (const action of myActions) {
      if (manuallyOverriddenActionIds.has(action.id)) {
          Utils.Debug.log(`[AutoSelect] manually overridden: skipping action ${action.id} (${action.type})`);
          continue;
      }

      const champId = chooseChampionForAction(s, action, myPosition);
      if (!champId) continue;

      if (!actionActiveStartTimes.has(action.id)) {
          actionActiveStartTimes.set(action.id, Date.now());
          if (lockSettings.mode === 'after' && lockSettings.timeMs > 0) {
              setTimeout(() => {
                  if (!isEnabled || panicActive || !lastSessionData) return;
                  processChampSelectSession(lastSessionData);
              }, lockSettings.timeMs + 50);
          }
      }

      const shouldComplete = shouldCompleteAction(s, action, instantPick, instantBan, lockSettings);

      if (action.championId === champId && action.completed === shouldComplete) {
          continue;
      }

      const now = Date.now();
      const lastPatchTime = lastAutoLockKeys.get(action.id + '_time') || 0;
      const cooldownMs = 1500;

      if (now - lastPatchTime < cooldownMs) {
          continue;
      }

      lastAutoLockKeys.set(action.id + '_time', now);

      const payload = {
          championId: champId,
          completed: shouldComplete
      };

      try {
          Utils.Debug.log(`[AutoSelect] ${action.type} patch`, {
              actionId: action.id,
              phase: getChampSelectPhase(s),
              active: isActionActive(action, s),
              payload
          });

          await Utils.LCU.patch(`/lol-champ-select/v1/session/actions/${action.id}`, payload);
          pluginPickSelectionId = champId;
      } catch (err) {
          Utils.Debug.warn(`[AutoSelect] ${action.type} patch failed`, {
              actionId: action.id,
              phase: getChampSelectPhase(s),
              payload,
              err
          });
      }
    }
}

function getChampSelectPhase(session) {
    return session?.timer?.phase || session?.phase || 'unknown';
}

/**
 * Returns the set of active (in-progress, non-completed) actions from the session.
 * finds the first action set where not all actions are completed,
 * then returns only the non-completed actions within it.
 */
function getCurrentActiveActions(session) {
    const actions = session?.actions;
    if (!Array.isArray(actions)) return [];
    for (const actionSet of actions) {
        if (Array.isArray(actionSet) && actionSet.length > 0) {
            const allCompleted = actionSet.every(a => a.completed);
            if (!allCompleted) {
                return actionSet.filter(a => !a.completed);
            }
        }
    }
    return [];
}

/**
 * Checks if an action is "active" aka the player can act on it. (find first incomplete set, then non-completed actions within it).
 * Fallback: the raw API's `isInProgress` field
 */
function isActionActive(action, session) {
    if (!action || action.completed) return false;
    const active = getCurrentActiveActions(session);
    const viaSet = active.some(a => a.id === action.id);
    if (!viaSet) return !!action.isInProgress;
    return true;
}

function shouldCompleteAction(session, action, instantPick, instantBan, lockSettings) {
    // Arena's freeform pick window has no per-player turn order, so picks never
    // go active — mirror the same PLANNING carve-out the caller's
    // eligibility filter uses, or these actions could hover but never lock in.
    const isEligible = isActionActive(action, session) || (action.type === 'pick' && getChampSelectPhase(session) === 'PLANNING');
    if (!isEligible) return false;

    if (lockSettings.timeMs > 0) {
        if (lockSettings.mode === 'after') {
            const startTs = actionActiveStartTimes.get(action.id);
            if (!startTs) return false;
            const elapsed = Date.now() - startTs;
            const shouldComplete = elapsed >= lockSettings.timeMs;
            // Classic Draft/Ranked report the ban window as 'BAN_PICK'; Arena's
            // single-phase flow reports the same window as 'PLANNING'.
            if (shouldComplete && action.type === 'ban') {
                const phase = getChampSelectPhase(session);
                if (phase !== 'BAN_PICK' && phase !== 'PLANNING') return false;
            }
            Utils.Debug.log(`[AutoSelect] lockAfterStart: elapsed=${elapsed}ms, threshold=${lockSettings.timeMs}ms, complete=${shouldComplete}`);
            return shouldComplete;
        }

        let timerSrc = 'none';
        let timeRemaining = null;

        // Raw session snapshot + elapsed time (fresh LCU push, accounts for elapsed time even with stale session)
        if (session?.timer?.adjustedTimeLeftInPhase !== undefined && session?.timer?.internalNowInEpochMs !== undefined) {
            timeRemaining = Math.max(session.timer.adjustedTimeLeftInPhase - (Date.now() - session.timer.internalNowInEpochMs), 0);
            timerSrc = 'raw-adjusted';
        }
        // Ember timer fallback (when raw session lacks timer data)
        if (timeRemaining === null && emberTimerMs !== null && emberTimerMs !== undefined) {
            timeRemaining = emberTimerMs;
            timerSrc = 'ember';
        }
        // raw snapshot value directly
        if (timeRemaining === null && session?.timer?.adjustedTimeLeftInPhase !== undefined) {
            timeRemaining = session.timer.adjustedTimeLeftInPhase;
            timerSrc = 'raw-snapshot';
        }

        if (timeRemaining !== null) {
            const shouldComplete = timeRemaining <= lockSettings.timeMs;
            // Classic Draft/Ranked report the ban window as 'BAN_PICK'; Arena's
            // single-phase flow reports the same window as 'PLANNING'.
            if (shouldComplete && action.type === 'ban') {
                const phase = getChampSelectPhase(session);
                if (phase !== 'BAN_PICK' && phase !== 'PLANNING') return false;
            }
            Utils.Debug.log(`[AutoSelect] lockBeforeEnd: timer=${timeRemaining}ms, threshold=${lockSettings.timeMs}ms, complete=${shouldComplete}, src=${timerSrc}`);
            return shouldComplete;
        }
        Utils.Debug.warn('[AutoSelect] lockBeforeEnd enabled but no timer source available, falling through to instant');
    }

    const phase = getChampSelectPhase(session);
    if (action.type === 'ban') return instantBan && (phase === 'BAN_PICK' || phase === 'PLANNING');
    if (action.type === 'pick') return instantPick;

    return false;
}

function logBanSessionState(session, allActions, myPosition) {
    const banActions = allActions.filter((action) => action.type === 'ban');
    if (banActions.length === 0) return;

    const compactActions = banActions.map((action) => ({
        id: action.id,
        actorCellId: action.actorCellId,
        isAllyAction: action.isAllyAction,
        active: isActionActive(action, session),
        completed: action.completed,
        championId: action.championId
    }));

    const debugState = {
        phase: getChampSelectPhase(session),
        localPlayerCellId: session.localPlayerCellId,
        myPosition,
        banPriority: getPriorityList(BAN_PRIORITY_KEY, myPosition),
        bannedChampionIds: [...getBannedChampionIds(session)],
        bannableSetSize: bannableChampionSet?.size ?? 'N/A',
        banActions: compactActions
    };
    const debugKey = JSON.stringify(debugState);
    if (debugKey === lastBanDebugKey) return;
    lastBanDebugKey = debugKey;

    Utils.Debug.log('[AutoSelect] ban state', debugState);
}

function getBannedChampionIds(session) {
    const bans = new Set();

    // Primary: completed ban actions from the flat action array
    if (session?.actions) {
        session.actions.flat(2).forEach(action => {
            if (action.type === 'ban' && action.championId && action.completed) {
                bans.add(Number(action.championId));
            }
        });
    }

    // Secondary: session.bans object (may have champion IDs that are hidden in the action array during simultaneous ban mode)
    if (session?.bans) {
        const extractBans = (arr) => {
            if (Array.isArray(arr)) {
                arr.forEach(entry => {
                    if (typeof entry === 'number' && entry > 0) bans.add(entry);
                    else if (entry && typeof entry === 'object' && entry.championId) bans.add(Number(entry.championId));
                });
            }
        };
        extractBans(session.bans.myTeamBans);
        extractBans(session.bans.theirTeamBans);
    }

    return bans;
}

function getPickedChampionIds(session) {
    const picked = new Set();

    // Completed pick actions from the session
    if (session?.actions) {
        session.actions.flat(2).forEach(action => {
            if (action.type === 'pick' && action.championId && action.completed) {
                picked.add(Number(action.championId));
            }
        });
    }

    // Also check player championId field (populated on lock-in)
    const players = [...(session?.myTeam || []), ...(session?.theirTeam || [])];
    players
        .filter((player) => player.cellId !== session?.localPlayerCellId)
        .forEach(player => {
            const id = Number(player.championId);
            if (id) picked.add(id);
        });

    return picked;
}

function isChampionAvailableForAction(actionType, championId, session) {
    const bannedIds = getBannedChampionIds(session);
    if (bannedIds.has(championId)) return false;

    const pickedIds = getPickedChampionIds(session);
    if (actionType === 'pick' && pickedIds.has(championId)) return false;

    // Server-pushed bannable set may shrink as bans happen
    if (actionType === 'ban') {
        if (bannableChampionSet && !bannableChampionSet.has(championId)) return false;
    }

    // Team intent awareness: don't ban a champion a teammate is hovering
    if (actionType === 'ban' && Utils.Store.get('autoLockChampion', 'respectTeamIntent') !== false) {
        if (teammateIntents.has(championId)) return false;
    }

    return true;
}

function chooseChampionForAction(session, action, role) {
    const actionType = action.type;

    let priorities = getPriorityList(actionType === 'ban' ? BAN_PRIORITY_KEY : PICK_PRIORITY_KEY, role);
    if (priorities.length === 0 && role !== 'default') {
        priorities = getPriorityList(actionType === 'ban' ? BAN_PRIORITY_KEY : PICK_PRIORITY_KEY, 'default');
    }

    if (priorities.length === 0) return null;

    const currentChampionId = Number(action.championId || 0);

    if (currentChampionId && priorities.includes(currentChampionId)) {
        if (isChampionAvailableForAction(actionType, currentChampionId, session)) {
            return currentChampionId;
        }
    }

    return priorities.find((championId) => isChampionAvailableForAction(actionType, championId, session)) || null;
}

function panic() {
    Utils.Debug.log('[AutoSelect] Panic triggered, overriding controls');
    panicActive = true;
    emberTimerCrossed = false;
    lastAutoLockKeys.clear();
    actionActiveStartTimes.clear();
    if (window.Toast && typeof window.Toast.success === 'function') {
        window.Toast.success('Auto Lock Override — Next champ select will re-enable');
    }
}

function mountAutoLockChampion() {
    if (!Utils.LCU || !Utils.LCU.observe) return;
    // Clean up any stale subscriptions from previous mounts (hot-reload safety)
    unmountAutoLockChampion();
    panicActive = false;
    unregisterPanic = Utils.Panic.register(panic);
    bannableChampionSet = null;
    pickableChampionSet = null;

    bannableChampUnsub = Utils.LCU.observe('/lol-champ-select/v1/bannable-champion-ids', e => {
        bannableChampionSet = new Set(e.data || []);
        Utils.Debug.log(`[AutoSelect] bannableChampionSet updated, size=${bannableChampionSet.size}`);
    });
    Utils.LCU.get('/lol-champ-select/v1/bannable-champion-ids')
        .then(data => { bannableChampionSet = new Set(data || []); })
        .catch(() => {});

    pickableChampUnsub = Utils.LCU.observe('/lol-champ-select/v1/pickable-champion-ids', e => {
        pickableChampionSet = new Set(e.data || []);
        Utils.Debug.log(`[AutoSelect] pickableChampionSet updated, size=${pickableChampionSet.size}`);
    });
    Utils.LCU.get('/lol-champ-select/v1/pickable-champion-ids')
        .then(data => { pickableChampionSet = new Set(data || []); })
        .catch(() => {});

    autoLockSessionUnsub = Utils.LCU.observe('/lol-champ-select/v1/session', e => {
        processChampSelectSession(e.data);
    });
    Utils.LCU.get('/lol-champ-select/v1/session')
        .then(processChampSelectSession)
        .catch(() => {});
}

function unmountAutoLockChampion() {
    if (unregisterPanic) {
        unregisterPanic();
        unregisterPanic = null;
    }
    if (autoLockSessionUnsub) {
        autoLockSessionUnsub();
        autoLockSessionUnsub = null;
    }
    if (bannableChampUnsub) {
        bannableChampUnsub();
        bannableChampUnsub = null;
    }
    if (pickableChampUnsub) {
        pickableChampUnsub();
        pickableChampUnsub = null;
    }
    bannableChampionSet = null;
    pickableChampionSet = null;
    lastAutoLockKeys.clear();
    actionActiveStartTimes.clear();
    lastBanDebugKey = '';
}

export function load() {
    if (isEnabled) mountAutoLockChampion();
}
