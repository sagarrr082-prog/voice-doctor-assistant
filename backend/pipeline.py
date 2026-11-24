import asyncio
from concurrent.futures import ThreadPoolExecutor
import inspect
import os
import traceback
from typing import Any, Awaitable, Callable, Dict, Optional
import aiohttp
from fastapi import WebSocket

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    Frame,
    LLMFullResponseEndFrame,
    LLMRunFrame,
    TextFrame,
    TranscriptionFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.elevenlabs.stt import ElevenLabsSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.google.llm import GoogleLLMService

try:
    from pipecat.audio.vad.vad_analyzer import VADParams
except ImportError:
    try:
        from pipecat.audio.vad.silero import VADParams
    except ImportError:
        VADParams = None

try:
    from google import genai
    from google.genai import types as genai_types
except ImportError:
    genai = None
    genai_types = None

try:
    from pipecat.transports.websocket.fastapi import (
        FastAPIWebsocketParams,
        FastAPIWebsocketTransport,
    )
except ImportError:
    from pipecat.transports.network.fastapi_websocket import (
        FastAPIWebsocketParams,
        FastAPIWebsocketTransport,
    )

from serializer import RawPCMFrameSerializer
from tools import TOOLS_SCHEMA, register_clinic_tools

SYSTEM_PROMPT = """
You are Maya, the friendly, efficient voice receptionist at Solaris Clinic.
You help callers find doctors, check appointment slots, book appointments, and cancel existing appointments in one seamless conversation.

CRITICAL RULES:
1. Identify callers ONLY by the phone number they speak aloud. Never ask for OTPs, login credentials, or email addresses.
2. Before calling `book_appointment` or `cancel_appointment`, you MUST repeat the caller's phone number back to them clearly (e.g., "nine eight seven six, five four three, two one zero") and ask them to confirm that the number is right. Only invoke the tool after they confirm.
3. Keep every spoken reply concise (1 to 3 short sentences), natural, and free of markdown, bullet points, or asterisks.
4. When listing available doctors or slots, mention 2 or 3 clear options so the caller can pick easily.
5. Use `get_available_doctors` to find doctors, `get_available_slots` to find open times, `book_appointment` to reserve a confirmed selection, and `cancel_appointment` to cancel an appointment.
"""

_CACHED_WORKING_MODEL: Optional[str] = None
_FAILED_MODELS: set[str] = set()


def _get_candidate_models(api_key: str, preferred: Optional[str]) -> list[str]:
    discovered: list[str] = []
    if genai is not None:
        try:
            client = genai.Client(api_key=api_key)
            for m in client.models.list():
                name = (getattr(m, "name", "") or "").replace("models/", "")
                methods = (
                    getattr(m, "supported_generation_methods", None)
                    or getattr(m, "supported_actions", None)
                    or []
                )
                if (
                    "gemini" in name
                    and not any(
                        bad in name
                        for bad in ("tts", "image", "audio", "embedding", "aqa", "omni", "robotics", "exp")
                    )
                    and "generateContent" in methods
                ):
                    discovered.append(name)
        except Exception as exc:
            print(f"[Model List Warning]: {exc}")

    # Prioritize Flash models that actually exist on this API key
    flash_lite = sorted([m for m in discovered if "flash" in m and "lite" in m], reverse=True)
    flash_std = sorted([m for m in discovered if "flash" in m and "lite" not in m], reverse=True)
    other_models = sorted([m for m in discovered if "flash" not in m], reverse=True)

    ordered: list[str] = []
    for candidate in ([preferred] if preferred else []) + flash_lite + flash_std + other_models + (["gemini-2.5-flash"] if not discovered else []):
        if candidate and candidate not in ordered and candidate not in _FAILED_MODELS:
            ordered.append(candidate)

    if not ordered:
        _FAILED_MODELS.clear()
        ordered = discovered[:5] if discovered else ["gemini-2.5-flash"]
    return ordered


def _probe_single_model(api_key: str, model_name: str) -> bool:
    if genai is None:
        return True
    try:
        client = genai.Client(api_key=api_key)
        resp = client.models.generate_content(
            model=model_name,
            contents="Say hello in two words.",
        )
        return bool(getattr(resp, "text", "").strip())
    except Exception as exc:
        print(f"[Model Probe] {model_name} failed: {str(exc)[:120]}")
        return False


