import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { uuid } from '../lib/chat'
import { useAuth } from './AuthContext'
import { useRealtime } from './RealtimeContext'
import { Avatar } from '../components/Avatar'
import { startRingtone } from '../lib/sounds'

type CallStatus = 'ringing' | 'connecting' | 'connected' | 'failed'
type CallInfo = {
  id: string
  conversationId: string
  peerId: string
  peerName: string
  peerAvatar: string | null
  video: boolean
  direction: 'incoming' | 'outgoing'
  status: CallStatus
  error?: string
}
type SignalType = 'offer' | 'answer' | 'candidate' | 'hangup' | 'decline' | 'busy'
type Signal = {
  type: SignalType
  call_id: string
  conversation_id: string
  from: string
  to: string
  peer_name?: string
  video?: boolean
  peer_avatar?: string
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}
type CallsState = {
  call: CallInfo | null
  micMuted: boolean
  deafened: boolean
  startCall: (conversationId: string, peerId: string, peerName: string, video: boolean, peerAvatar?: string | null) => Promise<void>
  acceptCall: () => Promise<void>
  declineCall: () => Promise<void>
  endCall: () => Promise<void>
  toggleMic: () => void
  toggleDeafen: () => void
  toggleVideo: () => void
  dismissError: () => void
}

const Ctx = createContext<CallsState | null>(null)

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
  const urls = import.meta.env.VITE_TURN_URLS?.split(',').map((url: string) => url.trim()).filter(Boolean)
  if (urls?.length) {
    servers.push({
      urls,
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL,
    })
  }
  return servers
}

function formatCallDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function mediaErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Camera or microphone access was denied. Allow access in browser settings and try again.'
    if (error.name === 'NotFoundError') return 'No camera or microphone was found on this device.'
    if (error.name === 'NotReadableError') return 'Your camera or microphone is busy in another app.'
  }
  return error instanceof Error ? error.message : 'Could not start the call.'
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { session, profile } = useAuth()
  const me = session?.user.id ?? ''
  const rt = useRealtime()
  const [call, setCall] = useState<CallInfo | null>(null)
  const [micMuted, setMicMuted] = useState(false)
  const [deafened, setDeafened] = useState(false)
  const [videoEnabled, setVideoEnabled] = useState(true)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteAudioMuted, setRemoteAudioMuted] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const callRef = useRef<CallInfo | null>(null)
  const offerRef = useRef<RTCSessionDescriptionInit | null>(null)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const localRef = useRef<MediaStream | null>(null)
  const remoteIceQueue = useRef<RTCIceCandidateInit[]>([])
  const pendingLocalIce = useRef<RTCIceCandidateInit[]>([])
  const sendLocalIceRef = useRef(false)
  const ringTimerRef = useRef<number | undefined>(undefined)
  const disconnectTimerRef = useRef<number | undefined>(undefined)
  const connectedRef = useRef(false)
  const connectedSinceRef = useRef<number | null>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const remoteAudioRef = useRef<HTMLAudioElement>(null)

  const logCall = useCallback(async (active: CallInfo, result: 'completed' | 'missed' | 'cancelled' | 'failed', duration = 0) => {
    if (active.direction !== 'outgoing') return
    const kind = active.video ? 'Video' : 'Audio'
    const body = result === 'completed'
      ? `${kind} call · ${formatCallDuration(duration)}`
      : result === 'missed'
        ? `Missed ${kind.toLowerCase()} call`
        : `${kind} call · ${result === 'cancelled' ? 'Cancelled' : 'Failed'}`
    try {
      const { data, error } = await supabase.from('messages').insert({
        conversation_id: active.conversationId,
        sender_id: me,
        kind: 'system',
        body,
        client_id: active.id,
      }).select('*').single()
      if (error && error.code !== '23505') {
        console.error('Unable to add the call to chat history', error.message)
      } else if (data) {
        rt.dispatch('message', { op: 'INSERT', record: data })
      }
    } catch (error) {
      console.error('Unable to add the call to chat history', error)
    }
  }, [me, rt.dispatch])

  const updateCall = useCallback((next: CallInfo | null) => {
    callRef.current = next
    setCall(next)
  }, [])
  const isCurrentCall = useCallback((id: string) => callRef.current?.id === id, [])

  const releaseMedia = useCallback(() => {
    peerRef.current?.close()
    peerRef.current = null
    localRef.current?.getTracks().forEach((track) => track.stop())
    localRef.current = null
    setLocalStream(null)
    setRemoteStream(null)
    remoteIceQueue.current = []
    offerRef.current = null
    pendingLocalIce.current = []
    sendLocalIceRef.current = false
    window.clearTimeout(ringTimerRef.current)
    ringTimerRef.current = undefined
    window.clearTimeout(disconnectTimerRef.current)
    disconnectTimerRef.current = undefined
  }, [])

  const send = useCallback(async (to: string, signal: Omit<Signal, 'from' | 'to'>) => {
    const { error } = await supabase.from('call_signals').insert({
      call_id: signal.call_id,
      conversation_id: signal.conversation_id,
      sender_id: me,
      recipient_id: to,
      type: signal.type,
      payload: {
        description: signal.description ?? null,
        candidate: signal.candidate ?? null,
        peer_name: signal.peer_name ?? null,
        peer_avatar: signal.peer_avatar ?? null,
        video: signal.video ?? null,
      },
    })
    if (error) throw new Error(`Could not send call signal: ${error.message}`)
  }, [me])

  const applyAudioState = useCallback((muted: boolean, deaf: boolean) => {
    localRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !muted && !deaf
    })
  }, [])

  const makePeer = useCallback((active: CallInfo) => {
    const peer = new RTCPeerConnection({ iceServers: iceServers() })
    peerRef.current = peer
    remoteIceQueue.current = []
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        const candidate = event.candidate.toJSON()
        if (sendLocalIceRef.current) {
          void send(active.peerId, {
            type: 'candidate',
            call_id: active.id,
            conversation_id: active.conversationId,
            candidate,
          }).catch((error: unknown) => console.error('Unable to send call candidate', error))
        } else {
          pendingLocalIce.current.push(candidate)
        }
      }
    }
    peer.ontrack = (event) => {
      const stream = event.streams[0]
      if (stream) setRemoteStream(stream)
    }
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        connectedRef.current = true
        if (connectedSinceRef.current === null) connectedSinceRef.current = Date.now()
        window.clearTimeout(ringTimerRef.current)
        window.clearTimeout(disconnectTimerRef.current)
        disconnectTimerRef.current = undefined
        updateCall({ ...active, status: 'connected' })
      } else if (peer.connectionState === 'failed') {
        const duration = connectedSinceRef.current === null ? 0 : Math.floor((Date.now() - connectedSinceRef.current) / 1000)
        void logCall(active, connectedRef.current ? 'completed' : 'failed', duration)
        void send(active.peerId, {
          type: 'hangup',
          call_id: active.id,
          conversation_id: active.conversationId,
        }).catch((error: unknown) => console.error('Unable to notify the other participant that the call failed', error))
        releaseMedia()
        updateCall({ ...active, status: 'failed', error: 'Could not establish a direct connection. A TURN server may be required on this network.' })
      } else if (peer.connectionState === 'disconnected') {
        updateCall({ ...active, status: 'connecting' })
        window.clearTimeout(disconnectTimerRef.current)
        disconnectTimerRef.current = window.setTimeout(() => {
          if (peerRef.current !== peer || peer.connectionState !== 'disconnected') return
          const duration = connectedSinceRef.current === null ? 0 : Math.floor((Date.now() - connectedSinceRef.current) / 1000)
          void logCall(active, connectedRef.current ? 'completed' : 'failed', duration)
          releaseMedia()
          updateCall({ ...active, status: 'failed', error: 'The connection was lost. Check your network and try again.' })
        }, 15000)
      } else if (peer.connectionState === 'closed') {
        setRemoteStream(null)
      }
    }
    return peer
  }, [logCall, releaseMedia, send, updateCall])

  const addLocalTracks = useCallback((peer: RTCPeerConnection, stream: MediaStream) => {
    stream.getTracks().forEach((track) => peer.addTrack(track, stream))
    applyAudioState(micMuted, deafened)
    stream.getVideoTracks().forEach((track) => {
      track.enabled = videoEnabled
    })
  }, [applyAudioState, deafened, micMuted, videoEnabled])

  const cleanup = useCallback(() => {
    releaseMedia()
    connectedRef.current = false
    connectedSinceRef.current = null
    setElapsedSeconds(0)
    setMicMuted(false)
    setDeafened(false)
    setVideoEnabled(true)
    setRemoteAudioMuted(false)
    updateCall(null)
  }, [releaseMedia, updateCall])

  const endCall = useCallback(async () => {
    const active = callRef.current
    if (active) {
      if (active.direction === 'outgoing') {
        const duration = connectedSinceRef.current === null ? 0 : Math.floor((Date.now() - connectedSinceRef.current) / 1000)
        void logCall(active, connectedRef.current ? 'completed' : 'cancelled', duration)
      }
      void send(active.peerId, {
        type: 'hangup',
        call_id: active.id,
        conversation_id: active.conversationId,
      }).catch((error: unknown) => console.error('Unable to notify the other participant that the call ended', error))
    }
    cleanup()
  }, [cleanup, logCall, send])

  const startCall = useCallback(async (conversationId: string, peerId: string, peerName: string, video: boolean, peerAvatar: string | null = null) => {
    if (!me || !peerId || callRef.current) return
    if (!navigator.mediaDevices?.getUserMedia) {
      const failed: CallInfo = { id: uuid(), conversationId, peerId, peerName, peerAvatar, video, direction: 'outgoing', status: 'failed', error: 'Calling requires a secure connection (HTTPS) and a browser with media support.' }
      updateCall(failed)
      void logCall(failed, 'failed')
      return
    }
    const active: CallInfo = { id: uuid(), conversationId, peerId, peerName, peerAvatar, video, direction: 'outgoing', status: 'connecting' }
    updateCall(active)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video })
      if (!isCurrentCall(active.id)) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      localRef.current = stream
      setLocalStream(stream)
      const peer = makePeer(active)
      addLocalTracks(peer, stream)
      const offer = await peer.createOffer()
      if (!isCurrentCall(active.id)) return
      await peer.setLocalDescription(offer)
      if (!isCurrentCall(active.id)) return
      await send(peerId, {
        type: 'offer',
        call_id: active.id,
        conversation_id: conversationId,
        peer_name: profile?.display_name || 'Someone',
        peer_avatar: profile?.avatar_path ?? undefined,
        video,
        description: offer,
      })
      if (!isCurrentCall(active.id)) {
        void send(peerId, { type: 'hangup', call_id: active.id, conversation_id: conversationId })
          .catch((error: unknown) => console.error('Unable to cancel a call that was closed while starting', error))
        return
      }
      if (!connectedRef.current) {
        updateCall({ ...active, status: 'ringing' })
        ringTimerRef.current = window.setTimeout(() => {
          if (callRef.current?.id !== active.id || callRef.current.status !== 'ringing') return
          void send(peerId, {
            type: 'hangup',
            call_id: active.id,
            conversation_id: conversationId,
          }).catch((error: unknown) => console.error('Unable to cancel unanswered call', error))
          void logCall(active, 'missed')
          cleanup()
          updateCall({ ...active, status: 'failed', error: 'No answer. The other person may be offline or not have this conversation open.' })
        }, 45000)
      }
      sendLocalIceRef.current = true
      for (const candidate of pendingLocalIce.current.splice(0)) {
        await send(peerId, { type: 'candidate', call_id: active.id, conversation_id: conversationId, candidate })
      }
    } catch (error) {
      if (!isCurrentCall(active.id)) return
      void logCall(active, 'failed')
      cleanup()
      updateCall({ ...active, status: 'failed', error: mediaErrorMessage(error) })
    }
  }, [addLocalTracks, cleanup, isCurrentCall, logCall, makePeer, me, profile?.display_name, profile?.avatar_path, send, updateCall])

  const acceptCall = useCallback(async () => {
    const active = callRef.current
    const offer = offerRef.current
    if (!active || active.direction !== 'incoming' || active.status !== 'ringing' || !offer) return
    window.clearTimeout(ringTimerRef.current)
    ringTimerRef.current = undefined
    if (!navigator.mediaDevices?.getUserMedia) {
      updateCall({ ...active, status: 'failed', error: 'Calling requires a secure connection (HTTPS) and a browser with media support.' })
      return
    }
    updateCall({ ...active, status: 'connecting' })
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: active.video })
      if (!isCurrentCall(active.id)) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      localRef.current = stream
      setLocalStream(stream)
      const peer = makePeer(active)
      addLocalTracks(peer, stream)
      await peer.setRemoteDescription(offer)
      if (!isCurrentCall(active.id)) return
      for (const candidate of remoteIceQueue.current.splice(0)) await peer.addIceCandidate(candidate)
      const answer = await peer.createAnswer()
      await peer.setLocalDescription(answer)
      await send(active.peerId, {
        type: 'answer',
        call_id: active.id,
        conversation_id: active.conversationId,
        description: answer,
      })
      if (!isCurrentCall(active.id)) {
        void send(active.peerId, { type: 'hangup', call_id: active.id, conversation_id: active.conversationId })
          .catch((error: unknown) => console.error('Unable to close a call that was ended while answering', error))
        return
      }
      sendLocalIceRef.current = true
      for (const candidate of pendingLocalIce.current.splice(0)) {
        await send(active.peerId, { type: 'candidate', call_id: active.id, conversation_id: active.conversationId, candidate })
      }
    } catch (error) {
      if (!isCurrentCall(active.id)) return
      void send(active.peerId, { type: 'decline', call_id: active.id, conversation_id: active.conversationId })
        .catch((signalError: unknown) => console.error('Unable to decline a call that could not be answered', signalError))
      cleanup()
      updateCall({ ...active, status: 'failed', error: mediaErrorMessage(error) })
    }
  }, [addLocalTracks, cleanup, isCurrentCall, makePeer, send, updateCall])

  const declineCall = useCallback(async () => {
    const active = callRef.current
    if (active) {
      void send(active.peerId, { type: 'decline', call_id: active.id, conversation_id: active.conversationId })
        .catch((error: unknown) => console.error('Unable to decline call', error))
    }
    cleanup()
  }, [cleanup, send])

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream
      remoteAudioRef.current.muted = deafened || remoteAudioMuted
    }
  }, [deafened, remoteAudioMuted, remoteStream, localStream, call?.video])

  useEffect(() => {
    applyAudioState(micMuted, deafened)
  }, [applyAudioState, deafened, micMuted])

  useEffect(() => {
    if (call?.status !== 'connected') return
    const updateDuration = () => {
      if (connectedSinceRef.current !== null) {
        setElapsedSeconds(Math.floor((Date.now() - connectedSinceRef.current) / 1000))
      }
    }
    updateDuration()
    const timer = window.setInterval(updateDuration, 1000)
    return () => window.clearInterval(timer)
  }, [call?.id, call?.status])

  useEffect(() => {
    if (call?.direction !== 'incoming' || call.status !== 'ringing') return
    return startRingtone(call.id)
  }, [call?.direction, call?.id, call?.status])

  useEffect(() => {
    const off = rt.on('call', (value: unknown) => {
      const signal = value as Signal | undefined
      if (!signal || signal.to !== me || !signal.from || !signal.call_id || !signal.conversation_id) return
      const active = callRef.current
      if (signal.type === 'offer') {
        if (!signal.description) return
        if (active) {
          if (active.id !== signal.call_id) {
            void send(signal.from, { type: 'busy', call_id: signal.call_id, conversation_id: signal.conversation_id })
              .catch((error: unknown) => console.error('Unable to reject a busy call', error))
          }
          return
        }
        const incoming: CallInfo = {
          id: signal.call_id,
          conversationId: signal.conversation_id,
          peerId: signal.from,
          peerName: signal.peer_name || 'Someone',
          peerAvatar: signal.peer_avatar ?? null,
          video: Boolean(signal.video),
          direction: 'incoming',
          status: 'ringing',
        }
        offerRef.current = signal.description
        updateCall(incoming)
        window.clearTimeout(ringTimerRef.current)
        ringTimerRef.current = window.setTimeout(() => {
          if (callRef.current?.id !== incoming.id) return
          void send(incoming.peerId, {
            type: 'decline',
            call_id: incoming.id,
            conversation_id: incoming.conversationId,
          }).catch((error: unknown) => console.error('Unable to end an unanswered incoming call', error))
          cleanup()
        }, 45000)
        return
      }
      if (!active || signal.call_id !== active.id || signal.from !== active.peerId) return
      if (signal.type === 'answer' && signal.description && peerRef.current) {
        void peerRef.current.setRemoteDescription(signal.description).then(async () => {
          for (const candidate of remoteIceQueue.current.splice(0)) {
            await peerRef.current?.addIceCandidate(candidate)
          }
        }).catch((error: unknown) => console.error('Unable to apply call answer', error))
      } else if (signal.type === 'candidate' && signal.candidate) {
        if (peerRef.current?.remoteDescription) {
          void peerRef.current.addIceCandidate(signal.candidate).catch((error: unknown) => console.error('Unable to add call candidate', error))
        } else {
          remoteIceQueue.current.push(signal.candidate)
        }
      } else if (signal.type === 'decline' || signal.type === 'busy') {
        void logCall(active, 'missed')
        cleanup()
        updateCall({
          ...active,
          status: 'failed',
          error: signal.type === 'busy' ? 'The other person is busy.' : 'The call was declined.',
        })
      } else if (signal.type === 'hangup') {
        if (active.direction === 'outgoing') {
          const duration = connectedSinceRef.current === null ? 0 : Math.floor((Date.now() - connectedSinceRef.current) / 1000)
          void logCall(active, connectedRef.current ? 'completed' : 'missed', duration)
        }
        cleanup()
      }
    })
    return off
  }, [cleanup, logCall, me, rt.on, send, updateCall])

  useEffect(() => {
    if (!me) cleanup()
  }, [cleanup, me])

  useEffect(() => () => cleanup(), [cleanup])

  const value = useMemo<CallsState>(() => ({
    call,
    micMuted,
    deafened,
    startCall,
    acceptCall,
    declineCall,
    endCall,
    toggleMic: () => setMicMuted((muted) => !muted),
    toggleDeafen: () => setDeafened((deaf) => !deaf),
    toggleVideo: () => {
      const next = !videoEnabled
      setVideoEnabled(next)
      localRef.current?.getVideoTracks().forEach((track) => { track.enabled = next })
    },
    dismissError: cleanup,
  }), [acceptCall, call, cleanup, deafened, declineCall, endCall, micMuted, startCall, videoEnabled])

  return (
    <Ctx.Provider value={value}>
      {children}
      {call && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#070a10] text-white" role="dialog" aria-modal="true" aria-label={`${call.video ? 'Video' : 'Audio'} call with ${call.peerName}`}>
          <section className="relative flex h-full w-full max-w-5xl flex-col overflow-hidden border border-white/10 bg-[#0d111b] shadow-2xl md:my-6 md:h-[min(90vh,800px)] md:rounded-[2rem]">
            {call.video ? (
              <div className="absolute inset-0 bg-black">
                {!remoteStream && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-700 via-[#111827] to-[#070a10]">
                    <Avatar path={call.peerAvatar} name={call.peerName} size={136} className="ring-4 ring-white/10 shadow-2xl" />
                    <p className="text-lg font-medium text-white/80">{call.peerName}</p>
                  </div>
                )}
                <video ref={remoteVideoRef} autoPlay muted playsInline className={`h-full w-full object-cover ${remoteStream ? '' : 'invisible'}`} />
                <video ref={localVideoRef} autoPlay muted playsInline className="absolute bottom-28 right-4 z-10 h-28 w-24 rounded-2xl border border-white/20 bg-slate-900 object-cover shadow-xl sm:bottom-32 sm:right-6 sm:h-40 sm:w-32" />
                <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/65" />
              </div>
            ) : (
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_35%,_var(--tw-gradient-stops))] from-indigo-950/70 via-[#111827] to-[#070a10]" />
            )}

            <header className="relative z-10 flex items-center justify-between gap-4 px-5 py-5 sm:px-8">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/55">{call.video ? 'Video call' : 'Audio call'}</p>
                <h2 className="mt-1 truncate text-lg font-semibold sm:text-xl">{call.peerName}</h2>
                <p aria-live="polite" className="mt-1 text-sm text-white/65">
                  {call.status === 'connected' ? formatCallDuration(elapsedSeconds) : call.status === 'failed' ? 'Call ended' : call.status === 'ringing' ? call.direction === 'incoming' ? 'Incoming call' : 'Ringing…' : 'Connecting…'}
                </p>
              </div>
              {call.status === 'connected' && (
                <span className="inline-flex items-center gap-2 rounded-full bg-black/30 px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" /> Connected
                </span>
              )}
            </header>

            {!call.video && (
              <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pb-8 text-center">
                <div className="relative mb-7">
                  {call.status === 'ringing' && <span className="absolute -inset-5 animate-ping rounded-full bg-brand-500/15" />}
                  <Avatar path={call.peerAvatar} name={call.peerName} size={144} className="relative ring-4 ring-white/10 shadow-2xl sm:h-40 sm:w-40" />
                </div>
                <h3 className="text-2xl font-semibold tracking-tight sm:text-3xl">{call.peerName}</h3>
                <p className="mt-2 text-sm text-white/55">{call.status === 'ringing' && call.direction === 'outgoing' ? 'Calling…' : call.status === 'ringing' ? 'Would like to talk with you' : call.status === 'failed' ? call.error : call.status === 'connected' ? 'You’re connected' : 'Please wait a moment'}</p>
              </div>
            )}

            {call.video && <div className="relative z-10 flex-1" />}
            <audio ref={remoteAudioRef} autoPlay playsInline />

            {call.status === 'failed' && (
              <p role="alert" className="relative z-10 mx-5 mb-3 rounded-xl border border-red-300/20 bg-red-950/50 px-4 py-3 text-center text-sm text-red-200 sm:mx-auto sm:max-w-xl">{call.error}</p>
            )}

            <footer className="relative z-10 flex flex-col items-center gap-5 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3 sm:pb-8">
              {call.direction === 'incoming' && call.status === 'ringing' ? (
                <div className="flex items-center gap-12">
                  <button type="button" aria-label="Decline call" onClick={() => void declineCall()} className="flex flex-col items-center gap-2 text-xs text-white/70">
                    <span className="flex h-16 w-16 items-center justify-center rounded-full bg-red-600 shadow-lg shadow-red-950/40 transition hover:bg-red-500 active:scale-95">
                      <svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 11.2 19a19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.2-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.8 2.1z" /></svg>
                    </span>
                    Decline
                  </button>
                  <button type="button" aria-label="Answer call" onClick={() => void acceptCall()} className="flex flex-col items-center gap-2 text-xs text-white/70">
                    <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 shadow-lg shadow-emerald-950/40 transition hover:bg-emerald-400 active:scale-95">
                      <svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 11.2 19a19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.2-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.8 2.1z" /></svg>
                    </span>
                    Answer
                  </button>
                </div>
              ) : (
                <>
                  {call.status !== 'failed' && (
                    <div className="flex flex-wrap items-start justify-center gap-3 sm:gap-5">
                      <button type="button" aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={micMuted} onClick={() => setMicMuted((muted) => !muted)} className="flex w-[4.5rem] flex-col items-center gap-2 text-[11px] text-white/75">
                        <span className={`flex h-12 w-12 items-center justify-center rounded-full transition ${micMuted ? 'bg-white text-slate-900' : 'bg-white/10 text-white hover:bg-white/20'}`}>
                          <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />{micMuted && <path d="m3 3 18 18" />}</svg>
                        </span>
                        {micMuted ? 'Unmute' : 'Mute'}
                      </button>
                      <button type="button" aria-label={deafened ? 'Turn speaker on' : 'Turn speaker off'} aria-pressed={deafened} onClick={() => setDeafened((deaf) => !deaf)} className="flex w-[4.5rem] flex-col items-center gap-2 text-[11px] text-white/75">
                        <span className={`flex h-12 w-12 items-center justify-center rounded-full transition ${deafened ? 'bg-white text-slate-900' : 'bg-white/10 text-white hover:bg-white/20'}`}>
                          <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 14v-3a9 9 0 0 1 18 0v3M3 14h4v7H5a2 2 0 0 1-2-2zM21 14h-4v7h2a2 2 0 0 0 2-2z" />{deafened && <path d="m3 3 18 18" />}</svg>
                        </span>
                        {deafened ? 'Speaker on' : 'Speaker'}
                      </button>
                      {call.video && (
                        <button type="button" aria-label={videoEnabled ? 'Turn camera off' : 'Turn camera on'} aria-pressed={!videoEnabled} onClick={() => {
                          setVideoEnabled((enabled) => {
                            localRef.current?.getVideoTracks().forEach((track) => { track.enabled = !enabled })
                            return !enabled
                          })
                        }} className="flex w-[4.5rem] flex-col items-center gap-2 text-[11px] text-white/75">
                          <span className={`flex h-12 w-12 items-center justify-center rounded-full transition ${videoEnabled ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-white text-slate-900'}`}>
                            <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3z" />{!videoEnabled && <path d="m3 3 18 18" />}</svg>
                          </span>
                          {videoEnabled ? 'Camera' : 'Camera off'}
                        </button>
                      )}
                      <button type="button" aria-label={remoteAudioMuted ? 'Unmute speaker' : 'Mute speaker'} aria-pressed={remoteAudioMuted} onClick={() => setRemoteAudioMuted((muted) => !muted)} className="flex w-[4.5rem] flex-col items-center gap-2 text-[11px] text-white/75">
                        <span className={`flex h-12 w-12 items-center justify-center rounded-full transition ${remoteAudioMuted ? 'bg-white text-slate-900' : 'bg-white/10 text-white hover:bg-white/20'}`}>
                          <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />{remoteAudioMuted && <path d="m3 3 18 18" />}</svg>
                        </span>
                        {remoteAudioMuted ? 'Hear audio' : 'Audio'}
                      </button>
                    </div>
                  )}
                  <button type="button" aria-label={call.status === 'failed' ? 'Close call' : 'End call'} onClick={() => call.status === 'failed' ? cleanup() : void endCall()} className="flex h-14 w-16 items-center justify-center rounded-full bg-red-600 shadow-lg shadow-red-950/40 transition hover:bg-red-500 active:scale-95">
                    {call.status === 'failed' ? (
                      <span className="text-sm font-semibold">Close</span>
                    ) : (
                      <svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 11.2 19a19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.2-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.8 2.1z" /></svg>
                    )}
                  </button>
                </>
              )}
            </footer>
          </section>
        </div>
      )}
    </Ctx.Provider>
  )
}

export function useCalls(): CallsState {
  const value = useContext(Ctx)
  if (!value) throw new Error('useCalls must be used inside CallProvider')
  return value
}
