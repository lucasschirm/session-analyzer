/**
 * config/ module barrel — re-exports the contract surface from `./contract.js`.
 *
 * Implementation modules (env resolution, validation) live alongside and are
 * added by TSK0002; they must be exported from this barrel.
 */
export * from './contract.js';
