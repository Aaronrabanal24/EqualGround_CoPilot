// AudioWorklet processors for real-time audio capture
// Runs on a dedicated audio rendering thread (off main thread)

class MonoAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    this._chunkSize = 4000; // ~250ms at 16kHz
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];

    // Append to buffer
    const newBuffer = new Float32Array(this._buffer.length + channelData.length);
    newBuffer.set(this._buffer);
    newBuffer.set(channelData, this._buffer.length);
    this._buffer = newBuffer;

    while (this._buffer.length >= this._chunkSize) {
      const chunk = this._buffer.slice(0, this._chunkSize);
      this._buffer = this._buffer.slice(this._chunkSize);

      // Convert Float32 to Int16 for Deepgram
      const int16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }
    return true;
  }
}

class StereoAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._leftBuffer = new Float32Array(0);
    this._rightBuffer = new Float32Array(0);
    this._chunkSize = 4000; // ~250ms at 16kHz per channel
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const left = input[0];   // mic (rep)
    const right = input[1] || left; // system (prospect), fallback to left if mono

    // Append to buffers
    const newLeft = new Float32Array(this._leftBuffer.length + left.length);
    newLeft.set(this._leftBuffer);
    newLeft.set(left, this._leftBuffer.length);
    this._leftBuffer = newLeft;

    const newRight = new Float32Array(this._rightBuffer.length + right.length);
    newRight.set(this._rightBuffer);
    newRight.set(right, this._rightBuffer.length);
    this._rightBuffer = newRight;

    while (this._leftBuffer.length >= this._chunkSize && this._rightBuffer.length >= this._chunkSize) {
      const leftChunk = this._leftBuffer.slice(0, this._chunkSize);
      this._leftBuffer = this._leftBuffer.slice(this._chunkSize);
      const rightChunk = this._rightBuffer.slice(0, this._chunkSize);
      this._rightBuffer = this._rightBuffer.slice(this._chunkSize);

      // Interleave into stereo Int16: [L0, R0, L1, R1, ...]
      const interleaved = new Int16Array(leftChunk.length * 2);
      for (let i = 0; i < leftChunk.length; i++) {
        const lSample = Math.max(-1, Math.min(1, leftChunk[i]));
        const rSample = Math.max(-1, Math.min(1, rightChunk[i]));
        interleaved[i * 2] = lSample < 0 ? lSample * 0x8000 : lSample * 0x7fff;
        interleaved[i * 2 + 1] = rSample < 0 ? rSample * 0x8000 : rSample * 0x7fff;
      }
      this.port.postMessage(interleaved.buffer, [interleaved.buffer]);
    }
    return true;
  }
}

registerProcessor("mono-audio-processor", MonoAudioProcessor);
registerProcessor("stereo-audio-processor", StereoAudioProcessor);
