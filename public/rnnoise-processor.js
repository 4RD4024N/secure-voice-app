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

    while (readPos < input.length) {
      // Fill our accumulation buffer sample-by-sample
      const toCopy = Math.min(frameSize - inBufPos, input.length - readPos);
      for (let i = 0; i < toCopy; i++) {
        // RNNoise works in ±32768 scale
        inBuf[inBufPos++] = input[readPos++] * 32768;
      }

      if (inBufPos === frameSize) {
        // Write into WASM heap
        HEAPF32.set(inBuf, this._inPtr >> 2);

        // Process — returns VAD probability (not used here)
        mod._rnnoise_process_frame(this._state, this._outPtr, this._inPtr);

        // Read back and convert to ±1
        const processed = new Float32Array(frameSize);
        for (let i = 0; i < frameSize; i++) {
          processed[i] = HEAPF32[(this._outPtr >> 2) + i] / 32768;
        }
        this._outQueue.push(processed);
        inBufPos = 0;
      }
    }

    this._inBufPos = inBufPos;

    // Drain the queue into the output buffer
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

    // If queue was empty (startup latency), output silence
    if (outPos < output.length) output.fill(0, outPos);

    return true;
  }

  // Clean up WASM memory when the node is garbage-collected
  static get parameterDescriptors() { return []; }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
