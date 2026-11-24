import { useCallback, useEffect, useState } from 'react';
import {
  Calendar,
  Clock,
  PhoneCall,
  Stethoscope,
  UserCheck,
} from 'lucide-react';
import { PhoneModal } from './components/PhoneModal';
import { useVoiceCall } from './hooks/useVoiceCall';
import { Appointment, Doctor, TranscriptMessage } from './types';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000';
const WS_EVENTS_URL = import.meta.env.VITE_WS_EVENTS_URL || 'ws://localhost:8000/ws/events';

export function App() {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [transcripts, setTranscripts] = useState<TranscriptMessage[]>([]);
  const [latestBooking, setLatestBooking] = useState<Appointment | null>(null);
  const [highlightedRow, setHighlightedRow] = useState<{
    id: string;
    type: 'booked' | 'cancelled';
  } | null>(null);

  const handleCallStarted = useCallback(() => {
    setTranscripts([]);
    setLatestBooking(null);
  }, []);

  const {
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
  } = useVoiceCall(handleCallStarted);

  useEffect(() => {
    fetch(`${API_BASE}/api/state`)
      .then((res) => res.json())
      .then((data) => {
        setDoctors(data.doctors || []);
        setAppointments(data.appointments || []);
      })
      .catch((err) => console.error('Failed to load initial clinic state:', err));
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let isMounted = true;

    const connectEvents = () => {
      if (!isMounted) return;
      ws = new WebSocket(WS_EVENTS_URL);

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);

          if (payload.type === 'INIT_STATE') {
            setDoctors(payload.state.doctors || []);
            setAppointments(payload.state.appointments || []);
          } else if (payload.type === 'APPOINTMENT_BOOKED') {
            setDoctors(payload.state.doctors || []);
            setAppointments(payload.state.appointments || []);
            setLatestBooking(payload.appointment);
            setHighlightedRow({ id: payload.appointment.id, type: 'booked' });
          } else if (payload.type === 'APPOINTMENT_CANCELLED') {
            setDoctors(payload.state.doctors || []);
            setAppointments(payload.state.appointments || []);
            setHighlightedRow({ id: payload.appointment.id, type: 'cancelled' });
          } else if (payload.type === 'TRANSCRIPT') {
            if (payload.role === 'assistant') {
              speakAssistantFallback(payload.text);
            }
            setTranscripts((prev) => [
              ...prev,
              {
                id: `${Date.now()}-${Math.random()}`,
                role: payload.role,
                text: payload.text,
                timestamp: new Date().toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              },
            ]);
          }
        } catch (err) {
          console.error('Event parse error:', err);
        }
      };

      ws.onclose = () => {
        if (isMounted) {
          reconnectTimer = window.setTimeout(connectEvents, 1500);
        }
      };
    };

    connectEvents();

    return () => {
      isMounted = false;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      ws?.close();
    };
  }, [speakAssistantFallback]);

  return (
    <div className="min-h-screen bg-[#F8F7F4] text-[#18181B]">
      {/* Minimal Header */}
      <header className="sticky top-0 z-30 border-b border-stone-200/90 bg-[#F8F7F4]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-900 text-white">
              <Stethoscope className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight text-zinc-900">
                Solaris Clinic Desk
              </h1>
              <p className="text-xs text-zinc-500">
                Voice AI Appointment Reception · Pipecat + Gemini
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="hidden items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs text-zinc-600 sm:flex">
              <span
                className={`h-2 w-2 rounded-full ${
                  callState === 'connected'
                    ? 'animate-pulse bg-emerald-500'
                    : 'bg-teal-700'
                }`}
              />
              <span>
                {callState === 'connected' ? 'Agent On Call' : 'Voice Line Ready'}
              </span>
            </div>

            {callState === 'connected' || callState === 'ringing' ? (
              <button
                onClick={endCall}
                className="inline-flex items-center gap-2 rounded-full bg-rose-600 px-4 py-2 text-xs font-medium text-white shadow-sm transition hover:bg-rose-700"
              >
                End Call
              </button>
            ) : (
              <button
                onClick={startCall}
                className="inline-flex items-center gap-2 rounded-full bg-teal-900 px-4 py-2 text-xs font-medium text-white shadow-sm transition hover:bg-teal-950 active:scale-[0.99]"
              >
                <PhoneCall className="h-3.5 w-3.5" />
                Try Call
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Error Banner */}
      {callError && (
        <div className="mx-auto mt-4 max-w-6xl px-6">
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-medium text-rose-800">
            Voice Call Error: {callError}
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="mx-auto max-w-6xl space-y-8 px-6 py-8">
        {/* Section 1: Doctors & Live Slots */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Doctors & Available Slots
            </h2>
            <span className="text-xs text-zinc-400">
              Updates automatically during calls
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {doctors.map((doc) => {
              const openCount = doc.slots.filter((s) => !s.is_booked).length;
              return (
                <div
                  key={doc.id}
                  className="flex flex-col justify-between rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm transition hover:border-stone-300"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold text-zinc-900">
                          {doc.name}
                        </h3>
                        <p className="text-xs text-zinc-500">{doc.specialty}</p>
                      </div>
                      <span className="rounded-md bg-stone-100 px-2 py-0.5 font-mono text-[11px] text-zinc-600">
                        {doc.room}
                      </span>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {doc.slots.map((slot) => (
                        <span
                          key={slot.id}
                          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 font-mono text-[11px] transition ${
                            slot.is_booked
                              ? 'border-stone-200 bg-stone-100 text-zinc-400 line-through'
                              : 'border-teal-200 bg-teal-50/70 text-teal-900'
                          }`}
                        >
                          <Clock className="h-3 w-3 opacity-70" />
                          {slot.time_slot}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="mt-4 border-t border-stone-100 pt-2.5 text-[11px] text-zinc-500">
                    {openCount} of {doc.slots.length} slots open · Tomorrow
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Section 2: Appointments Ledger + Live Call Transcript */}
        <section className="grid gap-6 lg:grid-cols-3">
          {/* Appointments Table (2 cols) */}
          <div className="lg:col-span-2">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
                Appointments Ledger
              </h2>
              <span className="font-mono text-xs text-zinc-400">
                {appointments.length} total
              </span>
            </div>

            <div className="overflow-hidden rounded-2xl border border-stone-200/90 bg-white shadow-sm">
              {appointments.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-14 text-center">
                  <Calendar className="mb-2 h-6 w-6 text-zinc-300" />
                  <p className="text-sm font-medium text-zinc-700">
                    No appointments booked yet
                  </p>
                  <p className="mt-1 text-xs text-zinc-400">
                    Click <span className="font-medium text-teal-800">Try Call</span> and give your phone number to book a slot.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-stone-200 bg-stone-50/70 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                      <tr>
                        <th className="px-4 py-3">Caller Phone</th>
                        <th className="px-4 py-3">Doctor</th>
                        <th className="px-4 py-3">Slot</th>
                        <th className="px-4 py-3">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-100">
                      {appointments.map((apt) => {
                        const isFlashing = highlightedRow?.id === apt.id;
                        const flashClass = isFlashing
                          ? highlightedRow?.type === 'booked'
                            ? 'row-flash-booked'
                            : 'row-flash-cancelled'
                          : '';

                        return (
                          <tr key={apt.id} className={flashClass}>
                            <td className="px-4 py-3.5 font-mono font-medium text-zinc-900">
                              {apt.phone_number}
                            </td>
                            <td className="px-4 py-3.5">
                              <div className="font-medium text-zinc-900">
                                {apt.doctor_name}
                              </div>
                              <div className="text-[11px] text-zinc-400">
                                {apt.specialty}
                              </div>
                            </td>
                            <td className="px-4 py-3.5 text-zinc-700">
                              {apt.date} ·{' '}
                              <span className="font-mono">{apt.time_slot}</span>
                            </td>
                            <td className="px-4 py-3.5">
                              <span
                                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                                  apt.status === 'CONFIRMED'
                                    ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-600/20'
                                    : 'bg-rose-50 text-rose-700 ring-1 ring-rose-600/20'
                                }`}
                              >
                                {apt.status}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Live Transcript Panel (1 col) */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
                Live Transcript
              </h2>
              <UserCheck className="h-4 w-4 text-zinc-400" />
            </div>

            <div className="flex h-[320px] flex-col justify-between rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm">
              <div className="flex-1 space-y-3 overflow-y-auto pr-1 text-xs">
                {transcripts.length === 0 ? (
                  <p className="py-12 text-center text-zinc-400">
                    Conversation transcript appears here in real time during a call.
                  </p>
                ) : (
                  transcripts.map((msg) => (
                    <div key={msg.id} className="space-y-0.5">
                      <div className="flex items-center justify-between text-[10px] text-zinc-400">
                        <span className="font-semibold uppercase tracking-wider">
                          {msg.role === 'user' ? 'Caller' : 'Maya (Agent)'}
                        </span>
                        <span className="font-mono">{msg.timestamp}</span>
                      </div>
                      <p className="leading-relaxed text-zinc-800">{msg.text}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Phone-Style Call Modal */}
      <PhoneModal
        callState={callState}
        isMuted={isMuted}
        elapsedSeconds={elapsedSeconds}
        analyserNode={analyserNode}
        transcripts={transcripts}
        latestBooking={latestBooking}
        onSendText={sendTextMessage}
        onToggleMute={toggleMute}
        onEndCall={endCall}
        onDismiss={dismissModal}
        onCallAgain={startCall}
      />
    </div>
  );
}

export default App;