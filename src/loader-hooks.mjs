/**
 * Node module-resolution hooks:
 * maps the Cloudflare-only specifier `cloudflare:sockets` to our Node shim,
 * so the original worker file loads 100% unmodified.
 */
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const socketsShimUrl = pathToFileURL(path.join(here, "shims", "sockets.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:sockets") {
    return { url: socketsShimUrl, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
