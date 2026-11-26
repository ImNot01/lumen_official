let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return null
  audioContext ??= new AudioContext()
  return audioContext
}

export function unlockAudio() {
  const context = getAudioContext()
  if (!context || context.state === 'running') return
  void context.resume().catch((error: unknown) => {
    console.warn('Browser audio playback is unavailable', error)
  })
}

function playTone(frequency: number, duration: number, delay = 0, volume = 0.07) {
  const context = getAudioContext()
  if (!context) return

  const play = () => {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const startAt = context.currentTime + delay
    const endAt = startAt + duration
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(frequency, startAt)
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.025)
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(startAt)
    oscillator.stop(endAt)
  }

  if (context.state === 'running') {
    play()
    return
  }

  void context.resume().then(play).catch((error: unknown) => {
    console.warn('Browser audio playback is unavailable', error)
  })
}

export function playMessageSound() {
  playTone(660, 0.14, 0, 0.055)
  playTone(880, 0.2, 0.09, 0.045)
}

export function startRingtone(callId: string): () => void {
  const lockKey = `lumen:call-sound:${callId}`
  const claim = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    if (localStorage.getItem(lockKey)) return () => undefined
    localStorage.setItem(lockKey, claim)
  } catch (error) {
    console.error('Could not coordinate call sounds between tabs', error)
  }

  let stopped = false
  const ring = () => {
    if (stopped) return
    playTone(494, 0.3, 0, 0.048)
    playTone(587, 0.38, 0.36, 0.048)
    playTone(494, 0.3, 0.8, 0.048)
  }
  ring()
  const timer = window.setInterval(ring, 3600)

  return () => {
    stopped = true
    window.clearInterval(timer)
    try {
      if (localStorage.getItem(lockKey) === claim) localStorage.removeItem(lockKey)
    } catch (error) {
      console.error('Could not clear the call sound marker', error)
    }
  }
}

export function startRingback(callId: string): () => void {
  const lockKey = `lumen:ringback:${callId}`
  const claim = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    if (localStorage.getItem(lockKey)) return () => undefined
    localStorage.setItem(lockKey, claim)
  } catch (error) {
    console.error('Could not coordinate ringback sounds between tabs', error)
  }

  let stopped = false
  const ring = () => {
    if (stopped) return
    playTone(440, 0.62, 0, 0.042)
    playTone(494, 0.62, 0.75, 0.042)
  }
  ring()
  const timer = window.setInterval(ring, 4000)

  return () => {
    stopped = true
    window.clearInterval(timer)
    try {
      if (localStorage.getItem(lockKey) === claim) localStorage.removeItem(lockKey)
    } catch (error) {
      console.error('Could not clear the ringback sound marker', error)
    }
  }
}
