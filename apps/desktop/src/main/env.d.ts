/**
 * Build-time constant (electron-vite `define`): true only in the end-to-end test build
 * (`TERNIX_E2E_BUILD=1`), false in every release build, so the code it guards is removed.
 */
declare const __TERNIX_E2E__: boolean;
