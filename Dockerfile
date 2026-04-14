FROM python:3.12-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code + knowledge base
COPY server.py .
COPY knowledge/ knowledge/

# Render sets $PORT dynamically
ENV PORT=8000
EXPOSE ${PORT}

CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT}"]
