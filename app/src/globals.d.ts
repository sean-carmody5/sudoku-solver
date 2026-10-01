/** Short git SHA of the build, injected by vite.config define. */
declare const __BUILD_ID__: string
/** Content hashes of the shipped models (see vite.config.ts). */
declare const __MODEL_VERSIONS__: { cnn: string; detect: string; detectLive: string }
