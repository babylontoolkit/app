/**
 * Asset introspection (SPEC §4.9).
 *
 * The implementation is pure glTF-JSON scanning, so it lives at `~/lib/assets/introspect` where both
 * the server (upload introspection) and the CLIENT (store-asset introspection, §4.9 client GLB unwrap)
 * can use it. This file re-exports it to keep existing server import paths working.
 */
export * from '~/lib/assets/introspect';
