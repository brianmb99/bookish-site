// passkey_protection.js - Passkey enrollment for existing accounts
// Handles: passkey creation + PRF encryption of seed
// No account creation, no Arweave uploads - just passkey protection

import { encryptJson, decryptJson } from './crypto_core.js';
import { PASSKEY_STORAGE_KEY, ACCOUNT_STORAGE_KEY } from './storage_constants.js';
const RP_NAME = 'Bookish';
const RP_ID = window.location.hostname;

/**
 * Store passkey metadata to localStorage
 * Centralized function to ensure consistent data structure across all passkey flows
 * @param {string} credentialId - Base64 credential ID
 * @param {string} displayName - User display name
 * @param {number} createdAt - Creation timestamp (defaults to now)
 */
export function storePasskeyMetadata(credentialId, displayName, createdAt = Date.now()) {
  const passkeyMetadata = {
    version: 2,
    credentialId,
    displayName,
    createdAt,
    prfEnabled: true
  };

  localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(passkeyMetadata));
  console.log('[Bookish:PasskeyProtection] Passkey metadata stored:', {
    version: passkeyMetadata.version,
    credentialId: credentialId.substring(0, 16) + '...',
    displayName,
    prfEnabled: true
  });
}

// Constant PRF salt (no userId needed)
const PRF_SALT_CONSTANT = 'bookish-prf-v1';

/**
 * Derive constant PRF salt
 * @returns {Promise<Uint8Array>}
 */
async function getPRFSalt() {
  const encoder = new TextEncoder();
  const data = encoder.encode(PRF_SALT_CONSTANT);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash);
}

/**
 * Create PRF-enabled passkey and return encryption key
 * @param {string} displayName - User display name for passkey
 * @returns {Promise<{encryptionKey: CryptoKey, credentialId: string}>}
 */
async function createPRFPasskey(displayName) {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));

  const createOptions = {
    publicKey: {
      challenge,
      rp: { name: RP_NAME, id: RP_ID },
      user: {
        id: userId,
        name: displayName,
        displayName
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },  // ES256
        { type: 'public-key', alg: -257 } // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        requireResidentKey: true,
        userVerification: 'required'
      },
      extensions: {
        prf: {
          eval: {
            first: await getPRFSalt()
          }
        }
      }
    }
  };

  try {
    const credential = await navigator.credentials.create(createOptions);

    // Check if PRF was successful
    const prfResults = credential.getClientExtensionResults().prf;
    if (!prfResults?.enabled || !prfResults?.results?.first) {
      throw new Error('PRF extension not supported or failed');
    }

    // Derive encryption key from PRF output
    const prfOutput = new Uint8Array(prfResults.results.first);
    const encryptionKey = await crypto.subtle.importKey(
      'raw',
      prfOutput,
      { name: 'AES-GCM' },
      true, // extractable: true (so we can cache it)
      ['encrypt', 'decrypt']
    );

    // Convert credential ID to base64
    const credentialIdBytes = new Uint8Array(credential.rawId);
    const credentialId = btoa(String.fromCharCode(...credentialIdBytes));

    console.log('[Bookish:PasskeyProtection] PRF passkey created:', credentialId.substring(0, 16) + '...');

    return { encryptionKey, credentialId };
  } catch (error) {
    console.error('[Bookish:PasskeyProtection] Passkey creation failed:', error);

    if (error.name === 'NotAllowedError') {
      throw new Error('Passkey creation was cancelled or timed out');
    }
    throw new Error(`Failed to create passkey: ${error.message}`);
  }
}

/**
 * Authenticate with existing PRF passkey
 * @returns {Promise<{encryptionKey: CryptoKey, credentialId: string}>}
 */
async function authenticateWithPRFPasskey() {
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  const getOptions = {
    publicKey: {
      challenge,
      rpId: RP_ID,
      userVerification: 'required',
      extensions: {
        prf: {
          eval: {
            first: await getPRFSalt()
          }
        }
      }
    }
  };

  try {
    const assertion = await navigator.credentials.get(getOptions);

    // Check if PRF was successful
    const prfResults = assertion.getClientExtensionResults().prf;
    if (!prfResults?.results?.first) {
      throw new Error('PRF extension failed during authentication');
    }

    // Derive encryption key from PRF output
    const prfOutput = new Uint8Array(prfResults.results.first);
    const encryptionKey = await crypto.subtle.importKey(
      'raw',
      prfOutput,
      { name: 'AES-GCM' },
      true, // extractable: true (so we can cache it)
      ['encrypt', 'decrypt']
    );

    // Convert credential ID to base64
    const credentialIdBytes = new Uint8Array(assertion.rawId);
    const credentialId = btoa(String.fromCharCode(...credentialIdBytes));

    console.log('[Bookish:PasskeyProtection] Authenticated with passkey:', credentialId.substring(0, 16) + '...');

    return { encryptionKey, credentialId };
  } catch (error) {
    console.error('[Bookish:PasskeyProtection] Authentication failed:', error);

    if (error.name === 'NotAllowedError') {
      throw new Error('Authentication was cancelled or timed out');
    }
    throw new Error(`Failed to authenticate: ${error.message}`);
  }
}

