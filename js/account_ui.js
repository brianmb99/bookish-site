// account_ui.js - Clean account management UI orchestrator
// Coordinates between: account_creation, passkey_protection, account_arweave, passkey_mapping
// Clear separation: creation → protection choice → persistence on funding

import { createNewAccount, restoreAccountFromSeed } from './core/account_creation.js';
import { protectAccountWithPasskey, unlockPasskeyProtectedAccount, isPasskeyProtected, getPasskeyMetadata } from './core/passkey_protection.js';
import { isPRFSupported } from './core/passkey_core.js';
import uiStatusManager from './ui_status_manager.js';
import { stopSync, startSync } from './sync_manager.js';
import { resetKeyState } from './app.js';
import { uploadAccountMetadata, downloadAccountMetadata } from './core/account_arweave.js';
import { uploadPasskeyMapping, getSeedByCredentialId } from './core/passkey_mapping.js';
import { signInWithPasskey } from './core/passkey_signin.js';
import { formatAddress, copyAddressToClipboard, getWalletBalance } from './core/wallet_core.js';
import { deriveAndStoreSymmetricKey, hexToBytes, storeSessionEncryptedSeed, getSessionEncryptedSeed, clearSessionEncryptedSeed, clearPRFKey, getPRFKey } from './core/crypto_core.js';
import { ACCOUNT_STORAGE_KEY, PASSKEY_STORAGE_KEY, SEED_SHOWN_KEY } from './core/storage_constants.js';
import * as storageManager from './core/storage_manager.js';
import { openOnrampWidget, isCoinbaseOnrampConfigured } from './core/coinbase_onramp.js';
import { formatBalanceAsBooks, getBalanceStatus } from './core/balance_display.js';
import { requestFaucetFunding, isEligibleForFaucet } from './core/faucet_client.js';

// Global state
let currentBalanceETH = null;

// Transient state for UI status manager
const transientState = {
  justSignedIn: false,
  signInTime: 0,
  justCreated: false,
  createdTime: 0,
  faucetResult: null, // 'funded', 'failed', 'skipped', or null
  faucetTxHash: null,
  faucetSkipped: false
};

const BANNER_DISMISSED_KEY = 'bookish_account_banner_dismissed';

/**
 * Get account status for UI status manager
 * @returns {Object} { isLoggedIn, isPersisted, justSignedIn, signInTime, justCreated, createdTime }
 */
export function getAccountStatus() {
  const isLoggedIn = storageManager.isLoggedIn();
  const isPersisted = storageManager.isAccountPersisted();

  return {
    isLoggedIn,
    isPersisted,
    justSignedIn: transientState.justSignedIn,
    signInTime: transientState.signInTime,
    justCreated: transientState.justCreated,
    createdTime: transientState.createdTime
  };
}

/**
 * Initialize account UI on page load
 */
export async function initAccountUI() {
  console.log('[Bookish:AccountUI] Initializing...');

  // Coinbase Pay requires no configuration - always available via direct link

  // Setup modal event listeners
  setupAccountModalListeners();

  // Show account banner if needed
  showAccountBannerIfNeeded();
}

/**
 * Open account modal
 */
export async function openAccountModal() {
  const modal = document.getElementById('accountModal');
  const content = document.getElementById('accountModalContent');
  if (!modal || !content) {
    console.warn('[Bookish:AccountUI] Account modal not found', { modal: !!modal, content: !!content });
    return;
  }

  // Prevent backdrop clicks for a short time after opening
  modal.dataset.allowClose = 'false';

  try {
    console.log('[Bookish:AccountUI] Opening account modal...');

    // Render content (await since it's async)
    await renderAccountModalContent(content);
    console.log('[Bookish:AccountUI] Content rendered, innerHTML length:', content.innerHTML.length);

    // Show modal
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Ensure modal content is visible
    const modalContent = modal.querySelector('.account-modal');
    if (modalContent) {
      modalContent.style.visibility = 'visible';
      modalContent.style.opacity = '1';
      modalContent.style.display = 'block';
    }

    // Force a reflow to ensure display:flex is applied
    void modal.offsetHeight;

    // Animate in
    requestAnimationFrame(() => {
      modal.classList.add('open');
      console.log('[Bookish:AccountUI] Modal opened, classList:', modal.classList.toString());
      console.log('[Bookish:AccountUI] Modal content element:', modalContent, 'display:', modalContent?.style.display, 'visibility:', modalContent?.style.visibility);

      // Allow backdrop clicks after animation starts
      setTimeout(() => {
        modal.dataset.allowClose = 'true';
      }, 100);
    });
  } catch (error) {
    console.error('[Bookish:AccountUI] Error opening account modal:', error);
    console.error('[Bookish:AccountUI] Error stack:', error.stack);
    // Close modal on error
    modal.style.display = 'none';
    document.body.style.overflow = '';
    modal.dataset.allowClose = 'true';
  }
}

/**
 * Close account modal
 */
export function closeAccountModal() {
  const modal = document.getElementById('accountModal');
  if (!modal) return;

  console.log('[Bookish:AccountUI] Closing account modal');
  modal.classList.remove('open');
  document.body.style.overflow = '';

  // Wait for animation before hiding
  setTimeout(() => {
    modal.style.display = 'none';
    // Clear backdrop listener flag so it can be reattached next time
    const backdrop = modal.querySelector('.modal-backdrop');
    if (backdrop) {
      backdrop.dataset.listenerAttached = '';
    }
  }, 200);
}

/**
 * Render account modal content
 */
async function renderAccountModalContent(container) {
  try {
    const isLoggedIn = storageManager.isLoggedIn();
    console.log('[Bookish:AccountUI] Rendering modal content, isLoggedIn:', isLoggedIn);

    if (isLoggedIn) {
      let walletInfo, passkeyMeta, persistenceState, persistenceIndicator;

      try {
        walletInfo = await getStoredWalletInfo();
        console.log('[Bookish:AccountUI] Got wallet info:', !!walletInfo);
      } catch (e) {
        console.error('[Bookish:AccountUI] Error getting wallet info:', e);
        walletInfo = null;
      }

      try {
        passkeyMeta = getPasskeyMetadata();
        console.log('[Bookish:AccountUI] Got passkey meta:', !!passkeyMeta);
      } catch (e) {
        console.error('[Bookish:AccountUI] Error getting passkey meta:', e);
        passkeyMeta = null;
      }

      const accountData = localStorage.getItem(ACCOUNT_STORAGE_KEY);
      let displayName = 'Anonymous';
      if (accountData) {
        try {
          const accountObj = JSON.parse(accountData);
          displayName = accountObj.displayName || passkeyMeta?.userDisplayName || 'Anonymous';
        } catch (e) {
          console.error('[Bookish:AccountUI] Failed to parse account data:', e);
        }
      }

      const address = walletInfo?.address || '';
      const shortAddress = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '';
      const fullAddress = address || '';

      // Get balance
      let balanceText = 'Loading...';
      let balanceStatus = 'ok';
      let isFunded = false;
      try {
        if (address) {
          const balanceResult = await getWalletBalance(address);
          const balanceETH = balanceResult.balanceETH || '0';
          const balance = parseFloat(balanceETH);
          isFunded = balance >= 0.00002; // MIN_FUNDING_ETH

          // Format as "~X books remaining"
          balanceText = formatBalanceAsBooks(balanceETH, { showExact: false });
          balanceStatus = getBalanceStatus(balanceETH);
        }
      } catch (e) {
        console.error('[Bookish:AccountUI] Error getting balance:', e);
        balanceText = 'Error loading balance';
        balanceStatus = 'empty';
      }

      // Determine protection type
      const isProtected = isPasskeyProtected();
      const protectionType = isProtected ? '🔐 Passkey' : '🔑 Manual Seed';

      // Check if account is backed up
      try {
        persistenceState = determineAccountPersistenceState();
        persistenceIndicator = getPersistenceIndicatorHTML(persistenceState);
        console.log('[Bookish:AccountUI] Got persistence state:', persistenceState);
      } catch (e) {
        console.error('[Bookish:AccountUI] Error getting persistence state:', e);
        persistenceState = 'local';
        persistenceIndicator = '';
      }
      const isBackedUp = persistenceState === 'confirmed';

    container.innerHTML = `
      <h2>Your Account ${persistenceIndicator}</h2>

      <div class="account-info">
        <div class="account-name">👤 ${displayName}</div>
        ${fullAddress ? `
          <div class="account-address-row" style="display: flex; align-items: center; gap: 8px; margin-top: 8px;">
            <span style="font-size: 0.8rem; color: #64748b;">Address:</span>
            <span class="account-address" style="font-family: var(--font-mono); font-size: 0.8rem; color: #94a3b8;">${shortAddress}</span>
            <button id="copyAddressBtn" class="btn-icon copy-btn" style="background: transparent; border: 1px solid #334155; color: #94a3b8; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 0.75rem; display: flex; align-items: center; gap: 4px;" title="Copy address">
              📋 Copy
            </button>
          </div>
        ` : ''}
        <div class="account-balance" style="margin-top: 12px; font-size: 0.85rem;">
          Balance: <span id="accountBalanceDisplay" class="balance-display balance-${balanceStatus}">${balanceText}</span>
        </div>
        <div class="account-protection" style="margin-top: 8px; font-size: 0.85rem; color: #94a3b8;">
          Protection: ${protectionType}
        </div>
      </div>

      <div class="account-actions" style="margin-top: 24px;">
        ${!isBackedUp ? (() => {
          const buttonText = isFunded ? 'Add Credit' : 'Enable Cloud Backup';
          return `<button id="enableBackupBtn" class="btn primary" style="width: 100%; margin-bottom: 12px;">${buttonText}</button>`;
        })() : ''}
        ${!isProtected ? `<button id="protectPasskeyBtn" class="btn primary" style="width: 100%; margin-bottom: 12px;">Protect with Passkey</button>` : ''}
        <div style="display: flex; gap: 12px; margin-top: 12px;">
          <button id="logoutBtn" class="btn secondary" style="flex: 1;">Log Out</button>
          <button id="viewRecoveryBtn" class="btn secondary" style="flex: 1;">Recovery Phrase</button>
        </div>
      </div>
    `;

    // Setup event listeners for logged-in state
    document.getElementById('copyAddressBtn')?.addEventListener('click', async () => {
      if (fullAddress) {
        try {
          await copyAddressToClipboard(fullAddress);
          const btn = document.getElementById('copyAddressBtn');
          if (btn) {
            const originalText = btn.innerHTML;
            btn.innerHTML = '✓ Copied';
            btn.style.color = '#10b981';
            setTimeout(() => {
              btn.innerHTML = originalText;
              btn.style.color = '#94a3b8';
            }, 2000);
          }
        } catch (e) {
          console.error('[Bookish:AccountUI] Failed to copy address:', e);
        }
      }
    });

    document.getElementById('enableBackupBtn')?.addEventListener('click', () => {
      // DO NOT close account modal - open funding dialog on top
      handleBuyStorage();
    });

    document.getElementById('protectPasskeyBtn')?.addEventListener('click', () => {
      // DO NOT close account modal - open passkey flow on top
      handleAddPasskey();
    });

    document.getElementById('logoutBtn')?.addEventListener('click', () => {
      // Logout can close the modal (terminal action)
      closeAccountModal();
      handleLogout();
    });

    document.getElementById('viewRecoveryBtn')?.addEventListener('click', () => {
      // DO NOT close account modal - open recovery phrase view on top
      handleViewSeed();
    });
  } else {
    container.innerHTML = `
      <h2>Account</h2>

      <p style="margin: 0 0 24px 0; line-height: 1.6; opacity: 0.9;">
        Your books, on any device. Create an account to get started.
      </p>

      <div class="account-actions">
        <button id="createAccountBtn" class="btn primary">Create Account</button>
      </div>

      <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #334155;">
        <div style="font-size: 0.8rem; color: #64748b; margin-bottom: 12px;">
          Already have an account?
        </div>
        <div style="display: flex; gap: 16px;">
          <button id="loginBtn" class="btn-link" style="font-size: 0.85rem;">Sign in with passkey</button>
          <button id="importSeedBtn" class="btn-link" style="font-size: 0.85rem;">Use recovery phrase</button>
        </div>
      </div>
    `;

    // Setup event listeners for logged-out state
    document.getElementById('createAccountBtn')?.addEventListener('click', () => {
      closeAccountModal();
      handleCreateAccount();
    });

    document.getElementById('loginBtn')?.addEventListener('click', () => {
      closeAccountModal();
      handleCrossDeviceSignIn();
    });

    document.getElementById('importSeedBtn')?.addEventListener('click', () => {
      closeAccountModal();
      // Wait for accountModal to close before showing seed input modal
      setTimeout(() => {
        handleManualSeedLogin();
      }, 250);
    });
  }
  } catch (error) {
    console.error('[Bookish:AccountUI] Error in renderAccountModalContent:', error);
    console.error('[Bookish:AccountUI] Error stack:', error.stack);
    // Render error state
    container.innerHTML = `
      <h2>Account</h2>
      <p style="color: #ef4444;">Error loading account information. Please try again.</p>
      <button onclick="window.location.reload()" class="btn primary">Reload Page</button>
    `;
    throw error; // Re-throw so openAccountModal can handle it
  }
}

