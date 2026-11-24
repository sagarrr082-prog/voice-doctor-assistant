export interface Slot {
  id: string;
  date: string;
  time_slot: string;
  is_booked: boolean;
}

export interface Doctor {
  id: string;
  name: string;
  specialty: string;
  room: string;
  slots: Slot[];
}

export interface Appointment {
  id: string;
  phone_number: string;
  patient_name: string;
  doctor_id: string;
  doctor_name: string;
  specialty: string;
  date: string;
  time_slot: string;
  status: 'CONFIRMED' | 'CANCELLED';
  created_at: string;
}

export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export type CallState = 'idle' | 'ringing' | 'connected' | 'ended';