/**
 * Protect an existing account with passkey (encrypt seed with PRF)
 * @param {string} seed - 12-word mnemonic to protect
 * @param {string} displayName - User display name
 * @returns {Promise<{credentialId: string}>}
 */
export async function protectAccountWithPasskey(seed, displayName = 'Bookish User') {
  console.log('[Bookish:PasskeyProtection] Enrolling passkey protection...');

  // Create PRF passkey
  const { encryptionKey, credentialId } = await createPRFPasskey(displayName);
  console.log('[Bookish:PasskeyProtection] Created PRF passkey, credentialId:', credentialId);

  // Cache PRF key for future use (eliminates passkey prompts during session)
  const { storePRFKey } = await import('./crypto_core.js');
  await storePRFKey(encryptionKey);

  // Encrypt seed with PRF-derived key
  const encryptedSeed = await encryptJson(encryptionKey, {
    mnemonic: seed,
    encrypted: Date.now()
  });
  console.log('[Bookish:PasskeyProtection] Encrypted seed, length:', encryptedSeed.length);

  // Store encrypted seed in unified account storage
  const accountData = {
    version: 2,
    derivation: 'prf',
    enc: encryptedSeed,
    credentialId,
    created: Date.now()
  };

  localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accountData));
  console.log('[Bookish:PasskeyProtection] Stored account data to localStorage');

  // Store passkey metadata using centralized function
  storePasskeyMetadata(credentialId, displayName);

  console.log('[Bookish:PasskeyProtection] Account protected with passkey');

  return { credentialId };
}

/**
 * Unlock passkey-protected account (decrypt seed with PRF)
 * @returns {Promise<{seed: string, credentialId: string}>}
 */
export async function unlockPasskeyProtectedAccount() {
  console.log('[Bookish:PasskeyProtection] Unlocking passkey-protected account...');

  // Check if passkey-protected account exists
  const accountDataStr = localStorage.getItem(ACCOUNT_STORAGE_KEY);
  if (!accountDataStr) {
    throw new Error('No account found. Please create an account first.');
  }

  const accountData = JSON.parse(accountDataStr);
  console.log('[Bookish:PasskeyProtection] Account data to decrypt:', {
    version: accountData.version,
    derivation: accountData.derivation,
    hasEnc: !!accountData.enc,
    encLength: accountData.enc?.length,
    storedCredentialId: accountData.credentialId,
    encPreview: accountData.enc?.substring(0, 50)
  });

  if (accountData.version !== 2 || accountData.derivation !== 'prf') {
    throw new Error('Account is not passkey-protected');
  }

  // Authenticate with passkey to get decryption key
  const { encryptionKey, credentialId } = await authenticateWithPRFPasskey();
  console.log('[Bookish:PasskeyProtection] Authenticated with credentialId:', credentialId);
  console.log('[Bookish:PasskeyProtection] Does it match stored credentialId?', credentialId === accountData.credentialId);

  // Cache PRF key for future use (eliminates passkey prompts during session)
  const { storePRFKey } = await import('./crypto_core.js');
  await storePRFKey(encryptionKey);

  // Decrypt seed
  console.log('[Bookish:PasskeyProtection] Attempting to decrypt with encryptionKey...');
  const decrypted = await decryptJson(encryptionKey, accountData.enc);

  console.log('[Bookish:PasskeyProtection] Account unlocked');

  return {
    seed: decrypted.mnemonic,
    credentialId
  };
}

/**
 * Check if account is passkey-protected
 * @returns {boolean}
 */
export function isPasskeyProtected() {
  try {
    const accountData = localStorage.getItem(ACCOUNT_STORAGE_KEY);
    if (!accountData) return false;

    const parsed = JSON.parse(accountData);
    return parsed.version === 2 && parsed.derivation === 'prf';
  } catch {
    return false;
  }
}

/**
 * Get passkey metadata if exists
 * @returns {Object|null}
 */
export function getPasskeyMetadata() {
  try {
    const data = localStorage.getItem(PASSKEY_STORAGE_KEY);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}
