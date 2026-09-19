FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=3000

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 3000

# One worker on purpose: replies are generated in background threads inside the
# process (see the note at the top of app.py). Logs go to stdout for the dashboard.
CMD ["sh", "-c", "exec gunicorn app:app --bind 0.0.0.0:${PORT} -w 1 --threads 16 --timeout 120 --access-logfile - --error-logfile -"]
