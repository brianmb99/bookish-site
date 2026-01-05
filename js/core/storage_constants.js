// storage_constants.js - Centralized localStorage key constants
// Single source of truth for all storage keys used across the app

// Account and authentication
export const ACCOUNT_STORAGE_KEY = 'bookish.account';
export const PASSKEY_STORAGE_KEY = 'bookish.passkey';
export const SEED_SHOWN_KEY = 'bookish.seed.shown';

// Session and encryption
export const SYM_KEY_STORAGE_KEY = 'bookish.sym';
export const SESSION_ENC_STORAGE_KEY = 'bookish.account.sessionEnc';
export const PRF_KEY_STORAGE_KEY = 'bookish.prfKey';

// Wallet
export const WALLET_STORAGE_KEY = 'bookish.wallet';
export const EVM_WALLET_STORAGE_KEY = 'bookish.evmWallet.v1';

// Manual seed
export const MANUAL_SEED_STORAGE_KEY = 'bookish.seed.manual';
