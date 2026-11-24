import json
from typing import Optional
from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    OutputAudioRawFrame,
    TranscriptionFrame,
)
from pipecat.serializers.base_serializer import FrameSerializer


class RawPCMFrameSerializer(FrameSerializer):
    def __init__(self, sample_rate: int = 16000, num_channels: int = 1):
        self._sample_rate = sample_rate
        self._num_channels = num_channels

    async def serialize(self, frame: Frame) -> Optional[str | bytes]:
        if isinstance(frame, OutputAudioRawFrame):
            return frame.audio
        if frame.__class__.__name__ in ("InterruptionFrame", "StartInterruptionFrame"):
            return json.dumps({"type": "CLEAR_AUDIO"})
        return None

    async def deserialize(self, data: str | bytes) -> Optional[Frame]:
        if isinstance(data, bytes):
            if not data:
                return None
            return InputAudioRawFrame(
                audio=data,
                sample_rate=self._sample_rate,
                num_channels=self._num_channels,
            )
        try:
            payload = json.loads(data)
        except (TypeError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict) or payload.get("type") != "USER_TEXT":
            return None
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            return None
        from datetime import datetime, timezone

        return TranscriptionFrame(
            text=text.strip(),
            user_id="web-caller",
            timestamp=datetime.now(timezone.utc).isoformat(),
            finalized=True,
        )