def _select_working_gemini_model(api_key: str, preferred: Optional[str]) -> str:
    global _CACHED_WORKING_MODEL
    if _CACHED_WORKING_MODEL and _CACHED_WORKING_MODEL not in _FAILED_MODELS:
        return _CACHED_WORKING_MODEL

    candidates = _get_candidate_models(api_key, preferred)
    print(f"[LLM Probe]: Testing discovered models {candidates[:8]}...")

    for model_name in candidates:
        executor = ThreadPoolExecutor(max_workers=1)
        future = executor.submit(_probe_single_model, api_key, model_name)
        try:
            ok = future.result(timeout=8.0)
            executor.shutdown(wait=False)
            if ok:
                _CACHED_WORKING_MODEL = model_name
                print(f"[LLM Selected]: {model_name} passed live probe")
                return model_name
            _FAILED_MODELS.add(model_name)
        except Exception:
            executor.shutdown(wait=False)
            _FAILED_MODELS.add(model_name)
            print(f"[Model Probe] {model_name} timed out (>8s), skipping...")

    fallback = candidates[0]
    print(f"[LLM Warning]: No probe succeeded, trying {fallback}")
    return fallback


def _build_google_llm(api_key: str, model_name: str) -> GoogleLLMService:
    try:
        if hasattr(GoogleLLMService, "InputParams") and genai_types is not None:
            sig = inspect.signature(GoogleLLMService.InputParams)
            if "thinking" in sig.parameters:
                params = GoogleLLMService.InputParams(
                    thinking=genai_types.ThinkingConfig(thinking_budget=0)
                )
                return GoogleLLMService(api_key=api_key, model=model_name, params=params)
    except Exception as exc:
        print(f"[LLM Config Note]: Using default params ({exc})")
    return GoogleLLMService(api_key=api_key, model=model_name)


class UserTranscriptProcessor(FrameProcessor):
    """Placed after STT to broadcast voice and typed caller transcripts."""

    def __init__(
        self,
        broadcast_event: Callable[[Dict[str, Any]], Awaitable[None]],
    ):
        super().__init__()
        self._broadcast_event = broadcast_event

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        frame_name = frame.__class__.__name__
        if frame_name == "UserStartedSpeakingFrame":
            print("[VAD]: User started speaking")
        elif frame_name == "UserStoppedSpeakingFrame":
            print("[VAD]: User stopped speaking -> sending audio to STT")
        elif isinstance(frame, TranscriptionFrame) and frame.text.strip():
            clean_text = frame.text.strip()
            print(f"[STT User]: {clean_text}")
            await self._broadcast_event(
                {
                    "type": "TRANSCRIPT",
                    "role": "user",
                    "text": clean_text,
                }
            )
        await self.push_frame(frame, direction)


class AssistantTranscriptProcessor(FrameProcessor):
    """Placed right after LLM: captures Maya's generated text before TTS."""

    def __init__(
        self,
        broadcast_event: Callable[[Dict[str, Any]], Awaitable[None]],
        llm_service: GoogleLLMService,
        api_key: str,
        initial_model: str,
    ):
        super().__init__()
        self._broadcast_event = broadcast_event
        self._assistant_buffer: list[str] = []
        self._llm = llm_service
        self._api_key = api_key
        self._current_model = initial_model
        self._task: Optional[PipelineTask] = None
        self._retry_count = 0

    def set_task(self, task: PipelineTask) -> None:
        self._task = task

    async def _recover_llm(self) -> None:
        global _CACHED_WORKING_MODEL
        _FAILED_MODELS.add(self._current_model)
        _CACHED_WORKING_MODEL = None
        await asyncio.sleep(0.5)
        next_model = await asyncio.to_thread(_select_working_gemini_model, self._api_key, None)
        if next_model and next_model != self._current_model:
            self._current_model = next_model
            if hasattr(self._llm, "set_model_name"):
                self._llm.set_model_name(next_model)
            if hasattr(self._llm, "_model_name"):
                self._llm._model_name = next_model
            print(f"[LLM Recovered]: Switched active call to {next_model}")
        if self._task is not None:
            await self._task.queue_frames([LLMRunFrame()])

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, TextFrame) and direction == FrameDirection.DOWNSTREAM:
            self._assistant_buffer.append(frame.text)
        elif isinstance(frame, LLMFullResponseEndFrame):
            full_text = "".join(self._assistant_buffer).strip()
            self._assistant_buffer.clear()
            if full_text:
                print(f"[LLM Maya]: {full_text}")
                await self._broadcast_event(
                    {
                        "type": "TRANSCRIPT",
                        "role": "assistant",
                        "text": full_text,
                    }
                )
        elif frame.__class__.__name__ == "ErrorFrame":
            err_text = str(getattr(frame, "error", ""))
            if "completed with no audio" in err_text:
                print(f"[TTS Notice]: {err_text} (browser voice fallback active)")
            else:
                print(f"[Pipeline Error]: {err_text}")
                if any(k in err_text.lower() for k in ("503", "unavailable", "timeout", "timed out")) and self._retry_count < 4:
                    self._retry_count += 1
                    asyncio.create_task(self._recover_llm())
                else:
                    await self._broadcast_event({"type": "TRANSCRIPT", "role": "assistant", "text": f"[Pipeline Notice]: {err_text[:160]}"})

        await self.push_frame(frame, direction)


