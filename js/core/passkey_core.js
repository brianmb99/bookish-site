// passkey_core.js - WebAuthn PRF Extension for deterministic key derivation
// Uses PRF (Pseudo-Random Function) extension for deterministic encryption keys
// PRF generates the same encryption key on all devices where passkey syncs

import { PASSKEY_STORAGE_KEY } from './storage_constants.js';

const RP_NAME = 'Bookish';
const RP_ID = window.location.hostname;
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
 * Check if WebAuthn is supported in this browser
 * @returns {boolean}
 */
export function isPasskeySupported() {
  return !!(navigator.credentials && window.PublicKeyCredential);
}

/**
 * Check if PRF extension is supported (Chrome 108+, Edge 108+, Safari 17+)
 * Note: Firefox does not support PRF yet as of Oct 2024
 * @returns {Promise<boolean>}
 */
export async function isPRFSupported() {
  if (!isPasskeySupported()) {
    return false;
  }

  // Check if platform authenticator is available
  try {
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) {
      return false;
    }

    // PRF support detection: We can't directly check PRF support without attempting to create a credential.
    // Instead, we'll rely on user agent detection for now (Chrome/Edge 108+, Safari 17+)
    const ua = navigator.userAgent;

    // Chrome/Edge 108+
    if (ua.includes('Chrome/') || ua.includes('Edg/')) {
      const match = ua.match(/(?:Chrome|Edg)\/(\d+)/);
      if (match && parseInt(match[1]) >= 108) {
        return true;
      }
    }

    // Safari 17+
    if (ua.includes('Safari/') && !ua.includes('Chrome')) {
      const match = ua.match(/Version\/(\d+)/);
      if (match && parseInt(match[1]) >= 17) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Convert ArrayBuffer to base64 string
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to ArrayBuffer
 * @param {string} b64
 * @returns {ArrayBuffer}
 */
function base64ToBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Generate random challenge for WebAuthn
 * @returns {Uint8Array}
 */
function generateChallenge() {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Generate constant PRF salt for all users
 * Using a constant salt simplifies cross-device flow (no need for userId)
 * Salt: SHA-256('bookish-prf-v1')
 * @returns {Promise<Uint8Array>} - 32-byte constant salt
 */
async function getConstantPRFSalt() {
  const encoder = new TextEncoder();
  const data = encoder.encode('bookish-prf-v1');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash);
}

/**
 * Create a new PRF-enabled passkey credential
 * @param {string} displayName - Display name for the passkey
 * @returns {Promise<{credentialId: string, prfEnabled: boolean, encryptionKey: CryptoKey}>}
 */
export async function createPasskeyWithPRF(displayName = 'Bookish User') {
  if (!isPasskeySupported()) {
    throw new Error('Passkeys are not supported in this browser');
  }

  // Use constant salt for all users (simplifies cross-device flow)
  // Get constant salt (no longer stored in metadata)
  const salt = await getConstantPRFSalt();
  const challenge = generateChallenge();
  // Generate random userId for this credential (not used for salt)
  const userId = crypto.randomUUID();
  const userIdBytes = new TextEncoder().encode(userId);

  const publicKeyOptions = {
    challenge,
    rp: {
      name: RP_NAME,
      id: RP_ID,
    },
    user: {
      id: userIdBytes,
      name: displayName,
      displayName: displayName,
    },
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' },  // ES256
      { alg: -257, type: 'public-key' }, // RS256
    ],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      requireResidentKey: true,
      residentKey: 'required',
      userVerification: 'required',
    },
    timeout: 60000,
    attestation: 'none',
    extensions: {
      prf: {
        eval: { first: salt }  // Enable PRF with deterministic salt
      }
    }
  };

  try {
    const credential = await navigator.credentials.create({
      publicKey: publicKeyOptions,
    });

    if (!credential) {
      throw new Error('Failed to create passkey credential');
    }

    // Check if PRF was successful
    const prfResults = credential.getClientExtensionResults().prf;
    if (!prfResults || !prfResults.enabled) {
      console.warn('PRF extension not supported or failed. This passkey may not work cross-device.');
      throw new Error('PRF extension not supported on this browser');
    }

    // Extract PRF output (32 bytes) - this is our encryption key material
    const prfOutput = new Uint8Array(prfResults.results.first);

    // Import PRF output as AES-256-GCM key directly (no additional HKDF needed)
    //
    // Security Justification:
    // - PRF (hmac-secret) already outputs cryptographically secure 32 bytes via HMAC-SHA-256
    // - W3C WebAuthn spec Section 10.5: PRF output is designed for direct key use
    // - Additional HKDF provides no security benefit per WebAuthn design
    // - Reference: https://w3c.github.io/webauthn/#prf-extension (PRF outputs are key material)
    // - Research validation: "Use PRF output directly as AES-256-GCM key (it's already 32 cryptographically random bytes)"
    const encryptionKey = await crypto.subtle.importKey(
      'raw',
      prfOutput,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );    const credentialId = bufferToBase64(credential.rawId);

    // Store passkey info (salt NOT stored - regenerated from userId each time)
    // Store passkey metadata for future authentication
    const metadata = {
      credentialId: credentialIdB64,
      displayName,
      createdAt: new Date().toISOString(),
      prfEnabled: prfEnabled
    };
    localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(metadata));

    return {
      credentialId: credentialIdB64,
      prfEnabled,
      encryptionKey
    };
  } catch (error) {
    console.error('PRF passkey creation failed:', error);

    // Provide helpful error message for common issues
    if (error.name === 'NotAllowedError') {
      throw new Error('Passkey creation was cancelled or timed out');
    }
    if (error.name === 'NotSupportedError') {
      throw new Error('PRF extension not supported on this browser. Please use Chrome 108+, Edge 108+, or Safari 17+');
    }

    throw new Error(`Failed to create PRF passkey: ${error.message}`);
  }
}

