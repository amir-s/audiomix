type GainEvent =
  | { type: "set"; value: number; time: number }
  | { type: "ramp"; value: number; time: number };

class FakeGainParam {
  readonly events: GainEvent[] = [];

  setValueAtTime(value: number, time: number) {
    this.events.push({ type: "set", value, time });
  }

  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ type: "ramp", value, time });
  }
}

class FakeGainNode {
  readonly gain = new FakeGainParam();
  readonly connections: unknown[] = [];

  connect(destination: unknown) {
    this.connections.push(destination);
    return destination;
  }

  disconnect() {}
}

export class FakeAudioBufferSourceNode extends EventTarget {
  buffer: AudioBuffer | null = null;
  readonly connections: unknown[] = [];
  readonly startCalls: Array<{
    duration: number | undefined;
    offset: number | undefined;
    startTime: number;
  }> = [];
  stopCalls = 0;

  connect(destination: unknown) {
    this.connections.push(destination);
    return destination;
  }

  disconnect() {}

  start(startTime: number, offset?: number, duration?: number) {
    this.startCalls.push({ startTime, offset, duration });
  }

  stop() {
    this.stopCalls += 1;
    this.dispatchEvent(new Event("ended"));
  }

  emitEnded() {
    this.dispatchEvent(new Event("ended"));
  }
}

export class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState;
  readonly destination = {};
  readonly createdGainNodes: FakeGainNode[] = [];
  readonly createdSources: FakeAudioBufferSourceNode[] = [];
  readonly decodeCalls: number[] = [];
  readonly bufferDurationSec: number;

  constructor({
    bufferDurationSec = 32,
    state = "suspended",
  }: {
    bufferDurationSec?: number;
    state?: AudioContextState;
  } = {}) {
    this.bufferDurationSec = bufferDurationSec;
    this.state = state;
  }

  advanceTime(seconds: number) {
    this.currentTime += seconds;
  }

  async close() {
    this.state = "closed";
  }

  createBufferSource() {
    const source = new FakeAudioBufferSourceNode();
    this.createdSources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  createGain() {
    const gainNode = new FakeGainNode();
    this.createdGainNodes.push(gainNode);
    return gainNode as unknown as GainNode;
  }

  async decodeAudioData(arrayBuffer: ArrayBuffer) {
    this.decodeCalls.push(arrayBuffer.byteLength);

    return {
      duration: this.bufferDurationSec,
      length: Math.max(1, Math.round(this.bufferDurationSec * 48000)),
      numberOfChannels: 1,
      sampleRate: 48000,
      copyFromChannel() {},
      copyToChannel() {},
      getChannelData() {
        return new Float32Array(1);
      },
    } as unknown as AudioBuffer;
  }

  async resume() {
    this.state = "running";
  }

  async suspend() {
    this.state = "suspended";
  }
}