/**
 * Setup account modal event listeners
 */
function setupAccountModalListeners() {
  const modal = document.getElementById('accountModal');
  if (!modal) return;

  // Setup backdrop click handler (only once, use flag to prevent duplicates)
  const backdrop = modal.querySelector('.modal-backdrop');
  if (backdrop && !backdrop.dataset.listenerAttached) {
    backdrop.dataset.listenerAttached = 'true';
    backdrop.addEventListener('click', (e) => {
      // Only close if clicking the backdrop itself, not children, and if allowed
      const modal = document.getElementById('accountModal');
      if (modal && modal.dataset.allowClose === 'true' && e.target === backdrop) {
        console.log('[Bookish:AccountUI] Backdrop clicked, closing modal');
        e.stopPropagation();
        closeAccountModal();
      } else {
        console.log('[Bookish:AccountUI] Backdrop click ignored', { allowClose: modal?.dataset.allowClose, target: e.target, backdrop });
      }
    });
  }

  // Close on close button click
  const closeBtn = document.getElementById('accountModalClose');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeAccountModal);
  }

  // Close on Escape key (remove old handler first)
  const escHandler = (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
      closeAccountModal();
    }
  };
  // Remove any existing handler
  document.removeEventListener('keydown', escHandler);
  document.addEventListener('keydown', escHandler);
}

/**
 * Show account banner for first-time visitors (when not logged in)
 */
function showAccountBannerIfNeeded() {
  const banner = document.getElementById('accountBanner');
  if (!banner) return;

  // Don't show if logged in
  if (storageManager.isLoggedIn()) {
    banner.style.display = 'none';
    return;
  }

  // Don't show if previously dismissed
  if (localStorage.getItem(BANNER_DISMISSED_KEY) === 'true') {
    banner.style.display = 'none';
    return;
  }

  // Show banner
  banner.style.display = 'flex';
  banner.innerHTML = `
    <div class="account-banner-content">
      <span>💡</span>
      <span>Create an account to access your books from any device</span>
    </div>
    <button class="account-banner-dismiss" id="dismissBannerBtn" aria-label="Dismiss">×</button>
  `;

  document.getElementById('dismissBannerBtn').addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent triggering banner click
    localStorage.setItem(BANNER_DISMISSED_KEY, 'true');
    banner.style.display = 'none';
  });

  // Add click handler to banner itself
  banner.addEventListener('click', (e) => {
    // Don't trigger if clicking dismiss button
    if (e.target.closest('.account-banner-dismiss')) return;
    openAccountModal();
  });

  // Keyboard support
  banner.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openAccountModal();
    }
  });
}

/**
 * Update account section UI based on state
 * DEPRECATED: This function is no longer used. Account UI is now rendered in the modal via renderAccountModalContent().
 * Kept for backward compatibility but does nothing.
 */
async function updateAccountSection(section, isLoggedIn) {
  // Modal content is rendered dynamically when modal opens
  // No need to update a persistent section anymore
}

/**
 * Handle account creation - NEW 2-STEP FLOW
 * Step 1: Generate seed + wallet (no passkey yet)
 * Step 2: Ask user if they want passkey protection
 */
async function handleCreateAccount() {
  // Step 1: Ask for display name with friendly copy
  showAccountModal(`
    <div style="text-align:center;margin-bottom:20px;">
      <div style="font-size:2.5rem;margin-bottom:8px;">👤</div>
      <h3 style="margin:0;">Create Your Account</h3>
    </div>

    <div style="margin:20px 0;">
      <label style="display:block;font-size:.875rem;margin-bottom:8px;opacity:.9;">What should we call you?</label>
      <input type="text" id="displayNameInput" placeholder="Your name" style="width:100%;padding:12px;background:#0b1220;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:.875rem;" />
      <div style="font-size:.75rem;opacity:.6;margin-top:6px;">This is just for display.</div>
    </div>

    <div id="createAccountStatus" style="margin:12px 0;font-size:.875rem;text-align:center;"></div>

    <button id="confirmCreateBtn" class="btn" style="width:100%;padding:14px 20px;margin-top:16px;">Continue →</button>

    <div class="modal-progress" style="display:flex;justify-content:center;gap:8px;margin-top:20px;">
      <span class="dot active" style="width:8px;height:8px;border-radius:50%;background:#2563eb;"></span>
      <span class="dot" style="width:8px;height:8px;border-radius:50%;background:#334155;"></span>
    </div>
  `);

  document.getElementById('confirmCreateBtn').onclick = async () => {
    const displayName = document.getElementById('displayNameInput').value.trim();
    const statusDiv = document.getElementById('createAccountStatus');

    if (!displayName) {
      statusDiv.innerHTML = '<span style="color:#ef4444;">Please enter a display name</span>';
      return;
    }

    try {
      statusDiv.textContent = 'Creating account...';

      // STEP 1: Create account (seed + wallet) - NO PASSKEY YET
      const account = await createNewAccount();

      console.log('[Bookish:AccountUI] Account created:', account.address);

      // Store wallet info and display name temporarily
      window.__tempAccount = { ...account, displayName };

      // Show security setup (passkey-first, no seed visible by default)
      closeAccountModal();
      showSecuritySetupModal(account.seed, account.address, displayName);

    } catch (error) {
      console.error('[Bookish:AccountUI] Account creation failed:', error);
      statusDiv.innerHTML = `<span style="color:#ef4444;">${error.message}</span>`;
    }
  };
}

/**
 * Show security setup modal after account creation
 * Passkey-first approach: seed phrase hidden by default, shown only via Advanced toggle
 */
async function showSecuritySetupModal(seed, address, displayName) {
  // Check if PRF (passkey) is supported in this browser
  const prfSupported = await isPRFSupported();

  if (!prfSupported) {
    // Browser doesn't support passkeys - show fallback UI
    showManualBackupModal(seed, displayName);
    return;
  }

  // Default: Passkey-first UI (no seed visible)
  showAccountModal(`
    <div style="text-align:center;margin-bottom:20px;">
      <div style="font-size:2.5rem;margin-bottom:8px;">🔐</div>
      <h3 style="margin:0;">Secure Your Account</h3>
    </div>

    <div style="margin:20px 0;">
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:0 0 8px 0;font-weight:500;">Use your device to sign in</p>
      <p style="font-size:.8rem;line-height:1.5;opacity:.7;margin:0;">
        You'll use Face ID, fingerprint, or your device passcode to access your account. It syncs automatically to your other devices.
      </p>
    </div>

    <button id="setupPasskeyBtn" class="btn" style="width:100%;padding:14px 20px;margin-top:16px;background:#2563eb;">Set Up Passkey →</button>

    <div id="securityStatus" style="margin:12px 0;font-size:.85rem;text-align:center;"></div>

    <div id="advancedToggle" class="advanced-toggle" style="font-size:.75rem;color:#94a3b8;cursor:pointer;display:flex;align-items:center;gap:4px;margin-top:20px;">
      <span id="advancedArrow">▸</span> Advanced: Manage backup manually
    </div>

    <div id="advancedOptions" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid #334155;">
      <p style="font-size:.75rem;opacity:.7;margin:0 0 12px 0;">
        For advanced users who prefer to manage their own recovery phrase.
      </p>
      <button id="showRecoveryBtn" class="btn secondary" style="width:100%;font-size:.8rem;">Skip passkey, show recovery phrase →</button>
    </div>

    <div class="modal-progress" style="display:flex;justify-content:center;gap:8px;margin-top:20px;">
      <span class="dot" style="width:8px;height:8px;border-radius:50%;background:#334155;"></span>
      <span class="dot active" style="width:8px;height:8px;border-radius:50%;background:#2563eb;"></span>
    </div>
  `, false);

  // Handle passkey setup
  document.getElementById('setupPasskeyBtn').onclick = async () => {
    const statusDiv = document.getElementById('securityStatus');
    try {
      statusDiv.textContent = 'Setting up passkey...';

      const account = window.__tempAccount;
      const { credentialId } = await protectAccountWithPasskey(account.seed, `Bookish: ${account.displayName || 'User'}`);

      console.log('[Bookish:AccountUI] Account protected with passkey:', credentialId);

      // protectAccountWithPasskey already stored complete account data with encrypted seed
      // Store displayName in passkey metadata
      const passkeyMeta = JSON.parse(localStorage.getItem(PASSKEY_STORAGE_KEY) || '{}');
      passkeyMeta.userDisplayName = account.displayName;
      localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(passkeyMeta));

      // Don't call storeAccountInfo - it would overwrite and lose the enc field
      await deriveAndStoreSymmetricKey(account.seed);
      await window.bookishWallet.ensure();
      await storeSessionEncryptedSeed(account.seed);
      localStorage.setItem(SEED_SHOWN_KEY, 'true');

      // Clean up temp
      delete window.__tempAccount;

      // Reset faucet state
      transientState.faucetResult = null;
      transientState.faucetTxHash = null;
      transientState.faucetSkipped = false;

      // Ensure modal is closed before showing loading state
      closeAccountModal();
      // Use requestAnimationFrame to ensure close completes before showing new modal
      requestAnimationFrame(() => {
        onAccountCreated(account.displayName, true, credentialId);
      });

    } catch (error) {
      console.error('[Bookish:AccountUI] Passkey protection failed:', error);

      // User-friendly error message
      let errorMsg = error.message;
      if (error.message.includes('cancelled') || error.message.includes('timed out')) {
        errorMsg = 'The security prompt closed. Let\'s try again.';
      }

      statusDiv.innerHTML = `<span style="color:#ef4444;">${errorMsg}</span>`;
    }
  };

  // Advanced toggle
  document.getElementById('advancedToggle').onclick = () => {
    const options = document.getElementById('advancedOptions');
    const arrow = document.getElementById('advancedArrow');
    if (options.style.display === 'none') {
      options.style.display = 'block';
      arrow.textContent = '▾';
    } else {
      options.style.display = 'none';
      arrow.textContent = '▸';
    }
  };

  // Show recovery phrase button
  document.getElementById('showRecoveryBtn').onclick = () => {
    closeAccountModal();
    showManualBackupModal(seed, displayName);
  };
}

