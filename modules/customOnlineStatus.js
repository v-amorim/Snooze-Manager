/**
 * @name Snooze-customOnlineStatus
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Adds custom chat availability, status message, and fake ranked badge/challenge points controls.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';

let isEnabled = false;
let statusMenu = null;
let statusMsgInput = null;
let documentClickHandlerAttached = false;

const RANK_QUEUE_OPTIONS = [
    { value: '', label: 'None' },
    { value: 'RANKED_SOLO_5x5', label: 'Solo/Duo' },
    { value: 'RANKED_FLEX_SR', label: 'Flex 5v5' },
    { value: 'RANKED_FLEX_TT', label: 'Flex 3v3' },
    { value: 'RANKED_TFT', label: 'TFT' },
    { value: 'RANKED_TFT_TURBO', label: 'Hyper Roll' },
    { value: 'RANKED_TFT_DOUBLE_UP', label: 'Double Up' },
    { value: 'CHERRY', label: 'Arena' }
];

const RANK_TIER_OPTIONS = [
    { value: '', label: 'Unranked' },
    { value: 'IRON', label: 'Iron' },
    { value: 'BRONZE', label: 'Bronze' },
    { value: 'SILVER', label: 'Silver' },
    { value: 'GOLD', label: 'Gold' },
    { value: 'PLATINUM', label: 'Platinum' },
    { value: 'EMERALD', label: 'Emerald' },
    { value: 'DIAMOND', label: 'Diamond' },
    { value: 'MASTER', label: 'Master' },
    { value: 'GRANDMASTER', label: 'Grandmaster' },
    { value: 'CHALLENGER', label: 'Challenger' }
];

const RANK_DIVISION_OPTIONS = [
    { value: '', label: 'None' },
    { value: 'I', label: 'I' },
    { value: 'II', label: 'II' },
    { value: 'III', label: 'III' },
    { value: 'IV', label: 'IV' }
];

function debugLog(tag, msg, extra) {
    if (extra !== undefined) Utils.Debug.log('[CustomOnlineStatus][' + tag + ']', msg, extra);
    else Utils.Debug.log('[CustomOnlineStatus][' + tag + ']', msg);
}

// Push the desired status to /me
async function syncAvailability() {
    if (!Utils.Store.get('customOnlineStatus', 'enabled') || !Utils.LCU) return;
    const payload = {
        availability: Utils.Store.get('customOnlineStatus', 'status') || 'chat',
        statusMessage: Utils.Store.get('customOnlineStatus', 'statusMsg') || ''
    };
    debugLog('availability', 'PUT /lol-chat/v1/me', payload);
    try {
        const resp = await Utils.LCU.put('/lol-chat/v1/me', payload);
        debugLog('availability', 'response', resp);
    } catch(e) {
        Utils.Debug.warn('[CustomOnlineStatus][availability] PUT failed', e);
    }
}

// Push the desired fake rank badge / challenge crystal / challenge points to /me.
// challengeCrystalLevel is the challenges system's own Iron-Challenger tier and is
// independent from rankedLeagueTier (the ranked league badge), so it gets its own setting.
// Each field group is sent as its own PUT so one rejected/invalid field can't block the others.
async function syncRankSpoof() {
    if (!Utils.Store.get('customOnlineStatus', 'rankSpoofEnabled') || !Utils.LCU) return;

    const groups = [
        ['rank', {
            lol: {
                rankedLeagueQueue: Utils.Store.get('customOnlineStatus', 'rankQueue') || '',
                rankedLeagueTier: Utils.Store.get('customOnlineStatus', 'rankTier') || '',
                rankedLeagueDivision: Utils.Store.get('customOnlineStatus', 'rankDivision') || ''
            }
        }],
        ['challengeCrystal', { lol: { challengeCrystalLevel: Utils.Store.get('customOnlineStatus', 'challengeCrystalTier') || '' } }],
        ['challengePoints', { lol: { challengePoints: Utils.Store.get('customOnlineStatus', 'challengePoints') || '' } }]
    ];

    for (const [tag, payload] of groups) {
        debugLog(tag, 'PUT /lol-chat/v1/me sent lol=', payload.lol);
        try {
            const resp = await Utils.LCU.put('/lol-chat/v1/me', payload);
            debugLog(tag, 'echoed back lol=', resp && resp.lol);
        } catch(e) {
            Utils.Debug.warn('[CustomOnlineStatus][' + tag + '] PUT failed', e);
        }
    }
}

function toggleRankSpoof(enabled) {
    debugLog('toggle', 'rankSpoofEnabled -> ' + enabled);
    Utils.Store.set('customOnlineStatus', 'rankSpoofEnabled', enabled);
    if (enabled) syncRankSpoof();
}

// Install WS + XHR hooks so the status stays locked even when the client resets it.
// Called once from init(). safe to call multiple times (hooks are registered once).
let _hooksInstalled = false;
let _emberHookInstalled = false;
function installHooks(context) {
    if (_hooksInstalled) return;
    _hooksInstalled = true;

    // Inbound WS hook
    // Intercept server push of /lol-chat/v1/me to lock status UI + fake rank/challenges.
    Utils.Hooks.WS.install(context);
    Utils.Hooks.WS.hook('/lol-chat/v1/me', (endpoint, payload) => {
        if (!payload || typeof payload !== 'object') return payload;
        let patched = payload;

        if (isEnabled) {
            const desired = Utils.Store.get('customOnlineStatus', 'status') || 'chat';
            const desiredMsg = Utils.Store.get('customOnlineStatus', 'statusMsg') || '';
            patched = { ...patched };
            if (patched.availability !== undefined) patched.availability = desired;
            if (patched.statusMessage !== undefined) patched.statusMessage = desiredMsg;
        }

        if (Utils.Store.get('customOnlineStatus', 'rankSpoofEnabled') && patched.lol && typeof patched.lol === 'object') {
            debugLog('ws-in', 'incoming lol fields', patched.lol);
            patched = { ...patched, lol: { ...patched.lol } };
            if (patched.lol.rankedLeagueQueue !== undefined) patched.lol.rankedLeagueQueue = Utils.Store.get('customOnlineStatus', 'rankQueue') || '';
            if (patched.lol.rankedLeagueTier !== undefined) patched.lol.rankedLeagueTier = Utils.Store.get('customOnlineStatus', 'rankTier') || '';
            if (patched.lol.rankedLeagueDivision !== undefined) patched.lol.rankedLeagueDivision = Utils.Store.get('customOnlineStatus', 'rankDivision') || '';
            if (patched.lol.challengeCrystalLevel !== undefined) patched.lol.challengeCrystalLevel = Utils.Store.get('customOnlineStatus', 'challengeCrystalTier') || '';
            if (patched.lol.challengePoints !== undefined) patched.lol.challengePoints = Utils.Store.get('customOnlineStatus', 'challengePoints') || '';
            debugLog('ws-in', 'patched lol fields', patched.lol);
        }

        return patched;
    });

    // Outbound XHR hook
    // When the client sends a PUT /lol-chat/v1/me (e.g. entering lobby, post-game),
    // rewrite the body to keep our desired availability/statusMessage and fake rank/challenges.
    Utils.Hooks.Xhr.hookReq('/lol-chat/v1/me', (method, url, xhr, body) => {
        if (method !== 'PUT' && method !== 'put') return body;

        let parsed;
        try { parsed = JSON.parse(body); } catch { return body; }
        let changed = false;

        if (isEnabled) {
            const desired = Utils.Store.get('customOnlineStatus', 'status') || 'chat';
            const desiredMsg = Utils.Store.get('customOnlineStatus', 'statusMsg') || '';
            if (parsed.availability !== undefined) { parsed.availability = desired; changed = true; }
            if (parsed.statusMessage !== undefined) { parsed.statusMessage = desiredMsg; changed = true; }
        }

        if (Utils.Store.get('customOnlineStatus', 'rankSpoofEnabled') && parsed.lol && typeof parsed.lol === 'object') {
            debugLog('xhr-out', 'outgoing lol fields (before)', parsed.lol);
            if (parsed.lol.rankedLeagueQueue !== undefined) { parsed.lol.rankedLeagueQueue = Utils.Store.get('customOnlineStatus', 'rankQueue') || ''; changed = true; }
            if (parsed.lol.rankedLeagueTier !== undefined) { parsed.lol.rankedLeagueTier = Utils.Store.get('customOnlineStatus', 'rankTier') || ''; changed = true; }
            if (parsed.lol.rankedLeagueDivision !== undefined) { parsed.lol.rankedLeagueDivision = Utils.Store.get('customOnlineStatus', 'rankDivision') || ''; changed = true; }
            if (parsed.lol.challengeCrystalLevel !== undefined) { parsed.lol.challengeCrystalLevel = Utils.Store.get('customOnlineStatus', 'challengeCrystalTier') || ''; changed = true; }
            if (parsed.lol.challengePoints !== undefined) { parsed.lol.challengePoints = Utils.Store.get('customOnlineStatus', 'challengePoints') || ''; changed = true; }
            debugLog('xhr-out', 'outgoing lol fields (after)', parsed.lol);
        }

        return changed ? JSON.stringify(parsed) : body;
    });
}

function installEmberHook() {
    if (_emberHookInstalled) return;
    _emberHookInstalled = true;

    Utils.Hooks.Ember.registerRule({
        name: 'custom-online-status-identity',
        matcher: 'lol-social-identity',
        mixin() {
            return {
                didInsertElement() {
                    this._super(...arguments);
                    const hitbox = this.element.querySelector('.lol-social-availability-hitbox');
                    if (hitbox && !hitbox.hasAttribute('data-pm-status-menu-hook')) {
                        hitbox.setAttribute('data-pm-status-menu-hook', 'true');
                        hitbox.addEventListener('click', (e) => {
                            const currentEnabled = Utils.Store.get('customOnlineStatus', 'enabled');
                            if (!currentEnabled) return;
                            e.stopPropagation(); e.stopImmediatePropagation();
                            const customMenu = getStatusMenu();
                            const r = hitbox.getBoundingClientRect();
                            customMenu.style.left = 'auto';
                            customMenu.style.right = (window.innerWidth - r.right) + 'px';
                            customMenu.style.top = (r.bottom + 5) + 'px';
                            customMenu.style.display = 'block';
                            if (Utils.LCU) {
                                Utils.LCU.get('/lol-chat/v1/me').then(me => {
                                    if (me && statusMsgInput) statusMsgInput.value = me.statusMessage || '';
                                }).catch(() => {});
                            }
                        }, true);
                    }
                },
            };
        },
    });
}

function cleanupDuplicateMenus(keep) {
    document.querySelectorAll('#pm-status-menu').forEach((menu) => {
        if (menu !== keep) menu.remove();
    });
}

function getStatusMenu() {
    if (statusMenu && document.body.contains(statusMenu)) {
        cleanupDuplicateMenus(statusMenu);
        return statusMenu;
    }

    document.querySelectorAll('#pm-status-menu').forEach((menu) => menu.remove());

    const customMenu = document.createElement('div');
    customMenu.id = 'pm-status-menu';
    Object.assign(customMenu.style, {
        position: 'fixed', minWidth: '160px', background: 'rgba(1,10,19,0.97)', border: '1px solid #785a28',
        borderRadius: '3px', boxShadow: '0 8px 24px rgba(0,0,0,0.7)', zIndex: '999999', display: 'none',
        padding: '6px', pointerEvents: 'auto', color: '#a09b8c', fontSize: '12px'
    });
    document.body.appendChild(customMenu);

    const opts = [
        { v: 'chat', l: 'Online (Green)', d: '#43b581' },
        { v: 'away', l: 'Away (Red)', d: '#f04747' },
        { v: 'dnd', l: 'Do Not Disturb (Yellow)', d: '#faa61a' },
        { v: 'mobile', l: 'Mobile (Green)', d: '#43b581' },
        { v: 'offline', l: 'Offline (Gray)', d: '#747f8d' }
    ];

    opts.forEach(o => {
        const item = document.createElement('div');
        Object.assign(item.style, {
            display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', cursor: 'pointer', transition: '0.2s', borderRadius: '2px'
        });
        item.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${o.d}"></span><span>${o.l}</span>`;
        item.onmouseover = () => item.style.background = 'rgba(200,170,110,0.15)';
        item.onmouseout = () => item.style.background = 'none';
        item.onclick = async (ev) => {
            ev.stopPropagation();
            customMenu.style.display = 'none';
            try {
                Utils.Store.set('customOnlineStatus', 'status', o.v);
                if (Utils.Store.get('customOnlineStatus', 'enabled') && Utils.LCU) {
                    await Utils.LCU.put('/lol-chat/v1/me', { availability: o.v });
                }
            } catch (err) {}
        };
        customMenu.appendChild(item);
    });

    const inputWrap = document.createElement('div');
    Object.assign(inputWrap.style, { padding: '6px 4px 0', marginTop: '4px', borderTop: '1px solid #3e2e13' });
    statusMsgInput = document.createElement('textarea');
    statusMsgInput.setAttribute('data-pm-status-message', 'true');
    statusMsgInput.placeholder = 'Custom Status Message...';
    Object.assign(statusMsgInput.style, {
        width: '100%', background: '#111', border: '1px solid #785a28', color: '#f0e6d2', padding: '6px 10px',
        borderRadius: '2px', outline: 'none', boxSizing: 'border-box', resize: 'vertical', minHeight: '60px',
        fontFamily: 'inherit', fontSize: '13px'
    });
    statusMsgInput.onchange = async (ev) => {
        try {
            Utils.Store.set('customOnlineStatus', 'statusMsg', ev.target.value);
            if (Utils.Store.get('customOnlineStatus', 'enabled') && Utils.LCU) {
                await Utils.LCU.put('/lol-chat/v1/me', { statusMessage: ev.target.value });
            }
        } catch (err) {}
    };
    statusMsgInput.onclick = (ev) => ev.stopPropagation();
    inputWrap.appendChild(statusMsgInput);
    customMenu.appendChild(inputWrap);

    statusMenu = customMenu;
    return statusMenu;
}

// Plain 'textarea' settings have no visible label - once text is typed the
// placeholder (the only clue to what the field is) disappears. Render a small
// header above the textarea instead.
function renderLabeledTextarea(row, { label, storeKey, placeholder, onChange }) {
    const title = document.createElement('div');
    title.className = 'pm-label-title';
    title.style.marginBottom = '8px';
    title.textContent = label;
    row.appendChild(title);

    const input = document.createElement('textarea');
    input.placeholder = placeholder || '';
    Object.assign(input.style, { background: '#111', color: '#f0e6d2', border: '1px solid #3e2e13', padding: '10px 14px', borderRadius: '4px', outline: 'none', boxSizing: 'border-box', width: '100%', minHeight: '60px', resize: 'vertical', fontFamily: 'inherit', fontSize: '14px' });
    input.value = Utils.Store.get('customOnlineStatus', storeKey) || '';
    input.addEventListener('change', (e) => onChange(e.target.value));
    input.addEventListener('click', (ev) => ev.stopPropagation());
    row.appendChild(input);
}

function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set('customOnlineStatus', 'enabled', enabled);
    if (!enabled) {
        const menu = statusMenu || document.getElementById('pm-status-menu');
        if (menu) menu.style.display = 'none';
    } else {
        // Force a sync immediately when turned ON
        syncAvailability();
    }
}



export function init(context) {
    isEnabled = Utils.Store.get('customOnlineStatus', 'enabled') || false;
    installHooks(context);

    Utils.Settings.inject(context, {
        name: "custom-status-settings",
        titleKey: "snooze_custom-status",
        titleName: "Custom Status",
        capitalTitleKey: "snooze_custom-status_capital",
        capitalTitleName: "CUSTOM STATUS",
        class: "custom-status-settings"
    });

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'customOnlineStatus',
            category: 'Profile & Social',
            name: 'Custom Online Status',
            description: 'Overrides your online status indicator and fake ranked badge/challenge points. Menu available directly on your profile avatar in the client.',
            settings: [
                {
                    type: 'toggle',
                    id: 'sm:customOnlineStatus',
                    label: 'Enable Custom Online Status',
                    description: 'Forces your chat availability and status message to the values chosen below',
                    value: isEnabled,
                    onChange: (val) => toggleFeature(val)
                },
                {
                    type: 'select',
                    id: 'sm:customStatus',
                    value: Utils.Store.get('customOnlineStatus', 'status') || 'chat',
                    options: [
                        { value: 'chat', label: 'Online (Green)' },
                        { value: 'away', label: 'Away (Red)' },
                        { value: 'dnd', label: 'Do Not Disturb (Yellow)' },
                        { value: 'mobile', label: 'Mobile (Green)' },
                        { value: 'offline', label: 'Offline (Gray)' }
                    ],
                    onChange: async (val) => {
                        Utils.Store.set('customOnlineStatus', 'status', val);
                        if(Utils.Store.get('customOnlineStatus', 'enabled') && Utils.LCU) {
                            await Utils.LCU.put('/lol-chat/v1/me', { availability: val });
                        }
                    }
                },
                {
                    type: 'custom',
                    render: (row) => renderLabeledTextarea(row, {
                        label: 'Custom Status Message',
                        storeKey: 'statusMsg',
                        placeholder: 'Custom Status Message...',
                        onChange: async (val) => {
                            Utils.Store.set('customOnlineStatus', 'statusMsg', val);
                            if(Utils.Store.get('customOnlineStatus', 'enabled') && Utils.LCU) {
                                await Utils.LCU.put('/lol-chat/v1/me', { statusMessage: val });
                            }
                        }
                    })
                },
                {
                    type: 'toggle',
                    id: 'sm:rankSpoofEnabled',
                    label: 'Enable Fake Rank & Challenge Points',
                    description: 'Overrides the ranked badge, challenge crystal, and challenge points shown on your profile card and in the friends list. Cosmetic only: does not touch your real ranked stats.',
                    warning: 'Grey area: broadcasts fake presence data (rank, challenges) to your friends and your own client via a live LCU write. Purely cosmetic (no real stats change), but it is API tampering, not just a UI tweak.',
                    value: Utils.Store.get('customOnlineStatus', 'rankSpoofEnabled') || false,
                    onChange: (val) => toggleRankSpoof(val)
                },
                {
                    type: 'select',
                    id: 'sm:rankQueue',
                    value: Utils.Store.get('customOnlineStatus', 'rankQueue') || '',
                    options: RANK_QUEUE_OPTIONS,
                    onChange: async (val) => {
                        Utils.Store.set('customOnlineStatus', 'rankQueue', val);
                        await syncRankSpoof();
                    }
                },
                {
                    type: 'select',
                    id: 'sm:rankTier',
                    value: Utils.Store.get('customOnlineStatus', 'rankTier') || '',
                    options: RANK_TIER_OPTIONS,
                    onChange: async (val) => {
                        Utils.Store.set('customOnlineStatus', 'rankTier', val);
                        await syncRankSpoof();
                    }
                },
                {
                    type: 'select',
                    id: 'sm:rankDivision',
                    value: Utils.Store.get('customOnlineStatus', 'rankDivision') || '',
                    options: RANK_DIVISION_OPTIONS,
                    onChange: async (val) => {
                        Utils.Store.set('customOnlineStatus', 'rankDivision', val);
                        await syncRankSpoof();
                    }
                },
                {
                    type: 'select',
                    id: 'sm:challengeCrystalTier',
                    value: Utils.Store.get('customOnlineStatus', 'challengeCrystalTier') || '',
                    options: RANK_TIER_OPTIONS,
                    onChange: async (val) => {
                        Utils.Store.set('customOnlineStatus', 'challengeCrystalTier', val);
                        await syncRankSpoof();
                    }
                },
                {
                    type: 'custom',
                    render: (row) => renderLabeledTextarea(row, {
                        label: 'Challenge Points',
                        storeKey: 'challengePoints',
                        placeholder: 'Challenge Points (any text)...',
                        onChange: async (val) => {
                            Utils.Store.set('customOnlineStatus', 'challengePoints', val);
                            await syncRankSpoof();
                        }
                    })
                }
            ]
        });
    } else {
        // Inject UI into native settings panel
        Utils.DOM.observer.observe("lol-uikit-scrollable.custom-status-settings", (plugin) => {
            plugin.innerHTML = '';
            plugin.appendChild(Utils.Settings.createToggleRow("Enable Custom Online Status", isEnabled, async (next) => {
                isEnabled = next;
                Utils.Store.set('customOnlineStatus', 'enabled', isEnabled);
                await toggleFeature(isEnabled);
            }));

            // Native UI Fallback for Select and Textarea
            const selectRow = document.createElement("div");
            selectRow.classList.add("plugins-settings-row");
            selectRow.style.marginTop = "10px";
            const statusSelect = document.createElement("select");
            Object.assign(statusSelect.style, { background: '#111', color: '#f0e6d2', border: '1px solid #3e2e13', padding: '6px', borderRadius: '2px', outline: 'none', width: '100%' });
            const opts = [ {v:'chat', l:'Online (Green)'}, {v:'away', l:'Away (Red)'}, {v:'dnd', l:'Do Not Disturb (Yellow)'}, {v:'mobile', l:'Mobile (Green)'}, {v:'offline', l:'Offline (Gray)'} ];
            opts.forEach(o => {
                const opt = document.createElement('option');
                opt.value = o.v; opt.textContent = o.l;
                statusSelect.appendChild(opt);
            });
            statusSelect.value = Utils.Store.get('customOnlineStatus', 'status') || 'chat';
            statusSelect.addEventListener('change', async (e) => {
                Utils.Store.set('customOnlineStatus', 'status', e.target.value);
                if(Utils.Store.get('customOnlineStatus', 'enabled') && Utils.LCU) {
                    await Utils.LCU.put('/lol-chat/v1/me', { availability: e.target.value });
                }
            });
            selectRow.appendChild(statusSelect);
            plugin.appendChild(selectRow);

            const textRow = document.createElement("div");
            textRow.classList.add("plugins-settings-row");
            textRow.style.marginTop = "10px";
            const statusLabel = document.createElement('div');
            statusLabel.textContent = 'Custom Status Message';
            Object.assign(statusLabel.style, { color: '#f0e6d2', fontSize: '13px', fontWeight: '700', marginBottom: '8px' });
            textRow.appendChild(statusLabel);
            const statusInput = document.createElement('textarea');
            statusInput.placeholder = 'Custom Status Message...';
            Object.assign(statusInput.style, { background: '#111', color: '#f0e6d2', border: '1px solid #3e2e13', padding: '6px 10px', borderRadius: '2px', outline: 'none', boxSizing: 'border-box', width: '100%', minHeight: '60px', resize: 'vertical', fontFamily: 'inherit', fontSize: '13px' });
            statusInput.value = Utils.Store.get('customOnlineStatus', 'statusMsg') || '';
            statusInput.addEventListener('change', async (e) => {
                Utils.Store.set('customOnlineStatus', 'statusMsg', e.target.value);
                if(Utils.Store.get('customOnlineStatus', 'enabled') && Utils.LCU) {
                    await Utils.LCU.put('/lol-chat/v1/me', { statusMessage: e.target.value });
                }
            });
            textRow.appendChild(statusInput);
            plugin.appendChild(textRow);

            // Native UI Fallback for fake rank / challenge points
            plugin.appendChild(Utils.Settings.createToggleRow("[!] Enable Fake Rank & Challenge Points (grey area - broadcasts fake presence data)", Utils.Store.get('customOnlineStatus', 'rankSpoofEnabled') || false, async (next) => {
                toggleRankSpoof(next);
            }));

            const buildNativeSelectRow = (options, storeKey) => {
                const row = document.createElement("div");
                row.classList.add("plugins-settings-row");
                row.style.marginTop = "10px";
                const select = document.createElement("select");
                Object.assign(select.style, { background: '#111', color: '#f0e6d2', border: '1px solid #3e2e13', padding: '6px', borderRadius: '2px', outline: 'none', width: '100%' });
                options.forEach(o => {
                    const opt = document.createElement('option');
                    opt.value = o.value; opt.textContent = o.label;
                    select.appendChild(opt);
                });
                select.value = Utils.Store.get('customOnlineStatus', storeKey) || '';
                select.addEventListener('change', async (e) => {
                    Utils.Store.set('customOnlineStatus', storeKey, e.target.value);
                    await syncRankSpoof();
                });
                row.appendChild(select);
                return row;
            };

            plugin.appendChild(buildNativeSelectRow(RANK_QUEUE_OPTIONS, 'rankQueue'));
            plugin.appendChild(buildNativeSelectRow(RANK_TIER_OPTIONS, 'rankTier'));
            plugin.appendChild(buildNativeSelectRow(RANK_DIVISION_OPTIONS, 'rankDivision'));
            plugin.appendChild(buildNativeSelectRow(RANK_TIER_OPTIONS, 'challengeCrystalTier'));

            const challengePointsRow = document.createElement("div");
            challengePointsRow.classList.add("plugins-settings-row");
            challengePointsRow.style.marginTop = "10px";
            const challengePointsLabel = document.createElement('div');
            challengePointsLabel.textContent = 'Challenge Points';
            Object.assign(challengePointsLabel.style, { color: '#f0e6d2', fontSize: '13px', fontWeight: '700', marginBottom: '8px' });
            challengePointsRow.appendChild(challengePointsLabel);
            const challengePointsInput = document.createElement('textarea');
            challengePointsInput.placeholder = 'Challenge Points (any text)...';
            Object.assign(challengePointsInput.style, { background: '#111', color: '#f0e6d2', border: '1px solid #3e2e13', padding: '6px 10px', borderRadius: '2px', outline: 'none', boxSizing: 'border-box', width: '100%', minHeight: '40px', resize: 'vertical', fontFamily: 'inherit', fontSize: '13px' });
            challengePointsInput.value = Utils.Store.get('customOnlineStatus', 'challengePoints') || '';
            challengePointsInput.addEventListener('change', async (e) => {
                Utils.Store.set('customOnlineStatus', 'challengePoints', e.target.value);
                await syncRankSpoof();
            });
            challengePointsRow.appendChild(challengePointsInput);
            plugin.appendChild(challengePointsRow);
        });
    }

}

export function load() {
    cleanupDuplicateMenus(statusMenu);

    if (!documentClickHandlerAttached) {
        documentClickHandlerAttached = true;
        document.addEventListener('click', (e) => {
            const menu = statusMenu || document.getElementById('pm-status-menu');
            if (menu && !menu.contains(e.target)) menu.style.display = 'none';
        });
    }

    installEmberHook();

    // Apply saved status and rank/challenge spoof to the server on load
    syncAvailability();
    syncRankSpoof();
}
