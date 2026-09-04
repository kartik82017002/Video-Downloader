# Video Downloader (Flask + yt-dlp + ffmpeg)

## Requirements
- Python 3.10+
- ffmpeg available (on PATH) or set environment variable `FFMPEG_BIN` to the ffmpeg bin folder (examples below)
- pip packages: `pip install -r requirements.txt`

## Run locally
1. Create and activate venv:

2. Make sure ffmpeg installed and visible:
- Option A: add ffmpeg bin to PATH
- Option B: set env var (temporary):
  ```
  $env:FFMPEG_BIN = 'C:\path\to\ffmpeg\bin'
  ```

3. Start server:
