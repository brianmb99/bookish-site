// faucet_client.js - Request initial funding from Bookish faucet

// TODO: Update this URL after deploying the Cloudflare Worker
// For initial deployment, use: https://bookish-faucet.YOUR_SUBDOMAIN.workers.dev/fund
// For custom domain: https://faucet.getbookish.app/fund
const FAUCET_URL = 'https://bookish-faucet.YOUR_SUBDOMAIN.workers.dev/fund';

/**
 * Request funding from the Bookish faucet
 * Requires an active passkey session
 *
 * @param {string} walletAddress - User's wallet address
 * @returns {Promise<{success: boolean, txHash?: string, error?: string, code?: string}>}
 */
export async function requestFaucetFunding(walletAddress) {
  // 1. Generate challenge
  const timestamp = Date.now();
  const challenge = `bookish-faucet:${walletAddress.toLowerCase()}:${timestamp}`;

  // 2. Sign challenge with passkey
  // This proves the user has a valid passkey (hard to automate)
  const signature = await signChallengeWithPasskey(challenge);
  if (!signature) {
    return { success: false, error: 'Passkey signature failed' };
  }

  // 3. Get credential ID for tracking
  const { PASSKEY_STORAGE_KEY } = await import('./storage_constants.js');
  const passkeyMeta = localStorage.getItem(PASSKEY_STORAGE_KEY);
  const credentialId = passkeyMeta ? JSON.parse(passkeyMeta).credentialId : null;

  // 4. Request funding
  try {
    const resp = await fetch(FAUCET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: walletAddress.toLowerCase(),
        challenge,
        signature,
        credentialId,
      }),
    });

    const data = await resp.json();

    if (data.success) {
      console.log('[Bookish:Faucet] Funding successful:', data.txHash);
      return { success: true, txHash: data.txHash };
    } else {
      console.warn('[Bookish:Faucet] Funding failed:', data.error);
      return { success: false, error: data.error, code: data.code };
    }
  } catch (err) {
    console.error('[Bookish:Faucet] Request failed:', err);
    return { success: false, error: 'Network error' };
  }
}

/**
 * Sign a challenge string with the user's passkey
 * Returns base64-encoded signature or null on failure
 *
 * @param {string} challenge - Challenge string to sign
 * @returns {Promise<string|null>}
 */
async function signChallengeWithPasskey(challenge) {
  try {
    const challengeBuffer = new TextEncoder().encode(challenge);

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: challengeBuffer,
        timeout: 60000,
        userVerification: 'preferred',
        rpId: window.location.hostname,
      },
    });

    if (!assertion) return null;

    // Return signature as base64
    const sig = assertion.response.signature;
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  } catch (err) {
    console.error('[Bookish:Faucet] Passkey sign failed:', err);
    return null;
  }
}

/**
 * Check if wallet is eligible for faucet funding
 * (Has zero balance and is a passkey account)
 *
 * @returns {Promise<boolean>}
 */
export async function isEligibleForFaucet() {
  // Must be passkey account
  const { PASSKEY_STORAGE_KEY } = await import('./storage_constants.js');
  const passkeyMeta = localStorage.getItem(PASSKEY_STORAGE_KEY);
  if (!passkeyMeta) return false;

  // Must have zero balance
  try {
    const balance = await window.bookishWallet?.getBalance?.();
    if (balance && BigInt(balance) > 0n) return false;
  } catch (err) {
    console.warn('[Bookish:Faucet] Balance check failed:', err);
    // If balance check fails, assume eligible (will be checked server-side)
  }

  return true;
}

