/**
 * RemoteLogger — Buffers print() output and sends to voice proxy server.
 *
 * Usage:
 *   import { RemoteLogger, rlog } from "../Utils/RemoteLogger"
 *   rlog("message")  // prints + buffers
 *   RemoteLogger.instance.setSocket(ws)  // flushes to server
 */

import { setTimeout } from "SpectaclesInteractionKit.lspkg/Utils/FunctionTimingUtils"

let _inst: RemoteLogger

export class RemoteLogger {
  private buf: string[] = []
  private ws: any = null
  private t0: number = Date.now()
  private tid: any = null

  static get instance(): RemoteLogger {
    if (!_inst) {
      _inst = new RemoteLogger()
    }
    return _inst
  }

  log(msg: string): void {
    print(msg)
    const t = ((Date.now() - this.t0) / 1000).toFixed(3)
    this.buf.push("[" + t + "] " + msg)
    if (this.buf.length > 2000) {
      this.buf.shift()
    }
  }

  setSocket(socket: any): void {
    this.ws = socket
    if (socket) {
      this.log("[RemoteLogger] Socket attached (" + this.buf.length + " buffered)")
      this.flush()
      this.startFlush()
    } else {
      this.tid = null
    }
  }

  flush(): void {
    if (!this.ws || this.buf.length === 0) return
    try {
      const lines = this.buf
      this.buf = []
      this.ws.send(JSON.stringify({ type: "client.log", lines: lines }))
    } catch (_e) {
      // ignore
    }
  }

  flushSync(): void {
    this.flush()
  }

  private startFlush(): void {
    this.tid = null
    const tick = (): void => {
      this.flush()
      if (this.ws) {
        this.tid = setTimeout(() => tick(), 2000)
      }
    }
    this.tid = setTimeout(() => tick(), 2000)
  }
}

export function rlog(msg: string): void {
  RemoteLogger.instance.log(msg)
}