/**
 * Show manual backup modal with recovery phrase and confirmation checkbox
 * Used when user explicitly chooses manual path or browser doesn't support passkeys
 */
function showManualBackupModal(seed, displayName) {
  const words = seed.split(' ');

  showAccountModal(`
    <h3 style="margin:0 0 16px 0;">Your Recovery Phrase</h3>

    <div style="background:#f59e0b1a;border:1px solid #f59e0b;border-radius:6px;padding:12px;margin-bottom:16px;">
      <p style="font-size:.8rem;line-height:1.5;color:#f59e0b;margin:0;">
        <strong>Save these 12 words</strong><br>
        These words are the ONLY way to recover your account if you lose access to all devices.
      </p>
    </div>

    <div style="background:#0b1220;border:1px solid #334155;border-radius:6px;padding:16px;position:relative;">
      <button id="copyRecoveryBtn" style="position:absolute;top:8px;right:8px;padding:4px 8px;font-size:.7rem;background:#1e293b;border:1px solid #334155;border-radius:4px;color:#e2e8f0;cursor:pointer;">Copy 📋</button>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;font-family:monospace;font-size:.8rem;">
        ${words.map((word, i) => `
          <div style="display:flex;gap:6px;">
            <span style="opacity:.5;min-width:18px;">${i + 1}.</span>
            <span style="font-weight:500;">${word}</span>
          </div>
        `).join('')}
      </div>
    </div>

    <label class="checkbox-confirm" style="display:flex;align-items:center;gap:8px;font-size:.8rem;margin:16px 0;cursor:pointer;">
      <input type="checkbox" id="confirmSavedCheckbox" style="width:18px;height:18px;accent-color:#2563eb;">
      <span>I've saved my recovery phrase</span>
    </label>

    <button id="completeSetupBtn" class="btn" style="width:100%;padding:14px 20px;opacity:.5;cursor:not-allowed;" disabled>Complete Setup →</button>

    <div id="manualSetupStatus" style="margin-top:12px;font-size:.85rem;text-align:center;"></div>
  `, false);

  // Copy button
  document.getElementById('copyRecoveryBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(seed);
      const btn = document.getElementById('copyRecoveryBtn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = 'Copy 📋'; }, 2000);
    } catch (error) {
      console.error('[Bookish:AccountUI] Copy failed:', error);
    }
  };

  // Checkbox enables button
  document.getElementById('confirmSavedCheckbox').onchange = (e) => {
    const btn = document.getElementById('completeSetupBtn');
    if (e.target.checked) {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
    } else {
      btn.disabled = true;
      btn.style.opacity = '.5';
      btn.style.cursor = 'not-allowed';
    }
  };

  // Complete setup (manual path)
  document.getElementById('completeSetupBtn').onclick = async () => {
    const account = window.__tempAccount;

    // Store account without passkey protection (manual seed storage)
    const accountData = {
      version: 1,
      derivation: 'manual',
      displayName: account.displayName,
      created: Date.now()
    };
    localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accountData));

    // Store seed in localStorage for manual accounts
    const { MANUAL_SEED_STORAGE_KEY } = await import('./core/storage_constants.js');
    localStorage.setItem(MANUAL_SEED_STORAGE_KEY, account.seed);

    await deriveAndStoreSymmetricKey(account.seed);
    await window.bookishWallet.ensure();
    await storeSessionEncryptedSeed(account.seed);
    localStorage.setItem(SEED_SHOWN_KEY, 'true');

    // Clean up temp
    delete window.__tempAccount;

    // Ensure modal is closed before showing success
    closeAccountModal();
    // Use requestAnimationFrame to ensure close completes before showing new modal
    requestAnimationFrame(() => {
      showSuccessModal(account.displayName, false);
    });
  };
}

/**
 * Handle account creation completion - shows loading state, runs faucet, then shows success modal
 * @param {string} displayName - User's display name
 * @param {boolean} isPasskey - Whether account is passkey-protected
 * @param {string} credentialId - Passkey credential ID (if passkey account)
 */
async function onAccountCreated(displayName, isPasskey, credentialId = null) {
  // For passkey accounts, show loading state and run faucet
  if (isPasskey) {
    // Show interim loading state with skip option
    showAccountModal(`
      <div style="text-align:center;padding:20px 0;">
        <div style="font-size:3rem;margin-bottom:16px;opacity:.9;">⏳</div>
        <h3 style="margin:0 0 16px 0;">Setting up your account...</h3>
        <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;margin:0 0 24px 0;text-align:left;">
          <div class="setup-step" style="display:flex;align-items:center;gap:8px;font-size:.85rem;margin:8px 0;opacity:1;color:#10b981;">
            <span>✓</span> <span>Account created</span>
          </div>
          <div class="setup-step" style="display:flex;align-items:center;gap:8px;font-size:.85rem;margin:8px 0;opacity:1;color:#10b981;">
            <span>✓</span> <span>Passkey enrolled</span>
          </div>
          <div id="setupStep3" class="setup-step" style="display:flex;align-items:center;gap:8px;font-size:.85rem;margin:8px 0;opacity:1;">
            <span>◐</span> <span>Activating cloud storage...</span>
          </div>
        </div>
        <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:0 0 16px 0;">
          This usually takes just a moment.
        </p>
        <button id="skipFaucetWaitBtn" class="btn-link" style="background:none;border:none;color:#94a3b8;font-size:.875rem;cursor:pointer;text-decoration:underline;">Skip this step →</button>
      </div>
    `);

    // Skip button handler
    document.getElementById('skipFaucetWaitBtn').onclick = () => {
      transientState.faucetSkipped = true;
      transientState.faucetResult = 'skipped';
      showSuccessModal(displayName, isPasskey, credentialId);
    };

    // Run faucet with 20-second timeout (accounts for retries: 1s + 2s + 4s delays + request time)
    const eligible = await isEligibleForFaucet();
    if (eligible && !transientState.faucetSkipped) {
      try {
        // Get wallet address
        const address = await window.bookishWallet?.getAddress?.();
        if (address) {
          // Race between faucet request (with retries) and timeout
          const result = await Promise.race([
            requestFaucetFunding(address, credentialId, 3), // 3 retries
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000))
          ]);
          transientState.faucetResult = result.success ? 'funded' : (result.code || 'failed');
          transientState.faucetTxHash = result.txHash || null;
        } else {
          transientState.faucetResult = 'failed';
        }
      } catch (e) {
        console.error('[Bookish:AccountUI] Faucet request error:', e);
        transientState.faucetResult = e.message === 'timeout' ? 'timeout' : 'failed';
      }
    } else {
      transientState.faucetResult = 'failed'; // Not eligible
    }
  } else {
    // Manual accounts: no faucet, just show success modal
    transientState.faucetResult = null;
  }

  // Now show final success modal
  showSuccessModal(displayName, isPasskey, credentialId);
}

/**
 * Show success modal after account creation
 * @param {string} displayName - User's display name
 * @param {boolean} isPasskey - Whether account is passkey-protected
 * @param {string} credentialId - Passkey credential ID (if passkey account)
 */
