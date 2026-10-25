"""WebRTC signalling relay for the smartphone secondary camera.

The interview room (host) and the phone (guest) both open a WebSocket keyed by
the session's short-lived pair token.  Messages are relayed to every *other*
client in that room; no media travels through the server (P2P WebRTC).
"""
from __future__ import annotations

import asyncio
import json
from typing import Dict, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..db import SessionLocal
from ..db import InterviewSession

router = APIRouter(tags=["rtc"])

ROOMS: Dict[str, Set[WebSocket]] = {}
_LOCK = asyncio.Lock()


def _token_from(token: str) -> str:
    return (token or "").strip()[:64]


async def _join(token: str, ws: WebSocket) -> None:
    async with _LOCK:
        ROOMS.setdefault(token, set()).add(ws)


async def _leave(token: str, ws: WebSocket) -> None:
    async with _LOCK:
        room = ROOMS.get(token)
        if room:
            room.discard(ws)
            if not room:
                ROOMS.pop(token, None)


def _valid_token(token: str) -> bool:
    """Only allow signalling for a real, unfinished session."""
    db = SessionLocal()
    try:
        row = (db.query(InterviewSession)
               .filter(InterviewSession.pair_token == token).first())
        return row is not None and row.status != "completed"
    finally:
        db.close()


@router.websocket("/ws/rtc/{token}")
async def rtc(websocket: WebSocket, token: str, role: str = "guest"):
    token = _token_from(token)
    if not token or not _valid_token(token):
        await websocket.close(code=4404)
        return

    await websocket.accept()
    await _join(token, websocket)

    # Tell the newcomer how many peers are already waiting so the host knows a
    # phone connected (and can log the event).
    async with _LOCK:
        peers = [ws for ws in ROOMS.get(token, set()) if ws is not websocket]
    await websocket.send_text(json.dumps({
        "type": "peers", "count": len(peers), "role": role,
    }))
    for peer in peers:
        try:
            await peer.send_text(json.dumps({
                "type": "peer_joined", "role": role,
            }))
        except Exception:  # noqa: BLE001
            pass

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            msg.setdefault("from", role)
            payload = json.dumps(msg)
            async with _LOCK:
                targets = [ws for ws in ROOMS.get(token, set())
                           if ws is not websocket]
            for target in targets:
                try:
                    await target.send_text(payload)
                except Exception:  # noqa: BLE001
                    pass
    except WebSocketDisconnect:
        pass
    finally:
        await _leave(token, websocket)
        async with _LOCK:
            remaining = list(ROOMS.get(token, set()))
        for peer in remaining:
            try:
                await peer.send_text(json.dumps({
                    "type": "peer_left", "role": role,
                }))
            except Exception:  # noqa: BLE001
                pass
