FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 3000

# ONE worker on purpose: replies are generated in background threads inside the
# process (see the note at the top of app.py).
# - ${PORT:-3000}: use the port the platform gives us, else 3000.
# - --worker-tmp-dir /dev/shm: avoids gunicorn heartbeat hangs on container filesystems.
# - --capture-output: print()s and tracebacks go to the platform's log page.
CMD ["sh", "-c", "exec gunicorn app:app --bind 0.0.0.0:${PORT:-3000} -w 1 --threads 16 --timeout 120 --worker-tmp-dir /dev/shm --capture-output --log-level info --access-logfile - --error-logfile -"]
