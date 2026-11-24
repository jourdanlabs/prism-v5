import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { fractionText } from './rational.js';

export const RECEIPT_SCHEMA = 'omnis.prism.v5';

export function canonicalJson(value) {
  const ancestors = new Set();
  function encode(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isSafeInteger(item)) return JSON.stringify(item);
    if (typeof item === 'bigint') return JSON.stringify(item.toString());
    if (!item || typeof item !== 'object' || ancestors.has(item)) {
      throw new TypeError('Canonical JSON requires acyclic exact JSON data');
    }
    const isArray = Array.isArray(item);
    if (!isArray && ![null, Object.prototype].includes(Object.getPrototypeOf(item))) {
      throw new TypeError('Canonical JSON requires plain records');
    }
    const keys = Reflect.ownKeys(item);
    if (!isArray && keys.some((key) => typeof key !== 'string'
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(item, key), 'value')
        || !Object.getOwnPropertyDescriptor(item, key).enumerable)) {
      throw new TypeError('Canonical JSON requires enumerable data properties');
    }
    if (!isArray && keys.length === 2 && keys.includes('n') && keys.includes('d')
        && typeof item.n === 'bigint' && typeof item.d === 'bigint') {
      return JSON.stringify(fractionText(item));
    }
    ancestors.add(item);
    let result;
    if (isArray) {
      if (keys.length !== item.length + 1) throw new TypeError('Canonical JSON requires dense arrays');
      const values = [];
      for (let i = 0; i < item.length; i++) {
        const property = Object.getOwnPropertyDescriptor(item, String(i));
        if (!property || !Object.hasOwn(property, 'value')) throw new TypeError('Canonical JSON requires dense data arrays');
        values.push(encode(property.value));
      }
      result = '[' + values.join(',') + ']';
    } else {
      result = '{' + keys.sort().map((key) => JSON.stringify(key) + ':' + encode(item[key])).join(',') + '}';
    }
    ancestors.delete(item);
    return result;
  }
  return encode(value);
}

export function toWire(value) { return JSON.parse(canonicalJson(value)); }

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function keyId(publicKey) { return sha256(publicKey.export({ type: 'spki', format: 'der' })); }

export function createReceipt({ operation, input, result }, privateKey) {
  if (typeof operation !== 'string' || operation.length === 0) throw new TypeError('Receipt operation is required');
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Receipts require an Ed25519 private key');
  const body = toWire({ schema: RECEIPT_SCHEMA, operation, keyId: keyId(createPublicKey(key)), input, result });
  const bytes = Buffer.from(canonicalJson(body));
  return { body, sha256: sha256(bytes), signature: sign(null, bytes, key).toString('base64url') };
}

export function verifyReceipt(receipt, pinnedPublicKey) {
  const failed = (code) => ({ status: 'REFUSED', verified: false, code });
  if (!pinnedPublicKey) return failed('PINNED_PUBLIC_KEY_REQUIRED');
  let key;
  try {
    key = pinnedPublicKey.type === 'public' ? pinnedPublicKey : createPublicKey(pinnedPublicKey);
    if (key.asymmetricKeyType !== 'ed25519') return failed('INVALID_PINNED_PUBLIC_KEY');
  } catch {
    return failed('INVALID_PINNED_PUBLIC_KEY');
  }
  try {
    if (!receipt || Object.keys(receipt).length !== 3 || !['body', 'sha256', 'signature'].every((field) => Object.hasOwn(receipt, field))) {
      return failed('INVALID_RECEIPT');
    }
    const { body, sha256: digest, signature } = receipt;
    if (body?.schema !== RECEIPT_SCHEMA || typeof body.operation !== 'string' || !body.operation
        || Object.keys(body).length !== 5 || !['input', 'result', 'keyId'].every((field) => Object.hasOwn(body, field))
        || !/^[a-f0-9]{64}$/.test(digest) || !/^[A-Za-z0-9_-]{86}$/.test(signature)) {
      return failed('INVALID_RECEIPT');
    }
    if (body.keyId !== keyId(key)) return failed('RECEIPT_SIGNER_MISMATCH');
    const bytes = Buffer.from(canonicalJson(body));
    if (sha256(bytes) !== digest) return failed('RECEIPT_DIGEST_MISMATCH');
    const decoded = Buffer.from(signature, 'base64url');
    if (decoded.toString('base64url') !== signature || !verify(null, bytes, key, decoded)) {
      return failed('RECEIPT_SIGNATURE_INVALID');
    }
    return { status: 'VERIFIED', verified: true, keyId: body.keyId, sha256: digest };
  } catch {
    return failed('INVALID_RECEIPT');
  }
}
