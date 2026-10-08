// Byte transports: Web Serial (recommended), WebUSB (raw CDC bulk) and a base with a read queue.

export type TraceFn = (dir: "tx" | "rx", bytes: Uint8Array) => void;

export abstract class LinkBase {
  kind = "link";
  closed = false;
  trace: TraceFn | null = null;
  onClose: (() => void) | null = null;
  private buf = new Uint8Array(0);
  private waiters: (() => void)[] = [];

  push(chunk: Uint8Array): void {
    this.trace?.("rx", chunk);
    const n = new Uint8Array(this.buf.length + chunk.length);
    n.set(this.buf);
    n.set(chunk, this.buf.length);
    this.buf = n;
    this.wake();
  }

  protected wake(): void {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  protected markClosed(): void {
    if (!this.closed) { this.closed = true; this.onClose?.(); }
    this.wake();
  }

  flush(): void { this.buf = new Uint8Array(0); }
  get pending(): number { return this.buf.length; }

  async read(n: number, timeout = 3000): Promise<Uint8Array> {
    const t0 = Date.now();
    while (this.buf.length < n) {
      if (this.closed) throw new Error("The device was disconnected.");
      const left = timeout - (Date.now() - t0);
      if (left <= 0) throw new Error(`No reply from the device (expected ${n} bytes, got ${this.buf.length}).`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => { clearTimeout(t); r(); });
      });
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  async send(bytes: Uint8Array): Promise<void> {
    this.trace?.("tx", bytes);
    return this.write(bytes);
  }

  protected abstract write(bytes: Uint8Array): Promise<void>;
  abstract close(): Promise<void>;
}

/** Web Serial — works on macOS, Windows, Linux (Chromium browsers). */
export class SerialLink extends LinkBase {
  kind = "Web Serial";
  private port!: SerialPort;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;

  async open(port: SerialPort): Promise<void> {
    this.port = port;
    await port.open({ baudRate: 115200, bufferSize: 65536 }); // baud is ignored by USB CDC
    this.writer = port.writable!.getWriter();
    this.reader = port.readable!.getReader();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this.push(value);
        }
      } catch { /* port lost */ }
      this.markClosed();
    })();
  }

  protected async write(bytes: Uint8Array): Promise<void> { await this.writer.write(bytes); }

  async close(): Promise<void> {
    this.closed = true;
    try { await this.reader.cancel(); } catch { /* ignore */ }
    try { this.reader.releaseLock(); } catch { /* ignore */ }
    try { this.writer.releaseLock(); } catch { /* ignore */ }
    try { await this.port.close(); } catch { /* ignore */ }
  }
}

/** WebUSB — raw CDC-ACM bulk endpoints. Fails on macOS (kernel owns the interface). */
export class UsbLink extends LinkBase {
  kind = "WebUSB";
  private dev!: USBDevice;
  private epIn = 0;
  private epOut = 0;

  async open(dev: USBDevice): Promise<void> {
    this.dev = dev;
    await dev.open();
    if (!dev.configuration) await dev.selectConfiguration(1);
    let data: USBInterface | null = null, ctrl: USBInterface | null = null;
    for (const itf of dev.configuration!.interfaces) {
      const a = itf.alternates[0];
      if (a.interfaceClass === 0x02 && !ctrl) ctrl = itf;
      const bulkIn = a.endpoints.some((e) => e.type === "bulk" && e.direction === "in");
      const bulkOut = a.endpoints.some((e) => e.type === "bulk" && e.direction === "out");
      if (!data && bulkIn && bulkOut && (a.interfaceClass === 0x0a || a.interfaceClass === 0xff)) data = itf;
    }
    if (!data) throw new Error("This device has no USB serial data interface.");
    if (ctrl) { try { await dev.claimInterface(ctrl.interfaceNumber); } catch { /* optional */ } }
    try { await dev.claimInterface(data.interfaceNumber); }
    catch { throw new Error("WebUSB couldn't claim the device: the operating system's serial driver owns it. Use Web Serial instead."); }
    const eps = data.alternates[0].endpoints;
    this.epIn = eps.find((e) => e.direction === "in" && e.type === "bulk")!.endpointNumber;
    this.epOut = eps.find((e) => e.direction === "out" && e.type === "bulk")!.endpointNumber;
    if (ctrl) {
      try {
        await dev.controlTransferOut({ requestType: "class", recipient: "interface", request: 0x20, value: 0, index: ctrl.interfaceNumber }, new Uint8Array([0x00, 0xc2, 0x01, 0x00, 0, 0, 8]));
        await dev.controlTransferOut({ requestType: "class", recipient: "interface", request: 0x22, value: 3, index: ctrl.interfaceNumber });
      } catch { /* optional */ }
    }
    void (async () => {
      while (!this.closed) {
        try {
          const r = await dev.transferIn(this.epIn, 4096);
          if (r.data && r.data.byteLength) this.push(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
        } catch { break; }
      }
      this.markClosed();
    })();
  }

  protected async write(bytes: Uint8Array): Promise<void> { await this.dev.transferOut(this.epOut, bytes as BufferSource); }
  async close(): Promise<void> { this.closed = true; try { await this.dev.close(); } catch { /* ignore */ } }
}

/**
 * WebUSB — vendor-specific interface with bulk endpoints (LibreVNA: EP 0x01 OUT data, 0x81 IN data, 0x82 IN firmware log).
 * The first bulk-IN endpoint carries data; an optional second one is the log and goes to `onLog`.
 */
export class WebUsbBulkLink extends LinkBase {
  kind = "WebUSB";
  /** Optional sink for the log endpoint (text from the firmware). */
  onLog: ((bytes: Uint8Array) => void) | null = null;
  private dev!: USBDevice;
  private epOut = 1;
  private itf = -1;

  async open(dev: USBDevice): Promise<void> {
    this.dev = dev;
    await dev.open();
    if (!dev.configuration) await dev.selectConfiguration(1);
    const found = dev.configuration!.interfaces.find((i) => {
      const a = i.alternates[0];
      return a.interfaceClass === 0xff && a.endpoints.some((e) => e.type === "bulk" && e.direction === "in") && a.endpoints.some((e) => e.type === "bulk" && e.direction === "out");
    });
    if (!found) throw new Error("This device has no vendor-specific USB bulk interface.");
    try { await dev.claimInterface(found.interfaceNumber); }
    catch { throw new Error("WebUSB couldn't claim the device: another program or driver owns it."); }
    this.itf = found.interfaceNumber;
    const eps = found.alternates[0].endpoints.filter((e) => e.type === "bulk");
    const ins = eps.filter((e) => e.direction === "in").map((e) => e.endpointNumber).sort((a, b) => a - b);
    this.epOut = eps.find((e) => e.direction === "out")!.endpointNumber;
    const pump = async (ep: number, sink: (b: Uint8Array) => void) => {
      while (!this.closed) {
        try {
          const r = await dev.transferIn(ep, 4096);
          if (r.data && r.data.byteLength) sink(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
        } catch { break; }
      }
      this.markClosed();
    };
    void pump(ins[0], (b) => this.push(b));
    if (ins[1] !== undefined) void pump(ins[1], (b) => this.onLog?.(b));
  }

  protected async write(bytes: Uint8Array): Promise<void> { await this.dev.transferOut(this.epOut, bytes as BufferSource); }
  async close(): Promise<void> {
    this.closed = true;
    try { await this.dev.releaseInterface(this.itf); } catch { /* ignore */ }
    try { await this.dev.close(); } catch { /* ignore */ }
  }
}
