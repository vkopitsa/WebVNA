// Protocol detection and driver factory for the two USB-CDC device families.
import type { VnaDriver } from "./driver";
import type { LinkBase } from "./links";
import { LiteVNA, sleep } from "./litevna";
import { NanoVNAShell } from "./nanovna";

export type Protocol = "v2" | "v1-shell"; // LibreVNA is chosen by USB id (WebUSB), never probed

/**
 * Probe with the V2 handshake: 8×NOP (0x00) + INDICATE (0x0d).
 *  - V2 / LiteVNA: NOPs are ignored and INDICATE answers a single byte '2'.
 *  - NanoVNA shell: 0x00 is ignored (not echoed, empty command line) and 0x0d is a plain carriage return,
 *    i.e. an empty command, which the shell answers with "\r\nch> ". Nothing harmful reaches either device.
 * A power-on banner or half-typed line is flushed by a second bare "\r".
 */
export async function detectProtocol(link: LinkBase): Promise<Protocol> {
  const probes = [Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0x0d]), Uint8Array.of(0x0d)];
  for (const probe of probes) {
    link.flush();
    await link.send(probe);
    let reply = new Uint8Array(0);
    try {
      const first = await link.read(1, 1500);
      await sleep(100); // let the rest of a prompt arrive
      const rest = link.pending ? await link.read(link.pending) : new Uint8Array(0);
      reply = Uint8Array.from([...first, ...rest]);
    } catch { /* silence */ }
    link.flush();
    if (reply.length === 1 && reply[0] === 0x32) return "v2";
    if (new TextDecoder("latin1").decode(reply).includes("ch>")) return "v1-shell";
  }
  throw new Error("The device answered neither as a LiteVNA / NanoVNA V2 nor as a NanoVNA V1 / -H / -H4.");
}

/** Pick the driver for whatever is on the other end of the link (call init() on the result). */
export async function createDriver(link: LinkBase): Promise<VnaDriver> {
  return (await detectProtocol(link)) === "v2" ? new LiteVNA(link) : new NanoVNAShell(link);
}
