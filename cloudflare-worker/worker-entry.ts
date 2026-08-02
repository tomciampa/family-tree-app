// The real Wrangler entrypoint (see wrangler.toml's `main`). Its only job
// is the Workers-specific WASM bootstrap — static .wasm imports, which
// Wrangler's bundler resolves into already-compiled WebAssembly.Module
// objects, but which cannot be imported outside that bundler at all (not
// even by plain Node — confirmed by trying). Deliberately kept separate
// from email-intake.ts's actual handling logic so that logic stays
// testable directly in Node against real parsed emails and a real local
// webhook — only this file's WASM wiring is unverified until a real
// `wrangler dev`/`deploy` actually runs it.
import jpegDecWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
import jpegEncWasm from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm";
import pngDecWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import resizeWasm from "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm";
import heicDecWasm from "libheif-js/libheif-wasm/libheif.wasm";
import { initCodecs } from "./image-compression";
import { handleEmail, type Env } from "./email-intake";

const codecsReady = initCodecs({
  jpegDecode: jpegDecWasm,
  jpegEncode: jpegEncWasm,
  pngDecode: pngDecWasm,
  resize: resizeWasm,
  heicDecode: heicDecWasm,
});

const worker = {
  async email(message: ForwardableEmailMessage, env: Env) {
    await codecsReady;
    return handleEmail(message, env);
  },
};

export default worker;