async def run_voice_session(
    websocket: WebSocket,
    broadcast_event: Callable[[Dict[str, Any]], Awaitable[None]],
) -> None:
    try:
        gemini_key = os.environ["GEMINI_API_KEY"]
        preferred_model = os.getenv("GEMINI_MODEL")
        active_model = await asyncio.to_thread(
            _select_working_gemini_model, gemini_key, preferred_model
        )

        vad_analyzer = (
            SileroVADAnalyzer(
                params=VADParams(
                    confidence=0.5,
                    start_secs=0.15,
                    stop_secs=0.6,
                    min_volume=0.05,
                )
            )
            if VADParams is not None
            else SileroVADAnalyzer()
        )

        async with aiohttp.ClientSession() as session:
            transport = FastAPIWebsocketTransport(
                websocket=websocket,
                params=FastAPIWebsocketParams(
                    audio_in_enabled=True,
                    audio_out_enabled=True,
                    add_wav_header=False,
                    vad_analyzer=vad_analyzer,
                    serializer=RawPCMFrameSerializer(sample_rate=16000, num_channels=1),
                ),
            )

            stt_sig = inspect.signature(ElevenLabsSTTService.__init__).parameters
            stt_kwargs: Dict[str, Any] = {"api_key": os.environ["ELEVENLABS_API_KEY"]}
            if "aiohttp_session" in stt_sig:
                stt_kwargs["aiohttp_session"] = session
            stt = ElevenLabsSTTService(**stt_kwargs)

            tts_sig = inspect.signature(ElevenLabsTTSService.__init__).parameters
            tts_kwargs: Dict[str, Any] = {
                "api_key": os.environ["ELEVENLABS_API_KEY"],
                "voice_id": os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
            }
            if "aiohttp_session" in tts_sig:
                tts_kwargs["aiohttp_session"] = session
            if "model" in tts_sig:
                tts_kwargs["model"] = "eleven_flash_v2_5"
            tts = ElevenLabsTTSService(**tts_kwargs)

            llm = _build_google_llm(gemini_key, active_model)

            register_clinic_tools(llm, broadcast_event)

            context = LLMContext(
                messages=[{"role": "system", "content": SYSTEM_PROMPT}],
                tools=TOOLS_SCHEMA,
            )
            context_aggregator = LLMContextAggregatorPair(context)
            user_transcript_tap = UserTranscriptProcessor(
                broadcast_event=broadcast_event,
            )
            assistant_transcript_tap = AssistantTranscriptProcessor(
                broadcast_event, llm, gemini_key, active_model
            )

            pipeline = Pipeline(
                [
                    transport.input(),
                    stt,
                    user_transcript_tap,
                    context_aggregator.user(),
                    llm,
                    assistant_transcript_tap,
                    tts,
                    transport.output(),
                    context_aggregator.assistant(),
                ]
            )

            task = PipelineTask(
                pipeline,
                params=PipelineParams(
                    allow_interruptions=True,
                    audio_in_sample_rate=16000,
                    audio_out_sample_rate=16000,
                ),
            )
            assistant_transcript_tap.set_task(task)

            @transport.event_handler("on_client_connected")
            async def on_client_connected(transport, client):
                print("[Voice Session]: Client connected, triggering Maya greeting...")
                await broadcast_event({"type": "CALL_STATUS", "status": "connected"})
                context.add_message(
                    {
                        "role": "user",
                        "content": "Hello, I just called Solaris Clinic.",
                    }
                )
                await task.queue_frames([LLMRunFrame()])

            @transport.event_handler("on_client_disconnected")
            async def on_client_disconnected(transport, client):
                print("[Voice Session]: Client disconnected.")
                await broadcast_event({"type": "CALL_STATUS", "status": "ended"})
                await task.cancel()

            runner = PipelineRunner(handle_sigint=False)
            await runner.run(task)
    except Exception:
        traceback.print_exc()
        raise
