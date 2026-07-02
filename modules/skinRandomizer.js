/**
 * @name Snooze-SkinRandomizer
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Adds a "Random Skin" button to the champion select skin carousel (rolls an owned skin, with a chance for an owned chroma) and marks owned skins/chromas on the carousel dots.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';

// The carousel renders one navigation pip (.skin-selection-indicator-selector)
// per skin, in the same order as the component's own carouselSkins, so we map
// pip index -> skin and fade-fill the dot for owned skins.
const PIP_SELECTOR =
  '.skin-selection-indicator-list .skin-selection-indicator-selector';
const REROLL_BTN_CLASS = 'skin-randomizer-reroll';

let randomizeEnabled = false;
let indicatorsEnabled = false;

// skin-select component instances currently mounted, so a settings toggle can
// take effect immediately instead of waiting for the next natural re-render.
const activeComponents = new Set();

function isSkinOwned(skin) {
  return !!(skin && (skin.unlocked || (skin.ownership && skin.ownership.owned)));
}

function hasOwnedChroma(skin) {
  return !!(
    skin &&
    Array.isArray(skin.childSkins) &&
    skin.childSkins.some((c) => c.unlocked || c.ownership?.owned)
  );
}

// pick a random owned skin variant (excluding only the currently
// viewed/selected one - the base skin is a valid roll outcome too) then apply
// it through the component's own setter so Ember's state/observers stay
// correct.
function rerollSkin(component) {
  const skins = component.carouselSkins;
  if (!Array.isArray(skins) || skins.length < 2) return;

  const owned = skins.filter((s) => isSkinOwned(s));
  if (owned.length < 2) return;

  const currentId = component.get?.('viewSkin.id') ?? component.get?.('selectedSkinId');
  const pool = currentId ? owned.filter((s) => s.id !== currentId) : owned;
  if (!pool.length) return;

  // Pick the skin first with even odds across owned skins, then separately
  // roll whether to apply one of its owned chromas - keeps a skin with many
  // chromas from crowding out skins that have none.
  let pick = pool[Math.floor(Math.random() * pool.length)];
  if (Array.isArray(pick.childSkins) && pick.childSkins.length) {
    const ownedChromas = pick.childSkins.filter((c) => c.unlocked || c.ownership?.owned);
    if (ownedChromas.length) {
      const chromaOptions = [null, ...ownedChromas];
      const chromaPick = chromaOptions[Math.floor(Math.random() * chromaOptions.length)];
      if (chromaPick) pick = chromaPick;
    }
  }

  try {
    if (typeof component.setSkin === 'function') {
      component.setSkin(pick);
    } else if (typeof component.setViewSkin === 'function') {
      component.setViewSkin(pick);
    }
  } catch (err) {
    Utils.Debug.warn('[SkinRandomizer] Failed to apply skin:', err);
  }
}

// add the dice button to the skin-select component root (idempotent, safe to call every render)
function ensureRerollButton(component) {
  if (!component.element || component.element.querySelector(`.${REROLL_BTN_CLASS}`)) return;

  const btn = document.createElement('div');
  btn.className = REROLL_BTN_CLASS;
  btn.setAttribute('role', 'button');
  btn.title = 'Random Skin';
  btn.innerHTML =
    '<img class="skin-randomizer-reroll-icon" src="/fe/lol-static-assets/svg/bad_luck_protection_dice.svg" alt="">';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    rerollSkin(component);
  });
  component.element.appendChild(btn);
}

function removeRerollButton(component) {
  component.element?.querySelectorAll(`.${REROLL_BTN_CLASS}`).forEach((el) => el.remove());
}

// fade-fill the dot of every owned skin; re-applied every render since pips
// get re-created on scroll/selection
function paintOwnedPips(component) {
  const skins = component.carouselSkins;
  if (!component.element || !Array.isArray(skins)) return;

  const pips = component.element.querySelectorAll(PIP_SELECTOR);
  // Bail if the pip set doesn't match carouselSkins yet (mid-render); the next
  // didRender call will retry once they're in sync.
  if (pips.length !== skins.length) return;

  pips.forEach((pip, i) => {
    const skin = skins[i];
    pip.classList.toggle('owned-skin-pip', isSkinOwned(skin));
    pip.classList.toggle('owned-chroma-pip', isSkinOwned(skin) && hasOwnedChroma(skin));
  });
}

function clearPips(component) {
  component.element?.querySelectorAll(PIP_SELECTOR).forEach((pip) => {
    pip.classList.remove('owned-skin-pip', 'owned-chroma-pip');
  });
}

// applies the current toggle state to one mounted skin-select instance
function applyToComponent(component) {
  if (!component.element) return;
  if (randomizeEnabled) ensureRerollButton(component);
  else removeRerollButton(component);
  if (indicatorsEnabled) paintOwnedPips(component);
  else clearPips(component);
}

function refreshActiveComponents() {
  activeComponents.forEach(applyToComponent);
}

function setRandomizeEnabled(enabled) {
  randomizeEnabled = enabled;
  Utils.Store.set('skinRandomizer', 'autoRandomize', enabled);
  refreshActiveComponents();
}

function setIndicatorsEnabled(enabled) {
  indicatorsEnabled = enabled;
  Utils.Store.set('skinRandomizer', 'indicators', enabled);
  refreshActiveComponents();
}

function injectStyles() {
  if (document.getElementById('skin-randomizer-styles')) return;
  const style = document.createElement('style');
  style.id = 'skin-randomizer-styles';
  style.textContent = `
    .skin-select {
      position: relative;
    }
    .skin-randomizer-reroll {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 5;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid rgba(200, 170, 110, 0.3);
      cursor: pointer;
      user-select: none;
      padding: 4px;
      flex-shrink: 0;
      transition: all 0.2s;
    }
    .skin-randomizer-reroll:hover {
      background: rgba(200, 170, 110, 0.2);
      border-color: #c8aa6e;
      transform: scale(1.1);
    }
    .skin-randomizer-reroll:active {
      background: rgba(0, 0, 0, 0.8);
    }
    .skin-randomizer-reroll-icon {
      width: 12px;
      height: 12px;
      opacity: 0.8;
      filter: invert(66%) sepia(9%) saturate(415%) hue-rotate(3deg) brightness(93%) contrast(88%);
      transition: opacity 0.2s;
      display: block;
    }
    .skin-randomizer-reroll:hover .skin-randomizer-reroll-icon {
      opacity: 1;
    }

    .skin-selection-indicator-list .skin-selection-indicator-selector.owned-skin-pip {
      position: relative;
    }
    /* faded "selected" dot for owned skins (skip the one currently viewed) */
    .skin-selection-indicator-list .skin-selection-indicator-selector.owned-skin-pip:not(.skin-selection-indicator-selector-viewed) {
      background-image: none;
    }
    .skin-selection-indicator-list .skin-selection-indicator-selector.owned-skin-pip:not(.skin-selection-indicator-selector-viewed)::after {
      content: "";
      position: absolute;
      inset: 0;
      background: url(/fe/lol-champ-select/images/config/skin-carousel-pip-selected.png) 50% no-repeat;
      opacity: 0.35;
      pointer-events: none;
    }
    /* rainbow ring when the skin has an owned chroma */
    .skin-selection-indicator-list .skin-selection-indicator-selector.owned-chroma-pip::before {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: 10px;
      height: 10px;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      background: conic-gradient(#ff4d4d, #ffb24d, #fff24d, #4dff7a, #4dd2ff, #4d6bff, #b24dff, #ff4d4d);
      -webkit-mask: radial-gradient(closest-side, transparent 58%, #000 62%);
      mask: radial-gradient(closest-side, transparent 58%, #000 62%);
      pointer-events: none;
    }
    /* dim the rainbow ring on pips that aren't currently viewed */
    .skin-selection-indicator-list .skin-selection-indicator-selector.owned-chroma-pip:not(.skin-selection-indicator-selector-viewed)::before {
      opacity: 0.35;
    }
  `;
  document.head.appendChild(style);
}

export function installEmberHook() {
  Utils.Hooks.Ember.registerRule({
    name: 'skin-randomizer-hook',
    matcher: 'skin-select',
    mixin() {
      return {
        didInsertElement() {
          this._super(...arguments);
          activeComponents.add(this);
        },
        didRender() {
          this._super(...arguments);
          applyToComponent(this);
        },
        willDestroyElement() {
          activeComponents.delete(this);
          removeRerollButton(this);
          this._super(...arguments);
        }
      };
    }
  });
}

export function init(context) {
  Utils.Settings.inject(context, {
    name: 'skin-randomizer-settings',
    titleKey: 'snooze_skin-randomizer',
    titleName: 'Skin Randomizer',
    capitalTitleKey: 'snooze_skin-randomizer_capital',
    capitalTitleName: 'SKIN RANDOMIZER',
    class: 'skin-randomizer-settings',
  });

  randomizeEnabled = Utils.Store.get('skinRandomizer', 'autoRandomize') || false;
  indicatorsEnabled = Utils.Store.get('skinRandomizer', 'indicators') || false;

  if (window.SnoozeManager && window.SnoozeManager.registerModule) {
    window.SnoozeManager.registerModule({
      id: 'skinRandomizer',
      name: 'Skin Randomizer',
      description:
        'Adds a "Random Skin" dice button to the champion select carousel and marks which skins you own (and which have chromas) on the carousel dots.',
      settings: [
        {
          type: 'toggle',
          id: 'sm:skinRandomizerAuto',
          label: 'Enable random skin button',
          description: 'Adds a dice button to the skin carousel; click it to roll a random owned skin, with a chance to roll one of its owned chromas',
          value: randomizeEnabled,
          onChange: (val) => setRandomizeEnabled(val),
        },
        {
          type: 'toggle',
          id: 'sm:skinRandomizerIndicators',
          label: 'Show owned & chroma indicators',
          description: 'Fills the carousel dot for each skin you own and rings dots with an owned chroma',
          value: indicatorsEnabled,
          onChange: (val) => setIndicatorsEnabled(val),
        },
      ],
    });
  } else {
    Utils.DOM.observer.observe('lol-uikit-scrollable.skin-randomizer-settings', (plugin) => {
      plugin.appendChild(Utils.Settings.createToggleRow('Enable random skin button', randomizeEnabled, (next) => {
        setRandomizeEnabled(next);
      }));
      plugin.appendChild(Utils.Settings.createToggleRow('Show owned & chroma indicators', indicatorsEnabled, (next) => {
        setIndicatorsEnabled(next);
      }));
    });
  }
}

export function load() {
  injectStyles();
}
