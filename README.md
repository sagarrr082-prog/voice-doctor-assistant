# Solaris Clinic Desk

Solaris Clinic Desk is a local full-stack voice receptionist. Maya answers through a browser microphone, transcribes speech with ElevenLabs, generates replies with Google Gemini, speaks with ElevenLabs, and manages clinic appointments in SQLite. A React dashboard receives live transcripts and appointment changes over a separate WebSocket.

## Requirements

- Windows 10/11, Python 3.12 (64-bit), and Node.js with npm
- A Google Gemini API key and an ElevenLabs API key
- A browser with microphone access (localhost is treated as a secure context)

## Setup and run

1. In PowerShell, set up the backend environment:

   ```powershell
   cd backend
   py -3.12 -m venv venv
   .\venv\Scripts\Activate.ps1
   python -m pip install -r requirements.txt
   Copy-Item .env.example .env
   # Edit .env and add the real credentials before starting the server.
   uvicorn main:app --port 8000
   ```

2. In a second PowerShell window, start the frontend:

   ```powershell
   cd frontend
   npm.cmd install
   npm.cmd run dev
   ```

3. Open the Vite URL shown in the frontend terminal, select **Try Call**, and allow microphone access.

The backend also provides `GET /api/health`, `GET /api/state`, `/ws/voice` for audio/text calls, and `/ws/events` for dashboard synchronization. The SQLite database is created as `backend/clinic.db` and seeded with sample doctors and appointment slots on first run.

## Architecture

- **Frontend:** React, TypeScript, Vite, and TailwindCSS. `useVoiceCall` uses browser speech recognition when available and sends finalized transcripts as `USER_TEXT` messages to `/ws/voice`; browsers without that API fall back to microphone capture and 16 kHz mono PCM for backend STT. The phone modal also accepts typed messages. Returned PCM is played in the browser, with browser speech synthesis as the fallback when TTS returns no audio.
- **Backend:** FastAPI and Pipecat 1.17 connect WebSocket transport, Silero VAD, ElevenLabs STT/TTS, Gemini, and transcript processors. Gemini models are discovered and probed at startup, then transient unavailable/timeout failures trigger model recovery.
- **Clinic data:** `backend/store.py` persists doctors, slots, and appointments in SQLite. Appointment tools publish the updated state to connected `/ws/events` clients; the dashboard reconnects when that socket closes.

## Sample call

> Caller: “Do you have a cardiologist tomorrow?”  
> Maya: “Dr. Vikram Mehta has openings at 9:30 AM and 2:00 PM. Which works for you?”  
> Caller: “Book 2 PM. My phone number is 9876543210.”  
> Maya: “I have 9 8 7 6 5 4 3 2 1 0. Is that the right number?”  
> Caller: “Yes.”  
> Maya: “You’re booked with Dr. Vikram Mehta tomorrow at 2:00 PM.”

To cancel, Maya asks for the spoken phone number, reads it back for confirmation, then cancels the matching active appointment.
