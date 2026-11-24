from typing import Any, Awaitable, Callable, Dict
try:
    from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
    from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema
except ImportError:
    from pipecat.adapters.schemas.function_schema import FunctionSchema
    from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.services.llm_service import FunctionCallParams
from store import store

available_doctors_fn = FunctionSchema(
    name="get_available_doctors",
    description="List clinic doctors, optionally filtered by medical specialty.",
    properties={"specialty": {"type": "string", "description": "Optional medical specialty."}},
    required=[],
)

available_slots_fn = FunctionSchema(
    name="get_available_slots",
    description="Find open appointment slots by doctor name, specialty, or date.",
    properties={
        "doctor_name": {
            "type": "string",
            "description": "Doctor's name, e.g. 'Dr. Ananya Sharma' or 'Sharma'.",
        },
        "specialty": {
            "type": "string",
            "description": "Medical specialty, e.g. 'Cardiology', 'Dermatology', 'General Medicine', 'Orthopedics'.",
        },
        "date": {
            "type": "string",
            "description": "Day or date requested, e.g. 'Tomorrow'.",
        },
    },
    required=[],
)

book_appointment_fn = FunctionSchema(
    name="book_appointment",
    description="Book an available doctor appointment slot using the caller's confirmed spoken phone number.",
    properties={
        "phone_number": {
            "type": "string",
            "description": "The caller's phone number after reading it back and receiving confirmation.",
        },
        "doctor_name": {
            "type": "string",
            "description": "The full or partial name of the selected doctor.",
        },
        "time_slot": {
            "type": "string",
            "description": "The exact slot time, e.g. '10:00 AM' or '02:00 PM'.",
        },
        "date": {
            "type": "string",
            "description": "Appointment day, defaults to 'Tomorrow'.",
        },
        "patient_name": {
            "type": "string",
            "description": "Optional name if the caller mentioned it.",
        },
    },
    required=["phone_number", "doctor_name", "time_slot"],
)

cancel_appointment_fn = FunctionSchema(
    name="cancel_appointment",
    description="Cancel an existing confirmed appointment found by the caller's confirmed spoken phone number.",
    properties={
        "phone_number": {
            "type": "string",
            "description": "The caller's phone number after reading it back and receiving confirmation.",
        },
        "doctor_name": {
            "type": "string",
            "description": "Optional doctor name if the caller has multiple appointments.",
        },
    },
    required=["phone_number"],
)

TOOLS_SCHEMA = ToolsSchema(
    standard_tools=[
        available_doctors_fn,
        available_slots_fn,
        book_appointment_fn,
        cancel_appointment_fn,
    ]
)


def register_clinic_tools(
    llm: Any,
    broadcast_event: Callable[[Dict[str, Any]], Awaitable[None]],
) -> None:
    async def handle_available_doctors(params: FunctionCallParams):
        args = params.arguments or {}
        doctors = store.get_available_doctors(specialty=args.get("specialty"))
        await params.result_callback({"doctors": doctors, "count": len(doctors)})

    async def handle_available_slots(params: FunctionCallParams):
        args = params.arguments or {}
        slots = store.get_available_slots(
            doctor_name=args.get("doctor_name"),
            specialty=args.get("specialty"),
            date=args.get("date"),
        )
        await params.result_callback(
            {
                "available_slots": slots,
                "count": len(slots),
            }
        )

    async def handle_book_appointment(params: FunctionCallParams):
        args = params.arguments or {}
        result = store.book_appointment(
            phone_number=args.get("phone_number", ""),
            doctor_name=args.get("doctor_name", ""),
            time_slot=args.get("time_slot", ""),
            date=args.get("date", "Tomorrow"),
            patient_name=args.get("patient_name"),
        )
        if result.get("success"):
            await broadcast_event(
                {
                    "type": "APPOINTMENT_BOOKED",
                    "appointment": result["appointment"],
                    "state": store.get_dashboard_state(),
                }
            )
        await params.result_callback(result)

    async def handle_cancel_appointment(params: FunctionCallParams):
        args = params.arguments or {}
        result = store.cancel_appointment(
            phone_number=args.get("phone_number", ""),
            doctor_name=args.get("doctor_name"),
        )
        if result.get("success"):
            await broadcast_event(
                {
                    "type": "APPOINTMENT_CANCELLED",
                    "appointment": result["appointment"],
                    "state": store.get_dashboard_state(),
                }
            )
        await params.result_callback(result)

    llm.register_function("get_available_doctors", handle_available_doctors)
    llm.register_function("get_available_slots", handle_available_slots)
    llm.register_function("book_appointment", handle_book_appointment)
    llm.register_function("cancel_appointment", handle_cancel_appointment)
