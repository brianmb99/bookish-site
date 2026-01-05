// storage_manager.js - Centralized localStorage management
// Single source of truth for all app storage keys and operations
// Prevents bugs like missing cleanup during logout

/**
 * Storage keys used by the application
 */
export const STORAGE_KEYS = {
  // Account & Authentication
  ACCOUNT: 'bookish.account',              // Account metadata (address, derivation, displayName, created, arweaveTxId)
  SYM_KEY: 'bookish.sym',                  // Symmetric encryption key (hex string)
  SESSION_SEED: 'bookish.account.sessionEnc', // Session-encrypted seed
  MANUAL_SEED: 'bookish.seed.manual',      // Manual seed for non-passkey accounts
  PASSKEY: 'bookish.passkey',              // Passkey credential info
  SEED_SHOWN: 'bookish.seed.shown',        // Flag: seed phrase has been shown to user
  PRF_KEY: 'bookish.prf.key',              // Cached PRF key for passkey accounts

  // Wallet
  EVM_WALLET: 'bookish.evmWallet.v1'       // Encrypted EVM wallet (Base)
};

// ============================================================================
// GETTERS (Read with type safety and parsing)
// ============================================================================

/**
 * Get account metadata
 * @returns {Object|null} Parsed account object or null
 */
export function getAccount() {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.ACCOUNT);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('[StorageManager] Failed to parse account:', error);
    return null;
  }
}

/**
 * Get symmetric encryption key
 * @returns {string|null} Hex string or null
 */
export function getSymKey() {
  return localStorage.getItem(STORAGE_KEYS.SYM_KEY);
}

/**
 * Get session-encrypted seed
 * @returns {string|null} Seed string or null
 */
export function getSessionSeed() {
  return localStorage.getItem(STORAGE_KEYS.SESSION_SEED);
}

/**
 * Get manual seed (for non-passkey accounts)
 * @returns {string|null} Seed string or null
 */
export function getManualSeed() {
  return localStorage.getItem(STORAGE_KEYS.MANUAL_SEED);
}

/**
 * Get passkey credential info
 * @returns {Object|null} Parsed passkey object or null
 */
export function getPasskeyInfo() {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.PASSKEY);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('[StorageManager] Failed to parse passkey info:', error);
    return null;
  }
}

/**
 * Get EVM wallet record
 * @returns {Object|null} Parsed wallet record or null
 */
export function getWalletRecord() {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.EVM_WALLET);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('[StorageManager] Failed to parse wallet record:', error);
    return null;
  }
}

/**
 * Get cached PRF key
 * @returns {string|null} PRF key or null
 */
export function getPRFKey() {
  return localStorage.getItem(STORAGE_KEYS.PRF_KEY);
}

/**
 * Check if seed has been shown to user
 * @returns {boolean}
 */
export function getSeedShown() {
  return localStorage.getItem(STORAGE_KEYS.SEED_SHOWN) === 'true';
}

// ============================================================================
// SETTERS (Write with validation)
// ============================================================================

/**
 * Set account metadata
 * @param {Object} accountData - Account object
 */
export function setAccount(accountData) {
  if (!accountData || typeof accountData !== 'object') {
    throw new Error('Invalid account data');
  }
  localStorage.setItem(STORAGE_KEYS.ACCOUNT, JSON.stringify(accountData));
}

/**
 * Set symmetric encryption key
 * @param {string} hexString - Hex-encoded key
 */
export function setSymKey(hexString) {
  if (!hexString || typeof hexString !== 'string') {
    throw new Error('Invalid symmetric key');
  }
  localStorage.setItem(STORAGE_KEYS.SYM_KEY, hexString);
}

/**
 * Set session-encrypted seed
 * @param {string} seed - Seed phrase
 */
export function setSessionSeed(seed) {
  if (!seed || typeof seed !== 'string') {
    throw new Error('Invalid session seed');
  }
  localStorage.setItem(STORAGE_KEYS.SESSION_SEED, seed);
}

/**
 * Set manual seed
 * @param {string} seed - Seed phrase
 */
export function setManualSeed(seed) {
  if (!seed || typeof seed !== 'string') {
    throw new Error('Invalid manual seed');
  }
  localStorage.setItem(STORAGE_KEYS.MANUAL_SEED, seed);
}

/**
 * Set passkey credential info
 * @param {Object} info - Passkey info object
 */
export function setPasskeyInfo(info) {
  if (!info || typeof info !== 'object') {
    throw new Error('Invalid passkey info');
  }
  localStorage.setItem(STORAGE_KEYS.PASSKEY, JSON.stringify(info));
}

/**
 * Set EVM wallet record
 * @param {Object} record - Wallet record object
 */
export function setWalletRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('Invalid wallet record');
  }
  localStorage.setItem(STORAGE_KEYS.EVM_WALLET, JSON.stringify(record));
}

/**
 * Set cached PRF key
 * @param {string} key - PRF key
 */
export function setPRFKey(key) {
  if (!key || typeof key !== 'string') {
    throw new Error('Invalid PRF key');
  }
  localStorage.setItem(STORAGE_KEYS.PRF_KEY, key);
}

/**
 * Set seed shown flag
 * @param {boolean} shown - Whether seed has been shown
 */
export function setSeedShown(shown) {
  localStorage.setItem(STORAGE_KEYS.SEED_SHOWN, shown ? 'true' : 'false');
}

// ============================================================================
// CHECKERS (Boolean queries)
// ============================================================================

/**
 * Check if account exists
 * @returns {boolean}
 */
