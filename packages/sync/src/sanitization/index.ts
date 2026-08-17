/**
 * sanitization/ module barrel — re-exports the contract surface from `./contract.js`.
 *
 * Implementation modules (json, jsonl, secrets) live alongside and are added
 * by TSK0004; they must be exported from this barrel.
 */
export * from './contract.js';