async function showSuccessModal(displayName, isPasskey, credentialId = null) {
  const protectionMessage = isPasskey
    ? 'Your account is protected by passkey.'
    : 'Your account is secured with your recovery phrase. Keep it safe!';

  // Check if account is funded (either via faucet or existing balance)
  const faucetOK = transientState.faucetResult === 'funded' || transientState.faucetResult === 'already-funded' || transientState.faucetResult === 'has-balance';
  let balance = 0;
  let isFunded = faucetOK;

  // Check current balance if not already funded via faucet
  if (!isFunded) {
    try {
      const address = await window.bookishWallet?.getAddress?.();
      if (address) {
        const balanceResult = await getWalletBalance(address);
        balance = parseFloat(balanceResult.balanceETH || '0');
        isFunded = balance >= 0.00002; // MIN_FUNDING_ETH
      }
    } catch (e) {
      console.error('[Bookish:AccountUI] Error checking balance:', e);
    }
  }

  // Render content based on funding status
  let contentHTML;
  if (isFunded) {
    // State A: Faucet succeeded or already funded
    contentHTML = `
      <div style="text-align:center;padding:20px 0;">
        <div class="success-checkmark" style="font-size:3rem;margin-bottom:16px;animation:scaleIn .3s ease-out;">✓</div>
        <h3 style="margin:0 0 12px 0;">You're all set, ${displayName}!</h3>
        <p style="font-size:.85rem;line-height:1.6;opacity:.8;margin:0 0 16px 0;">
          ${protectionMessage}
        </p>
        <div style="background:#1e3a5f;border:1px solid #2563eb;border-radius:8px;padding:12px 16px;margin:0 0 24px 0;text-align:left;">
          <div style="font-size:.85rem;line-height:1.5;margin-bottom:4px;">
            ✓ Cloud backup enabled
          </div>
          <div style="font-size:.75rem;opacity:.8;line-height:1.4;margin-bottom:4px;">
            Your books will sync across devices.
          </div>
          ${faucetOK ? '<div style="font-size:.75rem;opacity:.8;line-height:1.4;">You have credit for ~30 books.</div>' : ''}
        </div>
        <button id="startAddingBooksBtn" class="btn" style="width:100%;padding:14px 20px;background:#2563eb;">Start Adding Books →</button>
        <div style="margin-top:16px;">
          <button id="viewRecoveryLinkBtn" class="btn-link" style="background:none;border:none;color:#64748b;font-size:.75rem;cursor:pointer;text-decoration:underline;">View recovery phrase in settings</button>
        </div>
      </div>
    `;
  } else {
    // State B: Faucet failed or skipped
    contentHTML = `
      <div style="text-align:center;padding:20px 0;">
        <div class="success-checkmark" style="font-size:3rem;margin-bottom:16px;animation:scaleIn .3s ease-out;">✓</div>
        <h3 style="margin:0 0 12px 0;">You're all set, ${displayName}!</h3>
        <p style="font-size:.85rem;line-height:1.6;opacity:.8;margin:0 0 16px 0;">
          ${protectionMessage}
        </p>
        <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 16px;margin:0 0 24px 0;text-align:left;">
          <div style="font-size:.85rem;line-height:1.5;">
            💡 Your account is local-only right now.<br>
            <span style="font-size:.75rem;opacity:.8;">Add funds to enable cloud backup and sync.</span>
          </div>
        </div>
        <button id="addFundsNowBtn" class="btn" style="width:100%;padding:14px 20px;background:#2563eb;">Enable Cloud Backup →</button>
        <div style="margin-top:12px;">
          <button id="skipForNowBtn" class="btn-link" style="background:none;border:none;color:#94a3b8;font-size:.875rem;cursor:pointer;">Skip for now</button>
        </div>
        <div style="margin-top:16px;">
          <button id="viewRecoveryLinkBtn" class="btn-link" style="background:none;border:none;color:#64748b;font-size:.75rem;cursor:pointer;text-decoration:underline;">View recovery phrase in settings</button>
        </div>
      </div>
    `;
  }

  showAccountModal(contentHTML);

  // Set transient state for UI updates
  transientState.justCreated = true;
  transientState.createdTime = Date.now();
  setTimeout(() => { transientState.justCreated = false; uiStatusManager.refresh(); }, 3000);

  // Helper to complete setup and start sync
  const completeSetup = async () => {
    closeAccountModal();
    // Hide banner after account creation
    const banner = document.getElementById('accountBanner');
    if (banner) banner.style.display = 'none';
    uiStatusManager.refresh();
    console.log('[Bookish:AccountUI] Account created, starting sync loop');
    startSync();
  };

  // Button handlers - conditional based on funding status
  if (isFunded) {
    // Start Adding Books button (funded state)
    document.getElementById('startAddingBooksBtn').onclick = completeSetup;
  } else {
    // Add Funds Now - opens Coinbase onramp (unfunded state)
    document.getElementById('addFundsNowBtn').onclick = async () => {
      await completeSetup();
      // Small delay to let UI settle, then open funding
      setTimeout(() => handleBuyStorage(), 100);
    };

    // Skip for now - just closes and continues (unfunded state)
    document.getElementById('skipForNowBtn').onclick = completeSetup;
  }

  // View recovery phrase link (always available)
  document.getElementById('viewRecoveryLinkBtn').onclick = async () => {
    await completeSetup();
    setTimeout(() => handleViewSeed(), 100);
  };
}

/**
 * Store account info in localStorage
 */
function storeAccountInfo(account, isPasskey = false) {
  // Note: Seed is NOT stored here for manual accounts
  // For passkey accounts, it's encrypted in passkey_protection.js
  const accountData = {
    version: isPasskey ? 2 : 1,
    derivation: isPasskey ? 'prf' : 'manual',
    created: account.createdAt || Date.now()
  };
  localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accountData));
}

/**
 * Handle login
 */
async function handleLogin() {
  // Check what type of account exists locally
  const accountData = localStorage.getItem(ACCOUNT_STORAGE_KEY);

  if (!accountData) {
    // No local account - try cross-device sign-in
    handleCrossDeviceSignIn();
    return;
  }

  const accountObj = JSON.parse(accountData);

  if (accountObj.version === 2 && accountObj.derivation === 'prf') {
    // Passkey-protected account - authenticate with passkey
    handlePasskeyLogin();
  } else {
    // Manual seed account - require seed entry
    handleManualSeedLogin();
  }
}

/**
 * Handle passkey login (for local passkey-protected account)
 */
async function handlePasskeyLogin() {
  try {
    const { seed, credentialId } = await unlockPasskeyProtectedAccount();

    console.log('[Bookish:AccountUI] Account unlocked');

    // Derive wallet and symmetric key
    const { address } = await import('./core/account_creation.js').then(m => m.deriveWalletFromSeed(seed));
    await deriveAndStoreSymmetricKey(seed);
    await window.bookishWallet.ensure();
    await storeSessionEncryptedSeed(seed);

    // Refresh UI state
    transientState.justSignedIn = true;
    transientState.signInTime = Date.now();
    setTimeout(() => { transientState.justSignedIn = false; uiStatusManager.refresh(); }, 3000);
    uiStatusManager.refresh();

    // Start sync loop now that user is logged in
    console.log('[Bookish:AccountUI] Passkey login successful, starting sync loop');
    startSync();

  } catch (error) {
    console.error('[Bookish:AccountUI] Login failed:', error);
    uiStatusManager.refresh();
  }
}

/**
 * Handle cross-device sign-in (no local account)
 */
async function handleCrossDeviceSignIn() {
  try {
    const result = await signInWithPasskey();

    await deriveAndStoreSymmetricKey(result.seed);
    await window.bookishWallet.ensure();
    await storeSessionEncryptedSeed(result.seed);

    // Hide banner after login
    const banner = document.getElementById('accountBanner');
    if (banner) banner.style.display = 'none';

    // Start sync loop now that user is logged in
    console.log('[Bookish:AccountUI] Login successful, starting sync loop');
    startSync();

  } catch (error) {
    console.error('[Bookish:AccountUI] Cross-device sign-in failed:', error);

    // Check if this is an "account not synced" error (unfunded account)
    const isNotSynced = error.message.includes('No wallet mapping found') ||
                        error.message.includes('No account metadata found');
    const isCancelled = error.message.includes('cancelled') || error.message.includes('timed out');

    if (isNotSynced) {
      // Show helpful "Account Not Synced" modal
      showAccountModal(`
        <h3>Account Not Synced Yet</h3>
        <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
          Your account hasn't been backed up to the cloud yet, so it can't be accessed from this device.
        </p>
        <div style="background:#1e242b;border:1px solid #334155;border-radius:8px;padding:12px 16px;margin:16px 0;">
          <div style="font-size:.8rem;font-weight:600;margin-bottom:8px;">What happened?</div>
          <p style="font-size:.8rem;line-height:1.5;opacity:.8;margin:0;">
            Your account was created but not funded. Without funds, your data stays on the original device only.
          </p>
        </div>
        <div style="font-size:.875rem;margin:16px 0;">
          <div style="font-weight:500;margin-bottom:8px;">To fix this:</div>
          <ol style="margin:0;padding-left:20px;line-height:1.8;opacity:.9;">
            <li>Go back to your original device</li>
            <li>Add funds to enable cloud backup</li>
            <li>Then you can sign in anywhere</li>
          </ol>
        </div>
        <p style="font-size:.875rem;opacity:.9;margin:16px 0;">
          Or, if you have your recovery phrase:
        </p>
        <button id="signInWithRecoveryBtn" class="btn" style="width:100%;padding:12px 20px;background:#2563eb;margin-bottom:12px;">Sign in with Recovery Phrase</button>
        <div style="text-align:center;">
          <button id="closeErrorBtn" class="btn-link" style="background:none;border:none;color:#94a3b8;font-size:.875rem;cursor:pointer;">Close</button>
        </div>
      `);

      document.getElementById('signInWithRecoveryBtn').onclick = () => {
        closeAccountModal();
        handleManualSeedLogin();
      };
      document.getElementById('closeErrorBtn').onclick = closeHelperModal;
    } else if (isCancelled) {
      // Show simple retry message for cancelled/timed out
      showAccountModal(`
        <h3>Sign-In Cancelled</h3>
        <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
          The security prompt closed. Let's try again when you're ready.
        </p>
        <div style="text-align:center;margin:24px 0;">
          <button id="retrySignInBtn" class="btn" style="margin-right:12px;">Try Again</button>
          <button id="closeErrorBtn" class="btn secondary">Cancel</button>
        </div>
      `);

      document.getElementById('retrySignInBtn').onclick = () => {
        closeAccountModal();
        handleCrossDeviceSignIn();
      };
      document.getElementById('closeErrorBtn').onclick = closeHelperModal;
    } else {
      // Generic error
      showAccountModal(`
        <h3>Sign-In Failed</h3>
        <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
          ${error.message}
        </p>
        <div style="text-align:center;margin:24px 0;">
          <button id="closeErrorBtn" class="btn">OK</button>
        </div>
      `);

      document.getElementById('closeErrorBtn').onclick = closeHelperModal;
    }

    uiStatusManager.refresh();
  }
}

/**
 * Handle manual seed login (for manual seed accounts)
 */
