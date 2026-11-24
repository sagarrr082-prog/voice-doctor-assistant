import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Send,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Appointment, CallState, TranscriptMessage } from '../types';

interface PhoneModalProps {
  callState: CallState;
  isMuted: boolean;
  elapsedSeconds: number;
  analyserNode: AnalyserNode | null;
  transcripts: TranscriptMessage[];
  latestBooking: Appointment | null;
  onSendText?: (text: string) => void;
  onToggleMute: () => void;
  onEndCall: () => void;
  onDismiss: () => void;
  onCallAgain: () => void;
}

function formatTimer(seconds: number): string {
  const mins = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

export const PhoneModal: React.FC<PhoneModalProps> = ({
  callState,
  isMuted,
  elapsedSeconds,
  analyserNode,
  transcripts,
  latestBooking,
  onSendText,
  onToggleMute,
  onEndCall,
  onDismiss,
  onCallAgain,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcripts, latestBooking]);

  useEffect(() => {
    if (callState !== 'connected' || !analyserNode || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    let animId: number;

    const draw = () => {
      animId = requestAnimationFrame(draw);
      analyserNode.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const bars = 24;
      const barWidth = 3;
      const gap = 4;
      const totalWidth = bars * (barWidth + gap) - gap;
      const startX = (canvas.width - totalWidth) / 2;

      for (let i = 0; i < bars; i++) {
        const value = isMuted ? 4 : dataArray[i % bufferLength] || 6;
        const height = Math.max(4, (value / 255) * 28);
        const x = startX + i * (barWidth + gap);
        const y = (canvas.height - height) / 2;

        ctx.fillStyle = isMuted ? '#A1A1AA' : '#0F766E';
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, height, 2);
        ctx.fill();
      }
    };

    draw();
    return () => cancelAnimationFrame(animId);
  }, [callState, analyserNode, isMuted]);

  if (callState === 'idle') return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || !onSendText) return;
    onSendText(draft.trim());
    setDraft('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/45 backdrop-blur-sm p-4 transition-opacity">
      <div className="relative flex h-[660px] w-full max-w-[360px] flex-col overflow-hidden rounded-[38px] border-[6px] border-zinc-900 bg-[#FAF9F6] shadow-2xl">
        {/* Top Speaker Notch */}
        <div className="flex items-center justify-between px-6 pt-3 pb-2 text-[11px] font-medium text-zinc-500">
          <span>Solaris Line</span>
          <div className="h-4 w-20 rounded-full bg-zinc-900" />
          <button
            onClick={callState === 'ended' ? onDismiss : onEndCall}
            aria-label="Close phone"
            className="rounded-full p-1 text-zinc-400 hover:bg-zinc-200/70 hover:text-zinc-700"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Caller Header */}
        <div className="flex flex-col items-center border-b border-stone-200/80 px-5 pt-3 pb-4 text-center">
          <div className="relative mb-2.5 flex h-14 w-14 items-center justify-center rounded-full bg-teal-900 text-lg font-semibold text-white shadow-sm">
            M
            {callState === 'connected' && (
              <span className="absolute -right-0.5 -bottom-0.5 h-3.5 w-3.5 rounded-full border-2 border-[#FAF9F6] bg-emerald-500" />
            )}
          </div>
          <h3 className="text-base font-semibold tracking-tight text-zinc-900">
            Maya — Clinic Reception
          </h3>
          <p className="mt-0.5 font-mono text-xs text-zinc-500">
            {callState === 'ringing' && 'Calling clinic desk...'}
            {callState === 'connected' && `Connected · ${formatTimer(elapsedSeconds)}`}
            {callState === 'ended' && `Call Ended · ${formatTimer(elapsedSeconds)}`}
          </p>

          {/* Reactive Waveform */}
          <div className="mt-2.5 flex h-8 w-full items-center justify-center">
            {callState === 'connected' ? (
              <canvas ref={canvasRef} width={200} height={32} />
            ) : (
              <div className="flex items-center gap-1.5 text-[11px] text-teal-800">
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>Voice ID via spoken phone number</span>
              </div>
            )}
          </div>
        </div>

        {/* Live Transcript & In-Call Confirmation Card */}
        <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3.5 text-xs">
          {transcripts.length === 0 && callState !== 'ended' && (
            <div className="rounded-xl border border-dashed border-stone-300 bg-white/60 p-3 text-center text-zinc-500">
              Speak naturally once connected. Ask for doctor availability, book a slot, or cancel an appointment.
            </div>
          )}

          {transcripts.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${
                msg.role === 'user' ? 'items-end' : 'items-start'
              }`}
            >
              <span className="mb-0.5 px-1 text-[10px] font-medium uppercase tracking-wider text-zinc-400">
                {msg.role === 'user' ? 'You' : 'Maya'}
              </span>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 leading-relaxed ${
                  msg.role === 'user'
                    ? 'rounded-br-sm bg-zinc-900 text-white'
                    : 'rounded-bl-sm border border-stone-200 bg-white text-zinc-800 shadow-sm'
                }`}
              >
                {msg.text}
              </div>
            </div>
          ))}

          {/* Booking Confirmation Card inside Phone */}
          {latestBooking && (
            <div className="mt-2 rounded-2xl border border-emerald-200 bg-emerald-50/90 p-3.5 text-zinc-900 shadow-sm">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-800">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                <span>Appointment Confirmed</span>
              </div>
              <div className="mt-2 space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Doctor</span>
                  <span className="font-medium">{latestBooking.doctor_name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Slot</span>
                  <span className="font-medium">
                    {latestBooking.date}, {latestBooking.time_slot}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Caller ID</span>
                  <span className="font-mono font-medium">
                    {latestBooking.phone_number}
                  </span>
                </div>
              </div>
            </div>
          )}

          <div ref={scrollEndRef} />
        </div>

        {/* Optional Quick Text Input during Call */}
        {callState === 'connected' && onSendText && (
          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-1.5 border-t border-stone-200/80 bg-[#FAF9F6] px-3 py-2"
          >
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Speak or type to Maya..."
              className="flex-1 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs text-zinc-800 placeholder:text-zinc-400 focus:border-teal-700 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-teal-900 text-white transition hover:bg-teal-950 disabled:opacity-40"
              title="Send"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>
        )}

        {/* Bottom Phone Keypad / Call Controls */}
        <div className="border-t border-stone-200 bg-white px-6 py-3.5">
          {callState === 'ended' ? (
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={onCallAgain}
                className="flex flex-1 items-center justify-center gap-2 rounded-full bg-teal-800 py-3 text-xs font-medium text-white transition hover:bg-teal-900"
              >
                <Phone className="h-3.5 w-3.5" />
                Call Again
              </button>
              <button
                onClick={onDismiss}
                className="rounded-full border border-stone-300 px-5 py-3 text-xs font-medium text-zinc-700 transition hover:bg-stone-100"
              >
                Done
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-6">
              <button
                onClick={onToggleMute}
                disabled={callState !== 'connected'}
                className={`flex h-12 w-12 items-center justify-center rounded-full border transition ${
                  isMuted
                    ? 'border-amber-300 bg-amber-50 text-amber-700'
                    : 'border-stone-200 bg-stone-100 text-zinc-700 hover:bg-stone-200'
                } disabled:opacity-40`}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              </button>

              <button
                onClick={onEndCall}
                className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-600 text-white shadow-md transition hover:bg-rose-700 active:scale-95"
                title="End Call"
              >
                <PhoneOff className="h-6 w-6" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};