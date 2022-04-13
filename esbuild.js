const esbuild = require("esbuild");

const { NodeModulesPolyfillPlugin } = require('@esbuild-plugins/node-modules-polyfill');
const { NodeGlobalsPolyfillPlugin } = require('@esbuild-plugins/node-globals-polyfill');

esbuild
    .build({
        entryPoints: [
            "./src/background.ts",
        ],
        bundle: true,
        sourcemap: true,
        outdir: "./public/build",
        watch: !!process.env.DEV_MODE,
        external: ['brotli-wasm'],
        plugins: [
            NodeModulesPolyfillPlugin(),
            NodeGlobalsPolyfillPlugin({
                process: true,
                buffer: true
            })
        ]
    })
    .catch(() => process.exit(1));