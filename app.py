import os
import sqlite3
import tempfile
import shutil
import uuid
import threading
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, request, jsonify, send_file, render_template
from yt_dlp import YoutubeDL

# ---------- Configuration ----------
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "downloads.db")
FFMPEG_BIN = r"C:\Users\Asus\Downloads\ffmpeg-2025-12-04-git-d6458f6a8b-full_build\ffmpeg\bin"
MAX_WORKERS = 3

os.makedirs(os.path.join(BASE_DIR, "data"), exist_ok=True)

# ---------- Simple SQLite history ----------
def init_db():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("""
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        title TEXT,
        url TEXT,
        filename TEXT,
        status TEXT,
        quality TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    """)
    conn.commit()
    conn.close()

def save_history(item):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("INSERT OR REPLACE INTO history (id,title,url,filename,status,quality) VALUES (?,?,?,?,?,?)",
                (item['id'], item.get('title'), item.get('url'), item.get('filename'), item.get('status'), item.get('quality')))
    conn.commit()
    conn.close()

def get_history():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT id,title,url,filename,status,quality,created_at FROM history ORDER BY created_at DESC LIMIT 50")
    rows = cur.fetchall()
    conn.close()
    keys = ['id','title','url','filename','status','quality','created_at']
    return [dict(zip(keys, r)) for r in rows]

# ---------- Task management (in-memory progress) ----------
tasks = {}  # task_id -> {status, progress, tmpdir, final_path, title, url, quality}
cancelled_tasks = set()
tasks_lock = threading.Lock()
executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)

app = Flask(__name__)
init_db()

def _update_task(task_id, **kwargs):
    with tasks_lock:
        t = tasks.setdefault(task_id, {})
        t.update(kwargs)

def _progress_hook_factory(task_id):
    def hook(d):
        if d.get('status') == 'downloading':
            if task_id in cancelled_tasks:
             raise Exception("Download Cancelled")
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
            downloaded = d.get('downloaded_bytes') or 0
            pct = 0
            if total:
                pct = int(downloaded * 100 / total)
            _update_task(task_id, progress=pct, eta=d.get('eta'))
        elif d.get('status') == 'finished':
            _update_task(task_id, progress=100)
    return hook

def download_job(task_id, url, quality):
    _update_task(task_id, status="starting", progress=0, url=url, quality=quality)
    tmpdir = tempfile.mkdtemp(prefix=f"vd_{task_id}_")
    try:
        out_template = os.path.join(tmpdir, "%(title)s.%(ext)s")
        # format selection logic: if user requested a resolution label map to yt-dlp format string
        if quality and quality != "best":
            # try explicit height format (e.g., 720 -> "bestvideo[height<=720]+bestaudio/best")
            fmt = f"bestvideo[height<={quality}]+bestaudio/best"
        else:
            fmt = "bestvideo+bestaudio/best"

        ydl_opts = {
            "format": fmt,
            "outtmpl": out_template,
            "merge_output_format": "mp4",
            "noplaylist": True,
            "quiet": True,
            "progress_hooks": [_progress_hook_factory(task_id)],
            "ffmpeg_location": FFMPEG_BIN  # ensure yt-dlp uses correct ffmpeg
        }

        _update_task(task_id, status="downloading", tmpdir=tmpdir)
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
            final = os.path.splitext(filename)[0] + ".mp4"
            _update_task(task_id, status="finished", progress=100, final_path=final, title=info.get('title'))
            # save to history
            save_history({
                'id': task_id,
                'title': info.get('title'),
                'url': url,
                'filename': final,
                'status': 'finished',
                'quality': quality or 'best'
            })
    except Exception as e:
         if str(e) == "Download Cancelled":
          shutil.rmtree(tmpdir, ignore_errors=True)

         _update_task(task_id, status="cancelled", progress=0)
 
         save_history({
            'id': task_id,
            'title': None,
            'url': url,
            'filename': None,
            'status': 'cancelled',
            'quality': quality or 'best'
        })

    else:
        _update_task(task_id, status="error", error=str(e), progress=0)

        save_history({
            'id': task_id,
            'title': None,
            'url': url,
            'filename': None,
            'status': 'error',
            'quality': quality or 'best'
        })

    finally:
         pass

# ---------- API endpoints ----------
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/start", methods=["POST"])
def api_start():
    data = request.form or request.json or {}
    url = data.get("url")
    quality = data.get("quality")  # expected: "best" or "720" or "480", etc.
    if not url:
        return jsonify({"error": "missing url"}), 400
    task_id = uuid.uuid4().hex
    _update_task(task_id, status="queued", progress=0, url=url, quality=quality)
    # start background job
    executor.submit(download_job, task_id, url, quality)
    return jsonify({"task_id": task_id})

@app.route("/api/status/<task_id>")
def api_status(task_id):
    t = tasks.get(task_id)
    if not t:
        return jsonify({"error": "task not found"}), 404
    # hide tmpdir path
    return jsonify({
        "task_id": task_id,
        "status": t.get("status"),
        "progress": t.get("progress", 0),
        "title": t.get("title"),
        "error": t.get("error")
    })
@app.route("/api/cancel/<task_id>", methods=["POST"])
def cancel_task(task_id):
    cancelled_tasks.add(task_id)
    return jsonify({"success": True})

@app.route("/api/history")
def api_history():
    return jsonify(get_history())
@app.route("/api/history/clear", methods=["POST"])
def clear_history():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("DELETE FROM history")
    conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route("/download/<task_id>")
def download_task(task_id):
    t = tasks.get(task_id)
    if not t:
        return "Task not found", 404
    if t.get("status") != "finished":
        return "Not ready", 400
    final = t.get("final_path")
    if not final or not os.path.exists(final):
        return "File not available", 404
    # send file and optionally cleanup after sending
    response = send_file(final, as_attachment=True, download_name=os.path.basename(final))
    @response.call_on_close
    def cleanup():
        try:
            # remove the temp dir if exists
            tmp = t.get("tmpdir")
            if tmp and os.path.exists(tmp):
                shutil.rmtree(tmp, ignore_errors=True)
        except Exception:
            pass
    return response

# ---------- small health endpoint ----------
@app.route("/api/ping")
def ping():
    return jsonify({"ok": True})

if __name__ == "__main__":
    print("Starting server on http://127.0.0.1:5001")
    app.run(debug=True, port=5001)


