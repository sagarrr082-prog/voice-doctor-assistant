import { useCallback, useEffect, useRef, useState } from 'react';
import { CallState } from '../types';

const WS_VOICE_URL = import.meta.env.VITE_WS_VOICE_URL || 'ws://localhost:8000/ws/voice';

interface BrowserSpeechResult {
  isFinal: boolean;
  0: { transcript: string };
}

interface BrowserSpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<BrowserSpeechResult>;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: BrowserSpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  }
}

function downsampleTo16k(input: Float32Array, inputSampleRate: number): Int16Array {
  if (inputSampleRate === 16000) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = inputSampleRate / 16000;
  const newLength = Math.round(input.length / ratio);
  const result = new Int16Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i++) {
      accum += input[i];
      count++;
    }
    const sample = count > 0 ? accum / count : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    result[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function playTone(type: 'ring' | 'end') {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    if (type === 'ring') {
      osc1.frequency.setValueAtTime(440, now);
      osc2.frequency.setValueAtTime(480, now);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.85);
      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);
      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.85);
      osc2.stop(now + 0.85);
    } else {
      osc1.frequency.setValueAtTime(480, now);
      osc1.frequency.exponentialRampToValueAtTime(320, now + 0.35);
      gain.gain.setValueAtTime(0.07, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc1.connect(gain);
      gain.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.35);
    }
    setTimeout(() => ctx.close(), 1000);
  } catch {
    // Ignore autoplay restrictions
  }
}

