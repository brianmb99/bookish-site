// passkey_mapping.js - Arweave passkey-to-seed mapping operations
// Handles upload/download of Passkey-Seed Mapping entries on Arweave

import { encryptBytes, decryptBytes, bytesToBase64, base64ToBytes } from './crypto_core.js';

/**
 * Upload passkey-to-seed mapping to Arweave
 * @param {string} credentialId - Base64-encoded WebAuthn credential ID
 * @param {string} seed - 12-word BIP39 seed phrase
 * @param {CryptoKey} prfKey - PRF-derived encryption key from passkey
 * @returns {Promise<string>} - Arweave transaction ID
 */
export async function uploadPasskeyMapping(credentialId, seed, prfKey) {
  if (!credentialId || !seed || !prfKey) {
    throw new Error('credentialId, seed, and prfKey are required');
  }

  console.log(`[Bookish:PasskeyMapping] Encrypting seed for credentialId ${credentialId.substring(0, 16)}...`);

  // Encrypt seed with PRF key
  const seedBytes = new TextEncoder().encode(seed);
  const encryptedBytes = await encryptBytes(prfKey, seedBytes);

  // Split encrypted bytes into iv, tag, ciphertext for JSON storage
  const iv = encryptedBytes.slice(0, 12);
  const tag = encryptedBytes.slice(12, 28);
  const ciphertext = encryptedBytes.slice(28);

  const mapping = {
    schema: 'passkey-mapping',
    version: '0.1.0',
    credentialId,
    encryptedSeed: {
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array([...ciphertext, ...tag])) // Combine ct+tag for storage
    }
  };

  const tags = [
    { name: 'App-Name', value: 'Bookish' },
    { name: 'Type', value: 'passkey-mapping' },
    { name: 'Credential-ID', value: credentialId },
    { name: 'Enc', value: 'aes-256-gcm' }
  ];

  console.log(`[Bookish:PasskeyMapping] Uploading mapping for credentialId ${credentialId.substring(0, 16)}...`);

  if (!window.bookishIrys) {
    throw new Error('Irys uploader not initialized');
  }

  try {
    const jsonStr = JSON.stringify(mapping);
    const jsonBytes = new TextEncoder().encode(jsonStr);
    const result = await window.bookishIrys.upload(jsonBytes, tags);

    console.log(`[Bookish:PasskeyMapping] Mapping uploaded: ${result.id}`);
    return result.id;
  } catch (error) {
    console.error('[Bookish:PasskeyMapping] Upload failed:', error);
    throw new Error(`Failed to upload passkey mapping: ${error.message}`);
  }
}

/**
 * Query Arweave for encrypted seed using credentialId and decrypt it
 * @param {string} credentialId - Base64-encoded WebAuthn credential ID
 * @param {CryptoKey} prfKey - PRF-derived decryption key from passkey
 * @returns {Promise<string|null>} - Decrypted seed phrase or null if not found
 */
export async function getSeedByCredentialId(credentialId, prfKey) {
  if (!credentialId || !prfKey) {
    throw new Error('credentialId and prfKey are required');
  }

  console.log(`[Bookish:PasskeyMapping] Querying mapping for credentialId ${credentialId.substring(0, 16)}...`);

  const query = `query {
    transactions(
      tags: [
        {name: "App-Name", values: ["Bookish"]},
        {name: "Type", values: ["passkey-mapping"]},
        {name: "Credential-ID", values: ["${credentialId}"]}
      ],
      first: 1,
      sort: HEIGHT_DESC
    ) {
      edges {
        node {
          id
        }
      }
    }
  }`;

  try {
    const response = await fetch('https://arweave.net/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });

    const result = await response.json();
    const edges = result.data?.transactions?.edges || [];

    if (edges.length === 0) {
      console.log('[Bookish:PasskeyMapping] No mapping found');
      return null;
    }

    const txId = edges[0].node.id;
    console.log(`[Bookish:PasskeyMapping] Found mapping: ${txId}, downloading...`);

    // Download full transaction data (JSON)
    const dataResponse = await fetch(`https://arweave.net/${txId}`);
    if (!dataResponse.ok) {
      throw new Error(`Failed to download mapping: ${dataResponse.status}`);
    }

    const mapping = await dataResponse.json();
    console.log('[Bookish:PasskeyMapping] Downloaded mapping, decrypting seed...');

    // Reconstruct encrypted bytes from stored format
    const iv = base64ToBytes(mapping.encryptedSeed.iv);
    const ctWithTag = base64ToBytes(mapping.encryptedSeed.ciphertext);

    // Split back into ciphertext and tag
    const tag = ctWithTag.slice(ctWithTag.length - 16);
    const ct = ctWithTag.slice(0, ctWithTag.length - 16);

    // Reconstruct full encrypted bytes: iv(12) | tag(16) | ciphertext
    const encryptedBytes = new Uint8Array(12 + 16 + ct.length);
    encryptedBytes.set(iv, 0);
    encryptedBytes.set(tag, 12);
    encryptedBytes.set(ct, 28);

    // Decrypt seed
    const seedBytes = await decryptBytes(prfKey, encryptedBytes);
    const seed = new TextDecoder().decode(seedBytes);

    console.log('[Bookish:PasskeyMapping] Seed decrypted successfully');
    return seed;
  } catch (error) {
    console.error('[Bookish:PasskeyMapping] Query/decrypt failed:', error);
    throw new Error(`Failed to retrieve seed from passkey mapping: ${error.message}`);
  }
}

/**
 * Check if a passkey mapping exists for the given credentialId
 * @param {string} credentialId - Base64-encoded WebAuthn credential ID
 * @returns {Promise<boolean>}
 */
export async function passkeyMappingExists(credentialId) {
  if (!credentialId) {
    return false;
  }

  const query = `query {
    transactions(
      tags: [
        {name: "App-Name", values: ["Bookish"]},
        {name: "Type", values: ["passkey-mapping"]},
        {name: "Credential-ID", values: ["${credentialId}"]}
      ],
      first: 1
    ) {
      edges {
        node {
          id
        }
      }
    }
  }`;

  try {
    const response = await fetch('https://arweave.net/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });

    const result = await response.json();
    return (result.data?.transactions?.edges || []).length > 0;
  } catch (error) {
    console.error('[Bookish:PasskeyMapping] Existence check failed:', error);
    return false;
  }
}