function handleManualSeedLogin() {
  showAccountModal(`
    <h3>Enter Your Recovery Phrase</h3>
    <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
      Enter your 12-word recovery phrase to unlock your account.
    </p>
    <textarea id="manualSeedInput" style="width:100%;min-height:100px;font-family:monospace;padding:12px;background:#0b1220;border:1px solid #334155;border-radius:6px;color:#fff;" placeholder="word1 word2 word3 ..."></textarea>
    <div style="text-align:center;margin:24px 0;">
      <button id="confirmManualLoginBtn" class="btn">Log In with Recovery Phrase</button>
    </div>
    <div id="manualLoginStatus" style="margin-top:12px;font-size:.85rem;text-align:center;"></div>
  `);

  document.getElementById('confirmManualLoginBtn').onclick = async () => {
    const statusDiv = document.getElementById('manualLoginStatus');
    const btn = document.getElementById('confirmManualLoginBtn');
    const seedInput = document.getElementById('manualSeedInput').value.trim();

    try {
      btn.disabled = true;
      btn.textContent = 'Verifying...';

      const { restoreAccountFromSeed } = await import('./core/account_creation.js');
      const account = await restoreAccountFromSeed(seedInput);

      // Derive symmetric key first (needed for metadata decryption)
      await deriveAndStoreSymmetricKey(account.seed);
      await window.bookishWallet.ensure();
      await storeSessionEncryptedSeed(account.seed);

      // Try to download account metadata from Arweave if it exists
      statusDiv.innerHTML = '<span style="color:#10b981;">✓ Recovery phrase verified, checking Arweave...</span>';

      let accountData = {
        version: 1,
        derivation: 'manual',
        created: account.createdAt
      };

      try {
        const symKeyHex = localStorage.getItem('bookish.sym');
        const symKeyBytes = hexToBytes(symKeyHex);
        const symKey = await crypto.subtle.importKey('raw', symKeyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

        const metadata = await downloadAccountMetadata(account.address, symKey);
        if (metadata) {
          console.log('[Bookish:AccountUI] Account metadata restored from Arweave');
          accountData.displayName = metadata.displayName;
          accountData.arweaveTxId = 'restored'; // Mark as having been backed up
          accountData.persistedAt = metadata.createdAt;
        }
      } catch (metadataError) {
        console.log('[Bookish:AccountUI] No account metadata found on Arweave (new account or not yet backed up)');
      }

      // Store account info locally
      localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accountData));

      // Store seed for manual accounts
      const { MANUAL_SEED_STORAGE_KEY } = await import('./core/storage_constants.js');
      localStorage.setItem(MANUAL_SEED_STORAGE_KEY, account.seed);

      statusDiv.innerHTML = '<span style="color:#10b981;">✓ Logged in!</span>';

      // Start sync loop now that user is logged in
      console.log('[Bookish:AccountUI] Manual seed login successful, starting sync loop');
      startSync();

      setTimeout(() => {
        closeAccountModal();
        // Hide banner after login
        const banner = document.getElementById('accountBanner');
        if (banner) banner.style.display = 'none';
      }, 1000);

    } catch (error) {
      console.error('[Bookish:AccountUI] Manual login failed:', error);
      statusDiv.innerHTML = `<span style="color:#ef4444;">Error: ${error.message}</span>`;
      btn.disabled = false;
      btn.textContent = 'Log In with Recovery Phrase';
    }
  };
}

/**
 * Handle logout
 */
async function handleLogout() {
  // Check for unsynced data before logout
  const persistenceState = determineAccountPersistenceState();
  const hasUnsyncedAccount = persistenceState === 'local';

  let unsyncedBooks = 0;
  if (window.bookishCache) {
    try {
      const entries = await window.bookishCache.getAllActive();
      // Count entries that don't have a txid or are still pending
      unsyncedBooks = entries.filter(e => !e.txid || e.status === 'pending').length;
    } catch (error) {
      console.error('[Bookish:AccountUI] Failed to check unsynced books:', error);
    }
  }

  // Show warning if there's unsynced data
  if (hasUnsyncedAccount || unsyncedBooks > 0) {
    showAccountModal(`
      <h3>⚠️ You May Lose Access</h3>
      <p style="font-size:.875rem;line-height:1.6;margin:16px 0;">
        Your account hasn't been backed up yet. If you log out now:
      </p>
      <div style="background:#2d1f1f;border:1px solid #7f1d1d;border-radius:8px;padding:12px 16px;margin:16px 0;">
        <div style="font-size:.85rem;line-height:1.7;">
          ${hasUnsyncedAccount ? '<div>❌ You won\'t be able to sign back in with passkey</div>' : ''}
          <div>❌ ${unsyncedBooks > 0 ? `${unsyncedBooks} book${unsyncedBooks > 1 ? 's' : ''} will be lost` : 'Your books will be lost'} unless you have your recovery phrase saved</div>
        </div>
      </div>
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
        Add funds now to back up your account before logging out.
      </p>
      <button id="addFundsStayLoggedInBtn" class="btn" style="width:100%;padding:14px 20px;background:#2563eb;margin-bottom:12px;">Enable Cloud Backup & Stay</button>
      <button id="haveRecoveryPhraseBtn" class="btn secondary" style="width:100%;padding:12px 20px;margin-bottom:16px;">I have my recovery phrase saved</button>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <button id="cancelLogoutBtn" class="btn-link" style="background:none;border:none;color:#94a3b8;font-size:.875rem;cursor:pointer;">Cancel</button>
        <button id="logoutWithoutSavingBtn" class="btn-link" style="background:none;border:none;color:#94a3b8;font-size:.875rem;cursor:pointer;">Log out without saving</button>
      </div>
    `);

    // Add Funds & Stay Logged In - opens funding, stays logged in
    document.getElementById('addFundsStayLoggedInBtn').onclick = () => {
      closeAccountModal();
      handleBuyStorage();
    };

    // I have my recovery phrase saved - proceed with logout
    document.getElementById('haveRecoveryPhraseBtn').onclick = () => {
      closeHelperModal(); // Close the warning dialog (helperModal)
      performLogout();
    };

    // Cancel - return to app
    document.getElementById('cancelLogoutBtn').onclick = closeHelperModal;

    // Log out without saving - proceed with logout (for users who accept data loss)
    document.getElementById('logoutWithoutSavingBtn').onclick = () => {
      closeHelperModal(); // Close the warning dialog (helperModal)
      performLogout();
    };
    return;
  }

  // No unsynced data, log out immediately
  performLogout();
}

/**
 * Perform actual logout (clear all data)
 */
async function performLogout() {
  // Ensure modal is closed
  closeAccountModal();

  // Stop sync manager
  stopSync();

  // Reset key state
  resetKeyState();

  // Clear all session data using centralized storage manager
  storageManager.clearSession();

  // Clear cache and books
  if (window.bookishCache) {
    await window.bookishCache.clearAll();
  }
  if (window.bookishApp) {
    window.bookishApp.clearBooks();
  }

  // Refresh UI to logged-out state
  initAccountUI();

  // Show banner after logout (if not dismissed)
  showAccountBannerIfNeeded();

  console.log('[Bookish:AccountUI] Logged out');
}

/**
 * Handle view seed
 * NOTE: Does NOT close account modal - opens recovery phrase view on top
 */
async function handleViewSeed() {
  if (isPasskeyProtected()) {
    // Try to get seed from session storage first (already decrypted)
    try {
      let seed = await getSessionEncryptedSeed();

      if (seed) {
        console.log('[Bookish:AccountUI] Using session-encrypted seed');
        showSeedPhraseModal(seed);
        return;
      }

      // No session seed, try cached PRF key to decrypt from storage
      const cachedPRFKey = await getPRFKey();

      if (cachedPRFKey) {
        console.log('[Bookish:AccountUI] Using cached PRF key to decrypt seed');
        const accountData = JSON.parse(localStorage.getItem(ACCOUNT_STORAGE_KEY));
        const encryptedData = Uint8Array.from(atob(accountData.enc), c => c.charCodeAt(0));
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: encryptedData.slice(0, 12) },
          cachedPRFKey,
          encryptedData.slice(12)
        );
        seed = new TextDecoder().decode(decrypted);
        showSeedPhraseModal(seed);
        return;
      }

      // No cached key, authenticate with passkey
      console.log('[Bookish:AccountUI] No cached PRF key, authenticating with passkey');
      const result = await unlockPasskeyProtectedAccount();
      showSeedPhraseModal(result.seed);

    } catch (error) {
      console.error('[Bookish:AccountUI] Failed to unlock seed:', error);
      uiStatusManager.refresh();
    }
  } else {
    // Manual seed account - retrieve from session storage
    try {
      const seed = await getSessionEncryptedSeed();
      if (seed) {
        showSeedPhraseModal(seed);
      } else {
        showAccountModal(`
          <h3>View Recovery Phrase</h3>
          <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
            Your recovery phrase is only stored in memory during this session. Please log in again to view it.
          </p>
          <div style="text-align:center;margin:24px 0;">
            <button onclick="window.accountUI.closeHelperModal()" class="btn">Close</button>
          </div>
        `);
      }
    } catch (error) {
      console.error('[Bookish:AccountUI] Failed to retrieve manual seed:', error);
      uiStatusManager.refresh();
    }
  }
}

/**
 * Show seed phrase modal
 */
function showSeedPhraseModal(seed) {
  const words = seed.split(' ');

  showAccountModal(`
    <h3>Your Recovery Phrase</h3>
    <div style="background:#f59e0b1a;border:1px solid #f59e0b;border-radius:6px;padding:16px;margin:16px 0;">
      <p style="font-size:.875rem;line-height:1.6;color:#f59e0b;margin:0;">
        <strong>Keep this private and secure.</strong> Anyone with this recovery phrase can access your account.
      </p>
    </div>

    <div style="background:#0b1220;border:1px solid #334155;border-radius:6px;padding:16px;margin:16px 0;">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;font-family:monospace;font-size:.875rem;">
        ${words.map((word, i) => `
          <div style="display:flex;gap:8px;">
            <span style="opacity:.5;">${i + 1}.</span>
            <span style="font-weight:500;">${word}</span>
          </div>
        `).join('')}
      </div>
    </div>

    <div style="text-align:center;margin:24px 0;display:flex;gap:8px;justify-content:center;">
      <button id="copySeedBtn" class="btn secondary">Copy to Clipboard</button>
      <button id="closeSeedBtn" class="btn">Close</button>
    </div>
  `);

  document.getElementById('copySeedBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(seed);
      const btn = document.getElementById('copySeedBtn');
      const origText = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = origText; }, 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  document.getElementById('closeSeedBtn').onclick = closeHelperModal;
}

/**
 * Handle adding passkey protection to manual account
 */
