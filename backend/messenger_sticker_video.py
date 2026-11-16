"""Bounded, silent animated WebP conversion for the sticker editor."""
import asyncio
import json
import math
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from starlette.datastructures import Headers

from messenger_core import administrator, chat_user, member
from messenger_files import MAX_BYTES, store

api = APIRouter()
conversion_slots = asyncio.Semaphore(2)


async def run_media(*args):
    process = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 45)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        process.kill()
        await process.communicate()
        raise
    if process.returncode:
        raise HTTPException(400, "Cette vidéo ne peut pas être convertie en sticker.")
    return stdout


@api.post("/conversations/{cid}/stickers/video")
async def video_sticker(
    cid: str, request: Request,
    file: UploadFile = File(...),
    start: float = Form(default=0, ge=0),
    duration: float = Form(default=3, gt=0, le=6),
    user=Depends(chat_user),
):
    conv = await member(request.app.state.db, cid, user)
    if conv["kind"] == "channel" or (
        conv["kind"] == "group" and (conv.get("permissions") or {}).get("send_messages") == "admins"
    ):
        administrator(conv, user)
    if not math.isfinite(start) or not math.isfinite(duration):
        raise HTTPException(400, "L’extrait sélectionné est invalide.")
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise HTTPException(503, "La création de stickers vidéo nécessite FFmpeg et FFprobe sur le serveur.")
    async with conversion_slots:
        with tempfile.TemporaryDirectory(prefix="spv-sticker-") as folder:
            source, target = Path(folder) / "source", Path(folder) / "sticker.webp"
            try:
                size = 0
                with source.open("wb") as output:
                    while chunk := await file.read(65536):
                        size += len(chunk)
                        if size > MAX_BYTES:
                            raise HTTPException(413, "La vidéo dépasse 20 Mo.")
                        output.write(chunk)
                metadata = json.loads(await run_media(
                    "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
                    "-show_format", "-show_streams", "-of", "json", str(source),
                ))
                video = next((s for s in metadata.get("streams", []) if s.get("codec_type") == "video"), None)
                total = float(metadata.get("format", {}).get("duration") or (video or {}).get("duration") or 0)
                if not video or not math.isfinite(total) or total <= 0 or start >= total:
                    raise HTTPException(400, "La vidéo ou le début de l’extrait est invalide.")
                duration = min(duration, total - start)
                await run_media(
                    "ffmpeg", "-v", "error", "-nostdin", "-threads", "1",
                    "-protocol_whitelist", "file,pipe", "-ss", str(start), "-i", str(source),
                    "-t", str(duration), "-an", "-map", "0:v:0",
                    "-vf", "fps=12,scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
                    "-c:v", "libwebp_anim", "-threads", "1", "-q:v", "70",
                    "-loop", "0", "-vsync", "0", "-y", str(target),
                )
                with target.open("rb") as rendered:
                    return await store(
                        request, user,
                        UploadFile(file=rendered, filename="sticker-anime.webp", headers=Headers({"content-type": "image/webp"})),
                        cid, sticker=True,
                    )
            except asyncio.TimeoutError:
                raise HTTPException(422, "La conversion a pris trop de temps. Choisissez une vidéo plus courte.")
            finally:
                await file.close()
