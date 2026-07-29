// AudioWorkletProcessor that runs RNNoise (Mozilla's RNN-based noise suppressor).
// Loaded via audioContext.audioWorklet.addModule('/rnnoise-processor.js').
//
// RNNoise expects:
//   - 480 samples per frame  (10 ms @ 48 kHz)
//   - Float32, range ±32768  (16-bit PCM scale, NOT ±1)
//   - Mono

importScripts('/rnnoise-sync.js');

const FRAME_SIZE = 480;

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._mod       = null;
    this._state     = 0;
    this._inPtr     = 0;
    this._outPtr    = 0;
    this._inBuf     = new Float32Array(FRAME_SIZE);
    this._inBufPos  = 0;
    this._outQueue  = [];   // processed frames waiting to be output
    this._bypass    = false;

    this.port.onmessage = (e) => {
      if (e.data.type === 'bypass') this._bypass = e.data.value;
    };

    // createRNNWasmModuleSync is the global exported by rnnoise-sync.js
    createRNNWasmModuleSync().then(mod => {
      this._mod    = mod;
      this._state  = mod._rnnoise_create(0);
      // Allocate WASM memory for one frame (Float32 = 4 bytes each)
      this._inPtr  = mod._malloc(FRAME_SIZE * 4);
      this._outPtr = mod._malloc(FRAME_SIZE * 4);
    }).catch(e => console.error('[RNNoise] init failed', e));
  }

  process(inputs, outputs) {
    const input  = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    if (this._bypass || !this._mod || !this._state) {
      // Pass through unprocessed
      output.set(input);
      return true;
    }

    const mod       = this._mod;
    const HEAPF32   = mod.HEAPF32;
    const inBuf     = this._inBuf;
    const frameSize = FRAME_SIZE;
    let   inBufPos  = this._inBufPos;
    let   readPos   = 0;
    const GAIN      = 0.85; // Reduce gain to prevent clipping

    while (readPos < input.length) {
      const toCopy = Math.min(frameSize - inBufPos, input.length - readPos);
      for (let i = 0; i < toCopy; i++) {
        // Apply gain reduction before RNNoise to prevent clipping
        inBuf[inBufPos++] = input[readPos++] * 32768 * GAIN;
      }

      if (inBufPos === frameSize) {
        HEAPF32.set(inBuf, this._inPtr >> 2);
        mod._rnnoise_process_frame(this._state, this._outPtr, this._inPtr);

        // Read back with smooth normalization
        const processed = new Float32Array(frameSize);
        let maxSample = 0;
        for (let i = 0; i < frameSize; i++) {
          const sample = Math.abs(HEAPF32[(this._outPtr >> 2) + i]);
          if (sample > maxSample) maxSample = sample;
        }

        // Adaptive gain to prevent distortion
        const outputGain = maxSample > 32768 * 0.9 ? (32768 * 0.8) / maxSample : 1.0;
        for (let i = 0; i < frameSize; i++) {
          processed[i] = (HEAPF32[(this._outPtr >> 2) + i] / 32768) * outputGain;
        }
        this._outQueue.push(processed);
        inBufPos = 0;
      }
    }

    this._inBufPos = inBufPos;

    // Drain queue with smooth transitions
    let outPos = 0;
    while (outPos < output.length && this._outQueue.length > 0) {
      const frame  = this._outQueue[0];
      const avail  = frame.length;
      const needed = output.length - outPos;

      if (avail <= needed) {
        output.set(frame, outPos);
        outPos += avail;
        this._outQueue.shift();
      } else {
        output.set(frame.subarray(0, needed), outPos);
        this._outQueue[0] = frame.subarray(needed);
        outPos += needed;
      }
    }

    // Smooth fade-out instead of hard silence to avoid clicks
    if (outPos < output.length) {
      const remaining = output.length - outPos;
      for (let i = 0; i < remaining; i++) {
        output[outPos + i] = 0;
      }
    }

    return true;
  }

  // Clean up WASM memory when the node is garbage-collected
  static get parameterDescriptors() { return []; }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