export function hasAccount() {
  return !!localStorage.getItem(STORAGE_KEYS.ACCOUNT);
}

/**
 * Check if symmetric key exists
 * @returns {boolean}
 */
export function hasSymKey() {
  return !!localStorage.getItem(STORAGE_KEYS.SYM_KEY);
}

/**
 * Check if session seed exists
 * @returns {boolean}
 */
export function hasSessionSeed() {
  return !!localStorage.getItem(STORAGE_KEYS.SESSION_SEED);
}

/**
 * Check if wallet exists
 * @returns {boolean}
 */
export function hasWallet() {
  return !!localStorage.getItem(STORAGE_KEYS.EVM_WALLET);
}

/**
 * Check if user is logged in (has both account and sym key)
 * @returns {boolean}
 */
export function isLoggedIn() {
  return hasAccount() && hasSymKey();
}

/**
 * Check if account is persisted to Arweave
 * @returns {boolean}
 */
export function isAccountPersisted() {
  const account = getAccount();
  return !!(account && account.arweaveTxId);
}

// ============================================================================
// CLEARERS (Granular removal)
// ============================================================================

/**
 * Clear account metadata
 */
export function clearAccount() {
  localStorage.removeItem(STORAGE_KEYS.ACCOUNT);
}

/**
 * Clear authentication data (sym key, session seed, PRF key)
 */
export function clearAuth() {
  localStorage.removeItem(STORAGE_KEYS.SYM_KEY);
  localStorage.removeItem(STORAGE_KEYS.SESSION_SEED);
  localStorage.removeItem(STORAGE_KEYS.PRF_KEY);
}

/**
 * Clear EVM wallet
 */
export function clearWallet() {
  localStorage.removeItem(STORAGE_KEYS.EVM_WALLET);
}

/**
 * Clear passkey info
 */
export function clearPasskey() {
  localStorage.removeItem(STORAGE_KEYS.PASSKEY);
}

/**
 * Clear manual seed
 */
export function clearManualSeed() {
  localStorage.removeItem(STORAGE_KEYS.MANUAL_SEED);
}

/**
 * Clear seed shown flag
 */
export function clearSeedShown() {
  localStorage.removeItem(STORAGE_KEYS.SEED_SHOWN);
}

// ============================================================================
// CLEARERS (Bulk operations)
// ============================================================================

/**
 * Clear all session data (logout)
 * Removes everything related to current session
 */
export function clearSession() {
  clearAuth();
  clearAccount();
  clearWallet();
  clearPasskey();
  clearManualSeed();
  clearSeedShown();
}

/**
 * Clear all storage (nuclear option)
 * Use with extreme caution - removes ALL Bookish data
 */
export function clearAll() {
  Object.values(STORAGE_KEYS).forEach(key => {
    localStorage.removeItem(key);
  });
}

// ============================================================================
// STATE QUERIES (Debugging & monitoring)
// ============================================================================

/**
 * Get complete storage state (for debugging)
 * @returns {Object} Object with all storage flags
 */
export function getStorageState() {
  return {
    hasAccount: hasAccount(),
    hasSymKey: hasSymKey(),
    hasSessionSeed: hasSessionSeed(),
    hasManualSeed: !!getManualSeed(),
    hasPasskey: !!getPasskeyInfo(),
    hasWallet: hasWallet(),
    hasPRFKey: !!getPRFKey(),
    seedShown: getSeedShown(),
    isLoggedIn: isLoggedIn(),
    isAccountPersisted: isAccountPersisted()
  };
}

/**
 * Get all sensitive storage keys (for privacy/logging)
 * @returns {string[]} Array of key names containing sensitive data
 */
export function getSensitiveKeys() {
  return [
    STORAGE_KEYS.SYM_KEY,
    STORAGE_KEYS.SESSION_SEED,
    STORAGE_KEYS.MANUAL_SEED,
    STORAGE_KEYS.PRF_KEY,
    STORAGE_KEYS.EVM_WALLET
  ];
}

/**
 * Mask sensitive data in object (for safe logging)
 * @param {Object} obj - Object to mask
 * @returns {Object} Object with sensitive fields masked
 */
export function maskSensitiveData(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const masked = { ...obj };
  const sensitiveFields = ['seed', 'privateKey', 'enc', 'key'];

  for (const field of sensitiveFields) {
    if (masked[field]) {
      masked[field] = '[REDACTED]';
    }
  }

  return masked;
}

// ============================================================================
// EXPORT/IMPORT (Backup & restore)
// ============================================================================

/**
 * Export all storage data (for backup)
 * @returns {Object} Object containing all storage data
 */
export function exportAllData() {
  const data = {};

  Object.entries(STORAGE_KEYS).forEach(([name, key]) => {
    const value = localStorage.getItem(key);
    if (value !== null) {
      data[key] = value;
    }
  });

  return data;
}

/**
 * Import storage data (for restore)
 * WARNING: Overwrites existing data
 * @param {Object} data - Data object from exportAllData()
 */
export function importAllData(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid import data');
  }

  // Validate keys before importing
  const validKeys = Object.values(STORAGE_KEYS);
  const dataKeys = Object.keys(data);

  for (const key of dataKeys) {
    if (!validKeys.includes(key)) {
      console.warn(`[StorageManager] Unknown key in import: ${key}`);
    }
  }

  // Clear existing data first
  clearAll();

  // Import new data
  Object.entries(data).forEach(([key, value]) => {
    if (validKeys.includes(key)) {
      localStorage.setItem(key, value);
    }
  });
}