async function handleAddPasskey() {
  // Try to get seed from session storage first (user is already logged in)
  const sessionSeed = await getSessionEncryptedSeed();

  if (sessionSeed) {
    // User is logged in, seed is available - trigger passkey creation immediately
    try {
      // Get display name from existing account data
      const accountData = JSON.parse(localStorage.getItem(ACCOUNT_STORAGE_KEY) || '{}');
      const displayName = accountData.displayName || 'User';

      // Protect account with passkey using the session seed - this will show browser's passkey dialog
      const result = await protectAccountWithPasskey(sessionSeed, `Bookish: ${displayName}`);
      console.log('[Bookish:AccountUI] protectAccountWithPasskey returned credentialId:', result.credentialId);

      uiStatusManager.refresh();

      // UI will refresh when modal is reopened

      // Trigger persistence check (will auto-persist if funded)
      if (window.bookishSyncManager?.triggerPersistenceCheck) {
        window.bookishSyncManager.triggerPersistenceCheck();
      }

    } catch (error) {
      console.error('[Bookish:AccountUI] Failed to add passkey:', error);

      // Show user-friendly error modal
      showAccountModal(`
        <h3>Passkey Setup Timed Out</h3>
        <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
          The passkey creation window closed or timed out. This can happen if you wait too long to complete the authentication.
        </p>
        <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
          <strong>Please try again</strong> and complete the passkey prompt quickly when it appears.
        </p>
        <div style="margin-top:24px;">
          <button id="closeErrorBtn" class="btn" style="width:100%;">OK</button>
        </div>
      `);
      document.getElementById('closeErrorBtn').onclick = closeHelperModal;
    }
  } else {
    // User is not logged in or seed not in session - ask for seed phrase
    showAccountModal(`
      <h3>Protect with Passkey</h3>
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
        Enter your 12-word recovery phrase to enable passkey protection. This will allow you to recover your account on other devices.
      </p>

      <div style="margin:16px 0;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <label style="font-size:.875rem;opacity:.9;">Recovery Phrase (12 words)</label>
          <button id="pasteSeedBtn" class="btn secondary" style="padding:4px 8px;font-size:.75rem;">Paste</button>
        </div>
        <textarea id="seedInput" rows="3" style="width:100%;padding:12px;background:#0b1220;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-family:monospace;font-size:.875rem;resize:vertical;"></textarea>
      </div>

      <div id="addPasskeyStatus" style="margin:12px 0;font-size:.875rem;text-align:center;"></div>

      <div style="display:flex;gap:12px;margin-top:24px;">
        <button id="cancelAddPasskeyBtn" class="btn secondary" style="flex:1;">Cancel</button>
        <button id="confirmAddPasskeyBtn" class="btn" style="flex:1;">Enable Passkey</button>
      </div>
    `);

    document.getElementById('cancelAddPasskeyBtn').onclick = closeHelperModal;
    document.getElementById('pasteSeedBtn').onclick = async () => {
      try {
        const text = await navigator.clipboard.readText();
        document.getElementById('seedInput').value = text;
      } catch (error) {
        console.error('[Bookish:AccountUI] Paste failed:', error);
      }
    };
    document.getElementById('confirmAddPasskeyBtn').onclick = async () => {
      const seedInput = document.getElementById('seedInput').value.trim().toLowerCase();
      const statusDiv = document.getElementById('addPasskeyStatus');

      // Validate seed format
      const words = seedInput.split(/\s+/);
      if (words.length !== 12) {
        statusDiv.innerHTML = '<span style="color:#ef4444;">Recovery phrase must be exactly 12 words</span>';
        return;
      }

      try {
        statusDiv.textContent = 'Verifying seed...';

        // Verify the entered seed matches by comparing derived symmetric keys
        const existingSymKey = localStorage.getItem('bookish.sym');
        if (existingSymKey) {
          const derivedSymKey = await deriveAndStoreSymmetricKey(seedInput);
          if (derivedSymKey !== existingSymKey) {
            statusDiv.innerHTML = '<span style="color:#ef4444;">Recovery phrase does not match your account</span>';
            // Restore the correct symKey
            localStorage.setItem('bookish.sym', existingSymKey);
            return;
          }
        }

        await storeSessionEncryptedSeed(seedInput);

        statusDiv.textContent = 'Creating passkey...';

        // Get display name from existing account data
        const accountData = JSON.parse(localStorage.getItem(ACCOUNT_STORAGE_KEY) || '{}');
        const displayName = accountData.displayName || 'User';

        // Protect account with passkey
        const result = await protectAccountWithPasskey(seedInput, `Bookish: ${displayName}`);
        console.log('[Bookish:AccountUI] protectAccountWithPasskey returned credentialId:', result.credentialId);

        closeAccountModal();
        uiStatusManager.refresh();

        // UI will refresh when modal is reopened

      } catch (error) {
        console.error('[Bookish:AccountUI] Failed to add passkey protection:', error);
        statusDiv.innerHTML = `<span style="color:#ef4444;">${error.message}</span>`;
      }
    };
  }
}

/**
 * Handle "Buy with Transak" button click - shows coming soon message
 */
function handleBuyTransak() {
  showAccountModal(`
    <h3>Transak Coming Soon</h3>
    <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
      Transak integration is coming soon! For now, please use Coinbase to purchase Base ETH.
    </p>
    <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
      Transak will offer guest checkout, allowing you to purchase crypto without creating an account.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <button id="closeComingSoonBtn" class="btn">Got it</button>
    </div>
  `);
  document.getElementById('closeComingSoonBtn').onclick = closeHelperModal;
}

/**
 * Phase 3: Show value explanation modal before payment
 * @param {string} address - Wallet address for funding
 * @param {boolean} isFunded - Whether account already has credit
 */
