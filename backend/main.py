import asyncio
import json
import os
from typing import Any, Dict, Set

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from pipeline import _select_working_gemini_model, run_voice_session
from store import store

load_dotenv()

app = FastAPI(title="Solaris Voice AI Appointment Assistant")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

event_clients: Set[WebSocket] = set()


@app.on_event("startup")
async def warm_gemini_model() -> None:
    """Probe Gemini while the app starts so the first call avoids the warm-up delay."""
    api_key = os.getenv("GEMINI_API_KEY")
    if api_key:
        app.state.gemini_model_warmup = asyncio.create_task(
            asyncio.to_thread(
                _select_working_gemini_model,
                api_key,
                os.getenv("GEMINI_MODEL"),
            )
        )


async def broadcast_event(payload: Dict[str, Any]) -> None:
    if not event_clients:
        return
    message = json.dumps(payload)
    stale: list[WebSocket] = []
    for ws in list(event_clients):
        try:
            await ws.send_text(message)
        except Exception:
            stale.append(ws)
    for ws in stale:
        event_clients.discard(ws)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/state")
async def get_state():
    return store.get_dashboard_state()


@app.websocket("/ws/events")
async def events_endpoint(websocket: WebSocket):
    await websocket.accept()
    event_clients.add(websocket)
    try:
        await websocket.send_text(
            json.dumps({"type": "INIT_STATE", "state": store.get_dashboard_state()})
        )
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        event_clients.discard(websocket)
    except Exception:
        event_clients.discard(websocket)


@app.websocket("/ws/voice")
async def voice_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        warmup = getattr(app.state, "gemini_model_warmup", None)
        if warmup is not None:
            try:
                await warmup
            except Exception as exc:
                print(f"[LLM Warmup Warning]: {exc}")
        await run_voice_session(websocket, broadcast_event)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[Voice Session Error] {exc}")
        await broadcast_event({"type": "CALL_STATUS", "status": "ended"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", 8000)), reload=True)
