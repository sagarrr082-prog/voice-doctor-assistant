import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

DB_PATH = Path(__file__).parent / "clinic.db"


def normalize_phone(phone: str) -> str:
    """Normalize numeric or individually spoken phone digits from speech recognition."""
    raw = phone or ""
    digits = re.sub(r"\D", "", raw)
    if not digits:
        digit_words = {
            "zero": "0", "oh": "0", "one": "1", "two": "2", "three": "3",
            "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
        }
        digits = "".join(digit_words[word] for word in re.findall(r"[a-z]+", raw.lower()) if word in digit_words)
    if len(digits) > 10:
        digits = digits[-10:]
    return digits


class ClinicStore:
    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = str(db_path)
        self._lock = threading.Lock()
        self._init_db()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self._lock, self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS doctors (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    specialty TEXT NOT NULL,
                    room TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS slots (
                    id TEXT PRIMARY KEY,
                    doctor_id TEXT NOT NULL,
                    date TEXT NOT NULL,
                    time_slot TEXT NOT NULL,
                    is_booked INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY (doctor_id) REFERENCES doctors(id)
                );

                CREATE TABLE IF NOT EXISTS appointments (
                    id TEXT PRIMARY KEY,
                    phone_number TEXT NOT NULL,
                    patient_name TEXT NOT NULL,
                    doctor_id TEXT NOT NULL,
                    doctor_name TEXT NOT NULL,
                    specialty TEXT NOT NULL,
                    date TEXT NOT NULL,
                    time_slot TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'CONFIRMED',
                    created_at TEXT NOT NULL
                );
                """
            )

            count = conn.execute("SELECT COUNT(*) FROM doctors").fetchone()[0]
            if count == 0:
                self._seed_data(conn)

    def _seed_data(self, conn: sqlite3.Connection) -> None:
        doctors = [
            ("doc_1", "Dr. Ananya Sharma", "General Medicine", "Suite 102"),
            ("doc_2", "Dr. Vikram Mehta", "Cardiology", "Suite 204"),
            ("doc_3", "Dr. Priya Nair", "Dermatology", "Suite 108"),
            ("doc_4", "Dr. Rohan Kapoor", "Orthopedics", "Suite 301"),
        ]
        conn.executemany(
            "INSERT INTO doctors (id, name, specialty, room) VALUES (?, ?, ?, ?)",
            doctors,
        )

        slots = [
            ("slot_1", "doc_1", "Tomorrow", "10:00 AM", 0),
            ("slot_2", "doc_1", "Tomorrow", "11:30 AM", 0),
            ("slot_3", "doc_1", "Tomorrow", "04:00 PM", 0),
            ("slot_4", "doc_2", "Tomorrow", "09:30 AM", 0),
            ("slot_5", "doc_2", "Tomorrow", "02:00 PM", 0),
            ("slot_6", "doc_3", "Tomorrow", "11:00 AM", 0),
            ("slot_7", "doc_3", "Tomorrow", "03:30 PM", 0),
            ("slot_8", "doc_4", "Tomorrow", "10:30 AM", 0),
            ("slot_9", "doc_4", "Tomorrow", "05:00 PM", 0),
        ]
        conn.executemany(
            "INSERT INTO slots (id, doctor_id, date, time_slot, is_booked) VALUES (?, ?, ?, ?, ?)",
            slots,
        )

    def get_dashboard_state(self) -> Dict[str, Any]:
        with self._lock, self._connect() as conn:
            docs = [dict(row) for row in conn.execute("SELECT * FROM doctors").fetchall()]
            all_slots = [dict(row) for row in conn.execute("SELECT * FROM slots").fetchall()]

            for doc in docs:
                doc["slots"] = [
                    {
                        "id": s["id"],
                        "date": s["date"],
                        "time_slot": s["time_slot"],
                        "is_booked": bool(s["is_booked"]),
                    }
                    for s in all_slots
                    if s["doctor_id"] == doc["id"]
                ]

            appointments = [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM appointments ORDER BY created_at DESC"
                ).fetchall()
            ]
            return {"doctors": docs, "appointments": appointments}

    def get_available_doctors(self, specialty: Optional[str] = None) -> List[Dict[str, Any]]:
        with self._lock, self._connect() as conn:
            query = "SELECT id, name, specialty, room FROM doctors"
            params: List[Any] = []
            if specialty:
                query += " WHERE LOWER(specialty) LIKE ?"
                params.append(f"%{specialty.lower().strip()}%")
            query += " ORDER BY name"
            return [dict(row) for row in conn.execute(query, params).fetchall()]

    def get_available_slots(
        self,
        doctor_name: Optional[str] = None,
        specialty: Optional[str] = None,
        date: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        with self._lock, self._connect() as conn:
            query = """
                SELECT d.name AS doctor_name, d.specialty, d.room, s.date, s.time_slot
                FROM slots s
                JOIN doctors d ON s.doctor_id = d.id
                WHERE s.is_booked = 0
            """
            params: List[Any] = []
            if doctor_name:
                query += " AND LOWER(d.name) LIKE ?"
                params.append(f"%{doctor_name.lower().strip()}%")
            if specialty:
                query += " AND LOWER(d.specialty) LIKE ?"
                params.append(f"%{specialty.lower().strip()}%")
            if date:
                query += " AND LOWER(s.date) LIKE ?"
                params.append(f"%{date.lower().strip()}%")

            rows = conn.execute(query, params).fetchall()
            return [dict(r) for r in rows]

    def book_appointment(
        self,
        phone_number: str,
        doctor_name: str,
        time_slot: str,
        date: str = "Tomorrow",
        patient_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        clean_phone = normalize_phone(phone_number)
        if len(clean_phone) < 7:
            return {
                "success": False,
                "error": "Invalid phone number. Please ask the caller for a valid phone number.",
            }

        with self._lock, self._connect() as conn:
            row = conn.execute(
                """
                SELECT s.id AS slot_id, s.date, s.time_slot, s.is_booked,
                       d.id AS doctor_id, d.name AS doctor_name, d.specialty
                FROM slots s
                JOIN doctors d ON s.doctor_id = d.id
                WHERE LOWER(d.name) LIKE ?
                  AND LOWER(s.time_slot) LIKE ?
                  AND LOWER(s.date) LIKE ?
                  AND s.is_booked = 0
                ORDER BY s.date, s.time_slot
                LIMIT 1
                """,
                (f"%{doctor_name.lower().strip()}%", f"%{time_slot.lower().strip()}%", f"%{(date or 'Tomorrow').lower().strip()}%"),
            ).fetchone()

            if not row:
                return {
                    "success": False,
                    "error": f"No matching slot found for {doctor_name} at {time_slot}.",
                }
            if row["is_booked"]:
                return {
                    "success": False,
                    "error": f"Sorry, {row['doctor_name']} at {row['time_slot']} is already booked.",
                }

            conn.execute("UPDATE slots SET is_booked = 1 WHERE id = ?", (row["slot_id"],))

            appt_id = f"APT-{uuid.uuid4().hex[:6].upper()}"
            created_at = datetime.utcnow().isoformat() + "Z"
            display_name = (patient_name or "Walk-in Caller").strip()

            conn.execute(
                """
                INSERT INTO appointments
                (id, phone_number, patient_name, doctor_id, doctor_name, specialty, date, time_slot, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?)
                """,
                (
                    appt_id,
                    clean_phone,
                    display_name,
                    row["doctor_id"],
                    row["doctor_name"],
                    row["specialty"],
                    row["date"],
                    row["time_slot"],
                    created_at,
                ),
            )

            appointment = {
                "id": appt_id,
                "phone_number": clean_phone,
                "patient_name": display_name,
                "doctor_id": row["doctor_id"],
                "doctor_name": row["doctor_name"],
                "specialty": row["specialty"],
                "date": row["date"],
                "time_slot": row["time_slot"],
                "status": "CONFIRMED",
                "created_at": created_at,
            }
            return {"success": True, "appointment": appointment}

    def cancel_appointment(
        self,
        phone_number: str,
        doctor_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        clean_phone = normalize_phone(phone_number)
        with self._lock, self._connect() as conn:
            query = """
                SELECT * FROM appointments
                WHERE phone_number = ? AND status = 'CONFIRMED'
            """
            params: List[Any] = [clean_phone]
            if doctor_name:
                query += " AND LOWER(doctor_name) LIKE ?"
                params.append(f"%{doctor_name.lower().strip()}%")
            query += " ORDER BY created_at DESC LIMIT 1"

            appt = conn.execute(query, params).fetchone()
            if not appt:
                return {
                    "success": False,
                    "error": f"No active appointment found under phone number {clean_phone}.",
                }

            conn.execute(
                "UPDATE appointments SET status = 'CANCELLED' WHERE id = ?",
                (appt["id"],),
            )
            conn.execute(
                """
                UPDATE slots SET is_booked = 0
                WHERE doctor_id = ? AND time_slot = ? AND date = ?
                """,
                (appt["doctor_id"], appt["time_slot"], appt["date"]),
            )

            cancelled_record = dict(appt)
            cancelled_record["status"] = "CANCELLED"
            return {"success": True, "appointment": cancelled_record}


store = ClinicStore()
