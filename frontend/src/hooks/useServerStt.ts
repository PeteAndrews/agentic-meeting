import { API_BASE_URL } from '../config/api'

export type ServerSttMessage =
  | { type: 'ready' }
  | { type: 'partial'; text: string; confidence?: number | null }
  | { type: 'final'; text: string; startMs: number; endMs: number; confidence?: number | null }
  | { type: 'error'; message: string }

export type ServerSttSession = {
  roomName: string
  participantId: string
  role: string
  condition: string
  sttLanguage: string
  sttSendInterim: boolean
}

function resolveWsBase(): string {
  if (API_BASE_URL) {
    return API_BASE_URL.replace(/^http/i, 'ws')
  }
  const loc = window.location
  const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${loc.host}`
}

export function buildServerSttUrl(session: ServerSttSession): string {
  const params = new URLSearchParams({
    roomName: session.roomName,
    participantId: session.participantId,
    role: session.role,
    condition: session.condition,
    sttLanguage: session.sttLanguage,
    sttSendInterim: session.sttSendInterim ? 'true' : 'false',
  })
  return `${resolveWsBase()}/api/stt/stream?${params.toString()}`
}

function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  const targetRate = 16_000
  if (inputRate === targetRate) {
    return input
  }
  const ratio = inputRate / targetRate
  const outLength = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const s0 = input[idx] ?? 0
    const s1 = input[idx + 1] ?? s0
    out[i] = s0 + (s1 - s0) * frac
  }
  return out
}

function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0))
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return out
}

export type ServerSttCallbacks = {
  onReady?: () => void
  onPartial?: (text: string) => void
  onFinal?: (text: string, startMs: number, endMs: number) => void
  onError?: (message: string) => void
  onClose?: () => void
}

export async function startServerStt(
  session: ServerSttSession,
  callbacks: ServerSttCallbacks,
): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  })

  const audioContext = new AudioContext()
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume()
    } catch {
      // Autoplay policies may still leave it suspended until a later gesture.
    }
  }
  const source = sourceNode(audioContext, stream)
  const processor = audioContext.createScriptProcessor(4096, 1, 1)
  const gain = audioContext.createGain()
  gain.gain.value = 0

  const ws = new WebSocket(buildServerSttUrl(session))
  ws.binaryType = 'arraybuffer'

  let closed = false
  let reportedWsError = false

  const cleanup = () => {
    if (closed) return
    closed = true
    try {
      ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'stop' }))
    } catch {
      // ignore
    }
    try {
      ws.close()
    } catch {
      // ignore
    }
    processor.disconnect()
    source.disconnect()
    gain.disconnect()
    void audioContext.close()
    for (const track of stream.getTracks()) {
      track.stop()
    }
    callbacks.onClose?.()
  }

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return
    try {
      const msg = JSON.parse(ev.data) as ServerSttMessage
      if (msg.type === 'ready') {
        callbacks.onReady?.()
      } else if (msg.type === 'partial') {
        callbacks.onPartial?.(msg.text)
      } else if (msg.type === 'final') {
        callbacks.onFinal?.(msg.text, msg.startMs, msg.endMs)
      } else if (msg.type === 'error') {
        callbacks.onError?.(msg.message)
      }
    } catch {
      // ignore malformed messages
    }
  }

  ws.onerror = () => {
    reportedWsError = true
    callbacks.onError?.('STT WebSocket error')
  }

  ws.onclose = (ev) => {
    if (!closed && !reportedWsError && ev.code !== 1000 && ev.code !== 1001) {
      const reason = ev.reason?.trim()
      callbacks.onError?.(
        reason
          ? `STT WebSocket closed (${ev.code}: ${reason})`
          : `STT WebSocket closed (${ev.code})`,
      )
    }
    cleanup()
  }

  processor.onaudioprocess = (event) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return
    const input = event.inputBuffer.getChannelData(0)
    const downsampled = downsampleTo16k(input, audioContext.sampleRate)
    const pcm = floatToInt16(downsampled)
    ws.send(pcm.buffer)
  }

  source.connect(processor)
  processor.connect(gain)
  gain.connect(audioContext.destination)

  return cleanup
}

function sourceNode(context: AudioContext, stream: MediaStream): MediaStreamAudioSourceNode {
  return context.createMediaStreamSource(stream)
}

export function isServerSttSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof WebSocket !== 'undefined'
  )
}
