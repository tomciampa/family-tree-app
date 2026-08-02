// Wrangler (v3.15+) bundles a statically-imported .wasm file as an
// already-compiled WebAssembly.Module — this just tells tsc what that
// import actually resolves to, since .wasm isn't a real JS/TS module
// type on its own.
//
// This file must actually be reachable from tsconfig.json's "include"
// (fixed there alongside this file, from ["email-intake.ts"] to
// ["*.ts", "*.d.ts"]) — a pure ambient .d.ts that nothing ever imports
// only gets loaded if it's in the project's root file set, not just by
// existing on disk. Missing that was the real cause of a genuinely
// confusing symptom while building this: two of these four .wasm
// imports (@jsquash/png, @jsquash/resize) type-checked fine even before
// this file was included, while the other two (@jsquash/jpeg's
// decode/encode) failed with "Cannot find module" — an inconsistency
// that turned out to be incidental (tsc's fallback behavior for an
// unrecognized extension differs depending on whether a same-basename
// sibling .d.ts happens to exist, which mozjpeg_dec/mozjpeg_enc have and
// the other two don't), not a real per-package difference. Once this
// file is actually part of the compile, all four resolve identically
// through the declarations below and the incidental difference stops
// mattering.
declare module "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
declare module "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
declare module "@jsquash/png/codec/pkg/squoosh_png_bg.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
declare module "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
declare module "libheif-js/libheif-wasm/libheif.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