/**
 * Authenticate with PRF-enabled passkey and derive encryption key
 * @returns {Promise<{encryptionKey: CryptoKey, credentialId: string}>}
 */
export async function authenticateWithPRF() {
  if (!isPasskeySupported()) {
    throw new Error('Passkeys are not supported in this browser');
  }

  const passkeyInfoStr = localStorage.getItem(PASSKEY_STORAGE_KEY);
  if (!passkeyInfoStr) {
    throw new Error('No PRF passkey registered. Please create an account first.');
  }

  const passkeyInfo = JSON.parse(passkeyInfoStr);

  if (passkeyInfo.version !== 2 || !passkeyInfo.prfEnabled) {
    throw new Error('Stored passkey is not PRF-enabled (older format. Please create a new account.');
  }

  // Use constant PRF salt (same for all users)
  const salt = await getPRFSalt();

  const challenge = generateChallenge();

  const publicKeyOptions = {
    challenge,
    rpId: RP_ID,
    allowCredentials: [{
      id: base64ToBuffer(passkeyInfo.credentialId),
      type: 'public-key',
      transports: ['internal', 'hybrid'],
    }],
    userVerification: 'required',
    timeout: 60000,
    extensions: {
      prf: {
        eval: { first: salt }  // Use same salt to get same PRF output
      }
    }
  };

  try {
    const assertion = await navigator.credentials.get({
      publicKey: publicKeyOptions,
    });

    if (!assertion) {
      throw new Error('Failed to authenticate with passkey');
    }

    // Extract PRF output
    const prfResults = assertion.getClientExtensionResults().prf;
    if (!prfResults || !prfResults.results || !prfResults.results.first) {
      throw new Error('PRF output not available. This should not happen for a PRF-enabled passkey.');
    }

    const prfOutput = new Uint8Array(prfResults.results.first);

    // Import PRF output as AES-256-GCM key (same security justification as creation)
    // PRF output is cryptographically secure 32 bytes from HMAC-SHA-256, designed for direct key use
    // Set extractable: true so key can be cached in localStorage to avoid re-authentication
    const encryptionKey = await crypto.subtle.importKey(
      'raw',
      prfOutput,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    return {
      encryptionKey,
      credentialId: passkeyInfo.credentialId,
    };
  } catch (error) {
    console.error('PRF authentication failed:', error);

    // Provide helpful error messages
    if (error.name === 'NotAllowedError') {
      throw new Error('Authentication was cancelled or timed out');
    }
    if (error.name === 'AbortError') {
      throw new Error('Authentication was aborted');
    }

    throw new Error(`Failed to authenticate: ${error.message}`);
  }
}

/**
 * Authenticate with any available passkey (cross-device sign-in)
 * Does NOT require local passkey metadata - lets platform show all synced passkeys
 * @returns {Promise<{encryptionKey: CryptoKey, credentialId: string}>}
 */
export async function authenticateWithAnyPRFPasskey() {
  if (!isPasskeySupported()) {
    throw new Error('Passkeys are not supported in this browser');
  }

  // Use constant salt (no userId needed)
  const salt = await getConstantPRFSalt();
  const challenge = generateChallenge();

  const publicKeyOptions = {
    challenge,
    rpId: RP_ID,
    // NO allowCredentials - this lets the platform show ALL available passkeys
    userVerification: 'required',
    timeout: 60000,
    extensions: {
      prf: {
        eval: { first: salt }
      }
    }
  };

  try {
    const assertion = await navigator.credentials.get({
      publicKey: publicKeyOptions,
    });

    if (!assertion) {
      throw new Error('Failed to authenticate with passkey');
    }

    // Extract PRF output
    const prfResults = assertion.getClientExtensionResults().prf;
    if (!prfResults || !prfResults.results || !prfResults.results.first) {
      throw new Error('PRF output not available from this passkey');
    }

    const prfOutput = new Uint8Array(prfResults.results.first);

    // Import PRF output as AES-256-GCM key
    // Set extractable: true so key can be cached in localStorage to avoid re-authentication
    const encryptionKey = await crypto.subtle.importKey(
      'raw',
      prfOutput,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    // Get credential ID from assertion
    const credentialId = bufferToBase64(new Uint8Array(assertion.rawId));

    return {
      encryptionKey,
      credentialId
    };
  } catch (error) {
    console.error('Cross-device PRF authentication failed:', error);

    if (error.name === 'NotAllowedError') {
      throw new Error('Authentication was cancelled or timed out');
    }
    if (error.name === 'AbortError') {
      throw new Error('Authentication was aborted');
    }

    throw new Error(`Failed to authenticate: ${error.message}`);
  }
}

/**
 * Check if a PRF passkey is already registered
 * @returns {boolean}
 */
export function hasPasskey() {
  const info = localStorage.getItem(PASSKEY_STORAGE_KEY);
  if (!info) return false;

  try {
    const parsed = JSON.parse(info);
    return parsed.version === 2 && parsed.prfEnabled === true;
  } catch {
    return false;
  }
}

/**
 * Get stored PRF passkey info (without sensitive data)
 * @returns {Object|null} - Passkey info or null if none exists
 */
export function getPasskeyInfo() {
  const infoStr = localStorage.getItem(PASSKEY_STORAGE_KEY);
  if (!infoStr) return null;

  try {
    const info = JSON.parse(infoStr);
    return {
      version: info.version,
      prfEnabled: info.prfEnabled,
      displayName: info.displayName,
      created: info.created,
      hasCredential: !!info.credentialId,
    };
  } catch {
    return null;
  }
}

/**
 * Clear PRF passkey from storage (use with caution!)
 * @returns {void}
 */
export function clearPasskey() {
  localStorage.removeItem(PASSKEY_STORAGE_KEY);
}

/**
 * Generate a unique user ID for new account creation
 * Uses timestamp + random bytes for uniqueness
 * @returns {string}
 */
export function generateUniqueUserId() {
  const timestamp = Date.now().toString(36);
  const randomBytes = crypto.getRandomValues(new Uint8Array(16));
  const randomStr = bufferToBase64(randomBytes).substring(0, 16);
  return `bookish_${timestamp}_${randomStr}`;
}
