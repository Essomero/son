import type { PipecatClientOptions } from "@pipecat-ai/client-js";

/**
 * Mic-only MediaManager for SmallWebRTCTransport.
 *
 * client-js's transports default to Daily's media manager, which fetches
 * https://c.daily.co/.../call-machine-object-bundle.js and evaluates it. A
 * Manifest V3 extension page runs under `script-src 'self'` — no remote
 * scripts, no eval, and Chrome does not let a manifest relax either — so the
 * default manager dies with "Failed to load call object bundle" *before* the
 * /start request is ever sent. The transport takes a `mediaManager` option, so
 * this replaces exactly that layer with what the panel actually needs:
 * getUserMedia for the mic, device enumeration, track-level mute.
 *
 * Video and screen share report unsupported rather than being stubbed, so the
 * transport never negotiates transceivers for them.
 *
 * Structurally typed against the transport's MediaManager (it ships bundled,
 * not as its own package): the transport reads tracks(), the enable/is* flags,
 * the device lists and the selected-device getters — nothing else.
 */
export class MicMediaManager {
  readonly supportsScreenShare = false;

  private stream: MediaStream | null = null;
  private micEnabled = true;
  private deviceId: string | undefined;
  private devices: MediaDeviceInfo[] = [];
  /** Sessions whose STT runs in the panel (browser Web Speech) carry no audio
   *  at all: opening the mic would only put a track on the wire that the server
   *  has no VAD or STT to read, and the transport would negotiate an audio
   *  sender for nothing. */
  private readonly capture: boolean;

  constructor(options: { capture?: boolean } = {}) {
    this.capture = options.capture ?? true;
  }

  get isMicEnabled(): boolean {
    return this.micEnabled;
  }

  get isCamEnabled(): boolean {
    return false;
  }

  get isSharingScreen(): boolean {
    return false;
  }

  get selectedMic(): MediaDeviceInfo | Record<string, never> {
    return this.devices.find((device) => device.deviceId === this.deviceId) ?? {};
  }

  get selectedCam(): Record<string, never> {
    return {};
  }

  get selectedSpeaker(): Record<string, never> {
    return {};
  }

  /** client-js assigns the panel's options here before anything else — the
   *  mic's initial enabled state rides options.enableMic. */
  setClientOptions(options: PipecatClientOptions, override = false): void {
    if (this.devices.length && !override) return;
    this.micEnabled = options.enableMic ?? true;
  }

  /** Device labels are only meaningful once permission is granted, but
   *  enumerateDevices also surfaces mics the user has used elsewhere, which is
   *  what getAllMics() reports. The mic itself is opened in connect(), so a
   *  session that never starts never holds the device. */
  async initialize(): Promise<void> {
    try {
      this.devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      this.devices = [];
    }
  }

  async connect(): Promise<void> {
    // No capture: leave the device closed. tracks() then reports no audio, so
    // the transport sends none.
    if (!this.capture) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
        // The server does denoise + AGC of its own (audio_filters.py); leaving
        // the browser's defaults on would stack two noise gates and two gain
        // stages, and the browser's own gate is the one that eats soft speech.
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.applyMicEnabled();
  }

  async disconnect(): Promise<void> {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  tracks(): { local: { audio?: MediaStreamTrack } } {
    return { local: { audio: this.stream?.getAudioTracks()[0] } };
  }

  enableMic(enable: boolean): void {
    this.micEnabled = enable;
    this.applyMicEnabled();
  }

  /** Video is not offered in this panel: the interface requires the method,
   *  the transport never calls it here (isCamEnabled is false). */
  enableCam(_enable: boolean): void {}

  enableScreenShare(_enable: boolean): void {}

  /** Switching the input device mid-session needs the transport to
   *  replaceTrack on its sender, which this manager has no handle on. The
   *  panel does not offer device picking, so record the choice — it applies to
   *  the next connect() — instead of silently doing nothing now. */
  updateMic(deviceId: string): void {
    this.deviceId = deviceId;
  }

  updateCam(_id: string): void {}

  updateSpeaker(_id: string): void {}

  getAllMics(): Promise<MediaDeviceInfo[]> {
    return this.devicesOfKind("audioinput");
  }

  getAllCams(): Promise<MediaDeviceInfo[]> {
    return this.devicesOfKind("videoinput");
  }

  getAllSpeakers(): Promise<MediaDeviceInfo[]> {
    return this.devicesOfKind("audiooutput");
  }

  private async devicesOfKind(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
    this.devices = await navigator.mediaDevices.enumerateDevices();
    return this.devices.filter((device) => device.kind === kind);
  }

  private applyMicEnabled(): void {
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = this.micEnabled;
    });
  }
}
