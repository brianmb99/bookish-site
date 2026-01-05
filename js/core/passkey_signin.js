// passkey_signin.js - Passkey-based account sign-in flow
// Works on same device or new device (if passkey synced via iCloud/Google)
// Flow: authenticate → download mapping → download metadata → restore local state

import { authenticateWithAnyPRFPasskey } from './passkey_core.js';
import { getSeedByCredentialId } from './passkey_mapping.js';
import { downloadAccountMetadata } from './account_arweave.js';
import { storeSeed } from './seed_core.js';
import { deriveWalletFromSeed } from './account_creation.js';
import { storePasskeyMetadata } from './passkey_protection.js';
import { deriveAndStoreSymmetricKey, storeSessionEncryptedSeed, storePRFKey, hexToBytes, importAesKey } from './crypto_core.js';
import { storeWalletAddress } from './wallet_core.js';
import { ACCOUNT_STORAGE_KEY } from './storage_constants.js';

/**
 * Sign in with passkey (same device or new device with synced passkey)
 * Orchestrates Flow 2 from ARCHITECTURE.md
 *
 * @returns {Promise<Object>} - Restored account data {seed, address, displayName, credentialId}
 */
export async function signInWithPasskey() {
  console.log('[Bookish:PasskeySignIn] Starting passkey sign-in...');

  // Step 1: Authenticate with passkey to get PRF encryption key
  console.log('[Bookish:PasskeySignIn] Step 1: Authenticating with passkey...');
  const { encryptionKey, credentialId } = await authenticateWithAnyPRFPasskey();
  console.log(`[Bookish:PasskeySignIn] Authenticated, credentialId: ${credentialId.substring(0, 16)}...`);

  // Step 2: Download and decrypt seed from Arweave passkey mapping
  console.log('[Bookish:PasskeySignIn] Step 2: Downloading encrypted seed from Arweave...');
  const seed = await getSeedByCredentialId(credentialId, encryptionKey);

  if (!seed) {
    throw new Error('No passkey mapping found on Arweave. Account may not be funded/uploaded yet.');
  }

  console.log('[Bookish:PasskeySignIn] Seed decrypted successfully');

  // Step 3: Derive wallet address from seed
  console.log('[Bookish:PasskeySignIn] Step 3: Deriving wallet address...');
  const { address } = await deriveWalletFromSeed(seed);
  console.log(`[Bookish:PasskeySignIn] Wallet address: ${address}`);

  // Step 4: Download account metadata from Arweave (requires deriving symKey for decryption)
  console.log('[Bookish:PasskeySignIn] Step 4: Downloading account metadata...');
  await deriveAndStoreSymmetricKey(seed); // Derives and stores bookish.sym
  const symHex = localStorage.getItem('bookish.sym');
  const symKeyBytes = hexToBytes(symHex);
  const symKey = await importAesKey(symKeyBytes);

  const accountMetadata = await downloadAccountMetadata(address, symKey);

  if (!accountMetadata) {
    console.debug('[Bookish:PasskeySignIn] No account metadata found, using defaults');
  }

  const displayName = accountMetadata?.displayName || 'Bookish User';
  const createdAt = accountMetadata?.createdAt || Date.now();

  console.log('[Bookish:PasskeySignIn] Account metadata downloaded');

  // Step 5: Restore local state using shared functions
  console.log('[Bookish:PasskeySignIn] Step 5: Restoring local state...');

  // Store PRF-encrypted seed
  await storeSeed(seed, encryptionKey);
  console.log('[Bookish:PasskeySignIn] Seed stored with PRF encryption');

  // Store passkey metadata
  storePasskeyMetadata(credentialId, displayName, createdAt);
  console.log('[Bookish:PasskeySignIn] Passkey metadata stored');

  // Store session-encrypted seed (uses bookish.sym already stored in step 4)
  await storeSessionEncryptedSeed(seed);
  console.log('[Bookish:PasskeySignIn] Session-encrypted seed stored');

  // Cache PRF key to eliminate re-prompts during session
  await storePRFKey(encryptionKey);
  console.log('[Bookish:PasskeySignIn] PRF key cached');

  // Store wallet address
  storeWalletAddress(address);
  console.log('[Bookish:PasskeySignIn] Wallet address stored');

  // Store account info with arweaveTxId: 'restored' to prevent re-upload
  const accountData = {
    version: 2,
    derivation: 'prf',
    displayName,
    created: createdAt,
    arweaveTxId: 'restored', // Mark as already backed up to Arweave
    persistedAt: createdAt
  };
  localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accountData));
  console.log('[Bookish:PasskeySignIn] Account info stored (marked as restored from Arweave)');

  console.log('[Bookish:PasskeySignIn] ✅ Passkey sign-in complete');

  return {
    seed,
    address,
    displayName,
    credentialId
  };
}

/**
 * Check if passkey sign-in is available
 * (Passkeys supported + no local account)
 * @returns {Promise<boolean>}
 */
export async function isPasskeySignInAvailable() {
  // Check if passkeys are supported
  if (!navigator.credentials || !window.PublicKeyCredential) {
    return false;
  }

  // Check if local account already exists
  const hasLocalAccount = !!localStorage.getItem('bookish.account');
  if (hasLocalAccount) {
    return false;
  }

  return true;
}
