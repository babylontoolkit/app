/**
 * GLB container parsing (SPEC §4.9).
 *
 * The implementation is pure (DataView / TextDecoder / JSON only), so it lives at `~/lib/assets/glb`
 * where BOTH the server (upload validation + introspection) and the CLIENT (store-asset introspection,
 * §4.9 client GLB unwrap) can reach it — a `.server` module cannot be imported from the browser. This
 * file re-exports it so existing server import paths (`~/lib/.server/assets/glb`) keep working.
 */
export * from '~/lib/assets/glb';
