/**
 * config/ module barrel — re-exports the `config.js` implementation and the
 * contract surface from `./contract.js`.
 *
 * Implementation modules (env resolution, validation) live alongside and are
 * added by TSK0002; they must be exported from this barrel.
 */

export * from './config.js';
export * from './contract.js';
