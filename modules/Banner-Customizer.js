/**
 * ============================================================
 *  Banner Customizer — Pengu Loader Plugin  v1
 *  DataStore namespace: "bnc_" prefix on all keys
 *
 *  Patches lol-regalia-banner-v2-element across all contexts:
 *    - Standard lobby banner (local player)
 *    - Arena lobby hover tooltip
 *    - Profile page banner
 * ============================================================
 */

    const BNC_VERSION = "1";
    let DEBUG = false;

    const _bncStyle = {
        log:  "background:#1a1a2e;color:#c8aa6e;font-weight:bold;padding:1px 6px;border-radius:3px;border:1px solid #785a28;",
        warn: "background:#2e1a00;color:#f0a830;font-weight:bold;padding:1px 6px;border-radius:3px;border:1px solid #c87800;",
        err:  "background:#2e0000;color:#ff5555;font-weight:bold;padding:1px 6px;border-radius:3px;border:1px solid #c80000;",
    };
    const log  = (...a) => { if (DEBUG) console.log("%cBNC",  _bncStyle.log,  ...a); };
    const warn = (...a) => { if (DEBUG) console.warn("%cBNC", _bncStyle.warn, ...a); };
    const err  = (...a) => console.error("%cBNC", _bncStyle.err, ...a);

    const DS_PREFIX = "bnc_";
    const DS = {
        get: (k) => DataStore.get(DS_PREFIX + k),
        set: (k, v) => DataStore.set(DS_PREFIX + k, v),
    };

    let uiVisible       = false;
    let bannerData      = [];
    let customBanners   = [];
    let bannerEnabled   = true;
    let nativePreviewEnabled = true;
    let ownSummonerId   = null;

    let _selectedTileDom       = null;
    let _currentRenderTiles    = new Set();
    let _lobbyObserver         = null;
    let _bannerElementObserver = null;
    let _customImgObservers    = new Map(); // img element → MutationObserver
    let _bannerApplyDeb        = null;

    const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

    // ============================================================
    //  Settings Persistence
    // ============================================================
    function saveSettings() {
        try {
            DS.set("config", {
                bannerEnabled,
                nativePreviewEnabled,
                customBanners,
                debug: DEBUG,
                savedAt: new Date().toISOString(),
                version: BNC_VERSION,
            });
            log("Settings saved");
        } catch (e) {
            err("saveSettings:", e);
        }
    }

    function loadSavedSettings() {
        try {
            const c = DS.get("config");
            if (!c) { log("No saved config, using defaults"); return false; }
            bannerEnabled = c.bannerEnabled ?? true;
            nativePreviewEnabled = c.nativePreviewEnabled ?? true;
            customBanners = c.customBanners ?? [];
            DEBUG         = c.debug ?? false;
            log("Loaded config v" + (c.version || "1.0"));
            return true;
        } catch (e) {
            err("loadSavedSettings:", e);
            return false;
        }
    }

    // ============================================================
    //  Data Fetch
    // ============================================================
    async function fetchOwnSummonerId() {
        if (ownSummonerId) return;
        try {
            const res = await fetch("/lol-summoner/v1/current-summoner");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            ownSummonerId = String(data.summonerId);
            log("Own summoner ID:", ownSummonerId);
        } catch (e) {
            err("fetchOwnSummonerId failed:", e);
        }
    }

    async function fetchBannerData() {
        if (window._bncDataCache) {
            bannerData = window._bncDataCache;
            log("Banner data from session cache");
            return;
        }
        log("Fetching banner data from LCU...");
        try {
            const res = await fetch("/lol-regalia/v3/inventory/REGALIA_BANNER");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const raw = await res.json();

            bannerData = [];
            for (const [, entry] of Object.entries(raw)) {
                for (const item of entry.items) {
                    if (!item.assetPath) continue;
                    const fname = item.assetPath
                        .split("/").pop()
                        .replace(/\.[^.]+$/, "")
                        .replace(/[_-]+/g, " ")
                        .replace(/\b\w/g, c => c.toUpperCase());
                    bannerData.push({
                        id:          item.id,
                        idSecondary: item.idSecondary || "",
                        name:        item.localizedName || fname || `Banner ${item.id}`,
                        assetPath:   item.assetPath,
                        bannerType:  item.bannerType || "blank",
                        isOwned:     entry.isOwned,
                        isCustom:    false,
                    });
                }
            }

            window._bncDataCache = bannerData;
            log("Banners fetched:", bannerData.length);
        } catch (e) {
            err("fetchBannerData failed:", e);
            bannerData = [];
        }
    }

    // ============================================================
    //  DOM Utilities
    // ============================================================
    function waitForShadowElement(host, selector, maxWaitMs = 3000) {
        return new Promise((resolve) => {
            const immediate = host.shadowRoot?.querySelector(selector);
            if (immediate) return resolve(immediate);

            let elapsed = 0;
            const interval = setInterval(() => {
                elapsed += 50;
                const el = host.shadowRoot?.querySelector(selector);
                if (el) {
                    clearInterval(interval);
                    resolve(el);
                } else if (elapsed >= maxWaitMs) {
                    clearInterval(interval);
                    resolve(null);
                }
            }, 50);
        });
    }

    function _getBannerElement() {
        const partiesHost = document.querySelector(".lobby-banner.local lol-regalia-parties-v2-element");
        if (!partiesHost?.shadowRoot) return null;
        return partiesHost.shadowRoot.querySelector("lol-regalia-banner-v2-element") || null;
    }

    /**
     * Pierces shadow roots to find lol-regalia-banner-v2-element across all
     * contexts where it can appear:
     *   - Lobby banner        : lol-regalia-parties-v2-element (any)
     *   - Arena hover tooltip : lol-regalia-parties-v2-element inside tooltip layer
     *   - Profile page        : lol-regalia-profile-v2-element
     *
     * Ownership is confirmed by matching summoner-id on the host element OR on
     * the banner element itself (profile page omits it on the host).
     */
    function _getOwnBannerElements() {
        const results = [];

        // All lol-regalia-parties-v2-element hosts (lobby + hover tooltips)
        document.querySelectorAll("lol-regalia-parties-v2-element").forEach(host => {
            if (!host.shadowRoot) return;
            // Only patch if the host belongs to us (has our summoner-id, or is .local)
            const hostId = host.getAttribute("summoner-id");
            const isLocal = host.closest(".lobby-banner.local") !== null;
            if (ownSummonerId && hostId && hostId !== ownSummonerId && !isLocal) return;
            const el = host.shadowRoot.querySelector("lol-regalia-banner-v2-element");
            if (el) results.push(el);
        });

        // Profile page: lol-regalia-profile-v2-element → shadow root → banner
        document.querySelectorAll("lol-regalia-profile-v2-element").forEach(host => {
            if (!host.shadowRoot) return;
            // Profile element has summoner-id on it — verify it's ours
            const hostId = host.getAttribute("summoner-id");
            if (ownSummonerId && hostId && hostId !== ownSummonerId) return;
            const el = host.shadowRoot.querySelector("lol-regalia-banner-v2-element");
            if (el) results.push(el);
        });

        log("_getOwnBannerElements: found", results.length, "element(s)");
        return results;
    }

    /**
     * Applies the custom banner src to every banner element that belongs to the
     * local player — covers both the lobby banner and Arena hover tooltip cards.
     */
    function _applyToHoverBanners(url, type) {
        for (const bannerEl of _getOwnBannerElements()) {
            _applyCustomSrc(bannerEl, url, type);
        }
    }

    function inferMediaType(url) {
        if (!url) return "image";
        if (url.startsWith("data:video/")) return "video";
        if (url.match(/\.(webm|mp4)$/i)) return "video";
        return "image";
    }

    // ============================================================
    //  Banner Application
    // ============================================================
    function applyBanner() {
        if (!bannerEnabled) return;

        const saved = DS.get("selectedBanner");
        if (!saved) return;

        let targetUrl = null;
        let type = "image";

        if (saved.isCustom) {
            const custom = customBanners.find(b => b.name === saved.name);
            targetUrl = custom?.url || null;
            type = custom?.type || inferMediaType(targetUrl);
        } else {
            targetUrl = saved.assetPath;
            type = "image";
        }

        if (!targetUrl) return;

        // Apply to the lobby banner directly (existing fast path)
        const bannerEl = _getBannerElement();
        if (bannerEl) _applyCustomSrc(bannerEl, targetUrl, type);

        // Apply to all other contexts: hover tooltips, profile page, etc.
        _applyToHoverBanners(targetUrl, type);
    }

    async function _applyCustomSrc(bannerEl, url, type = "image") {
        const img = await waitForShadowElement(bannerEl, "img.regalia-banner-asset-static-image");
        if (!img) return warn("img not found after waiting");

        // Insert the video as a sibling of the img, inside the same
        // regalia-banner-asset-static container. This makes it inherit the
        // same sizing/clipping as the original image in every context
        // (lobby, profile, Arena hover tooltip) without needing absolute
        // positioning hacks relative to the state machine.
        const imgContainer = img.parentElement;
        let customVid = imgContainer?.querySelector(".bnc-custom-video");
        if (!customVid) {
            customVid = document.createElement("video");
            customVid.className = "bnc-custom-video";
            customVid.autoplay = true;
            customVid.loop = true;
            customVid.muted = true;
            customVid.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:0;pointer-events:none;display:none;";
            if (imgContainer) imgContainer.appendChild(customVid);
        }

        // Disconnect any existing observer on this specific img
        _customImgObservers.get(img)?.disconnect();

        if (!img.dataset.bncOriginalSrc) {
            const currentSrc = img.getAttribute("src");
            if (currentSrc && !currentSrc.startsWith("data:") && currentSrc !== url) {
                img.dataset.bncOriginalSrc = currentSrc;
            }
        }

        const forceSrc = () => {
            if (type === "video") {
                if (img.style.visibility !== "hidden") img.style.visibility = "hidden";
                if (customVid.style.display !== "block") customVid.style.display = "block";
                if (customVid.getAttribute("src") !== url) {
                    customVid.setAttribute("src", url);
                    log("Forced banner src to VIDEO:", url);
                }
                if (customVid.paused) customVid.play().catch(() => {});
            } else {
                if (img.style.visibility !== "") img.style.visibility = "";
                if (customVid.style.display !== "none") {
                    customVid.style.display = "none";
                    customVid.pause();
                }
                if (img.getAttribute("src") !== url) {
                    img.setAttribute("src", url);
                    log("Forced banner src to IMAGE:", url);
                }
            }
        };

        forceSrc();

        const obs = new MutationObserver(() => forceSrc());
        obs.observe(img, { attributes: true, attributeFilter: ["src", "style"] });
        _customImgObservers.set(img, obs);
    }

    function selectBanner(item) {
        const stub = item.isCustom
            ? { name: item.name, isCustom: true }
            : {
                id:          item.id,
                idSecondary: item.idSecondary || "",
                name:        item.name,
                assetPath:   item.assetPath,
                bannerType:  item.bannerType || "blank",
                isCustom:    false,
              };
        DS.set("selectedBanner", stub);
        applyBanner();
    }

    async function clearBanner() {
        // Disconnect all per-img observers
        _customImgObservers.forEach(obs => obs.disconnect());
        _customImgObservers.clear();

        // Restore every patched banner element (lobby, profile, tooltip)
        const allEls = [_getBannerElement(), ..._getOwnBannerElements()].filter(Boolean);
        const seen = new Set();
        for (const bannerEl of allEls) {
            if (seen.has(bannerEl)) continue;
            seen.add(bannerEl);

            const img = await waitForShadowElement(bannerEl, "img.regalia-banner-asset-static-image", 1000);
            if (img) {
                const customVid = img.parentElement?.querySelector(".bnc-custom-video");
                if (customVid) {
                    customVid.style.display = "none";
                    customVid.pause();
                }
                img.style.visibility = "";
                if (img.dataset.bncOriginalSrc) {
                    img.setAttribute("src", img.dataset.bncOriginalSrc);
                    delete img.dataset.bncOriginalSrc;
                }
            } else {
                const currentId = bannerEl.getAttribute("banner-id");
                if (currentId) {
                    bannerEl.removeAttribute("banner-id");
                    setTimeout(() => bannerEl.setAttribute("banner-id", currentId), 50);
                }
            }
        }

        DS.set("selectedBanner", null);
        log("Banner cleared");
    }

    // ============================================================
    //  Observers
    // ============================================================
    function setupLobbyObserver() {
        if (_lobbyObserver) _lobbyObserver.disconnect();

        _lobbyObserver = new MutationObserver(() => {
            if (!uiVisible) checkAndCreateButton();
            checkAndCreateCustomizerButton();

            const bannerEl = _getBannerElement();
            if (bannerEl && !bannerEl.dataset.bncDirectObserved) {
                setupDirectBannerObserver(bannerEl);
            }

            // applyBanner handles all contexts including newly injected tooltip/profile elements
            applyBanner();
        });

        _lobbyObserver.observe(document.body, { childList: true, subtree: true });
    }

    function setupDirectBannerObserver(bannerEl) {
        bannerEl.dataset.bncDirectObserved = "true";
        if (_bannerElementObserver) _bannerElementObserver.disconnect();

        _bannerElementObserver = new MutationObserver(() => {
            const saved = DS.get("selectedBanner");
            if (!saved) return;
            clearTimeout(_bannerApplyDeb);
            _bannerApplyDeb = setTimeout(() => applyBanner(), 80);
        });

        _bannerElementObserver.observe(bannerEl, {
            attributes: true,
            attributeFilter: ["banner-id"],
        });
        log("Attached direct observer to regalia-banner-v2-element");
    }

    // ============================================================
    //  File Helpers
    // ============================================================
    function validateFile(file) {
        const allowed = ["image/jpeg", "image/png", "image/webp", "video/webm"];
        if (!allowed.includes(file.type))
            return { valid: false, error: "Supported: JPG, PNG, WEBP, WEBM" };
        if (file.size > MAX_FILE_SIZE_BYTES)
            return { valid: false, error: `Max file size is 5 MB (file is ${(file.size / 1048576).toFixed(1)} MB)` };
        return { valid: true };
    }

    function processFile(file, maxW = 600, maxH = 1200, quality = 0.85) {
        return new Promise((resolve, reject) => {
            const isVideo = file.type.startsWith("video/");
            const reader = new FileReader();

            reader.onload = e => {
                if (isVideo) {
                    resolve({ dataUrl: e.target.result, type: "video" });
                } else {
                    const img = new Image();
                    img.onload = () => {
                        let w = img.width, h = img.height;
                        if (w > maxW) { h = h * maxW / w; w = maxW; }
                        if (h > maxH) { w = w * maxH / h; h = maxH; }

                        const canvas = document.createElement("canvas");
                        canvas.width = w; canvas.height = h;
                        canvas.getContext("2d").drawImage(img, 0, 0, w, h);

                        const format = file.type === "image/png" ? "image/png" : "image/jpeg";
                        resolve({ dataUrl: canvas.toDataURL(format, quality), type: "image" });
                    };
                    img.onerror = () => reject(new Error("Failed to decode image"));
                    img.src = e.target.result;
                }
            };
            reader.onerror = () => reject(new Error("Failed to read file"));
            reader.readAsDataURL(file);
        });
    }

    function validateUrl(url) {
        return url.startsWith("data:") || url.startsWith("http://") ||
               url.startsWith("https://") || url.startsWith("file://");
    }

    // ============================================================
    //  Shared Styles
    // ============================================================
    function injectSharedStyles() {
        if (document.getElementById("bnc-shared-style")) return;
        const s = document.createElement("style");
        s.id = "bnc-shared-style";
        s.textContent = `
            .bnc-panel{font-family:'LoL Display','BeaufortforLOL',sans-serif;background:#010a13;border:1px solid #463714;border-top-color:#785a28;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.8),0 8px 40px rgba(0,0,0,.95),0 0 60px rgba(120,90,40,.1);display:flex;flex-direction:column;overflow:hidden;position:relative}
            .bnc-panel-header{display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:44px;flex-shrink:0;border-bottom:1px solid #785a28;background:linear-gradient(to bottom,#0d1b26,#010a13)}
            .bnc-panel-title{color:#f0e6d2;font-size:15px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;margin:0}
            .bnc-panel-body{flex:1;display:flex;flex-direction:column;overflow:hidden;padding:0;gap:0}
            .bnc-panel-footer{display:flex;align-items:center;justify-content:center;gap:10px;padding:10px 16px;border-top:1px solid #785a28;flex-shrink:0}
            .bnc-sub-border{width:100%;height:2px;flex-shrink:0;background:linear-gradient(to right,transparent,#785a28 20%,#c8aa6e 50%,#785a28 80%,transparent);opacity:.6}
            .bnc-scroll{scrollbar-width:thin;scrollbar-color:#463714 #0a0f16;overflow-y:auto}
            .bnc-scroll::-webkit-scrollbar{width:6px}
            .bnc-scroll::-webkit-scrollbar-track{background:#0a0f16}
            .bnc-scroll::-webkit-scrollbar-thumb{background:#463714;border-radius:3px}
            .bnc-scroll::-webkit-scrollbar-thumb:hover{background:#785a28}
            .bnc-section-title{color:#c8aa6e;font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;padding:16px 0 8px;margin:0;border-bottom:1px solid #1e2328}
            .bnc-setting-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;color:#cdbe91;font-size:13px;border-bottom:1px solid rgba(30,35,40,.5)}
            .bnc-input{background:#010a13;border:1px solid #785a28;border-bottom-color:#c8aa6e;color:#cdbe91;padding:7px 10px;outline:none;font-family:'LoL Display',sans-serif;font-size:13px;box-sizing:border-box;width:100%}
            #bnc-main-ui{width:860px;height:620px}
            #bnc-main-ui .bnc-body-row{display:flex;flex:1;overflow:hidden;min-height:0}
            #bnc-main-ui .bnc-content-col{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
            #bnc-main-ui .bnc-toolbar{display:flex;align-items:center;justify-content:center;gap:8px;padding:7px 12px;border-bottom:1px solid #1e2328;flex-shrink:0;background:rgba(0,0,0,.25)}
            #bnc-main-ui .bnc-scroll{flex:1;min-height:0;position:relative}
            #bnc-main-ui .bnc-scroll-inner{display:flex;flex-direction:column;gap:10px;padding:10px 12px}
            #bnc-main-ui .bnc-group-title{color:#c8aa6e;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:2px;display:flex;align-items:center;gap:6px;padding:6px 0 4px;border-bottom:1px solid #1e2328;margin-bottom:4px}
            #bnc-main-ui .bnc-banner-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;content-visibility:auto;contain-intrinsic-size:0 400px}
            #bnc-main-ui .bnc-banner-tile{width:110px;height:220px;background:#070e17;border:1px solid #1e2328;cursor:pointer;position:relative;box-sizing:border-box;overflow:hidden;border-radius:2px}
            #bnc-main-ui .bnc-banner-tile.selected{border:2px solid #c8aa6e;box-shadow:0 0 8px rgba(200,170,110,.4);z-index:1}
            #bnc-main-ui .bnc-banner-label{position:absolute;bottom:0;left:0;width:100%;box-sizing:border-box;padding:20px 6px 5px;background:linear-gradient(to top,rgba(0,0,0,.95) 0%,rgba(0,0,0,.7) 50%,transparent 100%);color:#e0e0e0;font-size:10px;font-weight:bold;text-align:center;text-shadow:1px 1px 3px rgba(0,0,0,1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;transition:color .15s;z-index:5}
            #bnc-main-ui .bnc-banner-tile:hover .bnc-banner-label{color:#f0e6d2}
            #bnc-main-ui .bnc-banner-tile.selected .bnc-banner-label{color:#c8aa6e}
            #bnc-main-ui .bnc-fail-text{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#3c3c41;font-size:10px;z-index:1;text-align:center;padding:4px}
            #bnc-main-ui .bnc-del-btn{position:absolute;top:3px;left:3px;width:22px;height:22px;background:rgba(0,0,0,.7) url("/fe/lol-uikit/images/icon_delete.png") no-repeat center;background-size:16px;border:1px solid #785a28;border-radius:2px;color:transparent;font-size:0;cursor:pointer;opacity:0;z-index:10}
            #bnc-main-ui .bnc-banner-tile:hover .bnc-del-btn{opacity:1}
            #bnc-main-ui .bnc-edit-btn{position:absolute;top:3px;left:29px;width:22px;height:22px;background:rgba(0,0,0,.7);border:1px solid #785a28;border-radius:2px;color:#cdbe91;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0;z-index:10}
            #bnc-main-ui .bnc-banner-tile:hover .bnc-edit-btn{opacity:1}
            #bnc-main-ui .bnc-bottom-bar{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:7px 16px;border-top:1px solid #1e2328;flex-shrink:0;height:52px;background:linear-gradient(to top,rgba(1,10,19,.9),transparent)}
            .bnc-cog-btn{width:28px;height:28px;border-radius:50%;cursor:pointer;background:linear-gradient(to top,#463714 4%,#785a28 23%,#c89b3c 90%,#c8aa6e 100%);display:flex;align-items:center;justify-content:center}
            .bnc-cog-inner{width:24px;height:24px;border-radius:50%;background:#1e282d;display:flex;align-items:center;justify-content:center}
            .bnc-cog-icon{width:18px;height:18px;-webkit-mask:url(/fe/lol-uikit/images/icon_settings.png) no-repeat center;-webkit-mask-size:18px;background:#cdbe91}
            .bnc-dialog-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:20000;display:flex;align-items:center;justify-content:center}
            .bnc-dialog-frame{background:#010a13;border:1px solid #463714;border-top-color:#785a28;border-radius:2px;min-width:320px;max-width:420px;box-shadow:0 0 0 1px rgba(0,0,0,.8),0 8px 40px rgba(0,0,0,.95);font-family:'LoL Display',sans-serif;overflow:hidden}
            .bnc-dialog-header{padding:12px 20px 10px;border-bottom:1px solid #1e2328;background:linear-gradient(to bottom,#0d1b26,#010a13)}
            .bnc-dialog-header h4{margin:0;color:#f0e6d2;font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase}
            .bnc-dialog-body{padding:14px 20px;color:#cdbe91;font-size:13px;line-height:1.5}
            .bnc-no-results{color:#5b5a56;font-size:13px;padding:8px 0 16px}
            .bnc-custombanner-body{display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0}
            .bnc-custombanner-scroll{flex:1;min-height:0;padding:16px;box-sizing:border-box}
            .bnc-custombanner-scroll .bnc-cols{display:flex;gap:16px;align-items:flex-start}
            .bnc-custombanner-scroll .bnc-left-col{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px}
            .bnc-custombanner-scroll .bnc-center-col{display:flex;flex-direction:column;align-items:center;gap:8px;flex-shrink:0}
        `;
        document.head.appendChild(s);
    }

    // ============================================================
    //  UI Boilerplate
    // ============================================================
    function makeFlatButton(text, primary = false) {
        const btn = document.createElement("lol-uikit-flat-button");
        if (primary) btn.setAttribute("primary", "");
        btn.textContent = text;
        return btn;
    }

    function makeSectionTitle(text) {
        const el = document.createElement("div");
        el.className = "bnc-section-title";
        el.textContent = text;
        return el;
    }

    function makeSettingRow(labelText, control) {
        const row = document.createElement("div");
        row.className = "bnc-setting-row";
        row.innerHTML = `<span style="flex:1">${labelText}</span>`;
        row.appendChild(control);
        return row;
    }

    function makeToggle(checked) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "position:relative;width:70px;height:29px;cursor:pointer;flex-shrink:0;";
        const bg = document.createElement("div");
        bg.style.cssText = "width:70px;height:29px;background:url(/fe/lol-parties/toggle-slider-closed.png) center/contain no-repeat;";
        const on = document.createElement("div");
        on.style.cssText = "width:70px;height:29px;position:absolute;top:0;left:0;background:url(/fe/lol-parties/toggle-slider-open.png) center/contain no-repeat;transition:opacity .3s;";
        on.style.opacity = checked ? "1" : "0";
        const thumb = document.createElement("div");
        thumb.style.cssText = `position:absolute;top:50%;transform:translateY(-50%);transition:left .3s;left:${checked ? "40px" : "2px"};`;
        thumb.innerHTML = `<div class="bnc-cog-btn" style="pointer-events:none;width:24px;height:24px;"><div class="bnc-cog-inner" style="width:20px;height:20px;"></div></div>`;
        wrap.append(bg, on, thumb);
        let _val = checked, _cb = null;
        wrap.addEventListener("click", () => {
            _val = !_val;
            on.style.opacity = _val ? "1" : "0";
            thumb.style.left = _val ? "40px" : "2px";
            if (_cb) _cb(_val);
        });
        return {
            el:       wrap,
            getValue: () => _val,
            setValue: (v) => { _val = v; on.style.opacity = v ? "1" : "0"; thumb.style.left = v ? "40px" : "2px"; },
            onChange: (fn) => { _cb = fn; },
        };
    }

    function bncConfirm(title, body) {
        return new Promise(resolve => {
            const bd = document.createElement("div");
            bd.className = "bnc-dialog-backdrop";
            const fr = document.createElement("div");
            fr.className = "bnc-dialog-frame";
            const hd = document.createElement("div");
            hd.className = "bnc-dialog-header";
            hd.innerHTML = `<h4>${title}</h4>`;
            const bl = document.createElement("div");
            bl.className = "bnc-dialog-body";
            bl.textContent = body;
            const ft = document.createElement("div");
            ft.style.cssText = "padding:10px 20px 14px;display:flex;justify-content:center;gap:8px;";
            const ok = makeFlatButton("Confirm", true);
            const no = makeFlatButton("Cancel");
            ok.addEventListener("click", () => { bd.remove(); resolve(true); });
            no.addEventListener("click", () => { bd.remove(); resolve(false); });
            ft.append(ok, no);
            fr.append(hd, bl, ft);
            bd.appendChild(fr);
            document.body.appendChild(bd);
        });
    }

    function makeSubPanel(id, title, width, height) {
        document.getElementById("bnc-main-wrapper")?.style.setProperty("display", "none");
        const backdrop = document.createElement("div");
        backdrop.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;";
        const wrapper = document.createElement("div");
        wrapper.id = id + "-wrapper";
        wrapper.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10001;";
        const panel = document.createElement("div");
        panel.id = id + "-panel";
        panel.className = "bnc-panel";
        panel.style.cssText = `width:${width}px;height:${height}px;`;
        const hdr = document.createElement("div");
        hdr.className = "bnc-panel-header";
        hdr.innerHTML = `<h3 class="bnc-panel-title">${title}</h3>`;
        const sub = document.createElement("div");
        sub.className = "bnc-sub-border";
        const body = document.createElement("div");
        body.className = "bnc-panel-body";
        const footer = document.createElement("div");
        footer.className = "bnc-panel-footer";
        const doneBtn = makeFlatButton("Done", true);
        doneBtn.addEventListener("click", doClose);
        footer.appendChild(doneBtn);
        panel.append(hdr, sub, body, footer);
        wrapper.appendChild(panel);
        document.body.append(backdrop, wrapper);

        function doClose() {
            backdrop.remove();
            wrapper.remove();
            const mw = document.getElementById("bnc-main-wrapper");
            if (mw) mw.style.display = "";
            else openMainUI();
        }
        return { backdrop, wrapper, panel, body, footer, doneBtn, close: doClose };
    }

    // ============================================================
    //  Settings Panel
    // ============================================================
    function openSettingsUI() {
        const { body } = makeSubPanel("bnc-settings", "Settings", 440, 320);
        body.style.cssText = "display:flex;flex-direction:column;padding:16px 20px;gap:0;overflow:hidden;";

        body.appendChild(makeSectionTitle("General"));
        const enableTog = makeToggle(bannerEnabled);
        enableTog.onChange(v => {
            bannerEnabled = v;
            saveSettings();
            if (v) applyBanner();
            else clearBanner();
        });
        body.appendChild(makeSettingRow("Enable banner override", enableTog.el));

        body.appendChild(makeSectionTitle("Debug"));
        const dbgTog = makeToggle(DEBUG);
        dbgTog.onChange(v => { DEBUG = v; saveSettings(); });
        body.appendChild(makeSettingRow("Enable debug logging", dbgTog.el));

        const ver = document.createElement("div");
        ver.textContent = `BNC v${BNC_VERSION}`;
        ver.style.cssText = "color:#3c3c41;font-size:11px;text-align:right;padding:20px 0 4px;margin-top:auto;";
        body.appendChild(ver);
    }

    // ============================================================
    //  Custom Banner Panel
    // ============================================================
    function openCustomBannerUI(existingItem = null) {
        const isEdit = !!existingItem;
        const { body, close } = makeSubPanel(
            "bnc-custombanner",
            isEdit ? "Edit Custom Banner" : "Add Custom Banner",
            580, 460,
        );

        // Body uses flex column, no overflow on itself — scroll is handled by inner scroll div
        body.style.cssText = "display:flex;flex-direction:column;overflow:hidden;";

        // Error message row — fixed at top, never scrolls away
        const errMsg = document.createElement("div");
        errMsg.style.cssText = "color:#f44;font-size:12px;min-height:18px;flex-shrink:0;padding:6px 16px 0;";
        function showError(msg) { errMsg.textContent = msg; setTimeout(() => errMsg.textContent = "", 4000); }
        body.appendChild(errMsg);

        // Scrollable content area with custom scrollbar
        const scrollArea = document.createElement("div");
        scrollArea.className = "bnc-scroll";
        scrollArea.style.cssText = "flex:1;min-height:0;padding:12px 16px 16px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;";
        body.appendChild(scrollArea);

        // Name field
        const nameArea = document.createElement("div");
        nameArea.style.cssText = "flex-shrink:0;display:flex;flex-direction:column;gap:4px;";
        nameArea.innerHTML = `<label style="color:#cdbe91;font-size:12px;letter-spacing:1px;">Name</label>`;
        const nameField = document.createElement("input");
        nameField.className = "bnc-input";
        nameField.placeholder = "My custom banner name";
        if (isEdit) nameField.value = existingItem.name;
        nameArea.appendChild(nameField);
        scrollArea.appendChild(nameArea);

        // Two-column layout: left (controls) + right (preview)
        const cols = document.createElement("div");
        cols.style.cssText = "display:flex;gap:16px;align-items:flex-start;";

        const leftCol = document.createElement("div");
        leftCol.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;";

        const centerCol = document.createElement("div");
        centerCol.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:8px;flex-shrink:0;";

        // Info note
        const note = document.createElement("div");
        note.style.cssText = "color:#cdbe91;font-size:11px;padding:8px 10px;background:rgba(200,170,110,.08);border-left:2px solid #c8aa6e;line-height:1.5;border-radius:0 2px 2px 0;";
        note.innerHTML = `Portrait-oriented (tall).<br>Supported: <b>JPG, PNG, WEBM</b>.<br>Paste an external URL or upload a file (max 5 MB).`;
        leftCol.appendChild(note);

        // Preview column
        const previewLabel = document.createElement("div");
        previewLabel.style.cssText = "color:#785a28;font-size:10px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;";
        previewLabel.textContent = "Preview";

        const previewEl = document.createElement("div");
        previewEl.style.cssText = "width:110px;height:200px;background:#0a1428;border:1px solid #1e2328;overflow:hidden;border-radius:2px;flex-shrink:0;";
        previewEl.innerHTML = `<span style="color:#5b5a56;font-size:11px;text-align:center;padding:6px;display:flex;align-items:center;justify-content:center;height:100%;box-sizing:border-box;">No media</span>`;
        centerCol.append(previewLabel, previewEl);

        function updatePreview(src, type) {
            previewEl.innerHTML = "";
            if (type === "video") {
                const vid = document.createElement("video");
                vid.style.cssText = "width:100%;height:100%;object-fit:cover;object-position:center -55px;";
                vid.autoplay = true; vid.loop = true; vid.muted = true;
                vid.src = src;
                vid.onerror = () => {
                    previewEl.innerHTML = `<span style="color:#f44;font-size:10px;text-align:center;padding:4px;display:flex;align-items:center;justify-content:center;height:100%;box-sizing:border-box;">Failed to load video</span>`;
                };
                previewEl.appendChild(vid);
            } else {
                const img = document.createElement("img");
                img.style.cssText = "width:100%;height:100%;object-fit:cover;object-position:center -55px;";
                img.src = src;
                img.onerror = () => {
                    previewEl.innerHTML = `<span style="color:#f44;font-size:10px;text-align:center;padding:4px;display:flex;align-items:center;justify-content:center;height:100%;box-sizing:border-box;">Failed to load image</span>`;
                };
                previewEl.appendChild(img);
            }
        }

        let pendingUrl  = isEdit ? existingItem.url : null;
        let pendingType = isEdit ? (existingItem.type || inferMediaType(existingItem.url)) : "image";
        if (isEdit && existingItem.url) updatePreview(existingItem.url, pendingType);

        // File picker
        const fileSection = document.createElement("div");
        fileSection.style.cssText = "display:flex;flex-direction:column;gap:6px;";
        fileSection.innerHTML = `<label style="color:#cdbe91;font-size:12px;letter-spacing:1px;">Banner File</label>`;
        const fileRow = document.createElement("div");
        fileRow.style.cssText = "display:flex;gap:6px;align-items:center;";
        const fileIn = document.createElement("input");
        fileIn.type = "file";
        fileIn.accept = "image/jpeg,image/png,image/webp,video/webm";
        fileIn.style.display = "none";
        const pickBtn = makeFlatButton("Browse");
        const fileLbl = document.createElement("span");
        fileLbl.style.cssText = "color:#5b5a56;font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        fileLbl.textContent = "No file selected";
        pickBtn.addEventListener("click", () => fileIn.click());

        fileIn.addEventListener("change", async e => {
            const file = e.target.files?.[0];
            if (!file) return;
            const v = validateFile(file);
            if (!v.valid) { showError(v.error); fileIn.value = ""; return; }
            fileLbl.textContent = "Processing...";
            try {
                const { dataUrl, type } = await processFile(file);
                pendingUrl  = dataUrl;
                pendingType = type;
                fileLbl.textContent = file.name;
                updatePreview(dataUrl, type);
            } catch (ex) {
                showError("Failed to process file: " + ex.message);
                fileIn.value = "";
            }
        });
        fileRow.append(fileIn, pickBtn, fileLbl);
        fileSection.appendChild(fileRow);

        // URL input
        const urlRow = document.createElement("div");
        urlRow.style.cssText = "display:flex;flex-direction:column;gap:4px;";
        urlRow.innerHTML = `<label style="color:#cdbe91;font-size:12px;letter-spacing:1px;">Or paste a URL</label>`;
        const urlInput = document.createElement("input");
        urlInput.className = "bnc-input";
        urlInput.placeholder = "https://example.com/banner.webm";
        if (isEdit && existingItem.url && !existingItem.url.startsWith("data:")) urlInput.value = existingItem.url;
        let _urlDeb;
        urlInput.addEventListener("input", () => {
            clearTimeout(_urlDeb);
            _urlDeb = setTimeout(() => {
                const v = urlInput.value.trim();
                if (!v || !validateUrl(v)) return;
                pendingUrl  = v;
                pendingType = inferMediaType(v);
                fileLbl.textContent = "No file selected";
                fileIn.value = "";
                updatePreview(v, pendingType);
            }, 400);
        });
        urlRow.appendChild(urlInput);

        leftCol.append(fileSection, urlRow);
        cols.append(leftCol, centerCol);
        scrollArea.appendChild(cols);

        // Override footer buttons
        const panelEl = document.getElementById("bnc-custombanner-panel");
        const footer  = panelEl?.querySelector(".bnc-panel-footer");
        if (footer) {
            footer.innerHTML = "";
            const cancelBtn = makeFlatButton("Cancel");
            cancelBtn.addEventListener("click", close);
            const saveBtn = makeFlatButton(isEdit ? "Save Changes" : "Add Banner", true);
            saveBtn.addEventListener("click", () => {
                const name = nameField.value.trim();
                if (!name) { showError("Please enter a name"); return; }
                const url = pendingUrl || urlInput.value.trim() || (isEdit ? existingItem.url : "");
                if (!url) { showError("Please select media or paste a URL"); return; }

                const itemType = pendingType || inferMediaType(url);

                if (isEdit) {
                    const idx = customBanners.findIndex(b => b.name === existingItem.name);
                    if (idx !== -1) customBanners[idx] = { name, url, type: itemType, isCustom: true };
                    else customBanners.push({ name, url, type: itemType, isCustom: true });
                } else {
                    if (customBanners.some(b => b.name === name)) { showError("Name already taken"); return; }
                    customBanners.push({ name, url, type: itemType, isCustom: true });
                }
                saveSettings();
                close();
                if (window._bncRenderBanners) window._bncRenderBanners();
            });
            footer.append(cancelBtn, saveBtn);
        }
    }

    // ============================================================
    //  Main UI
    // ============================================================
    function openMainUI() {
        document.getElementById("bnc-main-wrapper")?.remove();
        document.getElementById("bnc-main-backdrop")?.remove();

        const backdrop = document.createElement("div");
        backdrop.id = "bnc-main-backdrop";
        backdrop.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9997;";
        const wrapper = document.createElement("div");
        wrapper.id = "bnc-main-wrapper";
        wrapper.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9998;";

        const ui = document.createElement("div");
        ui.id = "bnc-main-ui";
        ui.className = "bnc-panel";

        // Header
        const hdr = document.createElement("div");
        hdr.className = "bnc-panel-header";
        hdr.innerHTML = `<h3 class="bnc-panel-title">Banner Customizer</h3>`;
        const hdrR = document.createElement("div");
        hdrR.style.cssText = "display:flex;align-items:center;gap:14px;";
        const cogBtn = document.createElement("div");
        cogBtn.style.cssText = "cursor:pointer;flex-shrink:0;";
        cogBtn.innerHTML = `<lol-uikit-close-button button-type="cog"></lol-uikit-close-button>`;
        cogBtn.addEventListener("click", () => openSettingsUI());
        hdrR.appendChild(cogBtn);
        const closeBtn = document.createElement("div");
        closeBtn.style.cssText = "cursor:pointer;flex-shrink:0;";
        closeBtn.innerHTML = `<lol-uikit-close-button></lol-uikit-close-button>`;
        closeBtn.addEventListener("click", closeMainUI);
        hdrR.appendChild(closeBtn);
        hdr.appendChild(hdrR);
        ui.appendChild(hdr);

        const subBorder = document.createElement("div");
        subBorder.className = "bnc-sub-border";
        ui.appendChild(subBorder);

        const bodyRow = document.createElement("div");
        bodyRow.className = "bnc-body-row";
        const contentCol = document.createElement("div");
        contentCol.className = "bnc-content-col";
        bodyRow.appendChild(contentCol);
        ui.appendChild(bodyRow);

        // Toolbar
        const toolbar = document.createElement("div");
        toolbar.className = "bnc-toolbar";
        const addCustomBtn = makeFlatButton("+ Add Custom Banner");
        addCustomBtn.addEventListener("click", () => {
            wrapper.style.display = "none";
            openCustomBannerUI();
        });
        toolbar.appendChild(addCustomBtn);
        contentCol.appendChild(toolbar);

        // Scroll area
        const mainScroll = document.createElement("div");
        mainScroll.className = "bnc-scroll";
        const scrollInner = document.createElement("div");
        scrollInner.className = "bnc-scroll-inner";
        mainScroll.appendChild(scrollInner);
        contentCol.appendChild(mainScroll);

        // Bottom bar
        const bottomBar = document.createElement("div");
        bottomBar.className = "bnc-bottom-bar";
        const clearBtn = makeFlatButton("Clear Banner");
        clearBtn.addEventListener("click", () => {
            if (_selectedTileDom) { _selectedTileDom.classList.remove("selected"); _selectedTileDom = null; }
            clearBanner();
        });
        const confirmBtn = makeFlatButton("Confirm", true);
        confirmBtn.addEventListener("click", closeMainUI);
        bottomBar.append(clearBtn, confirmBtn);
        contentCol.appendChild(bottomBar);

        wrapper.appendChild(ui);
        document.body.append(backdrop, wrapper);

        // Lazy-load tile media via IntersectionObserver
        const tileObserver = new IntersectionObserver(entries => {
            entries.filter(e => e.isIntersecting).forEach(entry => {
                const tile = entry.target;
                if (!tile.dataset.pendingSrc) return;
                if (tile.dataset.pendingType === "video") {
                    const vid = document.createElement("video");
                    vid.src = tile.dataset.pendingSrc;
                    vid.autoplay = true; vid.loop = true; vid.muted = true;
                    vid.style.cssText = "width:100%;height:100%;object-fit:cover;object-position:center -55px;position:absolute;top:0;left:0;z-index:0;";
                    tile.insertBefore(vid, tile.firstChild);
                } else {
                    const img = document.createElement("img");
                    img.src = tile.dataset.pendingSrc;
                    img.style.cssText = "width:100%;height:100%;object-fit:cover;object-position:center -55px;position:absolute;top:0;left:0;z-index:0;";
                    tile.insertBefore(img, tile.firstChild);
                }
                delete tile.dataset.pendingSrc;
                delete tile.dataset.pendingType;
                tileObserver.unobserve(tile);
            });
        }, { root: mainScroll, rootMargin: "200px" });

        scrollInner.addEventListener("click", async e => {
            const editBtn = e.target.closest(".bnc-edit-btn");
            if (editBtn) {
                e.stopPropagation();
                const tile = editBtn.closest(".bnc-banner-tile");
                if (!tile) return;
                const existing = customBanners.find(b => b.name === tile.dataset.name);
                if (existing) { wrapper.style.display = "none"; openCustomBannerUI(existing); }
                return;
            }

            const delBtn = e.target.closest(".bnc-del-btn");
            if (delBtn) {
                e.stopPropagation();
                const tile = delBtn.closest(".bnc-banner-tile");
                if (!tile) return;
                const name = tile.dataset.name;
                const ok = await bncConfirm("Delete Custom Banner", `Delete "${name}"?`);
                if (!ok) return;
                customBanners = customBanners.filter(b => b.name !== name);
                const saved = DS.get("selectedBanner");
                if (saved?.name === name && saved?.isCustom) clearBanner();
                saveSettings();
                renderBanners();
                return;
            }

            const tile = e.target.closest(".bnc-banner-tile");
            if (!tile) return;
            if (_selectedTileDom) _selectedTileDom.classList.remove("selected");
            tile.classList.add("selected");
            _selectedTileDom = tile;

            let item;
            if (tile.dataset.iscustom === "1") {
                item = { name: tile.dataset.name, isCustom: true };
            } else {
                item = {
                    id:          tile.dataset.id,
                    idSecondary: tile.dataset.idsecondary || "",
                    name:        tile.dataset.name,
                    assetPath:   tile.dataset.assetpath,
                    isCustom:    false,
                };
            }
            selectBanner(item);
        });

        function buildTile(item, savedBanner) {
            const tile = document.createElement("div");
            tile.className = "bnc-banner-tile";
            tile.dataset.name        = item.name;
            tile.dataset.id          = item.id || "";
            tile.dataset.idsecondary = item.idSecondary || "";
            tile.dataset.assetpath   = item.assetPath || "";
            tile.dataset.iscustom    = item.isCustom ? "1" : "0";

            let isSelected = false;
            if (savedBanner) {
                if (item.isCustom && savedBanner.isCustom && savedBanner.name === item.name)
                    isSelected = true;
                else if (!item.isCustom && !savedBanner.isCustom && savedBanner.assetPath === item.assetPath)
                    isSelected = true;
            }
            if (isSelected) { tile.classList.add("selected"); _selectedTileDom = tile; }

            let imgUrl = "";
            let type   = "image";

            if (item.isCustom) {
                const b = customBanners.find(b => b.name === item.name);
                imgUrl = b?.url || "";
                type   = b?.type || inferMediaType(imgUrl);
            } else {
                imgUrl = item.assetPath;
            }

            if (imgUrl) {
                tile.dataset.pendingSrc  = imgUrl;
                tile.dataset.pendingType = type;
            } else {
                tile.classList.add("failed");
                const noPrev = document.createElement("div");
                noPrev.className = "bnc-fail-text";
                noPrev.textContent = "No Preview";
                tile.appendChild(noPrev);
            }

            if (item.isCustom) {
                const editBtn = document.createElement("div");
                editBtn.className = "bnc-edit-btn";
                editBtn.textContent = "\u270e";
                tile.appendChild(editBtn);
                const delBtn = document.createElement("div");
                delBtn.className = "bnc-del-btn";
                tile.appendChild(delBtn);
            }

            const label = document.createElement("div");
            label.className = "bnc-banner-label";
            label.textContent = item.name;
            tile.appendChild(label);

            _currentRenderTiles.add(tile);
            return tile;
        }

        function renderBanners() {
            _currentRenderTiles.clear();
            tileObserver.disconnect();
            scrollInner.innerHTML = "";

            const savedBanner = DS.get("selectedBanner");
            const frag = document.createDocumentFragment();

            const customTitle = document.createElement("div");
            customTitle.className = "bnc-group-title";
            customTitle.innerHTML = `<span>Custom Banners</span>`;
            frag.appendChild(customTitle);

            if (customBanners.length === 0) {
                const empty = document.createElement("div");
                empty.className = "bnc-no-results";
                empty.textContent = 'No custom banners yet. Click "+ Add Custom Banner" above.';
                frag.appendChild(empty);
            } else {
                const customGrid = document.createElement("div");
                customGrid.className = "bnc-banner-grid";
                customBanners.forEach(b => {
                    customGrid.appendChild(buildTile(
                        { id: "custom", idSecondary: "", name: b.name, assetPath: "", isCustom: true },
                        savedBanner
                    ));
                });
                frag.appendChild(customGrid);
            }

            const lcuTitle = document.createElement("div");
            lcuTitle.className = "bnc-group-title";
            lcuTitle.innerHTML = `<span>Banners</span>`;
            frag.appendChild(lcuTitle);

            if (bannerData.length === 0) {
                const noData = document.createElement("div");
                noData.className = "bnc-no-results";
                noData.textContent = "No banners found. Make sure you are in a lobby.";
                frag.appendChild(noData);
            } else {
                const lcuGrid = document.createElement("div");
                lcuGrid.className = "bnc-banner-grid";
                bannerData.forEach(item => lcuGrid.appendChild(buildTile(item, savedBanner)));
                frag.appendChild(lcuGrid);
            }

            scrollInner.appendChild(frag);

            for (const tile of _currentRenderTiles) {
                if (tile.dataset.pendingSrc) tileObserver.observe(tile);
            }

            setTimeout(() => {
                const sel = scrollInner.querySelector(".bnc-banner-tile.selected");
                if (sel) sel.scrollIntoView({ behavior: "auto", block: "center" });
            }, 50);
        }

        window._bncRenderBanners      = () => renderBanners();
        window._bncDisconnectObservers = () => tileObserver.disconnect();

        queueMicrotask(() => renderBanners());
    }

    function closeMainUI() {
        window._bncDisconnectObservers?.();
        window._bncDisconnectObservers = null;
        window._bncRenderBanners       = null;
        document.getElementById("bnc-main-wrapper")?.remove();
        document.getElementById("bnc-main-backdrop")?.remove();
        uiVisible = false;
        checkAndCreateButton();
    }

    // ============================================================
    //  Button Injection
    // ============================================================
    function checkAndCreateButton() {
        const container = document.querySelector(".lobby-header-buttons-container");
        if (!container || document.getElementById("bnc-show-button")) return;
        const btn = document.createElement("lol-uikit-flat-button");
        btn.id = "bnc-show-button";
        btn.textContent = "BNC";
        btn.style.marginRight = "8px";
        btn.addEventListener("click", () => { openMainUI(); uiVisible = true; });
        container.insertBefore(btn, container.firstChild);
    }

    // Injects a "Custom Banner" button beside the search bar on the native
    // identity-customizer Banners tab, opening the full BNC picker so custom
    // banners are reachable without leaving the client screen. Keyed off the
    // banner-specific .identity-customizer-banner tile so it only shows on the
    // Banners tab (not Icons/Borders/etc), locale-independent.
    function checkAndCreateCustomizerButton() {
        const bannerTile = document.querySelector(".identity-customizer-banner");
        const onBannerScreen = bannerTile && bannerTile.offsetParent !== null;
        let btn = document.getElementById("bnc-customizer-button");

        if (!onBannerScreen) { btn?.remove(); return; }
        if (btn && btn.isConnected) return;

        const searchBox = document.querySelector(".identity-customizer-subheader .search-filter-container");
        if (!searchBox) return;

        btn = makeFlatButton("Custom Banner");
        btn.id = "bnc-customizer-button";
        btn.style.cssText = "margin-left:8px;flex-shrink:0;";
        btn.addEventListener("click", () => { openMainUI(); uiVisible = true; });
        searchBox.insertAdjacentElement("afterend", btn);
    }

    // ============================================================
    //  Native Identity-Customizer Picker Hook
    // ============================================================
    //  In League's own banner picker (the identity customizer), locked banners
    //  can't be selected — clicking them opens a purchase prompt. We intercept
    //  that click and instead mirror the locked banner onto the live preview
    //  card (lol-regalia-identity-customizer-element) so the user can see how it
    //  would look, without leaving the picker.
    let _nativePreviewAttrs  = null; // { bannerId, bannerType, bannerRank }
    let _nativePreviewGuard  = null; // MutationObserver keeping our preview applied

    function _clearNativePreviewGuard() {
        _nativePreviewGuard?.disconnect();
        _nativePreviewGuard = null;
        _nativePreviewAttrs = null;
    }

    function _applyToIdentityPreview(bannerId, bannerType, bannerRank) {
        const preview = document.querySelector("lol-regalia-identity-customizer-element");
        if (!preview) return;

        _nativePreviewAttrs = { bannerId, bannerType, bannerRank };

        const setAttrs = () => {
            if (preview.getAttribute("banner-id") !== bannerId) preview.setAttribute("banner-id", bannerId);
            if (bannerType && preview.getAttribute("banner-type") !== bannerType) preview.setAttribute("banner-type", bannerType);
            if (bannerRank && preview.getAttribute("banner-rank") !== bannerRank) preview.setAttribute("banner-rank", bannerRank);
        };
        setAttrs();
        log("Native preview -> banner-id", bannerId);

        // The native code re-asserts banner-id from its selected model on any
        // re-render; keep re-applying ours until the user picks an owned banner.
        _nativePreviewGuard?.disconnect();
        _nativePreviewGuard = new MutationObserver(() => {
            if (!_nativePreviewAttrs) return;
            if (!preview.isConnected) { _clearNativePreviewGuard(); return; }
            if (preview.getAttribute("banner-id") !== _nativePreviewAttrs.bannerId) setAttrs();
        });
        _nativePreviewGuard.observe(preview, {
            attributes: true,
            attributeFilter: ["banner-id", "banner-type", "banner-rank"],
        });
    }

    function _onIdentityBannerClick(e) {
        if (!nativePreviewEnabled) return;

        const tile = e.target.closest?.(".identity-customizer-banner");
        if (!tile) return;

        // Owned/selectable tile: let native selection run and stop overriding.
        if (!tile.classList.contains("unselectable")) {
            _clearNativePreviewGuard();
            return;
        }

        const regalia = tile.querySelector("lol-regalia-banner-v2-element");
        if (!regalia) return;

        // Block the native purchase prompt, preview instead.
        e.preventDefault();
        e.stopPropagation();

        document.querySelectorAll(".identity-customizer-banner.selected")
            .forEach(t => t.classList.remove("selected"));
        tile.classList.add("selected");

        _applyToIdentityPreview(
            regalia.getAttribute("banner-id"),
            regalia.getAttribute("banner-type") || "blank",
            regalia.getAttribute("banner-rank") || "",
        );
    }

    function setupNativePickerHook() {
        // Capture-phase so we run before the tile's own Ember click action.
        document.addEventListener("click", _onIdentityBannerClick, true);
    }

    // ============================================================
    //  Module Lifecycle
    // ============================================================
    export function init(context) {
        loadSavedSettings();

        if (window.SnoozeManager && window.SnoozeManager.registerModule) {
            window.SnoozeManager.registerModule({
                id: 'bannerCustomizer',
                category: 'Profile & Social',
                name: 'Banner Customizer',
                description: 'Override your lobby/profile banner with any image, video, or custom upload.',
                settings: [
                    {
                        type: 'toggle',
                        id: 'bnc:enabled',
                        label: 'Enable banner override',
                        description: 'Apply your selected banner across lobby, profile, and Arena hover cards.',
                        value: bannerEnabled,
                        onChange: (v) => {
                            bannerEnabled = v;
                            saveSettings();
                            if (v) applyBanner(); else clearBanner();
                        },
                    },
                    {
                        type: 'toggle',
                        id: 'bnc:nativePreview',
                        label: 'Native locked-banner preview',
                        description: 'On the client\'s own banner picker, click a locked banner to preview it on the summoner card (blocks the purchase prompt).',
                        value: nativePreviewEnabled,
                        onChange: (v) => {
                            nativePreviewEnabled = v;
                            saveSettings();
                            if (!v) _clearNativePreviewGuard();
                        },
                    },
                    {
                        type: 'custom',
                        render: (row) => {
                            const b = makeFlatButton('Open Banner Picker', true);
                            b.addEventListener('click', () => { openMainUI(); uiVisible = true; });
                            row.appendChild(b);
                        },
                    },
                ],
            });
        }
        // Standalone mode: the in-lobby BNC button (checkAndCreateButton) is the entry point.
    }

    export async function load() {
        log(`BNC v${BNC_VERSION} loading...`);

        injectSharedStyles();

        try {
            await Promise.all([fetchOwnSummonerId(), fetchBannerData()]);
        } catch (e) {
            err("Fatal fetch:", e);
        }

        setupLobbyObserver();
        checkAndCreateButton();
        setupNativePickerHook();

        log("BNC ready");
    }