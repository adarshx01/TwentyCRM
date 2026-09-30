# Conversation service. Twenty itself stays the pinned twentycrm/twenty image
# in infra/twenty. Do not clone twentyhq/twenty into this image.
FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml README.md alembic.ini ./
COPY src ./src
COPY alembic ./alembic

RUN pip install --no-cache-dir .

EXPOSE 3200

# MIGRATION_DATABASE_URL is the superuser DSN. The serving DATABASE_URL is conversation_app.
CMD ["sh", "-c", "if [ -n \"$MIGRATION_DATABASE_URL\" ]; then DATABASE_URL=\"$MIGRATION_DATABASE_URL\" alembic upgrade head; else alembic upgrade head; fi && exec uvicorn conversation.main:app --host 0.0.0.0 --port 3200"]
