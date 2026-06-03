// Records microphone audio and encodes it as a 16 kHz mono 16-bit PCM WAV blob.
// We encode WAV ourselves (rather than using MediaRecorder, which emits webm/opus)
// because whisper.cpp's server expects WAV audio.

const TARGET_SAMPLE_RATE = 16000;

export class WavRecorder {
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private processor?: ScriptProcessorNode;
  private chunks: Float32Array[] = [];
  private sourceSampleRate = TARGET_SAMPLE_RATE;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.ctx = new AudioContext();
    this.sourceSampleRate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessorNode is deprecated but universally supported and simplest
    // for grabbing raw PCM frames.
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    this.processor.onaudioprocess = (event) => {
      // Copy the frame; the underlying buffer is reused by the audio thread.
      this.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    this.source.connect(this.processor);
    // The processor must be connected to the destination to run. We never write
    // to its output buffer, so it emits silence (no mic feedback).
    this.processor.connect(this.ctx.destination);
  }

  /** Stop recording and return the captured audio as a WAV blob. */
  async stop(): Promise<Blob> {
    this.teardown();
    const samples = downsample(flatten(this.chunks), this.sourceSampleRate, TARGET_SAMPLE_RATE);
    this.chunks = [];
    return encodeWav(samples, TARGET_SAMPLE_RATE);
  }

  /** Abort recording and release the microphone without producing a blob. */
  cancel(): void {
    this.teardown();
    this.chunks = [];
  }

  private teardown(): void {
    try { this.processor?.disconnect(); } catch { /* noop */ }
    try { this.source?.disconnect(); } catch { /* noop */ }
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.ctx?.close().catch(() => undefined);
    this.processor = undefined;
    this.source = undefined;
    this.stream = undefined;
    this.ctx = undefined;
  }
}

function flatten(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (toRate >= fromRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    // Average the source window mapped to this output sample to avoid aliasing.
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) { sum += input[j]; count++; }
    output[i] = count > 0 ? sum / count : input[start] ?? 0;
  }
  return output;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: 'audio/wav' });
}