export function useVoiceCall(onCallStarted?: () => void) {
  const [callState, setCallState] = useState<CallState>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);
  const [callError, setCallError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const recognitionRestartRef = useRef<number | null>(null);
  const assistantResumeTimerRef = useRef<number | null>(null);
  const browserRecognitionActiveRef = useRef(false);
  const assistantSpeakingRef = useRef(false);
  const connectTimeoutRef = useRef<number | null>(null);
  const ttsFallbackTimerRef = useRef<number | null>(null);
  const receivedServerAudioRef = useRef<boolean>(false);
  const nextPlayTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const mutedRef = useRef(false);

  useEffect(() => {
    mutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    if (callState !== 'connected') return;
    const timer = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [callState]);

  const startBrowserRecognition = useCallback(() => {
    if (
      !browserRecognitionActiveRef.current ||
      mutedRef.current ||
      assistantSpeakingRef.current ||
      !recognitionRef.current
    ) return;
    try {
      recognitionRef.current.start();
    } catch {
      // Recognition may already be starting; its onend handler will retry if needed.
    }
  }, []);

  const pauseBrowserRecognition = useCallback(() => {
    if (recognitionRestartRef.current !== null) {
      window.clearTimeout(recognitionRestartRef.current);
      recognitionRestartRef.current = null;
    }
    recognitionRef.current?.abort();
  }, []);

  const resumeAfterAssistant = useCallback(() => {
    assistantSpeakingRef.current = false;
    if (assistantResumeTimerRef.current !== null) {
      window.clearTimeout(assistantResumeTimerRef.current);
      assistantResumeTimerRef.current = null;
    }
    startBrowserRecognition();
  }, [startBrowserRecognition]);

  const clearQueuedPlayback = useCallback(() => {
    if (ttsFallbackTimerRef.current !== null) {
      window.clearTimeout(ttsFallbackTimerRef.current);
      ttsFallbackTimerRef.current = null;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    activeSourcesRef.current.forEach((src) => {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    });
    activeSourcesRef.current = [];
    if (audioCtxRef.current) {
      nextPlayTimeRef.current = audioCtxRef.current.currentTime;
    }
  }, []);

  const speakAssistantFallback = useCallback((text: string) => {
    receivedServerAudioRef.current = false;
    assistantSpeakingRef.current = true;
    pauseBrowserRecognition();
    if (ttsFallbackTimerRef.current !== null) {
      window.clearTimeout(ttsFallbackTimerRef.current);
    }
    ttsFallbackTimerRef.current = window.setTimeout(() => {
      if (receivedServerAudioRef.current) return;
      if (!('speechSynthesis' in window)) {
        resumeAfterAssistant();
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices();
      const preferredVoice =
        voices.find((v) => /zira|aria|jenny|samantha|google uk english female/i.test(v.name)) ||
        voices.find((v) => v.lang.startsWith('en'));
      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }
      utterance.rate = 1.02;
      utterance.onend = () => {
        if (!receivedServerAudioRef.current) resumeAfterAssistant();
      };
      utterance.onerror = () => {
        if (!receivedServerAudioRef.current) resumeAfterAssistant();
      };
      window.speechSynthesis.speak(utterance);
    }, 450);
  }, [pauseBrowserRecognition, resumeAfterAssistant]);

  const queuePCMPlayback = useCallback((arrayBuffer: ArrayBuffer) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;

    const int16 = new Int16Array(arrayBuffer);
    if (int16.length === 0) return;

    assistantSpeakingRef.current = true;
    pauseBrowserRecognition();
    receivedServerAudioRef.current = true;
    if (ttsFallbackTimerRef.current !== null) {
      window.clearTimeout(ttsFallbackTimerRef.current);
      ttsFallbackTimerRef.current = null;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 0x8000;
    }

    const audioBuffer = ctx.createBuffer(1, float32.length, 16000);
    audioBuffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const startTime = Math.max(ctx.currentTime, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + audioBuffer.duration;
    if (assistantResumeTimerRef.current !== null) {
      window.clearTimeout(assistantResumeTimerRef.current);
    }
    assistantResumeTimerRef.current = window.setTimeout(
      resumeAfterAssistant,
      Math.max(0, (nextPlayTimeRef.current - ctx.currentTime) * 1000) + 500,
    );

    activeSourcesRef.current.push(source);
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
    };
  }, [pauseBrowserRecognition, resumeAfterAssistant]);

  const cleanupResources = useCallback(() => {
    if (connectTimeoutRef.current !== null) {
      window.clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    browserRecognitionActiveRef.current = false;
    assistantSpeakingRef.current = false;
    clearQueuedPlayback();
    if (assistantResumeTimerRef.current !== null) {
      window.clearTimeout(assistantResumeTimerRef.current);
      assistantResumeTimerRef.current = null;
    }
    if (recognitionRestartRef.current !== null) {
      window.clearTimeout(recognitionRestartRef.current);
      recognitionRestartRef.current = null;
    }
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      recognitionRef.current.onresult = null;
      recognitionRef.current.onerror = null;
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }
    processorRef.current?.disconnect();
    processorRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.close();
    }
    wsRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setAnalyserNode(null);
  }, [clearQueuedPlayback]);

  const startCall = useCallback(async () => {
    onCallStarted?.();
    setCallError(null);
    setElapsedSeconds(0);
    setIsMuted(false);
    receivedServerAudioRef.current = false;
    setCallState('ringing');
    playTone('ring');

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Browser blocked microphone API. Open http://localhost:5173 in Chrome or Edge.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      audioCtxRef.current = audioCtx;
      nextPlayTimeRef.current = audioCtx.currentTime;

      const source = audioCtx.createMediaStreamSource(stream);
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = 1.8;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;

      source.connect(gainNode);
      gainNode.connect(analyser);
      setAnalyserNode(analyser);

      const ws = new WebSocket(WS_VOICE_URL);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        connectTimeoutRef.current = window.setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            setCallState('connected');
          }
        }, 650);

        const processor = audioCtx.createScriptProcessor(2048, 1, 1);
        processorRef.current = processor;

        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (Recognition) {
          const recognition = new Recognition();
          recognition.continuous = true;
          recognition.interimResults = false;
          recognition.lang = navigator.language || 'en-US';
          recognitionRef.current = recognition;
          browserRecognitionActiveRef.current = true;

          recognition.onresult = (event) => {
            for (let i = event.resultIndex; i < event.results.length; i++) {
              const result = event.results[i];
              const text = result.isFinal ? result[0]?.transcript.trim() : '';
              if (text && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'USER_TEXT', text }));
              }
            }
          };

          recognition.onerror = (event) => {
            if (event.error === 'no-speech' || event.error === 'aborted') return;
            browserRecognitionActiveRef.current = false;
            console.warn(
              `Browser speech recognition failed (${event.error}); falling back to server transcription.`,
            );
          };

          recognition.onend = () => {
            if (
              !browserRecognitionActiveRef.current ||
              mutedRef.current ||
              assistantSpeakingRef.current ||
              ws.readyState !== WebSocket.OPEN
            ) return;
            recognitionRestartRef.current = window.setTimeout(() => {
              startBrowserRecognition();
            }, 250);
          };

          try {
            recognition.start();
          } catch (err) {
            browserRecognitionActiveRef.current = false;
            recognitionRef.current = null;
            console.warn('Could not start browser speech recognition; using server transcription.', err);
          }
        }

        processor.onaudioprocess = (e) => {
          if (
            browserRecognitionActiveRef.current ||
            mutedRef.current ||
            ws.readyState !== WebSocket.OPEN
          ) return;
          const inputData = e.inputBuffer.getChannelData(0);
          const pcm16 = downsampleTo16k(inputData, audioCtx.sampleRate);
          ws.send(pcm16.buffer);
        };

        gainNode.connect(processor);
        processor.connect(audioCtx.destination);
      };

      ws.onerror = () => {
        setCallError('Could not connect to backend voice WebSocket on port 8000.');
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          queuePCMPlayback(event.data);
        } else if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'CLEAR_AUDIO') {
              clearQueuedPlayback();
              resumeAfterAssistant();
            }
          } catch {
            // ignore non-json
          }
        }
      };

      ws.onclose = (ev) => {
        cleanupResources();
        if (ev.code !== 1000 && ev.code !== 1005) {
          setCallError(`Backend closed the call (code ${ev.code}). Check your Uvicorn terminal for the error.`);
        }
        setCallState('ended');
      };
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? `${err.name}: ${err.message}`
          : 'Microphone access failed.';
      console.error('Failed to start voice call:', err);
      setCallError(msg);
      cleanupResources();
      setCallState('ended');
    }
  }, [cleanupResources, clearQueuedPlayback, onCallStarted, queuePCMPlayback, resumeAfterAssistant, startBrowserRecognition]);

  const sendTextMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'USER_TEXT', text: trimmed }));
  }, []);

  const endCall = useCallback(() => {
    playTone('end');
    cleanupResources();
    setCallState('ended');
  }, [cleanupResources]);

  const dismissModal = useCallback(() => {
    setCallState('idle');
    setCallError(null);
    setElapsedSeconds(0);
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const nextMuted = !prev;
      mutedRef.current = nextMuted;
      if (nextMuted) {
        pauseBrowserRecognition();
      } else {
        startBrowserRecognition();
      }
      return nextMuted;
    });
  }, [pauseBrowserRecognition, startBrowserRecognition]);

  return {
    callState,
    isMuted,
    elapsedSeconds,
    analyserNode,
    callError,
    speakAssistantFallback,
    sendTextMessage,
    startCall,
    endCall,
    dismissModal,
    toggleMute,
  };
}