function showFundingValueModal(address, isFunded = false) {
  let advancedExpanded = false;

  // Adapt messaging based on funding status
  const title = isFunded ? 'Add More Credit' : 'Make Your Books Permanent';
  const icon = isFunded ? '💰 → ☁️' : '☁️ + 🔒 = ♾️';
  const introText = isFunded
    ? 'You have some credit, but need more to back up all your books.'
    : 'Right now, your books only exist on this device. Enable cloud backup to:';
  const costLabel = isFunded ? 'Recommended: ~$5' : 'One-time cost: ~$5';
  const paymentPrompt = isFunded ? 'How would you like to add credit?' : 'How would you like to pay?';

  showAccountModal(`
    <div style="text-align:center;padding:20px 0;">
      <h3 style="margin:0 0 16px 0;">${title}</h3>
      <div style="font-size:2.5rem;margin:16px 0;opacity:.9;">${icon}</div>
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:0 0 24px 0;text-align:left;">
        ${introText}
      </p>
      ${!isFunded ? `
      <div style="text-align:left;margin:0 0 24px 0;">
        <div style="font-size:.875rem;line-height:2;margin:8px 0;">✓ Access from any device</div>
        <div style="font-size:.875rem;line-height:2;margin:8px 0;">✓ Never lose your reading history</div>
        <div style="font-size:.875rem;line-height:2;margin:8px 0;">✓ Keep your data forever</div>
      </div>
      ` : `
      <div style="text-align:left;margin:0 0 24px 0;">
        <div style="font-size:.875rem;line-height:2;margin:8px 0;">✓ Back up all your books</div>
        <div style="font-size:.875rem;line-height:2;margin:8px 0;">✓ Keep them synced across devices</div>
        <div style="font-size:.875rem;line-height:2;margin:8px 0;">✓ Ensure permanent storage</div>
      </div>
      `}
      <div style="background:#1e3a5f;border:1px solid #2563eb;border-radius:8px;padding:12px 16px;margin:0 0 24px 0;">
        <div style="font-size:.85rem;line-height:1.5;">
          <strong>${costLabel}</strong><br>
          <span style="opacity:.8;">(covers years of storage)</span>
        </div>
      </div>
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:0 0 16px 0;">${paymentPrompt}</p>
      <button id="payWithCoinbaseBtn" class="btn" style="width:100%;padding:14px 20px;background:#2563eb;margin-bottom:12px;">Pay with Coinbase</button>
      <button id="payWithCardBtn" class="btn secondary" style="width:100%;padding:12px 20px;margin-bottom:12px;opacity:.6;cursor:not-allowed;" disabled>Pay with Card (Coming Soon)</button>
      <div style="margin:16px 0;">
        <button id="toggleAdvancedBtn" class="btn-link" style="background:none;border:none;color:#94a3b8;font-size:.8rem;cursor:pointer;padding:0;">▸ Advanced: Send crypto directly</button>
      </div>
      <div id="advancedSection" style="display:none;text-align:left;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 16px;margin:16px 0;">
        <div style="font-size:.8rem;opacity:.9;margin-bottom:8px;">Send Base ETH to this address:</div>
        <div style="background:#0f172a;border:1px solid #334155;border-radius:6px;padding:8px 12px;margin:8px 0;display:flex;justify-content:space-between;align-items:center;">
          <code style="font-size:.75rem;word-break:break-all;flex:1;">${address}</code>
          <button id="copyAddressBtn" class="btn secondary copy-btn" style="margin-left:8px;padding:4px 8px;font-size:.7rem;">Copy</button>
        </div>
        <div style="font-size:.75rem;opacity:.8;margin-top:8px;line-height:1.5;">
          <div>Minimum: 0.00003 ETH (~$0.10)</div>
          <div>Recommended: 0.002 ETH (~$5)</div>
          <div style="margin-top:8px;">The app checks your balance every 30 seconds.</div>
        </div>
      </div>
      <div style="margin-top:16px;">
        <button id="maybeLaterBtn" class="btn-link" style="background:none;border:none;color:#94a3b8;font-size:.875rem;cursor:pointer;">Maybe Later</button>
      </div>
    </div>
  `);

  // Pay with Coinbase
  document.getElementById('payWithCoinbaseBtn').onclick = () => {
    closeAccountModal();
    showFundingProgress(address);
    openCoinbaseOnrampWithInstructions(address);
  };

  // Toggle advanced section
  document.getElementById('toggleAdvancedBtn').onclick = () => {
    advancedExpanded = !advancedExpanded;
    const advancedSection = document.getElementById('advancedSection');
    const toggleBtn = document.getElementById('toggleAdvancedBtn');
    if (advancedExpanded) {
      advancedSection.style.display = 'block';
      toggleBtn.textContent = '▾ Advanced: Send crypto directly';
    } else {
      advancedSection.style.display = 'none';
      toggleBtn.textContent = '▸ Advanced: Send crypto directly';
    }
  };

  // Copy address
  document.getElementById('copyAddressBtn').onclick = async () => {
    try {
      await copyAddressToClipboard(address);
      const btn = document.getElementById('copyAddressBtn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  // Maybe Later
  document.getElementById('maybeLaterBtn').onclick = () => {
    closeAccountModal();
  };
}

/**
 * Phase 3: Show progress modal during funding
 * @param {string} address - Wallet address
 */
function showFundingProgress(address) {
  let progressState = 'initiated'; // initiated, waiting, setting-up

  showAccountModal(`
    <div style="text-align:center;padding:20px 0;">
      <h3 style="margin:0 0 16px 0;">Setting Up Cloud Backup...</h3>
      <div style="font-size:3rem;margin:16px 0;opacity:.9;">⏳</div>
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:0 0 24px 0;">
        Complete your purchase in the Coinbase window.
      </p>
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:0 0 24px 0;">
        We'll automatically set up your permanent storage once payment is confirmed.
      </p>
      <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;margin:0 0 24px 0;text-align:left;">
        <div id="progressStep1" class="funding-progress-step" style="display:flex;align-items:center;gap:8px;font-size:.85rem;margin:8px 0;opacity:1;">
          <span>○</span> <span>Payment initiated</span>
        </div>
        <div id="progressStep2" class="funding-progress-step" style="display:flex;align-items:center;gap:8px;font-size:.85rem;margin:8px 0;opacity:.5;">
          <span>○</span> <span>Waiting for confirmation...</span>
        </div>
        <div id="progressStep3" class="funding-progress-step" style="display:flex;align-items:center;gap:8px;font-size:.85rem;margin:8px 0;opacity:.5;">
          <span>○</span> <span>Setting up storage</span>
        </div>
      </div>
      <button id="cancelFundingBtn" class="btn-link" style="background:none;border:none;color:#94a3b8;font-size:.875rem;cursor:pointer;">Cancel</button>
    </div>
  `);

  // Cancel button
  document.getElementById('cancelFundingBtn').onclick = () => {
    // Clear timeout check
    if (window.__fundingTimeoutCheck) {
      clearInterval(window.__fundingTimeoutCheck);
      window.__fundingTimeoutCheck = null;
    }
    closeAccountModal();
    // Reset button state
    const buyBtn = document.getElementById('buyCoinbaseBtn');
    if (buyBtn) {
      buyBtn.textContent = '☁️ Enable Cloud Backup';
      buyBtn.disabled = false;
    }
    // Clear progress state
    window.__fundingProgressState = null;
    window.__updateFundingProgress = null;
    window.__fundingStartedAt = null;
  };

  // Store progress state updater globally so Coinbase callbacks can update it
  window.__fundingProgressState = progressState;
  window.__fundingStartedAt = Date.now();

  // Phase 3: Handle timeout for long funding waits (>5 minutes)
  const timeoutCheck = setInterval(() => {
    const elapsed = Date.now() - window.__fundingStartedAt;
    if (elapsed > 5 * 60 * 1000) { // 5 minutes
      const progressModal = document.getElementById('accountPanel');
      if (progressModal && progressModal.style.display !== 'none') {
        // Show reassurance message
        const cancelBtn = document.getElementById('cancelFundingBtn');
        if (cancelBtn) {
          cancelBtn.insertAdjacentHTML('beforebegin', `
            <p id="timeoutMessage" style="font-size:.8rem;opacity:.8;margin:16px 0;line-height:1.5;">
              This can take a few minutes. We'll notify you when ready. You can close this and continue using the app.
            </p>
          `);
        }
      }
    }
  }, 60000); // Check every minute

  // Store timeout ID for cleanup
  window.__fundingTimeoutCheck = timeoutCheck;

  window.__updateFundingProgress = (state) => {
    progressState = state;
    window.__fundingProgressState = state;

    const step1 = document.getElementById('progressStep1');
    const step2 = document.getElementById('progressStep2');
    const step3 = document.getElementById('progressStep3');

    if (state === 'initiated') {
      if (step1) {
        step1.style.opacity = '1';
        step1.querySelector('span').textContent = '○';
      }
      if (step2) step2.style.opacity = '.5';
      if (step3) step3.style.opacity = '.5';
    } else if (state === 'waiting') {
      if (step1) {
        step1.style.opacity = '1';
        step1.style.color = '#10b981';
        step1.querySelector('span').textContent = '✓';
      }
      if (step2) step2.style.opacity = '1';
      if (step3) step3.style.opacity = '.5';
    } else if (state === 'setting-up') {
      if (step1) {
        step1.style.opacity = '1';
        step1.style.color = '#10b981';
        step1.querySelector('span').textContent = '✓';
      }
      if (step2) {
        step2.style.opacity = '1';
        step2.style.color = '#10b981';
        step2.querySelector('span').textContent = '✓';
      }
      if (step3) step3.style.opacity = '1';
    }
  };
}

/**
 * Phase 3: Show success modal after funding completes
 */
function showFundingSuccess() {
  showAccountModal(`
    <div style="text-align:center;padding:20px 0;">
      <div class="success-checkmark" style="font-size:3rem;margin-bottom:16px;animation:scaleIn .3s ease-out;color:#10b981;">✓</div>
      <h3 style="margin:0 0 12px 0;">Cloud Backup Enabled!</h3>
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:0 0 24px 0;">
        Your books are now saved permanently and accessible from any device.
      </p>
      <button id="backToBooksBtn" class="btn" style="width:100%;padding:14px 20px;background:#2563eb;">Back to My Books</button>
    </div>
  `);

  document.getElementById('backToBooksBtn').onclick = () => {
    closeAccountModal();
  };
}

/**
 * Handle "Enable Cloud Backup" button click - shows value explanation modal first
 */
async function handleBuyStorage() {
  try {
    const walletInfo = await getStoredWalletInfo();
    if (!walletInfo?.address) {
      showAccountModal(`
        <h3>Wallet Not Found</h3>
        <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
          Unable to find your wallet address. Please try logging out and logging back in.
        </p>
        <div style="text-align:center;margin:24px 0;">
          <button id="closeErrorBtn" class="btn">OK</button>
        </div>
      `);
      document.getElementById('closeErrorBtn').onclick = closeHelperModal;
      return;
    }

    // Get current balance to determine if funded
    let isFunded = false;
    try {
      const balanceResult = await getWalletBalance(walletInfo.address);
      const balanceETH = balanceResult.balanceETH || '0';
      const balance = parseFloat(balanceETH);
      isFunded = balance >= 0.00002; // MIN_FUNDING_ETH
    } catch (e) {
      console.error('[Bookish:AccountUI] Error checking balance for dialog:', e);
      // Default to unfunded if check fails
      isFunded = false;
    }

    // Phase 3: Show value explanation modal before payment
    showFundingValueModal(walletInfo.address, isFunded);

  } catch (error) {
    console.error('[Bookish:AccountUI] Failed to open funding flow:', error);
    showAccountModal(`
      <h3>Error</h3>
      <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
        ${error.message || 'Failed to open funding flow. Please try again.'}
      </p>
      <div style="text-align:center;margin:24px 0;">
        <button id="closeErrorBtn" class="btn">OK</button>
      </div>
    `);
    document.getElementById('closeErrorBtn').onclick = closeHelperModal;
  }
}

/**
 * Open Coinbase Onramp widget with clear instructions for user
 */
function openCoinbaseOnrampWithInstructions(address) {
  // Show loading state
  const buyBtn = document.getElementById('buyCoinbaseBtn');
  if (buyBtn) {
    buyBtn.disabled = true;
    buyBtn.textContent = 'Loading...';
  }

  // Phase 3: Update progress modal to "waiting" state
  if (window.__updateFundingProgress) {
    window.__updateFundingProgress('waiting');
  }

  // Open widget directly
  openOnrampWidget(address, {
    onSuccess: () => {
      console.log('[Bookish:AccountUI] Coinbase Onramp widget opened');
      if (buyBtn) {
        buyBtn.textContent = '☁️ Enable Cloud Backup';
        buyBtn.disabled = false;
      }
      // Progress modal should already be showing - update to waiting state
      if (window.__updateFundingProgress) {
        window.__updateFundingProgress('waiting');
      }
    },
    onError: (error) => {
      console.error('[Bookish:AccountUI] Coinbase Onramp failed:', error);
      if (buyBtn) {
        buyBtn.textContent = '☁️ Enable Cloud Backup';
        buyBtn.disabled = false;
      }

      // Check if it's a server configuration error
      let errorMessage = error.message || 'Failed to open Coinbase Onramp. Please try again.';
      let showManualOption = true;

      if (errorMessage.includes('not configured') || errorMessage.includes('credentials')) {
        errorMessage = 'Coinbase integration is not configured on the server. Please contact support or fund your wallet manually.';
        showManualOption = true;
      } else if (errorMessage.includes('Popup blocked')) {
        errorMessage = 'Your browser blocked the popup. Please allow popups for this site and try again.';
        showManualOption = false;
      }

      showAccountModal(`
        <h3>Couldn't Open Coinbase Onramp</h3>
        <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
          ${errorMessage}
        </p>
        ${showManualOption ? `
        <p style="font-size:.875rem;line-height:1.6;opacity:.9;margin:16px 0;">
          <strong>Manual option:</strong> Copy your wallet address and send Base ETH directly:
        </p>
        <div style="background:#1e293b;border:1px solid #334155;border-radius:6px;padding:12px;margin:16px 0;">
          <div style="font-size:.75rem;opacity:.7;margin-bottom:4px;">Your wallet address:</div>
          <code style="font-size:.8rem;word-break:break-all;">${address}</code>
          <button id="copyAddressManualBtn" class="btn secondary" style="margin-top:8px;width:100%;font-size:.75rem;">Copy Address</button>
        </div>
        ` : ''}
        <div style="text-align:center;margin:24px 0;">
          <button id="closeErrorBtn" class="btn">OK</button>
        </div>
      `);
      document.getElementById('closeErrorBtn').onclick = closeHelperModal;
      if (showManualOption) {
        document.getElementById('copyAddressManualBtn').onclick = async () => {
          try {
            await copyAddressToClipboard(address);
            const btn = document.getElementById('copyAddressManualBtn');
            btn.textContent = '✓ Copied!';
            setTimeout(() => { btn.textContent = 'Copy Address'; }, 2000);
          } catch (err) {
            console.error('Copy failed:', err);
          }
        };
      }
    },
    onClose: () => {
      // Widget was closed (user may have cancelled or completed purchase)
      console.log('[Bookish:AccountUI] Coinbase Onramp widget closed');
      if (buyBtn) {
        buyBtn.textContent = '☁️ Enable Cloud Backup';
        buyBtn.disabled = false;
      }
      // If progress modal is showing and user closed without completing, return to value modal
      // Otherwise, balance polling will detect funds if purchase was successful
      const progressModal = document.getElementById('accountPanel');
      if (progressModal && progressModal.style.display !== 'none') {
        // User may have cancelled - close progress modal
        // They can try again later
      }
    }
  });
}

/**
 * Handle persistence to Arweave (triggered by funding automatically)
 */
/**
 * Handle persisting account to Arweave (auto-triggered on funding)
 * Exported for sync_manager to call
 */
export async function handlePersistAccountToArweave(isAutoTrigger = false) {
  // This should only be called by auto-persistence on funding detection
  if (!isAutoTrigger) {
    console.warn('[Bookish:AccountUI] Manual persistence called - should only be auto-triggered');
    return;
  }

  try {
    const triggerType = isAutoTrigger ? 'automatic (funding detected)' : 'manual';
    console.log(`[Bookish:AccountUI] Starting ${triggerType} account persistence...`);

    // Get account data
    const accountData = localStorage.getItem(ACCOUNT_STORAGE_KEY);
    if (!accountData) {
      throw new Error('No account found');
    }

    const accountObj = JSON.parse(accountData);

    // Get seed from session storage (no passkey prompt needed)
    let seed = await getSessionEncryptedSeed();
    if (!seed) {
      // Fallback: Try unlocking with passkey if session seed not available
      if (isPasskeyProtected()) {
        console.log('[Bookish:AccountUI] Session seed not available, prompting for passkey...');
        const result = await unlockPasskeyProtectedAccount();
        seed = result.seed;
        // Store for future use in this session
        await storeSessionEncryptedSeed(seed);
      } else {
        // Manual account: Get seed from localStorage
        const { MANUAL_SEED_STORAGE_KEY } = await import('./core/storage_constants.js');
        seed = localStorage.getItem(MANUAL_SEED_STORAGE_KEY);
        if (!seed) {
          throw new Error('Manual seed not found in storage');
        }
        // Store in session for future operations
        await storeSessionEncryptedSeed(seed);
      }
    }

    // Derive wallet address
    const { deriveWalletFromSeed } = await import('./core/account_creation.js');
    const { address } = await deriveWalletFromSeed(seed);

    // Get bookish.sym key for encrypting account metadata
    const symKeyHex = localStorage.getItem('bookish.sym');
    if (!symKeyHex) {
      throw new Error('Encryption key not available');
    }
    const symKeyBytes = hexToBytes(symKeyHex);
    const symKey = await crypto.subtle.importKey('raw', symKeyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

    // Get passkey metadata (needed for display name and later for mapping upload)
    const passkeyMeta = getPasskeyMetadata();

    // Get display name from account data
    const displayName = accountObj.displayName || passkeyMeta?.userDisplayName || 'User';

    // Upload account metadata (profile only, NO SEED)
    const accountTxId = await uploadAccountMetadata({
      address,
      displayName,
      symKey,
      createdAt: accountObj.created
    });

    console.log('[Bookish:AccountUI] Account metadata uploaded:', accountTxId);

    // If passkey account, also upload mapping with encrypted seed
    let mappingTxId = null;

    if (passkeyMeta?.credentialId) {
      console.log('[Bookish:AccountUI] Uploading passkey mapping with encrypted seed...');

      // Get PRF key for encrypting seed (check cache first to avoid passkey prompt)
      const { getPRFKey } = await import('./core/crypto_core.js');
      let encryptionKey = await getPRFKey();

      if (!encryptionKey) {
        console.log('[Bookish:AccountUI] PRF key not cached, authenticating...');
        const { authenticateWithPRF } = await import('./core/passkey_core.js');
        const result = await authenticateWithPRF();
        encryptionKey = result.encryptionKey;

        // Cache for future use
        const { storePRFKey } = await import('./core/crypto_core.js');
        await storePRFKey(encryptionKey);
      }

      mappingTxId = await uploadPasskeyMapping(passkeyMeta.credentialId, seed, encryptionKey);
      console.log('[Bookish:AccountUI] Passkey mapping uploaded:', mappingTxId);
    }

    // Update account storage with tx IDs
    accountObj.arweaveTxId = accountTxId;
    accountObj.persistedAt = Date.now();
    if (mappingTxId) {
      accountObj.passkeyMappingTxId = mappingTxId;
    }

    // Phase 3: Update progress to "setting-up" state
    // First ensure step 2 is marked complete, then update to "setting-up"
    try {
      if (window.__updateFundingProgress) {
        // First ensure step 2 is marked complete
        if (window.__fundingProgressState !== 'waiting' && window.__fundingProgressState !== 'setting-up') {
          window.__updateFundingProgress('waiting');
        }
        // Then update to "setting-up"
        window.__updateFundingProgress('setting-up');
      }
    } catch (error) {
      console.error('[Bookish:AccountUI] Failed to update progress modal:', error);
      // Continue with persistence completion anyway
    }
    localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accountObj));

    // Update UI
    updateAccountPersistenceIndicator('syncing');

    setTimeout(() => {
      updateAccountPersistenceIndicator('confirmed');

      uiStatusManager.refresh();

      // UI will refresh when modal is reopened

      // Phase 3: Show success modal if progress modal was showing
      if (window.__fundingProgressState) {
        // Clear timeout check
        if (window.__fundingTimeoutCheck) {
          clearInterval(window.__fundingTimeoutCheck);
          window.__fundingTimeoutCheck = null;
        }
        // Close progress modal and show success
        closeAccountModal();
        setTimeout(() => {
          showFundingSuccess();
        }, 300);
        // Clear progress state
        window.__fundingProgressState = null;
        window.__updateFundingProgress = null;
        window.__fundingStartedAt = null;
      }
    }, 2000);

  } catch (error) {
    console.error('[Bookish:AccountUI] Failed to persist account:', error);
    uiStatusManager.refresh();
  }
}

/**
 * Store session encryption (seed encrypted with bookish.sym)
 */
/**
 * Determine account persistence state for UI indicator
 */

/**
 * Determine account persistence state
 */
function determineAccountPersistenceState() {
  const accountData = localStorage.getItem(ACCOUNT_STORAGE_KEY);
  if (!accountData) return 'local';

  try {
    const accountObj = JSON.parse(accountData);
    // Check if account metadata has been uploaded to Arweave
    if (accountObj.arweaveTxId && accountObj.arweaveTxId !== 'restored') {
      return 'confirmed'; // Account was uploaded from this device
    }
    if (accountObj.arweaveTxId === 'restored') {
      return 'confirmed'; // Account was restored from Arweave
    }
  } catch (e) {
    console.error('Failed to parse account data:', e);
  }

  return 'local';
}

/**
 * Get persistence indicator HTML
 */
function getPersistenceIndicatorHTML(state) {
  // Use same status dot styling as books
  const classes = {
    local: 'local',      // yellow/orange
    syncing: 'irys',     // green
    confirmed: 'arweave' // dark green
  };
  const titles = {
    local: 'Account stored locally only',
    syncing: 'Syncing to Arweave...',
    confirmed: 'Backed up on Arweave'
  };
  const cls = classes[state] || 'local';
  const title = titles[state] || titles.local;
  return `<span class="status-dot ${cls}" style="position:relative;display:inline-block;width:10px;height:10px;top:0;right:0;margin-left:6px;vertical-align:middle;" title="${title}"></span>`;
}

/**
 * Update persistence indicator
 */
function updateAccountPersistenceIndicator(state) {
  // Modal content is rendered fresh each time it opens, so no need to update here
  // This function is kept for backward compatibility but does nothing
}

/**
 * Store wallet info
 */
/**
 * Get stored wallet info from window.bookishWallet
 */
export async function getStoredWalletInfo() {
  try {
    const address = await window.bookishWallet?.getAddress();
    if (!address) return null;
    return { address };
  } catch {
    return null;
  }
}

/**
 * Update balance display with current value
 * Exported for sync_manager to use
 */
export function updateBalanceDisplay(balanceETH) {
  currentBalanceETH = balanceETH;
  const balanceElement = document.getElementById('accountBalanceDisplay');
  if (!balanceElement) return;

  const balance = parseFloat(balanceETH);
  const isFunded = balance > 0.00002; // ~$0.07 Base ETH

  // Format as "~X books remaining"
  const formattedBalance = formatBalanceAsBooks(balanceETH, { showExact: false });
  const status = getBalanceStatus(balanceETH);

  balanceElement.textContent = formattedBalance;
  balanceElement.className = `balance-display balance-${status}`;

  // Update "Buy Storage" buttons visibility based on funding status
  updateBuyStorageButtonVisibility(isFunded).catch(err => {
    console.error('[Bookish:AccountUI] Failed to update buy storage button:', err);
  });
}

/**
 * Update "Buy Storage" buttons visibility based on funding status
 * Buttons always show when logged in (users can add more funds anytime)
 */
async function updateBuyStorageButtonVisibility(isFunded) {
  const buyCoinbaseBtn = document.getElementById('buyCoinbaseBtn');
  const buyTransakBtn = document.getElementById('buyTransakBtn');

  // Always show buttons when wallet is available (Coinbase Onramp available via server)
  const walletInfo = await getStoredWalletInfo();
  if (walletInfo && isCoinbaseOnrampConfigured()) {
    if (buyCoinbaseBtn) buyCoinbaseBtn.style.display = 'inline-flex';
    if (buyTransakBtn) buyTransakBtn.style.display = 'inline-flex';
  } else {
    if (buyCoinbaseBtn) buyCoinbaseBtn.style.display = 'none';
    if (buyTransakBtn) buyTransakBtn.style.display = 'none';
  }
}

/**
 * Modal helpers
 */
function showAccountModal(content, showClose = true) {
  // Create helper modal for various account-related modals (recovery phrase, success, etc.)
  // This is separate from the main account panel modal
  // When account modal is open, this should appear ON TOP with higher z-index
  const accountModal = document.getElementById('accountModal');
  const isAccountModalOpen = accountModal && accountModal.style.display === 'flex';

  let helperModal = document.getElementById('helperModal');
  if (!helperModal) {
    helperModal = document.createElement('div');
    helperModal.id = 'helperModal';
    helperModal.className = 'modal';
    document.body.appendChild(helperModal);
  }

  // If account modal is open, use higher z-index to appear on top
  if (isAccountModalOpen) {
    helperModal.style.zIndex = '1002'; // Higher than account modal (1000)
  } else {
    helperModal.style.zIndex = '5000'; // Default z-index
  }

  helperModal.innerHTML = `
    <div class="modal-content">
      ${showClose ? '<button class="modal-close" onclick="window.accountUI.closeHelperModal()">×</button>' : ''}
      ${content}
    </div>
  `;
  helperModal.style.display = 'flex';
}

function closeHelperModal() {
  const modal = document.getElementById('helperModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

// Export for use in HTML onclick handlers
window.accountUI = {
  closeAccountModal,
  closeHelperModal,
  handlePersistAccountToArweave,
  updateBalanceDisplay
};

// Auto-initialize on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAccountUI);
} else {
  initAccountUI();
}
