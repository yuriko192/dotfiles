// ==UserScript==
// @name         Generic Popup Hider
// @namespace    https://example.com/
// @version      1.0
// @description  Hide common floating login/sign-in popups on websites
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const SELECTORS = [
    'iframe[src*="accounts.google.com"]',
    'iframe[src*="accounts.google.com/gsi"]',
    'iframe[src*="google.com/gsi"]'
  ];

  function hide(el) {
    if (!el || !(el instanceof HTMLElement)) return;

    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
    el.style.setProperty('opacity', '0', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
  }

  function scan(root = document) {
    for (const selector of SELECTORS) {
      root.querySelectorAll?.(selector).forEach(hide);
    }
  }

  // Inject CSS immediately so the popup is hidden even before JS scanning.
  const style = document.createElement('style');
  style.textContent = `
        iframe[src*="accounts.google.com"],
        iframe[src*="accounts.google.com/gsi"],
        iframe[src*="google.com/gsi"] {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }
    `;

  // documentElement may not exist yet at document-start.
  function install() {
    if (document.head) {
      document.head.appendChild(style);
    } else {
      document.documentElement?.appendChild(style);
    }

    scan();
  }

  if (document.documentElement) {
    install();
  } else {
    new MutationObserver(() => {
      if (document.documentElement) {
        install();
        this?.disconnect?.();
      }
    }).observe(document, {
      childList: true,
      subtree: true
    });
  }

  // Catch popups inserted after page load.
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        scan(node);

        // Sometimes the iframe is nested inside a newly-created container.
        if (node.matches?.(SELECTORS.join(','))) {
          hide(node);
        }
      }
    }
  });

  function startObserver() {
    if (!document.documentElement) return;

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    scan();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
  } else {
    startObserver();
  }
})();
